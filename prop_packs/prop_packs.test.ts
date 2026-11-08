import * as assert from "node:assert/strict";
import { test } from "node:test";
import { applyInsertions } from "../retail/script_merge.ts";
import { applyPlacement, memberName, packId, readManifest } from "./pack.ts";
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
