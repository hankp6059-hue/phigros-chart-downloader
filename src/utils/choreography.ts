// judgment-line choreography: short performances made only of judgment lines, staged the way official charts
// are. there is only ever one line to play on: the main line, or a line that takes over a phrase from it (a
// relay) while the main line fades out. every other line is decoration and is made to read as decoration:
// upright rails sliding in at the sides, lines sweeping across or turning about the centre, quick streaks
// along the top, pieces flying off the main line. no decoration ever sits still and level beside the main
// line, where it would look like another line to play. which performances a song gets, where and how they
// move come from the song itself (its sections, its character, its accents) and a seed of the song, so every
// song is staged differently and the same song always the same way.
//
// most notes stay on the main line, as in official charts (it carries about three quarters); of the rest,
// two thirds come in relays there. relay lines (level, tilted or upright) carry notes; the generator places
// them with its two-dimensional hand model, so they stay comfortable to play wherever the line is

import type { GeneratorDifficulty } from './chartGenerator';
import type { BarMood, BarState, LinePose } from './lineMotion';

export type Motif = 'relay' | 'rails' | 'streaks' | 'fan' | 'cross' | 'orbit' | 'sweep' | 'flyIn' | 'pendulum' | 'converge' | 'shatter' | 'pulse';

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
}

export interface Choreography {
    performances: Performance[];
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
const CARRIES_NOTES: Motif[] = ['relay'];
// a line that is only performing stays faint (the playing lines are drawn at full strength), so it is never
// mistaken for one to hit; official charts keep note-less lines at a mean opacity of 0.61, 35% of the time
// under 0.5
const DECOR_ALPHA = 0.45;
/** part of a relay (0..1) during which its line has arrived and carries the notes */
const RELAY_FROM = 0.18;
const RELAY_TO = 0.86;

/** motifs that suit each kind of section */
const BY_STATE: Record<BarState | 'intro' | 'outro', Motif[]> = {
    intro: ['streaks', 'flyIn', 'rails', 'converge', 'orbit'],
    silent: ['pulse', 'rails'],
    calm: ['relay', 'rails', 'pendulum', 'pulse', 'sweep'],
    groove: ['relay', 'rails', 'sweep', 'cross', 'pendulum', 'fan'],
    build: ['relay', 'converge', 'rails', 'orbit', 'streaks'],
    drop: ['shatter', 'streaks', 'fan', 'cross'],
    climax: ['relay', 'rails', 'sweep', 'cross', 'orbit', 'fan', 'shatter'],
    outro: ['converge', 'rails', 'fan'],
};

/** which of the song's characters (from the line motion) each motif suits */
const CHARACTER: Record<Motif, { bounce: number; pendulum: number; wave: number }> = {
    relay: { bounce: 0.8, pendulum: 0.8, wave: 0.8 },
    rails: { bounce: 0.8, pendulum: 0.6, wave: 0.8 },
    streaks: { bounce: 1, pendulum: 0.3, wave: 0.6 },
    shatter: { bounce: 1, pendulum: 0.4, wave: 0.2 },
    pulse: { bounce: 0.9, pendulum: 0.3, wave: 0.4 },
    fan: { bounce: 0.4, pendulum: 1, wave: 0.5 },
    cross: { bounce: 0.5, pendulum: 1, wave: 0.4 },
    pendulum: { bounce: 0.2, pendulum: 1, wave: 0.6 },
    converge: { bounce: 0.5, pendulum: 0.8, wave: 0.6 },
    orbit: { bounce: 0.3, pendulum: 0.5, wave: 1 },
    sweep: { bounce: 0.4, pendulum: 0.4, wave: 1 },
    flyIn: { bounce: 0.7, pendulum: 0.6, wave: 0.6 },
};

const LINES: Record<Motif, [number, number]> = {
    relay: [1, 1], rails: [2, 3], streaks: [3, 4], fan: [2, 4], cross: [2, 2], orbit: [2, 4], sweep: [1, 2],
    flyIn: [2, 4], pendulum: [1, 2], converge: [2, 4], shatter: [3, 4], pulse: [2, 3],
};

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
    const env = envelope(p);
    const spread = (k + 1) / n;
    switch (perf.motif) {
        case 'relay': {
            // a line flies in from the side, settles higher up and a little tilted (or upright at one side),
            // drifts while it plays the phrase, and flies out the other way
            const restX = perf.upright ? 0.5 + d * 0.22 : 0.5 + d * 0.06;
            const restY = perf.upright ? 0.5 : 0.5 + 0.18 * size;
            const tilt = perf.upright ? d * (72 + 18 * size) : d * (6 + 14 * size);
            const enter = easeOut(p / RELAY_FROM);
            const leave = smooth((p - RELAY_TO) / (1 - RELAY_TO));
            const x = restX - d * 0.9 * (1 - enter) + d * 0.9 * leave;
            const drift = Math.sin(Math.PI * Math.min(1, Math.max(0, (p - RELAY_FROM) / (RELAY_TO - RELAY_FROM))));
            return { x, y: restY + 0.03 * drift, angle: tilt - d * 5 * drift, alpha: Math.min(enter, 1 - leave) };
        }
        case 'rails': {
            // two or three upright lines close together slide in at one side of the screen, ride there, and slide out
            const edge = d > 0 ? 0.97 : 0.03;
            const inward = (0.12 + 0.14 * size) * smooth(Math.min(p / 0.3, (1 - p) / 0.3));
            return { x: edge - d * inward - d * 0.018 * k, y: 0.5, angle: 90, alpha: env };
        }
        case 'streaks': {
            // quick level streaks along the top of the screen, well clear of the main line, gone within the bar
            const lane = 0.86 + 0.035 * k;
            const travel = easeOut(Math.min(1, p * 1.6 + 0.1 * k));
            return { x: d > 0 ? -0.5 + 1.6 * travel : 1.5 - 1.6 * travel, y: lane, angle: 0, alpha: env * (1 - 0.15 * k) };
        }
        case 'fan': {
            // lines open out from the main line's centre like a fan, then close
            const angle = main.angle + d * (k % 2 ? -1 : 1) * (20 + 50 * size) * Math.ceil((k + 1) / 2) / Math.ceil(n / 2) * smooth(Math.min(p / 0.35, (1 - p) / 0.35));
            return { x: main.x, y: main.y, angle, alpha: env * 0.9 };
        }
        case 'cross': {
            // two lines cross in an X over the centre and turn together
            const angle = (k ? -1 : 1) * (35 + 15 * size) + d * 90 * easeOut(p) * (0.5 + size);
            return { x: 0.5, y: 0.55, angle, alpha: env * 0.8 };
        }
        case 'orbit': {
            // spokes around the centre of the screen, turning
            const angle = (180 / n) * k + d * (90 + 180 * size) * p;
            return { x: 0.5, y: 0.55, angle, alpha: env * 0.55 };
        }
        case 'sweep': {
            // an upright line (or a close pair) sweeps across the screen, leaning a little as it goes
            const travel = easeOut(p);
            const x = (d > 0 ? -0.1 + 1.2 * travel : 1.1 - 1.2 * travel) - d * 0.025 * k;
            return { x, y: 0.5, angle: 90 - d * (8 + 12 * size) * (1 - travel), alpha: env };
        }
        case 'flyIn': {
            // upright lines come in from both sides and frame the screen, then fade
            const side = k % 2 ? 1 : -1;
            const rest = 0.5 + side * (0.18 + 0.12 * Math.floor(k / 2));
            const x = rest + side * 0.7 * (1 - easeOut(p / 0.4));
            return { x, y: 0.5, angle: 90, alpha: smooth((1 - p) / 0.3) * 0.8 };
        }
        case 'pendulum': {
            // swings from a point above the screen, a swing a bar
            const swing = Math.sin(Math.PI * beats / 2 + k * 0.6) * (20 + 25 * size) * d;
            return { x: 0.5 + 0.25 * Math.sin((swing * Math.PI) / 180), y: 0.75 - 0.08 * k, angle: swing, alpha: env * 0.8 };
        }
        case 'converge': {
            // upright lines from both sides close in on the centre of the screen and vanish there
            const from = (k % 2 ? -1 : 1) * (0.35 + 0.08 * Math.floor(k / 2) + 0.05 * size);
            const close = smooth(p);
            return { x: 0.5 + from * (1 - close), y: 0.5, angle: 90 + d * 10 * (1 - close) * (k % 2 ? -1 : 1), alpha: Math.min(smooth(p / 0.2), 1 - smooth((p - 0.8) / 0.2)) * 0.9 };
        }
        case 'shatter': {
            // the main line bursts into pieces that fly apart and fade
            const theta = ((k + 0.5) / n) * Math.PI * 2 * d + size;
            const out = easeOut(p) * (0.25 + 0.2 * size);
            return { x: main.x + Math.cos(theta) * out, y: main.y + Math.sin(theta) * out, angle: main.angle + d * (60 + 120 * spread) * easeOut(p), alpha: 1 - smooth(p) };
        }
        case 'pulse':
        default: {
            // upright lines across the screen flash on the beat, one after another
            const phase = (beats - k / n + 4) % 1;
            return { x: 0.5 + d * (k + 1 - (n + 1) / 2) * 0.22, y: 0.5, angle: 90, alpha: env * Math.max(0, 1 - phase * 2.5) * 0.8 };
        }
    }
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
}): Choreography => {
    const { bars, character, noteTimes, accentAt } = options;
    const random = createRandom(`${options.seed}|choreography`);
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
        const weights = pool.map(m => (avoid.includes(m) ? 0.05 : 1) * (m === 'relay' ? relaying : CARRIES_NOTES.includes(m) ? carrying : 1)
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
        const perf: Performance = { motif, start, end, lines: Math.min(MAX_LINES, lo + Math.round(random() * (hi - lo))), direction: random() < 0.5 ? -1 : 1, size: clamp(0.3 + 0.6 * intensity + 0.2 * (random() - 0.5), 0, 1) };
        // official charts put 15% of their off-main notes on upright lines; relays carry most of ours
        if (motif === 'relay') perf.upright = random() < 0.3;
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
    const seen: { index: number; state: BarState; intensity: number; bars: number; motifs: Motif[]; directions: number[] }[] = [];
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
        const record = { index, state: section.state, intensity: section.intensity, bars: length, motifs: [] as Motif[], directions: [] as number[] };
        const duration = section.state === 'build' ? Math.min(end - start, 4 * barSeconds) : section.state === 'drop' ? barSeconds : (length <= 2 ? 1 : 2) * barSeconds;
        for (let s = start, k = 0; s < end - 2 * beat && budget > 0; k++) {
            const motif = repeat?.motifs[k] ?? pick(BY_STATE[section.state], recent);
            // a relay plays a whole phrase, three or four bars, even past the end of its section
            const e = motif === 'relay' ? Math.min(s + (3 + Math.floor(random() * 2)) * barSeconds, last) : Math.min(s + duration, end);
            const perf = make(motif, s, e, section.intensity);
            if (repeat?.directions[k]) perf.direction = -repeat.directions[k];
            if (!performances.some(p => s < p.end + beat / 2 && e > p.start - beat / 2)) {
                performances.push(perf);
                budget -= e - s;
                recent = [motif, ...recent].slice(0, 2);
            }
            record.motifs.push(motif);
            record.directions.push(perf.direction);
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
        const [from, to] = [RELAY_FROM, RELAY_TO];
        const carrying = Math.min(smooth((p - from + 0.06) / 0.06), smooth((to + 0.06 - p) / 0.06));
        return DECOR_ALPHA + (1 - DECOR_ALPHA) * carrying;
    };
    const poseAt = (index: number, time: number, main: LinePose): LinePose => {
        const perf = active(time);
        if (!perf || index >= perf.lines) return { x: main.x, y: main.y, angle: main.angle, alpha: 0 };
        const p = (time - perf.start) / (perf.end - perf.start);
        const pose = motifPose(perf, index, p, (time - perf.start) / beat, main);
        return { ...pose, alpha: clamp(pose.alpha, 0, 1) * strength(perf, p) * main.alpha };
    };

    // a relay line takes every note of its phrase once it has arrived (a hold must end before it leaves); never
    // on EZ. no other line ever carries notes
    const noteLine = (time: number, end: number, side: number) => {
        void side;
        if (options.difficulty === 'EZ') return -1;
        const perf = active(time);
        if (!perf || perf.motif !== 'relay') return -1;
        const p = (time - perf.start) / (perf.end - perf.start);
        const pEnd = (end - perf.start) / (perf.end - perf.start);
        return p >= RELAY_FROM + 0.02 && pEnd <= RELAY_TO - 0.02 ? 0 : -1;
    };

    // the main line all but fades out while a relay line plays, so there is one line to play on
    const mainAlphaAt = (time: number) => {
        const perf = active(time);
        if (!perf || perf.motif !== 'relay') return 1;
        const p = (time - perf.start) / (perf.end - perf.start);
        return 1 - 0.88 * Math.min(smooth(p / RELAY_FROM), 1 - smooth((p - RELAY_TO) / (1 - RELAY_TO)));
    };

    return { performances, lineCount, poseAt, noteLine, mainAlphaAt };
};
