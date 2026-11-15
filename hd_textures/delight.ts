// NOT ORIGINAL - de-lighting the base game's textures before they are upscaled (base.ts --delight): some of the 2004
// colour maps have light painted into them - a facade darker toward its foot, a gradient down a wall, a shadow band
// under a ledge - which the Vulkan renderer's own lighting (ray-traced sun, occlusion, bounce) then lights a second
// time. This takes that painted light out at the original resolution, per texture, before the model sees it: the HD
// set is made from clean surface colour, and core's matchOriginal pulls the model's output back to the DE-LIT texels.
//
// Version 2 - light is removed only where there is evidence for it, in the shapes light takes. (Version 1 took any soft
// broad variation for light and removed it: the material's own tone - water's ripples, stains, weathering, grime -
// went with it and the textures came out flat. Most of THUG2's baked light is in its vertex colours; most tiling
// materials have little painted light.)
//
// The method - deterministic, no model (the same texels and level give the same bytes):
// - the broad part of the log luminance, l = ln(L + 0.01) of the linearised colour (sRGB as 2.2, Rec. 709): its
//   steps integrated on a grid of a 32nd of the shorter side, colour edges left out (gradient-domain Retinex, Horn
//   1974 / Blake 1985 - retinexShading: a step where the chromaticity changes hard is paint and counts for nothing; a
//   step of brightness alone stays - a shadow under a ledge starts with one). The colour (ln of R's and of B's share
//   of R + G + B) blurred to the same scale: light changes brightness, paint changes colour;
// - a structured lighting model fitted to it (least squares over the visible texels; x, y the picture's coordinates,
//   0 - 1) - three kinds of term, each the shape one kind of light takes:
//   gradient: a plane in l (x - 1/2, y - 1/2) - a smooth directional falloff of light across the picture. Only along
//     an axis that doesn't tile: a tiled picture meets its own other edge, so it can't hold a gradient across itself;
//   edge: darkening toward a border, exp(-d / s) for s = 0.05 and 0.15 (d the distance from it) - occlusion where the
//     picture's edge meets another surface (a wall's foot, a facade's corner). Only on a border that doesn't tile;
//   band: the same falloff from a line inside the picture where the level has surfaces meeting this one (a ledge, a
//     sill, a floor slab - delight_geometry.ts's lines), on the side the face lies (both when it lies on both);
// - the evidence gate - a term is taken only when all of these hold, and is then removed at strength 0.9:
//   its share: it explains at least a tenth of the broad variance (a gradient 15%) and moves l by 8% somewhere (a
//     gradient no more than 50%: light falling off across one face is gentle - a steeper one is the picture's content);
//   its sign: an edge or band darkens toward its line (light doesn't brighten a corner), a gradient brightens toward
//     the sky - up the face, in the picture (delight_geometry.ts: the faces' uv frames turn world up into the
//     picture's coordinates; at least 0.3 consistent and within 53 degrees of it - a floor has no up across it);
//   its texels: the dip at a line, the rise along a gradient, shows in the texels' own means across the picture, and
//     stands three times clear of their variation elsewhere (a dark plank at the border of planks is the pattern);
//   its geometry: an edge's border, a band's line, is where the level has another surface meeting this one in a
//     concave corner along at least 30% of its length;
//   its colour: the term moves the chromaticity by less than a fifth of what it moves l (paint changes hue: a two-tone
//     wall's soft border is surface, not shadow);
//   then the taken terms refitted together must explain at least 35% of the broad variance, and the broad variance
//   must be there at all (its standard deviation 5%). Otherwise the texture is left exactly as it is;
// - the removed shading: the gradient made zero-mean (the picture's level is its colour), the edges and bands as they
//   are (zero away from their lines: the unshadowed texels keep their bytes), bounded to a factor of `limit` (2);
//   each visible texel's linear RGB divided by exp of it (a luminance factor: chroma kept, clipped back by its largest
//   channel), back to sRGB. Transparent texels (alpha <= 8) take no part and keep their bytes; alpha untouched.
//
// What comes out: the de-lit texels, the shading layer (the natural log of the factor removed, per texel) and the
// model's report - each term's share, its agreement with the geometry and why it was taken or not (the review page).
//
// What base.ts leaves as it is (skipReason): skies' and models' dictionaries, soft alpha (glass, smoke, glows),
// cut-outs (a tree's, a fence's painted shading is its form), textures no mesh draws as a solid surface (added or
// modulated light, billboards), moving materials (the water system's: water, lava, scrolling signs), backdrops far
// outside the play area, and glowing pictures (bright, saturated, clipped: fire, neon, lit windows).
//
// Atlases (atlas.ts' regions) are de-lit region by region (delightRegions): each region on its own texels, with its own
// wrap and its own evidence (the triangles mapped into it), so no picture's light reaches its neighbour.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as scn from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { sceneFiles, type UvUse } from "./atlas.ts";
import { type Evidence, type Line, type SceneGeometry, solve, type TextureFacts } from "./delight_geometry.ts";

export type { Evidence, Line, TextureFacts };

// bumped whenever the step makes different texels from the same input (set.json records it per texture; base.ts's
// file cache and the game's settings key on it)
export const DELIGHT_VERSION = 2;

export interface DelightOptions {
    wrapU: boolean;
    wrapV: boolean;
    // the level's evidence for this picture (delight_geometry.ts); null / absent: none - nothing is removed
    evidence?: Evidence | null;
    strength?: number; // how much of a taken term is removed (default 0.9)
    limit?: number; // the largest factor removed either way (default 2)
}

export type TermKind = "gradient" | "edge" | "band";

// One term of the lighting model as fitted and judged.
export interface TermReport {
    kind: TermKind;
    name: string; // "gradient", "edge left", "band y=0.58 below"...
    share: number; // the share of the broad variance it explains on its own (fitted alone)
    amplitude: number; // the largest |change of l| it makes
    agreement: number | null; // gradient: cos to the way up; edge / band: the share of its line where surfaces meet
    chroma: number; // |its move of the chromaticity| / |its move of l|
    taken: boolean;
    why: string; // why taken or not
}

export interface DelightStats {
    changed: boolean;
    verdict: string; // "de-lit: ..." or why untouched
    terms: TermReport[];
    broadVariance: number; // the variance of the broad log luminance
    structure: number; // the share of it every candidate term together explains
    explained: number; // ... the taken terms (refitted) explain
    visible: number; // texels taking part
    meanChange: number; // the mean |byte change| over R, G, B of the visible texels (0 - 255)
    maxFactor: number; // the largest factor applied (>= 1)
    clipped: number; // the share of the visible texels whose factor reached the limit
    chromaShift: number; // the mean change of the chromaticity (r / (r+g+b), b / (r+g+b)), x 255
}

export interface DelightResult {
    bgra: Buffer;
    shading: Float32Array; // ln of the factor removed (the texel was divided by exp of it); 0 where untouched
    stats: DelightStats;
}

// the gate (see the header)
export const GATE = {
    strength: 0.9,
    minBroadStd: 0.05,
    minShare: 0.1,
    minGradientShare: 0.15,
    minAmplitude: 0.08,
    maxGradient: 0.5,
    minLight: 0.3,
    minAgreement: 0.6,
    minMeets: 0.3,
    maxChroma: 0.2,
    minExplained: 0.35,
    cellFraction: 1 / 32,
    edgeWidths: [0.05, 0.15],
    bandWidths: [0.04, 0.12],
    maxBands: 6,
};

const EPS = 0.01;
const LUT = new Float32Array(256).map((_, i) => (i / 255) ** 2.2);
const toByte = (v: number): number => Math.max(0, Math.min(255, Math.round(Math.max(0, v) ** (1 / 2.2) * 255)));

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

function emptyStats(verdict: string, visible = 0): DelightStats {
    return {
        changed: false,
        verdict,
        terms: [],
        broadVariance: 0,
        structure: 0,
        explained: 0,
        visible,
        meanChange: 0,
        maxFactor: 1,
        clipped: 0,
        chromaShift: 0,
    };
}

// ---- the lighting model ----

type Basis = (x: number, y: number) => number;

interface Candidate {
    kind: TermKind;
    name: string;
    basis: Basis[];
    line?: Line;
}

// exp(-d / s) on the face's side of the line (both sides when `side` is 0), 0 on the other
function falloff(line: { axis: "x" | "y"; at: number; side: number }, s: number): Basis {
    return (x, y) => {
        const d = (line.axis === "x" ? x : y) - line.at;
        if ((line.side > 0 && d < 0) || (line.side < 0 && d > 0)) return 0;
        return Math.exp(-Math.abs(d) / s);
    };
}

const SIDES: [string, "x" | "y", number][] = [
    ["left", "x", 0],
    ["right", "x", 1],
    ["top", "y", 0],
    ["bottom", "y", 1],
];

// The model's candidate terms for a picture of this wrap and evidence.
function candidatesFor(wrapU: boolean, wrapV: boolean, evidence: Evidence | null | undefined): Candidate[] {
    const out: Candidate[] = [];
    const gradient: Basis[] = [];
    if (!wrapU) gradient.push((x) => x - 0.5);
    if (!wrapV) gradient.push((_x, y) => y - 0.5);
    if (gradient.length) out.push({ kind: "gradient", name: "gradient", basis: gradient });
    for (const [name, axis, at] of SIDES) {
        if ((axis === "x" && wrapU) || (axis === "y" && wrapV)) continue;
        const side = at === 0 ? 1 : -1;
        const found = evidence?.lines.find((l) => l.axis === axis && l.at === at);
        const line: Line = { axis, at, side, meets: found?.meets ?? 0, length: found?.length ?? 0 };
        out.push({ kind: "edge", name: `edge ${name}`, basis: GATE.edgeWidths.map((s) => falloff(line, s)), line });
    }
    const bands = (evidence?.lines ?? []).filter(
        (l) =>
            l.at > 0 &&
            l.at < 1 &&
            l.meets >= GATE.minMeets &&
            l.length * l.meets >= 0.25 &&
            !(l.axis === "x" && wrapU) &&
            !(l.axis === "y" && wrapV),
    );
    for (const line of bands.slice(0, GATE.maxBands)) {
        const where =
            line.side === 0
                ? "both sides"
                : line.axis === "x"
                  ? line.side > 0
                      ? "right"
                      : "left"
                  : line.side > 0
                    ? "below"
                    : "above";
        out.push({
            kind: "band",
            name: `band ${line.axis}=${line.at.toFixed(2)} ${where}`,
            basis: GATE.bandWidths.map((s) => falloff(line, s)),
            line,
        });
    }
    return out;
}

interface Samples {
    x: Float64Array;
    y: Float64Array;
    l: Float64Array; // the broad log luminance (retinexShading)
    raw: Float64Array; // the texel's own log luminance
    cr: Float64Array;
    cb: Float64Array;
    n: number;
}

interface Fit {
    coef: number[]; // per column (column 0 the intercept)
    columns: number[][]; // each candidate's column indexes
}

// Least squares of the targets on the candidates' bases (+ an intercept), over the samples.
function fit(samples: Samples, terms: readonly Candidate[], target: Float64Array): Fit | null {
    const columns: number[][] = [];
    const basis: Basis[] = [];
    for (const t of terms) {
        columns.push(t.basis.map((_, k) => basis.length + 1 + k));
        basis.push(...t.basis);
    }
    const m = basis.length + 1;
    const ata = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const atb = new Array<number>(m).fill(0);
    const row = new Array<number>(m);
    for (let i = 0; i < samples.n; i++) {
        row[0] = 1;
        for (let k = 0; k < basis.length; k++) row[k + 1] = basis[k]!(samples.x[i]!, samples.y[i]!);
        for (let a = 0; a < m; a++) {
            atb[a]! += row[a]! * target[i]!;
            for (let b = a; b < m; b++) ata[a]![b]! += row[a]! * row[b]!;
        }
    }
    for (let a = 0; a < m; a++) {
        for (let b = 0; b < a; b++) ata[a]![b] = ata[b]![a]!;
        ata[a]![a]! += 1e-6 * samples.n;
    }
    const coef = solve(ata, atb);
    return coef ? { coef, columns } : null;
}

// A candidate's part of a fit at a point.
function partAt(term: Candidate, f: Fit, index: number, x: number, y: number): number {
    let s = 0;
    term.basis.forEach((b, k) => {
        s += f.coef[f.columns[index]![k]!]! * b(x, y);
    });
    return s;
}

function sampleVariance(v: Float64Array, n: number): number {
    let s = 0;
    for (let i = 0; i < n; i++) s += v[i]!;
    const mean = s / Math.max(1, n);
    let q = 0;
    for (let i = 0; i < n; i++) q += (v[i]! - mean) ** 2;
    return q / Math.max(1, n);
}

// The texels' own log luminance along t (0 - 1): its mean per bin (NaN where no sample falls).
function profileAlong(samples: Samples, t: (x: number, y: number) => number, bins: number): Float64Array {
    const sum = new Float64Array(bins);
    const count = new Float64Array(bins);
    for (let i = 0; i < samples.n; i++) {
        const b = Math.min(bins - 1, Math.max(0, Math.floor(t(samples.x[i]!, samples.y[i]!) * bins)));
        sum[b]! += samples.raw[i]!;
        count[b]!++;
    }
    return sum.map((v, b) => (count[b] ? v / count[b]! : Number.NaN));
}

const meanStd = (v: readonly number[]): [number, number] => {
    const m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
    return [m, Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length))];
};

// Whether an edge's / band's darkening stands out in the texels themselves: across the line (the texels' mean per
// 32nd of the picture) they are darker near it - by at least half the fitted depth - and that dip is at least three
// times deeper than the picture's own variation farther than a quarter away (a dark plank at the border of a picture
// of planks is its pattern; occlusion is the one dip). Null when it does, else why not.
function distinctDip(samples: Samples, line: Line, depth: number): string | null {
    const bins = 32;
    const profile = profileAlong(samples, (x, y) => (line.axis === "x" ? x : y), bins);
    const near: number[] = [];
    const far: number[] = [];
    profile.forEach((v, b) => {
        if (Number.isNaN(v)) return;
        const d = (b + 0.5) / bins - line.at;
        if ((line.side > 0 && d < -0.5 / bins) || (line.side < 0 && d > 0.5 / bins)) return;
        if (Math.abs(d) <= 0.07) near.push(v);
        else if (Math.abs(d) >= 0.25) far.push(v);
    });
    if (near.length < 1 || far.length < 3) return "too little of the picture beyond it to compare";
    const [nearMean] = meanStd(near);
    const [farMean, farStd] = meanStd(far);
    const dip = farMean - nearMean;
    if (dip < 0.5 * depth) return `the texels aren't darker there (${pct(dip)} against ${pct(depth)} fitted)`;
    if (dip < 3 * farStd) return `the picture varies as much away from it (${pct(farStd)}): its own pattern`;
    return null;
}

// Whether a gradient stands out in the texels: their means along its direction (16 steps) rise that way, by at least
// half the fitted slope and three times their scatter about the straight line (rows of windows, a pattern's bands
// don't make a gradient).
function distinctSlope(samples: Samples, g: readonly number[]): string | null {
    const length = Math.hypot(g[0]!, g[1]!);
    if (length <= 0) return "no slope";
    const ux = g[0]! / length;
    const uy = g[1]! / length;
    const span = Math.abs(ux) + Math.abs(uy);
    const bins = 16;
    const profile = profileAlong(samples, (x, y) => 0.5 + ((x - 0.5) * ux + (y - 0.5) * uy) / span, bins);
    const ts: number[] = [];
    const vs: number[] = [];
    profile.forEach((v, b) => {
        if (!Number.isNaN(v)) {
            ts.push((b + 0.5) / bins);
            vs.push(v);
        }
    });
    if (ts.length < 4) return "too few steps along it";
    const [tm] = meanStd(ts);
    const [vm] = meanStd(vs);
    let num = 0;
    let den = 0;
    ts.forEach((t, k) => {
        num += (t - tm) * (vs[k]! - vm);
        den += (t - tm) ** 2;
    });
    const slope = num / den; // (per the whole run of t: the rise across the picture)
    const [, scatter] = meanStd(ts.map((t, k) => vs[k]! - (vm + slope * (t - tm))));
    const fitted = length * span; // (the model's rise over the same run)
    if (slope < 0.5 * fitted) return `the texels don't rise that way (${pct(slope)} against ${pct(fitted)} fitted)`;
    if (slope < 3 * scatter) return `the picture varies as much across it (${pct(scatter)}): its own pattern`;
    return null;
}

// Each candidate fitted and judged against the gate; the taken ones refitted together.
function judge(
    samples: Samples,
    candidates: readonly Candidate[],
    evidence: Evidence | null | undefined,
    wrapU: boolean,
    wrapV: boolean,
): { reports: TermReport[]; taken: Candidate[]; fit: Fit | null; structure: number; explained: number; broad: number } {
    const n = samples.n;
    const broad = sampleVariance(samples.l, n);
    const explainedBy = (terms: readonly Candidate[], f: Fit): number => {
        const resid = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let m = f.coef[0]!;
            terms.forEach((t, k) => {
                m += partAt(t, f, k, samples.x[i]!, samples.y[i]!);
            });
            resid[i] = samples.l[i]! - m;
        }
        return broad > 0 ? 1 - sampleVariance(resid, n) / broad : 0;
    };
    const full = fit(samples, candidates, samples.l);
    if (!full) return { reports: [], taken: [], fit: null, structure: 0, explained: 0, broad };
    const structure = explainedBy(candidates, full);
    const light = evidence?.light ? [wrapU ? 0 : evidence.light[0], wrapV ? 0 : evidence.light[1]] : null;
    const reports: TermReport[] = [];
    const takenIdx: number[] = [];
    candidates.forEach((term, k) => {
        // (judged on its own: the term alone fitted - correlated terms fitted together trade their parts off)
        const alone = fit(samples, [term], samples.l);
        const aloneCr = fit(samples, [term], samples.cr);
        const aloneCb = fit(samples, [term], samples.cb);
        if (!alone) {
            reports.push({
                kind: term.kind,
                name: term.name,
                share: 0,
                amplitude: 0,
                agreement: null,
                chroma: 0,
                taken: false,
                why: "no fit",
            });
            return;
        }
        const part = new Float64Array(n);
        const pr = new Float64Array(n);
        const pb = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            part[i] = partAt(term, alone, 0, samples.x[i]!, samples.y[i]!);
            pr[i] = aloneCr ? partAt(term, aloneCr, 0, samples.x[i]!, samples.y[i]!) : 0;
            pb[i] = aloneCb ? partAt(term, aloneCb, 0, samples.x[i]!, samples.y[i]!) : 0;
        }
        const v = sampleVariance(part, n);
        const share = broad > 0 ? v / broad : 0;
        let mean = 0;
        for (let i = 0; i < n; i++) mean += part[i]!;
        mean /= Math.max(1, n);
        let amplitude = 0;
        for (let i = 0; i < n; i++)
            amplitude = Math.max(amplitude, Math.abs(part[i]! - (term.kind === "gradient" ? mean : 0)));
        const chroma = v > 1e-12 ? Math.sqrt((sampleVariance(pr, n) + sampleVariance(pb, n)) / v) : 0;
        let agreement: number | null = null;
        let why = "";
        if (term.kind === "gradient") {
            const gx = wrapU ? 0 : alone.coef[1]!;
            const gy = wrapV ? 0 : alone.coef[wrapU ? 1 : 2]!;
            const g = wrapU ? [0, gy] : wrapV ? [gx, 0] : [gx, gy];
            const consistency = light ? Math.hypot(light[0]!, light[1]!) : 0;
            const length = Math.hypot(g[0]!, g[1]!);
            agreement =
                light && consistency > 0 && length > 0
                    ? (g[0]! * light[0]! + g[1]! * light[1]!) / (consistency * length)
                    : null;
            if (share < GATE.minGradientShare) why = `explains ${pct(share)} (< ${pct(GATE.minGradientShare)})`;
            else if (amplitude < GATE.minAmplitude) why = `too faint (${pct(amplitude)})`;
            else if (!light || consistency < GATE.minLight)
                why = `the faces don't say which way is up in the picture (consistency ${consistency.toFixed(2)}): a floor, mixed mapping`;
            else if ((agreement ?? -1) < GATE.minAgreement)
                why = `doesn't brighten toward the sky (cos ${(agreement ?? 0).toFixed(2)}): the picture's own tone`;
            else if (amplitude > GATE.maxGradient)
                why = `too steep for light across one face (${pct(amplitude)}): the picture's own content`;
            else why = distinctSlope(samples, g) ?? "";
        } else {
            const line = term.line!;
            agreement = line.meets;
            // its profile from the line outward: darker at the line, never lighter
            const profile = [0, 0.02, 0.05, 0.1, 0.2, 0.3].map((d) => {
                const at = line.at + (line.side === 0 ? 1 : line.side) * d;
                const x = line.axis === "x" ? at : 0.5;
                const y = line.axis === "y" ? at : 0.5;
                return partAt(term, alone, 0, x, y);
            });
            const peak = profile[0]!;
            if (peak >= 0 || Math.max(...profile) > 0.25 * Math.abs(peak))
                why = "brightens toward its line: not occlusion";
            else if (share < GATE.minShare) why = `explains ${pct(share)} (< ${pct(GATE.minShare)})`;
            else if (amplitude < GATE.minAmplitude) why = `too faint (${pct(amplitude)})`;
            else if (line.meets < GATE.minMeets)
                why = `nothing meets the surface there in the level (${pct(line.meets)} of the line)`;
            else why = distinctDip(samples, line, -peak) ?? "";
        }
        if (!why && chroma > GATE.maxChroma)
            why = `the colour changes with it (${chroma.toFixed(2)} of its brightness change): paint, not light`;
        if (!why) {
            why =
                term.kind === "gradient"
                    ? `brightens toward the sky (cos ${(agreement ?? 0).toFixed(2)})`
                    : `surfaces meet along ${pct(agreement ?? 0)} of it`;
            takenIdx.push(k);
        }
        reports.push({
            kind: term.kind,
            name: term.name,
            share,
            amplitude,
            agreement,
            chroma,
            taken: takenIdx.includes(k),
            why,
        });
    });
    // the taken ones refitted together; a term whose sign turns over in company is dropped
    let taken = takenIdx.map((k) => candidates[k]!);
    let refit: Fit | null = null;
    for (let round = 0; round <= candidates.length && taken.length; round++) {
        refit = fit(samples, taken, samples.l);
        if (!refit) break;
        const bad = taken.findIndex((term, k) => {
            if (term.kind === "gradient") {
                if (!light) return true;
                const c = refit!.columns[k]!;
                const gx = wrapU ? 0 : refit!.coef[c[0]!]!;
                const gy = wrapV ? 0 : refit!.coef[c[wrapU ? 0 : 1]!]!;
                return gx * light[0]! + gy * light[1]! <= 0;
            }
            const line = term.line!;
            const x = line.axis === "x" ? line.at : 0.5;
            const y = line.axis === "y" ? line.at : 0.5;
            return partAt(term, refit!, k, x, y) >= 0;
        });
        if (bad < 0) break;
        const report = reports.find((r) => r.name === taken[bad]!.name);
        if (report) {
            report.taken = false;
            report.why = "its sign turns over beside the other terms";
        }
        taken = taken.filter((_, k) => k !== bad);
        refit = null;
    }
    const explained = refit && taken.length ? explainedBy(taken, refit) : 0;
    return { reports, taken: refit ? taken : [], fit: refit, structure, explained, broad };
}

const pct = (v: number): string => `${Math.round(100 * v)}%`;

// One texture (or one atlas region) de-lit: BGRA in, BGRA out (alpha and transparent texels untouched).
export function delight(bgra: Uint8Array, w: number, h: number, options: DelightOptions): DelightResult {
    const k = options.strength ?? GATE.strength;
    const limit = Math.log(Math.max(1, options.limit ?? 2));
    const n = w * h;
    const out = Buffer.from(bgra);
    const shading = new Float32Array(n);
    const visible = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) if (bgra[i * 4 + 3]! > 8) visible[i] = 1;
    for (let i = 0; i < n; i++) count += visible[i]!;
    const untouched = (verdict: string, extra?: Partial<DelightStats>): DelightResult => ({
        bgra: out,
        shading,
        stats: { ...emptyStats(verdict, count), ...extra },
    });
    if (count === 0 || w < 2 || h < 2) return untouched("untouched: nothing visible to judge");
    let uniform = true;
    let first = -1;
    for (let i = 0; i < n && uniform; i++) {
        if (!visible[i]) continue;
        if (first < 0) first = i;
        else for (let c = 0; c < 3; c++) if (bgra[i * 4 + c] !== bgra[first * 4 + c]) uniform = false;
    }
    if (uniform) return untouched("untouched: one colour");
    if (options.wrapU && options.wrapV)
        return untouched(
            "untouched: it tiles both ways - a repeating material has no room for light the model can tell from its own tone",
        );

    // linear R, G, B and the log luminance / chromaticity
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
    const cell = Math.max(2, GATE.cellFraction * Math.min(w, h));
    // (only a colour edge is surface here: a shadow under a ledge starts with a hard step of brightness alone - the
    // model's shapes, the level and the texel checks tell it from a dark stripe of paint)
    const low = retinexShading(l, gr, gb, visible, w, h, {
        wrapU: options.wrapU,
        wrapV: options.wrapV,
        cell,
        edgeLuma: Number.POSITIVE_INFINITY,
        edgeChroma: 0.06,
    });
    // (the colour the terms are checked against: ln of the channel's share of R + G + B - unchanged when the texel
    // only grows brighter or darker, even for a dark, saturated paint)
    const share = (c: number): Float32Array =>
        Float32Array.from({ length: n }, (_, i) => {
            const sum = lin[0]![i]! + lin[1]![i]! + lin[2]![i]!;
            return Math.log((lin[c]![i]! + 1e-3) / (sum + 3e-3));
        });
    const radius = Math.max(1, Math.round(cell));
    const lowR = boxMean(share(0), w, h, radius, options.wrapU, options.wrapV);
    const lowB = boxMean(share(2), w, h, radius, options.wrapU, options.wrapV);

    // the samples: the visible texels on a lattice of at most ~4096
    const stride = Math.max(1, Math.ceil(Math.sqrt(n / 4096)));
    const xs: number[] = [];
    const ys: number[] = [];
    const ls: number[] = [];
    const raws: number[] = [];
    const rs: number[] = [];
    const bs: number[] = [];
    for (let y = 0; y < h; y += stride)
        for (let x = 0; x < w; x += stride) {
            const i = y * w + x;
            if (!visible[i]) continue;
            xs.push((x + 0.5) / w);
            ys.push((y + 0.5) / h);
            ls.push(low[i]!);
            raws.push(l[i]!);
            rs.push(lowR[i]!);
            bs.push(lowB[i]!);
        }
    const samples: Samples = {
        x: Float64Array.from(xs),
        y: Float64Array.from(ys),
        l: Float64Array.from(ls),
        raw: Float64Array.from(raws),
        cr: Float64Array.from(rs),
        cb: Float64Array.from(bs),
        n: xs.length,
    };
    const broad = sampleVariance(samples.l, samples.n);
    if (broad < GATE.minBroadStd ** 2)
        return untouched(`untouched: no broad variation to explain (std ${pct(Math.sqrt(broad))})`, {
            broadVariance: broad,
        });
    const candidates = candidatesFor(options.wrapU, options.wrapV, options.evidence);
    const judged = judge(samples, candidates, options.evidence, options.wrapU, options.wrapV);
    const base = {
        terms: judged.reports,
        broadVariance: broad,
        structure: judged.structure,
        explained: judged.explained,
    };
    if (!options.evidence) return untouched("untouched: no level geometry to check the model against", base);
    if (!judged.taken.length || !judged.fit)
        return untouched("untouched: no term shaped like light passed the gate", base);
    if (judged.explained < GATE.minExplained)
        return untouched(
            `untouched: the light-shaped terms explain only ${pct(judged.explained)} of the broad variation`,
            base,
        );

    // the removed shading per texel
    const f = judged.fit;
    let gradientMean = 0;
    const gradientAt = judged.taken.findIndex((t) => t.kind === "gradient");
    if (gradientAt >= 0) {
        for (let i = 0; i < samples.n; i++)
            gradientMean += partAt(judged.taken[gradientAt]!, f, gradientAt, samples.x[i]!, samples.y[i]!);
        gradientMean /= samples.n;
    }
    let maxFactor = 1;
    let clipped = 0;
    let change = 0;
    let chroma = 0;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!visible[i]) continue;
            const px = (x + 0.5) / w;
            const py = (y + 0.5) / h;
            let s = 0;
            judged.taken.forEach((t, kk) => {
                s += partAt(t, f, kk, px, py) - (kk === gradientAt ? gradientMean : 0);
            });
            const r = Math.max(-limit, Math.min(limit, k * s));
            shading[i] = r;
            if (Math.abs(r) >= limit - 1e-6) clipped++;
            maxFactor = Math.max(maxFactor, Math.exp(Math.abs(r)));
            const fct = Math.exp(-r);
            let R = lin[0]![i]! * fct;
            let G = lin[1]![i]! * fct;
            let B = lin[2]![i]! * fct;
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
                Math.abs(out[i * 4]! - ob[0]!) +
                Math.abs(out[i * 4 + 1]! - ob[1]!) +
                Math.abs(out[i * 4 + 2]! - ob[2]!);
            const sum0 = ob[0]! + ob[1]! + ob[2]! || 1;
            const sum1 = out[i * 4]! + out[i * 4 + 1]! + out[i * 4 + 2]! || 1;
            chroma +=
                Math.abs(ob[2]! / sum0 - out[i * 4 + 2]! / sum1) * 255 +
                Math.abs(ob[0]! / sum0 - out[i * 4]! / sum1) * 255;
        }
    const changed = !out.equals(Buffer.from(bgra.buffer, bgra.byteOffset, bgra.byteLength));
    return {
        bgra: out,
        shading,
        stats: {
            ...base,
            changed,
            verdict: `de-lit: ${judged.taken.map((t) => t.name).join(", ")} (${pct(judged.explained)} of the broad variation)`,
            visible: count,
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

// An atlas de-lit region by region (each on its own texels, wrap and evidence); texels outside every region left as
// they were. The stats: the regions' (area-weighted; maxFactor the largest; the terms each region's, named by it).
export function delightRegions(
    bgra: Uint8Array,
    w: number,
    h: number,
    regions: readonly DelightRegion[],
    options: Omit<DelightOptions, "wrapU" | "wrapV" | "evidence"> & {
        evidenceFor?: (region: DelightRegion) => Evidence | null;
    },
): DelightResult {
    const out = Buffer.from(bgra);
    const shading = new Float32Array(w * h);
    const total = emptyStats("");
    const weighted = ["broadVariance", "structure", "explained", "meanChange", "chromaShift", "clipped"] as const;
    const verdicts: string[] = [];
    let changed = 0;
    regions.forEach((r, n) => {
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
        const done = delight(part, rw, rh, {
            ...options,
            wrapU: r.wrapU,
            wrapV: r.wrapV,
            evidence: options.evidenceFor?.(r) ?? null,
        });
        for (let y = 0; y < rh; y++) {
            done.bgra.copy(out, ((r.y0 + y) * w + r.x0) * 4, y * rw * 4, (y + 1) * rw * 4);
            shading.set(done.shading.subarray(y * rw, (y + 1) * rw), (r.y0 + y) * w + r.x0);
        }
        const v = done.stats.visible;
        for (const key of weighted) total[key] += done.stats[key] * v;
        total.visible += v;
        total.maxFactor = Math.max(total.maxFactor, done.stats.maxFactor);
        total.terms.push(...done.stats.terms.map((t) => ({ ...t, name: `region ${n + 1}: ${t.name}` })));
        if (done.stats.changed) {
            changed++;
            verdicts.push(`region ${n + 1} ${done.stats.verdict}`);
        }
    });
    if (total.visible) for (const key of weighted) total[key] /= total.visible;
    total.changed = changed > 0;
    total.verdict = changed
        ? `de-lit ${changed} of ${regions.length} regions: ${verdicts.join("; ")}`
        : `untouched: none of its ${regions.length} regions passed the gate`;
    return { bgra: out, shading, stats: total };
}

// ---- what is left as it is ----

// A glowing picture: bright, saturated and clipped (fire, lava, neon, lit windows) - its brightness is what it shows.
export function glowing(bgra: Uint8Array): boolean {
    let visible = 0;
    let clipped = 0;
    let saturation = 0;
    for (let i = 0; i < bgra.length; i += 4) {
        if (bgra[i + 3]! <= 8) continue;
        visible++;
        const top = Math.max(bgra[i]!, bgra[i + 1]!, bgra[i + 2]!);
        const bottom = Math.min(bgra[i]!, bgra[i + 1]!, bgra[i + 2]!);
        if (top >= 250) clipped++;
        saturation += top ? (top - bottom) / top : 0;
    }
    return visible > 0 && clipped / visible > 0.05 && saturation / visible > 0.6;
}

// Why base.ts --delight leaves a texture as it is (null: it is judged by the model). `facts`: the level's
// (delight_geometry.ts; absent: no mesh beside it uses it as a surface).
export function skipReason(
    dictionary: string,
    bgra: Uint8Array,
    alpha: "opaque" | "binary" | "smooth",
    orientation: Orientation | undefined,
    facts: TextureFacts | undefined,
): string | null {
    const left = leftAsItIs(dictionary, alpha, orientation);
    if (left) return left;
    if (facts?.moving) return "a moving material (water, lava, scrolling - the water system's rule)";
    if (alpha === "binary") return "a cut-out (a tree's, a fence's painted shading is its form)";
    if (facts && facts.backdrop >= 0.5) return "a backdrop far outside the play area";
    if (glowing(bgra)) return "a glowing picture (bright, saturated, clipped)";
    return null;
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
            k: options.strength ?? GATE.strength,
            limit: options.limit ?? 2,
            evidence: options.evidence ?? null,
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

// ---- the level's evidence for a texture ----

// Whether the texture tiles along u / v as the level maps it: some triangle (not clamped) reaches across a tile's
// border; no mapping known (generated coordinates, unreferenced): `fallback` (base.ts detectWrap, from its texels).
export function tilingOf(
    uses: readonly UvUse[] | undefined,
    fallback: { wrapU: boolean; wrapV: boolean },
): {
    wrapU: boolean;
    wrapV: boolean;
} {
    if (!uses?.length) return fallback;
    const crosses = (a: number, b: number): boolean => b - a > 1.02 || Math.floor(a + 0.01) !== Math.floor(b - 0.01);
    return {
        wrapU: uses.some((u) => !u.clampU && (u.whole || crosses(u.u0, u.u1))),
        wrapV: uses.some((u) => !u.clampV && (u.whole || crosses(u.v0, u.v1))),
    };
}

// The level's evidence for a whole texture.
export function textureEvidence(
    geometry: SceneGeometry | undefined,
    checksum: number,
    wrap: { wrapU: boolean; wrapV: boolean },
): Evidence | null {
    return geometry?.evidence(checksum, { u0: 0, u1: 1, v0: 0, v1: 1 }, wrap) ?? null;
}

// ... for each region of an atlas (its rectangle in uv units).
export function regionEvidence(
    geometry: SceneGeometry | undefined,
    checksum: number,
    w: number,
    h: number,
): (region: DelightRegion) => Evidence | null {
    return (r) => geometry?.evidence(checksum, { u0: r.x0 / w, u1: r.x1 / w, v0: r.y0 / h, v1: r.y1 / h }, r) ?? null;
}
