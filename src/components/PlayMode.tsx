import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OfficialChart } from '../utils/chartConverter';
import { linePoseAt, noteMetrics, renderChart } from '../utils/chartRenderer';
import { Hit, Judgment, PlaySession } from '../utils/playJudge';
import { DifficultyCard } from './DifficultyCard';

interface PlayModeProps {
    chart: OfficialChart;
    audio: AudioBuffer;
    title: string;
    difficulty: string;
    level: string;
    cover: string | null;
    /** extra delay between the music and the player's taps, in milliseconds */
    latencyMs: number;
    onExit: () => void;
}

type Phase = 'ready' | 'playing' | 'paused' | 'results';

interface Effect {
    x: number;
    y: number;
    angle: number;
    born: number;
    color: string;
}

interface Finger {
    x: number;
    y: number;
    anchorX: number;
    anchorY: number;
    anchorTime: number;
}

const EFFECT_SECONDS = 0.35;
const EFFECT_COLORS: Record<number, string> = { [Judgment.Perfect]: '#ffe17a', [Judgment.Good]: '#7dd3fc' };

/** A short percussive click, played on every successful hit. */
const createHitSound = (context: AudioContext) => {
    const length = Math.round(context.sampleRate * 0.04);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
        const t = i / context.sampleRate;
        data[i] = (Math.sin(2 * Math.PI * 2200 * t) * 0.6 + (Math.random() * 2 - 1) * 0.4) * Math.exp(-t * 90);
    }
    return buffer;
};

/** Full-screen touch play of a generated chart. */
export const PlayMode: React.FC<PlayModeProps> = ({ chart, audio, title, difficulty, level, cover, latencyMs, onExit }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const coverRef = useRef<HTMLImageElement | null>(null);
    const sessionRef = useRef<PlaySession | null>(null);
    const audioRef = useRef<{ context: AudioContext; startAt: number; hitSound: AudioBuffer } | null>(null);
    const fingersRef = useRef(new Map<number, Finger>());
    const effectsRef = useRef<Effect[]>([]);
    const frameRef = useRef(0);
    const [phase, setPhase] = useState<Phase>('ready');
    const [combo, setCombo] = useState(0);
    const [portrait, setPortrait] = useState(false);
    const [summary, setSummary] = useState<{ perfect: number; good: number; miss: number; maxCombo: number; total: number } | null>(null);

    const line = chart.judgeLineList[0];
    const lastEnd = line.notesAbove.reduce((m, n) => Math.max(m, ((n.time + n.holdTime) * 1.875) / line.bpm), 0);
    const firstNote = line.notesAbove.length ? (line.notesAbove[0].time * 1.875) / line.bpm : 0;

    useEffect(() => {
        if (!cover) return;
        const image = new Image();
        image.src = cover;
        coverRef.current = image;
    }, [cover]);

    // canvas follows the window at device resolution (capped for speed)
    useEffect(() => {
        const resize = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            canvas.width = Math.round(window.innerWidth * dpr);
            canvas.height = Math.round(window.innerHeight * dpr);
            setPortrait(window.innerHeight > window.innerWidth);
        };
        resize();
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);

    /** Song time the player is judged against. */
    const songTime = useCallback(() => {
        const playback = audioRef.current;
        if (!playback) return -Infinity;
        const output = (playback.context as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
        return playback.context.currentTime - playback.startAt - output - latencyMs / 1000;
    }, [latencyMs]);

    const stopAudio = useCallback(() => {
        audioRef.current?.context.close();
        audioRef.current = null;
    }, []);

    useEffect(() => () => {
        cancelAnimationFrame(frameRef.current);
        stopAudio();
    }, [stopAudio]);

    const handleHits = useCallback((hits: Hit[], time: number) => {
        if (hits.length === 0) return;
        const session = sessionRef.current;
        const canvas = canvasRef.current;
        const playback = audioRef.current;
        if (!session || !canvas) return;
        const pose = linePoseAt(line, time, canvas.width, canvas.height);
        const { unit } = noteMetrics(canvas.width, canvas.height);
        const radians = (pose.angle * Math.PI) / 180;
        let sound = false;
        for (const hit of hits) {
            if (hit.judgment === Judgment.Miss) continue;
            const x = session.notes[hit.index].x * unit;
            effectsRef.current.push({
                x: pose.x + x * Math.cos(radians),
                y: pose.y - x * Math.sin(radians),
                angle: pose.angle,
                born: performance.now() / 1000,
                color: EFFECT_COLORS[hit.judgment],
            });
            sound = true;
        }
        if (sound && playback) {
            const source = playback.context.createBufferSource();
            source.buffer = playback.hitSound;
            const gain = playback.context.createGain();
            gain.gain.value = 0.5;
            source.connect(gain).connect(playback.context.destination);
            source.start();
        }
        setCombo(session.combo);
    }, [line]);

    /** Where a screen point falls along the judgment line, in positionX units. */
    const project = useCallback((x: number, y: number, time: number) => {
        const canvas = canvasRef.current!;
        const pose = linePoseAt(line, time, canvas.width, canvas.height);
        const radians = (pose.angle * Math.PI) / 180;
        const along = (x - pose.x) * Math.cos(radians) - (y - pose.y) * Math.sin(radians);
        return along / noteMetrics(canvas.width, canvas.height).unit;
    }, [line]);

    const frame = useCallback(() => {
        const canvas = canvasRef.current;
        const g = canvas?.getContext('2d');
        const session = sessionRef.current;
        if (!canvas || !g || !session) return;
        const time = songTime();

        // fingers resting on a moving line slide along it
        for (const [id, finger] of fingersRef.current) session.moveTo(id, project(finger.x, finger.y, time));
        handleHits(session.update(time), time);

        renderChart(g, chart, time, canvas.width, canvas.height, {
            cover: coverRef.current,
            isHidden: i => session.results[i] !== Judgment.Pending,
            isHolding: i => session.holding.has(i),
        });

        // hit effects: a spinning square burst
        const now = performance.now() / 1000;
        const size = canvas.height * 0.09;
        effectsRef.current = effectsRef.current.filter(e => now - e.born < EFFECT_SECONDS);
        for (const effect of effectsRef.current) {
            const p = (now - effect.born) / EFFECT_SECONDS;
            g.save();
            g.translate(effect.x, effect.y);
            g.rotate((-effect.angle * Math.PI) / 180 + p * Math.PI / 2);
            g.globalAlpha = 1 - p;
            g.strokeStyle = effect.color;
            g.lineWidth = Math.max(2, canvas.height * 0.006);
            const s = size * (0.5 + p);
            g.strokeRect(-s / 2, -s / 2, s, s);
            g.fillStyle = effect.color;
            for (let k = 0; k < 4; k++) {
                const a = (k * Math.PI) / 2 + Math.PI / 4;
                g.fillRect(Math.cos(a) * s * 0.8 - 3, Math.sin(a) * s * 0.8 - 3, 6, 6);
            }
            g.restore();
        }
        g.globalAlpha = 1;

        // song progress
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fillRect(0, 0, canvas.width, Math.max(3, canvas.height * 0.005));
        g.fillStyle = '#feffa9';
        g.fillRect(0, 0, canvas.width * Math.min(1, Math.max(0, time / audio.duration)), Math.max(3, canvas.height * 0.005));

        if (session.finished && time > lastEnd + 1) {
            setSummary({ ...session.counts, maxCombo: session.maxCombo, total: session.total });
            setPhase('results');
            return;
        }
        frameRef.current = requestAnimationFrame(frame);
    }, [audio.duration, chart, handleHits, lastEnd, project, songTime]);

    // must run from a tap: iPad only lets audio start from a user gesture
    const start = () => {
        cancelAnimationFrame(frameRef.current);
        stopAudio();
        const context = new AudioContext();
        const lead = Math.max(1.5, 3 - firstNote);
        const startAt = context.currentTime + lead;
        const source = context.createBufferSource();
        source.buffer = audio;
        source.connect(context.destination);
        source.start(startAt);
        audioRef.current = { context, startAt, hitSound: createHitSound(context) };
        sessionRef.current = new PlaySession(chart);
        fingersRef.current.clear();
        effectsRef.current = [];
        setCombo(0);
        setSummary(null);
        setPhase('playing');
        frameRef.current = requestAnimationFrame(frame);
    };

    const pause = useCallback(() => {
        if (!audioRef.current) return;
        cancelAnimationFrame(frameRef.current);
        audioRef.current.context.suspend();
        setPhase(p => (p === 'playing' ? 'paused' : p));
    }, []);

    const resume = () => {
        audioRef.current?.context.resume();
        setPhase('playing');
        frameRef.current = requestAnimationFrame(frame);
    };

    useEffect(() => {
        const onHidden = () => { if (document.hidden && phase === 'playing') pause(); };
        document.addEventListener('visibilitychange', onHidden);
        return () => document.removeEventListener('visibilitychange', onHidden);
    }, [pause, phase]);

    const toCanvas = (e: React.PointerEvent) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        const dpr = canvasRef.current!.width / rect.width;
        return { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr };
    };

    const onPointerDown = (e: React.PointerEvent) => {
        if (phase !== 'playing' || !sessionRef.current) return;
        try {
            // keep receiving this finger's moves even if it slides off the canvas
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // not capturable (e.g. synthetic events); judging works without it
        }
        const { x, y } = toCanvas(e);
        const time = songTime();
        fingersRef.current.set(e.pointerId, { x, y, anchorX: x, anchorY: y, anchorTime: time });
        handleHits(sessionRef.current.press(e.pointerId, project(x, y, time), time), time);
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const finger = fingersRef.current.get(e.pointerId);
        const session = sessionRef.current;
        if (!finger || !session || phase !== 'playing') return;
        const { x, y } = toCanvas(e);
        const time = songTime();
        finger.x = x;
        finger.y = y;
        // a swipe is a quick move of a few percent of the screen height
        if (time - finger.anchorTime > 0.15) {
            finger.anchorX = x;
            finger.anchorY = y;
            finger.anchorTime = time;
        } else if (Math.hypot(x - finger.anchorX, y - finger.anchorY) >= canvasRef.current!.height * 0.03) {
            handleHits(session.swipe(e.pointerId, project(x, y, time), time), time);
            finger.anchorX = x;
            finger.anchorY = y;
            finger.anchorTime = time;
        }
    };

    const onPointerUp = (e: React.PointerEvent) => {
        fingersRef.current.delete(e.pointerId);
        sessionRef.current?.release(e.pointerId);
    };

    const exit = () => {
        cancelAnimationFrame(frameRef.current);
        stopAudio();
        onExit();
    };

    const overlay = 'absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[rgba(4,6,10,.72)] backdrop-blur-[3px] text-slate-100';
    const button = 'min-w-[140px] h-12 px-6 rounded-xl text-[16px] font-bold transition-colors';

    // rendered on <body>: the dialog's transform would otherwise trap this fixed layer inside it
    return createPortal(
        <div className="fixed inset-0 z-[70] bg-black select-none" style={{ touchAction: 'none' }}>
            <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ touchAction: 'none' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onContextMenu={e => e.preventDefault()}
            />

            {(phase === 'playing' || phase === 'paused') && (
                <>
                    <button type="button" onClick={pause} aria-label="暂停" className="absolute top-3 left-3 w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
                    </button>
                    {combo >= 3 && (
                        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 flex flex-col items-center text-white">
                            <span className="text-[34px] font-bold leading-none">{combo}</span>
                            <span className="font-mono text-[11px] tracking-[.3em] text-slate-300">COMBO</span>
                        </div>
                    )}
                    <div className="pointer-events-none absolute bottom-3 left-4 flex items-center gap-3 text-white/90">
                        <span className="text-[15px] font-semibold">{title}</span>
                        <span className="text-[13px] font-mono opacity-80">{difficulty} Lv.{level}</span>
                    </div>
                </>
            )}

            {phase === 'ready' && (
                <button type="button" onClick={start} className={`${overlay} w-full`}>
                    <span className="text-[26px] font-semibold">{title}</span>
                    <div className="w-[220px]"><DifficultyCard difficulty={difficulty} level={level} /></div>
                    <span className="text-[15px] text-slate-300">轻触屏幕开始</span>
                    <span className="text-[12px] text-slate-500 max-w-[420px] text-center leading-relaxed">
                        蓝色：点击 · 黄色：手指放在音符经过的位置 · 红色：在音符附近滑动 · 长条：按住到结束
                    </span>
                    {portrait && <span className="text-[13px] text-[#fbbf24]">建议把 iPad 横过来玩</span>}
                </button>
            )}

            {phase === 'paused' && (
                <div className={overlay}>
                    <span className="text-[22px] font-semibold">已暂停</span>
                    <div className="flex gap-3">
                        <button type="button" onClick={resume} className={`${button} bg-[#22d3ee] text-[#06141a]`}>继续</button>
                        <button type="button" onClick={start} className={`${button} bg-white/10 text-white`}>重新开始</button>
                        <button type="button" onClick={exit} className={`${button} bg-white/10 text-white`}>退出</button>
                    </div>
                </div>
            )}

            {phase === 'results' && summary && (
                <div className={overlay}>
                    <span className="text-[24px] font-semibold">{title}</span>
                    <div className="w-[240px]"><DifficultyCard difficulty={difficulty} level={level} /></div>
                    <div className="grid grid-cols-4 gap-6 text-center">
                        <div><div className="text-[28px] font-bold text-[#ffe17a]">{summary.perfect}</div><div className="text-[12px] text-slate-400">完美</div></div>
                        <div><div className="text-[28px] font-bold text-[#7dd3fc]">{summary.good}</div><div className="text-[12px] text-slate-400">良好</div></div>
                        <div><div className="text-[28px] font-bold text-[#f87171]">{summary.miss}</div><div className="text-[12px] text-slate-400">失误</div></div>
                        <div><div className="text-[28px] font-bold">{summary.maxCombo}<span className="text-[15px] text-slate-500">/{summary.total}</span></div><div className="text-[12px] text-slate-400">最大连击</div></div>
                    </div>
                    <div className="flex gap-3">
                        <button type="button" onClick={start} className={`${button} bg-[#22d3ee] text-[#06141a]`}>再来一次</button>
                        <button type="button" onClick={exit} className={`${button} bg-white/10 text-white`}>返回</button>
                    </div>
                </div>
            )}
        </div>,
        document.body,
    );
};
