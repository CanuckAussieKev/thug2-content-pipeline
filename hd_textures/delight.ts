// NOT ORIGINAL - de-lighting the base game's textures before they are upscaled (base.ts --delight): the 2004 colour
// maps have light painted into them - broad shading across a wall, a darker floor round its edges, highlights, a
// gradient across a tile - which the Vulkan renderer's own lighting (ray-traced sun, occlusion, bounce, per-pixel
// shading) then lights a second time. This takes the painted light out at the original resolution, per texture,
// before the model sees it: the HD set is made from clean surface colour, and core's matchOriginal pulls the model's
// output back to the DE-LIT texels (any shading the model puts back is removed with the rest of the low frequencies).
//
// The method - a classical intrinsic decomposition (no model, deterministic: the same texels give the same bytes):
// - the luminance of the linearised colour (sRGB as 2.2, Rec. 709) in log space, l = ln(L + 0.01) (the
//   0.01: near-black texels' noise doesn't swamp the steps);
// - shading = the broad part of l rebuilt from its small gradients only (gradient-domain Retinex, Horn 1974 / Blake
//   1985): each step between neighbouring texels is kept when it is soft - |d l| under 0.1 and the log chromaticity
//   (ln R/L, ln B/L) changing under 0.06, or no more than three times the typical step round it (the mean over 9 x 9
//   texels: a grainy surface's steps are all large and add up to nothing) - and taken as 0 when it is hard (a colour
//   edge, paint, a sign's letters, mortar, a plank's gap: surface, never shading); the kept steps are summed along the lines between the centres of
//   a coarse grid's cells (a sixteenth of the shorter side each) and the cells' values solved for in least squares
//   (conjugate gradients on the grid's weighted Laplacian), then spread back bilinearly. A plateau with a sharp border
//   is surface colour; a soft change of brightness at the same colour is light. Fine grain integrates to nothing at the
//   cells' scale and stays in the colour;
// - transparent texels (alpha <= 8) take no part and their bytes are left exactly as they were - a cut-out's alpha and colour under the holes untouched; a step touching
//   one counts for nothing;
// - a wrapped axis makes the grid periodic (the step from the last texel to the first is one of its steps; the cells'
//   values and their bilinear spread wrap round), so the shading - and the de-lit texture - stays seamless; a clamped
//   axis (an atlas region's) uses its own texels only;
// - the shading made zero-mean (over the visible texels) and scaled by the strength k times its reliability (a Wiener
//   shrink: its variance against the chance wander of a cell's mean - the residual's variance over a cell's texels,
//   x4 - so a speckled, grated or randomly tiled texture's cell means aren't taken for light), bounded to a factor of
//   `limit` (2) either way - real surface variation at the scale of the whole texture (a two-tone wall) is mostly
//   kept: only k of it goes, never more than a factor of two;
// - each texel's linear RGB divided by exp(k s) - a luminance factor, so the chroma is kept - and clipped back into
//   range by its largest channel (hue kept); back to sRGB.
// The strength k comes from the meshes using the texture (faceOrientations): a texture on faces of one direction
// (a floor, one wall) can hold that direction's baked light - removed at 0.85; one on faces of many directions (a
// crate, a pillar's sides, a prop) can't hold a consistent baked sun - its broad shading is painted occlusion and wear,
// partly the material's own character - removed at 0.5 (k = 0.5 + 0.35 x coherence, coherence = |sum of area x
// normal| / sum of area); a texture no mesh uses (or unknown) 0.65.
//
// What comes out: the de-lit texels and the shading layer (the natural log of the factor removed, per texel, 0 for
// the transparent ones) - kept as data: base.ts writes nothing of it into a set; the surface maps
// (tools/pbr_maps --delight) are made from the de-lit colour.
//
// What base.ts leaves as it is (leftAsItIs): skies' and models' dictionaries, soft alpha, textures no mesh beside them
// draws as a solid surface (added or modulated light, billboards).
//
// Atlases (atlas.ts' regions) are de-lit region by region (delightRegions): each region on its own texels, with its own
// wrap, so no picture's light reaches its neighbour; texels outside every region are left as they were.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as scn from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { sceneFiles } from "./atlas.ts";

// bumped whenever the step makes different texels from the same input (set.json records it per texture; base.ts's
// file cache and the game's settings key on it)
export const DELIGHT_VERSION = 1;

export interface DelightOptions {
    wrapU: boolean;
    wrapV: boolean;
    // the face-orientation coherence of the meshes using the texture (0: every direction - 1: one); null: unknown
    coherence?: number | null;
    strength?: number; // k itself (overrides the coherence's)
    cellFraction?: number; // the coarse grid's cell as a fraction of the shorter side (default 1/16)
    edgeLuma?: number; // a step of log luminance this large or more is surface, not light (default 0.1)
    edgeChroma?: number; // ... of log chromaticity (default 0.06)
    limit?: number; // the largest factor removed either way (default 2)
}

export interface DelightStats {
    strength: number; // k used (the coherence's, times the reliability)
    reliability: number; // how far the shading stands above chance (0 - 1)
    visible: number; // texels taking part
    shadingVariance: number; // the variance of the low-pass (log luminance) before
    shadingRemoved: number; // the fraction of it removed (0 - 1)
    lumaVariance: number; // the log luminance's variance before
    lumaVarianceAfter: number; // ... after
    meanChange: number; // the mean |byte change| over R, G, B of the visible texels (0 - 255)
    maxFactor: number; // the largest factor applied (>= 1: brightened or darkened by it)
    clipped: number; // the share of the visible texels whose factor reached the limit
    chromaShift: number; // the mean change of the chromaticity (r / (r+g+b), b / (r+g+b)), x 255
}

export interface DelightResult {
    bgra: Buffer;
    shading: Float32Array; // ln of the factor removed (the texel was divided by exp of it); 0 where untouched
    stats: DelightStats;
}

const EPS = 0.01;
const LUT = new Float32Array(256).map((_, i) => (i / 255) ** 2.2);
const toByte = (v: number): number => Math.max(0, Math.min(255, Math.round(Math.max(0, v) ** (1 / 2.2) * 255)));

export function strengthFor(coherence: number | null | undefined): number {
    if (coherence === null || coherence === undefined || !Number.isFinite(coherence)) return 0.65;
    return 0.5 + 0.35 * Math.max(0, Math.min(1, coherence));
}

// A box mean of radius r (separable; wrapping or clamped per axis).
function boxMean(src: Float32Array, w: number, h: number, r: number, wrapU: boolean, wrapV: boolean): Float32Array {
    const at = (v: number, n: number, wrap: boolean): number =>
        wrap ? ((v % n) + n) % n : Math.max(0, Math.min(n - 1, v));
    const mid = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let k = -r; k <= r; k++) s += src[y * w + at(x + k, w, wrapU)]!;
            mid[y * w + x] = s / (2 * r + 1);
        }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let k = -r; k <= r; k++) s += mid[at(y + k, h, wrapV) * w + x]!;
            out[y * w + x] = s / (2 * r + 1);
        }
    return out;
}

// Each texel's typical |step| (to its right and lower neighbours, visible pairs only) averaged over 9 x 9 texels:
// luminance and chromaticity (the larger of its two).
function localSteps(
    l: Float32Array,
    cr: Float32Array,
    cb: Float32Array,
    visible: Uint8Array,
    w: number,
    h: number,
    wrapU: boolean,
    wrapV: boolean,
): [Float32Array, Float32Array] {
    const sl = new Float32Array(w * h);
    const sc = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!visible[i]) continue;
            let nl = 0;
            let nc = 0;
            let count = 0;
            for (const [nx, ny] of [
                [x + 1, y],
                [x, y + 1],
            ] as const) {
                if ((nx >= w && !wrapU) || (ny >= h && !wrapV)) continue;
                const j = (ny % h) * w + (nx % w);
                if (!visible[j]) continue;
                nl += Math.abs(l[j]! - l[i]!);
                nc += Math.max(Math.abs(cr[j]! - cr[i]!), Math.abs(cb[j]! - cb[i]!));
                count++;
            }
            if (count) {
                sl[i] = nl / count;
                sc[i] = nc / count;
            }
        }
    return [boxMean(sl, w, h, 4, wrapU, wrapV), boxMean(sc, w, h, 4, wrapU, wrapV)];
}

// The broad shading (log luminance, per texel) from the soft steps of l only: the gradient-domain Retinex above.
// `cr`, `cb`: the log chromaticity; `visible`: the texels taking part.
export function retinexShading(
    l: Float32Array,
    cr: Float32Array,
    cb: Float32Array,
    visible: Uint8Array,
    w: number,
    h: number,
    options: { wrapU: boolean; wrapV: boolean; cell: number; edgeLuma: number; edgeChroma: number },
): Float32Array {
    // the typical step round each texel (the mean |step| over 9 x 9 texels), luminance and chromaticity: a step is
    // hard only when it also stands out from its neighbourhood's (3 x) - a grainy surface's steps are all large and
    // add up to nothing, so they are kept with the light they carry; an edge in a calm area stands out
    const [localL, localC] = localSteps(l, cr, cb, visible, w, h, options.wrapU, options.wrapV);
    const relative = 3;
    // the soft steps (0 for a hard one) and whether each step counts (both texels visible)
    const step = (i: number, j: number): [number, number] => {
        if (!visible[i] || !visible[j]) return [0, 0];
        const d = l[j]! - l[i]!;
        const c = Math.max(Math.abs(cr[j]! - cr[i]!), Math.abs(cb[j]! - cb[i]!));
        const hard =
            (Math.abs(d) >= options.edgeLuma && Math.abs(d) >= (relative * (localL[i]! + localL[j]!)) / 2) ||
            (c >= options.edgeChroma && c >= (relative * (localC[i]! + localC[j]!)) / 2);
        return [hard ? 0 : d, 1];
    };
    const cx = Math.max(1, Math.round(w / options.cell));
    const cy = Math.max(1, Math.round(h / options.cell));
    const edge = (n: number, cells: number, k: number): number => Math.floor((k * n) / cells);
    const centre = (n: number, cells: number, k: number): number =>
        Math.floor((edge(n, cells, k) + edge(n, cells, k + 1)) / 2);
    interface Link {
        a: number;
        b: number;
        g: number;
        weight: number;
    }
    const links: Link[] = [];
    // horizontal links: cell (X, Y) to (X + 1, Y) - the steps along each of the band's rows from one centre to the next
    const linksAlong = (horizontal: boolean): void => {
        const [n, m, cells, others, wrap] = horizontal ? [w, h, cx, cy, options.wrapU] : [h, w, cy, cx, options.wrapV];
        const count = wrap ? (cells > 1 ? cells : 0) : cells - 1;
        for (let other = 0; other < others; other++) {
            const from = edge(m, others, other);
            const to = edge(m, others, other + 1);
            for (let k = 0; k < count; k++) {
                const start = centre(n, cells, k);
                let end = centre(n, cells, (k + 1) % cells);
                if (end <= start) end += n;
                let sum = 0;
                let valid = 0;
                for (let line = from; line < to; line++)
                    for (let t = start; t < end; t++) {
                        const p = t % n;
                        const q = (t + 1) % n;
                        const [d, ok] = horizontal
                            ? step(line * w + p, line * w + q)
                            : step(p * w + line, q * w + line);
                        sum += d;
                        valid += ok;
                    }
                const total = (to - from) * (end - start);
                if (!valid) continue;
                const cellA = horizontal ? other * cx + k : k * cx + other;
                const cellB = horizontal ? other * cx + ((k + 1) % cells) : ((k + 1) % cells) * cx + other;
                // (the mean step per texel over the valid ones, times the distance: the hidden ones assumed alike)
                links.push({ a: cellA, b: cellB, g: (sum / valid) * (end - start), weight: valid / total });
            }
        }
    };
    linksAlong(true);
    linksAlong(false);
    // least squares: sum of weight (s_b - s_a - g)^2 + eps s^2, by conjugate gradients
    const N = cx * cy;
    const meanWeight = links.reduce((sum, link) => sum + link.weight, 0) / Math.max(1, links.length);
    const eps = 1e-4 * Math.max(meanWeight, 1e-6);
    const apply = (x: Float64Array, out: Float64Array): void => {
        for (let i = 0; i < N; i++) out[i] = eps * x[i]!;
        for (const link of links) {
            const d = link.weight * (x[link.b]! - x[link.a]!);
            out[link.b]! += d;
            out[link.a]! -= d;
        }
    };
    const rhs = new Float64Array(N);
    for (const link of links) {
        rhs[link.b]! += link.weight * link.g;
        rhs[link.a]! -= link.weight * link.g;
    }
    const x = new Float64Array(N);
    const r = Float64Array.from(rhs);
    const p = Float64Array.from(r);
    const ap = new Float64Array(N);
    let rr = r.reduce((sum, v) => sum + v * v, 0);
    const tolerance = 1e-12 * Math.max(1, rr);
    for (let it = 0; it < 4 * N + 50 && rr > tolerance; it++) {
        apply(p, ap);
        let pap = 0;
        for (let i = 0; i < N; i++) pap += p[i]! * ap[i]!;
        if (pap <= 0) break;
        const alpha = rr / pap;
        let next = 0;
        for (let i = 0; i < N; i++) {
            x[i]! += alpha * p[i]!;
            r[i]! -= alpha * ap[i]!;
            next += r[i]! * r[i]!;
        }
        const beta = next / rr;
        rr = next;
        for (let i = 0; i < N; i++) p[i] = r[i]! + beta * p[i]!;
    }
    // spread back: bilinear between the cells' centres (wrapping where the axis wraps)
    const out = new Float32Array(w * h);
    const axis = (v: number, n: number, cells: number, wrap: boolean): [number, number, number] => {
        const f = ((v + 0.5) * cells) / n - 0.5;
        if (wrap) {
            const a = Math.floor(f);
            return [((a % cells) + cells) % cells, (((a + 1) % cells) + cells) % cells, f - a];
        }
        const g = Math.max(0, Math.min(cells - 1, f));
        const a = Math.floor(g);
        return [a, Math.min(a + 1, cells - 1), g - a];
    };
    for (let y = 0; y < h; y++) {
        const [ya, yb, ty] = axis(y, h, cy, options.wrapV);
        for (let xx = 0; xx < w; xx++) {
            const [xa, xb, tx] = axis(xx, w, cx, options.wrapU);
            out[y * w + xx] =
                (x[ya * cx + xa]! * (1 - tx) + x[ya * cx + xb]! * tx) * (1 - ty) +
                (x[yb * cx + xa]! * (1 - tx) + x[yb * cx + xb]! * tx) * ty;
        }
    }
    return out;
}

const variance = (v: Float32Array, mask: Uint8Array): number => {
    let n = 0;
    let s = 0;
    for (let i = 0; i < v.length; i++)
        if (mask[i]) {
            s += v[i]!;
            n++;
        }
    if (!n) return 0;
    const mean = s / n;
    let q = 0;
    for (let i = 0; i < v.length; i++) if (mask[i]) q += (v[i]! - mean) ** 2;
    return q / n;
};

function emptyStats(strength: number): DelightStats {
    return {
        strength,
        reliability: 0,
        visible: 0,
        shadingVariance: 0,
        shadingRemoved: 0,
        lumaVariance: 0,
        lumaVarianceAfter: 0,
        meanChange: 0,
        maxFactor: 1,
        clipped: 0,
        chromaShift: 0,
    };
}

// One texture (or one atlas region) de-lit: BGRA in, BGRA out (alpha and transparent texels untouched).
export function delight(bgra: Uint8Array, w: number, h: number, options: DelightOptions): DelightResult {
    const k = options.strength ?? strengthFor(options.coherence);
    const limit = Math.log(Math.max(1, options.limit ?? 2));
    const n = w * h;
    const out = Buffer.from(bgra);
    const shading = new Float32Array(n);
    const visible = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) if (bgra[i * 4 + 3]! > 8) visible[i] = 1;
    for (let i = 0; i < n; i++) count += visible[i]!;
    let uniform = true;
    let first = -1;
    for (let i = 0; i < n && uniform; i++) {
        if (!visible[i]) continue;
        if (first < 0) first = i;
        else for (let c = 0; c < 3; c++) if (bgra[i * 4 + c] !== bgra[first * 4 + c]) uniform = false;
    }
    if (count === 0 || uniform || k <= 0 || w < 2 || h < 2) return { bgra: out, shading, stats: emptyStats(k) };

    // linear R, G, B (planes) and the log luminance
    const lin = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
        lin[0]![i] = LUT[bgra[i * 4 + 2]!]!;
        lin[1]![i] = LUT[bgra[i * 4 + 1]!]!;
        lin[2]![i] = LUT[bgra[i * 4]!]!;
    }
    const l = new Float32Array(n);
    const gr = new Float32Array(n);
    const gb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const L = 0.2126 * lin[0]![i]! + 0.7152 * lin[1]![i]! + 0.0722 * lin[2]![i]!;
        l[i] = Math.log(L + EPS);
        gr[i] = Math.log((lin[0]![i]! + EPS) / (L + EPS));
        gb[i] = Math.log((lin[2]![i]! + EPS) / (L + EPS));
    }

    const cell = Math.max(2, (options.cellFraction ?? 1 / 16) * Math.min(w, h));
    const low = retinexShading(l, gr, gb, visible, w, h, {
        wrapU: options.wrapU,
        wrapV: options.wrapV,
        cell,
        edgeLuma: options.edgeLuma ?? 0.1,
        edgeChroma: options.edgeChroma ?? 0.06,
    });

    // the zero-mean shading
    let mean = 0;
    for (let i = 0; i < n; i++) if (visible[i]) mean += low[i]!;
    mean /= count;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = visible[i] ? low[i]! - mean : 0;
    // how far it can be trusted (a Wiener shrink): the cells' means of a high-contrast pattern (speckle, a grate,
    // random tiles) wander by chance - by the residual's variance over a cell's texels; shading well above that
    // stays, shading at the level of that chance mostly goes back to the colour
    const residual = new Float32Array(n);
    for (let i = 0; i < n; i++) residual[i] = l[i]! - low[i]!;
    const signal = variance(s, visible);
    const chance = variance(residual, visible) / (cell * cell);
    const reliability = signal > 0 ? signal / (signal + 4 * chance) : 0;
    const kUsed = k * reliability;
    let maxFactor = 1;
    let clipped = 0;
    let change = 0;
    let chroma = 0;
    const lAfter = new Float32Array(n);
    const sAfter = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        if (!visible[i]) continue;
        const r = Math.max(-limit, Math.min(limit, kUsed * s[i]!));
        shading[i] = r;
        if (Math.abs(r) >= limit - 1e-6) clipped++;
        maxFactor = Math.max(maxFactor, Math.exp(Math.abs(r)));
        const f = Math.exp(-r);
        let R = LUT[bgra[i * 4 + 2]!]! * f;
        let G = LUT[bgra[i * 4 + 1]!]! * f;
        let B = LUT[bgra[i * 4]!]! * f;
        const top = Math.max(R, G, B);
        if (top > 1) {
            R /= top;
            G /= top;
            B /= top;
        }
        const ob = [bgra[i * 4]!, bgra[i * 4 + 1]!, bgra[i * 4 + 2]!];
        out[i * 4] = toByte(B);
        out[i * 4 + 1] = toByte(G);
        out[i * 4 + 2] = toByte(R);
        change +=
            Math.abs(out[i * 4]! - ob[0]!) + Math.abs(out[i * 4 + 1]! - ob[1]!) + Math.abs(out[i * 4 + 2]! - ob[2]!);
        const sum0 = ob[0]! + ob[1]! + ob[2]! || 1;
        const sum1 = out[i * 4]! + out[i * 4 + 1]! + out[i * 4 + 2]! || 1;
        chroma +=
            Math.abs(ob[2]! / sum0 - out[i * 4 + 2]! / sum1) * 255 + Math.abs(ob[0]! / sum0 - out[i * 4]! / sum1) * 255;
        lAfter[i] = l[i]! - r;
        sAfter[i] = s[i]! - r;
    }
    const shadingVariance = variance(s, visible);
    return {
        bgra: out,
        shading,
        stats: {
            strength: kUsed,
            reliability,
            visible: count,
            shadingVariance,
            shadingRemoved: shadingVariance > 1e-9 ? 1 - variance(sAfter, visible) / shadingVariance : 0,
            lumaVariance: variance(l, visible),
            lumaVarianceAfter: variance(lAfter, visible),
            meanChange: change / (3 * count),
            maxFactor,
            clipped: clipped / count,
            chromaShift: chroma / (2 * count),
        },
    };
}

// A rectangle of texels and how it wraps (atlas.ts' Region).
export interface DelightRegion {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    wrapU: boolean;
    wrapV: boolean;
}

// An atlas de-lit region by region (each on its own texels and wrap); texels outside every region left as they were.
// The stats are the regions' (area-weighted; maxFactor the largest).
export function delightRegions(
    bgra: Uint8Array,
    w: number,
    h: number,
    regions: readonly DelightRegion[],
    options: Omit<DelightOptions, "wrapU" | "wrapV">,
): DelightResult {
    const out = Buffer.from(bgra);
    const shading = new Float32Array(w * h);
    const total = emptyStats(0);
    const weighted: (keyof DelightStats)[] = [
        "shadingVariance",
        "shadingRemoved",
        "lumaVariance",
        "lumaVarianceAfter",
        "meanChange",
        "chromaShift",
        "clipped",
        "reliability",
        "strength",
    ];
    for (const r of regions) {
        const rw = r.x1 - r.x0;
        const rh = r.y1 - r.y0;
        const part = Buffer.alloc(rw * rh * 4);
        for (let y = 0; y < rh; y++)
            Buffer.from(bgra.buffer, bgra.byteOffset, bgra.byteLength).copy(
                part,
                y * rw * 4,
                ((r.y0 + y) * w + r.x0) * 4,
                ((r.y0 + y) * w + r.x1) * 4,
            );
        const done = delight(part, rw, rh, { ...options, wrapU: r.wrapU, wrapV: r.wrapV });
        for (let y = 0; y < rh; y++) {
            done.bgra.copy(out, ((r.y0 + y) * w + r.x0) * 4, y * rw * 4, (y + 1) * rw * 4);
            shading.set(done.shading.subarray(y * rw, (y + 1) * rw), (r.y0 + y) * w + r.x0);
        }
        const v = done.stats.visible;
        for (const key of weighted) total[key] += done.stats[key] * v;
        total.visible += v;
        total.maxFactor = Math.max(total.maxFactor, done.stats.maxFactor);
    }
    if (total.visible) for (const key of weighted) total[key] /= total.visible;
    return { bgra: out, shading, stats: total };
}

// ---- the meshes' face orientations ----

export interface Orientation {
    area: number; // the faces' total area (world units squared)
    coherence: number; // |sum of area x unit normal| / area: 1 all one direction, 0 every direction alike
    // drawn as a solid surface by some pass: blend mode diffuse, blend or fixed blend (not added light), on a mesh that
    // isn't a billboard (a flat stand-in - a distant building, a tree - whose painted shading is its form)
    surface: boolean;
}

export interface FaceSums {
    area: number;
    sum: number[];
    surface: boolean;
}

// A pass that draws a surface: blend mode 0 (diffuse), 5 (blend) or 6 (fixed blend), not environment-mapped - the
// others add, subtract, modulate or brighten (light, glows, shadows: core thug2_scene materialSeeThrough).
const surfacePass = (pass: scn.Pass): boolean =>
    !(pass.flags & scn.PASS_ENVIRONMENT) && [0, 5, 6].includes(pass.blendMode & 0xffffff);

// Per texture checksum (the passes' textures, an animated pass's frames too), the faces using it: their area and how
// alike their directions are. Positions are the vertex's first three floats (a level mesh's and a model's layout).
export function faceOrientations(scene: scn.Scene, into = new Map<number, FaceSums>()): Map<number, FaceSums> {
    const materials = new Map(scene.materials.map((m) => [m.checksum, m]));
    for (const sector of scene.sectors) {
        for (const mesh of sector.meshes) {
            const material = materials.get(mesh.material);
            const buffer = mesh.buffers[0]?.[1];
            if (!material || !buffer || mesh.stride < 12) continue;
            const textures = new Set<number>();
            const surfaces = new Set<number>();
            for (const pass of material.passes) {
                if (pass.flags & scn.PASS_ENVIRONMENT) continue;
                const frames = [pass.texture, ...(pass.animation?.[3] ?? []).map((key) => key[1] ?? 0)];
                for (const t of frames) {
                    if (!t) continue;
                    textures.add(t);
                    if (surfacePass(pass) && !(sector.flags & scn.SEC_BILLBOARD)) surfaces.add(t);
                }
            }
            if (!textures.size) continue;
            const count = Math.min(mesh.vertexCount, Math.floor(buffer.length / mesh.stride));
            const pos = (i: number): number[] => [
                buffer.readFloatLE(i * mesh.stride),
                buffer.readFloatLE(i * mesh.stride + 4),
                buffer.readFloatLE(i * mesh.stride + 8),
            ];
            const strip = mesh.strips[0] ?? [];
            const sum = [0, 0, 0];
            let area = 0;
            for (let k = 0; k + 2 < strip.length; k++) {
                let a = strip[k]!;
                let b = strip[k + 1]!;
                const c = strip[k + 2]!;
                if (a === b || b === c || a === c || Math.max(a, b, c) >= count) continue;
                if (k & 1) [a, b] = [b, a]; // (a strip's odd triangles wind the other way)
                const pa = pos(a);
                const pb = pos(b);
                const pc = pos(c);
                const u = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!];
                const v = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!];
                const nx = u[1]! * v[2]! - u[2]! * v[1]!;
                const ny = u[2]! * v[0]! - u[0]! * v[2]!;
                const nz = u[0]! * v[1]! - u[1]! * v[0]!;
                const len = Math.hypot(nx, ny, nz);
                if (!Number.isFinite(len) || len <= 0) continue;
                // (area x unit normal = the cross product / 2)
                sum[0]! += nx / 2;
                sum[1]! += ny / 2;
                sum[2]! += nz / 2;
                area += len / 2;
            }
            if (area <= 0) continue;
            for (const t of textures) {
                let entry = into.get(t);
                if (!entry) {
                    entry = { area: 0, sum: [0, 0, 0], surface: false };
                    into.set(t, entry);
                }
                if (surfaces.has(t)) entry.surface = true;
                entry.area += area;
                for (let c = 0; c < 3; c++) entry.sum[c]! += sum[c]!;
            }
        }
    }
    return into;
}

export function orientationsOf(sums: Map<number, FaceSums>): Map<number, Orientation> {
    const out = new Map<number, Orientation>();
    for (const [t, e] of sums)
        out.set(t, {
            area: e.area,
            coherence: e.area > 0 ? Math.min(1, Math.hypot(...e.sum) / e.area) : 0,
            surface: e.surface,
        });
    return out;
}

// Why a texture is left as it is by base.ts --delight (null: it is de-lit). Only the levels' own surfaces: a texture
// in a sky's dictionary is the sky (its light is the picture), a model's (skaters, peds, props) is shaded by its own
// modelling and left for a later stage; soft alpha is glass, smoke, glows - its brightness is what it shows; one no
// mesh draws as a surface is an effect, a glow, a light's halo or a script's.
export function leftAsItIs(
    dictionary: string,
    alpha: "opaque" | "binary" | "smooth",
    orientation: Orientation | undefined,
): string | null {
    const parts = dictionary.toLowerCase().split(/[\\/]/);
    const at = parts.indexOf("levels");
    if (at < 0 || at + 1 >= parts.length - 1) return "not a level's dictionary (models, skaters, peds)";
    if (parts[at + 1]!.endsWith("_sky")) return "a sky's";
    if (alpha === "smooth") return "soft alpha (glass, smoke, glows)";
    if (!orientation) return "no mesh beside it uses it (effects, scripts)";
    if (!orientation.surface) return "only drawn as light (added, modulated) or on billboards";
    return null;
}

// The face orientations of the scene files beside a dictionary (memoised per folder; atlas.ts' sceneFiles).
export class Orientations {
    private readonly folders = new Map<string, Map<number, Orientation>>();

    of(dictionary: string): Map<number, Orientation> {
        const dir = path.dirname(dictionary).toLowerCase();
        let found = this.folders.get(dir);
        if (!found) {
            const sums = new Map<number, FaceSums>();
            for (const file of sceneFiles(dictionary)) {
                try {
                    faceOrientations(scn.readScene(fs.readFileSync(file), file), sums);
                } catch {
                    // (a scene not read: its textures' strength is the unknown one)
                }
            }
            found = orientationsOf(sums);
            this.folders.set(dir, found);
        }
        return found;
    }
}

// ---- the cache ----

// A de-lit texture cached by its texels and every setting (gzipped: w, h, BGRA, the shading as float32).
export function delightKey(
    bgra: Uint8Array,
    w: number,
    h: number,
    options: DelightOptions,
    regions?: readonly DelightRegion[],
): string {
    const hash = createHash("sha256");
    hash.update(
        JSON.stringify({
            v: DELIGHT_VERSION,
            w,
            h,
            wrapU: options.wrapU,
            wrapV: options.wrapV,
            k: Math.round((options.strength ?? strengthFor(options.coherence)) * 1000),
            cell: options.cellFraction ?? 1 / 16,
            el: options.edgeLuma ?? 0.1,
            ec: options.edgeChroma ?? 0.06,
            limit: options.limit ?? 2,
            regions: regions ?? null,
        }),
    );
    hash.update(bgra);
    return hash.digest("hex");
}

export function readDelightCache(
    dir: string,
    key: string,
    w: number,
    h: number,
): { bgra: Buffer; shading: Float32Array } | null {
    const file = path.join(dir, key.slice(0, 2), `${key}.delit.gz`);
    if (!fs.existsSync(file)) return null;
    try {
        const data = zlib.gunzipSync(fs.readFileSync(file));
        if (data.length !== 8 + w * h * 8 || data.readUInt32LE(0) !== w || data.readUInt32LE(4) !== h) return null;
        const bgra = Buffer.from(data.subarray(8, 8 + w * h * 4));
        const shading = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) shading[i] = data.readFloatLE(8 + w * h * 4 + i * 4);
        return { bgra, shading };
    } catch {
        return null;
    }
}

export function writeDelightCache(
    dir: string,
    key: string,
    w: number,
    h: number,
    result: { bgra: Uint8Array; shading: Float32Array },
): void {
    const file = path.join(dir, key.slice(0, 2), `${key}.delit.gz`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = Buffer.alloc(8 + w * h * 8);
    data.writeUInt32LE(w, 0);
    data.writeUInt32LE(h, 4);
    data.set(result.bgra, 8);
    for (let i = 0; i < w * h; i++) data.writeFloatLE(result.shading[i]!, 8 + w * h * 4 + i * 4);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, zlib.gzipSync(data, { level: 6 }));
    fs.renameSync(temp, file);
}

// The shading layer as a grey picture (128: nothing removed; darker: the texel was brightened - painted shadow taken
// out; lighter: darkened - painted light taken out), `span` the ln factor that reaches black / white.
export function shadingPicture(shading: Float32Array, span = Math.log(2)): Uint8Array {
    const out = new Uint8Array(shading.length);
    for (let i = 0; i < shading.length; i++)
        out[i] = Math.max(0, Math.min(255, Math.round(128 + (127 * shading[i]!) / span)));
    return out;
}
