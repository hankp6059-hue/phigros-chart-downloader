// judgment line animation driven by the song's emotional arc.
// each bar is read for energy (loudness), activity (onset density) and brightness (spectral centroid),
// classified (silent / calm / groove / build / drop / climax), and the line moves accordingly:
// calm passages breathe, grooves sway, build-ups wind the line up like a drawn bow, drops snap it
// level and slam it down, and climaxes move in a style blended from the song's own character
// (bright and busy -> bounce, dark and heavy -> pendulum, melodic -> wave following the melody).
// swings pass through level on the downbeats (as official charts do: the line is nearly level but
// moving when notes are hit), and the beat bounce bottoms out exactly on the beat.

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
    /** overall movement scale */
    amplitude: number;
    /** largest tilt, in degrees */
    maxAngle: number;
}

const MOTION: Record<GeneratorDifficulty, MotionProfile> = {
    EZ: { amplitude: 0.45, maxAngle: 6 },
    HD: { amplitude: 0.65, maxAngle: 10 },
    IN: { amplitude: 0.9, maxAngle: 16 },
    AT: { amplitude: 1.1, maxAngle: 22 },
};

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
    const { amplitude: A, maxAngle } = MOTION[options.difficulty];
    const beat = 60 / options.bpm;
    const bars = readBarMoods(analysis, options.bpm, options.firstBeat);
    const barSeconds = beat * BEATS_PER_BAR;
    const origin = bars[0].start;
    const { noteTimes, notePitches, random } = options;

    // the song's character decides how its climaxes move
    const meanOf = (values: Float32Array) => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    const brightnessMean = meanOf(analysis.brightness);
    const busy = clamp(noteTimes.length / Math.max(1, analysis.duration) / 6, 0, 1);
    const bright = clamp((brightnessMean - 10) / 2, 0, 1); // ~1 kHz dull .. ~4 kHz bright
    const pitchMean = notePitches.reduce((s, v) => s + v, 0) / Math.max(1, notePitches.length);
    const pitchSpread = Math.sqrt(notePitches.reduce((s, v) => s + (v - pitchMean) ** 2, 0) / Math.max(1, notePitches.length));
    const melodic = clamp(pitchSpread / 0.8, 0, 1);
    const scores = {
        bounce: 0.2 + bright * 0.5 + busy * 0.5,
        pendulum: 0.2 + (1 - bright) * 0.6 + (1 - busy) * 0.3,
        wave: 0.2 + melodic * 0.9,
    };
    const scoreSum = scores.bounce + scores.pendulum + scores.wave;
    const character = { bounce: scores.bounce / scoreSum, pendulum: scores.pendulum / scoreSum, wave: scores.wave / scoreSum };

    // per-section direction so consecutive build-ups and sways do not all lean the same way
    const direction = bars.map(() => (random() < 0.5 ? -1 : 1));
    // sways cross the centre on downbeats; only which way they start is up to chance
    const swayPhase = random() < 0.5 ? 0 : Math.PI;

    const barIndex = (time: number) => clamp(Math.floor((time - origin) / barSeconds), 0, bars.length - 1);

    // intensity between bar centres, and how "climactic" a moment is, eased over a beat
    const intensityAt = (time: number) => {
        const position = (time - origin) / barSeconds - 0.5;
        const i = clamp(Math.floor(position), 0, bars.length - 1);
        const j = Math.min(bars.length - 1, i + 1);
        const w = clamp(position - i, 0, 1);
        return bars[i].intensity * (1 - w) + bars[j].intensity * w;
    };
    const stateWeight = (time: number, match: (s: BarState) => boolean) => {
        const b = barIndex(time);
        const here = match(bars[b].state) ? 1 : 0;
        const into = (time - bars[b].start) / beat;
        const previous = b > 0 && match(bars[b - 1].state) ? 1 : 0;
        // ease in over the first beat of a bar from the previous bar's value
        return into < 1 ? previous + (here - previous) * smoothstep(into) : here;
    };
    const isClimax = (s: BarState) => s === 'climax' || s === 'drop';

    // build-ups: progress 0..1 across the run of build bars ending at a drop
    const buildRuns: { start: number; drop: number; direction: number }[] = [];
    for (let b = 0; b < bars.length; b++) {
        if (bars[b].state !== 'build' || (b > 0 && bars[b - 1].state === 'build')) continue;
        let e = b;
        while (e + 1 < bars.length && bars[e + 1].state === 'build') e++;
        buildRuns.push({ start: bars[b].start, drop: bars[e].end, direction: direction[b] });
    }
    const drops = bars.filter(b => b.state === 'drop').map(b => b.start);

    // smoothed melody contour (octaves above the song's mean) for the wave style
    const melodyAt = (time: number) => {
        let sum = 0;
        let weight = 0;
        const radius = beat * 2;
        let lo = 0;
        let hi = noteTimes.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (noteTimes[mid] < time - radius) lo = mid + 1;
            else hi = mid;
        }
        for (let i = lo; i < noteTimes.length && noteTimes[i] <= time + radius; i++) {
            const w = 1 - Math.abs(noteTimes[i] - time) / radius;
            sum += (notePitches[i] - pitchMean) * w;
            weight += w;
        }
        return weight > 0 ? clamp(sum / weight / Math.max(pitchSpread, 0.2), -1.5, 1.5) : 0;
    };

    const firstNote = noteTimes[0] ?? 0;
    const lastNote = noteTimes[noteTimes.length - 1] ?? analysis.duration;
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
        const beatPosition = (time - options.firstBeat) / beat;
        const barPosition = beatPosition / BEATS_PER_BAR;
        const intensity = intensityAt(time);
        const climax = stateWeight(time, isClimax);
        const calm = stateWeight(time, s => s === 'calm' || s === 'silent');

        let x = 0.5;
        let y = BASE_Y;
        let angle = 0;

        // breathing: slow rise and fall every two bars, strongest when the song is quiet
        y += 0.014 * A * Math.sin(Math.PI * barPosition) * (0.4 + 0.6 * calm);

        // groove: two-bar sway that grows with intensity, fading out where the climax takes over
        const sway = Math.sin(Math.PI * barPosition + swayPhase);
        x += 0.1 * A * intensity * sway * (1 - climax);
        angle += 0.4 * maxAngle * intensity * sway * (1 - climax);

        if (climax > 0) {
            // bounce: lowest (and still) on every beat
            const bounce = (1 + Math.cos(2 * Math.PI * beatPosition)) / 2;
            y -= climax * character.bounce * 0.035 * A * bounce;
            // pendulum: wide swing, one bar each way, sweeping through level on the downbeats
            const pendulum = Math.sin(Math.PI * barPosition + swayPhase);
            angle += climax * character.pendulum * maxAngle * pendulum;
            x -= climax * character.pendulum * 0.12 * A * pendulum;
            // wave: the line follows the melody
            const melody = melodyAt(time);
            x += climax * character.wave * 0.12 * A * melody;
            angle += climax * character.wave * 0.5 * maxAngle * melody;
        }

        // build-up: wind the line up towards the drop, then snap it level just before it lands
        for (const run of buildRuns) {
            if (time < run.start || time > run.drop) continue;
            const progress = (time - run.start) / (run.drop - run.start);
            const snapStart = run.drop - beat / 2;
            const release = time < snapStart ? 1 : 1 - easeOut((time - snapStart) / (beat / 2));
            angle += run.direction * 0.9 * maxAngle * progress * progress * release;
            y += 0.06 * A * progress * release;
            x += 0.02 * A * Math.sin(2 * Math.PI * beatPosition * (1 + progress)) * progress * release;
        }

        // drop impact: the line slams down for a beat
        for (const drop of drops) {
            if (time >= drop && time < drop + beat) y -= 0.04 * A * Math.sin(Math.PI * (time - drop) / beat);
        }

        // fade in before the first note, out after the last; dim during silence without notes
        let alpha = 1;
        alpha = Math.min(alpha, smoothstep((time - (firstNote - 2 * beat)) / (1.5 * beat)));
        alpha = Math.min(alpha, 1 - smoothstep((time - (lastNote + beat)) / (2 * beat)));
        if (bars[barIndex(time)].state === 'silent' && !nearNote(time, beat)) alpha = Math.min(alpha, 0.4);

        return {
            x: clamp(x, 0.5 - 0.15 * A, 0.5 + 0.15 * A),
            y: clamp(y, 0.2, 0.45),
            angle: clamp(angle, -maxAngle, maxAngle),
            alpha,
        };
    };

    return { bars, character, poseAt };
};
