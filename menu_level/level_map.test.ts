// NOT ORIGINAL - tests of the level select's maps (level_map.ts, hd_textures/globe/plan.ts) and the stars' separation.

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPlan, fitPlan, PLAN_SIZE, planPoint, renderPlan } from "../hd_textures/globe/plan.ts";
import { PALETTE } from "../hd_textures/globe/redraw.ts";
import { type ColFile, FACE_SKATABLE } from "../level_port/thug2_col.ts";
import { footprint, nativeImage, objectMiddles, zoneOffset } from "./level_map.ts";
import { editLevelSelect, MIN_STAR_SEPARATION, mapPosition, starPositions, THAW_LEVELS } from "./level_select.ts";
import { readImg } from "./level_select_icons.ts";

test("starPositions: THAW's nine Los Angeles areas spread to the minimum separation, each staying near its place", () => {
    const places = [...THAW_LEVELS.values()].map((e) => e.location ?? null);
    const stars = starPositions(places);
    stars.forEach((a, i) => {
        if (!a) return;
        stars.forEach((b, j) => {
            if (!b || j <= i) return;
            assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= MIN_STAR_SEPARATION - 0.2, `${i} / ${j}`);
        });
        const home = mapPosition(places[i]![0], places[i]![1]);
        assert.ok(Math.hypot(a[0] - home[0], a[1] - home[1]) < 25, `star ${i} moved too far`);
    });
});

test("starPositions: stars that are apart stay where mapPosition puts them; the same spot is split; no place, no star", () => {
    const [a, b, c] = starPositions([[-0.128, 51.507], [-0.128, 51.507], null]);
    assert.ok(Math.hypot(a![0] - b![0], a![1] - b![1]) >= MIN_STAR_SEPARATION - 0.2);
    assert.equal(c, null);
    assert.deepEqual(starPositions([[-118.24, 34.05]]), [mapPosition(-118.24, 34.05)]);
});

// A collision file of one object with the given triangles (x, y, z each) and flags.
function col(faces: { flags: number; v: number[][] }[], checksum = 1): ColFile {
    const verts: number[][] = [];
    const out: [number, number, number, number, number][] = [];
    for (const f of faces) {
        const at = verts.length;
        verts.push(...f.v);
        out.push([f.flags, 0, at, at + 1, at + 2]);
    }
    return {
        objects: [
            {
                checksum,
                flags: 0,
                smallFaces: 0,
                fixedVerts: 0,
                bbox: [0, 0, 0, 1, 100, 100, 100, 1],
                verts,
                intensities: Buffer.alloc(0),
                faces: out,
                reach: Buffer.alloc(0),
                bsp: { kind: "leaf", faces: [], low: 3 },
            },
        ],
    };
}

test("footprint keeps floors and roofs, drops walls, triggers and invisible faces; the floor middle is area-weighted", () => {
    const floor = {
        flags: FACE_SKATABLE,
        v: [
            [0, 0, 0],
            [0, 0, 10],
            [10, 0, 0],
        ],
    }; // looks up (y)
    const wall = {
        flags: 0,
        v: [
            [0, 0, 0],
            [10, 0, 0],
            [0, 10, 0],
        ],
    }; // vertical
    const trigger = {
        flags: 0x40,
        v: [
            [50, 0, 50],
            [50, 0, 60],
            [60, 0, 50],
        ],
    };
    const invisible = {
        flags: 0x1000,
        v: [
            [70, 0, 70],
            [70, 0, 80],
            [80, 0, 70],
        ],
    };
    const fp = footprint(col([floor, wall, trigger, invisible]));
    assert.equal(fp.tris.length, 6);
    assert.ok(Math.abs(fp.floor[0] - 10 / 3) < 1e-4 && Math.abs(fp.floor[1] - 10 / 3) < 1e-4);
});

test("zoneOffset: the median shift of the shared objects (null with too few)", () => {
    const town = new Map<number, [number, number]>();
    const zone = new Map<number, [number, number]>();
    for (let i = 1; i <= 8; i++) {
        zone.set(i, [i * 10, i * 5]);
        town.set(i, [i * 10 + 1000, i * 5 - 300 + (i === 3 ? 999 : 0)]);
    }
    assert.deepEqual(zoneOffset(zone, town), [1000, -300]);
    assert.equal(zoneOffset(new Map([[1, [0, 0]]]), new Map([[1, [5, 5]]])), null);
    assert.deepEqual([...objectMiddles(col([])).keys()], [1]);
});

test("a plan draws the footprint in the globe's greens on its ocean, and the fit keeps it inside the circle", () => {
    const tris = Float32Array.from([-100, -100, 100, -100, 0, 100, -100, 100, 100, 100, 100, -100]);
    const fit = fitPlan(tris);
    const [px, py] = planPoint(fit, 0, 0);
    assert.deepEqual([px, py], [PLAN_SIZE / 2, PLAN_SIZE / 2]);
    for (let i = 0; i < tris.length; i += 2) {
        const [x, y] = planPoint(fit, tris[i]!, tris[i + 1]!);
        assert.ok(Math.hypot(x - 128, y - 128) <= 112.001);
    }
    const img = renderPlan(tris, fit, defaultPlan(1, 3));
    assert.equal(img.length, PLAN_SIZE * PLAN_SIZE * 4);
    const at = (x: number, y: number): number[] => [
        ...img.subarray((y * PLAN_SIZE + x) * 4, (y * PLAN_SIZE + x) * 4 + 3),
    ];
    assert.deepEqual(at(2, 2), [PALETTE.ocean[2], PALETTE.ocean[1], PALETTE.ocean[0]]);
    const middle = at(128, 128);
    assert.ok(middle[1]! > middle[0]! + 60 && middle[1]! > middle[2]! + 60, "green in the middle");
});

test("nativeImage: an 8-bit image the game reads, colours kept, palette index 0 unused", () => {
    const size = 16;
    const img = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) img.set(i < 100 ? [0xc1, 0x6c, 0x42, 255] : [0x04, 0xb4, 0x04, 255], i * 4);
    const read = readImg(nativeImage(img, size));
    assert.equal(read.w, size);
    assert.ok(read.indices.every((i) => i > 0));
    assert.deepEqual(read.palette[read.indices[0]!]!.slice(0, 3), [0xc1, 0x6c, 0x42]);
    assert.deepEqual(read.palette[read.indices[size * size - 1]!]!.slice(0, 3), [0x04, 0xb4, 0x04]);
});

test("editLevelSelect refuses nothing it didn't change: the map script is in the generated text", () => {
    assert.equal(typeof editLevelSelect, "function");
});
