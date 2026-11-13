// base.ts with a stand-in for the model (a smooth x4 - bilinear over the padded image): tiling found by edge
// continuity and kept seamless, alpha kept, atlases found, the dictionaries' round trip, DXT's error bounds, and an
// install / switch / restore on a made-up game folder.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as dxt from "thug2-level-converter-core/level_port/dxt.ts";
import * as hd from "thug2-level-converter-core/level_port/hd_textures.ts";
import { readTex, type TexFile, type Texture, writeTex } from "thug2-level-converter-core/level_port/tex.ts";
import type { Image } from "thug2-level-converter-core/lib/frame_diff.ts";
import * as base from "./base.ts";

// ---- made-up textures ----

function texture(w: number, h: number, texel: (x: number, y: number) => [number, number, number, number]): Buffer {
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const [r, g, b, a] = texel(x, y);
            out.set(
                [b, g, r, a].map((v) => Math.max(0, Math.min(255, Math.round(v)))),
                (y * w + x) * 4,
            );
        }
    return out;
}

// periodic in both directions (tiles seamlessly)
const tiling = (w: number, h: number): Buffer =>
    texture(w, h, (x, y) => {
        const u = (2 * Math.PI * x) / w;
        const v = (2 * Math.PI * y) / h;
        return [128 + 90 * Math.sin(u), 128 + 70 * Math.cos(v), 128 + 50 * Math.sin(u + 2 * v), 255];
    });

// a ramp left to right: its last column far from its first
const ramp = (w: number, h: number): Buffer => texture(w, h, (x, y) => [(x * 255) / (w - 1), 100 + (y % 7), 60, 255]);

function asTexture(bgra: Buffer, w: number, h: number, format: number, checksum = 0x1234): Texture {
    const t: Texture = {
        checksum,
        width: w,
        height: h,
        texelDepth: 32,
        paletteDepth: 0,
        dxt: 0,
        palette: Buffer.alloc(0),
        levels: [],
    };
    t.dxt = format;
    let level = bgra;
    let lw = w;
    let lh = h;
    for (let n = 0; n < Math.log2(Math.min(w, h)) + 1; n++) {
        if (n) {
            level = hd.mipDown(level, lw, lh);
            lw >>= 1;
            lh >>= 1;
        }
        t.levels.push(format ? dxt.encode(level, lw, lh, format) : Buffer.from(level));
    }
    return t;
}

// the model's stand-in: x4, bilinear inside the (padded) image - its edges clamped, as a network sees only its input
function smooth4(images: Map<string, Image>): Map<string, Image> {
    const out = new Map<string, Image>();
    for (const [name, img] of images) {
        const w = img.width * 4;
        const h = img.height * 4;
        const rgb = new Uint8Array(w * h * 3);
        const at = (x: number, y: number, k: number): number =>
            img.rgb[
                (Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 3 + k
            ]!;
        for (let y = 0; y < h; y++) {
            const fy = (y + 0.5) / 4 - 0.5;
            const y0 = Math.floor(fy);
            const ty = fy - y0;
            for (let x = 0; x < w; x++) {
                const fx = (x + 0.5) / 4 - 0.5;
                const x0 = Math.floor(fx);
                const tx = fx - x0;
                for (let k = 0; k < 3; k++)
                    rgb[(y * w + x) * 3 + k] = Math.round(
                        (at(x0, y0, k) * (1 - tx) + at(x0 + 1, y0, k) * tx) * (1 - ty) +
                            (at(x0, y0 + 1, k) * (1 - tx) + at(x0 + 1, y0 + 1, k) * tx) * ty,
                    );
            }
        }
        out.set(name, { width: w, height: h, rgb });
    }
    return out;
}

const temps: string[] = [];
function temp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temps.push(dir);
    return dir;
}
test.after(() => {
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function upscaleOne(t: Texture, addressing: hd.Addressing, compress = true): Texture {
    const tex: TexFile = { version: 1, textures: [t] };
    const options = { ...hd.defaultOptions(4), cacheDir: temp("hd-base-cache-"), minSize: base.MIN_SIZE, compress };
    hd.upscaleTexFile(tex, new Map([[t.checksum, addressing]]), options, hd.newStats(), smooth4);
    return tex.textures[0]!;
}

// how far the wrap seam stands out: the step across it over the texture's typical step
const seamRatio = (bgra: Uint8Array, w: number, h: number): number => {
    const s = base.seams(bgra, w, h);
    return Math.max(s.edgeU / Math.max(s.stepU, 0.5), s.edgeV / Math.max(s.stepV, 0.5));
};

// ---- tests ----

test("tiling found by edge continuity", () => {
    assert.deepEqual(base.detectWrap(tiling(64, 64), 64, 64), { wrapU: true, wrapV: true });
    const r = base.detectWrap(ramp(64, 64), 64, 64);
    assert.equal(r.wrapU, false, "a ramp doesn't wrap in u");
    assert.equal(r.wrapV, true, "the ramp's rows repeat every 7: v found continuous enough");
});

test("a tiling texture stays seamless through the upscale (wrap padding); clamp padding would show the seam", () => {
    const w = 64;
    const src = tiling(w, w);
    const before = seamRatio(src, w, w);
    // (32-bit out: the pass's seams, not DXT's block steps)
    const wrapped = upscaleOne(asTexture(src, w, w, 0), { wrapU: true, wrapV: true }, false);
    const clamped = upscaleOne(asTexture(src, w, w, 0), { wrapU: false, wrapV: false }, false);
    assert.equal(wrapped.width, 256);
    const after = seamRatio(wrapped.levels[0]!, 256, 256);
    const afterClamped = seamRatio(clamped.levels[0]!, 256, 256);
    assert.ok(before < 2.5, `the source tiles (${before.toFixed(2)})`);
    assert.ok(after < 2.5, `wrap padding: the seam no stronger than the texture's own steps (${after.toFixed(2)})`);
    assert.ok(afterClamped > after * 1.5, `clamp padding shows it (${afterClamped.toFixed(2)} vs ${after.toFixed(2)})`);
});

test("alpha kept: a cut-out stays 0 / 255 and in place, opaque stays opaque, soft alpha keeps its level", () => {
    const w = 32;
    // a disc cut-out
    const cut = texture(w, w, (x, y) => [200, 80, 40, (x - 15.5) ** 2 + (y - 15.5) ** 2 < 100 ? 255 : 0]);
    const up = upscaleOne(asTexture(cut, w, w, 0), { wrapU: false, wrapV: false });
    assert.equal(up.dxt, 2, "a cut-out is written as DXT1 with 1-bit alpha");
    const a = dxt.decode(up.levels[0]!, 128, 128, up.dxt);
    let mismatched = 0;
    for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
            const alpha = a[(y * 128 + x) * 4 + 3]!;
            assert.ok(alpha === 0 || alpha === 255, "binary alpha");
            const inside = ((x + 0.5) / 4 - 16) ** 2 + ((y + 0.5) / 4 - 16) ** 2 < 100;
            if ((alpha === 255) !== inside) mismatched++;
        }
    assert.ok(mismatched < 128 * 4, `the edge within a texel (${mismatched} texels differ)`);
    const opaque = upscaleOne(asTexture(tiling(w, w), w, w, 1), { wrapU: true, wrapV: true });
    const o = dxt.decode(opaque.levels[0]!, 128, 128, opaque.dxt);
    for (let i = 3; i < o.length; i += 4) assert.equal(o[i], 255);
    const soft = texture(w, w, (x) => [90, 90, 90, 40 + x * 5]);
    const s = upscaleOne(asTexture(soft, w, w, 0), { wrapU: false, wrapV: false });
    assert.equal(s.dxt, 5);
    const sb = dxt.decode(s.levels[0]!, 128, 128, 5);
    for (let x = 0; x < w; x++) {
        // every 4 x 4 block averages to the source texel's alpha (back-projection), give or take DXT5's steps
        let sum = 0;
        for (let k = 0; k < 16; k++) sum += sb[((8 + (k >> 2)) * 128 + x * 4 + (k & 3)) * 4 + 3]!;
        assert.ok(Math.abs(sum / 16 - (40 + x * 5)) <= 6, `column ${x}: ${sum / 16}`);
    }
});

test("atlases found; patterns, cut-out sheets and plain textures not", () => {
    const w = 64;
    // two different pictures stacked
    const stacked = texture(w, w, (x, y) => (y < 30 ? [200, 160, 40, 255] : [60, 70, 150 + (x % 5), 255]));
    assert.match(base.detectAtlas(stacked, w, w) ?? "", /seam at row 30/);
    const sideBySide = texture(w, w, (x, y) => (x < 40 ? [30 + (y % 3), 30, 30, 255] : [220, 220, 200, 255]));
    assert.match(base.detectAtlas(sideBySide, w, w) ?? "", /seam at column 40/);
    // rows of windows: strong seams, the same picture on both sides
    const windows = texture(w, w, (_x, y) => (y % 16 < 8 ? [20, 20, 30, 255] : [200, 200, 190, 255]));
    assert.equal(base.detectAtlas(windows, w, w), null);
    // a trim at the edge
    const trim = texture(w, w, (x, y) => (y < 4 ? [250, 250, 250, 255] : [90 + (x % 3), 60, 40, 255]));
    assert.equal(base.detectAtlas(trim, w, w), null);
    // sprites apart on transparent texels; hidden colour different on each side
    const sprites = texture(w, w, (x, y) =>
        x % 32 > 4 && x % 32 < 28 && y > 4 && y < 60 ? [180, 40, 40, 255] : x < 32 ? [0, 0, 0, 0] : [255, 0, 255, 0],
    );
    assert.equal(base.detectAtlas(sprites, w, w), null);
    assert.equal(base.detectAtlas(tiling(w, w), w, w), null);
});

test("texture dictionaries round-trip: read -> write -> read identical, upscaled too", () => {
    const tex: TexFile = {
        version: 1,
        textures: [
            asTexture(tiling(64, 32), 64, 32, 1, 1),
            asTexture(ramp(32, 32), 32, 32, 5, 2),
            asTexture(ramp(16, 16), 16, 16, 0, 3),
        ],
    };
    const bytes = writeTex(tex);
    const again = writeTex(readTex(bytes));
    assert.ok(again.equals(bytes));
    const read = readTex(bytes);
    hd.upscaleTexFile(
        read,
        new Map(),
        { ...hd.defaultOptions(4), cacheDir: temp("hd-base-cache-"), minSize: 32 },
        hd.newStats(),
        smooth4,
    );
    const hdBytes = writeTex(read);
    assert.ok(writeTex(readTex(hdBytes)).equals(hdBytes));
    const back = readTex(hdBytes);
    assert.deepEqual(
        back.textures.map((t) => [t.checksum, t.width, t.height, t.dxt, t.levels.length]),
        [
            [1, 256, 128, 1, 8],
            [2, 128, 128, 5, 8],
            [3, 16, 16, 0, 5], // (under 32: left as it was)
        ],
    );
    for (const t of back.textures)
        for (const [n, level] of t.levels.entries())
            assert.equal(
                level.length,
                t.dxt ? dxt.levelSize(t.width >> n, t.height >> n, t.dxt) : (t.width >> n) * (t.height >> n) * 4,
            );
});

test("DXT encode error bounds", () => {
    const rms = (a: Uint8Array, b: Uint8Array, channels: number[]): number => {
        let sum = 0;
        let n = 0;
        for (let i = 0; i < a.length; i += 4)
            for (const k of channels) {
                sum += (a[i + k]! - b[i + k]!) ** 2;
                n++;
            }
        return Math.sqrt(sum / n);
    };
    const w = 64;
    const smooth = tiling(w, w);
    const noisy = texture(w, w, (x, y) => [(x * 37 + y * 91) % 256, (x * 13 + y * 7) % 256, (x * y) % 256, 255]);
    const alpha = texture(w, w, (x, y) => [120, 130, 140, (x * 4 + y) % 256]);
    const dxt1Smooth = rms(smooth, dxt.decode(dxt.encode(smooth, w, w, 1), w, w, 1), [0, 1, 2]);
    const dxt1Noisy = rms(noisy, dxt.decode(dxt.encode(noisy, w, w, 1), w, w, 1), [0, 1, 2]);
    const dxt5Alpha = rms(alpha, dxt.decode(dxt.encode(alpha, w, w, 5), w, w, 5), [3]);
    assert.ok(dxt1Smooth < 6, `DXT1 smooth RMS ${dxt1Smooth.toFixed(2)}`);
    assert.ok(dxt1Noisy < 60, `DXT1 noise RMS ${dxt1Noisy.toFixed(2)}`);
    assert.ok(dxt5Alpha < 3, `DXT5 alpha RMS ${dxt5Alpha.toFixed(2)}`);
});

test("install, switch and restore on an unpacked game: the originals back byte for byte, a set made once is copied", () => {
    const game = temp("hd-base-game-");
    const cacheRoot = temp("hd-base-sets-");
    const made = "Data\\levels\\xx\\xx.tex.xbx";
    const shipped = "Data\\levels\\yy\\yy.tex.xbx"; // (installed with the game: never replaced)
    const overlay = "thug2-decomp-port\\levels\\zz\\zz.tex.xbx";
    const original = writeTex({ version: 1, textures: [asTexture(tiling(64, 64), 64, 64, 1)] });
    for (const rel of [made, shipped, overlay]) {
        fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
        fs.writeFileSync(path.join(game, rel), original);
    }
    fs.mkdirSync(path.join(game, "thug2-decomp-backup"));
    const unpacked = { moved: [], made: [made], folders: [] };
    fs.writeFileSync(path.join(game, "thug2-decomp-backup", "unpacked.json"), JSON.stringify(unpacked));
    let calls = 0;
    const counting: hd.Upscaler = (images) => {
        calls++;
        return smooth4(images);
    };
    const options = {
        scope: "levels" as const,
        levels: null,
        buildOnly: false,
        cacheRoot,
        vramGb: 1,
        upscaler: counting,
    };
    const first = base.install(game, "pbrify", options);
    assert.equal(first.installed, 2);
    assert.deepEqual(first.notOurs, [shipped]);
    assert.ok(fs.readFileSync(path.join(game, shipped)).equals(original));
    assert.equal(readTex(fs.readFileSync(path.join(game, made))).textures[0]!.width, 256);
    assert.equal(calls, 1);
    base.install(game, "seedvr2", options);
    assert.equal(calls, 2);
    assert.equal(base.readRecord(game)?.model, "seedvr2");
    base.install(game, "pbrify", options); // (from its cache: no model call)
    assert.equal(calls, 2);
    // an overlay remade since: kept on restore
    const remade = writeTex({ version: 1, textures: [asTexture(ramp(32, 32), 32, 32, 1)] });
    fs.writeFileSync(path.join(game, overlay), remade);
    const r = base.restore(game);
    assert.deepEqual(r, { restored: 1, kept: 1 });
    assert.ok(fs.readFileSync(path.join(game, made)).equals(original));
    assert.ok(fs.readFileSync(path.join(game, overlay)).equals(remade));
    assert.equal(base.readRecord(game), null);
    assert.ok(fs.existsSync(path.join(game, "thug2-decomp-backup", "unpacked.json")), "unpack's record untouched");
});
