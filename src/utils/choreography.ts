// judgment-line choreography: short performances made only of judgment lines, the way official charts
// and the fan charts players share are staged. extra lines fly in, split off the main line, fan out, cross,
// orbit or shatter, timed to the song's own accents, and leave again. which performances a song gets, where
// and how they move come from the song itself (its sections, its character, its accents) and from a seed of
// the song, so every song is staged differently and the same song always the same way.
//
// a motif is only the skeleton of a performance. each song also draws its own style (which motifs it likes,
// how its lines ease, enter and leave, whether they cascade, spin or snap to the beat), and every performance
// draws a variant around that style, so the same motif never looks quite the same twice and two songs read
// as two different hands. a new staging seed gives the same song a new staging while its notes stay put
//
// most notes stay on the main line, as in official charts (it carries about three quarters). of the rest, two
// thirds come in relays (another line takes over a phrase while the main line rests) and a third while the
// main line plays too; mostly on near-level lines (69%), some tilted (16%) or upright (15%), often moving.
// here relay lines (level, tilted or upright) and split lines carry notes; the generator places those notes
// with its two-dimensional hand model, so they stay comfortable to play wherever the line is

import type { GeneratorDifficulty } from './chartGenerator';
import type { BarMood, BarState, LinePose } from './lineMotion';

export type Motif = 'relay' | 'split' | 'stack' | 'fan' | 'cross' | 'orbit' | 'sweep' | 'flyIn' | 'mirror' | 'pendulum' | 'converge' | 'shatter' | 'pulse'
    | 'spiral' | 'lattice' | 'ripple' | 'scissor';

/** how a performance's lines move between their poses */
export type Ease = 'smooth' | 'out' | 'in' | 'sine' | 'linger';
/** how a performing line comes in and goes out */
export type Entry = 'fade' | 'slide' | 'drop' | 'rise' | 'unfold' | 'turn';

export interface Variant {
    ease: Ease;
    entry: Entry;
    /** 0..0.15: how far behind the line before it each line runs (a cascade) */
    stagger: number;
    /** degrees each line turns about itself over the performance */
    spin: number;
    /** moves in steps on the beats rather than continuously */
    snap: boolean;
    /** 0..1: how much the lines flash on each beat */
    breathe: number;
    /** offset of the centre the screen-centred motifs turn about */
    pivotX: number;
    pivotY: number;
}

/** one song's taste, which every performance's variant leans towards */
export interface StagingStyle {
    eases: Ease[];
    entries: Entry[];
    stagger: number;
    spin: number;
    snap: number;
    breathe: number;
    /** how much the song likes each motif */
    taste: Record<Motif, number>;
}

export interface Performance {
    motif: Motif;
    /** seconds */
    start: number;
    end: number;
    /** extra lines it uses */
    lines: number;
    /** 1 or -1: which way it turns or moves */
    direction: number;
    /** 0..1: how big it is */
    size: number;
    /** a relay on an upright line at the side of the screen (notes then come in sideways) */
    upright?: boolean;
    variant: Variant;
}

export interface Choreography {
    performances: Performance[];
    style: StagingStyle;
    /** extra lines besides the main one */
    lineCount: number;
    /** pose of extra line `index` (0-based) at `time`, given the main line's pose then */
    poseAt: (index: number, time: number, main: LinePose) => LinePose;
    /** extra line (0-based) a note at `time` (held until `end`) played by the hand on `side` (-1 left, 1 right) rides, or -1 for the main line */
    noteLine: (time: number, end: number, side: number) => number;
    /** how visible the main line is at `time` (it dims while a relay line plays) */
    mainAlphaAt: (time: number) => number;
}


// how much of the playing time has performances. 36 official IN/AT charts show two or more lines 62% of the
// time (four or more 22%), with the main line carrying a median 74% of the notes; easier charts stage less
const COVERAGE: Record<GeneratorDifficulty, number> = { EZ: 0.25, HD: 0.4, IN: 0.55, AT: 0.62 };
const MAX_LINES = 4;
const CARRIES_NOTES: Motif[] = ['relay', 'split', 'stack'];
// a line that is only performing stays faint (the playing lines are drawn at full strength), so it is never
// mistaken for one to hit; official charts keep note-less lines at a mean opacity of 0.61, 35% of the time
// under 0.5
const DECOR_ALPHA = 0.45;
/** part of a relay (0..1) during which its line has arrived and carries the notes */
const RELAY_FROM = 0.18;
const RELAY_TO = 0.86;

/** motifs that suit each kind of section */
const BY_STATE: Record<BarState | 'intro' | 'outro', Motif[]> = {
    intro: ['flyIn', 'converge', 'fan', 'orbit', 'stack', 'spiral', 'lattice'],
    silent: ['pulse', 'orbit', 'ripple'],
    calm: ['relay', 'pulse', 'mirror', 'pendulum', 'orbit', 'stack', 'ripple'],
    groove: ['relay', 'split', 'mirror', 'cross', 'pendulum', 'sweep', 'fan', 'stack', 'scissor', 'lattice'],
    build: ['relay', 'converge', 'stack', 'orbit', 'pulse', 'spiral', 'ripple'],
    drop: ['shatter', 'fan', 'cross', 'split', 'ripple', 'lattice'],
    climax: ['relay', 'split', 'cross', 'orbit', 'sweep', 'fan', 'shatter', 'stack', 'spiral', 'scissor', 'lattice'],
    outro: ['converge', 'fan', 'orbit', 'pulse', 'spiral', 'ripple'],
};

/** which of the song's characters (from the line motion) each motif suits */
const CHARACTER: Record<Motif, { bounce: number; pendulum: number; wave: number }> = {
    relay: { bounce: 0.8, pendulum: 0.8, wave: 0.8 },
    split: { bounce: 1, pendulum: 0.3, wave: 0.4 },
    stack: { bounce: 1, pendulum: 0.2, wave: 0.3 },
    shatter: { bounce: 1, pendulum: 0.4, wave: 0.2 },
    pulse: { bounce: 0.9, pendulum: 0.3, wave: 0.4 },
    fan: { bounce: 0.4, pendulum: 1, wave: 0.5 },
    cross: { bounce: 0.5, pendulum: 1, wave: 0.4 },
    pendulum: { bounce: 0.2, pendulum: 1, wave: 0.6 },
    converge: { bounce: 0.5, pendulum: 0.8, wave: 0.6 },
    orbit: { bounce: 0.3, pendulum: 0.5, wave: 1 },
    sweep: { bounce: 0.4, pendulum: 0.4, wave: 1 },
    mirror: { bounce: 0.3, pendulum: 0.5, wave: 1 },
    flyIn: { bounce: 0.7, pendulum: 0.6, wave: 0.6 },
    spiral: { bounce: 0.4, pendulum: 0.6, wave: 1 },
    lattice: { bounce: 1, pendulum: 0.4, wave: 0.5 },
    ripple: { bounce: 0.6, pendulum: 0.3, wave: 1 },
    scissor: { bounce: 0.8, pendulum: 1, wave: 0.3 },
};

const LINES: Record<Motif, [number, number]> = {
    relay: [1, 1], split: [1, 2], stack: [2, 3], fan: [2, 4], cross: [2, 2], orbit: [2, 4], sweep: [1, 2],
    flyIn: [2, 4], mirror: [1, 1], pendulum: [1, 2], converge: [2, 4], shatter: [3, 4], pulse: [2, 3],
    spiral: [3, 4], lattice: [3, 4], ripple: [2, 4], scissor: [2, 2],
};

const EASES: Record<Ease, (t: number) => number> = {
    smooth: t => smooth(t),
    out: t => easeOut(t),
    in: t => clamp(t, 0, 1) ** 2.2,
    sine: t => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1)),
    // quick, a long hold in the middle, quick again
    linger: t => {
        const u = clamp(t, 0, 1) * 2 - 1;
        return 0.5 + 0.5 * Math.sign(u) * Math.abs(u) ** 0.45;
    },
};
const ALL_EASES = Object.keys(EASES) as Ease[];
const ALL_ENTRIES: Entry[] = ['fade', 'slide', 'drop', 'rise', 'unfold', 'turn'];
/** how a relay line may arrive: from the side, from above or below, or turning in where it rests */
const RELAY_ENTRIES: Entry[] = ['slide', 'drop', 'rise', 'turn'];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (v: number) => {
    const t = clamp(v, 0, 1);
    return t * t * (3 - 2 * t);
};
const easeOut = (v: number) => 1 - (1 - clamp(v, 0, 1)) ** 3;
/** in over the first and out over the last `edge` of a performance */
const envelope = (p: number, edge = 0.2) => Math.min(smooth(p / edge), smooth((1 - p) / edge));

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

/** Pose of line `k` of `n` in a performance, `p` of the way through (0..1), `beats` beats in. */
const motifPose = (perf: Performance, k: number, p: number, beats: number, main: LinePose): LinePose => {
    const { direction: d, size } = perf;
    const n = perf.lines;
    const v = perf.variant;
    const env = envelope(p);
    const spread = (k + 1) / n;
    // the screen-centred motifs turn about a centre of their own
    const cx = 0.5 + v.pivotX;
    const cy = 0.55 + v.pivotY;
    switch (perf.motif) {
        case 'relay': {
            // a line comes in (from the side, from above or below, or turning in where it rests), settles higher
            // up and a little tilted (or upright at one side), drifts while it plays the phrase, and leaves the
            // way it came on through. it is at rest before its first note whichever way it comes
            const restX = perf.upright ? 0.5 + d * 0.22 : 0.5 + d * (0.06 + v.pivotX * 0.5);
            const restY = perf.upright ? 0.5 : 0.5 + 0.18 * size;
            const tilt = perf.upright ? d * (72 + 18 * size) : d * (6 + 14 * size);
            const enter = EASES[v.ease === 'smooth' || v.ease === 'sine' ? v.ease : 'out'](p / RELAY_FROM);
            const leave = smooth((p - RELAY_TO) / (1 - RELAY_TO));
            const away = 1 - enter;
            const drift = Math.sin(Math.PI * Math.min(1, Math.max(0, (p - RELAY_FROM) / (RELAY_TO - RELAY_FROM))));
            let x = restX;
            let y = restY + 0.03 * drift;
            let angle = tilt - d * 5 * drift;
            if (v.entry === 'drop') y += 0.6 * away - 0.6 * leave;
            else if (v.entry === 'rise') y += -0.6 * away + 0.6 * leave;
            else if (v.entry === 'turn') angle += d * 90 * away - d * 90 * leave;
            else x += -d * 0.9 * away + d * 0.9 * leave;
            return { x, y, angle, alpha: Math.min(enter, 1 - leave) };
        }
        case 'split': {
            // copies peel off the main line, tilting a little apart, ride along with it, and fold back in
            const out = smooth(Math.min(p / 0.25, (1 - p) / 0.25));
            const gap = (0.1 + 0.08 * size) * (k + 1) * d;
            const tilt = (k % 2 ? -1 : 1) * d * (3 + 9 * size) * out;
            return { x: main.x, y: main.y + gap * out, angle: main.angle + tilt, alpha: env };
        }
        case 'stack': {
            // one parallel line more on each beat, then all of them leave together
            const shown = beats >= k * 1 ? 1 : 0;
            return { x: main.x, y: main.y + (0.13 + 0.03 * size) * (k + 1), angle: main.angle, alpha: shown * smooth((1 - p) / 0.2) * 0.85 };
        }
        case 'fan': {
            // lines open out from the main line's centre like a fan, then close
            const angle = main.angle + d * (k % 2 ? -1 : 1) * (20 + 50 * size) * Math.ceil((k + 1) / 2) / Math.ceil(n / 2) * smooth(Math.min(p / 0.35, (1 - p) / 0.35));
            return { x: main.x, y: main.y, angle, alpha: env * 0.9 };
        }
        case 'cross': {
            // two lines cross in an X over the centre and turn together
            const angle = (k ? -1 : 1) * (35 + 15 * size) + d * 90 * easeOut(p) * (0.5 + size);
            return { x: cx, y: cy, angle, alpha: env * 0.8 };
        }
        case 'orbit': {
            // spokes around the centre of the screen, turning
            const angle = (180 / n) * k + d * (90 + 180 * size) * p;
            return { x: cx, y: cy, angle, alpha: env * 0.55 };
        }
        case 'sweep': {
            // a slanted line crosses the screen
            const travel = easeOut(p);
            const x = d > 0 ? -0.15 + 1.3 * travel : 1.15 - 1.3 * travel;
            return { x, y: 0.45 + 0.12 * k, angle: d * (55 + 30 * size) - d * 40 * travel, alpha: env };
        }
        case 'flyIn': {
            // upright lines come in from both sides and frame the screen, then fade
            const side = k % 2 ? 1 : -1;
            const rest = 0.5 + side * (0.18 + 0.12 * Math.floor(k / 2));
            const x = rest + side * 0.7 * (1 - easeOut(p / 0.4));
            return { x, y: 0.5, angle: 90, alpha: smooth((1 - p) / 0.3) * 0.8 };
        }
        case 'mirror': {
            // a line high on the screen tilts against the main line
            return { x: main.x, y: 0.85 - 0.05 * size, angle: -main.angle - d * 4 * Math.sin(Math.PI * beats / 2), alpha: env * 0.8 };
        }
        case 'pendulum': {
            // swings from a point above the screen, a swing a bar
            const swing = Math.sin(Math.PI * beats / 2 + k * 0.6) * (20 + 25 * size) * d;
            return { x: cx + 0.25 * Math.sin((swing * Math.PI) / 180), y: cy + 0.2 - 0.08 * k, angle: swing, alpha: env * 0.8 };
        }
        case 'converge': {
            // lines far above and below close in on the main line and disappear into it
            const from = (k % 2 ? -1 : 1) * (0.35 + 0.2 * Math.floor(k / 2) + 0.1 * size);
            const close = smooth(p);
            return { x: main.x, y: main.y + from * (1 - close), angle: main.angle + d * 15 * (1 - close) * (k % 2 ? -1 : 1), alpha: Math.min(smooth(p / 0.2), 1 - smooth((p - 0.85) / 0.15)) * 0.9 };
        }
        case 'shatter': {
            // the main line bursts into pieces that fly apart and fade
            const theta = ((k + 0.5) / n) * Math.PI * 2 * d + size;
            const out = easeOut(p) * (0.25 + 0.2 * size);
            return { x: main.x + Math.cos(theta) * out, y: main.y + Math.sin(theta) * out, angle: main.angle + d * (60 + 120 * spread) * easeOut(p), alpha: 1 - smooth(p) };
        }
        case 'spiral': {
            // lines wind out from the centre along a spiral, each turned across its own radius
            const theta = (2 * Math.PI * k) / n + d * Math.PI * (1 + size) * p;
            const r = 0.04 + (0.22 + 0.12 * size) * p;
            return { x: cx + Math.cos(theta) * r, y: cy + Math.sin(theta) * r * 0.8, angle: (theta * 180) / Math.PI + 90, alpha: env * 0.6 };
        }
        case 'lattice': {
            // level and upright lines lay a grid over the screen that slides a step each bar
            const upright = k % 2 === 1;
            const slot = Math.floor(k / 2) - 0.5 * (Math.ceil(n / 2) - 1);
            const slide = d * (0.04 + 0.06 * size) * Math.floor(beats / 4);
            return upright
                ? { x: cx + slot * 0.28 + slide, y: 0.5, angle: 90, alpha: env * 0.5 }
                : { x: 0.5, y: cy + slot * 0.24 - slide * 0.6, angle: 0, alpha: env * 0.5 };
        }
        case 'ripple': {
            // parallel lines run out from the main line, above and below, like a wave, fading as they go
            const ring = Math.floor(k / 2) + 1;
            const out = (0.06 + 0.06 * size) * ring * (0.3 + p * 1.4);
            return { x: main.x, y: main.y + (k % 2 ? -1 : 1) * d * out, angle: main.angle, alpha: env * (1 - 0.6 * p) * 0.7 };
        }
        case 'scissor': {
            // two lines side by side open and close against each other on the beat
            const open = (10 + 30 * size) * Math.abs(Math.sin((Math.PI * beats) / 2));
            return { x: cx + (k ? 1 : -1) * 0.12, y: cy, angle: (k ? -1 : 1) * d * open, alpha: env * 0.75 };
        }
        case 'pulse':
        default: {
            // horizontal lines at different heights flash on the beat, one after another
            const phase = (beats - k / n + 4) % 1;
            return { x: cx, y: cy - 0.05 + 0.12 * (k + 1), angle: 0, alpha: env * Math.max(0, 1 - phase * 2.5) * 0.8 };
        }
    }
};

/**
 * Pose of a performing line with its variant applied: a cascade, an easing of its motion, steps on the beat,
 * a way in and out, a turn about itself and a flash on the beat. lines that carry notes keep their motif's own
 * pose (a relay picks its way in itself), so they are steady while they are played.
 */
const variedPose = (perf: Performance, k: number, p: number, beats: number, beat: number, main: LinePose): LinePose => {
    const v = perf.variant;
    if (CARRIES_NOTES.includes(perf.motif)) return motifPose(perf, k, p, beats, main);
    const duration = perf.end - perf.start;
    let b = beats;
    if (v.snap) b = Math.floor(beats) + smooth((beats % 1) / 0.35);
    const lag = v.stagger * k;
    const pk = clamp((Math.min(1, (b * beat) / duration) - lag) / Math.max(0.5, 1 - v.stagger * (perf.lines - 1)), 0, 1);
    const pose = motifPose(perf, k, EASES[v.ease](pk), b - lag * duration / beat, main);
    const d = perf.direction;
    // 0 while the line is in place, 1 when it is all the way out
    const away = 1 - Math.min(smooth(pk / 0.22), smooth((1 - pk) / 0.22));
    let { x, y, angle } = pose;
    switch (v.entry) {
        case 'slide': x += d * (k % 2 ? -1 : 1) * 0.7 * away; break;
        case 'drop': y += 0.6 * away; break;
        case 'rise': y -= 0.6 * away; break;
        case 'unfold':
            x += (main.x - x) * away;
            y += (main.y - y) * away;
            angle += (main.angle - angle) * away;
            break;
        case 'turn': angle += d * 90 * away; break;
        default: break;
    }
    angle += d * v.spin * (pk - 0.5);
    const flash = 1 - v.breathe + v.breathe * Math.max(0, 1 - (beats % 1) * 3);
    // a line sliding, dropping or turning in shows as it moves, rather than fading in where it ends
    const shown = v.entry === 'fade' || v.entry === 'unfold' ? pose.alpha : pose.alpha / Math.max(0.35, 1 - away);
    return { x, y, angle, alpha: Math.min(shown, 1) * flash };
};

export const buildChoreography = (options: {
    difficulty: GeneratorDifficulty;
    bpm: number;
    firstBeat: number;
    bars: BarMood[];
    character: { bounce: number; pendulum: number; wave: number };
    /** sorted note times (seconds) */
    noteTimes: number[];
    /** accent strength at a time (onset strength around it) */
    accentAt: (time: number) => number;
    seed: string;
    /** 0 for the song's first staging; any other number stages it anew */
    stagingSeed?: number;
}): Choreography => {
    const { bars, character, noteTimes, accentAt } = options;
    const random = createRandom(`${options.seed}|choreography${options.stagingSeed ? `|${options.stagingSeed}` : ''}`);
    const choose = <T,>(items: T[]) => items[Math.floor(random() * items.length)];

    // the song's style: two eases and three ways in it favours, how much it cascades, spins, snaps and
    // flashes, and a liking for each motif, so its motifs come in proportions of its own
    const shuffled = <T,>(items: T[]) => items.map(item => ({ item, r: random() })).sort((a, b) => a.r - b.r).map(e => e.item);
    const style: StagingStyle = {
        eases: shuffled(ALL_EASES).slice(0, 2),
        entries: shuffled(ALL_ENTRIES).slice(0, 3),
        stagger: random() < 0.5 ? 0 : 0.04 + 0.1 * random(),
        spin: random() < 0.4 ? 0 : 20 + 70 * random(),
        snap: random() < 0.5 ? 0.1 : 0.7,
        breathe: random() < 0.5 ? 0 : 0.3 + 0.4 * random(),
        taste: Object.fromEntries((Object.keys(CHARACTER) as Motif[]).map(m => [m, 0.3 + 1.4 * random()])) as Record<Motif, number>,
    };
    // a performance keeps to the song's style most of the time and strays from it now and then
    // (a split or a stack carries notes on lines tied to the main one, so it keeps its own way in and its pace)
    const makeVariant = (motif: Motif): Variant => ({
        ease: random() < 0.8 ? choose(style.eases) : choose(ALL_EASES),
        entry: motif === 'relay'
            ? choose(style.entries.filter(e => RELAY_ENTRIES.includes(e)).concat('slide'))
            : CARRIES_NOTES.includes(motif) ? 'fade'
            : random() < 0.8 ? choose(style.entries) : choose(ALL_ENTRIES),
        stagger: style.stagger * (0.6 + 0.8 * random()),
        spin: style.spin * (0.5 + random()),
        snap: !CARRIES_NOTES.includes(motif) && random() < style.snap,
        breathe: style.breathe * (0.5 + random()),
        pivotX: (random() - 0.5) * 0.2,
        pivotY: (random() - 0.5) * 0.14,
    });
    /** what a performance looks like, to tell one already seen in this song from a new one */
    const look = (motif: Motif, v: Variant) => `${motif}|${v.ease}|${v.entry}|${v.snap}`;
    const looks = new Set<string>();
    const beat = 60 / options.bpm;
    const barSeconds = beat * 4;
    const first = noteTimes[0] ?? 0;
    const last = noteTimes[noteTimes.length - 1] ?? 0;
    const performances: Performance[] = [];

    // the parallel motifs carry notes, so harder charts (whose official counterparts put a quarter of their
    // notes on other lines) favour them
    const carrying = { EZ: 1, HD: 1.3, IN: 1.7, AT: 1.9 }[options.difficulty];
    // relays above all: two thirds of official off-main notes come in them (another line plays most of 23% of
    // all 4 s stretches)
    const relaying = { EZ: 1, HD: 1.8, IN: 2.6, AT: 2.8 }[options.difficulty];
    const pick = (pool: Motif[], avoid: Motif[]) => {
        const weights = pool.map(m => (avoid.includes(m) ? 0.05 : 1) * (m === 'relay' ? relaying : CARRIES_NOTES.includes(m) ? carrying : style.taste[m])
            * (CHARACTER[m].bounce * character.bounce + CHARACTER[m].pendulum * character.pendulum + CHARACTER[m].wave * character.wave) * (0.5 + random()));
        let r = random() * weights.reduce((s, w) => s + w, 0);
        for (let i = 0; i < pool.length; i++) {
            r -= weights[i];
            if (r <= 0) return pool[i];
        }
        return pool[pool.length - 1];
    };
    const make = (motif: Motif, start: number, end: number, intensity: number): Performance => {
        const [lo, hi] = LINES[motif];
        const perf: Performance = { motif, start, end, lines: Math.min(MAX_LINES, lo + Math.round(random() * (hi - lo))), direction: random() < 0.5 ? -1 : 1, size: clamp(0.3 + 0.6 * intensity + 0.2 * (random() - 0.5), 0, 1), variant: makeVariant(motif) };
        // official charts put 15% of their off-main notes on upright lines; relays carry most of ours
        if (motif === 'relay') perf.upright = random() < 0.3;
        // a look the song has shown already is drawn again (a few tries), so each performance is a new one
        for (let tries = 0; tries < 4 && looks.has(look(motif, perf.variant)); tries++) perf.variant = makeVariant(motif);
        looks.add(look(motif, perf.variant));
        return perf;
    };

    // intro: lines gather before the first note (up to two bars of it)
    const introStart = Math.max(0, first - 2 * barSeconds);
    if (first - introStart >= beat * 2) performances.push(make(pick(BY_STATE.intro, []), introStart, first - beat / 2, 0.5));

    // sections, as the scroll speed reads them: runs of bars in the same state
    const sections: { from: number; to: number; state: BarState; intensity: number }[] = [];
    for (let b = 0; b < bars.length; b++) {
        const state = bars[b].state === 'drop' ? 'drop' : bars[b].state;
        const lastSection = sections[sections.length - 1];
        if (lastSection && lastSection.state === state && state !== 'drop') {
            lastSection.to = b;
            lastSection.intensity = Math.max(lastSection.intensity, bars[b].intensity);
        } else sections.push({ from: b, to: b, state, intensity: bars[b].intensity });
    }

    // a performance every couple of bars while the budget lasts, each different from the last two. a section
    // that comes back (same state, similar intensity and length, not straight after itself) replays the
    // earlier one's performances in order, mirrored, so the song's structure shows in its staging
    const seen: { index: number; state: BarState; intensity: number; bars: number; motifs: Motif[]; directions: number[]; variants: Variant[] }[] = [];
    const playTime = Math.max(1, last - first);
    let budget = COVERAGE[options.difficulty] * playTime;
    let recent: Motif[] = [];
    sections.forEach((section, index) => {
        const start = Math.max(bars[section.from].start, first);
        const end = Math.min(bars[section.to].end, last);
        if (end - start < barSeconds || (section.state === 'silent' && random() < 0.5)) return;
        const length = section.to - section.from + 1;
        const repeat = seen.find(s => s.state === section.state && Math.abs(s.intensity - section.intensity) < 0.05
            && Math.abs(s.bars - length) <= 1 && s.index < index - 1);
        const record = { index, state: section.state, intensity: section.intensity, bars: length, motifs: [] as Motif[], directions: [] as number[], variants: [] as Variant[] };
        const duration = section.state === 'build' ? Math.min(end - start, 4 * barSeconds) : section.state === 'drop' ? barSeconds : (length <= 2 ? 1 : 2) * barSeconds;
        for (let s = start, k = 0; s < end - 2 * beat && budget > 0; k++) {
            const motif = repeat?.motifs[k] ?? pick(BY_STATE[section.state], recent);
            // a relay plays a whole phrase, three or four bars, even past the end of its section
            const e = motif === 'relay' ? Math.min(s + (3 + Math.floor(random() * 2)) * barSeconds, last) : Math.min(s + duration, end);
            const perf = make(motif, s, e, section.intensity);
            if (repeat?.directions[k]) perf.direction = -repeat.directions[k];
            // a section that comes back is staged the same way, mirrored, so the return reads as one
            if (repeat?.variants[k] && repeat.motifs[k] === motif) perf.variant = repeat.variants[k];
            if (!performances.some(p => s < p.end + beat / 2 && e > p.start - beat / 2)) {
                performances.push(perf);
                budget -= e - s;
                recent = [motif, ...recent].slice(0, 2);
            }
            record.motifs.push(motif);
            record.directions.push(perf.direction);
            record.variants.push(perf.variant);
            // a bar's rest before the next one, or two when the downbeat after that hits clearly harder
            s = accentAt(e + barSeconds) >= 0.8 * accentAt(e + 2 * barSeconds) ? e + barSeconds : e + 2 * barSeconds;
        }
        if (!repeat) seen.push(record);
    });

    // outro: the lines gather once more after the last note and fade
    performances.push(make(pick(BY_STATE.outro, recent), last + beat / 2, last + beat / 2 + barSeconds, 0.4));
    performances.sort((a, b) => a.start - b.start);

    // extra lines: a performance uses the first `lines` of them
    const lineCount = performances.reduce((m, p) => Math.max(m, p.lines), 0);
    const active = (time: number) => performances.find(p => time >= p.start && time < p.end) ?? null;

    /** how strongly a performance's line is drawn: full while it carries notes, faint otherwise */
    const strength = (perf: Performance, p: number) => {
        if (!CARRIES_NOTES.includes(perf.motif) || options.difficulty === 'EZ') return DECOR_ALPHA;
        const [from, to] = perf.motif === 'relay' ? [RELAY_FROM, RELAY_TO] : [0.26, 0.74];
        const carrying = Math.min(smooth((p - from + 0.06) / 0.06), smooth((to + 0.06 - p) / 0.06));
        return DECOR_ALPHA + (1 - DECOR_ALPHA) * carrying;
    };
    const poseAt = (index: number, time: number, main: LinePose): LinePose => {
        const perf = active(time);
        if (!perf || index >= perf.lines) return { x: main.x, y: main.y, angle: main.angle, alpha: 0 };
        const p = (time - perf.start) / (perf.end - perf.start);
        const pose = variedPose(perf, index, p, (time - perf.start) / beat, beat, main);
        return { ...pose, alpha: clamp(pose.alpha, 0, 1) * strength(perf, p) * main.alpha };
    };

    // a relay line takes every note of its phrase once it has arrived (a hold must end before it leaves).
    // in a split or a stack, right-hand notes ride the first extra line and left-hand ones the second (or the
    // main line when there is none), so each hand reads one line. never on EZ
    const noteLine = (time: number, end: number, side: number) => {
        if (options.difficulty === 'EZ') return -1;
        const perf = active(time);
        if (!perf || !CARRIES_NOTES.includes(perf.motif)) return -1;
        const p = (time - perf.start) / (perf.end - perf.start);
        if (perf.motif === 'relay') {
            const pEnd = (end - perf.start) / (perf.end - perf.start);
            return p >= RELAY_FROM + 0.02 && pEnd <= RELAY_TO - 0.02 ? 0 : -1;
        }
        // the line is fully out from 0.25 to 0.75 of the performance; a hold must end while it still is
        if (p < 0.26 || p > 0.74 || (end - perf.start) / (perf.end - perf.start) > 0.75) return -1;
        // a stack shows its lines one beat after another
        if (perf.motif === 'stack' && (time - perf.start) / beat < (side > 0 ? 1 : 2)) return -1;
        return side > 0 ? 0 : perf.lines >= 2 ? 1 : -1;
    };

    // the main line dims to a third while a relay line plays
    const mainAlphaAt = (time: number) => {
        const perf = active(time);
        if (!perf || perf.motif !== 'relay') return 1;
        const p = (time - perf.start) / (perf.end - perf.start);
        return 1 - 0.7 * Math.min(smooth(p / RELAY_FROM), 1 - smooth((p - RELAY_TO) / (1 - RELAY_TO)));
    };

    return { performances, style, lineCount, poseAt, noteLine, mainAlphaAt };
};
