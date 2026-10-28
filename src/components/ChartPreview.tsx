import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficialChart, OfficialNote } from '../utils/chartConverter';

interface ChartPreviewProps {
    chart: OfficialChart;
    audio: AudioBuffer;
    cover: string | null;
}

interface TimedEvent {
    startTime: number;
    endTime: number;
    start: number;
    end: number;
    start2?: number;
    end2?: number;
}

const WIDTH = 960;
const HEIGHT = 540;
const NOTE_COLORS: Record<OfficialNote['type'], string> = { 1: '#0ac3ff', 2: '#f0ed69', 3: '#0ac3ff', 4: '#fe4365' };

/** Value of a contiguous official event list at time `time` (chart units). */
const evaluate = (events: TimedEvent[], time: number, second = false) => {
    let lo = 0;
    let hi = events.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (events[mid].startTime <= time) lo = mid;
        else hi = mid - 1;
    }
    const e = events[lo];
    const start = second ? e.start2 ?? 0 : e.start;
    const end = second ? e.end2 ?? 0 : e.end;
    const span = e.endTime - e.startTime;
    const progress = span > 0 ? Math.min(1, Math.max(0, (time - e.startTime) / span)) : 1;
    return start + (end - start) * progress;
};

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** Plays the song and draws the chart as it would look in game, straight from the exported data. */
export const ChartPreview: React.FC<ChartPreviewProps> = ({ chart, audio, cover }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const coverRef = useRef<HTMLImageElement | null>(null);
    const playbackRef = useRef<{ context: AudioContext; startedAt: number; offset: number } | null>(null);
    const frameRef = useRef(0);
    const [playing, setPlaying] = useState(false);
    const [position, setPosition] = useState(0);
    const [clicks, setClicks] = useState(true);

    const line = chart.judgeLineList[0];
    const secondsPerUnit = 1.875 / line.bpm;
    const speed = line.speedEvents[0]?.value ?? 1;

    const draw = useCallback((seconds: number) => {
        const canvas = canvasRef.current;
        const g = canvas?.getContext('2d');
        if (!canvas || !g) return;
        const time = seconds / secondsPerUnit;

        g.fillStyle = '#05070a';
        g.fillRect(0, 0, WIDTH, HEIGHT);
        if (coverRef.current?.complete && coverRef.current.naturalWidth) {
            g.globalAlpha = 0.35;
            g.drawImage(coverRef.current, 0, 0, WIDTH, HEIGHT);
            g.globalAlpha = 1;
        }

        const x = evaluate(line.judgeLineMoveEvents, time) * WIDTH;
        const y = (1 - evaluate(line.judgeLineMoveEvents, time, true)) * HEIGHT;
        const angle = evaluate(line.judgeLineRotateEvents, time);
        const alpha = Math.min(1, Math.max(0, evaluate(line.judgeLineDisappearEvents, time)));
        const unit = WIDTH / 18;
        const floorScale = 0.6 * HEIGHT;
        const currentFloor = seconds * speed;
        const noteWidth = WIDTH * 0.1;
        const noteHeight = Math.max(5, HEIGHT * 0.018);

        g.save();
        g.translate(x, y);
        g.rotate((-angle * Math.PI) / 180);

        g.globalAlpha = alpha;
        g.fillStyle = '#feffa9';
        g.fillRect(-WIDTH * 3, -2, WIDTH * 6, 4);
        g.globalAlpha = 1;

        for (const note of line.notesAbove) {
            const hitSeconds = note.time * secondsPerUnit;
            const endSeconds = (note.time + note.holdTime) * secondsPerUnit;
            const lx = note.positionX * unit;

            // hit flash for a quarter second after the hit
            const since = seconds - hitSeconds;
            if (since >= 0 && since < 0.25 && note.type !== 3) {
                g.strokeStyle = `rgba(254,255,169,${1 - since / 0.25})`;
                g.lineWidth = 3;
                g.strokeRect(lx - noteWidth / 2 - since * 60, -noteHeight - since * 60, noteWidth + since * 120, noteHeight * 2 + since * 120);
            }

            if (note.type === 3) {
                if (seconds > endSeconds) continue;
                const head = Math.max(0, (note.floorPosition - currentFloor) * floorScale);
                const tail = (note.floorPosition + (endSeconds - hitSeconds) * note.speed - currentFloor) * floorScale;
                if (head > HEIGHT * 2) continue;
                g.fillStyle = 'rgba(10,195,255,0.55)';
                g.fillRect(lx - noteWidth * 0.4, -tail, noteWidth * 0.8, tail - head);
                g.fillStyle = NOTE_COLORS[3];
                g.fillRect(lx - noteWidth / 2, -head - noteHeight / 2, noteWidth, noteHeight);
                continue;
            }
            if (seconds > hitSeconds) continue;
            const distance = (note.floorPosition - currentFloor) * floorScale;
            if (distance > HEIGHT * 2) continue;
            g.fillStyle = NOTE_COLORS[note.type];
            g.fillRect(lx - noteWidth / 2, -distance - noteHeight / 2, noteWidth, noteHeight);
            if (note.type === 4) {
                g.fillStyle = '#ffffff';
                g.fillRect(lx - noteWidth * 0.15, -distance - noteHeight / 2, noteWidth * 0.3, noteHeight);
            }
        }
        g.restore();
    }, [line, secondsPerUnit, speed]);

    useEffect(() => {
        if (!cover) {
            coverRef.current = null;
            return;
        }
        const image = new Image();
        image.onload = () => draw(position);
        image.src = cover;
        coverRef.current = image;
        // only reload when the cover changes
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cover]);

    const stop = useCallback(() => {
        cancelAnimationFrame(frameRef.current);
        playbackRef.current?.context.close();
        playbackRef.current = null;
        setPlaying(false);
    }, []);

    useEffect(() => stop, [stop]);
    // a new chart (difficulty, BPM, …) restarts from where the preview was
    useEffect(() => {
        if (playbackRef.current) stop();
        draw(position);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chart]);

    const play = () => {
        const context = new AudioContext();
        const offset = position >= audio.duration - 0.5 ? 0 : position;
        const startedAt = context.currentTime + 0.1;
        const source = context.createBufferSource();
        source.buffer = audio;
        source.connect(context.destination);
        source.start(startedAt, offset);
        source.onended = () => { if (playbackRef.current?.context === context) stop(); };

        if (clicks) {
            const times = new Set(line.notesAbove.map(n => n.time * secondsPerUnit).filter(t => t >= offset));
            for (const t of times) {
                const at = startedAt + t - offset;
                const osc = context.createOscillator();
                const gain = context.createGain();
                osc.frequency.value = 1800;
                gain.gain.setValueAtTime(0.3, at);
                gain.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
                osc.connect(gain).connect(context.destination);
                osc.start(at);
                osc.stop(at + 0.05);
            }
        }

        playbackRef.current = { context, startedAt, offset };
        setPlaying(true);
        let lastUpdate = 0;
        const tick = () => {
            const playback = playbackRef.current;
            if (!playback) return;
            const seconds = Math.max(playback.offset, playback.context.currentTime - playback.startedAt + playback.offset);
            draw(seconds);
            if (performance.now() - lastUpdate > 150) {
                lastUpdate = performance.now();
                setPosition(seconds);
            }
            frameRef.current = requestAnimationFrame(tick);
        };
        frameRef.current = requestAnimationFrame(tick);
    };

    const seek = (seconds: number) => {
        const wasPlaying = playing;
        if (wasPlaying) stop();
        setPosition(seconds);
        draw(seconds);
    };

    return (
        <div className="flex flex-col gap-2">
            <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className="w-full aspect-video rounded-lg border border-white/[.08] bg-black" />
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={playing ? stop : play}
                    className="w-[72px] h-8 rounded-md bg-[#22d3ee] hover:bg-[#67e8f9] text-[#06141a] text-[13px] font-bold"
                >
                    {playing ? '暂停' : '播放'}
                </button>
                <input
                    type="range"
                    min={0}
                    max={audio.duration}
                    step={0.1}
                    value={position}
                    onChange={e => seek(parseFloat(e.target.value))}
                    aria-label="预览进度"
                    className="flex-1 accent-[#22d3ee]"
                />
                <span className="font-mono text-[11px] text-slate-400 w-[76px] text-right">{formatTime(position)} / {formatTime(audio.duration)}</span>
                <label className="flex items-center gap-1.5 text-[12px] text-slate-400">
                    <input type="checkbox" checked={clicks} onChange={e => setClicks(e.target.checked)} disabled={playing} className="accent-[#22d3ee]" />
                    打击音
                </label>
            </div>
        </div>
    );
};
