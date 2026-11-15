// delight.ts: synthetic textures - a known albedo times a known smooth shading recovered; a tiling texture stays
// seamless; atlas regions de-lit independently; a cut-out's transparent texels and alpha untouched; the same input
// gives the same bytes; the meshes' face orientations give the strength.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as scn from "thug2-level-converter-core/level_port/thug2_scene.ts";
import * as dl from "./delight.ts";

const W = 64;
const H = 64;
const lin = (b: number): number => (b / 255) ** 2.2;
const srgb = (v: number): number => Math.max(0, Math.min(255, Math.round(Math.max(0, v) ** (1 / 2.2) * 255)));

// a "surface": 8 x 8 blocks of a few paints with per-texel grain (deterministic), linear RGB
function albedo(x: number, y: number): [number, number, number] {
    const paints: [number, number, number][] = [
        [0.35, 0.3, 0.25],
        [0.3, 0.32, 0.36],
        [0.4, 0.22, 0.18],
    ];
    const p = paints[((x >> 3) + 2 * (y >> 3)) % 3]!;
    const grain = 1 + 0.15 * Math.sin(x * 2.3 + y * 1.7) * Math.cos(x * 0.9 - y * 2.1);
    return [p[0] * grain, p[1] * grain, p[2] * grain];
}

// smooth, periodic shading (a tile's painted light): x 0.5 - x 2
const shade = (x: number, y: number): number =>
    Math.exp(0.6 * Math.cos((2 * Math.PI * x) / W) * Math.cos((2 * Math.PI * y) / H));

function texture(f: (x: number, y: number) => [number, number, number], s = (_x: number, _y: number) => 1): Buffer {
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const [r, g, b] = f(x, y);
            const k = s(x, y);
            out.set([srgb(b * k), srgb(g * k), srgb(r * k), 255], (y * W + x) * 4);
        }
    return out;
}

const logLuma = (bgra: Uint8Array, i: number): number =>
    Math.log(0.2126 * lin(bgra[i * 4 + 2]!) + 0.7152 * lin(bgra[i * 4 + 1]!) + 0.0722 * lin(bgra[i * 4]!) + 0.001);

// the variance of the difference of two textures' log luminance (their means taken out)
function logDistance(a: Uint8Array, b: Uint8Array): number {
    const d: number[] = [];
    for (let i = 0; i < W * H; i++) d.push(logLuma(a, i) - logLuma(b, i));
    const mean = d.reduce((s, v) => s + v, 0) / d.length;
    return d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length;
}

test("a known albedo x a known smooth shading: the shading mostly removed, the albedo's detail kept", () => {
    const clean = texture(albedo);
    const lit = texture(albedo, shade);
    const result = dl.delight(lit, W, H, { wrapU: true, wrapV: true, strength: 1, limit: 4 });
    const before = logDistance(lit, clean);
    const after = logDistance(result.bgra, clean);
    assert.ok(after < 0.2 * before, `log distance to the albedo ${before.toFixed(4)} -> ${after.toFixed(4)}`);
    assert.ok(result.stats.shadingRemoved > 0.9, `shading removed ${result.stats.shadingRemoved}`);
    // (the removed layer follows the painted shading)
    let agree = 0;
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const truth = Math.log(shade(x, y));
            if (Math.abs(truth) > 0.3 && Math.sign(truth) === Math.sign(result.shading[y * W + x]!)) agree++;
        }
    let strong = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.abs(Math.log(shade(x, y))) > 0.3) strong++;
    assert.ok(agree / strong > 0.95, `the shading layer's sign agrees on ${agree} of ${strong}`);
    // chroma kept
    assert.ok(result.stats.chromaShift < 3, `chroma shift ${result.stats.chromaShift}`);
});

test("an unlit texture is changed little; a colour edge is kept as surface", () => {
    const clean = texture(albedo);
    const result = dl.delight(clean, W, H, { wrapU: true, wrapV: true, strength: 1 });
    assert.ok(result.stats.meanChange < 6, `mean change ${result.stats.meanChange}`);
    // a red half and a blue half of the same luminance: no shading across the edge
    const halves = texture((x) => (x < W / 2 ? [0.5, 0.1, 0.1] : [0.1, 0.1, 1.0]));
    const split = dl.delight(halves, W, H, { wrapU: false, wrapV: false, strength: 1 });
    assert.ok(split.stats.meanChange < 4, `two paints: mean change ${split.stats.meanChange}`);
    // a large dark panel with a sharp border, the same grey (a sign's black band): surface, kept
    const panel = texture((x, y) => (x >= 16 && x < 48 && y >= 8 && y < 40 ? [0.03, 0.03, 0.03] : [0.5, 0.5, 0.5]));
    const kept = dl.delight(panel, W, H, { wrapU: false, wrapV: false, strength: 1 });
    assert.ok(kept.stats.meanChange < 2, `a dark panel: mean change ${kept.stats.meanChange}`);
});

test("strength scales the removal; strength 0 and one colour change nothing", () => {
    const lit = texture(albedo, shade);
    const half = dl.delight(lit, W, H, { wrapU: true, wrapV: true, strength: 0.5, limit: 4 });
    const full = dl.delight(lit, W, H, { wrapU: true, wrapV: true, strength: 1, limit: 4 });
    assert.ok(half.stats.shadingRemoved > 0.4 && half.stats.shadingRemoved < full.stats.shadingRemoved);
    assert.deepEqual(dl.delight(lit, W, H, { wrapU: true, wrapV: true, strength: 0 }).bgra, lit);
    const flat = Buffer.alloc(W * H * 4, 0x80);
    assert.deepEqual(dl.delight(flat, W, H, { wrapU: true, wrapV: true }).bgra, flat);
});

test("the same input gives the same bytes", () => {
    const lit = texture(albedo, shade);
    const a = dl.delight(lit, W, H, { wrapU: true, wrapV: false, coherence: 0.3 });
    const b = dl.delight(Buffer.from(lit), W, H, { wrapU: true, wrapV: false, coherence: 0.3 });
    assert.deepEqual(a.bgra, b.bgra);
    assert.deepEqual(a.shading, b.shading);
});

// the mean RGB step between two columns (0 - 255)
function columnStep(bgra: Uint8Array, a: number, b: number): number {
    let s = 0;
    for (let y = 0; y < H; y++)
        for (let c = 0; c < 3; c++) s += Math.abs(bgra[(y * W + a) * 4 + c]! - bgra[(y * W + b) * 4 + c]!);
    return s / (3 * H);
}

test("a tiling texture stays seamless", () => {
    // periodic albedo grain plus a periodic broad shading, but lit off-centre (the light's peak near the edge)
    const lit = texture(
        (x, y) => {
            const g = 1 + 0.2 * Math.sin((2 * Math.PI * 5 * x) / W + y);
            return [0.4 * g, 0.35 * g, 0.3 * g];
        },
        (x, y) => Math.exp(0.7 * Math.cos((2 * Math.PI * (x - 3)) / W) + 0.3 * Math.sin((2 * Math.PI * y) / H)),
    );
    const result = dl.delight(lit, W, H, { wrapU: true, wrapV: true, strength: 1, limit: 4 });
    const steps: number[] = [];
    for (let x = 1; x < W; x++) steps.push(columnStep(result.bgra, x - 1, x));
    steps.sort((a, b) => a - b);
    const median = steps[steps.length >> 1]!;
    const seam = columnStep(result.bgra, W - 1, 0);
    assert.ok(seam <= 1.5 * steps[steps.length - 1]! && seam <= 2 * median + 3, `seam ${seam}, median ${median}`);
    assert.ok(result.stats.shadingRemoved > 0.8);
});

test("atlas regions are de-lit independently; texels outside them untouched", () => {
    const lit = texture(albedo, shade);
    const regions: dl.DelightRegion[] = [
        { x0: 0, y0: 0, x1: 32, y1: 64, wrapU: false, wrapV: false },
        { x0: 32, y0: 0, x1: 64, y1: 48, wrapU: false, wrapV: true },
    ];
    const a = dl.delightRegions(lit, W, H, regions, { strength: 1 });
    // region two's texels changed: region one's result the same, byte for byte
    const other = Buffer.from(lit);
    for (let y = 0; y < 48; y++) for (let x = 32; x < 64; x++) other[(y * W + x) * 4 + 1] = (x * 37 + y * 11) & 255;
    const b = dl.delightRegions(other, W, H, regions, { strength: 1 });
    for (let y = 0; y < H; y++)
        for (let x = 0; x < 32; x++)
            for (let c = 0; c < 4; c++) assert.equal(b.bgra[(y * W + x) * 4 + c], a.bgra[(y * W + x) * 4 + c]);
    // the strip below region two is in no region: as it was
    for (let y = 48; y < H; y++)
        for (let x = 32; x < 64; x++)
            for (let c = 0; c < 4; c++) assert.equal(a.bgra[(y * W + x) * 4 + c], lit[(y * W + x) * 4 + c]);
    // and region one de-lit on its own equals its part of the sheet
    const part = Buffer.alloc(32 * 64 * 4);
    for (let y = 0; y < 64; y++) lit.copy(part, y * 32 * 4, y * W * 4, (y * W + 32) * 4);
    const alone = dl.delight(part, 32, 64, { wrapU: false, wrapV: false, strength: 1 });
    for (let y = 0; y < 64; y++)
        assert.deepEqual(
            a.bgra.subarray(y * W * 4, (y * W + 32) * 4),
            alone.bgra.subarray(y * 32 * 4, (y + 1) * 32 * 4),
        );
});

test("a cut-out: transparent texels and every alpha untouched, the visible ones de-lit", () => {
    const lit = texture(albedo, shade);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
            if ((x - 32) ** 2 + (y - 32) ** 2 > 28 ** 2 || (x > 20 && x < 26)) {
                const i = (y * W + x) * 4;
                lit.set([0, 0, 0, 0], i);
            }
    const result = dl.delight(lit, W, H, { wrapU: false, wrapV: false, strength: 1 });
    let changed = 0;
    for (let i = 0; i < W * H; i++) {
        assert.equal(result.bgra[i * 4 + 3], lit[i * 4 + 3]);
        if (lit[i * 4 + 3] === 0)
            assert.deepEqual(result.bgra.subarray(i * 4, i * 4 + 4), lit.subarray(i * 4, i * 4 + 4));
        else if (result.bgra[i * 4 + 1] !== lit[i * 4 + 1]) changed++;
    }
    assert.ok(changed > 500, `visible texels changed: ${changed}`);
    assert.equal(result.shading[0], 0);
});

test("face orientations: one direction is coherent, a box's six sides are not; the strength follows", () => {
    // two quads (strips) facing +z for texture 1; a cube's six faces for texture 2
    const quad = (o: number[], u: number[], v: number[]): number[][] => [
        o,
        [o[0]! + u[0]!, o[1]! + u[1]!, o[2]! + u[2]!],
        [o[0]! + v[0]!, o[1]! + v[1]!, o[2]! + v[2]!],
        [o[0]! + u[0]! + v[0]!, o[1]! + u[1]! + v[1]!, o[2]! + u[2]! + v[2]!],
    ];
    const mesh = (material: number, quads: number[][][]) => {
        const vertices = quads.flat();
        const buffer = Buffer.alloc(vertices.length * 12);
        for (const [i, p] of vertices.entries())
            for (const [k, f] of p.entries()) buffer.writeFloatLE(f, i * 12 + 4 * k);
        // (each quad its own strip, joined by degenerate triangles)
        const strip: number[] = [];
        quads.forEach((_, q) => {
            const base = q * 4;
            if (q) strip.push(strip[strip.length - 1]!, base);
            if (strip.length % 2) strip.push(base);
            strip.push(base, base + 1, base + 2, base + 3);
        });
        return { material, buffers: [[0, buffer]], stride: 12, strips: [strip], vertexCount: vertices.length };
    };
    const pass = (texture: number) => ({ texture, flags: scn.PASS_TEXTURED });
    const cube = [
        quad([0, 0, 0], [1, 0, 0], [0, 1, 0]),
        quad([0, 0, 1], [0, 1, 0], [1, 0, 0]),
        quad([0, 0, 0], [0, 1, 0], [0, 0, 1]),
        quad([1, 0, 0], [0, 0, 1], [0, 1, 0]),
        quad([0, 0, 0], [0, 0, 1], [1, 0, 0]),
        quad([0, 1, 0], [1, 0, 0], [0, 0, 1]),
    ];
    const scene = {
        materials: [
            { checksum: 1, passes: [pass(0x100)] },
            { checksum: 2, passes: [pass(0x200)] },
        ],
        sectors: [
            {
                meshes: [
                    mesh(1, [quad([0, 0, 0], [1, 0, 0], [0, 1, 0]), quad([3, 0, 0], [2, 0, 0], [0, 2, 0])]),
                    mesh(2, cube),
                ],
            },
        ],
    } as unknown as scn.Scene;
    const found = dl.orientationsOf(dl.faceOrientations(scene));
    const floor = found.get(0x100)!;
    const box = found.get(0x200)!;
    assert.ok(Math.abs(floor.area - 5) < 1e-6, `area ${floor.area}`);
    assert.ok(floor.coherence > 0.99, `floor coherence ${floor.coherence}`);
    assert.ok(box.coherence < 0.05, `box coherence ${box.coherence}`);
    assert.ok(dl.strengthFor(floor.coherence) > dl.strengthFor(box.coherence));
    assert.equal(dl.strengthFor(null), 0.65);
});

test("the cache: written and read back the same", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delight-"));
    try {
        const lit = texture(albedo, shade);
        const options = { wrapU: true, wrapV: true };
        const result = dl.delight(lit, W, H, options);
        const key = dl.delightKey(lit, W, H, options);
        assert.equal(dl.readDelightCache(dir, key, W, H), null);
        dl.writeDelightCache(dir, key, W, H, result);
        const back = dl.readDelightCache(dir, key, W, H)!;
        assert.deepEqual(back.bgra, result.bgra);
        assert.deepEqual(back.shading, result.shading);
        assert.notEqual(dl.delightKey(lit, W, H, { ...options, strength: 0.9 }), key);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
