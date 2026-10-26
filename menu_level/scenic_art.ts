// NOT ORIGINAL - scenic level art for the new front end (the user's request, 2026-10-25; a prototype for THPS3): a
// picture of the converted level taken in our own game from a scenic spot above it (scenic_spots.ts picks the poses,
// scenic_capture.ts takes them into a cache outside the repo), run through one of our own deterministic print-style
// filters in the B+C look (docs/design/frontend/README.md: ink black, paper white, the game's colour) and written as the
// level's front end art, images\frontend_art_<game>_<level>.img.xbx - in place of frontend_art.ts's crop of its
// loading picture. The real loading screen (Levels.qb's loading_screen) is unchanged.
//
// The styles (STYLES; all three made for every level, so the user can choose - `--style` picks the installed one):
//   a  duotone halftone: the tones mapped ink -> the game's colour -> paper, a black 45-degree halftone screen over
//      the shadows and a colour screen at 15 degrees in the light, on paper grain (the default);
//   b  screenprint: flattened (blurred, posterised to four inks: black, the dark game colour, the game colour, paper),
//      black ink outlines from the edges, the colour layers a little off register, paper grain;
//   c  graded photo: desaturated, high contrast, split-toned (shadows to the game colour's dark, highlights to paper),
//      film grain and a vignette.
// Every size in a style is in pixels of the 640-wide picture, so the native and the HD pictures look alike; the noise
// is a hash of the pixel's place (no Math.random): the same capture always gives the same bytes (scenic_art.test.ts).
//
// Sizes: the front end draws its art full-bleed over the 16:9 screen (cover-cropped - src/game/front/new_frontend_draw.cpp
// ArtBox), and the pictures are 16:9 captures, so the art is 640 x 360 and its HD version (hd_ui, x4) 2560 x 1440 at the
// capture's own resolution, DXT1 like the HD loading screens - written here, not upscaled by the hd_ui pass
// (make_menu_level passes them as its `ownHd`).
//
//   node tools/pipeline/menu_level/scenic_art.ts sheets <out folder> [--game thps3]   contact sheets: candidates per level,
//                                                                            and the chosen pictures in each style
//   node tools/pipeline/menu_level/scenic_art.ts check [--game thps3]                 every chosen picture is in the cache

import * as fs from "node:fs";
import * as path from "node:path";
import { encodeImg } from "../hd_textures/ui.ts";
import { parseCli } from "../lib/cli.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import { nativeImg, type Picture, readPng, resize, toPng } from "./loading_art.ts";
import { capturePath } from "./scenic_capture.ts";
import { readSpots, type SpotsFile } from "./scenic_spots.ts";

export const ART_W = 640;
export const ART_H = 360;
export const HD_SCALE = 4;

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
];
export const INK: Rgb = hex("#0A0A0A");
export const PAPER: Rgb = hex("#F2EFE8");
// The games' colours (docs/design/frontend/README.md).
export const GAME_COLOURS: Readonly<Record<string, string>> = {
    thug2: "#A48BFF",
    thug1: "#2FD38A",
    thps4: "#FF6B3D",
    thps3: "#3DB7FF",
    thps2: "#FF4F9A",
    thaw: "#F2C230",
    thp8: "#5FE0D0",
};

// --- the filters' parameters (all sizes in pixels of the 640-wide picture) ------------------------------------------

export interface DuotoneParams {
    equalise: number; // how much of the histogram equalisation (0-1)
    kind: "duotone";
    black: number; // levels: the share of pixels clipped to black / white
    white: number;
    gamma: number;
    mid: number; // where the game's colour sits on the ink -> paper ramp (0-1)
    period: number; // halftone cell
    inkFrom: number; // tones below this get black dots (bigger the darker)
    inkMax: number; // the darkest tone's dot coverage
    colourFrom: number; // tones above this get colour dots on the light (bigger the lighter... less colour)
    grain: number; // paper grain strength
    seed: number;
}
export interface ScreenprintParams {
    equalise: number; // how much of the histogram equalisation (0-1)
    kind: "screenprint";
    black: number;
    white: number;
    blur: number; // flattening blur radius
    levels: [number, number, number]; // the tone thresholds between the four inks
    darkColour: number; // the dark ink = the game colour times this
    edge: number; // edge strength over which a pixel is outline
    edgeBlur: number;
    offset: [number, number]; // the colour layers' misregistration
    grain: number;
    seed: number;
}
export interface GradedParams {
    equalise: number; // how much of the histogram equalisation (0-1)
    kind: "graded";
    black: number;
    white: number;
    saturation: number; // of the original colour kept
    contrast: number; // the S-curve's strength (0-1)
    tint: number; // how much of the split tone
    grain: number; // film grain amplitude (0-1 of full scale)
    grainSize: number;
    vignette: number;
    seed: number;
}
export type StyleParams = DuotoneParams | ScreenprintParams | GradedParams;
export type Style = "a" | "b" | "c";

export const STYLES: Readonly<Record<Style, StyleParams>> = {
    a: {
        kind: "duotone",
        equalise: 0.5,
        black: 0.01,
        white: 0.005,
        gamma: 1.1,
        mid: 0.55,
        period: 4.6,
        inkFrom: 0.4,
        inkMax: 0.75,
        colourFrom: 0.72,
        grain: 0.06,
        seed: 3,
    },
    b: {
        kind: "screenprint",
        equalise: 0.5,
        black: 0.01,
        white: 0.01,
        blur: 2.0,
        levels: [0.24, 0.48, 0.74],
        darkColour: 0.42,
        edge: 0.14,
        edgeBlur: 0.8,
        offset: [1.2, 0.8],
        grain: 0.05,
        seed: 5,
    },
    c: {
        kind: "graded",
        equalise: 0.3,
        black: 0.005,
        white: 0.005,
        saturation: 0.25,
        contrast: 0.65,
        tint: 0.5,
        grain: 0.07,
        grainSize: 0.9,
        vignette: 0.35,
        seed: 7,
    },
};
export const STYLE_NAMES: Readonly<Record<Style, string>> = {
    a: "duotone halftone",
    b: "screenprint",
    c: "graded photo",
};

// --- pieces ---------------------------------------------------------------------------------------------------------

// A hash of (x, y, seed) in [0, 1): the grain's noise, the same everywhere.
export function hash01(x: number, y: number, seed: number): number {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Smooth value noise at `cell` pixels (bilinear between hashed lattice points).
function valueNoise(x: number, y: number, cell: number, seed: number): number {
    const fx = x / cell;
    const fy = y / cell;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const ax = fx - ix;
    const ay = fy - iy;
    const sx = ax * ax * (3 - 2 * ax);
    const sy = ay * ay * (3 - 2 * ay);
    const a = hash01(ix, iy, seed);
    const b = hash01(ix + 1, iy, seed);
    const c = hash01(ix, iy + 1, seed);
    const d = hash01(ix + 1, iy + 1, seed);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0: number, e1: number, v: number): number => {
    const t = clamp01((v - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
};
const mix = (p: Rgb, q: Rgb, t: number): Rgb => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
];

// The picture's luminance (0-1, Rec. 709 weights on the stored values).
export function luminance(p: Picture): Float32Array {
    const out = new Float32Array(p.width * p.height);
    for (let i = 0, j = 0; j < out.length; i += 4, j++)
        out[j] = (0.0722 * p.bgra[i]! + 0.7152 * p.bgra[i + 1]! + 0.2126 * p.bgra[i + 2]!) / 255;
    return out;
}

// Levels: the values stretched so `black` of them are 0 and `white` of them 1 (a 1024-bin histogram).
export function autoLevels(values: Float32Array, black: number, white: number): Float32Array {
    const bins = new Uint32Array(1024);
    for (const v of values) bins[Math.min(1023, Math.max(0, Math.floor(v * 1023)))]! += 1;
    const n = values.length;
    let lo = 0;
    for (let acc = 0; lo < 1023 && acc + bins[lo]! <= n * black; lo++) acc += bins[lo]!;
    let hi = 1023;
    for (let acc = 0; hi > 0 && acc + bins[hi]! <= n * white; hi--) acc += bins[hi]!;
    const a = lo / 1023;
    const b = Math.max(hi / 1023, a + 1 / 64);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = clamp01((values[i]! - a) / (b - a));
    return out;
}

// The values' histogram equalised (each value -> its rank's share), mixed `amount` into the values: spreads a dark
// level's tones over the whole ramp.
export function equalise(values: Float32Array, amount: number): Float32Array {
    if (amount <= 0) return values;
    const bins = new Uint32Array(1024);
    for (const v of values) bins[Math.min(1023, Math.max(0, Math.floor(v * 1023)))]! += 1;
    const cdf = new Float32Array(1024);
    let acc = 0;
    for (let i = 0; i < 1024; i++) {
        acc += bins[i]!;
        cdf[i] = acc / values.length;
    }
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        out[i] = v + amount * (cdf[Math.min(1023, Math.max(0, Math.floor(v * 1023)))]! - v);
    }
    return out;
}

// A box blur of radius r (fractional: the edge weights), separable, edges clamped. Run twice ~ a gaussian.
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
    if (r <= 0) return Float32Array.from(src);
    const ri = Math.floor(r);
    const frac = r - ri;
    const norm = 1 / (2 * r + 1);
    const pass = (from: Float32Array, len: number, lines: number, stride: number, step: number): Float32Array => {
        const to = new Float32Array(from.length);
        for (let l = 0; l < lines; l++) {
            const base = l * stride;
            const at = (k: number): number => from[base + Math.min(len - 1, Math.max(0, k)) * step]!;
            for (let k = 0; k < len; k++) {
                let s = 0;
                for (let d = -ri; d <= ri; d++) s += at(k + d);
                if (frac > 0) s += frac * (at(k - ri - 1) + at(k + ri + 1));
                to[base + k * step] = s * norm;
            }
        }
        return to;
    };
    const across = pass(src, w, h, w, 1);
    return pass(across, h, w, 1, w);
}

// The picture as three float planes (0-1).
function planes(p: Picture): [Float32Array, Float32Array, Float32Array] {
    const n = p.width * p.height;
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) {
        b[j] = p.bgra[i]! / 255;
        g[j] = p.bgra[i + 1]! / 255;
        r[j] = p.bgra[i + 2]! / 255;
    }
    return [r, g, b];
}

// A halftone dot's ink (0-1) at (x, y): a screen of `period` turned by `angle` degrees, the dot's area `coverage` of
// its cell, anti-aliased over `aa` pixels.
export function halftone(x: number, y: number, period: number, angle: number, coverage: number, aa: number): number {
    if (coverage <= 0) return 0;
    if (coverage >= 1) return 1;
    const a = (angle * Math.PI) / 180;
    const u = (x * Math.cos(a) + y * Math.sin(a)) / period;
    const v = (-x * Math.sin(a) + y * Math.cos(a)) / period;
    const du = (u - Math.floor(u) - 0.5) * period;
    const dv = (v - Math.floor(v) - 0.5) * period;
    const dist = Math.sqrt(du * du + dv * dv);
    // (past half coverage the dots merge: the round dot grows to the cell's corners)
    const radius = period * Math.sqrt(coverage / Math.PI);
    return clamp01((radius - dist) / aa + 0.5);
}

// --- the styles -------------------------------------------------------------------------------------------------------

// Paper grain: fibres (value noise at a few pixels) and a fine tooth, as a multiplier around 1.
function paper(x: number, y: number, k: number, strength: number, seed: number): number {
    const fibre = valueNoise(x, y * 0.35, 3 * k, seed) - 0.5;
    const tooth = hash01(Math.floor(x / Math.max(1, k * 0.7)), Math.floor(y / Math.max(1, k * 0.7)), seed + 1) - 0.5;
    return 1 + strength * (0.9 * fibre + 0.6 * tooth);
}

function duotone(p: Picture, s: DuotoneParams, colour: Rgb): Picture {
    const { width: w, height: h } = p;
    const k = w / ART_W;
    const t = equalise(autoLevels(luminance(p), s.black, s.white), s.equalise);
    const out = Buffer.alloc(w * h * 4);
    const aa = Math.max(1, k * 0.8);
    const period = s.period * k;
    const light = mix(colour, PAPER, 0.55);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const v = t[i]! ** s.gamma;
            // the ramp ink -> colour -> paper
            let c = v < s.mid ? mix(INK, colour, v / s.mid) : mix(colour, light, (v - s.mid) / (1 - s.mid));
            // black dots over the shadows, paper dots breaking up the light
            const inkCover = s.inkMax * smoothstep(s.inkFrom, 0, v);
            const ink = halftone(x, y, period, 45, inkCover, aa);
            c = mix(c, INK, ink);
            const paperCover = 0.8 * smoothstep(s.colourFrom, 1, v);
            const dot = halftone(x, y, period * 0.9, 15, paperCover, aa);
            c = mix(c, PAPER, dot);
            const g = paper(x, y, k, s.grain, s.seed);
            out[i * 4] = Math.round(clamp01((c[2] / 255) * g) * 255);
            out[i * 4 + 1] = Math.round(clamp01((c[1] / 255) * g) * 255);
            out[i * 4 + 2] = Math.round(clamp01((c[0] / 255) * g) * 255);
            out[i * 4 + 3] = 255;
        }
    return { width: w, height: h, bgra: out };
}

function screenprint(p: Picture, s: ScreenprintParams, colour: Rgb): Picture {
    const { width: w, height: h } = p;
    const k = w / ART_W;
    const lum = equalise(autoLevels(luminance(p), s.black, s.white), s.equalise);
    const flat = boxBlur(boxBlur(lum, w, h, s.blur * k), w, h, s.blur * k);
    // edges: the gradient of a lightly blurred tone (Sobel), then thickened a little
    const soft = boxBlur(lum, w, h, s.edgeBlur * k);
    const edges = new Float32Array(w * h);
    const at = (x: number, y: number): number =>
        soft[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const gx =
                at(x + 1, y - 1) +
                2 * at(x + 1, y) +
                at(x + 1, y + 1) -
                at(x - 1, y - 1) -
                2 * at(x - 1, y) -
                at(x - 1, y + 1);
            const gy =
                at(x - 1, y + 1) +
                2 * at(x, y + 1) +
                at(x + 1, y + 1) -
                at(x - 1, y - 1) -
                2 * at(x, y - 1) -
                at(x + 1, y - 1);
            // (per 640-wide pixel: the HD picture's gradients are k times flatter)
            edges[y * w + x] = (Math.sqrt(gx * gx + gy * gy) / 4) * k;
        }
    const line = boxBlur(edges, w, h, 0.6 * k);
    const dark = mix(INK, colour, s.darkColour);
    const inks: Rgb[] = [INK, dark, colour, PAPER];
    const ox = Math.round(s.offset[0] * k);
    const oy = Math.round(s.offset[1] * k);
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            // the colour layers printed a little off register
            const j = Math.min(h - 1, Math.max(0, y - oy)) * w + Math.min(w - 1, Math.max(0, x - ox));
            const v = flat[j]!;
            const level = v < s.levels[0] ? 0 : v < s.levels[1] ? 1 : v < s.levels[2] ? 2 : 3;
            let c = inks[level]!;
            const outline = smoothstep(s.edge * 0.7, s.edge * 1.3, line[i]!);
            c = mix(c, INK, outline);
            const g = paper(x, y, k, s.grain, s.seed);
            out[i * 4] = Math.round(clamp01((c[2] / 255) * g) * 255);
            out[i * 4 + 1] = Math.round(clamp01((c[1] / 255) * g) * 255);
            out[i * 4 + 2] = Math.round(clamp01((c[0] / 255) * g) * 255);
            out[i * 4 + 3] = 255;
        }
    return { width: w, height: h, bgra: out };
}

function graded(p: Picture, s: GradedParams, colour: Rgb): Picture {
    const { width: w, height: h } = p;
    const k = w / ART_W;
    const [r, g, b] = planes(p);
    const lum = luminance(p);
    const t = equalise(autoLevels(lum, s.black, s.white), s.equalise);
    const shadow = mix(INK, colour, 0.5);
    const highlight = PAPER;
    const out = Buffer.alloc(w * h * 4);
    const cell = Math.max(1, s.grainSize * k);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const l0 = lum[i]!;
            const l = t[i]!;
            // S-curve
            const curved = l + s.contrast * (smoothstep(0, 1, l) - l) * 2;
            const v = clamp01(curved);
            // the photo desaturated around its levelled tone
            const scale = l0 > 1e-4 ? v / l0 : 0;
            const photo: Rgb = [
                255 * clamp01(v + s.saturation * (r[i]! * scale - v)),
                255 * clamp01(v + s.saturation * (g[i]! * scale - v)),
                255 * clamp01(v + s.saturation * (b[i]! * scale - v)),
            ];
            // split tone: towards the dark colour in the shadows, the paper in the light
            const tone = mix(shadow, highlight, v);
            let c = mix(photo, tone, s.tint);
            // vignette
            const dx = (x + 0.5) / w - 0.5;
            const dy = (y + 0.5) / h - 0.5;
            const vig = 1 - s.vignette * smoothstep(0.25, 0.75, Math.sqrt(dx * dx + dy * dy) * 1.25);
            // film grain (three hashes summed ~ a bell), stronger in the mid tones
            const n =
                hash01(Math.floor(x / cell), Math.floor(y / cell), s.seed) +
                hash01(Math.floor(x / cell), Math.floor(y / cell), s.seed + 1) +
                hash01(Math.floor(x / cell), Math.floor(y / cell), s.seed + 2) -
                1.5;
            const grain = s.grain * n * (1 - Math.abs(v - 0.5)) * 255;
            c = [c[0] * vig + grain, c[1] * vig + grain, c[2] * vig + grain];
            out[i * 4] = Math.round(Math.min(255, Math.max(0, c[2])));
            out[i * 4 + 1] = Math.round(Math.min(255, Math.max(0, c[1])));
            out[i * 4 + 2] = Math.round(Math.min(255, Math.max(0, c[0])));
            out[i * 4 + 3] = 255;
        }
    return { width: w, height: h, bgra: out };
}

// A style applied to a picture in the game's colour.
export function applyStyle(p: Picture, params: StyleParams, colour: string): Picture {
    const c = hex(colour);
    if (params.kind === "duotone") return duotone(p, params, c);
    if (params.kind === "screenprint") return screenprint(p, params, c);
    return graded(p, params, c);
}

// The capture cut to 16:9 (centred) and sized w x h.
export function fitCapture(p: Picture, w: number, h: number): Picture {
    const want = w / h;
    let cw = p.width;
    let ch = p.height;
    if (cw / ch > want) cw = Math.round(ch * want);
    else ch = Math.round(cw / want);
    let cut = p;
    if (cw !== p.width || ch !== p.height) {
        const x0 = Math.floor((p.width - cw) / 2);
        const y0 = Math.floor((p.height - ch) / 2);
        const bgra = Buffer.alloc(cw * ch * 4);
        for (let y = 0; y < ch; y++)
            p.bgra.copy(bgra, y * cw * 4, ((y + y0) * p.width + x0) * 4, ((y + y0) * p.width + x0 + cw) * 4);
        cut = { width: cw, height: ch, bgra };
    }
    return resize(cut, w, h);
}

// One level's art from its capture: the HD picture (the style at 2560 x 1440) and the native one (that, averaged down
// to 640 x 360 - the same look), and their image files.
export function levelArt(
    capture: Picture,
    style: StyleParams,
    colour: string,
): { hd: Picture; native: Picture; nativeFile: Buffer; hdFile: Buffer } {
    const hd = applyStyle(fitCapture(capture, ART_W * HD_SCALE, ART_H * HD_SCALE), style, colour);
    const native = resize(hd, ART_W, ART_H);
    const original = { tw: ART_W, th: ART_H, iw: ART_W, ih: ART_H, bgra: Buffer.alloc(0) };
    return { hd, native, nativeFile: nativeImg(native), hdFile: encodeImg(original, hd.bgra, HD_SCALE, true) };
}

// --- for make_menu_level --------------------------------------------------------------------------------------------

export const spotsFile = (game: string): string => path.join(import.meta.dirname, "scenic_art", `${game}.json`);

export interface BuiltScenicArt {
    images: Map<string, Buffer>; // art name -> images\<name>.img.xbx (640 x 360)
    hd: Map<string, Buffer>; // images\<name>.img.xbx (relative) -> the HD file (x4, for hd_ui)
    art: Map<string, string>; // load script (lower case) -> art name
    lines: string[];
}

// The scenic art of `game`'s levels in `loads` (lower-case load scripts) that have a chosen capture in the cache.
// `artName` names the picture (frontend_art.ts frontArtName). Levels without one are left out (they keep their crop).
export function buildScenicArt(
    game: string,
    loads: ReadonlySet<string> | null, // (null: every level of the spots file - THUG2's own, which Levels.qb lists itself)
    style: Style,
    artName: (load: string) => string,
): BuiltScenicArt {
    const built: BuiltScenicArt = { images: new Map(), hd: new Map(), art: new Map(), lines: [] };
    const file = spotsFile(game);
    if (!fs.existsSync(file)) return built;
    const spots = readSpots(file);
    const missing: string[] = [];
    let made = 0;
    for (const [level, entry] of Object.entries(spots.levels).sort(([a], [b]) => (a < b ? -1 : 1))) {
        const load = (entry.load ?? `load_${level}`).toLowerCase();
        if ((loads !== null && !loads.has(load)) || entry.chosen === undefined) continue;
        const shot = capturePath(game, level, entry.chosen);
        if (!fs.existsSync(shot)) {
            missing.push(level);
            continue;
        }
        const art = levelArt(readPng(fs.readFileSync(shot)), STYLES[style], GAME_COLOURS[game] ?? "#C9CBD0");
        const name = artName(load);
        built.images.set(name, art.nativeFile);
        built.hd.set(path.join("images", `${name}.img.xbx`), art.hdFile);
        built.art.set(load, name);
        made += 1;
    }
    built.lines.push(
        `${game}: ${made} scenic pictures (style ${style}, ${STYLE_NAMES[style]})` +
            (missing.length
                ? `; no capture in the cache for ${missing.join(", ")} (scenic_capture.ts): their crops kept`
                : ""),
    );
    return built;
}

// --- contact sheets -------------------------------------------------------------------------------------------------

// A 5 x 7 pixel font for the sheets' labels (A-Z, 0-9, a few signs).
const FONT: Readonly<Record<string, string>> = {
    A: "01110100011000111111100011000110001",
    B: "11110100011000111110100011000111110",
    C: "01110100011000010000100001000101110",
    D: "11110100011000110001100011000111110",
    E: "11111100001000011110100001000011111",
    F: "11111100001000011110100001000010000",
    G: "01110100011000010111100011000101111",
    H: "10001100011000111111100011000110001",
    I: "01110001000010000100001000010001110",
    J: "00111000100001000010000101001001100",
    K: "10001100101010011000101001001010001",
    L: "10000100001000010000100001000011111",
    M: "10001110111010110101100011000110001",
    N: "10001100011100110101100111000110001",
    O: "01110100011000110001100011000101110",
    P: "11110100011000111110100001000010000",
    Q: "01110100011000110001101011001001101",
    R: "11110100011000111110101001001010001",
    S: "01111100001000001110000010000111110",
    T: "11111001000010000100001000010000100",
    U: "10001100011000110001100011000101110",
    V: "10001100011000110001100010101000100",
    W: "10001100011000110101101011010101010",
    X: "10001100010101000100010101000110001",
    Y: "10001100010101000100001000010000100",
    Z: "11111000010001000100010001000011111",
    "0": "01110100011001110101110011000101110",
    "1": "00100011000010000100001000010001110",
    "2": "01110100010000100010001000100011111",
    "3": "11111000100010000010000011000101110",
    "4": "00010001100101010010111110001000010",
    "5": "11111100001111000001000011000101110",
    "6": "00110010001000011110100011000101110",
    "7": "11111000010001000100010000100001000",
    "8": "01110100011000101110100011000101110",
    "9": "01110100011000101111000010001001100",
    "#": "01010010101111101010111110101001010",
    _: "00000000000000000000000000000011111",
    "-": "00000000000000011111000000000000000",
    ".": "00000000000000000000000000110001100",
    " ": "00000000000000000000000000000000000",
};

function drawText(sheet: Picture, text: string, x: number, y: number, scale: number, colour: Rgb): void {
    let cx = x;
    for (const ch of text.toUpperCase()) {
        const glyph = FONT[ch] ?? FONT[" "]!;
        for (let gy = 0; gy < 7; gy++)
            for (let gx = 0; gx < 5; gx++) {
                if (glyph[gy * 5 + gx] !== "1") continue;
                for (let sy = 0; sy < scale; sy++)
                    for (let sx = 0; sx < scale; sx++) {
                        const px = cx + gx * scale + sx;
                        const py = y + gy * scale + sy;
                        if (px < 0 || py < 0 || px >= sheet.width || py >= sheet.height) continue;
                        const o = (py * sheet.width + px) * 4;
                        sheet.bgra[o] = colour[2];
                        sheet.bgra[o + 1] = colour[1];
                        sheet.bgra[o + 2] = colour[0];
                    }
            }
        cx += 6 * scale;
    }
}

// Tiles (each w x h with a label under it) in `columns` on the ink ground.
export function contactSheet(
    tiles: readonly { picture: Picture; label: string }[],
    columns: number,
    w = ART_W,
    h = ART_H,
): Picture {
    const gap = 12;
    const labelH = 26;
    const rows = Math.ceil(tiles.length / columns);
    const width = columns * w + (columns + 1) * gap;
    const height = rows * (h + labelH) + (rows + 1) * gap;
    const bgra = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) bgra.set([INK[2], INK[1], INK[0], 255], i * 4);
    const sheet = { width, height, bgra };
    tiles.forEach((tile, n) => {
        const x0 = gap + (n % columns) * (w + gap);
        const y0 = gap + Math.floor(n / columns) * (h + labelH + gap);
        const pic =
            tile.picture.width === w && tile.picture.height === h ? tile.picture : fitCapture(tile.picture, w, h);
        for (let y = 0; y < h; y++) pic.bgra.copy(bgra, ((y0 + y) * width + x0) * 4, y * w * 4, (y + 1) * w * 4);
        drawText(sheet, tile.label, x0, y0 + h + 6, 2, PAPER);
    });
    return sheet;
}

function sheets(spots: SpotsFile, out: string): string[] {
    const written: string[] = [];
    const colour = GAME_COLOURS[spots.game] ?? "#C9CBD0";
    const chosen: { level: string; picture: Picture }[] = [];
    for (const [level, entry] of Object.entries(spots.levels)) {
        const tiles: { picture: Picture; label: string }[] = [];
        for (const c of entry.candidates) {
            const file = capturePath(spots.game, level, c.id);
            if (!fs.existsSync(file)) continue;
            const pic = readPng(fs.readFileSync(file));
            const mark = entry.chosen === c.id ? " CHOSEN" : "";
            tiles.push({
                picture: resize(fitCapture(pic, 1280, 720), ART_W, ART_H),
                label: `${level} #${c.id} score ${c.score.score.toFixed(2)}${mark}`,
            });
            if (entry.chosen === c.id) chosen.push({ level, picture: pic });
        }
        if (!tiles.length) continue;
        const file = path.join(out, `candidates_${spots.game}_${level}.png`);
        fs.writeFileSync(file, toPng(contactSheet(tiles, 3)));
        written.push(file);
    }
    for (const style of Object.keys(STYLES) as Style[]) {
        const tiles = chosen.map(({ level, picture }) => ({
            picture: levelArt(picture, STYLES[style], colour).native,
            label: level,
        }));
        if (!tiles.length) continue;
        const file = path.join(out, `style_${style}_${spots.game}.png`);
        fs.writeFileSync(file, toPng(contactSheet(tiles, 4)));
        written.push(file);
        // one full-size example per style, to judge the HD picture
        const first = chosen[0]!;
        const big = path.join(out, `style_${style}_${spots.game}_${first.level}_hd.png`);
        fs.writeFileSync(big, toPng(levelArt(first.picture, STYLES[style], colour).hd));
        written.push(big);
    }
    const raw = chosen.map(({ level, picture }) => ({
        picture: resize(fitCapture(picture, 1280, 720), ART_W, ART_H),
        label: level,
    }));
    if (raw.length) {
        const file = path.join(out, `chosen_${spots.game}_raw.png`);
        fs.writeFileSync(file, toPng(contactSheet(raw, 4)));
        written.push(file);
    }
    return written;
}

const USAGE = "usage: scenic_art.ts sheets <out folder> | check [--game thps3] [--spots <json>]";

function main(): number {
    const { values, positionals } = parseCli(USAGE, {
        options: { game: { type: "string", default: "thps3" }, spots: { type: "string" } },
        allowPositionals: true,
    });
    const spots = readSpots(values.spots ?? spotsFile(values.game));
    if (positionals[0] === "sheets" && positionals[1]) {
        fs.mkdirSync(positionals[1], { recursive: true });
        for (const file of sheets(spots, positionals[1])) print(file);
        return 0;
    }
    if (positionals[0] === "check") {
        let missing = 0;
        for (const [level, entry] of Object.entries(spots.levels)) {
            const ok = entry.chosen !== undefined && fs.existsSync(capturePath(spots.game, level, entry.chosen));
            if (!ok) missing += 1;
            print(
                `${level}: ${entry.chosen === undefined ? "none chosen" : ok ? `#${entry.chosen}` : `#${entry.chosen} NOT CAPTURED`}`,
            );
        }
        return missing ? 1 : 0;
    }
    print(USAGE);
    return 2;
}

if (isMain(import.meta.url)) await runMain(() => main());
