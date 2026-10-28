import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficialChart } from '../utils/chartConverter';
import { renderChart, secondsPerUnit as unitSeconds } from '../utils/chartRenderer';

const WIDTH = 960;
const HEIGHT = 540;

interface ChartPreviewProps {
    chart: OfficialChart;
    audio: AudioBuffer;
    cover: string | null;
}

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
    const secondsPerUnit = unitSeconds(line);

    const draw = useCallback((seconds: number) => {
        const g = canvasRef.current?.getContext('2d');
        if (!g) return;
        renderChart(g, chart, seconds, WIDTH, HEIGHT, {
            cover: coverRef.current,
            previewHits: true,
            isHidden: (_, note) => note.type !== 3 && seconds > note.time * secondsPerUnit,
        });
    }, [chart, secondsPerUnit]);

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
