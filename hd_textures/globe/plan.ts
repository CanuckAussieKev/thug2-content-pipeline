// NOT ORIGINAL - draws a level's top-down plan in the level select globe's own style (redraw.ts): the level's footprint
// (triangles seen from above, from its collision) is the "land": a dark outline (two shades), a bright green rim and
// the body in low-poly patches of three greens, on the globe's ocean blue - a map of the level in place of the globe
// for levels with no place on Earth (tools/pipeline/menu_level/level_map.ts).
//
// The picture is a PLAN_SIZE square (the globe window is round: the footprint is fitted inside a circle of PLAN_RADIUS
// pixels, so the window's round mask never cuts it). All sizes below are in 1x pixels; `scale` multiplies the output
// (4 = the HD UI's 1024 px image), and each output pixel averages ss x ss samples. The same code draws both sizes,
// so the HD image is the native one sharper, not another drawing.

import { distanceTo, fillMask, type PixelPolygon, type XY } from "./raster.ts";
import { PALETTE } from "./redraw.ts";

export const PLAN_SIZE = 256;
export const PLAN_RADIUS = 112;

export interface PlanFit {
    cx: number; // the world point at the picture's middle
    cz: number;
    k: number; // 1x pixels per world unit
}

// A footprint: triangles as x0, z0, x1, z1, x2, z2 (world units; y is up and left out).
export type PlanTriangles = Float32Array;

// The fit that puts the footprint in the circle: its bounding box's middle in the picture's middle, scaled so the
// farthest vertex lands `radius` pixels out.
export function fitPlan(tris: PlanTriangles, radius = PLAN_RADIUS): PlanFit {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < tris.length; i += 2) {
        const x = tris[i]!;
        const z = tris[i + 1]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    if (!(maxX >= minX)) return { cx: 0, cz: 0, k: 1 };
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    let far = 0;
    for (let i = 0; i < tris.length; i += 2) far = Math.max(far, Math.hypot(tris[i]! - cx, tris[i + 1]! - cz));
    return { cx, cz, k: far > 0 ? radius / far : 1 };
}

// A world point in the picture's 1x pixels (y down; the world's +z is up the picture).
export function planPoint(fit: PlanFit, x: number, z: number): [number, number] {
    return [PLAN_SIZE / 2 + (x - fit.cx) * fit.k, PLAN_SIZE / 2 - (z - fit.cz) * fit.k];
}

export interface PlanOptions {
    scale: number; // 1 = PLAN_SIZE px, 4 = 1024 px
    supersample: number; // samples per output pixel side
    closing: number; // footprint gaps up to twice this are closed (1x px)
    smoothing: number; // the outline's rounding (1x px)
    minIsland: number; // smallest land piece kept (1x px^2)
    minHole: number; // smallest hole kept (1x px^2)
    grow: number; // the outline's outer edge outside the footprint (1x px)
    seed: number; // the patches' pattern
}

export function defaultPlan(scale = 1, seed = 0): PlanOptions {
    return {
        scale,
        supersample: scale >= 4 ? 2 : 4,
        closing: 1.4,
        smoothing: 1.1,
        minIsland: 7,
        minHole: 9,
        grow: 0.8,
        seed,
    };
}

const hash = (a: number, b: number, c: number): number => {
    let h =
        Math.imul(a + 0x9e3779b1, 0x85ebca6b) ^
        Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^
        Math.imul(c + 0x1234567, 0x27d4eb2f);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
};

// The body's patches (the globe's low-poly facets): a jittered triangle mesh over the picture, each triangle one of
// three greens (0 light, 1 mid, 2 dark), at u samples per 1x pixel.
const MESH = 9;
function toneMap(w: number, seed: number): Uint8Array {
    const tone = new Uint8Array(w * w);
    const cell = PLAN_SIZE / MESH;
    const k = w / PLAN_SIZE;
    const vertex = (i: number, j: number): XY => [
        (i + (i <= 0 || i >= MESH ? 0 : (hash(i, j, seed + 1) - 0.5) * 0.7)) * cell,
        (j + (j <= 0 || j >= MESH ? 0 : (hash(i, j, seed + 2) - 0.5) * 0.7)) * cell,
    ];
    const fill = (a: XY, b: XY, c: XY, value: number): void => {
        const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) * k));
        const x1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], c[0]) * k));
        const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) * k));
        const y1 = Math.min(w - 1, Math.ceil(Math.max(a[1], b[1], c[1]) * k));
        const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++) {
                const px = (x + 0.5) / k;
                const py = (y + 0.5) / k;
                const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / d;
                const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / d;
                if (l1 >= 0 && l2 >= 0 && 1 - l1 - l2 >= 0) tone[y * w + x] = value;
            }
    };
    const pick = (i: number, j: number, n: number): number => {
        const r = hash(i, j, seed + 10 + n);
        return r < 0.45 ? 0 : r < 0.72 ? 1 : 2;
    };
    for (let j = 0; j < MESH; j++)
        for (let i = 0; i < MESH; i++) {
            const p00 = vertex(i, j);
            const p10 = vertex(i + 1, j);
            const p01 = vertex(i, j + 1);
            const p11 = vertex(i + 1, j + 1);
            if (hash(i, j, seed + 3) < 0.5) {
                fill(p00, p10, p11, pick(i, j, 0));
                fill(p00, p11, p01, pick(i, j, 1));
            } else {
                fill(p00, p10, p01, pick(i, j, 0));
                fill(p10, p11, p01, pick(i, j, 1));
            }
        }
    return tone;
}

// `mask` grown (r > 0) by r samples, or shrunk by -r.
function offset(mask: Uint8Array, w: number, r: number): Uint8Array {
    const out = new Uint8Array(mask.length);
    if (r >= 0) {
        const d = distanceTo(mask, w, w, false);
        for (let i = 0; i < out.length; i++) out[i] = d[i]! <= r ? 1 : 0;
    } else {
        const inverse = new Uint8Array(mask.length);
        for (let i = 0; i < mask.length; i++) inverse[i] = mask[i] ? 0 : 1;
        // (the picture's border is not "outside": the footprint never reaches it)
        const d = distanceTo(inverse, w, w, false);
        for (let i = 0; i < out.length; i++) out[i] = d[i]! > -r ? 1 : 0;
    }
    return out;
}

// A box blur of a w x w field, `r` samples each side, twice.
function blur(field: Float32Array, w: number, r: number): void {
    const line = new Float32Array(w);
    const pass = (vertical: boolean): void => {
        for (let a = 0; a < w; a++) {
            let sum = 0;
            let count = 0;
            const at = (b: number): number => (vertical ? b * w + a : a * w + b);
            for (let b = 0; b < Math.min(w, r + 1); b++) {
                sum += field[at(b)]!;
                count++;
            }
            for (let b = 0; b < w; b++) {
                line[b] = sum / count;
                const add = b + r + 1;
                const drop = b - r;
                if (add < w) {
                    sum += field[at(add)]!;
                    count++;
                }
                if (drop >= 0) {
                    sum -= field[at(drop)]!;
                    count--;
                }
            }
            for (let b = 0; b < w; b++) field[at(b)] = line[b]!;
        }
    };
    for (let n = 0; n < 2; n++) {
        pass(false);
        pass(true);
    }
}

// Components of `mask` value `value` smaller than `limit` samples flip to the other value (not the ones touching the
// border when `keepBorder`).
function dropSmall(mask: Uint8Array, w: number, value: number, limit: number, keepBorder: boolean): void {
    const seen = new Uint8Array(mask.length);
    const stack: number[] = [];
    const members: number[] = [];
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] !== value || seen[start]) continue;
        stack.length = 0;
        members.length = 0;
        stack.push(start);
        seen[start] = 1;
        let border = false;
        while (stack.length) {
            const i = stack.pop()!;
            members.push(i);
            const x = i % w;
            const y = (i - x) / w;
            if (x === 0 || y === 0 || x === w - 1 || y === w - 1) border = true;
            for (const [dx, dy] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ] as const) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= w) continue;
                const n = ny * w + nx;
                if (mask[n] === value && !seen[n]) {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
        }
        if (members.length < limit && !(keepBorder && border)) for (const i of members) mask[i] = 1 - value;
    }
}

type Rgb = readonly [number, number, number];

// The footprint's mask: the triangles filled, gaps closed, the outline rounded, specks and pin holes dropped.
export function footprintMask(tris: PlanTriangles, fit: PlanFit, o: PlanOptions): Uint8Array {
    const u = o.scale * o.supersample;
    const w = PLAN_SIZE * u;
    const polygons: PixelPolygon[] = [];
    const s = fit.k * u;
    for (let i = 0; i + 5 < tris.length; i += 6) {
        const p = (j: number): XY => [w / 2 + (tris[i + j]! - fit.cx) * s, w / 2 - (tris[i + j + 1]! - fit.cz) * s];
        polygons.push([[p(0), p(2), p(4)]]);
    }
    let mask: Uint8Array = fillMask(polygons, w, w, false);
    polygons.length = 0;
    const close = Math.round(o.closing * u);
    if (close > 0) mask = offset(offset(mask, w, close), w, -close);
    // rounded: the signed distance blurred, then cut at zero
    const inside = distanceTo(
        mask.map((v) => 1 - v),
        w,
        w,
        false,
    );
    const outside = distanceTo(mask, w, w, false);
    const field = new Float32Array(mask.length);
    for (let i = 0; i < field.length; i++) field[i] = mask[i] ? inside[i]! - 0.5 : -(outside[i]! - 0.5);
    blur(field, w, Math.max(1, Math.round(o.smoothing * u)));
    for (let i = 0; i < field.length; i++) mask[i] = field[i]! > 0 ? 1 : 0;
    dropSmall(mask, w, 1, o.minIsland * u * u, false);
    dropSmall(mask, w, 0, o.minHole * u * u, true);
    return mask;
}

// The plan: (PLAN_SIZE * scale) square BGRA.
export function renderPlan(tris: PlanTriangles, fit: PlanFit, o: PlanOptions = defaultPlan()): Buffer {
    const ss = o.supersample;
    const u = o.scale * ss;
    const w = PLAN_SIZE * u;
    const mask = footprintMask(tris, fit, o);
    const ocean = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) ocean[i] = mask[i] ? 0 : 1;
    const din = distanceTo(ocean, w, w, false);
    const dout = distanceTo(mask, w, w, false);
    const tone = toneMap(w, o.seed);
    const bodies: Rgb[] = [PALETTE.bodyLight, PALETTE.bodyMid, PALETTE.bodyDark];
    const growSamples = o.grow * u;
    const colourAt = (i: number): Rgb => {
        const t = mask[i] ? din[i]! - 0.5 + growSamples : growSamples - (dout[i]! - 0.5);
        if (t < 0) return PALETTE.ocean;
        const b = t / u;
        if (b < 1) return PALETTE.outer;
        if (b < 2) return PALETTE.outline;
        if (b < 3) return PALETTE.rim;
        if (b < 4) return PALETTE.rimBright;
        if (b < 6) return PALETTE.rim;
        return bodies[tone[i]!]!;
    };
    const size = PLAN_SIZE * o.scale;
    const out = Buffer.alloc(size * size * 4);
    const n = ss * ss;
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let sy = 0; sy < ss; sy++)
                for (let sx = 0; sx < ss; sx++) {
                    const c = colourAt((y * ss + sy) * w + x * ss + sx);
                    r += c[0];
                    g += c[1];
                    b += c[2];
                }
            const at = (y * size + x) * 4;
            out[at] = Math.round(b / n);
            out[at + 1] = Math.round(g / n);
            out[at + 2] = Math.round(r / n);
            out[at + 3] = 255;
        }
    return out;
}
