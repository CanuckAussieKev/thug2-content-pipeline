// NOT ORIGINAL - unit tests of scenic_art.ts (the scenic level art's filters): each style's output on a synthetic
// picture is pinned by its hash (the filters are deterministic - no Math.random, the noise a hash of the pixel's
// place), the pieces (levels, blur, halftone coverage, the hash's range), the art's sizes and files. (The real
// pictures are captures of the user's own levels in a cache: `scenic_art.ts check` / `sheets`.)

import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readImg } from "./loading_art.ts";
import {
    ART_H,
    ART_W,
    applyStyle,
    autoLevels,
    boxBlur,
    contactSheet,
    fitCapture,
    GAME_COLOURS,
    halftone,
    hash01,
    levelArt,
    parseArtChoices,
    pickVariants,
    STYLES,
    STYLES_PREVIOUS,
    type Style,
    variantName,
    viewDistance,
} from "./scenic_art.ts";
import type { Candidate } from "./scenic_spots.ts";

// A 16:9 test picture: a colour gradient with a bright disc and a dark bar (edges for the outlines).
function scene(w: number, h: number): { width: number; height: number; bgra: Buffer } {
    const bgra = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const u = x / w;
            const v = y / h;
            let r = 40 + 150 * u;
            let g = 60 + 120 * v;
            let b = 90 + 60 * (1 - u);
            if (Math.hypot(u - 0.7, v - 0.35) < 0.15) [r, g, b] = [240, 235, 220];
            if (v > 0.7 && v < 0.8) [r, g, b] = [15, 15, 20];
            bgra.set([Math.round(b), Math.round(g), Math.round(r), 255], (y * w + x) * 4);
        }
    return { width: w, height: h, bgra };
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 16);

// The pinned outputs: change a style's parameters or code and these change (re-pin after looking at the sheets).
const PINNED: Record<Style, string> = {
    a: "adcb76f079403a7f",
    b: "c7b9953718dea344",
    c: "774c37dd5b6cab70",
};
// The styles before they were toned down a notch (2026-10-31): kept for the sheets' comparison rows.
const PINNED_PREVIOUS: Record<Style, string> = {
    a: "83d9767759091fd3",
    b: "865926b251bb49e4",
    c: "97f645ae3bb51cac",
};

test("each style's output is pinned (deterministic)", () => {
    const pic = scene(160, 90);
    for (const style of Object.keys(STYLES) as Style[]) {
        const once = applyStyle(pic, STYLES[style], GAME_COLOURS.thps3!);
        const again = applyStyle(pic, STYLES[style], GAME_COLOURS.thps3!);
        assert.ok(once.bgra.equals(again.bgra), `${style}: the same twice`);
        assert.equal(sha(once.bgra), PINNED[style], `style ${style}`);
    }
});

test("the styles keep the picture's tones: the bright disc stays lighter than the dark bar", () => {
    const pic = scene(160, 90);
    const at = (p: { width: number; bgra: Buffer }, x: number, y: number): number => {
        const o = (y * p.width + x) * 4;
        return p.bgra[o]! + p.bgra[o + 1]! + p.bgra[o + 2]!;
    };
    for (const style of Object.keys(STYLES) as Style[]) {
        const out = applyStyle(pic, STYLES[style], GAME_COLOURS.thps3!);
        // (averaged over a few pixels: the halftone dots)
        let disc = 0;
        let bar = 0;
        for (let d = -2; d <= 2; d++) {
            disc += at(out, 112 + d, 31);
            bar += at(out, 40 + d, 67);
        }
        assert.ok(disc > bar + 300, `${style}: disc ${disc} bar ${bar}`);
        for (let i = 3; i < out.bgra.length; i += 4) assert.equal(out.bgra[i], 255);
    }
});

test("pieces: the hash's range, levels, blur, halftone coverage", () => {
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 1000; i++) {
        const v = hash01(i, i * 7, 3);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
    }
    assert.ok(lo >= 0 && hi < 1 && hi - lo > 0.9);
    assert.equal(hash01(5, 9, 1), hash01(5, 9, 1));
    const levelled = autoLevels(Float32Array.from([0.2, 0.3, 0.4, 0.5, 0.6]), 0, 0);
    assert.ok(Math.abs(levelled[0]!) < 0.01 && Math.abs(levelled[4]! - 1) < 0.01);
    const flat = boxBlur(new Float32Array(100).fill(0.5), 10, 10, 2.5);
    for (const v of flat) assert.ok(Math.abs(v - 0.5) < 1e-6);
    // the ink of a halftone screen covers about the asked share of a large area
    for (const coverage of [0.1, 0.3, 0.6]) {
        let ink = 0;
        for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) ink += halftone(x, y, 8, 45, coverage, 1);
        assert.ok(Math.abs(ink / 40000 - coverage) < 0.05, `coverage ${coverage}: ${ink / 40000}`);
    }
});

test("the art: 640 x 360 native, 2560 x 1440 HD (DXT1, x4 marker), from a capture of any size", () => {
    const capture = scene(320, 200); // (16:10: cut to 16:9)
    const fitted = fitCapture(capture, 160, 90);
    assert.equal(fitted.width, 160);
    assert.equal(fitted.height, 90);
    const art = levelArt(capture, STYLES.a, GAME_COLOURS.thps3!);
    assert.equal(art.native.width, ART_W);
    assert.equal(art.native.height, ART_H);
    assert.equal(art.hd.width, ART_W * 4);
    assert.equal(art.hd.height, ART_H * 4);
    const native = readImg(art.nativeFile);
    assert.equal(native.width, ART_W);
    assert.equal(native.height, ART_H);
    assert.equal(art.hdFile.readUInt32LE(8), ART_W * 4);
    assert.equal(art.hdFile.readUInt32LE(12), ART_H * 4);
    assert.equal(art.hdFile.readUInt32LE(16), 0x31545844); // DXT1
    assert.equal(art.hdFile.readUInt32LE(20), (0x48440000 | 4) >>> 0);
    assert.equal(art.hdFile.length, 32 + (ART_W * 4 * ART_H * 4) / 2);
});

test("contact sheet: tiles on the ink ground with labels", () => {
    const tile = { picture: scene(64, 36), label: "foun #0" };
    const sheet = contactSheet([tile, tile, tile], 2, 64, 36);
    assert.equal(sheet.width, 2 * 64 + 3 * 12);
    assert.equal(sheet.height, 2 * (36 + 26) + 3 * 12);
    assert.equal(sheet.bgra[0], 0x0a);
});

test("the previous styles are kept as they were; the new ones are a notch lighter", () => {
    const pic = scene(160, 90);
    for (const style of Object.keys(STYLES) as Style[]) {
        const old = applyStyle(pic, STYLES_PREVIOUS[style], GAME_COLOURS.thps3!);
        assert.equal(sha(old.bgra), PINNED_PREVIOUS[style], `previous style ${style}`);
        assert.ok(STYLES[style].desaturate > 0 && STYLES_PREVIOUS[style].desaturate === 0);
        const grain = (p: { grain: number }): number => p.grain;
        assert.ok(
            grain(STYLES[style] as { grain: number }) < grain(STYLES_PREVIOUS[style] as { grain: number }),
            `${style}: less grain`,
        );
    }
    const a = STYLES.a as { period: number; inkMax: number };
    const was = STYLES_PREVIOUS.a as { period: number; inkMax: number };
    assert.ok(a.period < was.period && a.inkMax < was.inkMax, "smaller dots, lighter coverage");
});

const cand = (id: number, x: number, heading: number, score: number): Candidate => ({
    id,
    pose: { pos: [x, 400, 0], heading, pitch: 30 },
    target: [x, 0, 500],
    score: { score } as Candidate["score"],
    ground: null,
});

test("pickVariants: the chosen picture first, then the best-scoring, most different views", () => {
    const entry = {
        chosen: 2,
        candidates: [
            cand(0, 0, 0, 1.7),
            cand(1, 50, 5, 1.69), // (almost the same view as #0 and #2)
            cand(2, 20, 2, 1.5),
            cand(3, 4000, 180, 1.6),
            cand(4, -4000, 90, 1.4),
            cand(5, 100, 270, 1.3),
        ],
    };
    const all = (): boolean => true;
    const ids = pickVariants(entry, all);
    assert.equal(ids.length, 4);
    assert.equal(ids[0], 2);
    assert.equal(new Set(ids).size, 4);
    assert.ok(ids.includes(3) && ids.includes(4), "the far-off views are taken before the near duplicates");
    assert.deepEqual(pickVariants(entry, all), ids, "deterministic");
    assert.ok(
        viewDistance(entry.candidates[0]!, entry.candidates[3]!) >
            viewDistance(entry.candidates[0]!, entry.candidates[1]!),
    );
    // fewer captures: what there is; none: nothing; the chosen one missing is left to the caller (it is not first)
    assert.deepEqual(
        pickVariants(entry, (id) => id === 3 || id === 2),
        [2, 3],
    );
    assert.deepEqual(
        pickVariants(entry, () => false),
        [],
    );
    assert.notEqual(pickVariants(entry, (id) => id !== 2)[0], 2);
    assert.equal(variantName("frontend_art_thps3_foun", 0), "frontend_art_thps3_foun");
    assert.equal(variantName("frontend_art_thps3_foun", 2), "frontend_art_thps3_foun_v2");
});

test("the choices file: load script and number per line, comments and junk skipped", () => {
    const m = parseArtChoices("# picks\r\nLoad_Foun 2\r\nload_can   3\n\nbad\nload_x -1\nload_y 1000\nload_z two\n");
    assert.deepEqual(
        [...m],
        [
            ["load_foun", 2],
            ["load_can", 3],
        ],
    );
});
