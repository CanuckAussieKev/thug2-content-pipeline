import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Face } from "thug2-level-converter-core/level_port/thug2_col.ts";
import { applyInsertions } from "../retail/script_merge.ts";
import { applyPlacement, belongsBelow, cutBelow, memberName, packId, readManifest } from "./pack.ts";
import { HOOK, levelsQbInsertions, readLayoutProps } from "./retail_props.ts";

test("pack ids and member names", () => {
    assert.equal(packId("LA", "Fire_Tender"), "pp_la_fire_tender");
    assert.equal(packId("SE2", "a b-c"), "pp_se2_a_b_c");
    assert.ok(packId("LA", "x".repeat(80)).length <= 48);
    assert.equal(memberName("pp_la_x", 0), "pp_la_x");
    assert.equal(memberName("pp_la_x", 2), "pp_la_x_2");
});

test("placement: scale, quarter turn, offset (the editor's order)", () => {
    const p = { quarters: 1, offset: { x: 10, y: 0, z: 0 }, scale: { x: 2, y: 1, z: 1 } };
    assert.deepEqual(applyPlacement(p, { x: 1, y: 2, z: 3 }), { x: 13, y: 2, z: -2 });
});

test("collision-only objects: inside the piece, or sunk below its bottom", () => {
    // (LA's Fire_Tender and the collision shell under it - b98f305e)
    const truck = { min: { x: -2703, y: -418, z: 6056 }, max: { x: -1975, y: -248, z: 6618 } };
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({
        min: { x: x0, y: y0, z: z0 },
        max: { x: x1, y: y1, z: z1 },
    });
    assert.ok(belongsBelow(box(-2702, -610, 6065, -1975, -240, 6618), truck)); // sunk into the ground
    assert.ok(belongsBelow(box(-2693, -420, 6370, -2587, -374, 6502), truck)); // inside
    assert.ok(!belongsBelow(box(-2720, -451, 6429, -1950, 784, 6626), truck)); // a trigger reaching far above
    assert.ok(!belongsBelow(box(-2702, -900, 6065, -1975, -500, 6618), truck)); // wholly under it
    assert.ok(!belongsBelow(box(-3336, -610, 5978, -2556, -300, 6699), truck)); // wider than it
});

test("a sunk shell cut off below the piece's bottom", () => {
    // (a wall from y -200 to 100 in two faces, and a bottom face at -200)
    const shell = {
        checksum: 1,
        flags: 0,
        smallFaces: 1,
        fixedVerts: 0,
        bbox: [0, -200, 0, 1, 10, 100, 10, 1],
        verts: [
            [0, -200, 0],
            [10, -200, 0],
            [10, 100, 0],
            [0, 100, 0],
            [0, -200, 10],
        ],
        intensities: Buffer.alloc(5),
        faces: [
            [0, 0, 0, 1, 2],
            [0, 0, 0, 2, 3],
            [0, 0, 0, 1, 4],
        ] as Face[],
        reach: Buffer.alloc(0),
        bsp: { kind: "leaf" as const, faces: [], low: 3 },
    };
    const cut = cutBelow(shell, -24);
    assert.deepEqual(
        cut.verts.map((v) => v[1]),
        [-24, -24, 100, 100, -24],
    );
    assert.equal(cut.faces.length, 2); // (the bottom face, now flat on the floor, gone)
    assert.equal(shell.verts[0]![1], -200); // (the source left as it was)
});

test("manifest read back", () => {
    const m = readManifest(
        "prop-pack 1\nid pp_la_ft\nsource LA Fire_Tender 61ef3ad4\nsector 99e6f8e2 pp_la_ft Fire_Tender\n" +
            "sector b3d33307 pp_la_ft_1 FE_CAB\nrail pp_la_ft_TRG_1 1 2 3 TERRAIN_METALSMOOTH pp_la_ft_TRG_2 trick\n" +
            "rail pp_la_ft_TRG_2 4 5 6 - -\n",
    );
    assert.equal(m.id, "pp_la_ft");
    assert.deepEqual(m.sectors, [0x99e6f8e2, 0xb3d33307]);
    assert.equal(m.rails.length, 2);
    assert.deepEqual(m.rails[0]!.links, ["pp_la_ft_TRG_2"]);
    assert.equal(m.rails[0]!.trick, true);
    assert.deepEqual(m.rails[1]!.links, []);
});

test("layout records: packs, sectors, clones", () => {
    const l = readLayoutProps(
        "thug2-decomp layout 2\nscene 34e098ec\nprop pp_la_ft\nprop pp_la_ft\n" +
            "sector 99e6f8e2 1 100 0 200 0\nsector b3d33307 0 1 2 3 1 scale=2\nclone 99e6f8e2 2 9 8 7 scale=1,2,3 # c\n",
    );
    assert.equal(l.scene, 0x34e098ec);
    assert.deepEqual(l.packs, ["pp_la_ft"]);
    assert.equal(l.sectors.get(0x99e6f8e2)!.placement.quarters, 1);
    assert.equal(l.sectors.get(0xb3d33307)!.hidden, true);
    assert.deepEqual(l.sectors.get(0xb3d33307)!.placement.scale, { x: 2, y: 2, z: 2 });
    assert.deepEqual(l.clones[0]!.placement.scale, { x: 1, y: 2, z: 3 });
});

test("Levels.qb: the load_level hook once, a key per level", () => {
    const text =
        "script load_level {\n    LoadCollision scene=<level> \n    PopMemProfile \n    change ParseNodeArrayIgnoreGaps=0 \n}\n" +
        "Level_BO = {\n    structure_name=Level_BO \n} \nLevel_LA = {\n    structure_name=Level_LA \n} \n";
    const out = applyInsertions(text, levelsQbInsertions(text, ["BO", "LA"]));
    assert.ok(out.includes(`    PopMemProfile \n${HOOK.join("\n")}\n    change ParseNodeArrayIgnoreGaps=0`));
    assert.ok(out.includes('Level_BO = {\n    props_scene="BO_Props" \n'));
    assert.ok(out.includes('Level_LA = {\n    props_scene="LA_Props" \n'));
    assert.throws(() => levelsQbInsertions(out, ["BO"]));
    assert.deepEqual(levelsQbInsertions(text, []), []);
});
