// NOT ORIGINAL - tests of THPS3's mip chains (moved from level_port/overlay_bias.test.ts with the converters' split).

import assert from "node:assert/strict";
import { test } from "node:test";
import { convertTextures } from "./thps3_levels.ts";

test("THPS3's textures get mip levels down to a shorter side of 4, each 2 x 2 averaged", () => {
    const texel = (v: number) => Buffer.from([v, v, v, 255]);
    const level0 = Buffer.concat(Array.from({ length: 128 * 64 }, (_, i) => texel(i % 2 ? 200 : 100)));
    const [t] = convertTextures([{ name: "grate", width: 128, height: 64, levels: [level0] }] as never).textures;
    assert.deepEqual(
        t!.levels.map((l) => l.length / 4),
        [128 * 64, 64 * 32, 32 * 16, 16 * 8, 8 * 4],
    );
    assert.deepEqual([...t!.levels[1]!.subarray(0, 4)], [150, 150, 150, 255]);
    const small = Buffer.concat(Array.from({ length: 16 * 4 }, () => texel(9)));
    assert.equal(
        convertTextures([{ name: "edge", width: 16, height: 4, levels: [small] }] as never).textures[0]!.levels.length,
        1,
    );
});
