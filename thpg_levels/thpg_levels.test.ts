// NOT ORIGINAL - tests of the Proving Ground converter's readers on synthetic data (no game data): the 0x0410 material
// records, the uv fields re-packed (kind 3, gaps, the light map's field copied), the light maps wired as THP8's pair, the
// layered templates' names, decals, the network levels, the elseif token.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checksum } from "../level_port/qb.ts";
import { pack } from "../lib/struct.ts";
import * as thaw from "../thaw_levels/thaw.ts";
import { scriptToks } from "../thaw_levels/thaw_scripts.ts";
import * as geom from "../thp8_levels/geom.ts";
import * as mats from "../thp8_levels/materials.ts";
import type * as xenos from "../thp8_levels/xenos.ts";
import * as layers from "./layers.ts";
import * as light from "./light.ts";
import * as scene from "./scene.ts";
import { netSpecs } from "./thpg_levels.ts";

// A material record: 0xA0 bytes of checksum + zeros, the header words, float4s at 0x100, textures after them.
function record(c: number, template: number, f4: number[][], textures: number[], blend = 0, ref = 0): Buffer {
    const fAt = 0x100;
    const tAt = fAt + 16 * f4.length;
    const size = (tAt + 4 * textures.length + 15) & ~15;
    const r = Buffer.alloc(Math.max(size, 0x100));
    r.writeUInt32BE(c, 0);
    r.writeUInt32BE(template, scene.REC_TEMPLATE);
    r.writeUInt32BE(0x100, 0xac);
    r.writeUInt32BE(f4.length, scene.REC_FLOAT4S);
    r.writeUInt32BE(fAt, scene.REC_FLOAT4S + 4);
    r.writeUInt32BE(textures.length, scene.REC_TEXTURES);
    r.writeUInt32BE(tAt, scene.REC_TEXTURES + 4);
    r.writeUInt32BE(r.length, scene.REC_SIZE);
    r.writeUInt32BE(0x44, scene.REC_STATE);
    r.writeUInt32BE(blend, scene.REC_BLEND);
    r.writeUInt32BE((ref << 24) | 0x20000, scene.REC_ALPHA_REF);
    f4.forEach((f, k) => {
        f.forEach((x, i) => {
            r.writeFloatBE(x, fAt + 16 * k + 4 * i);
        });
    });
    textures.forEach((t, k) => {
        r.writeUInt32BE(t, tAt + 4 * k);
    });
    return r;
}

test("thpg: a 0x0410 material record read as THP8's material, its parameter block in THP8's layout", () => {
    const t = checksum("D_3ChkBox_Pass0_Pass1");
    const r = record(
        0x1234,
        t,
        [
            [0.5, 0.25, 1, 1],
            [1, 1, 1, 0.5],
        ],
        [0xaaaa, 0xbbbb, 0xcccc, 0xdddd],
        3,
        0x64,
    );
    const m = scene.readMaterial(r, 0, r.length, "test");
    assert.equal(m.checksum, 0x1234);
    assert.equal(m.template, t);
    assert.deepEqual(m.textures, [0xaaaa, 0xbbbb, 0xcccc, 0xdddd]);
    assert.deepEqual(mats.float4s(m), [
        [0.5, 0.25, 1, 1],
        [1, 1, 1, 0.5],
    ]);
    assert.deepEqual(mats.alphaState(m), { blend: 3, ref: 0x64 });
    // (a record running past the block is an error)
    assert.throws(() => scene.readMaterial(r, 0, r.length - 16, "test"), /material record/);
});

test("thpg: vertices re-packed - gaps between uv slots, a kind-3 field, the last field copied", () => {
    // position, normal word, colour at 16, uv fields: slot 0 (kind 2), slot 2 (kind 3, 8 bytes), slot 5 (kind 2)
    const layout = (2 << 16) | (3 << 20) | (2 << 26) | 0x0078;
    assert.deepEqual(
        geom.uvFields(layout).map((f) => [f.slot, f.kind, f.offset]),
        [
            [0, 2, 0],
            [2, 3, 4],
            [5, 2, 12],
        ],
    );
    const stride = 20 + 4 + 8 + 4;
    const v = Buffer.alloc(stride * 2);
    for (let i = 0; i < 2; i++) {
        const o = i * stride;
        v.writeFloatBE(i + 1, o);
        v.writeUInt32BE(0xff102030, o + 16);
        v.writeUInt16BE(0x3c00, o + 20); // 1.0
        v.writeUInt16BE(0x4000, o + 22); // 2.0
        v.writeUInt16BE(0x3800, o + 24); // 0.5 (the kind-3 field's first two)
        v.writeUInt16BE(0x3400, o + 26); // 0.25
        v.writeUInt16BE(0x4200, o + 32); // 3.0 (the light map's)
        v.writeUInt16BE(0x4400, o + 34); // 4.0
    }
    const mesh: geom.GeomMesh = {
        sphere: [0, 0, 0, 1],
        material: 1,
        layout,
        flags: 0,
        colorOffset: 16,
        uvOffset: 20,
        vertexCount: 2,
        indexCount: 0,
        stride,
        vertices: v,
        indices: Buffer.alloc(0),
    };
    assert.deepEqual(geom.readVertices(mesh)[1]!.uvs, [
        [1, 2],
        [0.5, 0.25],
        [3, 4],
    ]);
    const packed = scene.repack(mesh);
    assert.equal(packed.stride, 20 + 12);
    assert.deepEqual(geom.uvSlots(packed.layout), [0, 1, 2]);
    const out = geom.readVertices(packed);
    assert.deepEqual(out[1]!.position, [2, 0, 0]);
    assert.deepEqual(out[1]!.color, [0x30, 0x20, 0x10, 0xff]);
    assert.deepEqual(out[1]!.uvs, [
        [1, 2],
        [0.5, 0.25],
        [3, 4],
    ]);
    const lit = scene.repack(packed, true);
    assert.deepEqual(geom.readVertices(lit)[0]!.uvs.slice(-2), [
        [3, 4],
        [3, 4],
    ]);
});

const flatTexture = (c: number, size: number, bgra: number[]): xenos.XenosTexture => {
    const px = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) px.set(bgra, 4 * i);
    return layers.madeTexture(c, size, size, px);
};

test("thpg: the light map listed twice and its uv field copied (THP8's ambient + shadow pair), stand-ins not", () => {
    const lm = 0x11;
    const white = 0x22; // (a 32 x 32 white stand-in: a blank, not a light map)
    const noise = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) & 0xff;
    const textures = new Map<number, xenos.XenosTexture>([
        [lm, layers.madeTexture(lm, 64, 64, noise)],
        [white, flatTexture(white, 32, [255, 255, 255, 255])],
        [0x33, layers.madeTexture(0x33, 64, 64, noise)],
    ]);
    const material = (c: number, textures: number[]): geom.GeomMaterial => ({
        checksum: c,
        flags: 0,
        template: 0,
        textures,
        terrain: 0,
        state: 0,
        params: Buffer.alloc(0x50),
    });
    const mesh = (m: number): geom.GeomMesh => ({
        sphere: [0, 0, 0, 1],
        material: m,
        layout: (2 << 16) | (2 << 18) | 0x78,
        flags: 0,
        colorOffset: 16,
        uvOffset: 20,
        vertexCount: 1,
        indexCount: 0,
        stride: 28,
        vertices: Buffer.alloc(28),
        indices: Buffer.alloc(0),
    });
    const g: geom.Geom = {
        materials: [material(1, [0x33, lm]), material(2, [0x33, white])],
        sectors: [{ checksum: 9, flags: 0, bbox: [], sphere: [], meshes: [mesh(1), mesh(2)] }],
        bbox: [],
    };
    assert.equal(light.wireLightMaps(g, textures), 1);
    assert.deepEqual(g.materials[0]!.textures, [0x33, lm, light.shadowOf(lm)]);
    assert.deepEqual(g.materials[1]!.textures, [0x33, white]);
    assert.equal(textures.get(light.shadowOf(lm))!.data, textures.get(lm)!.data);
    assert.deepEqual(geom.uvSlots(g.sectors[0]!.meshes[0]!.layout), [0, 1, 2]);
    assert.deepEqual(geom.uvSlots(g.sectors[0]!.meshes[1]!.layout), [0, 1]);
    // (THP8's planner then reads the pair as its ambient + shadow maps)
    const maps = mats.lightMaps(g.materials);
    assert.ok(maps.ambient.has(lm) && maps.shadow.has(light.shadowOf(lm)));
});

test("thpg: the layered templates' names (pass 0 named in the 3ChkBox families, always on in D_N_S_4ChkBox)", () => {
    const of = (name: string): layers.TemplateInfo | undefined => layers.TEMPLATES.get(checksum(name));
    assert.deepEqual(of("D_3ChkBox_Pass0_Pass2")?.passes, [0, 2]);
    assert.deepEqual(of("D_3ChkBox_Pass1")?.passes, [1]);
    assert.deepEqual(of("D_S_3ChkBox_Pass0_Pass1_Pass2")?.family, "D_S");
    assert.deepEqual(of("D_N_S_4ChkBox")?.passes, [0]);
    assert.deepEqual(of("D_N_S_4ChkBox_Pass1_Pass3")?.passes, [0, 1, 3]);
    assert.equal(of("D_N_S_4ChkBox_Pass0"), undefined);
    assert.equal(layers.TEMPLATES.size, 7 + 7 + 8);
});

test("thpg: a decal's texture - the diffuse map with the mask's brightness x the pass colour as its alpha", () => {
    const d: mats.Decoded = { width: 1, height: 1, bgra: Buffer.from([100, 100, 100, 255]) };
    const mask: mats.Decoded = { width: 2, height: 1, bgra: Buffer.from([255, 255, 255, 255, 0, 0, 0, 255]) };
    const out = layers.decalTexels(d, mask, [0, 0, 0, 0.5]);
    assert.equal(out.width, 2);
    assert.deepEqual([...out.bgra], [0, 0, 0, 128, 0, 0, 0, 0]);
});

test("thpg: network levels - WORLD every city zone, the barrier levels their area's zone first, the lounge's theme", () => {
    const specs = netSpecs([
        { id: "wholeworld", text: "WORLD", zones: ["z_love"], barriers: "", mainZone: "", description: "" },
        {
            id: "onlinephilly",
            text: "PHILLY",
            zones: ["z_love"],
            barriers: "z_online_philly",
            mainZone: "load_z_slums",
            description: "",
        },
        {
            id: "netcrib",
            text: "SKATE LOUNGE",
            zones: ["z_crib"],
            barriers: "z_crib",
            mainZone: "z_crib",
            description: "",
        },
    ]);
    assert.deepEqual(
        specs.map((s) => s.level),
        ["thpg_net_wholeworld", "thpg_net_philly", "thpg_net_crib"],
    );
    assert.equal(specs[0]!.zones[0], "z_love");
    assert.ok(specs[0]!.zones.includes("z_harbor") && specs[0]!.big);
    assert.deepEqual(specs[1]!.zones, ["z_slums", "z_love"]);
    assert.deepEqual(specs[1]!.barriers, ["z_online_philly"]);
    assert.deepEqual(specs[2]!.zones, ["z_crib", "z_crib_default"]);
    assert.deepEqual(specs[2]!.barriers, []);
});

test("thpg: the Xbox 360 games' elseif (0x27, two u16 jumps) made else + a nested if, closed by one more endif", () => {
    const name = (text: string): Buffer => Buffer.concat([Buffer.from([0x16]), pack("<I", checksum(text))]);
    const body = Buffer.concat([
        Buffer.from([0x47]),
        pack("<H", 0),
        name("A"),
        Buffer.from([0x01]),
        name("X"),
        Buffer.from([0x01, 0x27]),
        pack("<HH", 0, 0),
        name("B"),
        Buffer.from([0x01]),
        name("Y"),
        Buffer.from([0x01, 0x28, 0x01, 0x24]),
    ]);
    // (THAW's - order "<" - 0x27 has no payload: not read as one)
    assert.equal([...thaw.tokens(body, ">")].filter(([, t]) => t === 0x27).length, 1);
    const names = new Map(["A", "B", "X", "Y"].map((n) => [checksum(n), n]));
    const shown = scriptToks(body, names, "test", ">").map((t) => (t.t === 0x16 ? names.get(t.name()!) : t.t));
    assert.deepEqual(shown, [
        0x25,
        "A",
        0x01,
        "X",
        0x01,
        0x26,
        0x01,
        0x25,
        "B",
        0x01,
        "Y",
        0x01,
        0x28,
        0x01,
        0x28,
        0x01,
    ]);
});
