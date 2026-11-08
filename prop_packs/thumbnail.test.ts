import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Texture } from "thug2-level-converter-core/level_port/tex.ts";
import type { Material, Mesh, Pass, Sector } from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { TextureSet, thumbnail } from "./thumbnail.ts";

// A flat quad on the ground (y = 0), vertex colour 0x80 (1.0), normals up, UVs over a 4 x 4 texture whose left half
// is red and right half blue - its left half cut out (alpha 0) when `cut`.
function scene(cut: boolean): { parts: Sector[]; materials: Map<number, Material>; textures: TextureSet } {
    const corners = [
        [-10, 0, -10, 0, 0],
        [10, 0, -10, 1, 0],
        [-10, 0, 10, 0, 1],
        [10, 0, 10, 1, 1],
    ];
    const data = Buffer.alloc(36 * 4);
    corners.forEach(([x, y, z, u, v], i) => {
        const o = i * 36;
        data.writeFloatLE(x!, o);
        data.writeFloatLE(y!, o + 4);
        data.writeFloatLE(z!, o + 8);
        data.writeFloatLE(1, o + 16);
        data.writeUInt32LE(0x80808080, o + 24);
        data.writeFloatLE(u!, o + 28);
        data.writeFloatLE(v!, o + 32);
    });
    const mesh = {
        material: 7,
        lods: [[0, 1, 2, 3]],
        strips: [[0, 1, 2, 3]],
        stride: 36,
        vertexCount: 4,
        buffers: [[0, data]],
        vertexShader: [0x152, 0],
    } as unknown as Mesh;
    const pass = { texture: 0x1234, blendMode: 0, uAddress: 0, vAddress: 0, flags: 0 } as unknown as Pass;
    const material = { checksum: 7, alphaCutoff: 1, passes: [pass] } as unknown as Material;
    const texels = Buffer.alloc(4 * 4 * 4);
    for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
            const o = (y * 4 + x) * 4;
            if (x < 2) texels.set([0, 0, 255, cut ? 0 : 255], o);
            else texels.set([255, 0, 0, 255], o);
        }
    const texture: Texture = {
        checksum: 0x1234,
        width: 4,
        height: 4,
        texelDepth: 32,
        paletteDepth: 32,
        dxt: 0,
        palette: Buffer.alloc(0),
        levels: [texels],
    };
    const sector = { checksum: 1, meshes: [mesh] } as unknown as Sector;
    return {
        parts: [sector],
        materials: new Map([[7, material]]),
        textures: new TextureSet({ version: 1, textures: [texture] }),
    };
}

function counts(bgra: Buffer): { red: number; blue: number } {
    let red = 0;
    let blue = 0;
    for (let i = 0; i < bgra.length; i += 4) {
        if (bgra[i + 2]! > 150 && bgra[i]! < 80) red++;
        if (bgra[i]! > 150 && bgra[i + 2]! < 80) blue++;
    }
    return { red, blue };
}

test("thumbnail: textured, both halves seen", () => {
    const s = scene(false);
    const picture = thumbnail(s.parts, s.materials, s.textures, 32);
    assert.equal(picture.width, 32);
    assert.equal(picture.bgra.length, 32 * 32 * 4);
    const c = counts(picture.bgra);
    assert.ok(c.red > 40 && c.blue > 40, JSON.stringify(c));
});

test("thumbnail: texels under the alpha cut-off left out", () => {
    const s = scene(true);
    const c = counts(thumbnail(s.parts, s.materials, s.textures, 32).bgra);
    assert.ok(c.red === 0 && c.blue > 40, JSON.stringify(c));
});

test("thumbnail: nothing to draw is the background", () => {
    const s = scene(false);
    const picture = thumbnail([], s.materials, s.textures, 8);
    assert.ok(picture.bgra.every((v, i) => v === picture.bgra[i % 4]));
});
