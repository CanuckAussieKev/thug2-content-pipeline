// NOT ORIGINAL - Tony Hawk's Proving Ground's layered shader templates read as THP8's (thp8_levels/materials.ts
// planMaterial) - worked out from the data (the templates' texture lists and the meshes' uv fields across the zones).
//
// THPG's terrain templates are named by what they have and which of their passes are on: D_ (diffuse maps alone),
// D_S_ (diffuse + specular), D_N_S_ (diffuse, normal, specular), then <n>ChkBox (the passes: 3 or 4), then _Pass<k>
// for each pass that is on - in the 3ChkBox families pass 0 too (D_3ChkBox_Pass0_Pass2), in D_N_S_4ChkBox pass 0
// always (D_N_S_4ChkBox_Pass1_Pass3). The texture list: pass 0's maps (diffuse, then normal + specular / specular),
// then each further pass that is on its diffuse map (D_S_: + its specular map, pass 1 only) and its blend mask, then
// the light map (light.ts). The uv fields follow THP8's rule (materials.ts): one per pass, a mask one of its own while
// there are fields to spare (D_3ChkBox_Pass0_Pass1_Pass2: six fields, one per texture; D_N_S_4ChkBox_Pass1_Pass2: four,
// the masks sharing their passes'). D_3ChkBox's float4s are the passes' colours (one per pass that is on, in order).
//
// A 3ChkBox material whose pass 0 is off is a decal (blended: shadows, dirt, graffiti over the ground): its first pass
// is drawn as its diffuse map with the mask (and the pass colour) as its alpha - one texture made here; its further
// passes left out.
//
// Not read (pass 0 only, as THP8's other templates): NBlend (per-pass normal maps), Wet, Env / EnvMask, Prop, Wibble,
// water, billboards.

import { checksum } from "../level_port/qb.ts";
import * as dxt from "../thp8_levels/dxt.ts";
import * as geom from "../thp8_levels/geom.ts";
import * as mats from "../thp8_levels/materials.ts";
import * as thp8 from "../thp8_levels/thp8.ts";
import * as xenos from "../thp8_levels/xenos.ts";
import { keepFields, setParams } from "./scene.ts";

export interface TemplateInfo {
    name: string;
    family: "D" | "D_S" | "D_N_S";
    passes: number[]; // the passes that are on (0 first when it is)
    wet?: boolean; // D_N_S_Wet_4ChkBox...: D_N_S_4ChkBox's with a wet mask and its cube map (dropWet)
}

const subsets = (items: readonly number[]): number[][] =>
    items.reduce<number[][]>((all, x) => all.concat(all.map((s) => [...s, x])), [[]]);

// Every name of the three families, by checksum.
export const TEMPLATES: ReadonlyMap<number, TemplateInfo> = (() => {
    const out = new Map<number, TemplateInfo>();
    const add = (family: TemplateInfo["family"], base: string, passes: number[], wet = false): void => {
        const name =
            base +
            passes
                .filter((p) => p || family !== "D_N_S")
                .map((p) => `_Pass${p}`)
                .join("");
        out.set(checksum(name), { name, family, passes, ...(wet ? { wet } : {}) });
    };
    for (const s of subsets([0, 1, 2]).filter((x) => x.length)) {
        add("D", "D_3ChkBox", s);
        add("D_S", "D_S_3ChkBox", s);
    }
    for (const s of subsets([1, 2, 3])) {
        add("D_N_S", "D_N_S_4ChkBox", [0, ...s]);
        add("D_N_S", "D_N_S_Wet_4ChkBox", [0, ...s], true);
    }
    return out;
})();

// D_3ChkBox's pass colours: float4 k is the k-th pass that is on.
const COLOURS = [0, 1, 2, 3];
// D_N_S_4ChkBox's (and its Wet twin's) float4s: the specular power, then pass 0's colour, its tiling and its specular
// colour, then each further pass that is on its colour (A its opacity) and its tiling. The tiling float4 is per
// sampler: x the diffuse map's, y the mask's (pass 0: the normal map's), z the specular map's (the library names them
// m_psPass<k>MaterialColor / m_psPass<k>Tiling; the order read from the values over the zones' materials: colours vary
// in R, G, B with an opacity in A, tilings are (1, 1, 1, 1), (16, 16, 16, 1), (2, 1, 1, 1)...).
const D_N_S_COLOURS = [1, 4, 6, 8];
let registered = false;
export function registerTemplates(): void {
    if (registered) return;
    registered = true;
    for (const [c, t] of TEMPLATES) {
        if (!t.passes.includes(0)) continue; // (decals: made one texture - decals())
        if (t.family === "D") mats.addLayered(c, { colourAt: COLOURS, coloursFirst: true });
        else if (t.family === "D_N_S") mats.addLayered(c, { colourAt: D_N_S_COLOURS, samplerTiling: true });
        else mats.addLayered(c, { specularFirstTwo: true });
    }
}

// The Wet terrains (D_N_S_Wet_4ChkBox...: roads, pavements, plazas) are D_N_S_4ChkBox's with a wet layer: two more
// textures before the light map - a cube map and a big wet mask, in either order - and the mask's uv field before the
// light map's. THUG2 draws no wet sheen: both left out (and the field), so the material reads as D_N_S_4ChkBox's
// layers. Returns how many.
export function dropWet(g: geom.Geom, textures: ReadonlyMap<number, xenos.XenosTexture>): number {
    const wet = new Set<number>();
    for (const m of g.materials) {
        const n = m.textures.length;
        if (!TEMPLATES.get(m.template)?.wet || n < 4) continue;
        const pair = m.textures.slice(n - 3, n - 1);
        if (!pair.some((t) => textures.get(t)?.cube)) continue;
        m.textures = [...m.textures.slice(0, n - 3), m.textures[n - 1]!];
        wet.add(m.checksum);
    }
    for (const s of g.sectors) {
        s.meshes = s.meshes.map((mesh) => {
            const fields = geom.uvFields(mesh.layout).length;
            if (!wet.has(mesh.material) || fields < 3) return mesh;
            return keepFields(
                mesh,
                [...Array(fields).keys()].filter((k) => k !== fields - 2),
            );
        });
    }
    return wet.size;
}

// The glass towers (EnvMask_D_N_S_2ChkBox_Pass1...): pass 0 the glass - a black map (E7247FD8: mean 0, alpha 242)
// with its cube map's reflection by the mask after it -, pass 1 the facade over it - brick with windows, panels - by
// its own mask, black where the panes are. THUG2 draws neither the reflection nor the dark glass under a blend: drawn
// as pass 1's facade, solid and lit, with the glass over it where its mask is black - a layer of the glass's colour
// (the cube map's mean x GLASS_REFLECTION, as the dark glass reflects it) whose alpha is the mask's inverse, on the
// mask's own uv field. The material is made a D_N_S_4ChkBox_Pass1 (layers.ts's layout: facade, glass layer, a white
// mask, the light map) and its meshes keep pass 1's field, the mask's and the light map's. Only where pass 0's map is
// dark (materials.darkTexture): the other EnvMask materials (metal, awnings, sign frames) draw their pass 0 as before.
// Returns how many.
export const ENV_MASK_PASS1: ReadonlySet<number> = new Set(
    ["EnvMask_D_N_S_2ChkBox_Pass1", "EnvMask_D_N_S_2ChkBox_Pass1_Normal"].map(checksum),
);
export const GLASS_REFLECTION = 0.6;
// The texture lists: D0 N0 S0, the cube map, mask 0, then D1 (N1 S1), mask 1, then the light map. Float4s: the
// specular power, pass 0's colour, tiling, specular colour, the reflection (Remap), pass 1's colour, tiling, specular.
const FACADE_LAYOUTS: ReadonlyMap<number, { textures: number; mask: number }> = new Map([
    [checksum("EnvMask_D_N_S_2ChkBox_Pass1"), { textures: 8, mask: 6 }],
    [checksum("EnvMask_D_N_S_2ChkBox_Pass1_Normal"), { textures: 10, mask: 8 }],
]);
const FACADE_CUBE = 3;
const FACADE_DIFFUSE = 5;
export const FACADE_TEMPLATE = checksum("D_N_S_4ChkBox_Pass1");
export const WHITE = 0xd729d3b1; // (PAK\global_env_tex's white stand-in)

export function glassColour(cube: xenos.XenosTexture | undefined): number[] {
    const faces = cube?.cube ? mats.decodeCube(cube) : null;
    return [0, 1, 2].map((ch) => {
        if (!faces) return 0;
        let sum = 0;
        let n = 0;
        for (const f of faces) {
            for (let i = 0; i < f.width * f.height; i++) sum += f.bgra[4 * i + ch]!;
            n += f.width * f.height;
        }
        return Math.round((sum / Math.max(1, n)) * GLASS_REFLECTION);
    });
}

// The glass layer: the glass's colour (B, G, R), alpha the mask's inverse brightness (the panes).
export function glassTexels(mask: mats.Decoded, glass: readonly number[]): mats.Decoded {
    const bgra = Buffer.alloc(mask.width * mask.height * 4);
    for (let i = 0; i < mask.width * mask.height; i++) {
        const lum = (mask.bgra[4 * i]! + mask.bgra[4 * i + 1]! + mask.bgra[4 * i + 2]!) / 3;
        bgra.set([glass[0]!, glass[1]!, glass[2]!, Math.round(255 - lum)], 4 * i);
    }
    return { width: mask.width, height: mask.height, bgra };
}

export function facades(g: geom.Geom, textures: Map<number, xenos.XenosTexture>): number {
    // (materials some mesh of which hasn't the five uv fields: left as they are)
    const short = new Set<number>();
    for (const s of g.sectors)
        for (const mesh of s.meshes) if (geom.uvFields(mesh.layout).length !== 5) short.add(mesh.material);
    const made = new Set<number>();
    for (const m of g.materials) {
        const layout = FACADE_LAYOUTS.get(m.template);
        if (!layout || m.textures.length !== layout.textures || short.has(m.checksum)) continue;
        const glassMap = textures.get(m.textures[0]!);
        if (!glassMap || !mats.darkTexture(glassMap)) continue;
        const cube = m.textures[FACADE_CUBE]!;
        const facade = m.textures[FACADE_DIFFUSE]!;
        const mask = m.textures[layout.mask]!;
        const light = m.textures[layout.textures - 1]!;
        const k = textures.get(mask);
        const kk = k ? mats.decode(k) : null;
        if (!textures.has(facade) || !kk || !textures.has(WHITE)) continue;
        const glass = glassColour(textures.get(cube));
        const id = checksum(`thpg_glass_${thp8.hex(mask)}_${glass.join("_")}`);
        if (!textures.has(id)) {
            const out = glassTexels(kk, glass);
            textures.set(id, madeTexture(id, out.width, out.height, out.bgra));
        }
        const f = mats.float4s(m);
        const one = [1, 1, 1, 1];
        m.template = FACADE_TEMPLATE;
        m.textures = [facade, id, WHITE, light];
        // (D_N_S_4ChkBox_Pass1's float4s: the specular power, pass 0 = the facade's colour and tiling, its specular
        // colour, then the glass layer's colour (opaque) and tiling)
        setParams(m, [f[0] ?? [15, 0, 0, 0], f[5] ?? one, f[6] ?? one, f[7] ?? one, one, one]);
        m.params.writeUInt32BE(0, mats.PARAM_BLEND);
        m.params.writeUInt32BE(0, mats.PARAM_ALPHA_REF);
        made.add(m.checksum);
    }
    // (the uv fields: pass 1's (2), its mask's (3), the light map's)
    for (const s of g.sectors)
        s.meshes = s.meshes.map((mesh) => {
            return made.has(mesh.material) ? keepFields(mesh, [2, 3, 4]) : mesh;
        });
    return made.size;
}

// A texture we make as a THP8 texture would read: DXT5 (THUG2's block layout, no swap, untiled).
export function madeTexture(c: number, width: number, height: number, bgra: Buffer): xenos.XenosTexture {
    return {
        checksum: c,
        width,
        height,
        format: xenos.FMT_DXT5,
        endian: 0,
        tiled: false,
        pitch: width,
        data: dxt.encode(bgra, width, height, 5),
        cube: false,
    };
}

// The decal's texture: the diffuse map with alpha = the mask's brightness x the pass colour's opacity, its colour x
// the pass colour's (both at the larger one's size, nearest texel).
export function decalTexels(d: mats.Decoded, mask: mats.Decoded, colour: readonly number[]): mats.Decoded {
    const width = Math.max(d.width, mask.width);
    const height = Math.max(d.height, mask.height);
    const bgra = Buffer.alloc(width * height * 4);
    const at = (t: mats.Decoded, x: number, y: number): number =>
        4 *
        (Math.min(t.height - 1, Math.floor(((y + 0.5) * t.height) / height)) * t.width +
            Math.min(t.width - 1, Math.floor(((x + 0.5) * t.width) / width)));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = at(d, x, y);
            const q = at(mask, x, y);
            const o = 4 * (y * width + x);
            for (let c = 0; c < 3; c++) bgra[o + c] = Math.min(255, Math.round(d.bgra[p + c]! * (colour[2 - c] ?? 1)));
            const lum = (mask.bgra[q]! + mask.bgra[q + 1]! + mask.bgra[q + 2]!) / 3;
            bgra[o + 3] = Math.round((d.bgra[p + 3]! * lum * Math.min(1, Math.max(0, colour[3] ?? 1))) / 255);
        }
    }
    return { width, height, bgra };
}

// The zone's decal materials (a 3ChkBox template with pass 0 off) given their first pass as one texture, first in their
// list (their further passes' textures left out; the light map stays last). Returns how many.
export function decals(g: geom.Geom, textures: Map<number, xenos.XenosTexture>): number {
    let n = 0;
    for (const m of g.materials) {
        const t = TEMPLATES.get(m.template);
        if (!t || t.passes.includes(0) || m.textures.length < 3) continue;
        const d = textures.get(m.textures[0]!);
        const maskAt = t.family === "D_S" && t.passes[0] === 1 ? 2 : 1;
        const k = textures.get(m.textures[maskAt]!);
        const dd = d ? mats.decode(d) : null;
        const kk = k ? mats.decode(k) : null;
        if (!dd || !kk) continue;
        const colour = t.family === "D" ? (mats.float4s(m)[0] ?? [1, 1, 1, 1]) : [1, 1, 1, 1];
        const id = checksum(
            `thpg_decal_${thp8.hex(d!.checksum)}_${thp8.hex(k!.checksum)}_${colour.map((x) => Math.round(x * 100)).join("_")}`,
        );
        if (!textures.has(id)) {
            const made = decalTexels(dd, kk, colour);
            textures.set(id, madeTexture(id, made.width, made.height, made.bgra));
        }
        m.textures = [id, ...m.textures.slice(-1)];
        // (blended by that alpha, whatever its blend word says: a decal is a layer over the ground)
        const state = mats.alphaState(m);
        if (state && state.blend === 0 && state.ref === 0) m.params.writeUInt32BE(mats.BLEND_ALPHA, mats.PARAM_BLEND);
        n++;
    }
    return n;
}
