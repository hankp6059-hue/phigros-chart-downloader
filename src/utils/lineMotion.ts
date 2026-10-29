// judgment line animation driven by the song's emotional arc, in the manner of official charts:
// the main line stands still most of the time (about half of an official chart) and makes short
// gestures of about 1.5 beats that return to rest, starting on accented beats. each bar is read for
// energy, activity and brightness and classified (silent / calm / groove / build / drop / climax);
// the mood sets how often the line gestures, section changes move it to a new resting pose, build-ups
// tilt it slowly and drops snap it back level with a dip. the kind of gesture follows the song's
// character (bright and busy -> dip, dark and heavy -> tilt, melodic -> sideways sway).

import type { AudioAnalysis, GeneratorDifficulty } from './chartGenerator';

export type BarState = 'silent' | 'calm' | 'groove' | 'build' | 'drop' | 'climax';

export interface BarMood {
    start: number;
    end: number;
    /** 0..1 blend of energy, activity and brightness, relative to the rest of the song */
    intensity: number;
    state: BarState;
}

export interface LinePose {
    /** screen position, 0..1 from left */
    x: number;
    /** screen position, 0..1 from bottom */
    y: number;
    /** degrees */
    angle: number;
    /** 0..1 */
    alpha: number;
}

export interface LineMotion {
    bars: BarMood[];
    /** how much each climax style contributes for this song (sums to 1) */
    character: { bounce: number; pendulum: number; wave: number };
    poseAt: (time: number) => LinePose;
}

interface MotionProfile {
    /** tilt of a gesture, in degrees (official main lines: up to ~3-5 degrees) */
    tilt: number;
    /** sideways and vertical size of a gesture, as a share of the screen */
    shift: number;
    /** how often the line gestures compared with the default rates */
    rate: number;
}

const MOTION: Record<GeneratorDifficulty, MotionProfile> = {
    EZ: { tilt: 2.5, shift: 0.012, rate: 0.7 },
    HD: { tilt: 3, shift: 0.015, rate: 0.85 },
    IN: { tilt: 4, shift: 0.018, rate: 1 },
    AT: { tilt: 5, shift: 0.02, rate: 1.1 },
};

/** gestures per minute in each kind of section, before the difficulty's rate */
const GESTURES_PER_MINUTE: Record<BarState, number> = { silent: 0, calm: 4, groove: 10, build: 0, drop: 18, climax: 18 };
/** gesture length in beats (official median 1.5) */
const GESTURE_BEATS = 1.5;

export const BASE_Y = 0.3;
const BEATS_PER_BAR = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (v: number) => {
    const t = clamp(v, 0, 1);
    return t * t * (3 - 2 * t);
};
const easeOut = (v: number) => 1 - (1 - clamp(v, 0, 1)) ** 3;

/** Spreads values between their 10th and 90th percentile over 0..1. */
const normalize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const low = sorted[Math.floor(0.1 * (sorted.length - 1))] ?? 0;
    const high = sorted[Math.floor(0.9 * (sorted.length - 1))] ?? 1;
    return values.map(v => (high - low < 1e-9 ? 0.5 : clamp((v - low) / (high - low), 0, 1)));
};

export const readBarMoods = (analysis: AudioAnalysis, bpm: number, firstBeat: number): BarMood[] => {
    const { envelope, lowLevel, loudness, brightness, frameSeconds, frameOrigin, duration } = analysis;
    const barSeconds = (60 / bpm) * BEATS_PER_BAR;
    // start at the first downbeat at or before 0
    const origin = firstBeat - Math.ceil(firstBeat / barSeconds) * barSeconds;
    const barCount = Math.max(1, Math.ceil((duration - origin) / barSeconds));

    const energy: number[] = [];
    const activity: number[] = [];
    const bright: number[] = [];
    const low: number[] = [];
    for (let b = 0; b < barCount; b++) {
        const from = Math.max(0, Math.round((origin + b * barSeconds - frameOrigin) / frameSeconds));
        const to = Math.min(envelope.length, Math.round((origin + (b + 1) * barSeconds - frameOrigin) / frameSeconds));
        let loud = 0;
        let onsets = 0;
        let centroid = 0;
        let kick = 0;
        for (let f = from; f < to; f++) {
            loud += loudness[f];
            kick += lowLevel[f];
            centroid += brightness[f] * loudness[f];
            if (f > 0 && f + 1 < envelope.length && envelope[f] > 0.3 && envelope[f] >= envelope[f - 1] && envelope[f] >= envelope[f + 1]) onsets++;
        }
        const frames = Math.max(1, to - from);
        energy.push(loud / frames);
        activity.push(onsets / BEATS_PER_BAR);
        bright.push(loud > 0 ? centroid / loud : 0);
        low.push(kick / frames);
    }

    const e = normalize(energy);
    const a = normalize(activity);
    const br = normalize(bright);
    // kick and bass presence: a drop is where the low end comes in
    const bass = normalize(low);
    const raw = e.map((v, i) => 0.5 * v + 0.3 * a[i] + 0.2 * br[i]);
    const intensity = raw.map((v, i) => 0.25 * (raw[i - 1] ?? v) + 0.5 * v + 0.25 * (raw[i + 1] ?? v));

    const states: BarState[] = intensity.map((v, i) => {
        if (energy[i] < 0.06) return 'silent';
        if (v >= 0.7) return 'climax';
        if (v < 0.3) return 'calm';
        return 'groove';
    });
    // a drop is where the low end (or everything) suddenly comes in; the rising bars before it
    // are its build-up
    for (let b = 1; b < barCount; b++) {
        const average = (values: number[]) => (values[b - 1] + (values[b - 2] ?? values[b - 1])) / 2;
        // a strong low end arriving, not merely more than the silence before it
        const bassEntry = bass[b] - average(bass) > 0.35 && bass[b] > 0.6 && raw[b] > 0.5;
        // a jump out of silence is a section starting, not a drop
        const afterSilence = states[b - 1] === 'silent' || states[b - 2] === 'silent';
        const surge = raw[b] - average(raw) > 0.25 && raw[b] > 0.55 && !afterSilence;
        // after a drop the energy holds; if it keeps climbing this is still the build-up
        // (absolute loudness: the normalised scale saturates in loud build-ups)
        const stillRising = b + 1 < barCount && energy[b + 1] > energy[b] * 1.15;
        if (!(bassEntry || surge) || stillRising || states[b - 1] === 'drop') continue;
        states[b] = 'drop';
        for (let k = 1; k <= 4 && b - k >= 0; k++) {
            const i = b - k;
            if (states[i] === 'silent' || states[i] === 'drop' || bass[i] > bass[b] - 0.3) break;
            // each earlier bar of a build-up is quieter than the one after it
            if (k > 1 && energy[i] > energy[i + 1] * 1.05) break;
            states[i] = 'build';
        }
    }
    // after a drop the climax carries on while the energy stays up
    for (let b = 1; b < barCount; b++) {
        if ((states[b - 1] === 'drop' || states[b - 1] === 'climax') && states[b] === 'groove' && intensity[b] >= 0.55) states[b] = 'climax';
    }

    return intensity.map((v, b) => ({
        start: origin + b * barSeconds,
        end: origin + (b + 1) * barSeconds,
        intensity: v,
        state: states[b],
    }));
};

interface Gesture {
    start: number;
    duration: number;
    kind: 'tilt' | 'dip' | 'sway';
    /** signed size: degrees for a tilt, share of the screen otherwise */
    amount: number;
}

/** Out and back: quick to its peak, then settling home, still at both ends. */
const pulse = (p: number) => (p < 0.35 ? smoothstep(p / 0.35) : 1 - smoothstep((p - 0.35) / 0.65));

export const buildLineMotion = (
    analysis: AudioAnalysis,
    options: {
        difficulty: GeneratorDifficulty;
        bpm: number;
        firstBeat: number;
        /** note hit times in seconds, sorted */
        noteTimes: number[];
        /** melody pitch (octaves) at each note time */
        notePitches: number[];
        random: () => number;
    },
): LineMotion => {
    const motion = MOTION[options.difficulty];
    const beat = 60 / options.bpm;
    const bars = readBarMoods(analysis, options.bpm, options.firstBeat);
    const barSeconds = beat * BEATS_PER_BAR;
    const origin = bars[0].start;
    const { noteTimes, notePitches, random } = options;
    const { envelope, bassEnvelope, frameSeconds, frameOrigin } = analysis;

    // the song's character decides which gestures it makes
    const meanOf = (values: Float32Array) => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    const busy = clamp(noteTimes.length / Math.max(1, analysis.duration) / 6, 0, 1);
    const bright = clamp((meanOf(analysis.brightness) - 10) / 2, 0, 1); // ~1 kHz dull .. ~4 kHz bright
    const pitchMean = notePitches.reduce((s, v) => s + v, 0) / Math.max(1, notePitches.length);
    const pitchSpread = Math.sqrt(notePitches.reduce((s, v) => s + (v - pitchMean) ** 2, 0) / Math.max(1, notePitches.length));
    const melodic = clamp(pitchSpread / 0.8, 0, 1);
    const scores = { bounce: 0.2 + bright * 0.5 + busy * 0.5, pendulum: 0.2 + (1 - bright) * 0.6 + (1 - busy) * 0.3, wave: 0.2 + melodic * 0.9 };
    const scoreSum = scores.bounce + scores.pendulum + scores.wave;
    const character = { bounce: scores.bounce / scoreSum, pendulum: scores.pendulum / scoreSum, wave: scores.wave / scoreSum };
    const pickKind = (): Gesture['kind'] => {
        const r = random();
        return r < character.bounce ? 'dip' : r < character.bounce + character.pendulum ? 'tilt' : 'sway';
    };

    // how accented a beat is: the strongest onset right on it
    const accentAt = (time: number) => {
        const center = Math.round((time - frameOrigin) / frameSeconds);
        let peak = 0;
        for (let f = center - 2; f <= center + 2; f++) {
            if (f >= 0 && f < envelope.length) peak = Math.max(peak, envelope[f], bassEnvelope[f]);
        }
        return peak;
    };

    // gestures: per bar, as many as its mood calls for, on its most accented beats, never overlapping
    const gestures: Gesture[] = [];
    let carry = 0;
    let side = random() < 0.5 ? -1 : 1;
    const free = (start: number, duration: number) => gestures.every(g => start >= g.start + g.duration + beat / 2 || start + duration <= g.start - beat / 2);
    for (const bar of bars) {
        carry = Math.min(1, carry + (GESTURES_PER_MINUTE[bar.state] * motion.rate * barSeconds) / 60);
        if (bar.state === 'drop' && bar.start >= 0 && free(bar.start, 2 * beat)) {
            // the drop itself: a dip right on its downbeat
            gestures.push({ start: bar.start, duration: 2 * beat, kind: 'dip', amount: -2 * motion.shift });
            carry = 0;
            continue;
        }
        const beats = Array.from({ length: BEATS_PER_BAR }, (_, k) => bar.start + k * beat)
            .filter(t => t >= 0)
            .map((t, k) => ({ t, accent: accentAt(t) * (k === 0 ? 1.2 : 1) }))
            .sort((a, b) => b.accent - a.accent);
        for (const candidate of beats) {
            if (carry < 1 || candidate.accent < 0.35) break;
            if (!free(candidate.t, GESTURE_BEATS * beat)) continue;
            const kind = pickKind();
            side = -side;
            const size = (0.6 + 0.4 * bar.intensity) * (kind === 'tilt' ? motion.tilt : motion.shift);
            gestures.push({ start: candidate.t, duration: GESTURE_BEATS * beat, kind, amount: kind === 'dip' ? -size : side * size });
            carry -= 1;
        }
    }
    gestures.sort((a, b) => a.start - b.start);

    // resting pose per section: a small new position whenever the mood changes, eased in over two beats
    const rests = [{ start: -Infinity, x: 0.5, y: BASE_Y, angle: 0 }];
    for (let b = 1; b < bars.length; b++) {
        if (bars[b].state === bars[b - 1].state || bars[b].state === 'build') continue;
        const settled = bars[b].state === 'calm' || bars[b].state === 'silent' || bars[b].state === 'drop';
        rests.push({
            start: bars[b].start,
            x: settled ? 0.5 : 0.5 + (random() * 2 - 1) * motion.shift * 2,
            y: BASE_Y + (settled ? 0 : (random() * 2 - 1) * motion.shift),
            angle: settled ? 0 : (random() * 2 - 1) * motion.tilt * 0.5,
        });
    }
    const restAt = (time: number) => {
        let i = rests.length - 1;
        while (i > 0 && rests[i].start > time) i--;
        const to = rests[i];
        if (i === 0) return to;
        const from = rests[i - 1];
        const p = smoothstep((time - to.start) / (2 * beat));
        return { start: to.start, x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p, angle: from.angle + (to.angle - from.angle) * p };
    };

    // build-ups: a slow lean towards the drop, snapped back level just before it lands
    const buildRuns: { start: number; drop: number; direction: number }[] = [];
    for (let b = 0; b < bars.length; b++) {
        if (bars[b].state !== 'build' || (b > 0 && bars[b - 1].state === 'build')) continue;
        let e = b;
        while (e + 1 < bars.length && bars[e + 1].state === 'build') e++;
        buildRuns.push({ start: bars[b].start, drop: bars[e].end, direction: random() < 0.5 ? -1 : 1 });
    }

    const firstNote = noteTimes[0] ?? 0;
    const lastNote = noteTimes[noteTimes.length - 1] ?? analysis.duration;
    const barIndex = (time: number) => clamp(Math.floor((time - origin) / barSeconds), 0, bars.length - 1);
    const nearNote = (time: number, window: number) => {
        let lo = 0;
        let hi = noteTimes.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (noteTimes[mid] < time - window) lo = mid + 1;
            else hi = mid;
        }
        return lo < noteTimes.length && noteTimes[lo] <= time + window;
    };

    const poseAt = (time: number): LinePose => {
        let { x, y, angle } = restAt(time);

        for (const g of gestures) {
            if (g.start > time) break;
            const p = (time - g.start) / g.duration;
            if (p >= 1) continue;
            const shape = pulse(p);
            if (g.kind === 'tilt') angle += g.amount * shape;
            else if (g.kind === 'dip') y += g.amount * shape;
            else x += g.amount * shape;
        }

        for (const run of buildRuns) {
            if (time < run.start || time > run.drop) continue;
            const progress = (time - run.start) / (run.drop - run.start);
            const snapStart = run.drop - beat / 2;
            const release = time < snapStart ? 1 : 1 - easeOut((time - snapStart) / (beat / 2));
            angle += run.direction * 2 * motion.tilt * progress * progress * release;
            y += 2 * motion.shift * progress * release;
        }

        // fade in before the first note, out after the last; dim during silence without notes
        let alpha = 1;
        alpha = Math.min(alpha, smoothstep((time - (firstNote - 2 * beat)) / (1.5 * beat)));
        alpha = Math.min(alpha, 1 - smoothstep((time - (lastNote + beat)) / (2 * beat)));
        if (bars[barIndex(time)].state === 'silent' && !nearNote(time, beat)) alpha = Math.min(alpha, 0.4);

        return { x: clamp(x, 0.38, 0.62), y: clamp(y, 0.2, 0.45), angle: clamp(angle, -12, 12), alpha };
    };

    return { bars, character, poseAt };
};
