// a Phira resource pack in the look of the original game. Phira draws notes and hit effects from the
// resource pack the player has chosen, not from the chart, so this is how charts played in Phira get the
// original's note shapes and hit animation. everything is drawn here with canvas shapes (no game assets).
//
// format (Phira prpr/src/core/resource.rs): info.yml; click/drag/flick/hold.png and their multi-press (_mh)
// versions, each stretched to the note's width; hold.png is the tail (top holdAtlas[0] rows), the body
// (stretched) and the head (bottom holdAtlas[1] rows); hit_fx.png is a grid of hitFx[0] x hitFx[1] frames
// played over hitFxDuration and tinted with the Perfect / Good colour. sounds are optional (Phira falls
// back to its own), and Phira adds its own small flying squares to each hit, as the original has.

import JSZip from 'jszip';

const NOTE_WIDTH = 1000;
/** multi-press textures are wider by their glow; Phira scales them by their width over the plain one */
const MH_PAD = 36;
const GLOW = '#f2ec5c';

const canvasOf = (width: number, height: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, g: canvas.getContext('2d')! };
};

const toPng = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('could not draw the resource pack'))), 'image/png'));

// measured on a screen recording of the original (a tap is ~290 x 30 px on a 2360 px wide screen)
/** a note's height, as a share of its width */
const NOTE_HEIGHT = 92;
const TAP_FILL = '#11b6f6';
const DRAG_FILL = '#ece34f';
const FLICK_FILL = '#ef3d5c';

type Path = [number, number][];
const fillPath = (g: CanvasRenderingContext2D, points: Path) => {
    g.beginPath();
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
};
/** an elongated hexagon from x0 to x1, centred on cy, `h` high, its ends pointed by `tip` */
const hexagon = (x0: number, x1: number, cy: number, h: number, tip: number): Path => [
    [x0 + tip, cy - h / 2], [x1 - tip, cy - h / 2], [x1, cy], [x1 - tip, cy + h / 2], [x0 + tip, cy + h / 2], [x0, cy],
];
/** a chevron pointing out of the note (side -1: left), its tip at `x` */
const chevron = (x: number, cy: number, h: number, thickness: number, side: number): Path => {
    const depth = h * 0.42 * -side;
    return [[x, cy], [x + depth, cy - h / 2], [x + depth - side * thickness, cy - h / 2], [x - side * thickness, cy], [x + depth - side * thickness, cy + h / 2], [x + depth, cy + h / 2]];
};

/**
 * A note as the original draws it, across [left, left + width] centred on cy: a white frame shaped as a long
 * hexagon (pointed ends), the coloured bar inside it with pointed ends too, and a detached white chevron past
 * each end. `split` leaves a gap in the middle of the bar (the flick's mark sits there).
 */
const drawNote = (g: CanvasRenderingContext2D, left: number, cy: number, width: number, h: number, fill: string, split = 0) => {
    const chevronWidth = h * 0.42;
    const frame0 = left + chevronWidth + h * 0.14;
    const frame1 = left + width - chevronWidth - h * 0.14;
    g.fillStyle = '#ffffff';
    fillPath(g, hexagon(frame0, frame1, cy, h, h * 0.28));
    fillPath(g, chevron(left + h * 0.02, cy, h * 0.9, h * 0.2, -1));
    fillPath(g, chevron(left + width - h * 0.02, cy, h * 0.9, h * 0.2, 1));
    const inset = h * 0.21;
    g.fillStyle = fill;
    const bar = hexagon(frame0 + inset, frame1 - inset, cy, h - inset * 2, (h - inset * 2) * 0.35);
    if (!split) {
        fillPath(g, bar);
        return;
    }
    const mid = (frame0 + frame1) / 2;
    g.save();
    g.beginPath();
    g.rect(0, 0, mid - split / 2, cy * 2 + h);
    g.rect(mid + split / 2, 0, g.canvas.width, cy * 2 + h);
    g.clip();
    fillPath(g, bar);
    g.restore();
};

/**
 * the flick's mark: a white lightning bolt standing across the bar, two slanted strokes stepped apart at the
 * middle, each with a small red notch
 */
const drawBolt = (g: CanvasRenderingContext2D, cx: number, cy: number, h: number) => {
    const u = h;
    const stroke = 0.44 * u;
    const lean = 0.3 * u;
    const step = 0.13 * u;
    g.fillStyle = '#ffffff';
    // upper stroke: from the top, leaning down to the left, ending at the middle
    fillPath(g, [[cx + lean - stroke / 2 + step, cy - 1.15 * u], [cx + lean + stroke / 2 + step, cy - 1.15 * u],
        [cx + stroke / 2 + step, cy + 0.08 * u], [cx - stroke / 2 + step, cy + 0.08 * u]]);
    // lower stroke: stepped to the left, from the middle on down
    fillPath(g, [[cx - stroke / 2 - step, cy - 0.08 * u], [cx + stroke / 2 - step, cy - 0.08 * u],
        [cx - lean + stroke / 2 - step, cy + 1.15 * u], [cx - lean - stroke / 2 - step, cy + 1.15 * u]]);
    g.fillStyle = FLICK_FILL;
    fillPath(g, [[cx + lean + step - 0.02 * u, cy - 0.92 * u], [cx + lean + step + 0.1 * u, cy - 0.92 * u], [cx + lean + step - 0.02 * u, cy - 0.74 * u]]);
    fillPath(g, [[cx - lean - step + 0.02 * u, cy + 0.92 * u], [cx - lean - step - 0.1 * u, cy + 0.92 * u], [cx - lean - step + 0.02 * u, cy + 0.74 * u]]);
};

/** the multi-press glow: draws `shape` again under a yellow halo that follows its outline */
const withGlow = (g: CanvasRenderingContext2D, shape: () => void) => {
    g.save();
    g.shadowColor = GLOW;
    for (const blur of [26, 14]) {
        g.shadowBlur = blur;
        shape();
    }
    g.restore();
};

/** A note texture; flicks are taller to hold the bolt, and multi-press versions add room for the glow. */
const noteTexture = (fill: string, height: number, multi: boolean, flick = false) => {
    const pad = multi ? MH_PAD : 0;
    const boltRoom = flick ? height * 0.75 : 0;
    const { canvas, g } = canvasOf(NOTE_WIDTH + pad * 2, height + (boltRoom + pad) * 2);
    const cy = canvas.height / 2;
    const draw = () => {
        drawNote(g, pad, cy, NOTE_WIDTH, height, fill, flick ? height * 0.95 : 0);
        if (flick) drawBolt(g, pad + NOTE_WIDTH / 2, cy, height);
    };
    if (multi) withGlow(g, draw);
    draw();
    return canvas;
};

// hold texture: a light cyan body, lighter towards the head, with a thin lighter stripe inside each side and
// a white rim outside it, the corners chamfered at both ends. the ends are the tail (top) and head (bottom)
const HOLD_END = 50;
const HOLD_BODY = 400;

const holdTexture = (multi: boolean) => {
    const pad = multi ? MH_PAD : 0;
    const width = NOTE_WIDTH + pad * 2;
    const height = HOLD_END * 2 + HOLD_BODY + pad * 2;
    const { canvas, g } = canvasOf(width, height);
    const left = pad + 30;
    const right = pad + NOTE_WIDTH - 30;
    const top = pad + 6;
    const bottom = height - pad - 6;
    const cut = HOLD_END * 0.7;
    const outline: Path = [[left + cut, top], [right - cut, top], [right, top + cut], [right, bottom - cut], [right - cut, bottom], [left + cut, bottom], [left, bottom - cut], [left, top + cut]];
    const rim = () => {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 12;
        g.lineJoin = 'miter';
        g.beginPath();
        outline.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.stroke();
    };
    if (multi) withGlow(g, rim);
    rim();
    // the body sits inside the rim with a narrow gap
    const gap = 18;
    const inner: Path = [[left + cut + gap * 0.4, top + gap], [right - cut - gap * 0.4, top + gap], [right - gap, top + cut], [right - gap, bottom - cut], [right - cut - gap * 0.4, bottom - gap], [left + cut + gap * 0.4, bottom - gap], [left + gap, bottom - cut], [left + gap, top + cut]];
    const body = g.createLinearGradient(0, top, 0, bottom);
    body.addColorStop(0, 'rgba(176,222,238,0.88)');
    body.addColorStop(1, 'rgba(150,232,252,0.96)');
    g.fillStyle = body;
    fillPath(g, inner);
    g.fillStyle = 'rgba(190,242,255,0.7)';
    g.fillRect(left + gap + 14, top + cut, 22, bottom - top - cut * 2);
    g.fillRect(right - gap - 36, top + cut, 22, bottom - top - cut * 2);
    return { canvas, atlas: [HOLD_END + pad, HOLD_END + pad] as [number, number] };
};

// hit effect, as the original's: two level square frames growing apart over a faint diamond, arcs circling
// inside and a bright round core, drawn white so Phira tints them gold (Perfect) or blue (Good)
const FX_COLS = 8;
const FX_ROWS = 4;
const FX_CELL = 256;
const FX_SECONDS = 0.5;

const hitFxTexture = () => {
    const { canvas, g } = canvasOf(FX_COLS * FX_CELL, FX_ROWS * FX_CELL);
    const frames = FX_COLS * FX_ROWS;
    for (let i = 0; i < frames; i++) {
        const p = i / (frames - 1);
        const ease = 1 - (1 - p) ** 3;
        const fade = 1 - p;
        g.save();
        g.translate((i % FX_COLS) * FX_CELL + FX_CELL / 2, Math.floor(i / FX_COLS) * FX_CELL + FX_CELL / 2);
        g.strokeStyle = '#ffffff';
        g.fillStyle = '#ffffff';
        // a faint diamond behind
        g.save();
        g.rotate(Math.PI / 4);
        const diamond = FX_CELL * (0.36 + 0.14 * ease);
        g.globalAlpha = 0.35 * fade;
        g.fillRect(-diamond / 2, -diamond / 2, diamond, diamond);
        g.restore();
        // two level square frames, the inner one a little off-centre, growing apart
        g.lineWidth = FX_CELL * 0.016;
        const outer = FX_CELL * (0.46 + 0.3 * ease);
        g.globalAlpha = fade ** 1.2;
        g.strokeRect(-outer / 2, -outer / 2, outer, outer);
        const inner = outer * 0.84;
        g.globalAlpha = fade ** 1.5;
        g.strokeRect(-inner / 2 + FX_CELL * 0.02, -inner / 2 + FX_CELL * 0.02, inner, inner);
        // arcs circling inside
        g.lineWidth = FX_CELL * 0.014;
        g.globalAlpha = 0.85 * fade;
        for (const [radius, offset] of [[0.17, 0], [0.24, Math.PI * 0.8]] as const) {
            const start = Math.PI * (0.3 + 1.5 * ease) + offset;
            g.beginPath();
            g.arc(0, 0, FX_CELL * radius * (0.8 + 0.4 * ease), start, start + Math.PI * 0.9);
            g.stroke();
        }
        // a bright solid core, shrinking away
        const coreRadius = FX_CELL * 0.1 * (1 - 0.6 * p);
        const core = g.createRadialGradient(0, 0, coreRadius * 0.55, 0, 0, coreRadius);
        core.addColorStop(0, 'rgba(255,255,255,1)');
        core.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = core;
        g.globalAlpha = fade ** 1.5;
        g.beginPath();
        g.arc(0, 0, coreRadius, 0, Math.PI * 2);
        g.fill();
        g.restore();
    }
    return canvas;
};

/** Builds the resource pack zip. */
export const buildPhiraSkin = async (): Promise<Blob> => {
    const zip = new JSZip();
    const add = async (name: string, canvas: HTMLCanvasElement) => zip.file(name, await toPng(canvas));
    await add('click.png', noteTexture(TAP_FILL, NOTE_HEIGHT, false));
    await add('click_mh.png', noteTexture(TAP_FILL, NOTE_HEIGHT, true));
    await add('drag.png', noteTexture(DRAG_FILL, NOTE_HEIGHT * 0.8, false));
    await add('drag_mh.png', noteTexture(DRAG_FILL, NOTE_HEIGHT * 0.8, true));
    await add('flick.png', noteTexture(FLICK_FILL, NOTE_HEIGHT, false, true));
    await add('flick_mh.png', noteTexture(FLICK_FILL, NOTE_HEIGHT, true, true));
    const hold = holdTexture(false);
    const holdMh = holdTexture(true);
    await add('hold.png', hold.canvas);
    await add('hold_mh.png', holdMh.canvas);
    await add('hit_fx.png', hitFxTexture());
    zip.file('info.yml', [
        'name: Phigros Style (procedural)',
        'author: Phigros Chart Downloader',
        'description: Notes and hit effect in the look of the original game, drawn procedurally. No game assets.',
        `hitFx: [${FX_COLS}, ${FX_ROWS}]`,
        `hitFxDuration: ${FX_SECONDS}`,
        'hitFxScale: 1.0',
        'hitFxRotate: false',
        'hideParticles: false',
        'hitFxTinted: true',
        `holdAtlas: [${hold.atlas[0]}, ${hold.atlas[1]}]`,
        `holdAtlasMH: [${holdMh.atlas[0]}, ${holdMh.atlas[1]}]`,
        'holdKeepHead: false',
        'holdRepeat: false',
        'holdCompact: false',
        // colorPerfect / colorGood are left out: Phira's defaults are the original's gold and light blue
        '',
    ].join('\n'));
    return zip.generateAsync({ type: 'blob' });
};
