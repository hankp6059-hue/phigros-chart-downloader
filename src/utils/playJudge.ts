// judgment for playing a single-line chart by touch. positions are in positionX units along the
// judgment line (the caller projects each finger onto the line every frame, since the line moves).
//   tap / hold head: press near the note within the timing window
//   drag:  any finger resting near the note as it arrives
//   flick: a finger swiping near the note within the timing window
//   hold:  keep a finger near it until (almost) the end

import type { OfficialChart, OfficialNote } from './chartConverter';

export const PERFECT_WINDOW = 0.07;
export const GOOD_WINDOW = 0.15;
/** how far from a note's centre a finger still counts, in positionX units (a note is 1.8 wide) */
export const REACH = 1.5;
/** a hold may be let go this long before its end */
const HOLD_RELEASE_GRACE = 0.12;

export const Judgment = { Pending: 0, Perfect: 1, Good: 2, Miss: 3 } as const;
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
}

export class PlaySession {
    readonly notes: NoteTiming[];
    readonly results: Uint8Array;
    /** hold notes being held, with the judgment of their head */
    readonly holding = new Map<number, Judgment>();
    private readonly touches = new Map<number, number>();
    private next = 0;
    combo = 0;
    maxCombo = 0;
    readonly counts = { perfect: 0, good: 0, miss: 0 };

    constructor(chart: OfficialChart) {
        const line = chart.judgeLineList[0];
        const spu = 1.875 / line.bpm;
        this.notes = line.notesAbove.map(n => ({ type: n.type, time: n.time * spu, end: (n.time + n.holdTime) * spu, x: n.positionX }));
        this.results = new Uint8Array(this.notes.length);
    }

    get total() {
        return this.notes.length;
    }

    get finished() {
        return this.counts.perfect + this.counts.good + this.counts.miss === this.notes.length;
    }

    private record(index: number, judgment: Judgment, hits: Hit[]) {
        this.results[index] = judgment;
        if (judgment === Judgment.Miss) {
            this.counts.miss++;
            this.combo = 0;
        } else {
            if (judgment === Judgment.Perfect) this.counts.perfect++;
            else this.counts.good++;
            this.combo++;
            this.maxCombo = Math.max(this.maxCombo, this.combo);
        }
        hits.push({ index, judgment });
    }

    /** Pending notes of the given types whose window contains `time`, best match first. */
    private candidate(time: number, x: number, types: OfficialNote['type'][]) {
        let best = -1;
        let bestScore = Infinity;
        for (let i = this.next; i < this.notes.length; i++) {
            const note = this.notes[i];
            if (note.time - time > GOOD_WINDOW) break;
            if (this.results[i] !== Judgment.Pending || this.holding.has(i) || !types.includes(note.type)) continue;
            const dt = Math.abs(note.time - time);
            const dx = Math.abs(note.x - x);
            if (dt > GOOD_WINDOW || dx > REACH) continue;
            // earliest first, then nearest (for chords)
            const score = dt + dx * 0.01;
            if (score < bestScore) {
                bestScore = score;
                best = i;
            }
        }
        return best;
    }

    press(id: number, x: number, time: number): Hit[] {
        this.touches.set(id, x);
        const hits: Hit[] = [];
        const i = this.candidate(time, x, [1, 3]);
        if (i < 0) return hits;
        const judgment = Math.abs(this.notes[i].time - time) <= PERFECT_WINDOW ? Judgment.Perfect : Judgment.Good;
        if (this.notes[i].type === 3) {
            this.holding.set(i, judgment);
            hits.push({ index: i, judgment });
        } else {
            this.record(i, judgment, hits);
        }
        return hits;
    }

    /** A finger swiped (moved far enough quickly) at `x`. */
    swipe(id: number, x: number, time: number): Hit[] {
        this.moveTo(id, x);
        const hits: Hit[] = [];
        const i = this.candidate(time, x, [4]);
        if (i >= 0) this.record(i, Judgment.Perfect, hits);
        return hits;
    }

    /** Where a held-down finger is now (the line moves under resting fingers). */
    moveTo(id: number, x: number) {
        if (this.touches.has(id)) this.touches.set(id, x);
    }

    release(id: number) {
        this.touches.delete(id);
    }

    private touching(x: number, reach = REACH) {
        for (const tx of this.touches.values()) if (Math.abs(tx - x) <= reach) return true;
        return false;
    }

    /** Advances to `time`: catches drags under fingers, settles holds, and misses what has passed. */
    update(time: number): Hit[] {
        const hits: Hit[] = [];
        for (let i = this.next; i < this.notes.length; i++) {
            const note = this.notes[i];
            if (note.time - time > GOOD_WINDOW) break;
            if (this.results[i] !== Judgment.Pending) continue;

            if (this.holding.has(i)) {
                if (time >= note.end - HOLD_RELEASE_GRACE) {
                    this.record(i, this.holding.get(i)!, hits);
                    this.holding.delete(i);
                } else if (!this.touching(note.x, REACH * 1.5)) {
                    this.holding.delete(i);
                    this.record(i, Judgment.Miss, hits);
                }
                continue;
            }
            if (note.type === 2 && time >= note.time - PERFECT_WINDOW && this.touching(note.x)) {
                this.record(i, Judgment.Perfect, hits);
                continue;
            }
            if (time - note.time > GOOD_WINDOW) this.record(i, Judgment.Miss, hits);
        }
        while (this.next < this.notes.length && this.results[this.next] !== Judgment.Pending) this.next++;
        return hits;
    }
}
