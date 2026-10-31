// NOT ORIGINAL - Tony Hawk's Proving Ground's light maps made to read as THP8's (tools/pipeline/thp8_levels/materials.ts),
// and collision for a zone that has none - worked out from the data.
//
// THP8 lists two light maps last in a lit material (an ambient map and a shadow map, the vertex's last two uv fields);
// THPG one (its last texture, the vertex's last uv field): the light baked whole, dark - the city zones' maps average
// 0.22 (FDR 58 / 255, North Philly 67, inside the air and space museum 29). wireLightMaps gives each lit material a
// second "map" after it - the same texture under a checksum of its own - and its meshes a copy of the last uv field, so
// THP8's converter reads the pair; LIGHTING takes the light from the first map alone (no sun term).

import { checksum } from "../level_port/qb.ts";
import * as geom from "../thp8_levels/geom.ts";
import type * as havok from "../thp8_levels/havok.ts";
import * as mats from "../thp8_levels/materials.ts";
import * as thp8 from "../thp8_levels/thp8.ts";
import * as xenos from "../thp8_levels/xenos.ts";
import { repack } from "./scene.ts";

// light = map x LIGHT_SCALE / (1 + LIGHT_KNEE x map) - ours (THPG's shaders aren't read). The outdoor maps hold the
// light as it is, the sun's at 1: sampled at the lit vertices of the city's zones their brightest tenth is 1.0 - the
// sunlit ground, clipped - and the middle 0.3-0.6 (shade, walls turned from the sun). So the map is the light: 1 draws
// the texture as it is (THUG2's vertex colour 128), the curve lifting the shade a little (0.4 -> 0.44, 0.2 -> 0.23).
// The 0.22 average the first guess was set from (x 4.5 / (1 + 1.5 x)) counts the maps' black padding too; it made the
// sunlit ground x 1.8 - white.
export const LIGHT_SCALE = 1.2;
export const LIGHT_KNEE = 0.2;
export const LIGHTING: mats.Lighting = {
    sun: [0, 0, 0],
    ambientScale: LIGHT_SCALE,
    sunScale: 0,
    ambientKnee: LIGHT_KNEE,
};
// The interiors' maps are darker (inside the air and space museum: half its vertices under 0.15, the lounge's 0.2):
// THPG lights them brighter than the map - its own exposure, not read. Lit as the first guess: x 4.5 / (1 + 1.5 x)
// (0.15 -> 0.55, 0.4 -> 1.13).
export const INTERIOR_SCALE = 4.5;
export const INTERIOR_KNEE = 1.5;
export const INTERIOR_ZONES: ReadonlySet<string> = new Set(["z_museum_int", "z_crib", "z_crib_default", "z_bedroom"]);
export const INTERIOR_LIGHTING: mats.Lighting = {
    sun: [0, 0, 0],
    ambientScale: INTERIOR_SCALE,
    sunScale: 0,
    ambientKnee: INTERIOR_KNEE,
};
export function lightingOf(zone: string): mats.Lighting {
    return INTERIOR_ZONES.has(zone.toLowerCase()) ? INTERIOR_LIGHTING : LIGHTING;
}

// A texture is a zone's light map when it stands last in at least this share of the materials that list it.
export const LAST_SHARE = 0.8;

export const shadowOf = (lightMap: number): number => checksum(`thpg_shadow_${thp8.hex(lightMap)}`);

// The light maps: textures (in the zone's own .tex, real - not a stand-in - and no normal map) that stand last in
// nearly all the materials listing them.
export function lightMaps(g: geom.Geom, textures: ReadonlyMap<number, xenos.XenosTexture>): Set<number> {
    const uses = new Map<number, [number, number]>(); // [last, all]
    for (const m of g.materials) {
        m.textures.forEach((t, i) => {
            const u = uses.get(t) ?? [0, 0];
            if (i === m.textures.length - 1 && m.textures.length >= 2) u[0]++;
            u[1]++;
            uses.set(t, u);
        });
    }
    const out = new Set<number>();
    for (const [t, [last, all]] of uses) {
        const x = textures.get(t);
        if (!x || x.format === xenos.FMT_DXN || x.cube || mats.blankKind(x) !== null) continue;
        if (last >= LAST_SHARE * all) out.add(t);
    }
    return out;
}

// Every lit material's light map listed twice (the second under shadowOf's checksum, the same texture) and its meshes'
// last uv field twice. Returns the number of materials lit.
export function wireLightMaps(g: geom.Geom, textures: Map<number, xenos.XenosTexture>): number {
    const maps = lightMaps(g, textures);
    const lit = new Set<number>();
    for (const m of g.materials) {
        const t = m.textures[m.textures.length - 1];
        if (t === undefined || m.textures.length < 2 || !maps.has(t)) continue;
        const shadow = shadowOf(t);
        if (!textures.has(shadow)) textures.set(shadow, { ...textures.get(t)!, checksum: shadow });
        m.textures = [...m.textures, shadow];
        lit.add(m.checksum);
    }
    const copied = new Map<geom.GeomMesh, geom.GeomMesh>();
    for (const s of g.sectors) {
        s.meshes = s.meshes.map((mesh) => {
            if (!lit.has(mesh.material)) return mesh;
            let c = copied.get(mesh);
            if (c === undefined) {
                c = repack(mesh, true);
                copied.set(mesh, c);
            }
            return c;
        });
    }
    return lit.size;
}

// A zone without collision (THPG's bedroom: a menu scene, its .hkc holds no bodies) given its drawn triangles as
// collision: a body per sector, of its meshes whose materials neither blend nor alpha-test (glass, decals, leaves stay
// out), every face word 0 (THUG2's default terrain, no flags).
export function sceneCollision(g: geom.Geom): havok.HkBody[] {
    const solid = new Set(
        g.materials
            .filter((m) => {
                const a = mats.alphaState(m);
                return a === null || (a.blend === 0 && a.ref === 0);
            })
            .map((m) => m.checksum),
    );
    const out: havok.HkBody[] = [];
    for (const s of g.sectors) {
        const triangles: havok.HkTriangle[] = [];
        for (const mesh of s.meshes) {
            if (!solid.has(mesh.material)) continue;
            const p = (i: number): number[] => {
                const v = i * mesh.stride;
                return [0, 4, 8].map((k) => mesh.vertices.readFloatBE(v + k));
            };
            for (const t of geom.triangles(mesh))
                triangles.push({ a: p(t[0]!), b: p(t[1]!), c: p(t[2]!), material: 0, owner: 0 });
        }
        if (triangles.length) out.push({ index: out.length, triangles });
    }
    return out;
}
