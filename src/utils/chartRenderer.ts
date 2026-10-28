// draws a single-line official-format chart at a moment in time. shared by the dialog preview and
// play mode so what is previewed is exactly what is played.

import type { OfficialChart, OfficialNote } from './chartConverter';

type Line = OfficialChart['judgeLineList'][number];

interface TimedEvent {
    startTime: number;
    endTime: number;
    start: number;
    end: number;
    start2?: number;
    end2?: number;
}

export const NOTE_COLORS: Record<OfficialNote['type'], string> = { 1: '#0ac3ff', 2: '#f0ed69', 3: '#0ac3ff', 4: '#fe4365' };

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

export interface ScreenPose {
    /** pixels from the left */
    x: number;
    /** pixels from the top */
    y: number;
    /** degrees, counter-clockwise */
    angle: number;
    alpha: number;
}

export const secondsPerUnit = (line: Line) => 1.875 / line.bpm;

export const linePoseAt = (line: Line, seconds: number, width: number, height: number): ScreenPose => {
    const time = seconds / secondsPerUnit(line);
    return {
        x: evaluate(line.judgeLineMoveEvents, time) * width,
        y: (1 - evaluate(line.judgeLineMoveEvents, time, true)) * height,
        angle: evaluate(line.judgeLineRotateEvents, time),
        alpha: Math.min(1, Math.max(0, evaluate(line.judgeLineDisappearEvents, time))),
    };
};

/** Note geometry for a canvas: one positionX unit and note size, in pixels. */
export const noteMetrics = (width: number, height: number) => ({
    unit: width / 18,
    noteWidth: width * 0.1,
    noteHeight: Math.max(5, height * 0.018),
    floorScale: 0.6 * height,
});

export interface RenderOptions {
    cover?: HTMLImageElement | null;
    /** how far past the line notes are drawn once their time has come (preview hides them at once) */
    isHidden?: (index: number, note: OfficialNote) => boolean;
    /** holds currently being held stay drawn from the line until their end */
    isHolding?: (index: number) => boolean;
    /** draws the hit outline used in the preview */
    previewHits?: boolean;
}

export const renderChart = (g: CanvasRenderingContext2D, chart: OfficialChart, seconds: number, width: number, height: number, options: RenderOptions = {}) => {
    const line = chart.judgeLineList[0];
    const spu = secondsPerUnit(line);
    const speed = line.speedEvents[0]?.value ?? 1;

    g.fillStyle = '#05070a';
    g.fillRect(0, 0, width, height);
    const cover = options.cover;
    if (cover?.complete && cover.naturalWidth) {
        // cover the canvas, keeping the image's aspect ratio
        const scale = Math.max(width / cover.naturalWidth, height / cover.naturalHeight);
        const w = cover.naturalWidth * scale;
        const h = cover.naturalHeight * scale;
        g.globalAlpha = 0.3;
        g.drawImage(cover, (width - w) / 2, (height - h) / 2, w, h);
        g.globalAlpha = 1;
    }

    const pose = linePoseAt(line, seconds, width, height);
    const { unit, noteWidth, noteHeight, floorScale } = noteMetrics(width, height);
    const currentFloor = seconds * speed;

    g.save();
    g.translate(pose.x, pose.y);
    g.rotate((-pose.angle * Math.PI) / 180);

    g.globalAlpha = pose.alpha;
    g.fillStyle = '#feffa9';
    const thickness = Math.max(2, height * 0.006);
    g.fillRect(-width * 3, -thickness / 2, width * 6, thickness);
    g.globalAlpha = 1;

    const notes = line.notesAbove;
    for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        const hitSeconds = note.time * spu;
        const endSeconds = (note.time + note.holdTime) * spu;
        const lx = note.positionX * unit;

        if (options.previewHits) {
            const since = seconds - hitSeconds;
            if (since >= 0 && since < 0.25 && note.type !== 3) {
                g.strokeStyle = `rgba(254,255,169,${1 - since / 0.25})`;
                g.lineWidth = 3;
                g.strokeRect(lx - noteWidth / 2 - since * 60, -noteHeight - since * 60, noteWidth + since * 120, noteHeight * 2 + since * 120);
            }
        }
        if (options.isHidden?.(i, note)) continue;

        if (note.type === 3) {
            if (seconds > endSeconds) continue;
            const holding = options.isHolding?.(i) ?? seconds >= hitSeconds;
            const head = holding ? Math.max(0, (note.floorPosition - currentFloor) * floorScale) : (note.floorPosition - currentFloor) * floorScale;
            const tail = (note.floorPosition + (endSeconds - hitSeconds) * note.speed - currentFloor) * floorScale;
            if (head > height * 2) continue;
            g.fillStyle = holding ? 'rgba(10,195,255,0.75)' : 'rgba(10,195,255,0.5)';
            g.fillRect(lx - noteWidth * 0.4, -tail, noteWidth * 0.8, tail - head);
            g.fillStyle = NOTE_COLORS[3];
            g.fillRect(lx - noteWidth / 2, -head - noteHeight / 2, noteWidth, noteHeight);
            continue;
        }
        const distance = (note.floorPosition - currentFloor) * floorScale;
        if (distance > height * 2) continue;
        g.fillStyle = NOTE_COLORS[note.type];
        g.fillRect(lx - noteWidth / 2, -distance - noteHeight / 2, noteWidth, noteHeight);
        if (note.type === 4) {
            g.fillStyle = '#ffffff';
            g.fillRect(lx - noteWidth * 0.15, -distance - noteHeight / 2, noteWidth * 0.3, noteHeight);
        }
    }
    g.restore();
};
