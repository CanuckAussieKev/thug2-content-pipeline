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
import type * as geom from "../thp8_levels/geom.ts";
import * as mats from "../thp8_levels/materials.ts";
import * as thp8 from "../thp8_levels/thp8.ts";
import * as xenos from "../thp8_levels/xenos.ts";

export interface TemplateInfo {
    name: string;
    family: "D" | "D_S" | "D_N_S";
    passes: number[]; // the passes that are on (0 first when it is)
}

const subsets = (items: readonly number[]): number[][] =>
    items.reduce<number[][]>((all, x) => all.concat(all.map((s) => [...s, x])), [[]]);

// Every name of the three families, by checksum.
export const TEMPLATES: ReadonlyMap<number, TemplateInfo> = (() => {
    const out = new Map<number, TemplateInfo>();
    const add = (family: TemplateInfo["family"], base: string, passes: number[]): void => {
        const name =
            base +
            passes
                .filter((p) => p || family !== "D_N_S")
                .map((p) => `_Pass${p}`)
                .join("");
        out.set(checksum(name), { name, family, passes });
    };
    for (const s of subsets([0, 1, 2]).filter((x) => x.length)) {
        add("D", "D_3ChkBox", s);
        add("D_S", "D_S_3ChkBox", s);
    }
    for (const s of subsets([1, 2, 3])) add("D_N_S", "D_N_S_4ChkBox", [0, ...s]);
    return out;
})();

// D_3ChkBox's pass colours: float4 k is the k-th pass that is on.
const COLOURS = [0, 1, 2, 3];
let registered = false;
export function registerTemplates(): void {
    if (registered) return;
    registered = true;
    for (const [c, t] of TEMPLATES) {
        if (!t.passes.includes(0)) continue; // (decals: made one texture - decals())
        if (t.family === "D") mats.addLayered(c, { colourAt: COLOURS, coloursFirst: true });
        else mats.addLayered(c, { specularFirstTwo: t.family === "D_S" });
    }
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
