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

/** Distance the line's notes have travelled by `seconds`, summed over its speed events. */
export const createFloorAt = (line: Line) => {
    const spu = secondsPerUnit(line);
    const events = [...line.speedEvents].sort((a, b) => a.startTime - b.startTime);
    const starts: number[] = [];
    const floors: number[] = [];
    let floor = 0;
    for (let i = 0; i < events.length; i++) {
        const start = Math.max(0, events[i].startTime) * spu;
        if (i > 0) floor += (start - starts[i - 1]) * events[i - 1].value;
        starts.push(start);
        floors.push(floor);
    }
    return (seconds: number) => {
        if (!events.length) return seconds;
        // last event starting at or before `seconds` (the first one if none does); starts never decrease
        let lo = 0;
        let hi = events.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= seconds) lo = mid;
            else hi = mid - 1;
        }
        return floors[lo] + (seconds - starts[lo]) * events[lo].value;
    };
};

const floorCache = new WeakMap<Line, (seconds: number) => number>();

/** createFloorAt, built once per line object (charts are rebuilt, never edited in place). */
const cachedFloorAt = (line: Line) => {
    let floorAt = floorCache.get(line);
    if (!floorAt) {
        floorAt = createFloorAt(line);
        floorCache.set(line, floorAt);
    }
    return floorAt;
};

interface NoteIndex {
    /** time and floorPosition both never decrease, so the visible notes form a contiguous run */
    ordered: boolean;
    /** longest hold, in chart units */
    maxHold: number;
}

const noteIndexCache = new WeakMap<OfficialNote[], NoteIndex>();

const noteIndex = (notes: OfficialNote[]) => {
    let index = noteIndexCache.get(notes);
    if (!index) {
        let ordered = true;
        let maxHold = 0;
        for (let i = 0; i < notes.length; i++) {
            if (i > 0 && (notes[i].time < notes[i - 1].time || notes[i].floorPosition < notes[i - 1].floorPosition)) ordered = false;
            if (notes[i].type === 3) maxHold = Math.max(maxHold, notes[i].holdTime);
        }
        index = { ordered, maxHold };
        noteIndexCache.set(notes, index);
    }
    return index;
};

/** First index whose value is >= `target` (notes.length if none), for a non-decreasing key. */
const lowerBound = (notes: OfficialNote[], key: (note: OfficialNote) => number, target: number) => {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (key(notes[mid]) < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};

const noteTime = (note: OfficialNote) => note.time;
const noteFloor = (note: OfficialNote) => note.floorPosition;

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
    /** how far past the line notes are drawn once their time has come (preview hides them at once); `index`
     * numbers all lines' notes in turn (see noteOffsets) */
    isHidden?: (index: number, note: OfficialNote) => boolean;
    /** holds currently being held stay drawn from the line until their end */
    isHolding?: (index: number) => boolean;
    /** draws the hit outline used in the preview */
    previewHits?: boolean;
}

/** Index of each line's first note when all lines' notes are numbered in turn (line by line, in order). */
export const noteOffsets = (chart: OfficialChart) => {
    const offsets: number[] = [];
    let total = 0;
    for (const line of chart.judgeLineList) {
        offsets.push(total);
        total += line.notesAbove.length;
    }
    return offsets;
};

export const renderChart = (g: CanvasRenderingContext2D, chart: OfficialChart, seconds: number, width: number, height: number, options: RenderOptions = {}) => {
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

    const metrics = noteMetrics(width, height);
    const poses = chart.judgeLineList.map(line => linePoseAt(line, seconds, width, height));

    // every line first, then every line's notes, so notes are never covered by another line
    const thickness = Math.max(2, height * 0.006);
    g.fillStyle = '#feffa9';
    for (const pose of poses) {
        if (pose.alpha <= 0) continue;
        g.save();
        g.translate(pose.x, pose.y);
        g.rotate((-pose.angle * Math.PI) / 180);
        g.globalAlpha = pose.alpha;
        g.fillRect(-width * 3, -thickness / 2, width * 6, thickness);
        g.restore();
    }
    g.globalAlpha = 1;

    const offsets = noteOffsets(chart);
    chart.judgeLineList.forEach((line, l) => {
        if (line.notesAbove.length) drawNotes(g, line, poses[l], offsets[l], seconds, width, height, metrics, options);
    });
};

/** Notes of one line, numbered from `offset` for the hidden / holding callbacks. */
const drawNotes = (
    g: CanvasRenderingContext2D,
    line: Line,
    pose: ScreenPose,
    offset: number,
    seconds: number,
    width: number,
    height: number,
    { unit, noteWidth, noteHeight, floorScale }: ReturnType<typeof noteMetrics>,
    options: RenderOptions,
) => {
    const spu = secondsPerUnit(line);
    const floorAt = cachedFloorAt(line);
    const currentFloor = floorAt(seconds);

    g.save();
    g.translate(pose.x, pose.y);
    g.rotate((-pose.angle * Math.PI) / 180);

    const notes = line.notesAbove;
    const range = height * 2;
    let first = 0;
    let windowed = false;
    const { ordered, maxHold } = noteIndex(notes);
    if (ordered) {
        windowed = true;
        // Notes before `first` draw nothing visible:
        // - a note whose floorPosition is below `lowestFloor` sits further from the line's origin than any
        //   canvas pixel (rotation keeps distances), so drawing it as a plain note paints nothing;
        // - a hold that started more than the longest hold ago has ended (skipped below), and a note hit
        //   more than 0.25 s ago has no preview outline left.
        // Both keys never decrease, so each condition holds for a prefix; notes before both cut-offs are
        // skipped. Unordered note lists fall back to the full loop.
        const reach = Math.max(Math.hypot(pose.x, pose.y), Math.hypot(width - pose.x, pose.y), Math.hypot(pose.x, height - pose.y), Math.hypot(width - pose.x, height - pose.y))
            + Math.hypot(noteWidth, noteHeight) + 1;
        const lowestFloor = currentFloor - reach / floorScale;
        const recent = Math.max(maxHold * spu, options.previewHits ? 0.25 : 0) + 1e-3;
        first = Math.min(lowerBound(notes, noteFloor, lowestFloor), lowerBound(notes, noteTime, (seconds - recent) / spu));
    }
    for (let i = first; i < notes.length; i++) {
        const note = notes[i];
        const hitSeconds = note.time * spu;
        // every later note is at least as far up (drawn nothing, see the range checks below) and not yet hit
        // (no preview outline)
        if (windowed && (note.floorPosition - currentFloor) * floorScale > range && hitSeconds > seconds) break;
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
        if (options.isHidden?.(offset + i, note)) continue;

        if (note.type === 3) {
            if (seconds > endSeconds) continue;
            const holding = options.isHolding?.(offset + i) ?? seconds >= hitSeconds;
            const head = holding ? Math.max(0, (note.floorPosition - currentFloor) * floorScale) : (note.floorPosition - currentFloor) * floorScale;
            const tail = (floorAt(endSeconds) - currentFloor) * floorScale;
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
