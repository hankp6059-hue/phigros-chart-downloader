// scroll speed (line speed) that follows the music, in the manner of official charts: a steady base
// for the difficulty, slower in quiet and calm sections so their sparse notes read clearly, faster
// where the song is intense and notes are dense. build-ups speed up beat by beat into the drop,
// which lands at the top speed. speed only changes on bar lines (beats inside a build-up) and in
// steps of SPEED_STEP, so it moves when the music does and holds still otherwise.

import type { BarMood, BarState } from './lineMotion';
import type { GeneratorDifficulty } from './chartGenerator';

export interface SpeedChange {
    /** seconds */
    time: number;
    /** line speed (official units) from this time on */
    value: number;
}

/** speed of each kind of section relative to the difficulty's base speed */
const STATE_FACTOR: Record<BarState, number> = { silent: 0.8, calm: 0.88, groove: 1, build: 1, drop: 1.2, climax: 1.2 };
/** how far each difficulty follows the factors above (EZ keeps its speed steadier) */
const VARIATION: Record<GeneratorDifficulty, number> = { EZ: 0.5, HD: 0.75, IN: 1, AT: 1.1 };
const SPEED_STEP = 0.05;
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.9;
// sections shorter than this many bars are read as part of the section before them
const MIN_SECTION_BARS = 3;

const roundStep = (v: number) => Math.round(v / SPEED_STEP) * SPEED_STEP;

/**
 * Speed changes for a song from its bar moods. `base` is the difficulty's speed; fast songs get a
 * little more so notes a sixteenth apart stay apart on screen.
 */
export const buildScrollSpeed = (bars: BarMood[], options: { difficulty: GeneratorDifficulty; bpm: number; base: number }): SpeedChange[] => {
    const variation = VARIATION[options.difficulty];
    let tempo = options.bpm;
    while (tempo < 115) tempo *= 2;
    while (tempo > 260) tempo /= 2;
    const base = options.base * Math.min(1.1, Math.max(0.92, (tempo / 175) ** 0.25));
    const beat = 60 / options.bpm;
    const speedFor = (bar: BarMood) => {
        // inside a section, louder and busier bars run a touch faster
        const factor = STATE_FACTOR[bar.state] + (bar.state === 'groove' || bar.state === 'climax' ? 0.1 * (bar.intensity - 0.5) : 0);
        const value = base * (1 + (factor - 1) * variation);
        return Math.min(MAX_SPEED, Math.max(MIN_SPEED, roundStep(value)));
    };

    // sections: runs of bars in the same state. a drop opens the loud section after it, and a run
    // shorter than MIN_SECTION_BARS (a wobble of the mood reading) joins the section before it
    const states = bars.map(bar => (bar.state === 'drop' ? 'climax' : bar.state));
    for (let pass = 0; pass < 2; pass++) {
        for (let b = 1; b < states.length;) {
            let e = b;
            while (e + 1 < states.length && states[e + 1] === states[b]) e++;
            if (states[b] !== 'build' && e - b + 1 < MIN_SECTION_BARS && states[b - 1] !== 'build') {
                for (let i = b; i <= e; i++) states[i] = states[b - 1];
            }
            b = e + 1;
        }
    }
    const sections: { from: number; to: number; state: BarState }[] = [];
    for (let b = 0; b < states.length; b++) {
        const last = sections[sections.length - 1];
        if (last && last.state === states[b]) last.to = b;
        else sections.push({ from: b, to: b, state: states[b] });
    }
    const sectionSpeed = (section: (typeof sections)[number]) => {
        let sum = 0;
        for (let b = section.from; b <= section.to; b++) sum += speedFor({ ...bars[b], state: section.state });
        return Math.min(MAX_SPEED, Math.max(MIN_SPEED, roundStep(sum / (section.to - section.from + 1))));
    };

    const changes: SpeedChange[] = [];
    const push = (time: number, value: number) => {
        const v = Math.round(value * 100) / 100;
        const last = changes[changes.length - 1];
        if (last && Math.abs(last.value - v) < 1e-6) return;
        if (last && time - last.time < 1e-6) last.value = v;
        else changes.push({ time: Math.max(0, time), value: v });
    };

    let current = sectionSpeed(sections[0]);
    push(0, current);
    for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const start = bars[section.from].start;
        if (section.state === 'build') {
            // a build-up accelerates beat by beat towards the speed of the section it leads into
            const after = sections[i + 1] ? sectionSpeed(sections[i + 1]) : current;
            if (after - current < 2 * SPEED_STEP - 1e-9) continue;
            const from = current;
            const beats = Math.max(1, Math.round((bars[section.to].end - start) / beat));
            for (let k = 0; k < beats; k++) push(start + k * beat, roundStep(from + ((after - from) * (k + 1)) / (beats + 1)));
            current = changes[changes.length - 1].value;
            continue;
        }
        const next = sectionSpeed(section);
        // sections that differ only slightly keep the same speed
        if (Math.abs(next - current) < 2 * SPEED_STEP - 1e-9) continue;
        current = next;
        push(start, current);
    }
    return changes;
};
