// NOT ORIGINAL - texture atlases for the base-game HD textures (base.ts): a texture with several unrelated pictures
// packed in it is upscaled one picture (region) at a time, so the model never sees - and never bleeds - a neighbour.
//
//   node tools/pipeline/hd_textures/atlas.ts --game <folder> [--levels BO,AU,foun] [--out <folder>]
//
// prints every dictionary's atlases (their regions, and what the old seam heuristic - base.detectAtlas - said of the
// same textures) and, with --out, a picture of each atlas with its regions outlined (<out>\<file>-<checksum>.png).
//
// How the regions are found: from the meshes, not the texels. Every scene / model file beside a dictionary (the
// level's .scn.xbx and its _net twin, the sky's, a model's .mdl.xbx / .skin.xbx) is read, and for every material pass
// that samples a texture (pass n reads the vertex's uv set n; an animated pass's other frames too) each triangle's uv
// rectangle is taken:
// - a clamped axis (the pass's u / v address mode 1) is cut to 0..1;
// - a wrapped axis (0) is moved by whole tiles into 0..1 when the triangle fits in one tile; one that spans more than
//   a tile (or crosses a tile's edge) uses the whole axis and the region it lands in wraps that way (a tiling strip: a
//   trim sheet's row) - its padding is then its own other edge, as the whole texture's is;
// - environment-mapped and uv-wibbled passes (generated / scrolling coordinates) use the whole texture: not an atlas.
// The rectangles in texels (a quarter texel inside each edge, so a picture's exact border is not its neighbour's) that
// share a texel are one region, regions that touch along an edge are one when the texels across it are continuous
// (no harder a step than the texture's typical one: the same picture), and the merging repeats until nothing changes.
// Each region's edges are then moved out to a multiple of 4 texels (else 2, else left) where that doesn't make it
// overlap another, so its border stays on DXT blocks down to the original size's mip. A texture with one region
// covering most of it (85 %), or any region covering all of it, is not an atlas; one no mesh uses is left to the old
// heuristic and listed.
//
// How an atlas is upscaled (atlasTexels): each region cut out and sent to the model alone, padded with its own edge
// texels (clamped; its own other edge on a wrapped axis) as core pads a whole texture; the model's output cropped and
// put in the upscaled sheet at the scaled position; the texels no region covers filled bilinearly from the original
// (never sampled; they only keep the sheet whole). Alpha as core does it, per region. Back-projection to the original
// (core's matchOriginal) per region too, so no correction crosses a border. The mip chain is made region-aware
// (regionMips): a smaller texel averages only the texels of one region - the one most of its 2 x 2 belong to - so no
// colour crosses a border at any level where the regions are still apart.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as dxt from "thug2-level-converter-core/level_port/dxt.ts";
import * as hd from "thug2-level-converter-core/level_port/hd_textures.ts";
import { readTex, type Texture } from "thug2-level-converter-core/level_port/tex.ts";
import * as scn from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { exitWith, helpFromHeader, isMain, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { encodePng, type Image } from "thug2-level-converter-core/lib/frame_diff.ts";

// bumped whenever the regions or the atlas pass change for the same input (base.ts's file cache keys on it)
export const ATLAS_VERSION = 1;
// a single region covering this much of the texture is the texture (not an atlas)
export const WHOLE = 0.85;

// ---- the uv rectangles ----

// One triangle's uv rectangle (texture units) and how the pass addresses the texture.
export interface UvUse {
    u0: number;
    u1: number;
    v0: number;
    v1: number;
    clampU: boolean;
    clampV: boolean;
    whole?: boolean; // generated / scrolling coordinates: the whole texture, tiled
}

export type UvIndex = Map<number, UvUse[]>;

const PASS_WHOLE = scn.PASS_ENVIRONMENT | scn.PASS_UV_WIBBLE;

// The uv rectangles a scene's meshes use, per texture checksum (each distinct rectangle once).
export function sceneUses(scene: scn.Scene, index: UvIndex = new Map()): UvIndex {
    const materials = new Map(scene.materials.map((m) => [m.checksum, m]));
    const seen = new Map<number, Set<string>>();
    const add = (texture: number, use: UvUse): void => {
        let keys = seen.get(texture);
        if (!keys) {
            keys = new Set();
            seen.set(texture, keys);
        }
        const key = `${use.u0},${use.u1},${use.v0},${use.v1},${+use.clampU},${+use.clampV},${+!!use.whole}`;
        if (keys.has(key)) return;
        keys.add(key);
        let list = index.get(texture);
        if (!list) {
            list = [];
            index.set(texture, list);
        }
        list.push(use);
    };
    for (const sector of scene.sectors) {
        for (const mesh of sector.meshes) {
            const material = materials.get(mesh.material);
            if (!material) continue;
            const buffer = mesh.buffers[0]?.[1];
            const stride = mesh.stride;
            const uvAt = mesh.offsets[2] ?? 0;
            const shader = mesh.vertexShader[0] ?? 0;
            // (a built-in shader - skinned - has its uvs last; an FVF says how many sets)
            const room = uvAt > 0 && stride > uvAt ? Math.floor((stride - uvAt) / 8) : 0;
            const sets = shader > 6 ? Math.min(room, (shader >>> scn.FVF_TEXCOUNT_SHIFT) & 0xf) : room;
            material.passes.forEach((pass, n) => {
                const textures = [pass.texture];
                // (an animated pass's frames: {time, texture})
                for (const key of pass.animation?.[3] ?? []) if (key[1] !== undefined) textures.push(key[1]);
                const wanted = textures.filter((t) => t !== 0);
                if (!wanted.length) return;
                const clampU = pass.uAddress !== 0;
                const clampV = pass.vAddress !== 0;
                if (pass.flags & PASS_WHOLE || !buffer || !sets || !(sector.flags & scn.SEC_TEXCOORDS)) {
                    if (pass.flags & PASS_WHOLE)
                        for (const t of wanted) add(t, { u0: 0, u1: 1, v0: 0, v1: 1, clampU, clampV, whole: true });
                    return;
                }
                const at = uvAt + 8 * Math.min(n, sets - 1);
                const uv = (i: number): [number, number] => [
                    buffer.readFloatLE(i * stride + at),
                    buffer.readFloatLE(i * stride + at + 4),
                ];
                const strip = mesh.strips[0] ?? [];
                for (let k = 0; k + 2 < strip.length; k++) {
                    const a = strip[k]!;
                    const b = strip[k + 1]!;
                    const c = strip[k + 2]!;
                    if (a === b || b === c || a === c) continue;
                    if (Math.max(a, b, c) >= mesh.vertexCount || (Math.max(a, b, c) + 1) * stride > buffer.length)
                        continue;
                    const [ua, va] = uv(a);
                    const [ub, vb] = uv(b);
                    const [uc, vc] = uv(c);
                    if (![ua, va, ub, vb, uc, vc].every(Number.isFinite)) continue;
                    const use: UvUse = {
                        u0: Math.min(ua, ub, uc),
                        u1: Math.max(ua, ub, uc),
                        v0: Math.min(va, vb, vc),
                        v1: Math.max(va, vb, vc),
                        clampU,
                        clampV,
                    };
                    for (const t of wanted) add(t, use);
                }
            });
        }
    }
    return index;
}

// The scene / model files whose meshes may use a dictionary's textures: every one in its folder.
export function sceneFiles(dictionary: string): string[] {
    const dir = path.dirname(dictionary);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => /\.(scn|mdl|skin)\.xbx$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f));
}

// The uv index of the scene files beside a dictionary (memoised per folder) and the files' signature (their SHA-256s:
// base.ts's file cache keys on it - a changed scene can change the regions).
export class UvIndexes {
    private readonly folders = new Map<string, { index: UvIndex; signature: string; errors: string[] }>();

    of(dictionary: string): { index: UvIndex; signature: string; errors: string[] } {
        const dir = path.dirname(dictionary).toLowerCase();
        let entry = this.folders.get(dir);
        if (!entry) {
            const index: UvIndex = new Map();
            const h = createHash("sha256");
            h.update(`atlas ${ATLAS_VERSION}`);
            const errors: string[] = [];
            for (const file of sceneFiles(dictionary)) {
                const bytes = fs.readFileSync(file);
                h.update(path.basename(file).toLowerCase());
                h.update(bytes);
                try {
                    sceneUses(scn.readScene(bytes, file), index);
                } catch (e) {
                    errors.push(`${path.basename(file)}: ${(e as Error).message}`);
                }
            }
            entry = { index, signature: h.digest("hex"), errors };
            this.folders.set(dir, entry);
        }
        return entry;
    }
}

// ---- regions ----

// A rectangle of texels (x1, y1 exclusive) and how its padding is made: wrapped (its own other edge) or clamped.
export interface Region {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    wrapU: boolean;
    wrapV: boolean;
}

const area = (r: Region): number => (r.x1 - r.x0) * (r.y1 - r.y0);
const overlaps = (a: Region, b: Region): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const union = (a: Region, b: Region): Region => ({
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    wrapU: a.wrapU || b.wrapU,
    wrapV: a.wrapV || b.wrapV,
});

// One axis of a uv rectangle in texels [start, end) and whether it tiles (the whole axis, wrapped).
function axis(t0: number, t1: number, clamp: boolean, size: number): [number, number, boolean] {
    const eps = 0.25 / size;
    let a: number;
    let b: number;
    if (clamp) {
        a = Math.min(1, Math.max(0, t0));
        b = Math.min(1, Math.max(0, t1));
    } else {
        const tile = Math.floor(t0 + eps);
        if (t1 - tile > 1 + eps) return [0, size, true];
        a = Math.max(0, t0 - tile);
        b = Math.min(1, t1 - tile);
    }
    let start = Math.floor(a * size + 0.25);
    let end = Math.ceil(b * size - 0.25);
    start = Math.min(Math.max(0, start), size - 1);
    end = Math.max(start + 1, Math.min(size, end));
    return [start, end, false];
}

export function useRect(use: UvUse, w: number, h: number): Region {
    if (use.whole) return { x0: 0, y0: 0, x1: w, y1: h, wrapU: !use.clampU, wrapV: !use.clampV };
    const [x0, x1, wrapU] = axis(use.u0, use.u1, use.clampU, w);
    const [y0, y1, wrapV] = axis(use.v0, use.v1, use.clampV, h);
    return { x0, y0, x1, y1, wrapU, wrapV };
}

// The rectangles that share a texel merged (union-find over a texel grid), as their bounding boxes; repeated while a
// merged box overlaps another.
function mergeOverlapping(rects: Region[], w: number, h: number): Region[] {
    let current = rects;
    for (;;) {
        const parent = current.map((_, i) => i);
        const find = (i: number): number => {
            while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
            return i;
        };
        const owner = new Int32Array(w * h).fill(-1);
        current.forEach((r, i) => {
            for (let y = r.y0; y < r.y1; y++)
                for (let x = r.x0; x < r.x1; x++) {
                    const o = owner[y * w + x]!;
                    if (o < 0) owner[y * w + x] = i;
                    else {
                        const a = find(o);
                        const b = find(i);
                        if (a !== b) parent[b] = a;
                    }
                }
        });
        const groups = new Map<number, Region>();
        current.forEach((r, i) => {
            const root = find(i);
            const g = groups.get(root);
            groups.set(root, g ? union(g, r) : r);
        });
        const next = [...groups.values()];
        if (next.length === current.length) return next;
        current = next;
    }
}

// The mean RGB step (0-255) between texel lines across a shared border: a column pair (vertical border at x) over
// rows y0..y1, or a row pair.
function borderStep(bgra: Uint8Array, w: number, vertical: boolean, at: number, from: number, to: number): number {
    let sum = 0;
    for (let k = from; k < to; k++) {
        const i = vertical ? (k * w + at - 1) * 4 : ((at - 1) * w + k) * 4;
        const j = vertical ? (k * w + at) * 4 : (at * w + k) * 4;
        sum +=
            Math.abs(bgra[i]! - bgra[j]!) +
            Math.abs(bgra[i + 1]! - bgra[j + 1]!) +
            Math.abs(bgra[i + 2]! - bgra[j + 2]!);
    }
    return sum / (3 * Math.max(1, to - from));
}

function typicalStep(bgra: Uint8Array, w: number, h: number): number {
    const steps: number[] = [];
    for (let x = 1; x < w; x++) steps.push(borderStep(bgra, w, true, x, 0, h));
    for (let y = 1; y < h; y++) steps.push(borderStep(bgra, w, false, y, 0, w));
    steps.sort((a, b) => a - b);
    return steps[Math.floor(steps.length / 2)] ?? 0;
}

// Regions touching along an edge merged when the texels across it are continuous (the same picture cut by the uvs).
function mergeContinuous(regions: Region[], bgra: Uint8Array, w: number, h: number): Region[] {
    const limit = 2 * typicalStep(bgra, w, h) + 3;
    let current = regions;
    for (let changed = true; changed; ) {
        changed = false;
        outer: for (let i = 0; i < current.length; i++)
            for (let j = i + 1; j < current.length; j++) {
                const a = current[i]!;
                const b = current[j]!;
                let step: number | null = null;
                const yFrom = Math.max(a.y0, b.y0);
                const yTo = Math.min(a.y1, b.y1);
                const xFrom = Math.max(a.x0, b.x0);
                const xTo = Math.min(a.x1, b.x1);
                if (yTo > yFrom && (a.x1 === b.x0 || b.x1 === a.x0))
                    step = borderStep(bgra, w, true, a.x1 === b.x0 ? a.x1 : b.x1, yFrom, yTo);
                else if (xTo > xFrom && (a.y1 === b.y0 || b.y1 === a.y0))
                    step = borderStep(bgra, w, false, a.y1 === b.y0 ? a.y1 : b.y1, xFrom, xTo);
                if (step === null || step > limit) continue;
                current = mergeOverlapping([...current.filter((_, k) => k !== i && k !== j), union(a, b)], w, h);
                changed = true;
                break outer;
            }
    }
    return current;
}

// Each region's edges moved out to a multiple of 4 texels (else 2) where it then overlaps no other region.
function alignToBlocks(regions: Region[], w: number, h: number): Region[] {
    const out = regions.map((r) => ({ ...r }));
    out.forEach((r, i) => {
        for (const a of [4, 2]) {
            const moved: Region = {
                ...r,
                x0: Math.floor(r.x0 / a) * a,
                y0: Math.floor(r.y0 / a) * a,
                x1: Math.min(w, Math.ceil(r.x1 / a) * a),
                y1: Math.min(h, Math.ceil(r.y1 / a) * a),
            };
            if (out.every((o, k) => k === i || !overlaps(moved, o))) {
                out[i] = moved;
                return;
            }
        }
    });
    return out;
}

export type RegionResult =
    | { kind: "atlas"; regions: Region[] }
    | { kind: "whole"; why: string }
    | { kind: "unreferenced" };

// A texture's regions from the uv rectangles its meshes use (bgra: its top level, for the continuity test).
export function findRegions(uses: readonly UvUse[], bgra: Uint8Array, w: number, h: number): RegionResult {
    if (!uses.length) return { kind: "unreferenced" };
    const rects = new Map<string, Region>();
    for (const use of uses) {
        const r = useRect(use, w, h);
        if (r.x0 === 0 && r.y0 === 0 && r.x1 === w && r.y1 === h)
            return { kind: "whole", why: "a mesh uses all of it" };
        rects.set(`${r.x0},${r.y0},${r.x1},${r.y1},${+r.wrapU},${+r.wrapV}`, r);
    }
    const filled = hd.fillHidden(bgra, w, h, true, true);
    let regions = mergeOverlapping([...rects.values()], w, h);
    regions = mergeContinuous(regions, filled, w, h);
    regions = alignToBlocks(regions, w, h);
    regions = mergeOverlapping(regions, w, h);
    if (regions.some((r) => area(r) >= w * h)) return { kind: "whole", why: "its regions join up" };
    if (regions.length === 1 && area(regions[0]!) >= WHOLE * w * h)
        return { kind: "whole", why: "one region covers most of it" };
    regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    return { kind: "atlas", regions };
}

// ---- upscaling one atlas ----

export function crop(bgra: Uint8Array, w: number, r: Region): Buffer {
    const rw = r.x1 - r.x0;
    const out = Buffer.alloc(rw * (r.y1 - r.y0) * 4);
    for (let y = r.y0; y < r.y1; y++)
        Buffer.from(bgra.buffer, bgra.byteOffset + (y * w + r.x0) * 4, rw * 4).copy(out, (y - r.y0) * rw * 4);
    return out;
}

function paste(sheet: Buffer, sw: number, part: Uint8Array, pw: number, ph: number, x0: number, y0: number): void {
    for (let y = 0; y < ph; y++)
        Buffer.from(part.buffer, part.byteOffset + y * pw * 4, pw * 4).copy(sheet, ((y0 + y) * sw + x0) * 4);
}

// BGRA enlarged `scale` times bilinearly (clamped at the edges): the sheet under the regions.
export function bilinear(bgra: Uint8Array, w: number, h: number, scale: number): Buffer {
    const ow = w * scale;
    const oh = h * scale;
    const out = Buffer.alloc(ow * oh * 4);
    const at = (x: number, y: number, k: number): number =>
        bgra[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + k]!;
    for (let y = 0; y < oh; y++) {
        const fy = (y + 0.5) / scale - 0.5;
        const y0 = Math.floor(fy);
        const ty = fy - y0;
        for (let x = 0; x < ow; x++) {
            const fx = (x + 0.5) / scale - 0.5;
            const x0 = Math.floor(fx);
            const tx = fx - x0;
            for (let k = 0; k < 4; k++)
                out[(y * ow + x) * 4 + k] = Math.round(
                    (at(x0, y0, k) * (1 - tx) + at(x0 + 1, y0, k) * tx) * (1 - ty) +
                        (at(x0, y0 + 1, k) * (1 - tx) + at(x0 + 1, y0 + 1, k) * tx) * ty,
                );
        }
    }
    return out;
}

export interface RegionJob {
    region: Region;
    w: number; // the region's size in texels
    h: number;
    bgra: Buffer; // its texels
    kind: hd.AlphaKind;
    wrapU: boolean;
    wrapV: boolean;
    scale: number;
    key: string;
}

export function regionJobs(
    bgra: Uint8Array,
    w: number,
    regions: readonly Region[],
    scale: number,
    model: string,
): RegionJob[] {
    return regions.map((region) => {
        const rw = region.x1 - region.x0;
        const rh = region.y1 - region.y0;
        const part = crop(bgra, w, region);
        const kind = hd.alphaKind(part);
        const h = createHash("sha256");
        h.update(
            JSON.stringify({
                atlas: ATLAS_VERSION,
                pass: hd.PASS_VERSION,
                model,
                scale,
                pad: hd.PAD,
                wrapU: region.wrapU,
                wrapV: region.wrapV,
                w: rw,
                h: rh,
                kind,
            }),
        );
        h.update(part);
        return {
            region,
            w: rw,
            h: rh,
            bgra: part,
            kind,
            wrapU: region.wrapU,
            wrapV: region.wrapV,
            scale,
            key: h.digest("hex"),
        };
    });
}

// The region's images for the model (core's: colour padded with its own edges, soft alpha as grey).
export const regionInputs = (job: RegionJob): Map<string, Image> => hd.jobInputs(job, job.w, job.h);

// The region's upscaled texels from the model's outputs (core's: cropped back, alpha per kind).
export const regionResult = (job: RegionJob, outputs: Map<string, Image>): Buffer =>
    hd.jobResult(job, job.w, job.h, outputs);

// The upscaled sheet from the regions' upscaled texels (the model's own, as cached): the bilinear sheet under them,
// each region's (pulled back to its own original texels when `match`) put at its scaled place. Returns the texels and
// the region of each texel (-1: none).
export function atlasTexels(
    bgra: Uint8Array,
    w: number,
    h: number,
    jobs: readonly RegionJob[],
    results: readonly Uint8Array[],
    scale: number,
    match: boolean,
): { bgra: Buffer; labels: Int32Array } {
    const ow = w * scale;
    const oh = h * scale;
    const sheet = bilinear(hd.fillHidden(bgra, w, h, false, false), w, h, scale);
    const labels = new Int32Array(ow * oh).fill(-1);
    jobs.forEach((job, n) => {
        let part: Buffer = Buffer.from(results[n]!);
        if (match) {
            const original =
                job.kind === "opaque" ? job.bgra : hd.fillHidden(job.bgra, job.w, job.h, job.wrapU, job.wrapV);
            part = hd.matchOriginal(part, original, job.w, job.h, scale, job.wrapU, job.wrapV, job.kind === "smooth");
        }
        const x0 = job.region.x0 * scale;
        const y0 = job.region.y0 * scale;
        paste(sheet, ow, part, job.w * scale, job.h * scale, x0, y0);
        for (let y = 0; y < job.h * scale; y++) labels.fill(n, (y0 + y) * ow + x0, (y0 + y) * ow + x0 + job.w * scale);
    });
    return { bgra: sheet, labels };
}

// The next mip level, region-aware: each smaller texel belongs to the region most of its 2 x 2 belong to (ties: the
// first in reading order; -1 only when none does) and averages only that region's texels.
export function regionMipDown(
    level: Uint8Array,
    labels: Int32Array,
    w: number,
    h: number,
): { bgra: Buffer; labels: Int32Array } {
    const nw = Math.max(1, Math.floor(w / 2));
    const nh = Math.max(1, Math.floor(h / 2));
    const out = Buffer.alloc(nw * nh * 4);
    const outLabels = new Int32Array(nw * nh);
    const idx = [0, 0, 0, 0];
    for (let y = 0; y < nh; y++)
        for (let x = 0; x < nw; x++) {
            const x0 = Math.min(w - 1, 2 * x);
            const y0 = Math.min(h - 1, 2 * y);
            const x1 = Math.min(w - 1, 2 * x + 1);
            const y1 = Math.min(h - 1, 2 * y + 1);
            idx[0] = y0 * w + x0;
            idx[1] = y0 * w + x1;
            idx[2] = y1 * w + x0;
            idx[3] = y1 * w + x1;
            let best = -1;
            let bestCount = 0;
            for (let a = 0; a < 4; a++) {
                const l = labels[idx[a]!]!;
                if (l < 0) continue;
                let count = 0;
                for (let b = 0; b < 4; b++) if (labels[idx[b]!] === l) count++;
                if (count > bestCount) {
                    best = l;
                    bestCount = count;
                }
            }
            const o = (y * nw + x) * 4;
            outLabels[y * nw + x] = best;
            const sum = [0, 0, 0, 0];
            let n = 0;
            for (let a = 0; a < 4; a++) {
                if (labels[idx[a]!] !== best) continue;
                for (let k = 0; k < 4; k++) sum[k]! += level[idx[a]! * 4 + k]!;
                n++;
            }
            for (let k = 0; k < 4; k++) out[o + k] = Math.round(sum[k]! / n);
        }
    return { bgra: out, labels: outLabels };
}

// The texture rewritten at its new size from the sheet: as core's rebuild (format kept or made DXT, as many levels),
// with the region-aware mips.
export function rebuildAtlas(t: Texture, bgra: Buffer, labels: Int32Array, scale: number, format = 0): void {
    if (format) t.dxt = format;
    const w = t.width * scale;
    const h = t.height * scale;
    const count =
        t.levels.length <= 1
            ? 1
            : Math.min(t.levels.length + Math.log2(scale), Math.floor(Math.log2(Math.min(w, h))) + 1);
    const levels: Buffer[] = [];
    let level = bgra;
    let lab = labels;
    let lw = w;
    let lh = h;
    for (let n = 0; n < count; n++) {
        if (n > 0) {
            const next = regionMipDown(level, lab, lw, lh);
            level = next.bgra;
            lab = next.labels;
            lw = Math.max(1, Math.floor(lw / 2));
            lh = Math.max(1, Math.floor(lh / 2));
        }
        levels.push(t.dxt === 0 ? level : dxt.encode(level, lw, lh, t.dxt));
    }
    t.width = w;
    t.height = h;
    t.levels = levels;
}

// ---- the regions' cache (beside core's texels: the model's own output per region) ----

const cacheFile = (dir: string, key: string): string => path.join(dir, key.slice(0, 2), `${key}.region.gz`);

export function readRegionCache(dir: string, job: RegionJob): Buffer | null {
    const file = cacheFile(dir, job.key);
    if (!fs.existsSync(file)) return null;
    try {
        const data = zlib.gunzipSync(fs.readFileSync(file));
        const w = job.w * job.scale;
        const h = job.h * job.scale;
        if (data.length !== 8 + w * h * 4 || data.readUInt32LE(0) !== w || data.readUInt32LE(4) !== h) return null;
        return data.subarray(8);
    } catch {
        return null;
    }
}

export function writeRegionCache(dir: string, job: RegionJob, bgra: Uint8Array): void {
    const file = cacheFile(dir, job.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const head = Buffer.alloc(8);
    head.writeUInt32LE(job.w * job.scale, 0);
    head.writeUInt32LE(job.h * job.scale, 4);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, zlib.gzipSync(Buffer.concat([head, bgra]), { level: 6 }));
    fs.renameSync(temp, file);
}

// A whole pass over atlases: every region the cache lacks through the model in one call, then each texture rebuilt.
export interface AtlasItem {
    texture: Texture;
    regions: Region[];
}

export function upscaleAtlases(
    items: readonly AtlasItem[],
    options: hd.HdOptions,
    upscaler: hd.Upscaler,
): { upscaled: number; regions: number; generated: number } {
    const work = items.map((item) => {
        const t = item.texture;
        const bgra = hd.topLevel(t);
        const scale = hd.scaleFor(t.width, t.height, options);
        return {
            item,
            bgra,
            scale,
            kind: hd.alphaKind(bgra),
            jobs: regionJobs(bgra, t.width, item.regions, scale, options.model),
        };
    });
    const results = new Map<RegionJob, Buffer>();
    const missing: RegionJob[] = [];
    for (const w of work)
        for (const job of w.jobs) {
            const hit = readRegionCache(options.cacheDir, job);
            if (hit) results.set(job, hit);
            else if (!missing.includes(job)) missing.push(job);
        }
    if (missing.length) {
        const inputs = new Map<string, Image>();
        missing.forEach((job, n) => {
            for (const [part, img] of regionInputs(job)) inputs.set(`r${n}_${part}`, img);
        });
        const outputs = upscaler(inputs, options);
        missing.forEach((job, n) => {
            const mine = new Map<string, Image>();
            for (const part of ["rgb", "alpha"]) {
                const img = outputs.get(`r${n}_${part}`);
                if (img) mine.set(part, img);
            }
            const bgra = regionResult(job, mine);
            writeRegionCache(options.cacheDir, job, bgra);
            results.set(job, bgra);
        });
    }
    let regions = 0;
    for (const w of work) {
        const t = w.item.texture;
        const sheet = atlasTexels(
            w.bgra,
            t.width,
            t.height,
            w.jobs,
            w.jobs.map((j) => results.get(j)!),
            w.scale,
            options.match,
        );
        rebuildAtlas(t, sheet.bgra, sheet.labels, w.scale, hd.compressFormat(t, w.kind, options, w.scale));
        regions += w.jobs.length;
    }
    return { upscaled: work.length, regions, generated: missing.length };
}

// ---- the report tool ----

// The regions outlined on the texture (x4, nearest): each region's border in a colour of its own.
export function outlinePicture(bgra: Uint8Array, w: number, h: number, regions: readonly Region[]): Image {
    const s = 4;
    const ow = w * s;
    const oh = h * s;
    const rgb = new Uint8Array(ow * oh * 3);
    for (let y = 0; y < oh; y++)
        for (let x = 0; x < ow; x++) {
            const i = ((y >> 2) * w + (x >> 2)) * 4;
            const a = bgra[i + 3]! / 255;
            const check = ((x >> 4) + (y >> 4)) & 1 ? 200 : 150;
            const o = (y * ow + x) * 3;
            rgb[o] = Math.round(bgra[i + 2]! * a + check * (1 - a));
            rgb[o + 1] = Math.round(bgra[i + 1]! * a + check * (1 - a));
            rgb[o + 2] = Math.round(bgra[i]! * a + check * (1 - a));
        }
    const colours = [
        [255, 0, 255],
        [0, 255, 255],
        [255, 255, 0],
        [0, 255, 0],
        [255, 128, 0],
        [0, 128, 255],
    ];
    regions.forEach((r, n) => {
        const c = colours[n % colours.length]!;
        const set = (x: number, y: number): void => {
            if (x < 0 || y < 0 || x >= ow || y >= oh) return;
            rgb.set(c, (y * ow + x) * 3);
        };
        for (let x = r.x0 * s; x < r.x1 * s; x++) {
            set(x, r.y0 * s);
            set(x, r.y1 * s - 1);
        }
        for (let y = r.y0 * s; y < r.y1 * s; y++) {
            set(r.x0 * s, y);
            set(r.x1 * s - 1, y);
        }
    });
    return { width: ow, height: oh, rgb };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const args = [...argv];
    const take = (name: string): string | undefined => {
        const at = args.indexOf(name);
        if (at < 0) return undefined;
        const value = args[at + 1];
        args.splice(at, 2);
        return value;
    };
    const game = take("--game");
    if (!game) exitWith("usage: atlas.ts --game <folder> [--levels BO,AU,foun] [--out <folder>]");
    const levels = take("--levels");
    const out = take("--out");
    // (imported here: base.ts imports this module)
    const base = await import("./base.ts");
    const root = base.gameRoot(game);
    const entries = base.collect(root, "levels", levels ? levels.split(",") : null);
    const indexes = new UvIndexes();
    if (out) fs.mkdirSync(out, { recursive: true });
    let atlases = 0;
    let heuristic = 0;
    let unreferenced = 0;
    for (const e of entries) {
        const tex = readTex(base.originalBytes(root, e), e.rel);
        const { index, errors } = indexes.of(path.join(root, e.rel));
        for (const err of errors) print(`  ${e.rel}: scene not read: ${err}`);
        for (const t of tex.textures) {
            if (!base.handledTexture(t)) continue;
            const bgra = hd.topLevel(t);
            const old = base.detectAtlas(bgra, t.width, t.height);
            if (old) heuristic++;
            const found = findRegions(index.get(t.checksum) ?? [], bgra, t.width, t.height);
            const name = `${e.rel} ${t.checksum.toString(16).padStart(8, "0")} ${t.width}x${t.height}`;
            if (found.kind === "unreferenced") {
                unreferenced++;
                print(`${name}: no mesh uses it${old ? ` (heuristic: atlas, ${old})` : ""}`);
                continue;
            }
            if (found.kind === "whole") {
                if (old) print(`${name}: not an atlas - ${found.why} (heuristic said: ${old})`);
                continue;
            }
            atlases++;
            const list = found.regions
                .map((r) => `${r.x0},${r.y0}-${r.x1},${r.y1}${r.wrapU ? " wu" : ""}${r.wrapV ? " wv" : ""}`)
                .join("; ");
            print(
                `${name}: ${found.regions.length} regions [${list}]${old ? ` (heuristic: ${old})` : " (heuristic: none)"}`,
            );
            if (out) {
                const file = `${path.basename(e.rel).replace(/\.tex\.xbx$/i, "")}-${t.checksum.toString(16).padStart(8, "0")}.png`;
                fs.writeFileSync(
                    path.join(out, file),
                    encodePng(outlinePicture(bgra, t.width, t.height, found.regions)),
                );
            }
        }
    }
    print(`atlases by uv: ${atlases}; by the seam heuristic: ${heuristic}; textures no mesh uses: ${unreferenced}`);
    return 0;
}

if (isMain(import.meta.url)) helpFromHeader(import.meta.url);
if (isMain(import.meta.url)) await runMain(() => main());
