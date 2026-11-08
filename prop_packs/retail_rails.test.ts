import * as assert from "node:assert/strict";
import { test } from "node:test";
import { checksum, Name, QbFile, Struct, Vector } from "thug2-level-converter-core/level_port/qb.ts";
import { encodeValue } from "thug2-level-converter-core/level_port/qb_write.ts";
import { appendRails, readLayoutRails, stripRails } from "./retail_rails.ts";

function levelQb(): Buffer {
    const node = (name: string, links: number[]): Struct =>
        new Struct([
            [new Name(checksum("Pos")), new Vector("vector", [1, 2, 3])],
            [new Name(checksum("Name")), new Name(checksum(name))],
            [new Name(checksum("Class")), new Name(checksum("RailNode"))],
            ...(links.length ? ([[new Name(checksum("Links")), links]] as [Name, number[]][]) : []),
        ]);
    const name = Buffer.alloc(5);
    name[0] = 0x16;
    name.writeUInt32LE(checksum("BO_NodeArray"), 1);
    return Buffer.concat([
        Buffer.from([0x01]),
        name,
        Buffer.from([0x07]),
        encodeValue([node("TRG_A", [1]), node("TRG_B", [])]),
        Buffer.from([0x01, 0x00]),
    ]);
}

test("layout rail points", () => {
    const points = readLayoutRails(
        "thug2-decomp layout 2\nscene 1\npoint R1 RailNode pos=1,2,3 terrain=TERRAIN_GRINDWOOD links=" +
            `${checksum("R2").toString(16).padStart(8, "0")},${checksum("TRG_A").toString(16).padStart(8, "0")}\n` +
            "point R2 RailNode pos=4,5,6 cluster=0000abcd\npoint W1 Waypoint pos=0,0,0\npoint X RailNode\n",
    );
    assert.equal(points.length, 2);
    assert.equal(points[0]!.terrain, "TERRAIN_GRINDWOOD");
    assert.deepEqual(points[0]!.links, [checksum("R2"), checksum("TRG_A")]);
    assert.equal(points[1]!.cluster, 0xabcd);
});

test("rails appended to the node array, taken off again", () => {
    const qb = levelQb();
    const points = [
        { name: "R1", pos: { x: 1, y: 2, z: 3 }, terrain: "", links: [checksum("R2"), checksum("TRG_A")], cluster: 0 },
        { name: "R2", pos: { x: 4, y: 5, z: 6 }, terrain: "TERRAIN_GRINDWOOD", links: [], cluster: 0 },
        { name: "TRG_B", pos: { x: 0, y: 0, z: 0 }, terrain: "", links: [], cluster: 0 },
    ];
    const out = appendRails(qb, "BO", points);
    assert.deepEqual(out.nodes, ["R1", "R2"]);
    assert.deepEqual(out.clashes, ["TRG_B"]);
    assert.equal(out.droppedLinks, 1);
    assert.equal(out.baseCount, 2);
    const file = new QbFile(out.data, "bo.qb", true);
    const nodes = file.globals.find(([k]) => k.value === checksum("BO_NodeArray"))![1] as Struct[];
    assert.equal(nodes.length, 4);
    assert.deepEqual(nodes[2]!.get("Links"), [3]);
    assert.deepEqual((nodes[3]!.get("TerrainType") as Name).value, checksum("TERRAIN_GRINDWOOD"));
    assert.equal(file.names.get(checksum("R1")), "R1");
    // (the level's own nodes byte for byte)
    assert.ok(out.data.subarray(0, 40).equals(qb.subarray(0, 40)));
    const back = stripRails(out.data, "BO", out.nodes)!;
    const again = new QbFile(back, "bo.qb", true);
    assert.equal((again.globals.find(([k]) => k.value === checksum("BO_NodeArray"))![1] as Struct[]).length, 2);
    assert.equal(stripRails(out.data, "BO", ["R2", "R1"]), null);
    assert.equal(stripRails(qb, "BO", ["R1"]), null);
});
