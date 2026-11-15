// delight.ts (version 2): synthetic textures - a known albedo times a known gradient, corner occlusion or shadow band
// recovered when the level's evidence agrees; an albedo with only material blotches, stripes or ripples left exactly as
// it is; tiled textures seamless (the one-way tiled direction untouched); atlas regions independent; cut-outs'
// transparent texels untouched and cut-outs skipped; the level's evidence (delight_geometry.ts) read from a scene; the
// same input gives the same bytes; the cache keys on the version and the evidence.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as scn from "thug2-level-converter-core/level_port/thug2_scene.ts";
import * as dl from "./delight.ts";
import { pointTriangleDistance, SceneGeometry } from "./delight_geometry.ts";

const W = 64;
const H = 64;
const lin = (b: number): number => (b / 255) ** 2.2;
const srgb = (v: number): number => Math.max(0, Math.min(255, Math.round(Math.max(0, v) ** (1 / 2.2) * 255)));

// a "surface": 8 x 8 blocks of a few paints of one brightness with per-texel grain (deterministic), linear RGB
function albedo(x: number, y: number): [number, number, number] {
    const paints: [number, number, number][] = [
        [0.36, 0.3, 0.24],
        [0.3, 0.31, 0.34],
        [0.33, 0.3, 0.27],
    ];
    const p = paints[((x >> 3) + 2 * (y >> 3)) % 3]!;
    const grain = 1 + 0.12 * Math.sin(x * 2.3 + y * 1.7) * Math.cos(x * 0.9 - y * 2.1);
    return [p[0] * grain, p[1] * grain, p[2] * grain];
}

type Shade = (x: number, y: number) => number;

// light falling off down the picture (brighter at the top, the sky's side): x 1.5 at the top - x 0.67 at the foot
const gradient: Shade = (_x, y) => Math.exp(-0.8 * ((y + 0.5) / H - 0.5));
// occlusion toward the left and bottom borders (a corner where a wall meets the floor and another wall)
const corner: Shade = (x, y) =>
    Math.exp(-0.6 * Math.exp(-(x + 0.5) / W / 0.08) - 0.7 * Math.exp(-(1 - (y + 0.5) / H) / 0.1));
// a shadow band under a ledge a little below half height (not on a paint block's border: a colour edge there is surface)
const band: Shade = (_x, y) => {
    const d = (y + 0.5) / H - 34 / 64;
    return d < 0 ? 1 : Math.exp(-0.7 * Math.exp(-d / 0.08));
};

function texture(f: (x: number, y: number) => [number, number, number], s: Shade = () => 1): Buffer {
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

const line = (axis: "x" | "y", at: number, side = at === 0 ? 1 : at === 1 ? -1 : 0, meets = 1): dl.Line => ({
    axis,
    at,
    side,
    meets,
    length: 1,
});

// everything the level could say: up is the top of the picture, every border and the middle line meet something
const everything: dl.Evidence = {
    light: [0, -1],
    lines: [line("x", 0), line("x", 1), line("y", 0), line("y", 1), line("y", 0.5, 1)],
    faces: 2,
};

function recovered(shade: Shade, evidence: dl.Evidence, kind: dl.TermKind): void {
    const clean = texture(albedo);
    const lit = texture(albedo, shade);
    const result = dl.delight(lit, W, H, { wrapU: false, wrapV: false, evidence, strength: 1 });
    const why = result.stats.terms.map((t) => `${t.name}: ${t.why}`).join("; ");
    assert.ok(result.stats.changed, `${result.stats.verdict} - ${why}`);
    assert.ok(
        result.stats.terms.some((t) => t.taken && t.kind === kind),
        result.stats.terms.map((t) => `${t.name}: ${t.why}`).join("; "),
    );
    const before = logDistance(lit, clean);
    const after = logDistance(result.bgra, clean);
    assert.ok(after < 0.25 * before, `log distance to the albedo ${before.toFixed(4)} -> ${after.toFixed(4)}`);
    assert.ok(result.stats.chromaShift < 3, `chroma shift ${result.stats.chromaShift}`);
}

test("albedo x a gradient brightening toward the sky: recovered", () => {
    recovered(gradient, { light: [0, -1], lines: [], faces: 2 }, "gradient");
});

test("albedo x corner occlusion where the level has surfaces meeting the borders: recovered", () => {
    recovered(corner, { light: null, lines: [line("x", 0), line("y", 1)], faces: 2 }, "edge");
});

test("albedo x a shadow band under a line where surfaces meet: recovered", () => {
    recovered(band, { light: null, lines: [line("y", 34 / 64, 1)], faces: 2 }, "band");
});

test("the same light without the level's agreement is left exactly as it is", () => {
    const lit = texture(albedo, corner);
    // no geometry at all; borders where nothing meets; the sky on the other side
    for (const evidence of [
        null,
        { light: null, lines: [line("x", 0, 1, 0), line("y", 1, -1, 0)], faces: 2 } as dl.Evidence,
    ])
        assert.deepEqual(dl.delight(lit, W, H, { wrapU: false, wrapV: false, evidence }).bgra, lit);
    const up = texture(albedo, gradient);
    const result = dl.delight(up, W, H, {
        wrapU: false,
        wrapV: false,
        evidence: { light: [0, 1], lines: [], faces: 2 },
    });
    assert.deepEqual(result.bgra, up);
    assert.match(result.stats.terms.find((t) => t.kind === "gradient")?.why ?? "", /sky/);
});

test("an albedo with only material blotches (no structure) is left exactly as it is", () => {
    // soft stains and weathering: smooth blotches of either sign scattered over the picture, the evidence all there
    const blots: [number, number, number, number][] = [
        [0.22, 0.3, 0.12, -0.5],
        [0.7, 0.25, 0.1, 0.4],
        [0.45, 0.62, 0.14, -0.45],
        [0.8, 0.8, 0.1, -0.35],
        [0.15, 0.78, 0.09, 0.4],
    ];
    const stains: Shade = (x, y) => {
        const u = (x + 0.5) / W;
        const v = (y + 0.5) / H;
        let s = 0;
        for (const [cx, cy, r, a] of blots) s += a * Math.exp(-((u - cx) ** 2 + (v - cy) ** 2) / (2 * r * r));
        return Math.exp(s);
    };
    const stained = texture(albedo, stains);
    const result = dl.delight(stained, W, H, { wrapU: false, wrapV: false, evidence: everything });
    assert.deepEqual(result.bgra, stained, result.stats.verdict);
});

test("the controls: black / white stripes and tiled water ripples are left exactly as they are", () => {
    // (32 x 32 stripes of 4 texels, as the level's black / white stripes; water's ripples tiled both ways)
    const stripes = Buffer.alloc(32 * 32 * 4);
    for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++)
            stripes.set((x >> 2) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 32 + x) * 4);
    for (const wrap of [
        { wrapU: false, wrapV: false },
        { wrapU: true, wrapV: true },
    ])
        assert.deepEqual(dl.delight(stripes, 32, 32, { ...wrap, evidence: everything }).bgra, stripes);
    const ripples = texture(
        (x, y) => {
            const r = 1 + 0.3 * Math.sin((2 * Math.PI * 3 * x) / W + 2 * Math.sin((2 * Math.PI * y) / H));
            return [0.3 * r, 0.5 * r, 0.7 * r];
        },
        (x, y) => Math.exp(0.4 * Math.cos((2 * Math.PI * x) / W) * Math.cos((2 * Math.PI * 2 * y) / H)),
    );
    assert.deepEqual(dl.delight(ripples, W, H, { wrapU: true, wrapV: true, evidence: everything }).bgra, ripples);
    // (and a moving material is skipped before the model sees it: water, lava, the scrolling stripes)
    assert.match(
        dl.skipReason(
            "Data/levels/xx/xx.tex.xbx",
            ripples,
            "opaque",
            { area: 1, coherence: 1, surface: true },
            {
                area: 1,
                moving: true,
                backdrop: 0,
            },
        ) ?? "",
        /moving/,
    );
});

test("a texture tiled one way: the light across the other way removed, the tiled way untouched (seamless)", () => {
    // tiled in u: the gradient runs down v; each row's factor the same all along it
    const lit = texture(albedo, gradient);
    const result = dl.delight(lit, W, H, {
        wrapU: true,
        wrapV: false,
        evidence: { light: [0, -1], lines: [], faces: 2 },
    });
    assert.ok(result.stats.changed, result.stats.verdict);
    for (let y = 0; y < H; y++)
        for (let x = 1; x < W; x++) assert.equal(result.shading[y * W + x], result.shading[y * W]);
    // tiled both ways: nothing to remove
    assert.deepEqual(dl.delight(lit, W, H, { wrapU: true, wrapV: true, evidence: everything }).bgra, lit);
});

test("atlas regions are de-lit independently; texels outside them untouched", () => {
    const lit = texture(albedo, gradient);
    const regions: dl.DelightRegion[] = [
        { x0: 0, y0: 0, x1: 32, y1: 64, wrapU: false, wrapV: false },
        { x0: 32, y0: 0, x1: 64, y1: 48, wrapU: false, wrapV: false },
    ];
    // region one: the level says up is at its top; region two: nothing (no geometry)
    const evidenceFor = (r: dl.DelightRegion): dl.Evidence | null =>
        r.x0 === 0 ? { light: [0, -1], lines: [], faces: 2 } : null;
    const a = dl.delightRegions(lit, W, H, regions, { evidenceFor });
    assert.ok(a.stats.changed, a.stats.verdict);
    for (let y = 0; y < H; y++)
        for (let x = 32; x < 64; x++)
            for (let c = 0; c < 4; c++) assert.equal(a.bgra[(y * W + x) * 4 + c], lit[(y * W + x) * 4 + c]);
    // region one's result whatever region two holds, and the same as region one de-lit on its own
    const other = Buffer.from(lit);
    for (let y = 0; y < 48; y++) for (let x = 32; x < 64; x++) other[(y * W + x) * 4 + 1] = (x * 37 + y * 11) & 255;
    const b = dl.delightRegions(other, W, H, regions, { evidenceFor });
    const part = Buffer.alloc(32 * 64 * 4);
    for (let y = 0; y < 64; y++) lit.copy(part, y * 32 * 4, y * W * 4, (y * W + 32) * 4);
    const alone = dl.delight(part, 32, 64, { wrapU: false, wrapV: false, evidence: evidenceFor(regions[0]!) });
    for (let y = 0; y < 64; y++) {
        assert.deepEqual(b.bgra.subarray(y * W * 4, (y * W + 32) * 4), a.bgra.subarray(y * W * 4, (y * W + 32) * 4));
        assert.deepEqual(
            a.bgra.subarray(y * W * 4, (y * W + 32) * 4),
            alone.bgra.subarray(y * 32 * 4, (y + 1) * 32 * 4),
        );
    }
});

test("cut-outs: skipped by base.ts; and where de-lit, transparent texels and every alpha untouched", () => {
    const floor = { area: 10, coherence: 1, surface: true };
    const cut = texture(albedo);
    cut[3] = 0;
    assert.match(dl.skipReason("Data/levels/xx/xx.tex.xbx", cut, "binary", floor, undefined) ?? "", /cut-out/);
    const lit = texture(albedo, gradient);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
            if ((x - 32) ** 2 + (y - 32) ** 2 > 30 ** 2 || (x > 20 && x < 24)) lit.set([0, 0, 0, 0], (y * W + x) * 4);
    const result = dl.delight(lit, W, H, {
        wrapU: false,
        wrapV: false,
        evidence: { light: [0, -1], lines: [], faces: 1 },
    });
    assert.ok(result.stats.changed, result.stats.verdict);
    for (let i = 0; i < W * H; i++) {
        assert.equal(result.bgra[i * 4 + 3], lit[i * 4 + 3]);
        if (lit[i * 4 + 3] === 0) {
            assert.deepEqual(result.bgra.subarray(i * 4, i * 4 + 4), lit.subarray(i * 4, i * 4 + 4));
            assert.equal(result.shading[i], 0);
        }
    }
});

test("skip classes: skies, models, soft alpha, light-only, moving, backdrops, glowing pictures", () => {
    const name = "Data/levels/xx/xx.tex.xbx";
    const wall = { area: 10, coherence: 1, surface: true };
    const plain = texture(albedo);
    const still = { area: 10, moving: false, backdrop: 0 };
    assert.equal(dl.skipReason(name, plain, "opaque", wall, still), null);
    assert.match(dl.skipReason("Data/levels/xx_sky/xx_sky.tex.xbx", plain, "opaque", wall, still) ?? "", /sky/);
    assert.match(dl.skipReason("Data/models/skater/a.tex.xbx", plain, "opaque", wall, still) ?? "", /not a level/);
    assert.match(dl.skipReason(name, plain, "smooth", wall, still) ?? "", /soft alpha/);
    assert.match(dl.skipReason(name, plain, "opaque", { ...wall, surface: false }, still) ?? "", /light/);
    assert.match(dl.skipReason(name, plain, "opaque", wall, { ...still, backdrop: 0.9 }) ?? "", /backdrop/);
    // lava: saturated orange with clipped yellow highlights
    const lava = texture((x, y) => ((x * 7 + y * 3) % 5 === 0 ? [1, 1, 0.2] : [1, 0.25, 0.02]));
    assert.ok(dl.glowing(lava));
    assert.match(dl.skipReason(name, lava, "opaque", wall, still) ?? "", /glowing/);
    assert.ok(!dl.glowing(plain));
});

test("the same input gives the same bytes; one colour changes nothing", () => {
    const lit = texture(albedo, corner);
    const evidence: dl.Evidence = { light: [0, -1], lines: [line("x", 0), line("y", 1)], faces: 2 };
    const a = dl.delight(lit, W, H, { wrapU: false, wrapV: false, evidence });
    const b = dl.delight(Buffer.from(lit), W, H, { wrapU: false, wrapV: false, evidence });
    assert.deepEqual(a.bgra, b.bgra);
    assert.deepEqual(a.shading, b.shading);
    const flat = Buffer.alloc(W * H * 4, 0x80);
    assert.deepEqual(dl.delight(flat, W, H, { wrapU: false, wrapV: false, evidence }).bgra, flat);
});

// ---- the level's evidence ----

// a scene: a wall (texture 0x100, 100 x 100 units, facing +z, its picture upright - v 0 at the top) standing on a
// floor (texture 0x200) that reaches out in front of it; a scrolling material (texture 0x300)
function wallScene(): scn.Scene {
    const vertex = (p: number[], uv: number[]): number[] => [...p, ...uv];
    const mesh = (material: number, vertices: number[][]) => {
        const buffer = Buffer.alloc(vertices.length * 20);
        for (const [i, v] of vertices.entries())
            for (const [k, f] of v.entries()) buffer.writeFloatLE(f, i * 20 + 4 * k);
        return {
            material,
            buffers: [[0, buffer]],
            stride: 20,
            strips: [[0, 1, 2, 3]],
            vertexCount: vertices.length,
            offsets: [0, 0, 12],
            vertexShader: [0, 0],
        };
    };
    const quad = (o: number[], u: number[], v: number[], uv: (s: number, t: number) => number[]): number[][] =>
        [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
        ].map(([s, t]) =>
            vertex(
                [o[0]! + s! * u[0]! + t! * v[0]!, o[1]! + s! * u[1]! + t! * v[1]!, o[2]! + s! * u[2]! + t! * v[2]!],
                uv(s!, t!),
            ),
        );
    const pass = (texture: number, flags = scn.PASS_TEXTURED) => ({ texture, flags, blendMode: 0 });
    return {
        materials: [
            { checksum: 1, passes: [pass(0x100)] },
            { checksum: 2, passes: [pass(0x200)] },
            { checksum: 3, passes: [pass(0x300, scn.PASS_TEXTURED | scn.PASS_UV_WIBBLE)] },
        ],
        sectors: [
            {
                checksum: 7,
                flags: scn.SEC_TEXCOORDS,
                bbox: [0, 0, 0, 100, 100, 100],
                meshes: [
                    // (u along x, v down from the top: v = 1 - y / 100)
                    mesh(
                        1,
                        quad([0, 0, 0], [100, 0, 0], [0, 100, 0], (s, t) => [s, 1 - t]),
                    ),
                    mesh(
                        2,
                        quad([0, 0, 0], [0, 0, 100], [100, 0, 0], (s, t) => [t, s]),
                    ),
                    mesh(
                        3,
                        quad([0, 0, 200], [10, 0, 0], [0, 10, 0], (s, t) => [s, t]),
                    ),
                ],
            },
        ],
        hierarchyCount: 0,
    } as unknown as scn.Scene;
}

test("the level's evidence: up in the picture, the line where the floor meets the wall, moving materials", () => {
    const geometry = new SceneGeometry([wallScene()]);
    const evidence = geometry.evidence(0x100, { u0: 0, u1: 1, v0: 0, v1: 1 }, { wrapU: false, wrapV: false })!;
    assert.ok(evidence.light, "a light direction");
    assert.ok(evidence.light[1] < -0.95 && Math.abs(evidence.light[0]) < 0.05, `up: ${evidence.light}`);
    const at = (axis: "x" | "y", v: number): dl.Line | undefined =>
        evidence.lines.find((l) => l.axis === axis && l.at === v);
    assert.ok((at("y", 1)?.meets ?? 0) > 0.99, `the foot: ${JSON.stringify(at("y", 1))}`);
    assert.equal(at("y", 1)?.side, -1);
    assert.equal(at("y", 0)?.meets, 0);
    assert.equal(at("x", 0)?.meets, 0);
    // the floor: up isn't across it
    const floor = geometry.evidence(0x200, { u0: 0, u1: 1, v0: 0, v1: 1 }, { wrapU: false, wrapV: false })!;
    assert.ok(Math.hypot(...floor.light!) < 0.05, `floor: ${floor.light}`);
    // a tiled way has no lines across it
    const tiled = geometry.evidence(0x100, { u0: 0, u1: 1, v0: 0, v1: 1 }, { wrapU: false, wrapV: true })!;
    assert.ok(tiled.lines.every((l) => l.axis === "x"));
    assert.equal(geometry.facts(0x300)?.moving, true);
    assert.equal(geometry.facts(0x100)?.moving, false);
    assert.equal(geometry.evidence(0x999, { u0: 0, u1: 1, v0: 0, v1: 1 }, { wrapU: false, wrapV: false }), null);
});

test("the wall in the scene, painted darker at its foot, de-lit; painted darker at its top, left", () => {
    const geometry = new SceneGeometry([wallScene()]);
    const evidence = dl.textureEvidence(geometry, 0x100, { wrapU: false, wrapV: false });
    const foot: Shade = (_x, y) => Math.exp(-0.7 * Math.exp(-(1 - (y + 0.5) / H) / 0.1));
    const lit = texture(albedo, foot);
    const result = dl.delight(lit, W, H, { wrapU: false, wrapV: false, evidence });
    assert.ok(result.stats.changed, result.stats.verdict);
    // the same darkening at the top (where nothing meets the wall) is the picture's own
    const head: Shade = (_x, y) => Math.exp(-0.7 * Math.exp(-((y + 0.5) / H) / 0.1));
    const top = texture(albedo, head);
    assert.deepEqual(dl.delight(top, W, H, { wrapU: false, wrapV: false, evidence }).bgra, top);
});

test("tiling as the level maps it", () => {
    const use = (u0: number, u1: number, v0: number, v1: number, clamp = false) => ({
        u0,
        u1,
        v0,
        v1,
        clampU: clamp,
        clampV: clamp,
    });
    assert.deepEqual(dl.tilingOf([use(0, 1, 0, 1)], { wrapU: true, wrapV: true }), { wrapU: false, wrapV: false });
    assert.deepEqual(dl.tilingOf([use(0, 3, 0.2, 0.8)], { wrapU: false, wrapV: false }), { wrapU: true, wrapV: false });
    assert.deepEqual(dl.tilingOf([use(0, 3, 0, 2, true)], { wrapU: true, wrapV: true }), {
        wrapU: false,
        wrapV: false,
    });
    assert.deepEqual(dl.tilingOf(undefined, { wrapU: true, wrapV: false }), { wrapU: true, wrapV: false });
});

test("point to triangle distance", () => {
    const t = [0, 0, 0, 10, 0, 0, 0, 10, 0];
    assert.equal(pointTriangleDistance([1, 1, 5], t), 5);
    assert.equal(pointTriangleDistance([-3, -4, 0], t), 5);
    assert.ok(Math.abs(pointTriangleDistance([10, 10, 0], t) - Math.SQRT2 * 5) < 1e-9);
});

test("the cache: written and read back the same; the key follows the version and the evidence", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delight-"));
    try {
        const lit = texture(albedo, gradient);
        const options: dl.DelightOptions = {
            wrapU: false,
            wrapV: false,
            evidence: { light: [0, -1], lines: [], faces: 2 },
        };
        const result = dl.delight(lit, W, H, options);
        const key = dl.delightKey(lit, W, H, options);
        assert.equal(dl.readDelightCache(dir, key, W, H), null);
        dl.writeDelightCache(dir, key, W, H, result);
        const back = dl.readDelightCache(dir, key, W, H)!;
        assert.deepEqual(back.bgra, result.bgra);
        assert.deepEqual(back.shading, result.shading);
        assert.notEqual(dl.delightKey(lit, W, H, { ...options, evidence: null }), key);
        assert.notEqual(dl.delightKey(lit, W, H, { ...options, strength: 0.5 }), key);
        assert.equal(dl.DELIGHT_VERSION, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
