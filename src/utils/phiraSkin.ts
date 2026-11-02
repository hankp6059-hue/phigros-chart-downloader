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
const MH_PAD = 40;
const GOLD = '#ffe27a';

const canvasOf = (width: number, height: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, g: canvas.getContext('2d')! };
};

const toPng = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('could not draw the resource pack'))), 'image/png'));

interface Palette { light: string; mid: string; dark: string }
const TAP: Palette = { light: '#d6f6ff', mid: '#8fdcf4', dark: '#2a9fd8' };
const DRAG: Palette = { light: '#fffbd6', mid: '#f4ea86', dark: '#d8c33a' };
const FLICK: Palette = { light: '#ffd0d8', mid: '#fb7f95', dark: '#e0304f' };

/**
 * A note across [left, left + width] and [top, top + height], as the original draws its notes: a rounded
 * capsule with a white rim, a pale body and a deeper stripe along the middle, and curved bracket marks just
 * outside both ends.
 */
const drawBar = (g: CanvasRenderingContext2D, left: number, top: number, width: number, height: number, palette: Palette) => {
    const bracket = Math.max(12, height * 0.35);
    const x0 = left + bracket;
    const x1 = left + width - bracket;
    const cy = top + height / 2;
    const capsule = (inset: number) => {
        const r = height / 2 - inset;
        g.beginPath();
        g.moveTo(x0 + r, cy - r);
        g.lineTo(x1 - r, cy - r);
        g.arc(x1 - r, cy, r, -Math.PI / 2, Math.PI / 2);
        g.lineTo(x0 + r, cy + r);
        g.arc(x0 + r, cy, r, Math.PI / 2, (3 * Math.PI) / 2);
        g.closePath();
    };
    // pale body
    const body = g.createLinearGradient(0, top, 0, top + height);
    body.addColorStop(0, palette.light);
    body.addColorStop(1, palette.mid);
    g.fillStyle = body;
    capsule(height * 0.08);
    g.fill();
    // deeper stripe along the middle
    g.fillStyle = palette.dark;
    const stripe = height * 0.17;
    g.fillRect(x0 + height * 0.45, cy - stripe, x1 - x0 - height * 0.9, stripe * 2);
    // white rim
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(3, height * 0.1);
    capsule(height * 0.08);
    g.stroke();
    // curved brackets just outside both ends
    g.lineWidth = Math.max(3, height * 0.09);
    g.lineCap = 'round';
    for (const side of [-1, 1]) {
        const cx = side < 0 ? x0 + height / 2 : x1 - height / 2;
        const r = height / 2 + bracket * 0.45;
        const from = side < 0 ? Math.PI * 0.72 : -Math.PI * 0.28;
        g.beginPath();
        g.arc(cx, cy, r, from, from + Math.PI * 0.56);
        g.stroke();
    }
};

/** the multi-press glow: a soft gold halo with a gold outline around the whole note, rounded like it */
const drawGlow = (g: CanvasRenderingContext2D, left: number, top: number, width: number, height: number) => {
    const r = height / 2 + 10;
    const path = () => {
        g.beginPath();
        g.moveTo(left + r - 10, top - 10);
        g.lineTo(left + width - r + 10, top - 10);
        g.arc(left + width - r + 10, top + height / 2, r, -Math.PI / 2, Math.PI / 2);
        g.lineTo(left + r - 10, top + height + 10);
        g.arc(left + r - 10, top + height / 2, r, Math.PI / 2, (3 * Math.PI) / 2);
        g.closePath();
    };
    g.save();
    g.shadowColor = GOLD;
    g.shadowBlur = 26;
    g.fillStyle = 'rgba(255,226,122,0.28)';
    path();
    g.fill();
    g.strokeStyle = GOLD;
    g.lineWidth = 6;
    path();
    g.stroke();
    g.restore();
};

/** two white chevrons pointing up, centred on the bar: the flick's mark */
const drawChevrons = (g: CanvasRenderingContext2D, cx: number, top: number, height: number) => {
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(4, height * 0.09);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const w = height * 0.55;
    for (const offset of [-w * 0.8, w * 0.8]) {
        g.beginPath();
        g.moveTo(cx + offset - w / 2, top + height * 0.68);
        g.lineTo(cx + offset, top + height * 0.3);
        g.lineTo(cx + offset + w / 2, top + height * 0.68);
        g.stroke();
    }
};

/** A note texture: `height` is the bar's height; multi-press versions add room for the glow on every side. */
const noteTexture = (palette: Palette, height: number, multi: boolean, mark?: (g: CanvasRenderingContext2D, cx: number, top: number, h: number) => void) => {
    const pad = multi ? MH_PAD : 0;
    const { canvas, g } = canvasOf(NOTE_WIDTH + pad * 2, height + pad * 2);
    if (multi) drawGlow(g, pad, pad, NOTE_WIDTH, height);
    drawBar(g, pad, pad, NOTE_WIDTH, height, palette);
    mark?.(g, pad + NOTE_WIDTH / 2, pad, height);
    return canvas;
};

// hold texture: tail cap on top, translucent body, tap-like head at the bottom
const HOLD_TAIL = 40;
const HOLD_BODY = 400;
const HOLD_HEAD = 100;

const holdTexture = (multi: boolean) => {
    const pad = multi ? MH_PAD : 0;
    const width = NOTE_WIDTH + pad * 2;
    const height = HOLD_TAIL + HOLD_BODY + HOLD_HEAD + pad * 2;
    const { canvas, g } = canvasOf(width, height);
    // the body is as wide as the note: light, translucent cyan with thin white sides
    const bodyTop = pad + HOLD_TAIL * 0.5;
    const bodyBottom = height - pad - HOLD_HEAD * 0.5;
    const body = g.createLinearGradient(0, bodyTop, 0, bodyBottom);
    body.addColorStop(0, 'rgba(160,236,255,0.35)');
    body.addColorStop(1, 'rgba(120,226,255,0.65)');
    g.fillStyle = body;
    g.fillRect(pad + 10, bodyTop, NOTE_WIDTH - 20, bodyBottom - bodyTop);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.fillRect(pad + 10, bodyTop, 8, bodyBottom - bodyTop);
    g.fillRect(pad + NOTE_WIDTH - 18, bodyTop, 8, bodyBottom - bodyTop);
    // the tail: a thin white cap
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(pad + 10, pad + HOLD_TAIL * 0.5 - 4, NOTE_WIDTH - 20, 8);
    // the head, like a tap
    const headTop = height - pad - HOLD_HEAD;
    if (multi) drawGlow(g, pad, headTop, NOTE_WIDTH, HOLD_HEAD);
    drawBar(g, pad, headTop, NOTE_WIDTH, HOLD_HEAD, TAP);
    return { canvas, atlas: [HOLD_TAIL + pad, HOLD_HEAD + pad] as [number, number] };
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
    await add('click.png', noteTexture(TAP, 100, false));
    await add('click_mh.png', noteTexture(TAP, 100, true));
    await add('drag.png', noteTexture(DRAG, 60, false));
    await add('drag_mh.png', noteTexture(DRAG, 60, true));
    await add('flick.png', noteTexture(FLICK, 120, false, drawChevrons));
    await add('flick_mh.png', noteTexture(FLICK, 120, true, drawChevrons));
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
