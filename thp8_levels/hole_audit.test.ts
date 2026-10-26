// NOT ORIGINAL - tests of hole_audit.ts (slits of missing floor between two pieces of ground), on synthetic data, and
// the regression for BEAVER VALLEY's skatepark bowl: its round floor, a Havok
// cylinder, must leave no hole against the bowl's mesh.

import assert from "node:assert/strict";
import { test } from "node:test";
import type * as thug2Col from "../level_port/thug2_col.ts";
import * as havok from "./havok.ts";
import { holeAudit } from "./hole_audit.ts";
import { SCALE } from "./thp8_levels.ts";

type P = number[];

// A collision file of objects, each a list of triangles (corners in inches).
function colOf(...objects: P[][][]): thug2Col.ColFile {
    return {
        objects: objects.map((tris) => {
            const verts: P[] = [];
            const faces: thug2Col.Face[] = [];
            for (const [a, b, c] of tris) {
                faces.push([0, 0, verts.length, verts.length + 1, verts.length + 2]);
                verts.push(a!, b!, c!);
            }
            return { verts, faces } as unknown as thug2Col.ColObject;
        }),
    };
}

// An up-facing rectangle x0..x1, z0..z1 at height y (two triangles wound to face up).
const rect = (x0: number, x1: number, z0: number, z1: number, y: number): P[][] => [
    [
        [x0, y, z0],
        [x0, y, z1],
        [x1, y, z1],
    ],
    [
        [x0, y, z0],
        [x1, y, z1],
        [x1, y, z0],
    ],
];

// A wall across z at x (facing -x), from y0 to y1, z0..z1.
const wallAt = (x: number, y0: number, y1: number, z0: number, z1: number): P[][] => [
    [
        [x, y0, z0],
        [x, y1, z0],
        [x, y1, z1],
    ],
    [
        [x, y0, z0],
        [x, y1, z1],
        [x, y0, z1],
    ],
];

test("holeAudit: a 20-inch slit between two floors is a hole, its width measured", () => {
    const a = holeAudit(colOf(rect(0, 200, 0, 200, 0), rect(220, 400, 0, 200, 3)));
    assert.equal(a.holes.length, 1);
    const h = a.holes[0]!;
    assert.ok(h.widthIn >= 19 && h.widthIn <= 21, `width ${h.widthIn}`);
    assert.ok(h.at[0] > 200 && h.at[0] < 220);
    assert.ok(h.lengthIn >= 150);
});

test("holeAudit: welded floors, a floor's outer edge, a wall in the slit and a ledge far below are no holes", () => {
    assert.equal(holeAudit(colOf(rect(0, 200, 0, 200, 0), rect(200, 400, 0, 200, 0))).holes.length, 0);
    assert.equal(holeAudit(colOf(rect(0, 200, 0, 200, 0))).holes.length, 0);
    assert.equal(holeAudit(colOf(rect(0, 200, 0, 200, 0), rect(260, 400, 0, 200, 0))).holes.length, 0); // (60 in: an edge)
    assert.equal(
        holeAudit(colOf(rect(0, 200, 0, 200, 0), rect(220, 400, 0, 200, 0), wallAt(210, -10, 100, -10, 210))).holes
            .length,
        0,
    );
    assert.equal(holeAudit(colOf(rect(0, 200, 0, 200, 0), rect(220, 400, 0, 200, -40))).holes.length, 0); // (a step down)
});

// BEAVER VALLEY's bowl: a floor cylinder 8.84 m across, 0.155 m high (THP8 metres), and the bowl's mesh starting at
// 8.5 m round it (here a 64-sided ring rising outwards). As an inscribed 8-sided prism the floor left a sliver at every
// flat (8 holes, 14-19 inches wide, in the converted level); the prism must cover the circle.
test("bowl floor: the cylinder's prism leaves no hole against the bowl round it", () => {
    const r = 8.84;
    const inches = (t: P[][]): P[][] => t.map((tri) => tri.map((p) => p.map((c) => c * SCALE)));
    const floor = inches(havok.cylinderTriangles([0, 0, 0], [0, 0.155, 0], r));
    const ring: P[][] = [];
    const n = 64;
    const inner = 8.55;
    const outer = 10;
    for (let i = 0; i < n; i++) {
        const t0 = (2 * Math.PI * i) / n;
        const t1 = (2 * Math.PI * (i + 1)) / n;
        const p = (rad: number, t: number, y: number): P => [rad * Math.cos(t), y, rad * Math.sin(t)];
        const a = p(inner, t0, 0.16);
        const b = p(inner, t1, 0.16);
        const c = p(outer, t1, 0.6);
        const d = p(outer, t0, 0.6);
        // (wound to face up: the ring goes round anticlockwise seen from below, so a, c, b / a, d, c face +y)
        ring.push([a, c, b], [a, d, c]);
    }
    const bowl = inches(ring);
    for (const tri of bowl) {
        const [a, b, c] = tri as [P, P, P];
        const ny = (b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!);
        if (ny < 0) [tri[1], tri[2]] = [c, b];
    }
    assert.equal(holeAudit(colOf(floor, bowl)).holes.length, 0);
    // (the old prism: 8 sides, corners on the circle - its flats 0.67 m inside it)
    const inscribed: P[][] = [];
    const corner = (i: number, y: number): P => [
        r * SCALE * Math.cos((2 * Math.PI * i) / 8),
        y * SCALE,
        r * SCALE * Math.sin((2 * Math.PI * i) / 8),
    ];
    for (let i = 1; i < 7; i++) inscribed.push([corner(0, 0.155), corner(i + 1, 0.155), corner(i, 0.155)]);
    assert.equal(holeAudit(colOf(inscribed, bowl)).holes.length, 8);
});
