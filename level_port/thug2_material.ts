// NOT ORIGINAL - a THUG2 material of one pass, and THUG2's terrain table (moved from thps2_levels.ts with the
// converters' split: Project 8's converter, thp8/thp8_levels.ts, makes its materials and terrains so too).

import * as thug2Scene from "./thug2_scene.ts";

// THUG2's terrain numbers: a collision face's terrain byte is an index into scripts\game\terrain.qb's Terrain_Types
// (its first entries, in its order).
export const THUG2_TERRAIN_TYPES = [
    "DEFAULT",
    "CONCSMOOTH",
    "CONCROUGH",
    "METALSMOOTH",
    "METALROUGH",
    "METALCORRUGATED",
    "METALGRATING",
    "METALTIN",
    "WOOD",
    "WOODMASONITE",
    "WOODPLYWOOD",
    "WOODFLIMSY",
    "WOODSHINGLE",
    "WOODPIER",
    "BRICK",
    "TILE",
    "ASPHALT",
    "ROCK",
    "GRAVEL",
    "SIDEWALK",
    "GRASS",
    "GRASSDRIED",
    "DIRT",
    "DIRTPACKED",
    "WATER",
    "ICE",
    "SNOW",
    "SAND",
    "PLEXIGLASS",
    "FIBERGLASS",
    "CARPET",
    "CONVEYOR",
    "CHAINLINK",
    "METALFUTURE",
    "GENERIC1",
    "GENERIC2",
] as const;

// How a face is drawn: opaque, half (blended by the vertex alpha) or add.
export type Blend = "opaque" | "half" | "add";

// `wrap`: the texture repeats (some face reaches past it); else clamped (cut-outs and signs: nothing bleeds in from
// the far side at their edges).
export function makeMaterial(
    checksum: number,
    texture: number,
    blending: Blend | boolean,
    wrap = false,
): thug2Scene.Material {
    const blend: Blend = blending === true ? "half" : blending === false ? "opaque" : blending;
    const semi = blend !== "opaque";
    let flags = thug2Scene.PASS_SMOOTH;
    if (texture) flags |= thug2Scene.PASS_TEXTURED;
    // (half: THUG2's blend by the vertex alpha - SEMI_ALPHA; add: THUG2's add, the vertex alpha full)
    flags |= semi ? thug2Scene.PASS_TRANSPARENT : thug2Scene.PASS_IGNORE_VERTEX_ALPHA;
    return {
        checksum,
        nameChecksum: checksum,
        alphaCutoff: 1,
        sorted: 0,
        drawOrder: semi ? 1500.0 : 0.0,
        singleSided: 0,
        noBackfaceCulling: 0,
        zBias: 0,
        grassify: 0,
        specularPower: 0.0,
        passes: [
            {
                texture,
                flags,
                blendMode: blend === "add" ? 1 : semi ? 5 : 0,
                fixedAlpha: 0,
                uAddress: wrap ? 0 : 1,
                vAddress: wrap ? 0 : 1,
                envmapTiling: [3.0, 3.0],
                filtering: 0x10004,
                mip: [1, 4, -8.0, -8.0],
                hasColor: 0,
                color: [0.5, 0.5, 0.5],
            },
        ],
    };
}
