// NOT ORIGINAL - tests of how the Proving Ground converter draws THPG's materials, on synthetic data (no game data): the
// light maps' brightness, D_N_S_4ChkBox's per-sampler tilings, a layer's mask tiled otherwise than its diffuse map, the
// Wet terrains' wet layer left out, the glass towers' facades.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checksum } from "../level_port/qb.ts";
import * as geom from "../thp8_levels/geom.ts";
import * as mats from "../thp8_levels/materials.ts";
import { layerRepeat } from "../thp8_levels/thp8_levels.ts";
import type * as xenos from "../thp8_levels/xenos.ts";
import * as layers from "./layers.ts";
import * as light from "./light.ts";
import * as scene from "./scene.ts";

layers.registerTemplates();

// A THPG material (its parameter block in THP8's layout, as scene.readMaterial makes it).
function material(
    c: number,
    template: number,
    f4: number[][],
    textures: number[],
    blend = 0,
    ref = 0,
): geom.GeomMaterial {
    const m: geom.GeomMaterial = {
        checksum: c,
        flags: 0,
        template,
        textures,
        terrain: 0,
        state: 0x44,
        params: Buffer.alloc(0x50),
    };
    scene.setParams(m, f4);
    m.params.writeUInt32BE(blend, mats.PARAM_BLEND);
    m.params.writeUInt32BE(ref << 24, mats.PARAM_ALPHA_REF);
    return m;
}

const flatTexture = (c: number, size: number, bgra: number[]): xenos.XenosTexture => {
    const px = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) px.set(bgra, 4 * i);
    return layers.madeTexture(c, size, size, px);
};

// A re-packed mesh of `fields` uv fields (vertex i's field k = (10 k + i, k)) for `m`.
function plainMesh(m: number, fields: number, vertices = 2): geom.GeomMesh {
    const stride = 20 + 4 * fields;
    const v = Buffer.alloc(stride * vertices);
    // (half floats of small whole numbers)
    const half = (x: number): number => {
        if (x === 0) return 0;
        const e = Math.floor(Math.log2(x));
        return ((e + 15) << 10) | Math.round((x / 2 ** e - 1) * 1024);
    };
    for (let i = 0; i < vertices; i++) {
        for (let k = 0; k < fields; k++) {
            v.writeUInt16BE(half(10 * k + i), i * stride + 20 + 4 * k);
            v.writeUInt16BE(half(k), i * stride + 22 + 4 * k);
        }
    }
    let layout = 0x78;
    for (let k = 0; k < fields; k++) layout |= 2 << (16 + 2 * k);
    return {
        sphere: [0, 0, 0, 1],
        material: m,
        layout: layout >>> 0,
        flags: 0,
        colorOffset: 16,
        uvOffset: 20,
        vertexCount: vertices,
        indexCount: 0,
        stride,
        vertices: v,
        indices: Buffer.alloc(0),
    };
}

test("thpg: the outdoor light map is the light (1 = the texture as it is), the interiors' lifted", () => {
    const at = (l: mats.Lighting, x: number): number => mats.light([x, x, x, 1], [0, 0, 0, 1], l)[0]!;
    assert.ok(Math.abs(at(light.lightingOf("z_love"), 1) - 1) < 1e-9);
    assert.ok(at(light.lightingOf("z_love"), 0.4) < 0.5);
    assert.ok(at(light.lightingOf("z_museum_int"), 0.15) > 0.5);
    assert.equal(light.lightingOf("Z_Crib"), light.INTERIOR_LIGHTING);
});

test("thpg: D_N_S_4ChkBox's tilings per sampler - x the diffuse map's, y the mask's", () => {
    const m = material(
        1,
        checksum("D_N_S_4ChkBox_Pass1"),
        [
            [9, 0, 0, 0],
            [0.75, 0.75, 0.75, 1],
            [3, 2, 0.5, 1], // pass 0: diffuse x 3 (the normal map's 2 not read)
            [0.5, 0.5, 0.5, 1],
            [0.875, 0.875, 0.875, 0.75],
            [0.125, 2, 1, 1], // pass 1: diffuse x 0.125, mask x 2
        ],
        [0xd0, 0xd1, 0xd2, 0xd3, 0xd4],
    );
    assert.deepEqual(mats.passTiling(m, 0), [3, 3]);
    assert.deepEqual(mats.passTiling(m, 1), [0.125, 0.125]);
    assert.deepEqual(mats.passMaskTiling(m, 1), [2, 2]);
    assert.deepEqual(mats.passColour(m, 1), [0.875, 0.875, 0.875, 0.75]);
    // (THP8's templates keep theirs: no mask tiling)
    assert.equal(mats.passMaskTiling({ ...m, template: mats.T_NORMAL_TERRAIN_4 }, 1), undefined);
});

test("thpg: a layer whose mask is tiled otherwise - one period of the coarser, the other repeated across it", () => {
    assert.equal(layerRepeat(2, 2), null);
    assert.deepEqual(layerRepeat(2, 1), { period: 1, diffuse: 2, mask: 1 });
    assert.deepEqual(layerRepeat(0.125, 2), { period: 0.125, diffuse: 1, mask: 16 });
    // a 2-texel diffuse map twice across a 2-texel mask (white | black): the alpha follows the mask at its own scale
    const d: mats.Decoded = { width: 2, height: 1, bgra: Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]) };
    const k: mats.Decoded = { width: 2, height: 1, bgra: Buffer.from([255, 255, 255, 255, 0, 0, 0, 255]) };
    const out = mats.repeatedMaskedLayer(d, k, 1, 2, 1);
    assert.equal(out.width, 4);
    assert.deepEqual(
        [0, 1, 2, 3].map((x) => [out.bgra[4 * x]!, out.bgra[4 * x + 3]!]),
        [
            [10, 255],
            [40, 255],
            [10, 0],
            [40, 0],
        ],
    );
});

test("thpg: the Wet terrains' wet mask, cube map and their uv field left out", () => {
    const cube: xenos.XenosTexture = { ...flatTexture(0x44, 4, [0, 0, 0, 255]), cube: true };
    const textures = new Map<number, xenos.XenosTexture>([[0x44, cube]]);
    const m = material(1, checksum("D_N_S_Wet_4ChkBox_Pass1"), [], [0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0x55, 0x44, 0x99]);
    const g: geom.Geom = {
        materials: [m],
        sectors: [{ checksum: 9, flags: 0, bbox: [], sphere: [], meshes: [plainMesh(1, 4)] }],
        bbox: [],
    };
    assert.equal(layers.dropWet(g, textures), 1);
    assert.deepEqual(m.textures, [0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0x99]);
    // fields 0, 1 (pass 0, pass 1), 2 (the wet mask's: left out), 3 (the light map's)
    assert.deepEqual(geom.readVertices(g.sectors[0]!.meshes[0]!)[1]!.uvs, [
        [1, 0],
        [11, 1],
        [31, 3],
    ]);
    // (no cube map among the two: not a wet layer - left as it is)
    const other = material(2, checksum("D_N_S_Wet_4ChkBox"), [], [0xd0, 0xd1, 0xd2, 0x55, 0x56, 0x99]);
    assert.equal(layers.dropWet({ materials: [other], sectors: [], bbox: [] }, textures), 0);
});

test("thpg: a glass tower's facade - pass 1 drawn, the glass a layer where its mask is black", () => {
    const textures = new Map<number, xenos.XenosTexture>([
        [0x10, flatTexture(0x10, 4, [0, 0, 0, 242])],
        [0x15, flatTexture(0x15, 4, [100, 110, 120, 255])],
        [0x18, flatTexture(0x18, 4, [0, 0, 0, 255])],
        [layers.WHITE, flatTexture(layers.WHITE, 4, [255, 255, 255, 255])],
    ]);
    const m = material(
        1,
        checksum("EnvMask_D_N_S_2ChkBox_Pass1_Normal"),
        [
            [15, 0, 0, 0],
            [0.75, 1, 1, 0.5],
            [1, 3, 0.25, 0],
            [0.5, 0.5, 0.5, 0.5],
            [1, 1, 0, 0],
            [0.875, 0.75, 0.5, 1],
            [1, 7, 0.5, 0],
            [0.25, 0.25, 0.25, 1],
        ],
        [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x99],
        3,
        1,
    );
    const g: geom.Geom = {
        materials: [m],
        sectors: [{ checksum: 9, flags: 0, bbox: [], sphere: [], meshes: [plainMesh(1, 5)] }],
        bbox: [],
    };
    assert.equal(layers.facades(g, textures), 1);
    assert.equal(m.template, layers.FACADE_TEMPLATE);
    assert.equal(m.textures[0], 0x15);
    assert.deepEqual(m.textures.slice(2), [layers.WHITE, 0x99]);
    assert.deepEqual(mats.alphaState(m), { blend: 0, ref: 0 });
    assert.deepEqual(mats.passColour(m, 0), [0.875, 0.75, 0.5, 1]);
    // (the glass layer: opaque where the mask is black - no cube map here: black glass)
    const glass = mats.decode(textures.get(m.textures[1]!)!)!;
    assert.deepEqual([...glass.bgra.subarray(0, 4)], [0, 0, 0, 255]);
    // fields: pass 1's (2), its mask's (3), the light map's (4)
    assert.deepEqual(geom.readVertices(g.sectors[0]!.meshes[0]!)[1]!.uvs, [
        [21, 2],
        [31, 3],
        [41, 4],
    ]);
    // (a material whose pass 0 isn't dark - metal, awnings: left as it is)
    textures.set(0x10, flatTexture(0x10, 4, [128, 128, 128, 255]));
    const metal = material(
        2,
        checksum("EnvMask_D_N_S_2ChkBox_Pass1_Normal"),
        [],
        [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x99],
    );
    const g2: geom.Geom = {
        materials: [metal],
        sectors: [{ checksum: 9, flags: 0, bbox: [], sphere: [], meshes: [plainMesh(2, 5)] }],
        bbox: [],
    };
    assert.equal(layers.facades(g2, textures), 0);
});
