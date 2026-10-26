// NOT ORIGINAL - tests of zfight_raster.ts (z-fighting rendered as THUG2 draws it) on scenes built here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pack } from "../lib/struct.ts";
import { checksum, Name, type QbValue, Struct } from "./qb.ts";
import { encodeValue } from "./qb_write.ts";
import type * as thug2Col from "./thug2_col.ts";
import * as thug2Scene from "./thug2_scene.ts";
import {
    analyseViews,
    assertNoZFight,
    buildRasterScene,
    cameraView,
    classOf,
    DEPTH_BIAS_UNIT,
    DEPTH_MAX,
    drawBuckets,
    Frame,
    groundSpots,
    hiddenSectors,
    lookCamera,
    renderView,
    skaterCamera,
    sortedPairs,
    type ViewSpec,
} from "./zfight_raster.ts";

interface MaterialOptions {
    texture?: number;
    twoSided?: boolean;
    zBias?: number;
    blend?: number;
    flags?: number;
    drawOrder?: number;
    sorted?: number;
}

function material(checksum: number, o: MaterialOptions = {}): thug2Scene.Material {
    return {
        checksum,
        nameChecksum: checksum,
        alphaCutoff: 1,
        sorted: o.sorted ?? 0,
        drawOrder: o.drawOrder ?? 0,
        singleSided: 0,
        noBackfaceCulling: o.twoSided ? 1 : 0,
        zBias: o.zBias ?? 0,
        grassify: 0,
        specularPower: 0,
        passes: [
            {
                texture: o.texture ?? checksum,
                flags: thug2Scene.PASS_TEXTURED | (o.flags ?? 0),
                hasColor: 0,
                color: [0.5, 0.5, 0.5],
                blendMode: o.blend ?? 0,
                fixedAlpha: 0,
                uAddress: 0,
                vAddress: 0,
                envmapTiling: [3, 3],
                filtering: 0x10004,
                mip: [1, 4, -8, -8],
            },
        ],
    };
}

// A floor quad at `height` from (x0, z0) to (x1, z1), facing up (or down), as a 4-index strip.
function quad(m: number, x0: number, z0: number, x1: number, z1: number, height = 0, down = false): thug2Scene.Mesh {
    let corners = [
        [x0, height, z0],
        [x0, height, z1],
        [x1, height, z0],
        [x1, height, z1],
    ];
    if (down) corners = [corners[1]!, corners[0]!, corners[3]!, corners[2]!];
    const buffer = Buffer.alloc(corners.length * 12);
    corners.forEach((c, i) => {
        c.forEach((v, k) => {
            buffer.writeFloatLE(v, i * 12 + 4 * k);
        });
    });
    return {
        sphere: [0, 0, 0, 1],
        bbox: [x0, height, z0, x1, height, z1],
        flags: 0,
        material: m,
        lods: [[0, 1, 2, 3]],
        strips: [[0, 1, 2, 3]],
        stride: 12,
        vertexCount: 4,
        buffers: [[0, buffer]],
        vertexShader: [0x2, 0],
        offsets: [0, 12, 12],
        hasWibble: 0,
        indexSets: 1,
        pixelShader: 2,
    };
}

function scene(materials: thug2Scene.Material[], sectors: thug2Scene.Mesh[][]): thug2Scene.Scene {
    return {
        versions: [1, 1, 1],
        materials,
        sectors: sectors.map((meshes, i) => ({
            checksum: i + 1,
            bone: -1,
            flags: 0,
            bbox: [0, 0, 0, 0, 0, 0],
            sphere: [0, 0, 0, 1],
            meshes,
        })),
        hierarchyCount: 0,
        tail: Buffer.alloc(0),
    };
}

// Looking down onto the floor (0..400 x 0..400) from 3 m away.
const NEAR_VIEW: ViewSpec = cameraView([200, 80, -60, 0, -0.5, 1]);
const SIZE = { width: 160, height: 90 };

test("the floor is drawn (D3DCULL_CW culls the other side; a two-sided material draws both)", () => {
    const up = buildRasterScene(scene([material(1)], [[quad(1, 0, 0, 400, 400)]]));
    const frame = new Frame(SIZE.width, SIZE.height);
    renderView(up, NEAR_VIEW.camera, frame, { ...SIZE, jitter: 1, track: true });
    assert.ok(frame.drawn > 1000, `${frame.drawn} pixels`);
    const down = buildRasterScene(scene([material(1)], [[quad(1, 0, 0, 400, 400, 0, true)]]));
    renderView(down, NEAR_VIEW.camera, frame, { ...SIZE, jitter: 1, track: true });
    assert.equal(frame.drawn, 0);
    const both = buildRasterScene(scene([material(1, { twoSided: true })], [[quad(1, 0, 0, 400, 400, 0, true)]]));
    renderView(both, NEAR_VIEW.camera, frame, { ...SIZE, jitter: 1, track: true });
    assert.ok(frame.drawn > 1000);
});

test("two coplanar quads of other objects fight; their overlap only", () => {
    const s = scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300)]]);
    const rs = buildRasterScene(s);
    const a = analyseViews(rs, [NEAR_VIEW], SIZE);
    assert.ok(a.fight > 500, `${a.fight} pixels`);
    const pairs = sortedPairs(a);
    assert.equal(pairs.length, 1);
    assert.equal(classOf(pairs[0]!, rs), "overlap");
    // its place: inside the overlap
    const z = pairs[0]!.sum[2] / pairs[0]!.pixels;
    assert.ok(z > 100 && z < 300, `z ${z}`);
    // (a smaller object entirely over the other: not more than its own pixels)
    const small = analyseViews(
        buildRasterScene(scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [quad(2, 150, 150, 250, 250)]])),
        [NEAR_VIEW],
        SIZE,
    );
    assert.ok(small.fight < a.fight);
});

test("a z bias on the layer: no fight (D3DRS_DEPTHBIAS = bias x -2e-6, ~33 depth steps a unit)", () => {
    assert.ok(Math.abs(DEPTH_BIAS_UNIT * DEPTH_MAX + 33.55) < 0.1);
    const s = scene([material(1), material(2, { zBias: 1 })], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300)]]);
    assert.equal(analyseViews(buildRasterScene(s), [NEAR_VIEW], SIZE).fight, 0);
    assertNoZFight(s, 0, [NEAR_VIEW], SIZE);
    // (a negative bias wraps to a byte as the loader keeps it: 255 steps towards the camera - no fight either)
    const wrapped = scene(
        [material(1), material(2, { zBias: -1 })],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300)]],
    );
    assert.equal(buildRasterScene(wrapped).meshes[1]!.bias, Math.fround(255 * DEPTH_BIAS_UNIT));
});

test("an inch apart: no fight at near range, a fight from far away", () => {
    const s = scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300, 1)]]);
    const rs = buildRasterScene(s);
    assert.equal(analyseViews(rs, [NEAR_VIEW], SIZE).fight, 0);
    assert.throws(() =>
        assertNoZFight(
            scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300)]]),
            10,
            [NEAR_VIEW],
            SIZE,
        ),
    );
    // a big floor seen from 500 m (depth steps there are ~12 inches apart)
    const big = scene(
        [material(1), material(2)],
        [[quad(1, -20000, 0, 20000, 40000)], [quad(2, -20000, 10000, 20000, 30000, 1)]],
    );
    const far = cameraView([0, 3000, -20000, 0, -0.15, 1]);
    assert.ok(analyseViews(buildRasterScene(big), [far], SIZE).fight > 100);
});

test("exact copies of the triangles aren't counted (equal depths on the hardware); near-copies are, as copies", () => {
    for (const second of [material(1), material(2, { texture: 7 })]) {
        const same = scene([material(1), second], [[quad(1, 0, 0, 400, 400)], [quad(second.checksum, 0, 0, 400, 400)]]);
        const a = analyseViews(buildRasterScene(same), [NEAR_VIEW], SIZE);
        assert.equal(a.fight, 0);
        assert.ok(a.sameSurface > 1000);
    }
    // (two corners 0.004 inch off)
    const other = scene(
        [material(1), material(2, { texture: 1 })],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 0.004, 0, 400, 400)]],
    );
    const rs = buildRasterScene(other);
    const b = analyseViews(rs, [NEAR_VIEW], SIZE);
    assert.ok(b.fight > 1000);
    assert.equal(classOf(sortedPairs(b)[0]!, rs), "copy");
});

test("a blended layer drawn after the opaque floor fights it (the transparent pass), classed as a layer", () => {
    const layer = material(2, { blend: 5, flags: thug2Scene.PASS_TRANSPARENT });
    const s = scene([material(1), layer], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300)]]);
    const rs = buildRasterScene(s);
    assert.ok(rs.meshes[1]!.twoSided && rs.meshes[1]!.seeThrough && rs.meshes[1]!.transparent);
    // (drawn last whatever its place in the file)
    const buckets = drawBuckets(rs, NEAR_VIEW.camera);
    assert.deepEqual(buckets[0], [0]);
    assert.deepEqual(buckets[2], [1]);
    const a = analyseViews(rs, [NEAR_VIEW], SIZE);
    assert.ok(a.fight > 500);
    assert.equal(classOf(sortedPairs(a)[0]!, rs), "layer");
});

test("the draw order reversed changes only contested pixels (the two renders agree with the contest test)", () => {
    const s = scene(
        [material(1), material(2), material(3)],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300)], [quad(3, 100, 0, 300, 400, 20)]],
    );
    const a = analyseViews(buildRasterScene(s), [NEAR_VIEW], { ...SIZE, orders: true });
    assert.ok(a.orderDiff > 100);
    assert.equal(a.orderMissed, 0);
});

test("CompareMeshes: sort key, then the sort flag, then decals; transparent ones from the first of them", () => {
    const s = scene(
        [
            material(1, { drawOrder: 2 }),
            material(2),
            material(3, { flags: thug2Scene.PASS_TRANSPARENT, blend: 5, sorted: 1 }),
            material(4, { flags: thug2Scene.PASS_DECAL }),
        ],
        [[quad(1, 0, 0, 1, 1)], [quad(2, 0, 0, 1, 1)], [quad(3, 0, 0, 1, 1)], [quad(4, 0, 0, 1, 1)]],
    );
    const rs = buildRasterScene(s);
    assert.deepEqual(rs.sorted, [1, 3, 2, 0]);
    assert.equal(rs.firstTransparent, 2);
    assert.equal(rs.firstFlagged, 2);
    assert.equal(rs.flaggedCount, 1);
    assert.equal(rs.meshes[3]!.zWrite, false);
});

test("hidden sectors are left out", () => {
    const s = scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300)]]);
    const rs = buildRasterScene(s, { hidden: new Set([2]) });
    assert.equal(rs.meshes.length, 1);
    assert.equal(analyseViews(rs, [NEAR_VIEW], SIZE).fight, 0);
});

test("the camera: THUG2's lens (16:9: 88.2 degrees across) and the skater camera behind and above", () => {
    const c = lookCamera([0, 0, 0], [0, 0, 1]);
    assert.ok(Math.abs((2 * Math.atan(c.tanX) * 180) / Math.PI - 88.18) < 0.05);
    assert.ok(Math.abs(c.tanY - c.tanX / ((16 / 9) * 0.90909094)) < 1e-6);
    // looking along +z, +x is on the screen's left (a right-handed view)
    assert.ok(c.r[0] < -0.99);
    assert.ok(c.u[1] > 0.99);
    // (the screenshot sidecar's skater (-5894, 947, 8238) and camera (-5753, 1024, 8242): 144 * cos 0.18 behind,
    // 51.6 + 144 * sin 0.18 above)
    const k = skaterCamera([0, 0, 0], 90);
    assert.ok(Math.abs(k.eye[0] + 141.7) < 0.2 && Math.abs(k.eye[1] - 77.4) < 0.2 && Math.abs(k.eye[2]) < 1e-9);
    assert.ok(Math.abs(k.f[1] + Math.sin(0.18)) < 1e-9);
});

test("ground spots: up-facing collision only, deterministic", () => {
    const col: thug2Col.ColFile = {
        objects: [
            {
                checksum: 1,
                flags: 0,
                smallFaces: 0,
                fixedVerts: 0,
                bbox: [0, 0, 0, 1, 100, 0, 100, 1],
                verts: [
                    [0, 0, 0],
                    [0, 0, 100],
                    [100, 0, 0],
                    [0, 50, 0],
                ],
                intensities: Buffer.alloc(0),
                faces: [
                    [0, 0, 0, 1, 2], // floor (up: (0,0,100) x (100,0,0) = (0, 10000, 0))
                    [0, 0, 0, 3, 1], // wall
                ],
                reach: Buffer.alloc(0),
                bsp: { kind: "leaf", faces: [], low: 3 },
            },
        ],
    };
    const a = groundSpots(col, 5, 2, 7);
    assert.equal(a.length, 10);
    for (const s of a) assert.equal(s[1], 0);
    assert.deepEqual(a, groundSpots(col, 5, 2, 7));
    assert.notDeepEqual(a, groundSpots(col, 5, 2, 8));
    assert.equal(groundSpots(col, 5, 2, 7, new Set([1])).length, 0);
});

test("node arrays: LevelGeometry without CreatedAtStart and level / game objects are hidden (shared parts too)", () => {
    const n = (text: string): Name => new Name(checksum(text));
    const global = (name: string, value: QbValue): Buffer =>
        Buffer.concat([Buffer.from([0x01, 0x16]), pack("<I", checksum(name)), Buffer.from([0x07]), encodeValue(value)]);
    const node = (name: string, ...entries: [string | null, QbValue][]): Struct =>
        new Struct([
            [n("Name"), n(name)],
            ...entries.map(([k, v]): [Name | null, QbValue] => [k === null ? null : n(k), v]),
        ]);
    const data = Buffer.concat([
        global(
            "ncomp_LevelGeometry_1",
            new Struct([
                [n("Class"), n("LevelGeometry")],
                [null, n("CreatedAtStart")],
            ]),
        ),
        global("lv_NodeArray", [
            node("Shown", [null, n("ncomp_LevelGeometry_1")]),
            node("Later", ["Class", n("LevelGeometry")]),
            node("Mover", ["Class", n("LevelObject")], [null, n("CreatedAtStart")]),
            node("Thing", ["Class", n("GameObject")], [null, n("CreatedAtStart")]),
            node("Own", ["Class", n("LevelGeometry")], [null, n("CreatedAtStart")]),
            node("Rail", ["Class", n("RailNode")]),
        ]),
        Buffer.from([0x01, 0x00]),
    ]);
    const { hidden } = hiddenSectors(data);
    assert.deepEqual([...hidden].sort(), ["Later", "Mover", "Thing"].map(checksum).sort());
});

// The mesh seen at the middle of the picture, plain rendering.
function middle(s: thug2Scene.Scene, view = NEAR_VIEW): number {
    const rs = buildRasterScene(s);
    const frame = new Frame(SIZE.width, SIZE.height);
    renderView(rs, view.camera, frame, { ...SIZE, jitter: 1, track: false });
    return frame.signature[(SIZE.height >> 1) * SIZE.width + (SIZE.width >> 1)]! - 1;
}

test("LESSEQUAL: of equal depths the later one is seen; a z bias brings a layer a little behind forward", () => {
    assert.equal(middle(scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 0, 400, 400)]])), 1);
    // (0.01 inch under the floor, ~24 depth steps there: the bias's 33 steps win)
    const under = (zBias: number) =>
        scene([material(1), material(2, { zBias })], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 0, 400, 400, -0.01)]]);
    assert.equal(middle(under(0)), 0);
    assert.equal(middle(under(1)), 1);
});

test("contested both ways: a layer a fraction of a step under the floor fights as much as one over it", () => {
    // (0.0002 inch: about half a depth step at 4 m)
    const at = (h: number) =>
        analyseViews(
            buildRasterScene(
                scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300, h)]]),
            ),
            [NEAR_VIEW],
            SIZE,
        ).fight;
    const over = at(0.0002);
    const under = at(-0.0002);
    assert.ok(over > 500 && under > 500, `${over} / ${under}`);
    assert.ok(Math.abs(over - under) < 0.2 * over, `${over} / ${under}`);
});

test("surfaces crossing at an angle don't fight along the line they meet", () => {
    const ramp = quad(2, 0, 0, 400, 400);
    const b = ramp.buffers[0]![1];
    for (let i = 0; i < 4; i++) b.writeFloatLE((b.readFloatLE(i * 12 + 8) - 200) / 400, i * 12 + 4); // y = (z - 200) / 400
    const s = scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [ramp]]);
    const a = analyseViews(buildRasterScene(s), [NEAR_VIEW], SIZE);
    assert.equal(a.fight, 0);
});

test("a fight covered by something opaque in front isn't seen", () => {
    const s = scene(
        [material(1), material(2), material(3)],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 100, 400, 300)], [quad(3, -1000, -1000, 1000, 1000, 40)]],
    );
    assert.equal(analyseViews(buildRasterScene(s), [NEAR_VIEW], SIZE).fight, 0);
    // (and without the cover it is)
    assert.ok(analyseViews(buildRasterScene({ ...s, sectors: s.sectors.slice(0, 2) }), [NEAR_VIEW], SIZE).fight > 0);
});
