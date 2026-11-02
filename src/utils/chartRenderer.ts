// draws an official-format chart at a moment in time. shared by the dialog preview and
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
    /** draws a Perfect hit burst for notes hit within the last HIT_EFFECT_SECONDS (and held holds), statelessly */
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

// ---- look (drawn procedurally, in the style of Phigros) ----

/** length of a hit burst, in seconds */
export const HIT_EFFECT_SECONDS = 0.5;
/** how long a Bad note's red ghost flashes at the line */
export const BAD_FLASH_SECONDS = 0.25;
/** a hold being held throws a burst this often */
export const HOLD_EFFECT_INTERVAL = 0.16;
export const PERFECT_COLOR = '#ffe17a';
export const GOOD_COLOR = '#7dd3fc';
const MULTI_COLOR = '#ffe17a';

/** a decorative line (not line 0) is drawn solid only while a note on it hits within this window around now */
const ACTIVE_BEFORE = 0.3;
const ACTIVE_AFTER = 1.5;

/** Deterministic pseudo-random number in [0, 1) from a seed and a stream index. */
const hash01 = (seed: number, k: number) => {
    let h = (Math.imul(seed | 0, 374761393) + Math.imul(k + 1, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
};

/**
 * A Phigros-style hit burst at screen point (x, y) on a line turned `angle` degrees (counter-clockwise), `age`
 * seconds after the hit: a square outline growing 0.6 -> 1.4 x `scale` while turning 45 degrees and fading, a
 * brief flash, and 4-6 square sparks flying out in directions fixed by `seed`. Stateless; draws additively.
 */
export const drawHitEffect = (g: CanvasRenderingContext2D, x: number, y: number, angle: number, age: number, color: string, seed: number, scale: number) => {
    if (age < 0 || age >= HIT_EFFECT_SECONDS) return;
    const p = age / HIT_EFFECT_SECONDS;
    const ease = 1 - (1 - p) ** 3;
    const fade = 1 - p;
    g.save();
    g.translate(x, y);
    g.rotate((-angle * Math.PI) / 180);
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = color;
    g.strokeStyle = color;

    // sparks: decelerating, shrinking and fading
    const count = 4 + Math.floor(hash01(seed, 0) * 3);
    const turn = hash01(seed, 1) * Math.PI * 2;
    for (let k = 0; k < count; k++) {
        const direction = turn + (k / count) * Math.PI * 2 + (hash01(seed, k + 2) - 0.5) * 0.9;
        const reach = scale * (0.85 + 0.6 * hash01(seed, k + 10)) * ease;
        const size = scale * (0.08 + 0.04 * hash01(seed, k + 20)) * (1 - p * 0.8);
        g.globalAlpha = fade;
        g.fillRect(Math.cos(direction) * reach - size / 2, Math.sin(direction) * reach - size / 2, size, size);
    }

    g.rotate((ease * Math.PI) / 4);
    const s = scale * (0.6 + 0.8 * ease);
    // brief filled flash
    if (age < 0.1) {
        g.globalAlpha = 0.55 * (1 - age / 0.1);
        g.fillRect(-s / 2, -s / 2, s, s);
    }
    // soft inner glow and the square outline
    g.globalAlpha = 0.1 * fade;
    g.fillRect(-s * 0.45, -s * 0.45, s * 0.9, s * 0.9);
    g.globalAlpha = fade ** 1.3;
    g.lineWidth = Math.max(1.5, scale * 0.05 * (1 - p * 0.6));
    g.strokeRect(-s / 2, -s / 2, s, s);
    g.globalAlpha = 0.35 * fade;
    g.lineWidth *= 2.6;
    g.strokeRect(-s / 2, -s / 2, s, s);

    // as in the original: a second, level square frame, two arcs sweeping round, and a glowing core
    g.rotate((-ease * Math.PI) / 4);
    const level = s * 0.82;
    g.globalAlpha = fade ** 1.6;
    g.lineWidth = Math.max(1, scale * 0.03);
    g.strokeRect(-level / 2, -level / 2, level, level);
    const radius = scale * (0.3 + 0.28 * ease);
    const sweep = Math.PI * (0.25 + 1.4 * ease) + hash01(seed, 30) * Math.PI;
    g.globalAlpha = 0.9 * fade;
    g.lineWidth = Math.max(1.5, scale * 0.04 * (1 - p * 0.5));
    for (const offset of [0, Math.PI]) {
        g.beginPath();
        g.arc(0, 0, radius, sweep + offset, sweep + offset + Math.PI * 0.6);
        g.stroke();
    }
    const core = g.createRadialGradient(0, 0, 0, 0, 0, scale * 0.22);
    core.addColorStop(0, color);
    core.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = core;
    g.globalAlpha = fade ** 2;
    g.beginPath();
    g.arc(0, 0, scale * 0.22, 0, Math.PI * 2);
    g.fill();
    g.restore();
};

/** A Bad note's ghost flashing red where it was hit (screen point on a line turned `angle` degrees). */
export const drawBadFlash = (g: CanvasRenderingContext2D, x: number, y: number, angle: number, age: number, noteWidth: number, noteHeight: number) => {
    if (age < 0 || age >= BAD_FLASH_SECONDS) return;
    const fade = 1 - age / BAD_FLASH_SECONDS;
    g.save();
    g.translate(x, y);
    g.rotate((-angle * Math.PI) / 180);
    g.globalAlpha = 0.85 * fade;
    g.fillStyle = '#ff3b4e';
    g.fillRect(-noteWidth / 2, -noteHeight / 2, noteWidth, noteHeight);
    g.globalAlpha = 0.6 * fade;
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1, noteHeight * 0.1);
    g.strokeRect(-noteWidth / 2, -noteHeight / 2, noteWidth, noteHeight);
    g.restore();
};

const NOTE_GRADIENTS: Record<OfficialNote['type'], [string, string, string]> = {
    1: ['#9be9ff', '#2ccbff', '#0ab2ee'],
    2: ['#fffbc0', '#f0ed69', '#d8d54c'],
    3: ['#9be9ff', '#2ccbff', '#0ab2ee'],
    4: ['#ff9db0', '#fe4365', '#e2304f'],
};

/** One note head centred at (cx, cy) in line space; drags are thinner, flicks carry a chevron. */
const drawNoteHead = (g: CanvasRenderingContext2D, type: OfficialNote['type'], cx: number, cy: number, w: number, fullHeight: number, multi: boolean) => {
    const h = type === 2 ? fullHeight * 0.55 : fullHeight;
    const left = cx - w / 2;
    const top = cy - h / 2;
    const outline = Math.max(1, fullHeight * 0.1);
    const [light, mid, dark] = NOTE_GRADIENTS[type];
    const gradient = g.createLinearGradient(0, top, 0, top + h);
    gradient.addColorStop(0, light);
    gradient.addColorStop(0.45, mid);
    gradient.addColorStop(1, dark);
    g.fillStyle = gradient;
    g.fillRect(left, top, w, h);
    if (type === 1 || type === 3) {
        // faint highlight line along the bar
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.fillRect(left + w * 0.06, top + h * 0.2, w * 0.88, Math.max(1, h * 0.12));
    } else if (type === 4) {
        // white upward chevron in the middle
        const c = Math.min(w * 0.09, h * 0.75);
        g.strokeStyle = '#ffffff';
        g.lineWidth = Math.max(1.2, h * 0.17);
        g.lineJoin = 'miter';
        g.beginPath();
        g.moveTo(cx - c, cy + h * 0.24);
        g.lineTo(cx, cy - h * 0.26);
        g.lineTo(cx + c, cy + h * 0.24);
        g.stroke();
    }
    g.lineWidth = multi ? outline * 1.6 : outline;
    const inset = g.lineWidth / 2;
    if (multi) {
        // the multi-press highlight: gold outline with a soft gold glow (blur only on these few notes)
        g.save();
        g.strokeStyle = MULTI_COLOR;
        g.shadowColor = 'rgba(255,225,122,0.9)';
        g.shadowBlur = Math.max(6, fullHeight * 1.4);
        g.strokeRect(left + inset, top + inset, w - inset * 2, h - inset * 2);
        g.restore();
    } else {
        g.strokeStyle = 'rgba(255,255,255,0.92)';
        g.strokeRect(left + inset, top + inset, w - inset * 2, h - inset * 2);
    }
};

/** Hold body from `head` to `tail` (distances above the line) at lx, brighter and glowing at the line while held. */
const drawHoldBody = (g: CanvasRenderingContext2D, lx: number, head: number, tail: number, w: number, h: number, holding: boolean) => {
    const bodyWidth = w * 0.78;
    const left = lx - bodyWidth / 2;
    const length = tail - head;
    if (length > 0) {
        g.fillStyle = holding ? 'rgba(60,205,255,0.62)' : 'rgba(10,175,240,0.4)';
        g.fillRect(left, -tail, bodyWidth, length);
        // thin lighter side edges
        const edge = Math.max(1, w * 0.012);
        g.fillStyle = holding ? 'rgba(210,245,255,0.95)' : 'rgba(160,230,255,0.7)';
        g.fillRect(left, -tail, edge, length);
        g.fillRect(left + bodyWidth - edge, -tail, edge, length);
        // short cap at the tail end
        const cap = Math.min(length, Math.max(2, h * 0.35));
        g.fillStyle = holding ? 'rgba(225,248,255,0.95)' : 'rgba(170,232,255,0.85)';
        g.fillRect(left, -tail, bodyWidth, cap);
    }
    if (holding) {
        // glow where the body meets the line
        const radius = w * 0.55;
        const glow = g.createRadialGradient(lx, 0, 0, lx, 0, radius);
        glow.addColorStop(0, 'rgba(180,240,255,0.75)');
        glow.addColorStop(0.4, 'rgba(60,200,255,0.35)');
        glow.addColorStop(1, 'rgba(10,195,255,0)');
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = glow;
        g.fillRect(lx - radius, -radius, radius * 2, radius * 2);
        g.restore();
    }
};

const multiCache = new WeakMap<OfficialChart, Set<OfficialNote>>();

/** Notes sharing their hit time with another note (any line; hold ends do not count), built once per chart. */
const multiPressNotes = (chart: OfficialChart) => {
    let multi = multiCache.get(chart);
    if (!multi) {
        const buckets = new Map<number, OfficialNote[]>();
        for (const line of chart.judgeLineList) {
            const spu = secondsPerUnit(line);
            for (const note of line.notesAbove) {
                const key = Math.round(note.time * spu * 1000);
                const bucket = buckets.get(key);
                if (bucket) bucket.push(note);
                else buckets.set(key, [note]);
            }
        }
        multi = new Set();
        for (const [key, bucket] of buckets) {
            // a millisecond bucket may split one moment in two: neighbours count as the same time
            const others = bucket.length - 1 + (buckets.get(key - 1)?.length ?? 0) + (buckets.get(key + 1)?.length ?? 0);
            if (others > 0) for (const note of bucket) multi.add(note);
        }
        multiCache.set(chart, multi);
    }
    return multi;
};

/** Disjoint, sorted [start, end] spans (seconds) during which some note of the line is hitting or held. */
const activityCache = new WeakMap<Line, { starts: number[]; ends: number[] }>();

const lineActivity = (line: Line) => {
    let activity = activityCache.get(line);
    if (!activity) {
        const spu = secondsPerUnit(line);
        const spans = line.notesAbove.map(n => [n.time * spu, (n.time + Math.max(0, n.holdTime)) * spu]).sort((a, b) => a[0] - b[0]);
        const starts: number[] = [];
        const ends: number[] = [];
        for (const [start, end] of spans) {
            if (ends.length && start <= ends[ends.length - 1]) ends[ends.length - 1] = Math.max(ends[ends.length - 1], end);
            else {
                starts.push(start);
                ends.push(end);
            }
        }
        activity = { starts, ends };
        activityCache.set(line, activity);
    }
    return activity;
};

/** Whether a note of the line hits (or is held) within [seconds - ACTIVE_BEFORE, seconds + ACTIVE_AFTER]. */
const lineCarriesNotes = (line: Line, seconds: number) => {
    const { starts, ends } = lineActivity(line);
    const from = seconds - ACTIVE_BEFORE;
    // first span ending at or after `from`
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ends[mid] < from) lo = mid + 1;
        else hi = mid;
    }
    return lo < starts.length && starts[lo] <= seconds + ACTIVE_AFTER;
};

interface PendingEffect {
    x: number;
    y: number;
    angle: number;
    age: number;
    seed: number;
}

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

    // every line first, then every line's notes, so notes are never covered by another line. a line other
    // than line 0 with no notes coming is decoration: drawn faint and dashed so it is not taken for a real one
    const thickness = Math.max(2, height * 0.006);
    const dash = width * 0.012;
    g.fillStyle = '#feffa9';
    g.strokeStyle = '#feffa9';
    poses.forEach((pose, l) => {
        if (pose.alpha <= 0) return;
        g.save();
        g.translate(pose.x, pose.y);
        g.rotate((-pose.angle * Math.PI) / 180);
        if (l === 0 || lineCarriesNotes(chart.judgeLineList[l], seconds)) {
            g.globalAlpha = pose.alpha;
            g.fillRect(-width * 3, -thickness / 2, width * 6, thickness);
        } else {
            g.globalAlpha = pose.alpha * 0.6;
            g.lineWidth = thickness;
            g.setLineDash([dash, dash]);
            g.beginPath();
            g.moveTo(-width * 3, 0);
            g.lineTo(width * 3, 0);
            g.stroke();
        }
        g.restore();
    });
    g.globalAlpha = 1;

    const offsets = noteOffsets(chart);
    const multi = multiPressNotes(chart);
    const effects: PendingEffect[] = [];
    chart.judgeLineList.forEach((line, l) => {
        if (line.notesAbove.length) drawNotes(g, line, poses[l], offsets[l], seconds, width, height, metrics, options, multi, effects);
    });
    // preview hit bursts, above every note
    for (const e of effects) drawHitEffect(g, e.x, e.y, e.angle, e.age, PERFECT_COLOR, e.seed, metrics.noteWidth);
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
    multi: Set<OfficialNote>,
    effects: PendingEffect[],
) => {
    const spu = secondsPerUnit(line);
    const floorAt = cachedFloorAt(line);
    const currentFloor = floorAt(seconds);
    const radians = (pose.angle * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    /** a preview burst `age` seconds old at lx along this line */
    const burst = (lx: number, age: number, seed: number) => {
        if (age >= 0 && age < HIT_EFFECT_SECONDS) effects.push({ x: pose.x + lx * cos, y: pose.y - lx * sin, angle: pose.angle, age, seed });
    };

    g.save();
    g.translate(pose.x, pose.y);
    g.rotate(-radians);

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
        //   (or a hold ended) more than HIT_EFFECT_SECONDS ago has no preview burst left.
        // Both keys never decrease, so each condition holds for a prefix; notes before both cut-offs are
        // skipped. Unordered note lists fall back to the full loop.
        const reach = Math.max(Math.hypot(pose.x, pose.y), Math.hypot(width - pose.x, pose.y), Math.hypot(pose.x, height - pose.y), Math.hypot(width - pose.x, height - pose.y))
            + Math.hypot(noteWidth, noteHeight) + 1;
        const lowestFloor = currentFloor - reach / floorScale;
        const recent = maxHold * spu + (options.previewHits ? HIT_EFFECT_SECONDS : 0) + 1e-3;
        first = Math.min(lowerBound(notes, noteFloor, lowestFloor), lowerBound(notes, noteTime, (seconds - recent) / spu));
    }
    for (let i = first; i < notes.length; i++) {
        const note = notes[i];
        const hitSeconds = note.time * spu;
        // every later note is at least as far up (drawn nothing, see the range checks below) and not yet hit
        // (no preview burst)
        if (windowed && (note.floorPosition - currentFloor) * floorScale > range && hitSeconds > seconds) break;
        const endSeconds = (note.time + note.holdTime) * spu;
        const lx = note.positionX * unit;

        if (options.previewHits && seconds >= hitSeconds) {
            const seed = (offset + i) * 97;
            if (note.type !== 3) burst(lx, seconds - hitSeconds, seed);
            else {
                // a burst at the head time, then one every HOLD_EFFECT_INTERVAL until the end
                const held = Math.min(seconds, endSeconds) - hitSeconds;
                const last = Math.floor(held / HOLD_EFFECT_INTERVAL + 1e-9);
                const firstAlive = Math.max(0, Math.ceil((seconds - hitSeconds - HIT_EFFECT_SECONDS) / HOLD_EFFECT_INTERVAL));
                for (let k = firstAlive; k <= last; k++) burst(lx, seconds - hitSeconds - k * HOLD_EFFECT_INTERVAL, seed + k);
            }
        }
        if (options.isHidden?.(offset + i, note)) continue;

        if (note.type === 3) {
            if (seconds > endSeconds) continue;
            const holding = options.isHolding?.(offset + i) ?? seconds >= hitSeconds;
            const head = holding ? Math.max(0, (note.floorPosition - currentFloor) * floorScale) : (note.floorPosition - currentFloor) * floorScale;
            const tail = (floorAt(endSeconds) - currentFloor) * floorScale;
            if (head > height * 2) continue;
            drawHoldBody(g, lx, head, tail, noteWidth, noteHeight, holding);
            drawNoteHead(g, 3, lx, -head, noteWidth, noteHeight, multi.has(note));
            continue;
        }
        const distance = (note.floorPosition - currentFloor) * floorScale;
        if (distance > height * 2) continue;
        drawNoteHead(g, note.type, lx, -distance, noteWidth, noteHeight, multi.has(note));
    }
    g.restore();
};
