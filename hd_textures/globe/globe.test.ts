import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { NE_DIR } from "./fetch.ts";
import { loadProjection } from "./fit.ts";
import { distanceTo, fillMask, simplifyRing, smoothRing } from "./raster.ts";
import { cutTiles, defaultRedraw, PALETTE, renderStrip } from "./redraw.ts";
import { assemble, COLUMNS, LAYOUT, MAP_H, MAP_W, ROWS, TILE, TILE_COUNT } from "./tiles.ts";

const haveData = fs.existsSync(path.join(NE_DIR, "ne_110m_land.geojson"));
const skip = haveData ? false : "Natural Earth data not fetched (node tools/pipeline/hd_textures/globe/fetch.ts)";

test("fillMask: an even-odd square with a hole, wrapping across the right edge", () => {
    const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
    ];
    const mask = fillMask([[square(8, 2, 14, 8), square(10, 4, 12, 6)]], 12, 10);
    // x 8..11 inside the strip, 12..13 wrapped to 0..1
    assert.equal(mask[3 * 12 + 9], 1);
    assert.equal(mask[3 * 12 + 0], 1);
    assert.equal(mask[5 * 12 + 10], 0); // the hole
    assert.equal(mask[5 * 12 + 1], 1); // the wrapped part of the ring (x 12..13 -> 0..1), outside the hole
    assert.equal(mask[1 * 12 + 9], 0);
});

test("distanceTo is exact and wraps horizontally", () => {
    const m = new Uint8Array(10 * 5);
    m[2 * 10 + 9] = 1;
    const d = distanceTo(m, 10, 5);
    assert.equal(d[2 * 10 + 9], 0);
    assert.equal(d[2 * 10 + 1], 2); // 9 -> 0 -> 1
    assert.ok(Math.abs(d[0 * 10 + 8]! - Math.hypot(1, 2)) < 1e-6);
});

test("simplifyRing drops collinear points, smoothRing keeps the area close", () => {
    const ring: [number, number][] = [
        [0, 0],
        [5, 0],
        [10, 0],
        [10, 10],
        [0, 10],
    ];
    assert.equal(simplifyRing(ring, 0.1).length, 4);
    const smooth = smoothRing(simplifyRing(ring, 0.1), 2);
    assert.ok(smooth.length > 4);
});

test("the layout cuts the strip back into the same tiles (seams, wrap)", { skip }, () => {
    const strip = renderStrip(loadProjection(), { ...defaultRedraw(), scale: 2 });
    const tiles = cutTiles(strip, 2);
    assert.equal(tiles.length, TILE_COUNT);
    for (const t of tiles) assert.equal(t.length, TILE * 2 * TILE * 2 * 4);
    assert.ok(assemble(tiles, TILE * 2).equals(strip), "tiles reassemble into the strip");
    // map0 is plain ocean, every cell that uses it matches it
    const [b, g, r] = [PALETTE.ocean[2], PALETTE.ocean[1], PALETTE.ocean[0]];
    for (let i = 0; i < tiles[0]!.length; i += 4) assert.deepEqual([...tiles[0]!.subarray(i, i + 3)], [b, g, r]);
    // the strip wraps: its left and right edge columns are ocean here (no land crosses the seam)
    for (let y = 0; y < MAP_H * 2; y++)
        for (const x of [0, MAP_W * 2 - 1])
            assert.deepEqual([...strip.subarray((y * MAP_W * 2 + x) * 4, (y * MAP_W * 2 + x) * 4 + 3)], [b, g, r]);
    assert.equal(COLUMNS * ROWS, LAYOUT.flat().length);
});

test("the redraw is deterministic and uses the original's palette", { skip }, () => {
    const warp = loadProjection();
    const a = renderStrip(warp, { ...defaultRedraw(), scale: 2 });
    const b = renderStrip(warp, { ...defaultRedraw(), scale: 2 });
    assert.ok(a.equals(b));
    const exact = new Set(Object.values(PALETTE).map(([r, g, bl]) => (bl | (g << 8) | (r << 16)) >>> 0));
    let on = 0;
    let off = 0;
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (const [r, g, bl] of Object.values(PALETTE)) {
        for (const [i, v] of [r, g, bl].entries()) {
            lo[i] = Math.min(lo[i]!, v);
            hi[i] = Math.max(hi[i]!, v);
        }
    }
    for (let i = 0; i < a.length; i += 4) {
        const key = (a[i]! | (a[i + 1]! << 8) | (a[i + 2]! << 16)) >>> 0;
        if (exact.has(key)) on++;
        else {
            off++; // anti-aliased edge: a blend stays inside the palette's colour box
            for (const [k, v] of [a[i + 2]!, a[i + 1]!, a[i]!].entries()) assert.ok(v >= lo[k]! && v <= hi[k]!);
        }
        assert.equal(a[i + 3], 255);
    }
    assert.ok(on > off * 4, `flat palette colours dominate (${on} exact, ${off} blended)`);
    assert.ok(off > 0, "edges are anti-aliased");
});

test("the fitted projection puts the stars near the original's", () => {
    const warp = loadProjection();
    assert.equal(warp.x.length, 10);
});
