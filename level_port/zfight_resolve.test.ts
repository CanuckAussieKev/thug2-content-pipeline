// NOT ORIGINAL - tests of zfight_resolve.ts (coplanar overlaps resolved by class) on scenes built here, measured with
// zfight_raster.ts.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { checksum } from "./qb.ts";
import { addToggles, emptyToggles, type Toggles, thereWhenever } from "./script_toggles.ts";
import * as thug2Scene from "./thug2_scene.ts";
import { analyseViews, buildRasterScene, cameraView, type ViewSpec } from "./zfight_raster.ts";
import { resolveLevelFolder, resolveScene, restrip } from "./zfight_resolve.ts";

interface MaterialOptions {
    texture?: number;
    twoSided?: boolean;
    zBias?: number;
    blend?: number;
    flags?: number;
    drawOrder?: number;
    alphaCutoff?: number;
}

function material(c: number, o: MaterialOptions = {}): thug2Scene.Material {
    return {
        checksum: c,
        nameChecksum: c,
        alphaCutoff: o.alphaCutoff ?? 0,
        sorted: 0,
        drawOrder: o.drawOrder ?? 0,
        singleSided: 0,
        noBackfaceCulling: o.twoSided ? 1 : 0,
        zBias: o.zBias ?? 0,
        grassify: 0,
        specularPower: 0,
        passes: [
            {
                texture: o.texture ?? c,
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

const FVF = thug2Scene.FVF_XYZ | thug2Scene.FVF_DIFFUSE | (1 << thug2Scene.FVF_TEXCOUNT_SHIFT);

// A floor quad (x0, z0) - (x1, z1) at `height`, facing up (or down): position, colour, uv (an FVF mesh the resolver
// can rewrite), as a 4-index strip.
function quad(m: number, x0: number, z0: number, x1: number, z1: number, height = 0, down = false): thug2Scene.Mesh {
    let corners = [
        [x0, height, z0],
        [x0, height, z1],
        [x1, height, z0],
        [x1, height, z1],
    ];
    if (down) corners = [corners[1]!, corners[0]!, corners[3]!, corners[2]!];
    const buffer = Buffer.alloc(corners.length * 24);
    corners.forEach((c, i) => {
        c.forEach((v, k) => {
            buffer.writeFloatLE(v, i * 24 + 4 * k);
        });
        buffer.writeUInt32LE(0x80808080, i * 24 + 12);
        buffer.writeFloatLE(c[0]! / 100, i * 24 + 16);
        buffer.writeFloatLE(c[2]! / 100, i * 24 + 20);
    });
    return {
        sphere: [(x0 + x1) / 2, height, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2],
        bbox: [x0, height, z0, x1, height, z1],
        flags: 0,
        material: m,
        lods: [[0, 1, 2, 3]],
        strips: [[0, 1, 2, 3]],
        stride: 24,
        vertexCount: 4,
        buffers: [[0, buffer]],
        vertexShader: [FVF, 0],
        offsets: [0, 12, 16],
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

// Looking down onto the floor (0..400 x 0..400) from 3 m away, and from below.
const VIEWS: ViewSpec[] = [cameraView([200, 80, -60, 0, -0.5, 1]), cameraView([200, 120, 200, 0.01, -1, 0.02])];
const BELOW: ViewSpec = cameraView([200, -120, 200, 0.01, 1, 0.02]);
const SIZE = { width: 160, height: 90 };

const fights = (s: thug2Scene.Scene, views = VIEWS): number => analyseViews(buildRasterScene(s), views, SIZE).fight;
const drawn = (s: thug2Scene.Scene, views = VIEWS): number => analyseViews(buildRasterScene(s), views, SIZE).drawn;
const roundTrip = (s: thug2Scene.Scene): thug2Scene.Scene => thug2Scene.readScene(thug2Scene.writeScene(s));

// The triangles a strip draws, wound as drawn (D3D's alternating winding), degenerate ones left out.
function stripTriangles(strip: readonly number[]): string[] {
    const out: string[] = [];
    for (let j = 2; j < strip.length; j++) {
        const a = strip[j - 2]!;
        const b = strip[j - 1]!;
        const c = strip[j]!;
        if (a === b || b === c || a === c) continue;
        const t = j % 2 ? [b, a, c] : [a, b, c];
        // (a triangle's rotations are the same triangle)
        const k = t.indexOf(Math.min(...t));
        out.push([...t.slice(k), ...t.slice(0, k)].join(","));
    }
    return out.sort();
}

test("restrip: triangles left out, others kept with their winding, new ones added on their own parity", () => {
    const strip = [0, 1, 2, 3, 4, 5, 6, 7];
    const all = stripTriangles(strip);
    for (const removed of [[2], [3], [4, 5], [7], [2, 3, 4, 5, 6, 7]]) {
        const out = restrip(strip, new Set(removed), [
            [10, 11, 12],
            [13, 14, 15],
        ]);
        // (the kept ones: all but the removed places' triangles)
        const removedTris = removed.map((j) => {
            const a = strip[j - 2]!;
            const b = strip[j - 1]!;
            const c = strip[j]!;
            const t = j % 2 ? [b, a, c] : [a, b, c];
            const k = t.indexOf(Math.min(...t));
            return [...t.slice(k), ...t.slice(0, k)].join(",");
        });
        const expected = all
            .filter((t) => !removedTris.includes(t))
            .concat(["10,11,12", "13,14,15"])
            .sort();
        assert.deepEqual(stripTriangles(out), expected, `removed ${removed}`);
    }
});

test("duplicate: a copy wholly under another of the same material is dropped; the floor is untouched", () => {
    const s = scene(
        [material(1)],
        [[quad(1, 0, 0, 400, 400)], [quad(1, 100, 100, 300, 300)]], // (a patch on it: not an exact copy)
    );
    assert.ok(fights(s) > 500, `${fights(s)} before`);
    const floorBefore = thug2Scene.writeScene({ ...s, sectors: [s.sectors[0]!] });
    const r = resolveScene(s);
    assert.equal(r.meshPairs.duplicate, 1);
    assert.equal(r.dropped, 2);
    const after = roundTrip(s);
    assert.equal(fights(after), 0);
    assert.ok(thug2Scene.writeScene({ ...s, sectors: [s.sectors[0]!] }).equals(floorBefore));
});

test("duplicate: a copy partly covered is cut along the cover - no fight, no hole", () => {
    const s = scene([material(1)], [[quad(1, 0, 0, 400, 400)], [quad(1, 200, 100, 600, 300)]]);
    const coverBefore = drawn(s);
    assert.ok(fights(s) > 500);
    const r = resolveScene(s);
    assert.ok(r.cut > 0 && r.pieces > 0, JSON.stringify(r));
    const after = roundTrip(s);
    assert.equal(fights(after), 0);
    assert.equal(drawn(after), coverBefore);
});

test("overlap: the base under a smaller opaque detail of another look is cut away", () => {
    const s = scene([material(1), material(2)], [[quad(1, 0, 0, 400, 400)], [quad(2, 150, 150, 250, 250)]]);
    const before = drawn(s);
    assert.ok(fights(s) > 100);
    const r = resolveScene(s);
    assert.equal(r.meshPairs.overlap, 1);
    assert.equal(r.biased, 0);
    const after = roundTrip(s);
    assert.equal(fights(after), 0);
    assert.equal(drawn(after), before);
    // (the detail itself whole: still its two triangles)
    assert.equal(stripTriangles(after.sectors[1]!.meshes[0]!.strips[0]!).length, 2);
});

test("overlap: a detail with cut-out texels isn't cut into its base - it gets a z bias over it", () => {
    const s = scene(
        [material(1), material(2, { alphaCutoff: 128 })],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 150, 150, 250, 250)]],
    );
    const r = resolveScene(s, { cutOut: new Set([2]) });
    assert.equal(r.cut + r.dropped, 0);
    assert.equal(s.materials[1]!.zBias, 1);
    assert.equal(fights(roundTrip(s)), 0);
});

test("layer: a see-through layer a little behind its base is put on it and biased over it", () => {
    const s = scene(
        [material(1), material(2, { blend: 5, flags: thug2Scene.PASS_TRANSPARENT })],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 100, 100, 300, 300, -0.3)]],
    );
    const r = resolveScene(s);
    assert.equal(r.meshPairs.layer, 1);
    assert.equal(s.materials[1]!.zBias, 1);
    assert.equal(r.snapped, 4);
    assert.equal(s.sectors[1]!.meshes[0]!.buffers[0]![1].readFloatLE(4), 0);
    assert.equal(fights(roundTrip(s)), 0);
});

test("layer: one drawn before the opaque surface it lies on gets a later draw order; over a see-through one not", () => {
    // (a blended layer without the transparent flag: drawn in the opaque pass, by draw order - before its floor)
    const s = scene(
        [material(1, { drawOrder: 5 }), material(2, { blend: 5, drawOrder: 1 })],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 100, 100, 300, 300)]],
    );
    const r = resolveScene(s);
    assert.equal(r.reordered, 1);
    assert.ok(s.materials[1]!.drawOrder > 5);
    assert.equal(s.materials[1]!.zBias, 1);
    assert.equal(fights(roundTrip(s)), 0);
    // both see-through, the layer first: its bias settles it, the source's order is kept
    const w = scene(
        [
            material(1, { blend: 5, flags: thug2Scene.PASS_TRANSPARENT, drawOrder: 5 }),
            material(2, { blend: 5, flags: thug2Scene.PASS_TRANSPARENT, drawOrder: 1, zBias: 1 }),
        ],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 100, 100, 300, 300)]],
    );
    assert.equal(resolveScene(w).reordered, 0);
    assert.equal(w.materials[1]!.drawOrder, 1);
    assert.equal(fights(roundTrip(w)), 0);
});

test("opposite: two two-sided sides back to back are made one-sided where they lie on each other", () => {
    const s = scene(
        [material(1, { twoSided: true }), material(2, { twoSided: true })],
        [[quad(1, 0, 0, 400, 400)], [quad(2, 0, 0, 400, 400, 0, true)]],
    );
    assert.ok(fights(s, [...VIEWS, BELOW]) > 500);
    const r = resolveScene(s);
    assert.equal(r.meshPairs.opposite, 1);
    assert.equal(r.oneSided, 2);
    const after = roundTrip(s);
    assert.equal(fights(after, [...VIEWS, BELOW]), 0);
    // (seen from above and from below: each side still there)
    assert.ok(drawn(after, [BELOW]) > 1000);
    assert.ok(drawn(after, [VIEWS[1]!]) > 1000);
    const oneSided = after.materials.filter((m) => m.singleSided === 1 && m.noBackfaceCulling === 0);
    assert.equal(oneSided.length, 2);
});

test("states: alternate states the scripts show one at a time are left alone", () => {
    const s = scene([material(1)], [[quad(1, 0, 0, 400, 400)], [quad(1, 100, 100, 300, 300)]]);
    const toggles: Toggles = emptyToggles();
    toggles.hides.set(1, new Set([1]));
    toggles.shows.set(2, new Set([1]));
    toggles.hides.set(2, new Set([2]));
    toggles.shows.set(1, new Set([2]));
    const r = resolveScene(s, { toggles });
    assert.equal(r.meshPairs.states, 1);
    assert.equal(r.cut + r.dropped, 0);
});

test("a cover only shown with the copy (one area's culling) still keeps for it", () => {
    const s = scene([material(1)], [[quad(1, 0, 0, 400, 400)], [quad(1, 100, 100, 300, 300)]]);
    const toggles: Toggles = emptyToggles();
    for (const sector of [1, 2]) {
        toggles.hides.set(sector, new Set([7]));
        toggles.shows.set(sector, new Set([8]));
    }
    assert.ok(thereWhenever(toggles, 1, 2) && thereWhenever(toggles, 2, 1));
    const r = resolveScene(s, { toggles });
    assert.equal(r.dropped, 2);
});

test("script toggles: runs of Invisible / Visible statements, broken by other statements", () => {
    // script s
    //     Invisible name=A
    //     Invisible name=B      (one run: A and B go together)
    //     if
    //     Visible name=A
    //     Invisible name=C      (A shown, C hidden: different runs)
    //     Invisible name=E
    //     Visible name=F
    //     Invisible name=F      (another kind of command: a new run each time)
    // endscript
    const tok = (t: number, value?: number): Buffer => {
        if (value === undefined) return Buffer.from([t]);
        const b = Buffer.alloc(5);
        b[0] = t;
        b.writeUInt32LE(value >>> 0, 1);
        return b;
    };
    const name = (n: string): Buffer => tok(0x16, checksum(n));
    const line = (verb: string, sector: string): Buffer =>
        Buffer.concat([name(verb), name("name"), tok(0x07), name(sector), tok(0x01)]);
    const qb = Buffer.concat([
        tok(0x23),
        name("s"),
        tok(0x01),
        line("Invisible", "A"),
        line("Invisible", "B"),
        name("if"),
        tok(0x01),
        line("Visible", "A"),
        line("Invisible", "C"),
        line("Invisible", "E"),
        line("Visible", "F"),
        line("Invisible", "F"),
        tok(0x24),
        tok(0x01),
        tok(0x00),
    ]);
    const t = emptyToggles();
    const sectors = new Set(["A", "B", "C", "E", "F"].map(checksum));
    addToggles(t, qb, "test.qb", sectors);
    const [A, B, C] = ["A", "B", "C"].map(checksum) as [number, number, number];
    assert.ok(thereWhenever(t, A, B), "A is hidden with B and shown on its own: there whenever B is");
    assert.ok(!thereWhenever(t, B, A), "B isn't shown where A is");
    assert.ok(!thereWhenever(t, C, A) && !thereWhenever(t, A, C));
    assert.ok(!thereWhenever(t, checksum("F"), checksum("E")));
});

test("bit-identical copies of one material are cut alike (and stay bit-identical)", () => {
    const s = scene(
        [material(1), material(2)],
        [[quad(1, 0, 0, 400, 400)], [quad(1, 0, 0, 400, 400)], [quad(2, 150, 150, 250, 250)]],
    );
    const r = resolveScene(s);
    assert.ok(r.cut >= 2, JSON.stringify(r));
    const a = s.sectors[0]!.meshes[0]!;
    const b = s.sectors[1]!.meshes[0]!;
    assert.ok(a.buffers[0]![1].equals(b.buffers[0]![1]));
    assert.deepEqual(a.strips[0], b.strips[0]);
    assert.equal(fights(roundTrip(s)), 0);
    // one of them not rewritable (a built-in vertex shader): neither is cut
    const t = scene(
        [material(1), material(2)],
        [
            [quad(1, 0, 0, 400, 400)],
            [{ ...quad(1, 0, 0, 400, 400), vertexShader: [1, 0] }],
            [quad(2, 150, 150, 250, 250)],
        ],
    );
    const before = thug2Scene.writeScene({ ...t, materials: [], sectors: [t.sectors[0]!] });
    resolveScene(t);
    assert.ok(thug2Scene.writeScene({ ...t, materials: [], sectors: [t.sectors[0]!] }).equals(before));
    // (the detail biased over both instead)
    assert.equal(t.materials[1]!.zBias, 1);
    assert.equal(fights(roundTrip(t)), 0);
});

test("the same input resolves the same (deterministic); collision and textures aren't touched", () => {
    const make = () =>
        scene(
            [material(1), material(2), material(3, { blend: 5, flags: thug2Scene.PASS_TRANSPARENT })],
            [
                [quad(1, 0, 0, 400, 400)],
                [quad(1, 200, 100, 600, 300)],
                [quad(2, 50, 50, 120, 120)],
                [quad(3, 300, 300, 380, 380, -0.2)],
            ],
        );
    const a = make();
    const b = make();
    resolveScene(a);
    resolveScene(b);
    assert.ok(thug2Scene.writeScene(a).equals(thug2Scene.writeScene(b)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zfr"));
    try {
        fs.writeFileSync(path.join(dir, "lvl.scn.xbx"), thug2Scene.writeScene(make()));
        const col = Buffer.from("not read, not written");
        fs.writeFileSync(path.join(dir, "lvl.col.xbx"), col);
        resolveLevelFolder(dir, "lvl");
        assert.ok(fs.readFileSync(path.join(dir, "lvl.col.xbx")).equals(col));
        assert.ok(fs.readFileSync(path.join(dir, "lvl.scn.xbx")).equals(thug2Scene.writeScene(a)));
        // (a second pass finds nothing more to do)
        const again = resolveLevelFolder(dir, "lvl");
        assert.equal(again.dropped + again.cut + again.culled, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
