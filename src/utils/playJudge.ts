// judgment for playing a single-line chart by touch, ported from Phira's judge
// (https://github.com/TeamFlos/phira/blob/main/prpr/src/judge.rs) so a chart plays here as it will there.
// positions are in positionX units along a judgment line; the caller projects each finger onto every line
// each frame (lines move), and a note is judged against the finger's position along its own line. notes are
// numbered across all lines in turn (line by line, in order), as the renderer numbers them.
//   touch down: hits the best-matching note by timing and distance; a tap is Perfect / Good / Bad,
//               a hold starts; a drag or flick that matches best takes the touch without being hit
//   swipe:      hits the best-matching flick (a drag that matches best takes it instead)
//   drag:       any finger near the note within the window; counts once its time comes
//   hold:       keep a finger near it; safe once its end is within BAD_WINDOW
//   anything still unhit BAD_WINDOW after its time is a Miss

import type { OfficialChart, OfficialNote } from './chartConverter';

export const PERFECT_WINDOW = 0.08;
export const GOOD_WINDOW = 0.16;
export const BAD_WINDOW = 0.22;
/** a touch this much late still counts as on time (Phira's EARLY_OFFSET) */
const LATE_ALLOWANCE = 0.07;
/** how far from a note's centre a finger still counts, in positionX units (Phira: 0.21 / (16/9) * 2 of half the screen) */
export const REACH = 2.1;
/** note width in positionX units (Phira's NOTE_WIDTH_RATIO_BASE); farther fingers rank worse */
const NOTE_WIDTH = 1.171;
/** seconds of ranking penalty per note width past the first (Phira's DIST_FACTOR) */
const DIST_FACTOR = 0.2;
/** a hold may go untouched this long before it is missed */
const UP_TOLERANCE = 0.05;

export const Judgment = { Pending: 0, Perfect: 1, Good: 2, Bad: 3, Miss: 4 } as const;
export type Judgment = (typeof Judgment)[keyof typeof Judgment];

export interface Hit {
    index: number;
    judgment: Judgment;
}

interface NoteTiming {
    type: OfficialNote['type'];
    time: number;
    end: number;
    x: number;
    /** judgment line it is on */
    line: number;
}

interface HoldState {
    perfect: boolean;
    /** when the last finger left it, or Infinity while touched */
    up: number;
    /** close enough to its end that it can no longer be missed */
    safe: boolean;
}

export class PlaySession {
    readonly notes: NoteTiming[];
    readonly results: Uint8Array;
    /** hold notes being held */
    readonly holding = new Map<number, HoldState>();
    /** drags and flicks already caught, counted once their time comes */
    private readonly caught = new Set<number>();
    /** each finger's position along every line */
    private readonly touches = new Map<number, number[]>();
    /** note numbers in time order */
    private readonly order: number[];
    private next = 0;
    combo = 0;
    maxCombo = 0;
    readonly counts = { perfect: 0, good: 0, bad: 0, miss: 0 };

    constructor(chart: OfficialChart) {
        this.notes = chart.judgeLineList.flatMap((line, l) => {
            const spu = 1.875 / line.bpm;
            return line.notesAbove.map(n => ({ type: n.type, time: n.time * spu, end: (n.time + n.holdTime) * spu, x: n.positionX, line: l }));
        });
        this.order = this.notes.map((_, i) => i).sort((a, b) => this.notes[a].time - this.notes[b].time || a - b);
        this.results = new Uint8Array(this.notes.length);
    }

    get total() {
        return this.notes.length;
    }

    get finished() {
        return this.counts.perfect + this.counts.good + this.counts.bad + this.counts.miss === this.notes.length;
    }

    private record(index: number, judgment: Judgment, hits: Hit[]) {
        this.results[index] = judgment;
        if (judgment === Judgment.Miss || judgment === Judgment.Bad) {
            if (judgment === Judgment.Miss) this.counts.miss++;
            else this.counts.bad++;
            this.combo = 0;
        } else {
            if (judgment === Judgment.Perfect) this.counts.perfect++;
            else this.counts.good++;
            this.combo++;
            this.maxCombo = Math.max(this.maxCombo, this.combo);
        }
        hits.push({ index, judgment });
    }

    /**
     * The note a touch at `x` goes to, as Phira ranks them: by timing (late touches get LATE_ALLOWANCE,
     * drags and flicks rank GOOD_WINDOW worse) plus a penalty for distance past one note width.
     */
    private closest(time: number, xs: number[], press: boolean): { index: number; dt: number } | null {
        let best: { index: number; dt: number } | null = null;
        let bestKey = BAD_WINDOW + Math.max(REACH / NOTE_WIDTH - 1, 0) * DIST_FACTOR;
        for (let k = this.next; k < this.order.length; k++) {
            const i = this.order[k];
            const note = this.notes[i];
            if (this.results[i] !== Judgment.Pending || this.holding.has(i)) continue;
            if (!press && (note.type === 1 || note.type === 3)) continue;
            const early = note.time - time;
            if (early >= bestKey) break;
            const dt = early < 0 ? Math.abs(Math.min(early + LATE_ALLOWANCE, 0)) : early;
            const dist = Math.abs(note.x - (xs[note.line] ?? Infinity));
            if (dist > REACH) continue;
            if (dt > (note.type === 1 ? BAD_WINDOW : GOOD_WINDOW)) continue;
            const ranked = note.type === 2 || note.type === 4 ? dt + GOOD_WINDOW : dt;
            const key = ranked + Math.max(dist / NOTE_WIDTH - 1, 0) * DIST_FACTOR;
            if (key < bestKey) {
                bestKey = key;
                best = { index: i, dt };
            }
        }
        return best;
    }

    /** A finger touched down; `xs` is where it is along each line. */
    press(id: number, xs: number[], time: number): Hit[] {
        this.touches.set(id, xs);
        const hits: Hit[] = [];
        const found = this.closest(time, xs, true);
        if (!found) return hits;
        const { index, dt } = found;
        const note = this.notes[index];
        // a drag or flick that matches best takes the touch: the tap behind it is not hit
        if (note.type === 2 || note.type === 4) return hits;
        if (note.type === 3) {
            this.holding.set(index, { perfect: dt <= PERFECT_WINDOW, up: Infinity, safe: false });
            hits.push({ index, judgment: dt <= PERFECT_WINDOW ? Judgment.Perfect : Judgment.Good });
        } else {
            this.record(index, dt <= PERFECT_WINDOW ? Judgment.Perfect : dt <= GOOD_WINDOW ? Judgment.Good : Judgment.Bad, hits);
        }
        return hits;
    }

    /** A finger flicked at `xs` (along each line); returns whether the flick was used up. */
    flick(id: number, xs: number[], time: number): boolean {
        this.moveTo(id, xs);
        const found = this.closest(time, xs, false);
        if (!found || this.notes[found.index].type !== 4) return false;
        this.caught.add(found.index);
        return true;
    }

    /** Where a held-down finger is now (the line moves under resting fingers). */
    moveTo(id: number, xs: number[]) {
        if (this.touches.has(id)) this.touches.set(id, xs);
    }

    release(id: number) {
        this.touches.delete(id);
    }

    private touching(note: NoteTiming) {
        for (const xs of this.touches.values()) if (Math.abs((xs[note.line] ?? Infinity) - note.x) <= REACH) return true;
        return false;
    }

    /** Advances to `time`: catches drags under fingers, settles holds and caught notes, and misses what has passed. */
    update(time: number): Hit[] {
        const hits: Hit[] = [];
        for (let k = this.next; k < this.order.length; k++) {
            const i = this.order[k];
            const note = this.notes[i];
            if (this.results[i] !== Judgment.Pending) continue;

            const hold = this.holding.get(i);
            if (hold) {
                if (note.end - time <= BAD_WINDOW) hold.safe = true;
                if (hold.safe) {
                    if (time >= note.end) {
                        this.holding.delete(i);
                        this.record(i, hold.perfect ? Judgment.Perfect : Judgment.Good, hits);
                    }
                } else if (!this.touching(note)) {
                    if (time > hold.up + UP_TOLERANCE) {
                        this.holding.delete(i);
                        this.record(i, Judgment.Miss, hits);
                    } else if (!Number.isFinite(hold.up)) {
                        hold.up = time;
                    }
                } else {
                    hold.up = Infinity;
                }
                continue;
            }

            const late = time - note.time;
            if (this.caught.has(i)) {
                if (late >= 0) {
                    this.caught.delete(i);
                    this.record(i, Judgment.Perfect, hits);
                }
                continue;
            }
            if (late > BAD_WINDOW) {
                this.record(i, Judgment.Miss, hits);
                continue;
            }
            if (-late > BAD_WINDOW) break;
            if (note.type === 2 && this.touching(note)) {
                if (late >= 0) this.record(i, Judgment.Perfect, hits);
                else this.caught.add(i);
            }
        }
        while (this.next < this.order.length && this.results[this.order[this.next]] !== Judgment.Pending) this.next++;
        return hits;
    }
}
