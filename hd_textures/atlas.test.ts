// atlas.ts: regions from synthetic uv sets (two cells, tiling strips, overlapping and touching rectangles, wrapped
// tiles moved home), the uv rectangles read from a made-up scene, and the per-region upscale with stand-in models - a
// blurring one shows that no colour of one cell reaches the other's output or its mips (the padding is the cell's
// own), an identity one that every region lands exactly at its scaled place.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as dxt from "thug2-level-converter-core/level_port/dxt.ts";
import * as hd from "thug2-level-converter-core/level_port/hd_textures.ts";
import type { Texture } from "thug2-level-converter-core/level_port/tex.ts";
import * as scn from "thug2-level-converter-core/level_port/thug2_scene.ts";
import type { Image } from "thug2-level-converter-core/lib/frame_diff.ts";
import * as atlas from "./atlas.ts";

const W = 64;
const H = 64;

// BGRA from a function of the texel
function image(w: number, h: number, texel: (x: number, y: number) => [number, number, number]): Buffer {
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const [r, g, b] = texel(x, y);
            out.set([b, g, r, 255], (y * w + x) * 4);
        }
    return out;
}

// left half red-ish, right half blue-ish, each with some texture of its own (no green: green marks nothing here)
const twoCells = (): Buffer =>
    image(W, H, (x, y) => (x < W / 2 ? [200 + ((x * 7 + y * 3) % 50), 0, 0] : [0, 0, 200 + ((x * 5 + y * 11) % 50)]));

const use = (u0: number, u1: number, v0: number, v1: number, clamp = true): atlas.UvUse => ({
    u0,
    u1,
    v0,
    v1,
    clampU: clamp,
    clampV: clamp,
});

const rect = (r: atlas.Region): string =>
    `${r.x0},${r.y0}-${r.x1},${r.y1}${r.wrapU ? " wu" : ""}${r.wrapV ? " wv" : ""}`;

test("two cells used by separate triangles are two regions", () => {
    // (cell A: two triangles of a strip down it, overlapping; cell B: a quad and a smaller one inside it)
    const uses = [use(0, 0.5, 0, 0.6), use(0, 0.5, 0.4, 1), use(0.5, 1, 0, 1), use(0.6, 0.9, 0.2, 0.3)];
    const found = atlas.findRegions(uses, twoCells(), W, H);
    assert.equal(found.kind, "atlas");
    if (found.kind !== "atlas") return;
    assert.deepEqual(found.regions.map(rect), ["0,0-32,64", "32,0-64,64"]);
});

test("touching rectangles: one region when the texels across are continuous, two when not", () => {
    // a smooth picture: the two halves one picture cut by the uvs
    const smooth = image(W, H, (x, y) => [x * 2, y * 2, 100]);
    const found = atlas.findRegions([use(0, 0.5, 0, 0.6), use(0.5, 1, 0, 0.6)], smooth, W, H);
    assert.equal(found.kind, "atlas");
    if (found.kind === "atlas") assert.deepEqual(found.regions.map(rect), ["0,0-64,40"]);
    const apart = atlas.findRegions([use(0, 0.5, 0, 0.6), use(0.5, 1, 0, 0.6)], twoCells(), W, H);
    assert.equal(apart.kind, "atlas");
    if (apart.kind === "atlas") assert.deepEqual(apart.regions.map(rect), ["0,0-32,40", "32,0-64,40"]);
});

test("overlapping rectangles merge, and merged boxes that then overlap merge again", () => {
    const uses = [
        use(0.1, 0.3, 0.1, 0.2),
        use(0.25, 0.4, 0.15, 0.3),
        use(0.35, 0.45, 0.05, 0.12),
        use(0.7, 0.9, 0.7, 0.9),
    ];
    const found = atlas.findRegions(uses, twoCells(), W, H);
    assert.equal(found.kind, "atlas");
    if (found.kind === "atlas") assert.deepEqual(found.regions.map(rect), ["4,0-32,20", "44,44-60,60"]);
});

test("tiling: a wrapped axis spanning more than a tile is the whole axis and wraps; a tile away is moved home", () => {
    // a trim sheet: two strips tiled along u, each in its own band of v
    const strips = image(W, H, (x, y) => (y < 32 ? [200, 0, (x * 3) % 60] : [0, (x * 3) % 60, 200]));
    const found = atlas.findRegions([use(-2, 3.5, 0, 0.5, false), use(0, 7, 0.5, 1, false)], strips, W, H);
    assert.equal(found.kind, "atlas");
    if (found.kind === "atlas") assert.deepEqual(found.regions.map(rect), ["0,0-64,32 wu", "0,32-64,64 wu"]);
    // the same cell three tiles over
    const moved = atlas.findRegions([use(3, 3.5, 0, 0.5, false), use(0.5, 1, 0, 1, false)], twoCells(), W, H);
    assert.equal(moved.kind, "atlas");
    if (moved.kind === "atlas") assert.deepEqual(moved.regions.map(rect), ["0,0-32,32", "32,0-64,64"]);
    // tiled both ways: the whole texture
    assert.equal(atlas.findRegions([use(0, 4, 0, 4, false)], twoCells(), W, H).kind, "whole");
    // generated coordinates (environment map): the whole texture
    assert.equal(atlas.findRegions([{ ...use(0, 1, 0, 1), whole: true }], twoCells(), W, H).kind, "whole");
    // clamped: cut to the texture
    const clamped = atlas.findRegions([use(-1, 0.5, 0.5, 2)], twoCells(), W, H);
    assert.equal(clamped.kind, "atlas");
    if (clamped.kind === "atlas") assert.deepEqual(clamped.regions.map(rect), ["0,32-32,64"]);
});

test("one region over most of the texture is no atlas; no use at all is unreferenced", () => {
    assert.equal(atlas.findRegions([use(0, 1, 0, 0.9)], twoCells(), W, H).kind, "whole");
    assert.equal(atlas.findRegions([], twoCells(), W, H).kind, "unreferenced");
});

test("block alignment: edges out to 4 texels unless that would overlap a neighbour", () => {
    const found = atlas.findRegions([use(0.05, 0.3, 0.05, 0.3), use(0.6, 0.95, 0.6, 0.95)], twoCells(), W, H);
    assert.equal(found.kind, "atlas");
    if (found.kind === "atlas") assert.deepEqual(found.regions.map(rect), ["0,0-20,20", "36,36-64,64"]);
});

test("the uv rectangles of a made-up scene: pass n reads uv set n, clamp flags, animated frames, environment maps", () => {
    const stride = 12 + 16; // position, two uv sets
    const vertices = [
        [0, 0, 0.5, 0.5],
        [0.5, 0, 1, 0.5],
        [0, 0.5, 0.5, 1],
    ];
    const buffer = Buffer.alloc(vertices.length * stride);
    vertices.forEach((v, i) => {
        v.forEach((f, k) => {
            buffer.writeFloatLE(f, i * stride + 12 + 4 * k);
        });
    });
    const pass = (texture: number, flags: number, uAddress: number): scn.Pass => ({
        texture,
        flags,
        hasColor: 0,
        color: [0, 0, 0],
        blendMode: 0,
        fixedAlpha: 0,
        uAddress,
        vAddress: 0,
        envmapTiling: [1, 1],
        filtering: 0,
        mip: [0, 0, 0, 0],
    });
    const animated = pass(0x10, scn.PASS_TEXTURED | scn.PASS_ANIMATES, 0);
    animated.animation = [
        1,
        0,
        0,
        [
            [0, 0x10],
            [5, 0x11],
        ],
    ];
    const scene = {
        materials: [
            { checksum: 7, passes: [animated, pass(0x20, scn.PASS_TEXTURED, 1), pass(0x30, scn.PASS_ENVIRONMENT, 0)] },
        ],
        sectors: [
            {
                flags: scn.SEC_TEXCOORDS,
                meshes: [
                    {
                        material: 7,
                        buffers: [[0, buffer]],
                        stride,
                        offsets: [0, 0, 12],
                        vertexShader: [scn.FVF_XYZ | (2 << scn.FVF_TEXCOUNT_SHIFT), 0],
                        strips: [[0, 1, 2]],
                        vertexCount: 3,
                    },
                ],
            },
        ],
    } as unknown as scn.Scene;
    const index = atlas.sceneUses(scene);
    const strip = (u: atlas.UvUse): string => `${u.u0},${u.u1},${u.v0},${u.v1},${+u.clampU}${u.whole ? " whole" : ""}`;
    assert.deepEqual(index.get(0x10)?.map(strip), ["0,0.5,0,0.5,0"]);
    assert.deepEqual(index.get(0x11)?.map(strip), ["0,0.5,0,0.5,0"]);
    assert.deepEqual(index.get(0x20)?.map(strip), ["0.5,1,0.5,1,1"]);
    assert.deepEqual(index.get(0x30)?.map(strip), ["0,1,0,1,0 whole"]);
});

// ---- the per-region upscale ----

// x4 nearest, then each output texel averaged over a 9 x 9 neighbourhood: anything in the padding near the edge would
// reach the cropped middle
const blurringModel: hd.Upscaler = (images) => {
    const out = new Map<string, Image>();
    for (const [name, img] of images) {
        const w = img.width * 4;
        const h = img.height * 4;
        const big = new Uint8Array(w * h * 3);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
                big.set(
                    img.rgb.subarray(((y >> 2) * img.width + (x >> 2)) * 3, ((y >> 2) * img.width + (x >> 2)) * 3 + 3),
                    (y * w + x) * 3,
                );
        const blurred = new Uint8Array(w * h * 3);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++)
                for (let k = 0; k < 3; k++) {
                    let sum = 0;
                    let n = 0;
                    for (let dy = -4; dy <= 4; dy++)
                        for (let dx = -4; dx <= 4; dx++) {
                            const sx = Math.min(w - 1, Math.max(0, x + dx));
                            const sy = Math.min(h - 1, Math.max(0, y + dy));
                            sum += big[(sy * w + sx) * 3 + k]!;
                            n++;
                        }
                    blurred[(y * w + x) * 3 + k] = Math.round(sum / n);
                }
        out.set(name, { width: w, height: h, rgb: blurred });
    }
    return out;
};

const identityModel: hd.Upscaler = (images) => {
    const out = new Map<string, Image>();
    for (const [name, img] of images) {
        const w = img.width * 4;
        const h = img.height * 4;
        const rgb = new Uint8Array(w * h * 3);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const s = ((y >> 2) * img.width + (x >> 2)) * 3;
                rgb.set(img.rgb.subarray(s, s + 3), (y * w + x) * 3);
            }
        out.set(name, { width: w, height: h, rgb });
    }
    return out;
};

function texture32(bgra: Buffer, w: number, h: number): Texture {
    const levels: Buffer[] = [bgra];
    let level = bgra;
    for (let s = w; s > 1; s >>= 1) {
        level = hd.mipDown(level, s, s);
        levels.push(level);
    }
    return {
        checksum: 1,
        width: w,
        height: h,
        texelDepth: 32,
        paletteDepth: 0,
        dxt: 0,
        palette: Buffer.alloc(0),
        levels,
    };
}

function options(cacheDir: string, compress: boolean, match: boolean): hd.HdOptions {
    return { ...hd.defaultOptions(4), cacheDir, compress, match, minSize: 32, maxSize: 1024, model: "stub" };
}

const regions: atlas.Region[] = [
    { x0: 0, y0: 0, x1: 32, y1: 64, wrapU: false, wrapV: false },
    { x0: 32, y0: 0, x1: 64, y1: 64, wrapU: false, wrapV: false },
];

test("padding never samples the neighbour: no colour of cell A in cell B's output or its mips (32-bit and DXT1)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-"));
    try {
        for (const compress of [false, true]) {
            const t = texture32(twoCells(), W, H);
            atlas.upscaleAtlases([{ texture: t, regions }], options(dir, compress, true), blurringModel);
            assert.equal(t.width, W * 4);
            assert.equal(t.dxt, compress ? 1 : 0);
            t.levels.forEach((data, n) => {
                const lw = Math.max(1, t.width >> n);
                const lh = Math.max(1, t.height >> n);
                const border = lw / 2;
                // (DXT blocks are 4 wide: the border stays on one while it is a multiple of 4)
                if (border < 1 || (compress && border % 4)) return;
                const bgra = t.dxt ? dxt.decode(data, lw, lh, t.dxt) : data;
                for (let y = 0; y < lh; y++)
                    for (let x = 0; x < lw; x++) {
                        const i = (y * lw + x) * 4;
                        const red = bgra[i + 2]!;
                        const blue = bgra[i]!;
                        if (x < border) assert.ok(blue <= 8, `level ${n} (${x},${y}) in A has blue ${blue}`);
                        else assert.ok(red <= 8, `level ${n} (${x},${y}) in B has red ${red}`);
                    }
            });
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("the composite: each region exactly at its scaled place; texels no region covers filled from the original", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-"));
    try {
        // random texels: any shift or mix-up shows
        let seed = 12345;
        const rnd = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed % 256;
        };
        const src = image(W, H, () => [rnd(), rnd(), rnd()]);
        const parts: atlas.Region[] = [
            { x0: 4, y0: 8, x1: 20, y1: 40, wrapU: false, wrapV: false },
            { x0: 36, y0: 0, x1: 64, y1: 12, wrapU: true, wrapV: false },
        ];
        const t = texture32(src, W, H);
        atlas.upscaleAtlases([{ texture: t, regions: parts }], options(dir, false, false), identityModel);
        const out = t.levels[0]!;
        const ow = W * 4;
        for (const r of parts)
            for (let y = r.y0 * 4; y < r.y1 * 4; y++)
                for (let x = r.x0 * 4; x < r.x1 * 4; x++) {
                    const o = (y * ow + x) * 4;
                    const s = ((y >> 2) * W + (x >> 2)) * 4;
                    assert.deepEqual([...out.subarray(o, o + 4)], [...src.subarray(s, s + 4)], `(${x},${y})`);
                }
        // (the cache answers a second time: same texels, no model)
        const again = texture32(src, W, H);
        atlas.upscaleAtlases([{ texture: again, regions: parts }], options(dir, false, false), () => {
            throw Error("the model ran again");
        });
        assert.ok(again.levels[0]!.equals(out));
        // uncovered texels: the bilinear sheet (a texel deep inside the uncovered area is the original's)
        const x = 50 * 4 + 1;
        const y = 40 * 4 + 1;
        const o = (y * ow + x) * 4;
        const s = (40 * W + 50) * 4;
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(out[o + k]! - src[s + k]!) <= 64);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("region-aware mips: a 2 x 2 averages only the texels of its majority region", () => {
    const level = Buffer.from([10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 200, 200, 200, 255]);
    const labels = Int32Array.from([0, 0, 0, 1]);
    const next = atlas.regionMipDown(level, labels, 2, 2);
    assert.deepEqual([...next.bgra], [20, 20, 20, 255]);
    assert.deepEqual([...next.labels], [0]);
    const none = atlas.regionMipDown(level, Int32Array.from([-1, -1, -1, 1]), 2, 2);
    assert.deepEqual([...none.bgra], [200, 200, 200, 255]);
});
