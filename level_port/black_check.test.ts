// NOT ORIGINAL - tests of black_check.ts (what a converted level draws near black), on scenes built here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBlack, darkVertices, hasNormals } from "./black_check.ts";
import type * as tex from "./tex.ts";
import * as thug2Scene from "./thug2_scene.ts";

function texture(checksum: number, texel: (i: number) => number[], w = 8, h = 8): tex.Texture {
    const data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) Buffer.from(texel(i)).copy(data, 4 * i);
    return {
        checksum,
        width: w,
        height: h,
        texelDepth: 32,
        paletteDepth: 32,
        dxt: 0,
        palette: Buffer.alloc(0),
        levels: [data],
    };
}

function material(
    checksum: number,
    pass: Partial<thug2Scene.Pass> & { texture: number },
    extra: Partial<thug2Scene.Material> = {},
): thug2Scene.Material {
    return {
        checksum,
        nameChecksum: checksum,
        alphaCutoff: 1,
        sorted: 0,
        drawOrder: 0,
        singleSided: 0,
        noBackfaceCulling: 0,
        zBias: 0,
        grassify: 0,
        specularPower: 0,
        passes: [
            {
                flags: thug2Scene.PASS_TEXTURED,
                hasColor: 0,
                color: [0.5, 0.5, 0.5],
                blendMode: 0,
                fixedAlpha: 0,
                uAddress: 0,
                vAddress: 0,
                envmapTiling: [3, 3],
                filtering: 0x10004,
                mip: [1, 4, -8, -8],
                ...pass,
            },
        ],
        ...extra,
    };
}

// A quad of 4 vertices: position, (normal), colour B, G, R, A, one uv set.
function mesh(m: number, colour: number[], normals = false): thug2Scene.Mesh {
    const stride = 12 + (normals ? 12 : 0) + 4 + 8;
    const buf = Buffer.alloc(stride * 4);
    for (let i = 0; i < 4; i++) {
        const o = i * stride;
        buf.writeFloatLE(i & 1, o);
        buf.writeFloatLE(0, o + 4);
        buf.writeFloatLE(i >> 1, o + 8);
        Buffer.from(colour).copy(buf, o + 12 + (normals ? 12 : 0));
    }
    return {
        sphere: [0, 0, 0, 1],
        bbox: [0, 0, 0, 1, 0, 1],
        flags: 0,
        material: m,
        lods: [[0, 1, 2, 3]],
        strips: [[0, 1, 2, 3]],
        stride,
        vertexCount: 4,
        buffers: [[0, buf]],
        vertexShader: [2, 0],
        offsets: [0, 12, 12],
        hasWibble: 0,
        indexSets: 1,
        pixelShader: 2,
    };
}

const scene = (materials: thug2Scene.Material[], meshes: thug2Scene.Mesh[]): thug2Scene.Scene => ({
    versions: [1, 1, 1],
    materials,
    sectors: [{ checksum: 1, bone: -1, flags: 0, bbox: [0, 0, 0, 1, 0, 1], sphere: [0, 0, 0, 1], meshes }],
    hierarchyCount: 0,
    tail: Buffer.alloc(0),
});

const bright = texture(0x10, () => [200, 200, 200, 255]);
const dark = texture(0x11, () => [4, 4, 4, 255]);
const cutout = texture(0x12, (i) => [90, 120, 80, i % 4 ? 255 : 0]);

test("vertex layout: normals are told by the stride, dark vertices counted from the colour", () => {
    const plain = mesh(1, [0, 0, 0, 128]);
    const withNormals = mesh(1, [200, 200, 200, 128], true);
    assert.equal(hasNormals(plain), false);
    assert.equal(hasNormals(withNormals), true);
    assert.equal(darkVertices(plain), 4);
    assert.equal(darkVertices(withNormals), 0);
});

test("black tint: a bright texture under a (0.01, 0, 0) pass colour - not a blended shadow", () => {
    const s = scene(
        [
            material(1, { texture: 0x10, hasColor: 1, color: [0.01, 0, 0] }),
            material(2, { texture: 0x10, hasColor: 1, color: [0.3, 0.3, 0.3] }),
            material(3, {
                texture: 0x10,
                hasColor: 1,
                color: [0, 0, 0],
                flags: thug2Scene.PASS_TEXTURED | thug2Scene.PASS_TRANSPARENT,
            }),
        ],
        [mesh(1, [128, 128, 128, 128]), mesh(2, [128, 128, 128, 128]), mesh(3, [128, 128, 128, 128])],
    );
    const f = checkBlack(s, { version: 1, textures: [bright] });
    assert.deepEqual([...f.get("black tint")!.materials], [1]);
    assert.equal(f.has("dark vertex colours"), false);
});

test("dark base texture on an opaque material, dark vertex colours, env passes", () => {
    const env = {
        ...material(5, { texture: 0x10 }).passes[0]!,
        texture: 0x11,
        flags: thug2Scene.PASS_TEXTURED | thug2Scene.PASS_ENVIRONMENT,
        blendMode: 5,
    };
    const s = scene(
        [
            material(1, { texture: 0x11 }),
            material(2, { texture: 0x10 }),
            { ...material(3, { texture: 0x10 }), passes: [material(3, { texture: 0x10 }).passes[0]!, env] },
        ],
        [
            mesh(1, [128, 128, 128, 128]),
            mesh(2, [1, 1, 1, 128]),
            mesh(3, [128, 128, 128, 128], true),
            mesh(3, [128, 128, 128, 128]),
        ],
    );
    // (the quads have 4 vertices: under MIN_VERTICES for the vertex test - a 12-vertex one below)
    const f = checkBlack(s, { version: 1, textures: [bright, dark] });
    assert.deepEqual([...f.get("dark base texture")!.materials], [1]);
    assert.equal(f.get("dark env pass")!.meshes, 2);
    assert.equal(f.get("env without normals")!.meshes, 1); // (the second mesh of material 3 has none)
    assert.equal(f.has("dark vertex colours"), false);
});

test("dark vertex colours need a mesh of some size; a baked cut-out blended without an alpha test is listed", () => {
    const big = mesh(2, [1, 1, 1, 128]);
    big.vertexCount = 12;
    big.buffers = [[0, Buffer.concat([big.buffers[0]![1], big.buffers[0]![1], big.buffers[0]![1]])]];
    const s = scene(
        [
            material(2, { texture: 0x10 }),
            material(4, { texture: 0x12, flags: thug2Scene.PASS_TEXTURED | thug2Scene.PASS_TRANSPARENT, blendMode: 5 }),
            material(
                5,
                { texture: 0x12, flags: thug2Scene.PASS_TEXTURED | thug2Scene.PASS_TRANSPARENT, blendMode: 5 },
                { alphaCutoff: 128 },
            ),
        ],
        [big, mesh(4, [128, 128, 128, 128]), mesh(5, [128, 128, 128, 128])],
    );
    const f = checkBlack(s, { version: 1, textures: [bright, cutout] });
    assert.equal(f.get("dark vertex colours")!.vertices, 12);
    assert.deepEqual([...f.get("cut-out without test")!.materials], [4]);
});
