// automatic chart generation for user-imported songs.
// analyses the audio (spectral-flux onsets, tempo and beat phase), then places notes on a beat grid
// and emits an official-format chart so it goes through the same export pipeline as game charts.

import type { OfficialChart, OfficialNote } from './chartConverter';
import { BASE_Y, LineMotion, LinePose, buildLineMotion, readBarMoods } from './lineMotion';
import { SpeedChange, buildScrollSpeed } from './scrollSpeed';
import { PLACEMENT_FEATURES, placementScore } from './placementModel';

export type GeneratorDifficulty = 'EZ' | 'HD' | 'IN' | 'AT';

export const GENERATOR_DIFFICULTIES: GeneratorDifficulty[] = ['EZ', 'HD', 'IN', 'AT'];

/** how the chart is meant to be played: one finger per hand (two thumbs, on a phone) or several (on a tablet) */
export type FingeringStyle = 'single' | 'multi';

export const FINGERING_STYLES: FingeringStyle[] = ['single', 'multi'];

export interface AudioAnalysis {
    duration: number;
    /** seconds per envelope frame */
    frameSeconds: number;
    /** time of envelope frame 0, in seconds */
    frameOrigin: number;
    /** onset strength per frame, roughly 0..1 */
    envelope: Float32Array;
    /** onset strength below ~250 Hz (kicks, bass), roughly 0..1 */
    bassEnvelope: Float32Array;
    /** loudness per frame, 0..1 */
    loudness: Float32Array;
    /** dominant pitch of the melody range per frame, in octaves (log2 Hz) */
    pitch: Float32Array;
    /** strength of that dominant tone per frame (linear magnitude) */
    tone: Float32Array;
    /** spectral centroid per frame, in octaves (log2 Hz); higher sounds brighter and tenser */
    brightness: Float32Array;
    /** energy below ~150 Hz per frame (kick and bass line), 0..1 */
    lowLevel: Float32Array;
    bpm: number;
    /** time of the first beat on the detected grid, in seconds (0 <= firstBeat < beat length) */
    firstBeat: number;
}

export interface GeneratorOptions {
    difficulty: GeneratorDifficulty;
    bpm: number;
    /** time of any beat on the grid, in seconds */
    firstBeat: number;
    seed: string;
    /** animate the judgment line from the song's mood (default true) */
    lineMotion?: boolean;
    /** pick note positions with the learned placement model rather than onset strength (default true) */
    learnedPlacement?: boolean;
    /** change the scroll speed with the music (default true) */
    speedChanges?: boolean;
    /** fingers per hand the chart is written for (default 'single') */
    fingering?: FingeringStyle;
}

export interface GeneratedChart {
    chart: OfficialChart;
    /** present when the line is animated */
    motion?: LineMotion;
    /** difficulty constant on the official scale */
    level: number;
    /** scroll speed over the song (official units) */
    speed: { min: number; max: number; changes: SpeedChange[] };
    stats: { total: number; tap: number; drag: number; hold: number; flick: number };
}

// ---------- analysis ----------

const fft = (re: Float64Array, im: Float64Array) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k;
                const b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci;
                const ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
            }
        }
    }
};

const percentile = (values: Float32Array, p: number) => {
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] || 1;
};

/** Strength of the beat grid at the given tempo, plus the phase of its first beat. */
const gridAlignment = (envelope: Float32Array, frameSeconds: number, frameOrigin: number, bpm: number) => {
    const period = 60 / bpm;
    let re = 0;
    let im = 0;
    for (let i = 0; i < envelope.length; i++) {
        const angle = (2 * Math.PI * (frameOrigin + i * frameSeconds)) / period;
        re += envelope[i] * Math.cos(angle);
        im += envelope[i] * Math.sin(angle);
    }
    const phase = ((Math.atan2(im, re) / (2 * Math.PI)) * period + period) % period;
    return { strength: Math.hypot(re, im), phase };
};

/** Spectral flux with its slowly varying part removed, so only onsets stand out. */
const onsetEnvelope = (flux: Float32Array, frameSeconds: number) => {
    const frameCount = flux.length;
    const radius = Math.max(1, Math.round(0.15 / frameSeconds));
    const envelope = new Float32Array(frameCount);
    let windowSum = 0;
    for (let i = 0; i < Math.min(frameCount, radius); i++) windowSum += flux[i];
    for (let i = 0; i < frameCount; i++) {
        if (i + radius < frameCount) windowSum += flux[i + radius];
        if (i - radius - 1 >= 0) windowSum -= flux[i - radius - 1];
        const count = Math.min(frameCount - 1, i + radius) - Math.max(0, i - radius) + 1;
        envelope[i] = Math.max(0, flux[i] - windowSum / count);
    }
    const scale = percentile(envelope, 0.99);
    for (let i = 0; i < frameCount; i++) envelope[i] = Math.min(3, envelope[i] / scale);
    return envelope;
};

const TEMPO_PRIOR = 140;

export const analyzeAudio = (channels: Float32Array[], sampleRate: number, tempoPrior = TEMPO_PRIOR): AudioAnalysis => {
    const length = channels[0].length;
    const mono = new Float32Array(length);
    for (const channel of channels) {
        for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
    }

    // a short window keeps onset timing sharp; a separate long window centred on the same
    // moment resolves pitch (~23 Hz bins)
    const fftSize = sampleRate > 50000 ? 2048 : 1024;
    const hop = fftSize / 2;
    const bins = fftSize / 2;
    const pitchSize = fftSize * 2;
    const frameCount = Math.max(1, Math.floor((length - fftSize) / hop) + 1);
    const hann = (size: number) => new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
    const window = hann(fftSize);
    const pitchWindow = hann(pitchSize);

    // kick drums and bass mark the beat in most music; bins below ~250 Hz track them separately
    const bassBins = Math.max(2, Math.round((250 * fftSize) / sampleRate));
    const flux = new Float32Array(frameCount);
    const bassFlux = new Float32Array(frameCount);
    const loudness = new Float32Array(frameCount);
    const pitch = new Float32Array(frameCount);
    const tone = new Float32Array(frameCount);
    const brightness = new Float32Array(frameCount);
    const lowLevel = new Float32Array(frameCount);
    const lowBins = Math.max(1, Math.round((150 * fftSize) / sampleRate));
    // melody range: above most kick/bass energy, below cymbal noise
    const pitchLow = Math.round((150 * pitchSize) / sampleRate);
    const pitchHigh = Math.round((2000 * pitchSize) / sampleRate);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const pitchRe = new Float64Array(pitchSize);
    const pitchIm = new Float64Array(pitchSize);
    const pitchMagnitude = new Float64Array(pitchSize / 2);
    let previous = new Float64Array(bins);
    let current = new Float64Array(bins);

    for (let f = 0; f < frameCount; f++) {
        const offset = f * hop;
        let energy = 0;
        for (let i = 0; i < fftSize; i++) {
            const sample = mono[offset + i] ?? 0;
            energy += sample * sample;
            re[i] = sample * window[i];
            im[i] = 0;
        }
        loudness[f] = Math.sqrt(energy / fftSize);
        fft(re, im);
        let sum = 0;
        let weighted = 0;
        let total = 0;
        for (let k = 1; k < bins; k++) {
            const magnitude = Math.hypot(re[k], im[k]);
            current[k] = Math.log1p(100 * magnitude);
            if (f > 0) sum += Math.max(0, current[k] - previous[k]);
            if (k === bassBins) bassFlux[f] = sum;
            weighted += k * magnitude;
            total += magnitude;
            if (k <= lowBins) lowLevel[f] += magnitude * magnitude;
        }
        flux[f] = sum;
        brightness[f] = Math.log2(Math.max(1, (weighted / Math.max(total, 1e-9)) * (sampleRate / fftSize)));

        const pitchOffset = offset + fftSize / 2 - pitchSize / 2;
        for (let i = 0; i < pitchSize; i++) {
            pitchRe[i] = (mono[pitchOffset + i] ?? 0) * pitchWindow[i];
            pitchIm[i] = 0;
        }
        fft(pitchRe, pitchIm);
        let peakBin = pitchLow;
        for (let k = pitchLow - 1; k <= pitchHigh + 1; k++) {
            pitchMagnitude[k] = Math.log1p(100 * Math.hypot(pitchRe[k], pitchIm[k]));
            if (k >= pitchLow && k <= pitchHigh && pitchMagnitude[k] > pitchMagnitude[peakBin]) peakBin = k;
        }
        // parabolic interpolation between neighbouring bins
        const [a, b, c] = [pitchMagnitude[peakBin - 1], pitchMagnitude[peakBin], pitchMagnitude[peakBin + 1]];
        // a true peak lies within half a bin; flat spectra (silence) would otherwise throw it anywhere
        const curvature = a - 2 * b + c;
        const shift = curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curvature)) : 0;
        pitch[f] = Math.log2(((peakBin + shift) * sampleRate) / pitchSize);
        tone[f] = Math.hypot(pitchRe[peakBin], pitchIm[peakBin]);
        [previous, current] = [current, previous];
    }

    const frameSeconds = hop / sampleRate;
    const envelope = onsetEnvelope(flux, frameSeconds);
    const bassEnvelope = onsetEnvelope(bassFlux, frameSeconds);
    const loudnessScale = percentile(loudness, 0.99);
    const lowScale = percentile(lowLevel, 0.99);
    for (let i = 0; i < frameCount; i++) {
        loudness[i] = Math.min(1, loudness[i] / loudnessScale);
        lowLevel[i] = Math.min(1, lowLevel[i] / lowScale);
    }

    const frameOrigin = fftSize / 2 / sampleRate;

    // the beat lives mostly in the low end: off-beat hi-hats weigh as much as beats in the full band
    // and cancel the fundamental out, so tempo is estimated with the bass onsets weighted up
    const beatEnvelope = envelope.map((v, i) => 0.5 * v + bassEnvelope[i]);

    // coarse tempo: favour tempos whose eighth notes also line up, weighted towards common tempos
    let coarse = 120;
    let best = -Infinity;
    // Phigros-style songs run fast: search up to 260 BPM, leaning towards ~140
    for (let bpm = 70; bpm <= 260; bpm += 0.5) {
        const fundamental = gridAlignment(beatEnvelope, frameSeconds, frameOrigin, bpm).strength;
        const eighths = gridAlignment(beatEnvelope, frameSeconds, frameOrigin, bpm * 2).strength;
        const prior = Math.exp(-0.5 * (Math.log2(bpm / tempoPrior) / 0.6) ** 2);
        const score = (fundamental + 0.5 * eighths) * (0.6 + 0.4 * prior);
        if (score > best) {
            best = score;
            coarse = bpm;
        }
    }

    // fine tempo: small drift matters over a whole song, so search in 0.01 steps
    let bpm = coarse;
    best = -Infinity;
    for (let candidate = coarse - 1; candidate <= coarse + 1; candidate += 0.01) {
        const { strength } = gridAlignment(beatEnvelope, frameSeconds, frameOrigin, candidate);
        if (strength > best) {
            best = strength;
            bpm = candidate;
        }
    }
    // most songs use whole-number tempos
    const rounded = Math.round(bpm);
    if (gridAlignment(beatEnvelope, frameSeconds, frameOrigin, rounded).strength >= best * 0.95) bpm = rounded;
    else bpm = Math.round(bpm * 100) / 100;

    // the full-band grid can lock onto off-beats (hi-hats are broadband), so pick the quarter-beat
    // shift whose beats carry the most bass onsets
    const period = 60 / bpm;
    const phase = gridAlignment(beatEnvelope, frameSeconds, frameOrigin, bpm).phase;
    const tolerance = Math.max(1, Math.round(0.03 / frameSeconds));
    let firstBeat = phase;
    best = -Infinity;
    for (let shift = 0; shift < 4; shift++) {
        const candidate = (phase + (shift * period) / 4) % period;
        let score = 0;
        for (let time = candidate; time < length / sampleRate; time += period) {
            const center = Math.round((time - frameOrigin) / frameSeconds);
            let peak = 0;
            for (let f = center - tolerance; f <= center + tolerance; f++) {
                if (f >= 0 && f < frameCount) peak = Math.max(peak, bassEnvelope[f]);
            }
            score += peak;
        }
        // only move off the full-band phase when the bass clearly prefers another one
        if (score > best * (shift === 0 ? 1 : 1.1)) {
            best = score;
            firstBeat = candidate;
        }
    }

    // the averaged phase is pulled around by off-beat notes; snap it onto the actual onset peaks
    const onsetAt = (time: number) => {
        const position = (time - frameOrigin) / frameSeconds;
        const i = Math.floor(position);
        if (i < 0 || i + 1 >= frameCount) return 0;
        const weight = position - i;
        const at = (f: number) => Math.max(envelope[f], bassEnvelope[f]);
        return at(i) * (1 - weight) + at(i + 1) * weight;
    };
    let refined = firstBeat;
    best = -Infinity;
    for (let delta = -0.03; delta <= 0.03; delta += 0.001) {
        let score = 0;
        for (let time = firstBeat + delta; time < length / sampleRate; time += period) score += onsetAt(time);
        if (score > best) {
            best = score;
            refined = firstBeat + delta;
        }
    }
    firstBeat = ((refined % period) + period) % period;

    return {
        duration: length / sampleRate,
        frameSeconds,
        frameOrigin,
        envelope,
        bassEnvelope,
        loudness,
        pitch,
        tone,
        brightness,
        lowLevel,
        bpm,
        firstBeat,
    };
};


// ---------- generation ----------

// targets are the medians of official Phigros charts per difficulty (notes per second, share of each key);
// densities were then scaled so generated note counts match official ones on 39 training songs
interface DifficultyProfile {
    /** grid slots per beat */
    subdivision: number;
    /** target notes per second of non-silent audio, chords included */
    density: number;
    /** minimum distance between notes, in beats */
    minGap: number;
    /** line speed (official units) */
    speed: number;
    /** half-width of the playfield used, in official positionX units (screen is 18 wide) */
    spread: number;
    chordRate: number;
    flickRate: number;
    dragRate: number;
    holdRate: number;
    /** shortest hold, in beats */
    minHold: number;
    /** positions snap to this step (0 = free) */
    grid: number;
    /** shortest time between two taps of the same hand, in seconds; anything quicker is played hand to hand */
    sameHand: number;
    /** how far a hand travels across the screen per second, in positionX units */
    handSpeed: number;
}

const PROFILES: Record<GeneratorDifficulty, DifficultyProfile> = {
    EZ: { subdivision: 2, density: 1.75, minGap: 0.5, speed: 0.9, spread: 5.5, chordRate: 0.05, flickRate: 0.06, dragRate: 0.35, holdRate: 0.1, minHold: 1, grid: 0.5, sameHand: 0.4, handSpeed: 9 },
    HD: { subdivision: 4, density: 3.9, minGap: 0.25, speed: 1.0, spread: 6, chordRate: 0.14, flickRate: 0.07, dragRate: 0.32, holdRate: 0.08, minHold: 1, grid: 0.5, sameHand: 0.22, handSpeed: 13 },
    IN: { subdivision: 4, density: 6.1, minGap: 0.25, speed: 1.15, spread: 6.25, chordRate: 0.24, flickRate: 0.09, dragRate: 0.22, holdRate: 0.09, minHold: 0.5, grid: 0, sameHand: 0.15, handSpeed: 17 },
    AT: { subdivision: 4, density: 8.7, minGap: 0.25, speed: 1.3, spread: 6.5, chordRate: 0.32, flickRate: 0.09, dragRate: 0.18, holdRate: 0.09, minHold: 0.5, grid: 0, sameHand: 0.12, handSpeed: 21 },
};

// below this placement probability a position is left empty however few notes there are
const MIN_PLACEMENT = 0.1;

interface FingeringProfile {
    /** fingers per hand */
    fingers: number;
    /** widest stretch between the fingers of one hand, in positionX units */
    span: number;
    /** shortest time between two taps by different fingers of the same hand, in seconds */
    fingerGap: number;
    /** chords compared with the difficulty's rate */
    chordScale: number;
    /** per difficulty: notes compared with the difficulty's density */
    density: Record<GeneratorDifficulty, number>;
    /** per difficulty: share of notes that are chords of three */
    triple: Record<GeneratorDifficulty, number>;
    /** per difficulty: chance that a note in a fast run stays on the same hand (the next finger along) */
    roll: Record<GeneratorDifficulty, number>;
    /** per difficulty: lowest placement probability that still gets a note (fast runs need more of them) */
    minPlacement: Record<GeneratorDifficulty, number>;
    /** holds compared with the difficulty's rate */
    holdScale: number;
    /** holds that may be held at once (one per hand at most) */
    maxHolds: number;
    /** whether weak hits under a hold are kept (another finger of the holding hand can play them) */
    keepUnderHolds: boolean;
}

const NONE = { EZ: 0, HD: 0, IN: 0, AT: 0 };

// multi-finger figures are matched to the 20 official charts rated 17 and above, which are written for
// several fingers (medians: 10.5 notes per second, 2-note chords 28% and 3+ note chords 7% of hit times,
// three or more fingers down at 15% of hit times, 10% of notes played under a hold, a quarter of those
// by the holding hand, a quarter of quick taps rolled across one hand). charts of level 13-14 show none
// of the three-finger patterns, and the single-finger style keeps to them
const FINGERING: Record<FingeringStyle, FingeringProfile> = {
    // two thumbs (or index fingers): every finger is a hand
    single: { fingers: 1, span: 0, fingerGap: 0, chordScale: 1, density: { EZ: 1, HD: 1, IN: 1, AT: 1 }, triple: NONE, roll: NONE, minPlacement: { EZ: MIN_PLACEMENT, HD: MIN_PLACEMENT, IN: MIN_PLACEMENT, AT: MIN_PLACEMENT }, holdScale: 1, maxHolds: 1, keepUnderHolds: false },
    // tablet: index, middle and ring finger of each hand, side by side within about a third of the screen
    multi: {
        fingers: 3, span: 5.5, fingerGap: 0.07, chordScale: 1.3,
        density: { EZ: 1, HD: 1.1, IN: 1.3, AT: 1.5 },
        triple: { EZ: 0, HD: 0.02, IN: 0.07, AT: 0.13 },
        roll: { EZ: 0, HD: 0.2, IN: 0.3, AT: 0.35 },
        minPlacement: { EZ: MIN_PLACEMENT, HD: 0.08, IN: 0.05, AT: 0.03 },
        holdScale: 2,
        maxHolds: 2,
        keepUnderHolds: true,
    },
};

// official charts span their constant events across the whole song with these bounds
const EVENT_START = -999999;
const EVENT_END = 1000000000;
// line poses are sampled every 1/8 beat (official time unit is 1/32 beat)
const MOTION_STEP = 4;
// keep notes inside this share of the screen around the centre
const SAFE_WIDTH = 0.45 * 1350;
const SAFE_HEIGHT = 0.45 * 900;
const UNIT = 1350 / 18;
// notes are 1.8 units wide. within CLOSE_SECONDS of each other two notes are either a clean repeat
// (exactly the same spot, at least REPEAT_SECONDS apart) or at least NOTE_GAP apart, never half on
// top of each other
const NOTE_GAP = 2;
const CLOSE_SECONDS = 0.4;
// note times are rounded to 1/32 beat on export (up to ~8 ms on fast songs): checks keep this margin
const ROUNDING_MARGIN = 0.02;
const REPEAT_SECONDS = 0.25;
// drag streams glide note to note within this gap
const GLIDE_SECONDS = 0.3;
// a note this long before a rest ends a phrase
const PHRASE_REST = 0.4;
// a flick's swipe catches a tap or hold this close behind it (seconds, positionX units; the margin over
// 3.5 covers the line moving between the two)
const FLICK_CLEAR_SECONDS = 0.3;
const FLICK_CLEAR_UNITS = 4;
// a hand reaches at most this far past the middle of the screen
const CENTER_REACH = 1.5;
// a hand that played within this many seconds still has its finger down where it played
const HAND_MEMORY = 0.8;
// fingers of one hand used within this many seconds keep it in shape (within FingeringProfile.span)
const SPAN_MEMORY = 0.5;
// notes closer than this go hand to hand even when one hand could play both
const ALTERNATE_SECONDS = 0.3;
const SILENCE = 0.04;
const MIN_ONSET = 0.12;
const SEMITONE = 1 / 12;

// least-squares fit of official difficulty constants on note features (516 official charts,
// mean error about ±1). Official charts also get harder through line motion, which this ignores.
// generated charts use one judgment line and fewer chords than official ones, so the fit above
// underrates their harder difficulties. offsets measured against official charts of the same 14 songs
// (leave-one-out: IN error ±1.50 -> ±0.77); EZ/HD showed no gain. AT has no benchmark and follows IN.
const LEVEL_CALIBRATION: Record<GeneratorDifficulty, number> = { EZ: 0, HD: 0, IN: 1.5, AT: 1.5 };

const RATING_WEIGHTS = { intercept: 1.5455, logDensity: 3.1199, logPeakDensity: 3.3408, chord: 1.9774, drag: -7.4512 };

/** Difficulty constant on the official scale, from note times (seconds) and types. */
export const rateNotes = (notes: { time: number; type: OfficialNote['type'] }[]): number => {
    if (notes.length < 2) return 1;
    const times = notes.map(n => n.time).sort((a, b) => a - b);
    const count = times.length;
    const density = count / Math.max(times[count - 1] - times[0], 1);

    // 90th percentile of notes per second over 2 s windows
    const lowerBound = (t: number) => {
        let lo = 0;
        let hi = count;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (times[mid] < t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const windows: number[] = [];
    for (let t = times[0]; t < times[count - 1]; t += 0.5) windows.push((lowerBound(t + 2) - lowerBound(t)) / 2);
    windows.sort((a, b) => a - b);
    const peakDensity = windows.length ? windows[Math.floor(0.9 * (windows.length - 1))] : 0;

    let chords = 0;
    for (let i = 1; i < count; i++) if (times[i] - times[i - 1] < 0.005) chords++;
    const drags = notes.filter(n => n.type === 2).length;

    const level = RATING_WEIGHTS.intercept
        + RATING_WEIGHTS.logDensity * Math.log(density)
        + RATING_WEIGHTS.logPeakDensity * Math.log(Math.max(peakDensity, 0.5))
        + RATING_WEIGHTS.chord * (chords / count)
        + RATING_WEIGHTS.drag * (drags / count);
    return Math.round(Math.min(16.9, Math.max(1, level)) * 10) / 10;
};

const createRandom = (seed: string) => {
    let state = 2166136261;
    for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

interface PlannedNote {
    slot: number;
    strength: number;
    /** melody pitch in octaves */
    pitch: number;
    type: OfficialNote['type'];
    holdSlots: number;
    x: number;
    chord: boolean;
    /** a chord of three */
    triple?: boolean;
    /** type of the chord's other note (official chords mix types: drag with tap, flick with tap ...) */
    partnerType?: OfficialNote['type'];
}

/** Takes the best `rate` share of `candidates` (by score, highest first) that pass `accept`. */
const takeTop = <T>(candidates: T[], total: number, rate: number, score: (c: T) => number, accept: (c: T) => boolean = () => true) => {
    const wanted = Math.round(rate * total);
    const chosen: T[] = [];
    for (const c of [...candidates].sort((a, b) => score(b) - score(a))) {
        if (chosen.length >= wanted) break;
        if (accept(c)) chosen.push(c);
    }
    return chosen;
};

// ---------- note placement features (shared by model training and generation) ----------

export const FEATURE_NAMES = [
    'peak', 'envPeak', 'bassPeak', 'loud', 'section', 'low', 'bright', 'pitchMove', 'toneJump',
    'beat', 'eighth', 'sixteenth', 'triplet', 'sixth', 'downbeat', 'prevBeatPeak', 'nextBeatPeak', 'localDensity', 'tempo',
] as const;

/** Musical features of a candidate note position, in the order of FEATURE_NAMES. */
export const createFeatureExtractor = (analysis: AudioAnalysis, bpm: number, firstBeat: number) => {
    const { envelope, bassEnvelope, loudness, lowLevel, brightness, pitch, tone, frameSeconds, frameOrigin } = analysis;
    const beat = 60 / bpm;
    const frameAt = (time: number) => Math.round((time - frameOrigin) / frameSeconds);
    const valueAt = (values: Float32Array, frame: number) => values[Math.max(0, Math.min(values.length - 1, frame))];
    const tolerance = Math.max(1, Math.round(0.025 / frameSeconds));
    /** largest local maximum of a curve within the tolerance of `time` (0 when there is no onset) */
    const peakNear = (values: Float32Array, time: number) => {
        const center = frameAt(time);
        let peak = 0;
        for (let f = center - tolerance; f <= center + tolerance; f++) {
            if (f < 1 || f + 1 >= values.length) continue;
            if (values[f] >= values[f - 1] && values[f] >= values[f + 1]) peak = Math.max(peak, values[f]);
        }
        return peak;
    };
    const combinedPeak = (time: number) => Math.max(peakNear(envelope, time), peakNear(bassEnvelope, time));
    const loudnessSum = new Float64Array(loudness.length + 1);
    for (let f = 0; f < loudness.length; f++) loudnessSum[f + 1] = loudnessSum[f] + loudness[f];
    const envelopeSum = new Float64Array(envelope.length + 1);
    for (let f = 0; f < envelope.length; f++) envelopeSum[f + 1] = envelopeSum[f] + envelope[f];
    const meanOver = (sum: Float64Array, from: number, to: number) => {
        const a = Math.max(0, from);
        const b = Math.min(sum.length - 1, to);
        return b > a ? (sum[b] - sum[a]) / (b - a) : 0;
    };
    const sectionRadius = Math.max(1, Math.round((beat * 4) / frameSeconds));
    let loudestSection = 1e-9;
    for (let f = 0; f < loudness.length; f += sectionRadius) loudestSection = Math.max(loudestSection, meanOver(loudnessSum, f - sectionRadius, f + sectionRadius));
    const brightnessMean = brightness.reduce((s, v) => s + v, 0) / Math.max(1, brightness.length);
    const halfBeatFrames = Math.max(1, Math.round(beat / 2 / frameSeconds));
    const near = (fraction: number, target: number) => Math.abs(fraction - target) * beat < 0.012;

    return (time: number): number[] => {
        const f = frameAt(time);
        const beats = (time - firstBeat) / beat;
        const fraction = ((beats % 1) + 1) % 1;
        const onBeat = near(fraction, 0) || near(fraction, 1);
        const pitchShift = Math.abs(valueAt(pitch, frameAt(time + 0.05)) - valueAt(pitch, frameAt(time - 0.05))) * 12;
        const toneRatio = Math.log2((valueAt(tone, f + 2) + 1e-6) / (valueAt(tone, f - 3) + 1e-6));
        return [
            combinedPeak(time),
            peakNear(envelope, time),
            peakNear(bassEnvelope, time),
            valueAt(loudness, f),
            Math.min(1, meanOver(loudnessSum, f - sectionRadius, f + sectionRadius) / loudestSection),
            valueAt(lowLevel, f),
            valueAt(brightness, f) - brightnessMean,
            Math.min(12, pitchShift) / 12,
            Math.max(-3, Math.min(3, toneRatio)) / 3,
            onBeat ? 1 : 0,
            near(fraction, 0.5) ? 1 : 0,
            near(fraction, 0.25) || near(fraction, 0.75) ? 1 : 0,
            near(fraction, 1 / 3) || near(fraction, 2 / 3) ? 1 : 0,
            near(fraction, 1 / 6) || near(fraction, 5 / 6) ? 1 : 0,
            onBeat && ((Math.round(beats) % 4) + 4) % 4 === 0 ? 1 : 0,
            combinedPeak(time - beat),
            combinedPeak(time + beat),
            meanOver(envelopeSum, f - halfBeatFrames, f + halfBeatFrames),
            Math.log2(bpm / 160),
        ];
    };
};

/** Whether off-beat onsets fall on triplet positions more than on straight sixteenths. */
const swingsInTriplets = (analysis: AudioAnalysis, bpm: number, firstBeat: number) => {
    const { envelope, frameSeconds, frameOrigin } = analysis;
    const beat = 60 / bpm;
    const near = (fraction: number, targets: number[]) => targets.some(t => Math.abs(fraction - t) * beat < 0.025);
    let triplet = 0;
    let sixteenth = 0;
    for (let f = 1; f + 1 < envelope.length; f++) {
        if (envelope[f] < 0.3 || envelope[f] < envelope[f - 1] || envelope[f] < envelope[f + 1]) continue;
        const beats = (frameOrigin + f * frameSeconds - firstBeat) / beat;
        const fraction = ((beats % 1) + 1) % 1;
        if (near(fraction, [1 / 3, 2 / 3, 1 / 6, 5 / 6])) triplet++;
        else if (near(fraction, [0.25, 0.75])) sixteenth++;
    }
    return triplet > 1.2 * sixteenth && triplet > 20;
};

export const generateChart = (analysis: AudioAnalysis, options: GeneratorOptions): GeneratedChart => {
    const profile = PROFILES[options.difficulty];
    const style = FINGERING[options.fingering ?? 'single'];
    const chordRate = Math.min(0.5, profile.chordRate * style.chordScale);
    const random = createRandom(`${options.seed}|${options.difficulty}`);
    const { envelope, bassEnvelope, loudness, pitch, tone, frameSeconds, frameOrigin } = analysis;
    // songs in triplet feel get a grid with triplets as well as straight eighths (sixths of a beat)
    const sub = profile.subdivision === 4 && swingsInTriplets(analysis, options.bpm, options.firstBeat) ? 6 : profile.subdivision;
    const beat = 60 / options.bpm;
    const slotSeconds = beat / sub;
    const firstBeat = ((options.firstBeat % beat) + beat) % beat;

    const frameAt = (time: number) => Math.round((time - frameOrigin) / frameSeconds);
    const slotTime = (slot: number) => firstBeat + slot * slotSeconds;
    const slotCount = Math.max(0, Math.floor((analysis.duration - 0.3 - firstBeat) / slotSeconds));
    const valueAt = (values: Float32Array, frame: number) => values[Math.max(0, Math.min(values.length - 1, frame))];

    // how loud the music is around each moment (about a bar either side), 0..1: official charts pack
    // their notes into the loud parts, so selection favours them
    const loudnessSum = new Float64Array(loudness.length + 1);
    for (let f = 0; f < loudness.length; f++) loudnessSum[f + 1] = loudnessSum[f] + loudness[f];
    const sectionRadius = Math.max(1, Math.round((beat * 4) / frameSeconds));
    const sectionLoudness = (frame: number) => {
        const from = Math.max(0, frame - sectionRadius);
        const to = Math.min(loudness.length, frame + sectionRadius);
        return to > from ? (loudnessSum[to] - loudnessSum[from]) / (to - from) : 0;
    };
    let loudestSection = 1e-9;
    for (let f = 0; f < loudness.length; f += sectionRadius) loudestSection = Math.max(loudestSection, sectionLoudness(f));

    // onset strength near each slot, weighted by metric position so strong beats win ties
    const tolerance = Math.max(1, Math.round(0.035 / frameSeconds));
    const strengths = new Float32Array(slotCount);
    const active = new Uint8Array(slotCount);
    let activeSlots = 0;
    for (let slot = 0; slot < slotCount; slot++) {
        const center = frameAt(slotTime(slot));
        // only a real onset counts: a local maximum of the envelope near the slot
        let peak = 0;
        let loud = 0;
        for (let f = center - tolerance; f <= center + tolerance; f++) {
            if (f < 1 || f + 1 >= envelope.length) continue;
            const value = Math.max(envelope[f], bassEnvelope[f]);
            const isPeak = value >= Math.max(envelope[f - 1], bassEnvelope[f - 1]) && value >= Math.max(envelope[f + 1], bassEnvelope[f + 1]);
            if (isPeak) peak = Math.max(peak, value);
            loud = Math.max(loud, loudness[f]);
        }
        if (loud < SILENCE) continue;
        active[slot] = 1;
        activeSlots++;
        const position = slot % sub;
        const metric = position === 0 ? 1 : position * 2 === sub ? 0.85 : (position * 3) % sub === 0 ? 0.8 : 0.7;
        const section = Math.min(1, sectionLoudness(center) / loudestSection);
        strengths[slot] = peak * metric * (0.35 + 1.3 * section);
    }

    // rhythm: where would an official charter put notes? the placement model (learned from 240 songs'
    // official charts) scores every candidate position; take the best while respecting the minimum gap
    const features = createFeatureExtractor(analysis, options.bpm, firstBeat);
    const learned = options.learnedPlacement !== false && FEATURE_NAMES.every((name, i) => PLACEMENT_FEATURES[i] === name);
    const scores = new Float32Array(slotCount);
    for (let slot = 0; slot < slotCount; slot++) {
        if (!active[slot]) continue;
        scores[slot] = learned ? placementScore(options.difficulty, features(slotTime(slot))) : strengths[slot];
    }
    // official note density grows with tempo (notes per second ∝ BPM^0.75 around a median of 175)
    let tempo = options.bpm;
    while (tempo < 115) tempo *= 2;
    while (tempo > 260) tempo /= 2;
    const tempoFactor = Math.min(1.4, Math.max(0.6, (tempo / 175) ** 0.75));
    const target = Math.round((profile.density * style.density[options.difficulty] * tempoFactor * activeSlots * slotSeconds) / (1 + chordRate));
    const gapSlots = Math.max(1, Math.round(profile.minGap * sub));
    const order = Array.from({ length: slotCount }, (_, i) => i).sort((a, b) => scores[b] - scores[a]);
    const taken = new Uint8Array(slotCount);
    const picked: number[] = [];
    for (const slot of order) {
        // a quiet song gets fewer notes (and a lower rating) rather than notes on nothing
        if (picked.length >= target || scores[slot] < (learned ? style.minPlacement[options.difficulty] : MIN_ONSET)) break;
        let free = true;
        for (let s = slot - gapSlots + 1; s < slot + gapSlots && free; s++) {
            if (s >= 0 && s < slotCount && taken[s]) free = false;
        }
        if (!free) continue;
        taken[slot] = 1;
        picked.push(slot);
    }
    picked.sort((a, b) => a - b);

    // pitch: median over the frames just after the attack, where the tone has settled
    const settledPitch = (slot: number) => {
        const start = frameAt(slotTime(slot));
        const values = [];
        for (let f = start + 1; f <= start + Math.max(2, Math.round(0.07 / frameSeconds)); f++) values.push(valueAt(pitch, f));
        values.sort((a, b) => a - b);
        return values[values.length >> 1];
    };
    const notes: PlannedNote[] = picked.map(slot => ({
        slot, strength: strengths[slot], pitch: settledPitch(slot), type: 1, holdSlots: 0, x: 0, chord: false,
    }));
    const total = notes.length;
    const gapAfter = (i: number) => (i < notes.length - 1 ? notes[i + 1].slot - notes[i].slot : Infinity);
    const gapBefore = (i: number) => (i > 0 ? notes[i].slot - notes[i - 1].slot : Infinity);

    // hold: the tone keeps sounding at the same pitch without being struck again. other notes may fall inside a hold (played
    // with the other hand), except on EZ where a hold has to end before the next note
    const maxHoldSlots = 4 * sub;
    const sustain = notes.map((note, i) => {
        const startTone = valueAt(tone, frameAt(slotTime(note.slot)) + 2);
        const limit = options.difficulty === 'EZ' ? Math.min(maxHoldSlots, gapAfter(i) - Math.ceil(sub / 2)) : maxHoldSlots;
        let length = 0;
        let misses = 0;
        let previousTone = startTone;
        for (let s = 1; s <= limit; s++) {
            const frame = frameAt(slotTime(note.slot + s)) + 2;
            if (frame >= tone.length || tone[frame] < startTone * 0.3) break;
            // a new attack on (nearly) the same pitch is a new note, not a continuation
            if (tone[frame] > previousTone * 1.3) break;
            previousTone = tone[frame];
            // a drum hit can briefly mask the tone; only two misses in a row end it
            if (Math.abs(pitch[frame] - note.pitch) > 2 * SEMITONE) {
                if (++misses >= 2) break;
                continue;
            }
            misses = 0;
            length = s;
        }
        return length;
    });
    const holdStep = Math.max(1, sub / 2);
    const minHoldSlots = Math.max(1, Math.round(profile.minHold * sub));
    // one hand holds while the other plays, so with one finger per hand holds never overlap each other
    const holdSpans: [number, number][] = [];
    const acceptHold = (i: number) => {
        if (sustain[i] < minHoldSlots) return false;
        const from = notes[i].slot;
        const to = from + sustain[i];
        if (holdSpans.filter(([start, end]) => from <= end && to >= start).length >= style.maxHolds) return false;
        holdSpans.push([from, to]);
        return true;
    };
    const makeHold = (i: number) => {
        notes[i].type = 3;
        notes[i].holdSlots = Math.max(minHoldSlots, sustain[i] - (sustain[i] % holdStep));
    };
    for (const i of takeTop(notes.map((_, i) => i), total, profile.holdRate * style.holdScale, i => sustain[i], acceptHold)) makeHold(i);
    // official charts string sustained notes together: weak hits under a hold are left out, and a held
    // tone right after a hold becomes one too
    const covered = new Uint8Array(notes.length);
    for (let i = 0; i < notes.length; i++) {
        if (notes[i].type !== 3) continue;
        const end = notes[i].slot + notes[i].holdSlots;
        for (let j = i + 1; j < notes.length && notes[j].slot < end; j++) {
            if (!style.keepUnderHolds && notes[j].type === 1 && notes[j].strength < 0.6 * notes[i].strength) covered[j] = 1;
        }
        const next = notes.findIndex((n, j) => j > i && !covered[j] && n.slot >= end);
        if (next > 0 && notes[next].type === 1 && acceptHold(next)) makeHold(next);
    }
    if (covered.some(Boolean)) {
        const kept = notes.filter((_, j) => !covered[j]);
        const keptSustain = sustain.filter((_, j) => !covered[j]);
        notes.length = 0;
        notes.push(...kept);
        sustain.length = 0;
        sustain.push(...keptSustain);
    }

    // note types follow the way official charts use them (measured on 96 official IN/AT charts, levels 9-18):
    // flicks (5-8% of notes) mark accents, mostly on the beat, and often close a phrase (14-35% of them
    // are followed by a rest); a flick is followed nearby by another flick or a drag far more often than by
    // a tap, which the flick's swipe would catch. drags (20-40%) come in sweeping runs of about five notes,
    // sometimes ending in a flick. about half of all chords mix types: drag with tap or drag, a hold
    // starting with a tap, a flick with a tap or another flick

    // flick (red): the hardest accents (sharpest jump in loudness), outside fast runs, preferring the beat
    // and the end of a phrase
    const quarterBeat = Math.max(1, sub / 4);
    const inRun = notes.map((_, i) => gapBefore(i) <= quarterBeat || gapAfter(i) <= quarterBeat);
    const restSlots = Math.round(PHRASE_REST / slotSeconds);
    const accent = (i: number) => {
        const note = notes[i];
        const onset = frameAt(slotTime(note.slot));
        const jump = valueAt(loudness, onset + 2) - valueAt(loudness, onset - 3);
        const phraseEnd = gapAfter(i) >= restSlots ? 1.5 : 0;
        const onBeat = note.slot % sub === 0 ? 0.25 : 0;
        return (note.strength + 2 * Math.max(0, jump)) * (1 + phraseEnd + onBeat);
    };
    for (const i of takeTop(notes.map((_, i) => i), total, profile.flickRate * 0.6, accent,
        i => notes[i].type === 1 && !inRun[i])) {
        notes[i].type = 4;
    }
    // flicks come in groups: a strong hit right after a flick often flicks too
    for (let i = 0; i + 1 < notes.length; i++) {
        const next = notes[i + 1];
        if (notes[i].type === 4 && next.type === 1 && next.slot - notes[i].slot <= sub
            && next.strength >= 0.5 * notes[i].strength && random() < 0.6) next.type = 4;
    }

    // drag (yellow): fast runs and light hits that move along the melody
    const maxStrength = Math.max(...notes.map(n => n.strength), 1e-6);
    const dragScore = (i: number) => {
        const melodic = i > 0 && Math.abs(notes[i].pitch - notes[i - 1].pitch) < 4 * SEMITONE ? 0.3 : 0;
        return (inRun[i] ? 1 : 0) + 0.8 * (1 - notes[i].strength / maxStrength) + melodic;
    };
    for (const i of takeTop(notes.map((_, i) => i), total, profile.dragRate, dragScore, i => notes[i].type === 1)) {
        notes[i].type = 2;
    }
    // drags run in strings of about five: a drag pulls in the light, quick notes after it
    const lightStrength = [...notes.map(n => n.strength)].sort((a, b) => a - b)[Math.floor(0.8 * (notes.length - 1))] ?? 0;
    for (let i = 0; i + 1 < notes.length; i++) {
        let length = 1;
        while (length < i + 1 && notes[i - length]?.type === 2) length++;
        const next = notes[i + 1];
        if (notes[i].type === 2 && next.type === 1 && next.slot - notes[i].slot <= Math.max(1, (3 * sub) / 4)
            && next.strength <= lightStrength && length < 8 && random() < 0.75) next.type = 2;
    }
    // a lone drag pulls in the light note after it, or goes back to a tap
    for (let i = 0; i < notes.length; i++) {
        if (notes[i].type !== 2 || notes[i - 1]?.type === 2 || notes[i + 1]?.type === 2) continue;
        const next = notes[i + 1];
        if (next && next.type === 1 && next.slot - notes[i].slot <= sub / 2) next.type = 2;
        else notes[i].type = 1;
    }
    // a run of drags sometimes ends in a flick: the finger slides along, then swipes off
    for (let i = 2; i + 1 < notes.length; i++) {
        const next = notes[i + 1];
        if (notes[i].type === 2 && notes[i - 1].type === 2 && notes[i - 2].type === 2 && next.type === 1
            && next.slot - notes[i].slot <= sub / 2 && random() < 0.35) next.type = 4;
    }

    // chords, shared between types as in official charts; the other note's type depends on this one's
    const chordShare: [OfficialNote['type'], number][] = [[1, 0.55], [2, 0.25], [3, 0.12], [4, 0.08]];
    for (const [type, share] of chordShare) {
        for (const i of takeTop(notes.map((_, i) => i), total, chordRate * share, i => notes[i].strength, i => notes[i].type === type)) {
            const note = notes[i];
            note.chord = true;
            const r = random();
            note.partnerType = type === 1 ? (r < 0.2 ? 2 : 1) : type === 2 ? (r < 0.55 ? 2 : 1) : type === 3 ? 1 : r < 0.6 ? 1 : 4;
        }
    }
    // with several fingers the strongest chords take a third note
    const tripleRate = style.triple[options.difficulty];
    if (tripleRate) {
        for (const i of takeTop(notes.map((_, i) => i), total, tripleRate, i => notes[i].strength, i => notes[i].chord && notes[i].type === 1)) notes[i].triple = true;
    }

    const motion = options.lineMotion === false ? undefined : buildLineMotion(analysis, {
        difficulty: options.difficulty,
        bpm: options.bpm,
        firstBeat,
        noteTimes: notes.map(n => slotTime(n.slot)),
        notePitches: notes.map(n => n.pitch),
        random,
    });

    /** Where on the line a note can sit at `time` and still be hit on screen, however the line moves. */
    const reachAt = (time: number): [number, number] => {
        if (!motion) return [-profile.spread, profile.spread];
        const pose = motion.poseAt(time);
        const radians = (pose.angle * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.abs(Math.sin(radians));
        const dx = (pose.x - 0.5) * 1350;
        const dy = Math.abs(pose.y - 0.5) * 900;
        let low = (-SAFE_WIDTH - dx) / (UNIT * cos);
        let high = (SAFE_WIDTH - dx) / (UNIT * cos);
        if (sin > 1e-6) {
            const vertical = (SAFE_HEIGHT - dy) / (UNIT * sin);
            low = Math.max(low, -vertical);
            high = Math.min(high, vertical);
        }
        return [Math.max(low, -profile.spread), Math.min(high, profile.spread)];
    };

    // fingering, the way official charts are written for two hands: the left hand plays the left half
    // of the screen, the right hand the right half, and they never cross. each hand has one finger (two
    // thumbs, on a phone) or several side by side (on a tablet, see FINGERING). a finger that has just
    // tapped needs profile.sameHand before it taps again, and one holding a hold is taken until it lets
    // go, so quicker notes go to another finger: with one finger per hand that is the other hand (hand
    // to hand), with several it can also be a neighbouring finger of the same hand, within its span.
    // otherwise a rising melody moves to the right hand and a falling one to the left. each hand
    // follows the melody from where it last played, only as far as it can travel in the time it has
    // pitch by rank, so the notes spread over the playfield however narrow the melody is
    const pitches = notes.map(n => n.pitch).sort((a, b) => a - b);
    const pitchRank = (value: number) => {
        let lo = 0;
        let hi = pitches.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (pitches[mid] < value) lo = mid + 1;
            else hi = mid;
        }
        return pitches.length > 1 ? lo / (pitches.length - 1) : 0.5;
    };
    const placed: { time: number; end: number; x: number; type: OfficialNote['type'] }[] = [];
    const chords: PlannedNote[] = [];
    const dropped = new Set<PlannedNote>();
    /** where a finger of a hand played: still down until `end` for a hold */
    interface Contact { x: number; time: number; end: number }
    interface Hand { x: number; time: number; end: number; type: OfficialNote['type']; pitch: number; contacts: Contact[] }
    const hands: Hand[] = [
        { x: -profile.spread / 2, time: -Infinity, end: -Infinity, type: 1, pitch: NaN, contacts: [] },
        { x: profile.spread / 2, time: -Infinity, end: -Infinity, type: 1, pitch: NaN, contacts: [] },
    ];
    let lastHand = -1;
    let lastTime = -Infinity;
    let lastPitch = NaN;
    let sameHandRun = 0;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

    const isHeld = (c: Contact, time: number) => c.end > time + 1e-6;
    /** drags of one hand in quick succession are one finger gliding along */
    const glides = (h: number, type: OfficialNote['type'], time: number) => type === 2 && hands[h].type === 2 && time - hands[h].time < GLIDE_SECONDS;
    /** fingers of hand `h` that are holding, or have tapped too recently to tap again, at `time` */
    const busyFingers = (h: number, type: OfficialNote['type'], time: number) => {
        const recovery = profile.sameHand * (type === 4 ? 1.3 : 1) - 1e-6;
        const gliding = glides(h, type, time);
        return hands[h].contacts.filter(c => isHeld(c, time)
            || (time - Math.max(c.time, c.end) < recovery && !(gliding && c.time === hands[h].time)));
    };
    /** whether a finger of hand `h` is free to play a note of this type at `time` */
    const canPlay = (h: number, type: OfficialNote['type'], time: number) => {
        // the fingers of one hand still need a moment between their taps
        if (style.fingers > 1 && time - hands[h].time < style.fingerGap - 1e-6 && !glides(h, type, time)) return false;
        return busyFingers(h, type, time).length < style.fingers;
    };
    /** seconds since hand `h` last played (or let go of a hold) */
    const idleFor = (h: number, time: number) => time - Math.max(hands[h].time, hands[h].end);
    /** fingers of hand `h` that are down, or were used within `memory` seconds */
    const recentContacts = (h: number, time: number, memory: number) => hands[h].contacts.filter(c => isHeld(c, time) || time - c.end < memory);
    /** where hand `h` may play at `time`: its half of the screen, clear of the other hand while that one is in play, within reach */
    const handRange = (h: number, time: number, minX: number, maxX: number): [number, number] => {
        let low = h === 0 ? minX : Math.max(minX, -CENTER_REACH);
        let high = h === 0 ? Math.min(maxX, CENTER_REACH) : maxX;
        for (const c of recentContacts(1 - h, time, HAND_MEMORY)) {
            if (h === 0) high = Math.min(high, c.x - NOTE_GAP - 0.01);
            else low = Math.max(low, c.x + NOTE_GAP + 0.01);
        }
        // the fingers of one hand stay within its span
        if (style.fingers > 1) {
            for (const c of recentContacts(h, time, SPAN_MEMORY)) {
                low = Math.max(low, c.x - style.span);
                high = Math.min(high, c.x + style.span);
            }
        }
        const idle = idleFor(h, time);
        if (Number.isFinite(idle)) {
            const reach = 1.5 + style.span + profile.handSpeed * clamp(idle, 0, 1);
            low = Math.max(low, hands[h].x - reach);
            high = Math.min(high, hands[h].x + reach);
        }
        return [low, high];
    };
    /** where the melody puts a note for hand `h`: by pitch inside the hand's half, moved by the step from its last note */
    const melodicX = (h: number, note: PlannedNote, time: number) => {
        const [from, to] = h === 0 ? [-profile.spread, -1] : [1, profile.spread];
        let x = from + (to - from) * Math.min(1, pitchRank(note.pitch));
        const hand = hands[h];
        const idle = idleFor(h, time);
        if (idle < 1.5 && Number.isFinite(hand.pitch)) x = 0.5 * x + 0.5 * (hand.x + clamp((note.pitch - hand.pitch) * 6, -3, 3));
        // the same tone again from the same hand is a clean repeat on the same spot
        if (idle >= REPEAT_SECONDS && idle < 0.4 && hand.type !== 3 && Math.abs(note.pitch - hand.pitch) < SEMITONE / 2) x = hand.x;
        // drag strings glide from drag to drag instead of jumping
        if (glides(h, note.type, time)) x = hand.x + clamp(x - hand.x, -1.8, 1.8);
        return x;
    };
    const clearOf = (p: (typeof placed)[number], candidate: number, time: number) => {
        const dx = Math.abs(p.x - candidate);
        // positions are rounded to 0.01 afterwards, which must not bring them under NOTE_GAP
        if (dx >= NOTE_GAP + 0.01) return true;
        // a clean repeat: same spot, far enough apart in time, and not on a hold still being held
        return dx < 0.05 && p.type !== 3 && p.end <= time && time - p.time >= REPEAT_SECONDS;
    };
    /** nearest free spot to `wanted` inside [low, high], or null */
    const findSpot = (wanted: number, low: number, high: number, ok: (x: number) => boolean) => {
        const start = clamp(wanted, low, high);
        if (low <= high && ok(start)) return start;
        for (let step = 1; step <= 80; step++) {
            for (const candidate of [start + step * 0.25, start - step * 0.25]) {
                if (candidate >= low && candidate <= high && ok(candidate)) return candidate;
            }
        }
        return null;
    };
    /** taps and holds keep clear of a flick just before them, which its swipe would otherwise catch */
    const clearOfFlicks = (type: OfficialNote['type'], candidate: number, time: number) => (type !== 1 && type !== 3)
        || placed.every(p => p.type !== 4 || time - p.time <= 1e-6 || time - p.time >= FLICK_CLEAR_SECONDS
            || Math.abs(p.x - candidate) >= FLICK_CLEAR_UNITS);
    const play = (h: number, x: number, time: number, end: number, type: OfficialNote['type'], pitch: number) => {
        const contacts = hands[h].contacts.filter(c => isHeld(c, time) || time - c.end < HAND_MEMORY);
        contacts.push({ x, time, end });
        hands[h] = { x, time, end: Math.max(end, hands[h].end), type, pitch, contacts };
    };

    for (const note of notes) {
        const time = slotTime(note.slot);
        const [minX, maxX] = reachAt(time);
        const neighbours = placed.filter(p => time - p.time < CLOSE_SECONDS + ROUNDING_MARGIN || p.end > time);

        let playable = [0, 1].filter(h => canPlay(h, note.type, time));
        // too quick for every finger: a light hit becomes a drag a free finger just slides onto
        if (!playable.length && note.type !== 3) {
            const free = [0, 1].filter(h => hands[h].contacts.filter(c => isHeld(c, time)).length < style.fingers && time - hands[h].time >= 0.06);
            if (free.length) {
                note.type = 2;
                playable = free;
            }
        }
        if (!playable.length) {
            dropped.add(note);
            continue;
        }

        const step = (note.pitch - lastPitch) * 12;
        const preferHand = () => {
            if (lastHand < 0) return pitchRank(note.pitch) >= 0.5 ? 1 : 0;
            // a drag right after a drag continues the same finger's slide
            if (glides(lastHand, note.type, time)) return lastHand;
            // streams go hand to hand; with several fingers a short stepwise run rolls across one hand
            if (time - lastTime < ALTERNATE_SECONDS) {
                const roll = style.fingers > 1 && sameHandRun < style.fingers && random() < style.roll[options.difficulty];
                return roll ? lastHand : 1 - lastHand;
            }
            const byPitch = step >= 1 ? 1 : step <= -1 ? 0 : lastHand;
            // keep both hands working
            return byPitch === lastHand && sameHandRun >= 4 ? 1 - lastHand : byPitch;
        };
        const preferred = preferHand();
        const search = (candidates: number[]): [number, number] | null => {
            const order = candidates.includes(preferred) ? [preferred, ...candidates.filter(h => h !== preferred)] : candidates;
            for (const h of order) {
                const [low, high] = handRange(h, time, minX, maxX);
                // the drag right before a gliding drag of the same hand is meant to be close
                const gliding = glides(h, note.type, time);
                const blocking = neighbours.filter(p => !(gliding && p.time === hands[h].time && p.type === 2));
                // a spot one of the hand's fingers is still on (or has only just left) is that finger's, not another's
                const taken = style.fingers > 1 ? busyFingers(h, note.type, time) : [];
                const ok = (candidate: number) => blocking.every(p => clearOf(p, candidate, time))
                    && taken.every(c => Math.abs(c.x - candidate) >= NOTE_GAP + 0.01)
                    && clearOfFlicks(note.type, candidate, time);
                let spot = findSpot(melodicX(h, note, time), low, high, ok);
                if (spot === null) continue;
                if (profile.grid) {
                    const snapped = Math.round(spot / profile.grid) * profile.grid;
                    if (snapped >= low && snapped <= high && ok(snapped)) spot = snapped;
                }
                // a repeat lands exactly on the earlier note, not a hair beside it
                const repeated = blocking.find(p => Math.abs(p.x - spot!) < 0.05);
                if (repeated) spot = repeated.x;
                return [h, spot];
            }
            return null;
        };
        let found = search(playable);
        // no clear spot for a tap behind a flick: it becomes a drag, which follows flicks in official charts
        if (!found && note.type === 1) {
            note.type = 2;
            found = search([0, 1].filter(h => canPlay(h, 2, time)));
        }
        const [hand, x] = found ?? [-1, 0];
        // no room for any finger: one note fewer is better than two on top of each other
        if (hand < 0) {
            dropped.add(note);
            continue;
        }
        note.x = Math.round(x * 100) / 100;
        const end = note.type === 3 ? slotTime(note.slot + note.holdSlots) : time;

        if (note.chord) {
            // the partner goes to the other hand, on its own side, about 4-8 units away (official chords sit
            // about 6 apart); with several fingers a hand can also take both notes, within its span
            let partner: number | null = null;
            let partnerHand = -1;
            const partnerType = note.partnerType ?? note.type;
            const clearSpot = (h: number) => {
                // as for any note, a spot a finger of that hand has only just left is that finger's
                const taken = busyFingers(h, partnerType, time);
                return (candidate: number) => neighbours.every(p => Math.abs(p.x - candidate) >= NOTE_GAP + 0.01)
                    && taken.every(c => Math.abs(c.x - candidate) >= NOTE_GAP + 0.01)
                    && Math.abs(candidate - note.x) >= NOTE_GAP + 0.01
                    && clearOfFlicks(partnerType, candidate, time);
            };
            const other = 1 - hand;
            if (canPlay(other, partnerType, time)) {
                const [minOther, maxOther] = handRange(other, time, minX, maxX);
                const [low, high] = other === 1 ? [Math.max(minOther, note.x + 3.5), maxOther] : [minOther, Math.min(maxOther, note.x - 3.5)];
                partner = findSpot(note.x + (other === 1 ? 1 : -1) * (4 + random() * 4), low, high, clearSpot(other));
                partnerHand = other;
            }
            if (partner === null && style.fingers > 1 && busyFingers(hand, partnerType, time).length + 1 < style.fingers) {
                const [low, high] = handRange(hand, time, minX, maxX);
                const outward = hand === 1 ? 1 : -1;
                const clear = clearSpot(hand);
                const span = (candidate: number) => clear(candidate) && Math.abs(candidate - note.x) <= style.span;
                partner = findSpot(note.x + outward * 3, Math.max(low, note.x - style.span), Math.min(high, note.x + style.span), span);
                partnerHand = hand;
            }
            if (partner === null) {
                note.chord = false;
            } else {
                const px = Math.round(partner * 100) / 100;
                chords.push({ ...note, type: partnerType, holdSlots: 0, x: px });
                placed.push({ time, end: time, x: px, type: partnerType });
                play(partnerHand, px, time, time, partnerType, note.pitch);
            }
        }

        placed.push({ time, end, x: note.x, type: note.type });
        play(hand, note.x, time, end, note.type, note.pitch);

        if (note.chord && note.triple) {
            // a third finger, on whichever hand has one free, next to that hand's note and inside its span
            const together = placed.filter(p => Math.abs(p.time - time) < 1e-6);
            for (const h of [0, 1].sort((a, b) => busyFingers(a, 1, time).length - busyFingers(b, 1, time).length)) {
                if (busyFingers(h, 1, time).length >= style.fingers) continue;
                const [low, high] = handRange(h, time, minX, maxX);
                const taken = busyFingers(h, 1, time);
                const own = taken.filter(c => Math.abs(c.time - time) < 1e-6);
                const anchor = own.length ? own[own.length - 1].x : hands[h].x;
                const clear = (candidate: number) => [...neighbours, ...together].every(p => Math.abs(p.x - candidate) >= NOTE_GAP + 0.01)
                    && taken.every(c => Math.abs(c.x - candidate) >= NOTE_GAP + 0.01)
                    && clearOfFlicks(note.type, candidate, time);
                const third = findSpot(anchor + (h === 1 ? 1 : -1) * 2.5, low, high, clear);
                if (third === null) continue;
                const tx = Math.round(third * 100) / 100;
                chords.push({ ...note, x: tx });
                placed.push({ time, end: time, x: tx, type: note.type });
                play(h, tx, time, time, note.type, note.pitch);
                break;
            }
        }
        sameHandRun = hand === lastHand ? sameHandRun + 1 : 1;
        lastHand = hand;
        lastTime = time;
        lastPitch = note.pitch;
    }

    // to official format. time unit is 1/32 beat; floorPosition is distance travelled at the line speed
    const toTime = (seconds: number) => Math.round((seconds * options.bpm) / 1.875);
    const toSeconds = (time: number) => (time * 1.875) / options.bpm;

    // scroll speed: steps on official time units, and the distance travelled (floor position) summed
    // over them exactly as players do, so notes reach the line on time whatever the speed
    const speedChanges = options.speedChanges === false
        ? [{ time: 0, value: profile.speed }]
        : buildScrollSpeed(motion?.bars ?? readBarMoods(analysis, options.bpm, firstBeat), { difficulty: options.difficulty, bpm: options.bpm, base: profile.speed });
    const speedSteps: { time: number; value: number; floor: number }[] = [];
    for (const change of speedChanges) {
        const time = Math.max(0, toTime(change.time));
        const last = speedSteps[speedSteps.length - 1];
        if (last && time <= last.time) last.value = change.value;
        else speedSteps.push({ time, value: change.value, floor: 0 });
    }
    for (let i = 1; i < speedSteps.length; i++) {
        const prev = speedSteps[i - 1];
        speedSteps[i].floor = prev.floor + toSeconds(speedSteps[i].time - prev.time) * prev.value;
    }
    const stepAt = (time: number) => {
        let i = speedSteps.length - 1;
        while (i > 0 && speedSteps[i].time > time) i--;
        return speedSteps[i];
    };
    const speedAt = (time: number) => stepAt(time).value;
    const floorAt = (time: number) => {
        const step = stepAt(time);
        return step.floor + toSeconds(time - step.time) * step.value;
    };
    // final guarantee for the player: within CLOSE_SECONDS two notes are a clean repeat or NOTE_GAP
    // apart (drag streams aside). a note off by a hair snaps onto the earlier one, anything else goes
    const final = [...notes.filter(n => !dropped.has(n)), ...chords].sort((a, b) => a.slot - b.slot);
    const kept: PlannedNote[] = [];
    for (const note of final) {
        const time = slotTime(note.slot);
        const endOf = (n: PlannedNote) => slotTime(n.slot + (n.type === 3 ? n.holdSlots : 0));
        // notes still close in time (or holds still held)
        const near: PlannedNote[] = [];
        for (let k = kept.length - 1; k >= 0; k--) {
            const gap = time - slotTime(kept[k].slot);
            if (gap >= CLOSE_SECONDS + 4) break;
            if (gap < CLOSE_SECONDS + ROUNDING_MARGIN || endOf(kept[k]) > time) near.push(kept[k]);
        }
        const canRepeat = (other: PlannedNote) => other.type !== 3 && endOf(other) <= time
            && time - slotTime(other.slot) >= REPEAT_SECONDS - 0.001;
        const clear = (other: PlannedNote) => {
            const dx = Math.abs(note.x - other.x);
            return dx >= NOTE_GAP || (note.type === 2 && other.type === 2) || (dx === 0 && canRepeat(other));
        };
        // off by a hair from the most recent note: make it an exact repeat
        const hair = near.find(other => !clear(other) && Math.abs(note.x - other.x) < 0.25 && canRepeat(other));
        if (hair) note.x = hair.x;
        if (near.every(clear)) kept.push(note);
    }
    const officialNotes: OfficialNote[] = kept
        .map(note => {
            const time = toTime(slotTime(note.slot));
            const holdTime = note.type === 3 ? toTime(slotTime(note.slot + note.holdSlots)) - time : 0;
            return {
                type: note.type,
                time,
                holdTime,
                positionX: note.x,
                // hold speed is absolute, other notes are relative to the line
                speed: note.type === 3 ? speedAt(time) : 1,
                floorPosition: floorAt(time),
            };
        })
        .sort((a, b) => a.time - b.time);

    const constant = (value: number) => ({ startTime: EVENT_START, endTime: EVENT_END, start: value, end: value });

    let moveEvents: OfficialChart['judgeLineList'][number]['judgeLineMoveEvents'] = [{ ...constant(0.5), start2: BASE_Y, end2: BASE_Y }];
    let rotateEvents = [constant(0)];
    let alphaEvents = [constant(1)];
    if (motion) {
        const lastTime = officialNotes.length ? officialNotes[officialNotes.length - 1].time + officialNotes[officialNotes.length - 1].holdTime : 0;
        const end = Math.ceil((lastTime + 32 * 4) / MOTION_STEP) * MOTION_STEP;
        const poses: { time: number; pose: LinePose }[] = [];
        for (let time = 0; time <= end; time += MOTION_STEP) poses.push({ time, pose: motion.poseAt(toSeconds(time)) });
        const round = (v: number) => Math.round(v * 1e5) / 1e5;
        const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);
        // contiguous linear segments between samples, constant runs merged, held at both ends
        const segments = (sample: (p: LinePose) => number[]) => {
            const values = poses.map(p => sample(p.pose).map(round));
            const result = [{ startTime: EVENT_START, endTime: 0, start: values[0], end: values[0] }];
            for (let i = 1; i < poses.length; i++) {
                const last = result[result.length - 1];
                if (same(values[i - 1], values[i]) && same(last.start, last.end) && same(last.end, values[i])) {
                    last.endTime = poses[i].time;
                } else {
                    result.push({ startTime: poses[i - 1].time, endTime: poses[i].time, start: values[i - 1], end: values[i] });
                }
            }
            const tail = values[values.length - 1];
            result.push({ startTime: poses[poses.length - 1].time, endTime: EVENT_END, start: tail, end: tail });
            return result;
        };
        moveEvents = segments(p => [p.x, p.y]).map(e => ({
            startTime: e.startTime, endTime: e.endTime, start: e.start[0], end: e.end[0], start2: e.start[1], end2: e.end[1],
        }));
        rotateEvents = segments(p => [p.angle]).map(e => ({ startTime: e.startTime, endTime: e.endTime, start: e.start[0], end: e.end[0] }));
        alphaEvents = segments(p => [p.alpha]).map(e => ({ startTime: e.startTime, endTime: e.endTime, start: e.start[0], end: e.end[0] }));
    }

    const chart: OfficialChart = {
        formatVersion: 3,
        offset: 0,
        judgeLineList: [{
            bpm: options.bpm,
            judgeLineMoveEvents: moveEvents,
            judgeLineRotateEvents: rotateEvents,
            judgeLineDisappearEvents: alphaEvents,
            speedEvents: speedSteps.map((step, i) => ({
                startTime: step.time,
                endTime: speedSteps[i + 1]?.time ?? EVENT_END,
                value: step.value,
                floorPosition: step.floor,
            })),
            notesAbove: officialNotes,
            notesBelow: [],
        }],
    };

    const count = (type: OfficialNote['type']) => officialNotes.filter(n => n.type === type).length;
    return {
        chart,
        motion,
        level: Math.round(Math.min(16.9, rateNotes(officialNotes.map(n => ({ time: toSeconds(n.time), type: n.type }))) + LEVEL_CALIBRATION[options.difficulty]) * 10) / 10,
        speed: {
            min: Math.min(...speedSteps.map(step => step.value)),
            max: Math.max(...speedSteps.map(step => step.value)),
            changes: speedSteps.map(step => ({ time: toSeconds(step.time), value: step.value })),
        },
        stats: { total: officialNotes.length, tap: count(1), drag: count(2), hold: count(3), flick: count(4) },
    };
};
