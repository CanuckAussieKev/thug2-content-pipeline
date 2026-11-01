// NOT ORIGINAL - tests of THP8's material reading, fix round 7: the reflective
// 3-pass template's layout, the passes' tiling, the grey stand-in, on synthetic data (no game data).

import assert from "node:assert/strict";
import { test } from "node:test";
import { checksum } from "../level_port/qb.ts";
import type * as geom from "./geom.ts";
import * as mats from "./materials.ts";
import * as xenos from "./xenos.ts";

const material = (template: number, textures: number[], float4s: number[][] = []): geom.GeomMaterial => {
    const params = Buffer.alloc(mats.PARAM_HEADER + 16 * float4s.length + 4 * textures.length);
    params.writeUInt32BE(textures.length, 0x08);
    params.writeUInt32BE(float4s.length, mats.PARAM_FLOAT4S);
    float4s.forEach((f, i) => {
        f.forEach((x, c) => {
            params.writeFloatBE(x, mats.PARAM_HEADER + 16 * i + 4 * c);
        });
    });
    return { checksum: 1, flags: 0, template, textures, terrain: 0, state: 0, params };
};
const textures = new Map<number, xenos.XenosTexture>(
    [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0xa0, 0xa1, 0x90, 0x91].map((c) => [
        c,
        {
            checksum: c,
            format: c >= 0x90 && c < 0xa0 ? xenos.FMT_DXN : xenos.FMT_DXT1,
        } as unknown as xenos.XenosTexture,
    ]),
);
const MAPS = { ambient: new Set([0xa0]), shadow: new Set([0xa1]) };

test("NormalMapEnvMap_3Pass: pass 0, cube map and mask skipped, pass 1 with its own mask; uv slots 2 / 3 of six", () => {
    // diffuse, normal, specular | cube, pass 0 mask | diffuse, normal, specular, mask | ambient, shadow
    const m = material(
        mats.T_NORMAL_ENV_3,
        [0x10, 0x91, 0x11, 0x12, 0x13, 0x14, 0x90, 0x15, 0x16, 0xa0, 0xa1],
        [
            [66, 0, 0, 0],
            [0.5, 0.5, 0.5, 0.65], // pass 0 colour (+ opacity)
            [0.5, 0.25, 1, 1], // pass 0 tiling
            [0.5, 0.5, 0.5, 1],
            [0.1, 0.75, 0, 0.01],
            [0.75, 0.75, 0.75, 0.5], // pass 1 colour
            [0.5, 0.25, 1, 1], // pass 1 tiling
            [0.25, 0.25, 0.25, 1],
        ],
    );
    const plan = mats.planMaterial(m, textures, MAPS, 6);
    assert.equal(plan.layers.length, 2);
    assert.equal(plan.layers[0]!.diffuse, 0x10);
    assert.equal(plan.layers[1]!.diffuse, 0x14);
    assert.equal(plan.layers[1]!.mask, 0x16);
    assert.deepEqual([plan.layers[1]!.slot, plan.layers[1]!.maskSlot], [2, 3]);
    assert.deepEqual(plan.layers[0]!.colour, [0.5, 0.5, 0.5, Math.fround(0.65)]);
    assert.deepEqual(plan.layers[0]!.tiling, [0.5, 0.25]);
    assert.deepEqual(plan.layers[1]!.tiling, [0.5, 0.25]);
    // five uv fields: the mask shares pass 1's
    const five = mats.planMaterial(m, textures, MAPS, 5);
    assert.deepEqual([five.layers[1]!.slot, five.layers[1]!.maskSlot], [2, 2]);
    // not the layout (a different count): pass 0 alone
    const odd = material(mats.T_NORMAL_ENV_3, [0x10, 0x91, 0x11, 0x12, 0x13, 0xa0, 0xa1], [[66, 0, 0, 0]]);
    assert.equal(mats.planMaterial(odd, textures, MAPS, 6).layers.length, 1);
});

test("passTiling: the u, v of the float4 after the pass's colour in the tiled templates; 1 elsewhere or out of range", () => {
    const make = (template: number, tile: number[]): geom.GeomMaterial =>
        material(template, [0x10, 0xa0, 0xa1], [[66, 0, 0, 0], [1, 1, 1, 1], tile, [1, 1, 1, 1]]);
    assert.deepEqual(mats.passTiling(make(mats.T_NORMAL_TERRAIN_4, [0.5, 0.25, 1, 1]), 0), [0.5, 0.25]);
    assert.deepEqual(mats.passTiling(make(mats.T_NORMAL_ENV_3, [4, 4, 1, 1]), 0), [4, 4]);
    assert.deepEqual(mats.passTiling(make(mats.T_NORMAL_TERRAIN_4, [20, 1, 1, 0]), 0), [1, 1]); // (over the range)
    assert.deepEqual(mats.passTiling(make(mats.T_NORMAL_TERRAIN_4, [0, 1, 1, 1]), 0), [1, 1]);
    assert.deepEqual(mats.passTiling(make(mats.T_DIFFUSE_TERRAIN, [0.5, 1, 1, 1]), 0), [1, 1]); // (its float4s are colours)
    assert.deepEqual(mats.passTiling(make(checksum("NormalMapBlended"), [0.5, 1, 1, 1]), 0), [1, 1]);
});

test("greyStandIn: THP8's flat 129, 128, 129 only - a flat beige is a real colour", () => {
    const flat = (r: number, g: number, b: number): xenos.XenosTexture =>
        ({
            checksum: 1,
            width: 2,
            height: 2,
            format: xenos.FMT_8888,
            endian: 0,
            tiled: false,
            pitch: 2,
            data: Buffer.from(Array.from({ length: 4 }, () => [b, g, r, 255]).flat()),
            cube: false,
        }) as unknown as xenos.XenosTexture;
    assert.equal(mats.greyStandIn(flat(129, 128, 129)), true);
    assert.equal(mats.greyStandIn(flat(170, 170, 150)), false);
    assert.equal(mats.greyStandIn(flat(255, 255, 255)), false);
});
