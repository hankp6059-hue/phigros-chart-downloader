import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OfficialChart } from '../utils/chartConverter';
import { linePoseAt, noteMetrics, renderChart } from '../utils/chartRenderer';
import { Hit, Judgment, PlaySession } from '../utils/playJudge';
import { DifficultyCard } from './DifficultyCard';
import { unlockAudio } from '../utils/audioUnlock';

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

type Phase = 'ready' | 'playing' | 'paused' | 'countdown' | 'results';

interface Effect {
    x: number;
    y: number;
    angle: number;
    born: number;
    color: string;
}

/** a finger on the screen, with Phira's flick tracking (prpr/src/judge.rs FlickTracker) */
interface Finger {
    x: number;
    y: number;
    /** real time of the last move, in seconds */
    lastTime: number;
    /** direction of the last move (unit vector), once it has moved */
    direction: { x: number; y: number } | null;
    /** has slowed down (or not moved yet) since its last flick */
    stopped: boolean;
    /** a flick waiting for a flick note */
    flicked: boolean;
}

// Phira's flick speed: FLICK_SPEED_THRESHOLD 0.8 at its reference dpi (275 / 386), in half screen widths per second
const FLICK_SPEED = 0.8 * (275 / 386);

const EFFECT_SECONDS = 0.35;
// seconds counted down after resuming, during which the chart stays still
const RESUME_COUNTDOWN = 3;
const EFFECT_COLORS: Record<number, string> = { [Judgment.Perfect]: '#ffe17a', [Judgment.Good]: '#7dd3fc' };
// the smoothed song clock snaps back to the audio clock when they drift further apart than this
const CLOCK_RESYNC = 0.018;
// how quickly (seconds) the smoothed clock eases onto the audio clock's average
const CLOCK_EASE = 0.3;

/**
 * A continuous song clock. AudioContext.currentTime moves in steps (10-20 ms on iPad Safari), so between
 * steps it runs on performance.now() and eases towards the audio clock; it never goes back, and it
 * stands still whenever the audio clock does (suspended for pause/countdown, or not yet moving again
 * after a resume).
 */
interface SongClock {
    /** smoothed song time last handed out */
    time: number;
    /** performance.now() of that, in seconds */
    at: number;
    /** last audio song time seen, and whether it has moved since the context last ran */
    raw: number;
    moving: boolean;
    /** largest recent step of the audio clock: steps bigger than the resync bound must not trigger it */
    step: number;
}

/** Full-screen touch play of a generated chart. */
export const PlayMode: React.FC<PlayModeProps> = ({ chart, audio, title, difficulty, level, cover, latencyMs, onExit }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const coverRef = useRef<HTMLImageElement | null>(null);
    const sessionRef = useRef<PlaySession | null>(null);
    // no hit sounds: hits should feel part of the music, not play over it
    const audioRef = useRef<{ context: AudioContext; startAt: number } | null>(null);
    const fingersRef = useRef(new Map<number, Finger>());
    const effectsRef = useRef<Effect[]>([]);
    const frameRef = useRef(0);
    const clockRef = useRef<SongClock | null>(null);
    const fontsRef = useRef<{ sans: string; mono: string } | null>(null);
    const [phase, setPhase] = useState<Phase>('ready');
    const [countdown, setCountdown] = useState(0);
    const [portrait, setPortrait] = useState(false);
    const [summary, setSummary] = useState<{ perfect: number; good: number; bad: number; miss: number; maxCombo: number; total: number } | null>(null);

    const lines = chart.judgeLineList;
    const noteSeconds = lines.flatMap(line => line.notesAbove.map(n => ({ start: (n.time * 1.875) / line.bpm, end: ((n.time + n.holdTime) * 1.875) / line.bpm })));
    const lastEnd = noteSeconds.reduce((m, n) => Math.max(m, n.end), 0);
    const firstNote = noteSeconds.length ? Math.min(...noteSeconds.map(n => n.start)) : 0;

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

    /** Song time the player is judged against and the chart is drawn at (one clock for both). */
    const songTime = useCallback(() => {
        const playback = audioRef.current;
        if (!playback) return -Infinity;
        const output = (playback.context as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
        const raw = playback.context.currentTime - playback.startAt - output - latencyMs / 1000;
        const now = performance.now() / 1000;
        const clock = clockRef.current;
        if (!clock) {
            clockRef.current = { time: raw, at: now, raw, moving: false, step: 0 };
            return raw;
        }
        if (playback.context.state !== 'running') {
            // suspended (pause, countdown): hold still, and wait for the audio clock to move again
            clock.raw = raw;
            clock.moving = false;
            clock.at = now;
            return clock.time;
        }
        const wasMoving = clock.moving;
        if (raw !== clock.raw) {
            if (wasMoving) clock.step = Math.min(0.05, Math.max(raw - clock.raw, clock.step * 0.98));
            clock.raw = raw;
            clock.moving = true;
        }
        // time spent stopped (paused, counting down, waiting for the audio to restart) does not count
        const elapsed = wasMoving ? now - clock.at : 0;
        clock.at = now;
        // just resumed and the audio has not restarted yet: carry on from where it stopped, not ahead of it
        if (!clock.moving) return clock.time;
        let next = clock.time + elapsed;
        const drift = raw - next;
        if (Math.abs(drift) > Math.max(CLOCK_RESYNC, clock.step)) next = raw;
        else next += drift * (1 - Math.exp(-elapsed / CLOCK_EASE));
        // never backwards: an audio stall freezes the clock until the audio catches up
        clock.time = Math.max(clock.time, next);
        return clock.time;
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
        if (!session || !canvas) return;
        const { unit } = noteMetrics(canvas.width, canvas.height);
        for (const hit of hits) {
            if (hit.judgment === Judgment.Miss) continue;
            const note = session.notes[hit.index];
            const pose = linePoseAt(lines[note.line], time, canvas.width, canvas.height);
            const radians = (pose.angle * Math.PI) / 180;
            const x = note.x * unit;
            effectsRef.current.push({
                x: pose.x + x * Math.cos(radians),
                y: pose.y - x * Math.sin(radians),
                angle: pose.angle,
                born: performance.now() / 1000,
                color: EFFECT_COLORS[hit.judgment],
            });
        }
    }, [lines]);

    /** Where a screen point falls along each judgment line, in positionX units. */
    const project = useCallback((x: number, y: number, time: number) => {
        const canvas = canvasRef.current!;
        const { unit } = noteMetrics(canvas.width, canvas.height);
        return lines.map(line => {
            const pose = linePoseAt(line, time, canvas.width, canvas.height);
            const radians = (pose.angle * Math.PI) / 180;
            return ((x - pose.x) * Math.cos(radians) - (y - pose.y) * Math.sin(radians)) / unit;
        });
    }, [lines]);

    const frame = useCallback(() => {
        const canvas = canvasRef.current;
        const g = canvas?.getContext('2d');
        const session = sessionRef.current;
        if (!canvas || !g || !session) return;
        const time = songTime();

        // fingers resting on a moving line slide along it; a flick not yet used waits for its note
        for (const [id, finger] of fingersRef.current) {
            const x = project(finger.x, finger.y, time);
            session.moveTo(id, x);
            if (finger.flicked && session.flick(id, x, time)) finger.flicked = false;
        }
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

        const finished = session.finished && time > lastEnd + 1;

        // combo, top centre: drawn here so dense passages do not re-render React on every hit
        // (not on the frame left behind the results, as before)
        if (session.combo >= 3 && !finished) {
            const css = canvas.width / (canvas.clientWidth || canvas.width);
            if (!fontsRef.current) {
                const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
                fontsRef.current = { sans: getComputedStyle(canvas).fontFamily || 'sans-serif', mono: mono || 'ui-monospace, Menlo, monospace' };
            }
            const { sans, mono } = fontsRef.current;
            const centre = canvas.width / 2;
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillStyle = '#ffffff';
            g.font = `700 ${34 * css}px ${sans}`;
            // 34px number with leading-none, 12px from the top
            g.fillText(String(session.combo), centre, (12 + 17) * css);
            // 11px label spaced .3em per letter (trailing space included, as CSS letter-spacing does)
            g.font = `${11 * css}px ${mono}`;
            g.fillStyle = '#cbd5e1';
            g.textAlign = 'left';
            const label = 'COMBO';
            const spacing = 11 * 0.3 * css;
            const widths = [...label].map(c => g.measureText(c).width);
            let x = centre - (widths.reduce((a, b) => a + b, 0) + spacing * label.length) / 2;
            [...label].forEach((c, k) => {
                g.fillText(c, x, (12 + 34 + 16.5 / 2) * css);
                x += widths[k] + spacing;
            });
        }

        // song progress
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fillRect(0, 0, canvas.width, Math.max(3, canvas.height * 0.005));
        g.fillStyle = '#feffa9';
        g.fillRect(0, 0, canvas.width * Math.min(1, Math.max(0, time / audio.duration)), Math.max(3, canvas.height * 0.005));

        if (finished) {
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
        unlockAudio(context);
        const lead = Math.max(1.5, 3 - firstNote);
        const startAt = context.currentTime + lead;
        const source = context.createBufferSource();
        source.buffer = audio;
        source.connect(context.destination);
        source.start(startAt);
        audioRef.current = { context, startAt };
        sessionRef.current = new PlaySession(chart);
        fingersRef.current.clear();
        effectsRef.current = [];
        clockRef.current = null;
        setSummary(null);
        setPhase('playing');
        frameRef.current = requestAnimationFrame(frame);
    };

    const pause = useCallback(() => {
        if (!audioRef.current) return;
        cancelAnimationFrame(frameRef.current);
        audioRef.current.context.suspend();
        // the chart stops where it was last drawn; it moves again only once the resumed audio does
        if (clockRef.current) clockRef.current.moving = false;
        setPhase(p => (p === 'playing' || p === 'countdown' ? 'paused' : p));
    }, []);

    // the music stays suspended (so the chart stays still) through the countdown, then both carry on
    // from exactly where they stopped
    const resume = () => {
        // fingers lifted while paused never sent their release
        for (const id of fingersRef.current.keys()) sessionRef.current?.release(id);
        fingersRef.current.clear();
        setCountdown(RESUME_COUNTDOWN);
        setPhase('countdown');
    };

    useEffect(() => {
        if (phase !== 'countdown') return;
        if (countdown <= 0) {
            audioRef.current?.context.resume();
            setPhase('playing');
            frameRef.current = requestAnimationFrame(frame);
            return;
        }
        const timer = window.setTimeout(() => setCountdown(c => c - 1), 1000);
        return () => window.clearTimeout(timer);
    }, [phase, countdown, frame]);

    useEffect(() => {
        const onHidden = () => { if (document.hidden && (phase === 'playing' || phase === 'countdown')) pause(); };
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
        fingersRef.current.set(e.pointerId, { x, y, lastTime: performance.now() / 1000, direction: null, stopped: true, flicked: false });
        handleHits(sessionRef.current.press(e.pointerId, project(x, y, time), time), time);
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const finger = fingersRef.current.get(e.pointerId);
        const session = sessionRef.current;
        if (!finger || !session || phase !== 'playing') return;
        const { x, y } = toCanvas(e);
        const time = songTime();
        // as Phira: a flick is a move at twice the threshold speed after the finger has slowed below it
        const now = performance.now() / 1000;
        const dt = Math.max(now - finger.lastTime, 1e-3);
        const threshold = (FLICK_SPEED * canvasRef.current!.width) / 2;
        const dx = x - finger.x;
        const dy = y - finger.y;
        const length = Math.hypot(dx, dy);
        if (length > 0) {
            if (finger.direction) {
                if ((dx * finger.direction.x + dy * finger.direction.y) / dt < threshold) finger.stopped = true;
                if (finger.stopped && !finger.flicked) finger.flicked = length / dt >= threshold * 2;
            }
            finger.direction = { x: dx / length, y: dy / length };
        }
        finger.x = x;
        finger.y = y;
        finger.lastTime = now;
        const along = project(x, y, time);
        session.moveTo(e.pointerId, along);
        if (finger.flicked && session.flick(e.pointerId, along, time)) finger.flicked = false;
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

            {(phase === 'playing' || phase === 'paused' || phase === 'countdown') && (
                <>
                    <button type="button" onClick={pause} aria-label="暂停" className="absolute top-3 left-3 w-11 h-11 rounded-full bg-white/10 text-white flex items-center justify-center">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
                    </button>
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
                        蓝色：点击 · 黄色：手指放在音符经过的位置 · 红色：在音符附近快速划动 · 长条：按住到结束 · 判定与 Phira 相同
                    </span>
                    {portrait && <span className="text-[13px] text-[#fbbf24]">建议把 iPad 横过来玩</span>}
                </button>
            )}

            {phase === 'countdown' && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span key={countdown} className="text-[96px] font-bold text-white/90 drop-shadow-[0_0_24px_rgba(0,0,0,.6)] animate-pulse">{countdown}</span>
                </div>
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
                    <div className="grid grid-cols-5 gap-6 text-center">
                        <div><div className="text-[28px] font-bold text-[#ffe17a]">{summary.perfect}</div><div className="text-[12px] text-slate-400">完美</div></div>
                        <div><div className="text-[28px] font-bold text-[#7dd3fc]">{summary.good}</div><div className="text-[12px] text-slate-400">良好</div></div>
                        <div><div className="text-[28px] font-bold text-[#fb923c]">{summary.bad}</div><div className="text-[12px] text-slate-400">差</div></div>
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
