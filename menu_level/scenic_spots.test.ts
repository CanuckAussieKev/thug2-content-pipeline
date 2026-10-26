// NOT ORIGINAL - unit tests of scenic_spots.ts (the scenic art's camera spots) on a small synthetic level: a ground
// plane with a cluster of ramps in one corner and an outer wall. (The real levels' spots: scenic_art/thps3.json, made
// by `scenic_spots.ts <staging> <levels> --out`.)

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
    cameraCommands,
    candidates,
    faceWeight,
    forward,
    orientTris,
    pickTargets,
    Scene,
    scorePose,
    type V3,
    viewRay,
} from "./scenic_spots.ts";

// Two triangles of a quad a b c d, wound so their normal is (b - a) x (d - a)'s.
function quad(a: V3, b: V3, c: V3, d: V3): { a: V3; b: V3; c: V3; n: V3; area: number }[] {
    const tri = (p: V3, q: V3, r: V3) => {
        const e1: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        const e2: V3 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
        const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(...n);
        return { a: p, b: q, c: r, n: [n[0] / l, n[1] / l, n[2] / l] as V3, area: l / 2 };
    };
    return [tri(a, b, c), tri(a, c, d)];
}

// A 4000 x 4000 ground at y 0 (wound facing down: orientTris must flip it), ramps (slopes facing up) around
// (3000, 0, 3000), and a wall along x = 0.
function level(): Scene {
    const raw = [
        ...quad([0, 0, 0], [4000, 0, 0], [4000, 0, 4000], [0, 0, 4000]), // (x then z: normal -y)
    ];
    for (let i = 0; i < 4; i++) {
        const x = 2600 + i * 200;
        // a ramp rising towards +z: from (x, 0, 2800) to (x + 150, 200, 3100)
        raw.push(...quad([x, 0, 2800], [x + 150, 0, 2800], [x + 150, 200, 3100], [x, 200, 3100]));
    }
    raw.push(...quad([0, 0, 0], [0, 0, 4000], [0, 600, 4000], [0, 600, 0]));
    return new Scene(orientTris(raw), 48);
}

test("faces: floors oriented up, ramps weigh most, ceilings nothing", () => {
    const scene = level();
    const floor = scene.tris[0]!;
    assert.ok(floor.n[1] > 0.99, "the floor faces up after orienting");
    assert.equal(floor.w, faceWeight(1, false));
    assert.equal(faceWeight(0.8, false), 1);
    assert.equal(faceWeight(1, false), 0.3);
    assert.equal(faceWeight(-0.9, false), 0);
    assert.equal(faceWeight(0, true), 1);
});

test("ray casting finds the nearest face", () => {
    const scene = level();
    const hit = scene.cast([1000, 500, 1000], [0, -1, 0]);
    assert.ok(hit !== null && Math.abs(hit.t - 500) < 1e-6);
    // through the ramp at x 2675: the ramp's surface (y = 200 * (z - 2800) / 300) is above the floor
    const ramp = scene.cast([2675, 1000, 2950], [0, -1, 0]);
    assert.ok(ramp !== null && Math.abs(ramp.t - 900) < 1e-3, `ramp at ${ramp?.t}`);
    assert.equal(scene.cast([1000, 500, 1000], [0, 1, 0]), null);
    // outside the grid
    assert.equal(scene.cast([-5000, 500, -5000], [0, -1, 0]), null);
});

test("the target is the ramps' cluster", () => {
    const [first] = pickTargets(level(), 3);
    assert.ok(first !== undefined);
    assert.ok(Math.hypot(first[0] - 2900, first[2] - 2950) < 500, `target ${first}`);
});

test("view rays: the centre is the forward direction, the edges at half the field of view", () => {
    const pose = { pos: [0, 0, 0] as V3, heading: 90, pitch: 30 };
    const f = forward(90, 30);
    const centre = viewRay(pose, 0, 0);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(centre[k]! - f[k]!) < 1e-9);
    assert.ok(f[0] > 0.8 && f[1] < 0, "heading 90 looks along +x, pitched down");
    const top = viewRay(pose, 0, 1);
    assert.ok(top[1] > centre[1], "v = 1 is the picture's top");
});

test("a pose over the ramps beats one looking out of the world", () => {
    const scene = level();
    const size = Math.hypot(4000, 4000);
    const target: V3 = [2900, 100, 2950];
    const good = { pos: [2900 - 1200 * 0.6, 900, 2950 - 1200 * 0.6] as V3, heading: 45, pitch: 35 };
    const out = { pos: [3900, 300, 3900] as V3, heading: 45, pitch: 10 };
    const sGood = scorePose(scene, good, target, size);
    const sOut = scorePose(scene, out, [4500, 0, 4500], size);
    assert.ok(sOut.void > 0.3, `void ${sOut.void}`);
    assert.ok(sGood.score > sOut.score, `${sGood.score} vs ${sOut.score}`);
    // the wall seen from behind (from x < 0, looking +x through it) counts as back faces
    const behind = scorePose(scene, { pos: [-500, 300, 2000], heading: 90, pitch: 5 }, [500, 0, 2000], size);
    assert.ok(behind.back > 0.2, `back ${behind.back}`);
});

test("candidates: deterministic, scored best first, kept apart, the skater's ground under the camera", () => {
    const a = candidates(level(), 4, 3);
    const b = candidates(level(), 4, 3);
    assert.deepEqual(a, b);
    assert.ok(a.length >= 2);
    for (let i = 1; i < a.length; i++) assert.ok(a[i - 1]!.score.score >= a[i]!.score.score);
    for (const c of a) assert.ok(c.pose.pos[1] > c.target[1], "the camera is above its target");
    const cmds = cameraCommands(a[0]!);
    assert.match(cmds[cmds.length - 1]!, /^camera -?\d+ -?\d+ -?\d+ -?\d\.\d{5} -\d\.\d{5} -?\d\.\d{5}$/);
    if (a[0]!.ground !== null) assert.match(cmds[0]!, /^teleport /);
});

test("drawn-only structure in front of the collision counts as an occluder", () => {
    const scene = level();
    const size = Math.hypot(4000, 4000);
    const target: V3 = [2900, 100, 2950];
    const pose = { pos: [2900 - 720, 900, 2950 - 720] as V3, heading: 45, pitch: 35 };
    const clear = scorePose(scene, pose, target, size);
    assert.equal(clear.occl, 0);
    // a drawn plate (not in the collision) over the picture's middle
    const plate = quad([1500, 700, 1500], [3500, 700, 1500], [3500, 700, 3500], [1500, 700, 3500]);
    scene.drawn = new Scene(orientTris(plate), 48);
    const covered = scorePose(scene, pose, target, size);
    assert.ok(covered.occl > 0.3, `occl ${covered.occl}`);
    assert.ok(covered.blocked, "the plate is between the camera and the target");
    assert.ok(covered.score < clear.score - 1, `${covered.score} vs ${clear.score}`);
});
