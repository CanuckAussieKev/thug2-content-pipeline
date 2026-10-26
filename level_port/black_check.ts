// NOT ORIGINAL - what a converted level draws black or much darker than intended, found from its .scn.xbx and .tex.xbx
// alone (any port): per material, why a surface comes out near black.
//
//   "black tint"        pass 0's colour multiplier (THUG2's pass colour, 0.5 = as the texture) is under TINT_BLACK
//                       while its texture is bright - a wrong float4 read as a colour (the school's walls)
//   "dark base texture" pass 0 is a near-black texture (mean under DARK_MEAN) on an opaque material - a mask or
//                       occlusion map picked as the diffuse map
//   "dark vertex colours" an opaque or blended mesh with at least half its vertices under DARK_VERTEX (a lit mesh
//                       multiplied by black own colours, a light map sampled from a dither placeholder)
//   "dark env pass"     an environment pass (flag 0x08) over a texture whose mean is under DARK_MEAN
//   "env without normals" a mesh with an environment pass and no vertex normals (the reflection vector is undefined)
//   "cut-out without test" a blended pass whose texture alpha is binary (a baked alpha test, a fence, leaves) on a
//                       material with no alpha cutoff above 1: drawn by blending only - informational, not black
//
// A material is counted once per cause; meshes and triangles are what draws it.

import type * as tex from "./tex.ts";
import { lookOf, texels } from "./texture_check.ts";
import * as thug2Scene from "./thug2_scene.ts";

export const TINT_BLACK = 0.1; // pass colour factor (colour x 2) under which a bright texture is drawn black
export const BRIGHT_MEAN = 60; // a texture this bright (mean of R, G, B) under such a tint is a wrong tint
export const DARK_MEAN = 40;
export const DARK_VERTEX = 6; // a vertex colour's mean (B, G, R) under this is black
export const DARK_SHARE = 0.5;
export const EXAMPLES = 3; // shown per cause in the report
export const MIN_VERTICES = 8; // smaller meshes (a bolt, a knob) aren't counted for their vertex colours

export const CAUSES = [
    "black tint",
    "dark base texture",
    "dark vertex colours",
    "dark env pass",
    "env without normals",
    "cut-out without test",
] as const;
export type BlackCause = (typeof CAUSES)[number];

export interface BlackFinding {
    cause: BlackCause;
    materials: Set<number>;
    meshes: number;
    triangles: number;
    vertices: number;
    examples: { sector: number; material: number; texture: number }[]; // the first few
}

export interface TextureFacts {
    mean: number; // mean of B, G, R
    binaryAlpha: boolean; // more than 2% clear texels and under 25% partial
}

export function textureFacts(t: tex.Texture): TextureFacts | null {
    const d = texels(t);
    if (!d) return null;
    const look = lookOf(d, t.width, t.height);
    let clear = 0;
    let partial = 0;
    const n = t.width * t.height;
    for (let i = 0; i < n; i++) {
        const a = d[4 * i + 3]!;
        if (a < 8) clear++;
        else if (a < 247) partial++;
    }
    return {
        mean: (look.mean[0]! + look.mean[1]! + look.mean[2]!) / 3,
        binaryAlpha: clear / n > 0.02 && partial / n < 0.25,
    };
}

// A mesh's vertex colour layout: position, normal (when the stride says so), colour (B, G, R, A), uv sets.
export function hasNormals(mesh: thug2Scene.Mesh): boolean {
    return mesh.stride >= 28 && (mesh.stride - 16) % 8 === 4;
}

export function darkVertices(mesh: thug2Scene.Mesh): number {
    const buf = mesh.buffers[0]?.[1];
    if (!buf || mesh.stride < 16) return 0;
    const off = 12 + (hasNormals(mesh) ? 12 : 0);
    let dark = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
        const o = i * mesh.stride + off;
        if (o + 3 > buf.length) break;
        if ((buf[o]! + buf[o + 1]! + buf[o + 2]!) / 3 < DARK_VERTEX) dark++;
    }
    return dark;
}

function triangleCount(mesh: thug2Scene.Mesh): number {
    let n = 0;
    for (const strip of mesh.strips) n += Math.max(0, strip.length - 2);
    return n;
}

export function checkBlack(scene: thug2Scene.Scene, textures: tex.TexFile): Map<BlackCause, BlackFinding> {
    const byChecksum = new Map(textures.textures.map((t) => [t.checksum, t]));
    const facts = new Map<number, TextureFacts | null>();
    const factsOf = (c: number): TextureFacts | null => {
        if (!facts.has(c)) {
            const t = byChecksum.get(c);
            facts.set(c, t ? textureFacts(t) : null);
        }
        return facts.get(c)!;
    };
    const materials = new Map(scene.materials.map((m) => [m.checksum, m]));
    const out = new Map<BlackCause, BlackFinding>();
    const add = (cause: BlackCause, sector: number, mesh: thug2Scene.Mesh, texture: number): void => {
        let f = out.get(cause);
        if (!f) {
            f = { cause, materials: new Set(), meshes: 0, triangles: 0, vertices: 0, examples: [] };
            out.set(cause, f);
        }
        f.materials.add(mesh.material);
        f.meshes++;
        f.triangles += triangleCount(mesh);
        f.vertices += mesh.vertexCount;
        if (f.examples.length < 6 && !f.examples.some((e) => e.material === mesh.material))
            f.examples.push({ sector, material: mesh.material, texture });
    };
    for (const s of scene.sectors) {
        for (const mesh of s.meshes) {
            const m = materials.get(mesh.material);
            const p0 = m?.passes[0];
            if (!m || !p0) continue;
            const blended = (p0.flags & thug2Scene.PASS_TRANSPARENT) !== 0;
            const f0 = p0.texture && p0.flags & thug2Scene.PASS_TEXTURED ? factsOf(p0.texture) : null;
            // (a blended pass of a black tint is a shadow: THP8's dark overlays)
            if (p0.hasColor && f0 && f0.mean >= BRIGHT_MEAN && !blended) {
                const factor = 2 * Math.max(p0.color[0]!, p0.color[1]!, p0.color[2]!);
                if (factor < TINT_BLACK) add("black tint", s.checksum, mesh, p0.texture);
            }
            if (f0 && !blended && f0.mean < DARK_MEAN && (!p0.hasColor || 2 * Math.max(...p0.color) > 0.3))
                add("dark base texture", s.checksum, mesh, p0.texture);
            if (mesh.vertexCount >= MIN_VERTICES && darkVertices(mesh) >= DARK_SHARE * mesh.vertexCount)
                add("dark vertex colours", s.checksum, mesh, p0.texture);
            for (const p of m.passes) {
                if (!(p.flags & thug2Scene.PASS_ENVIRONMENT)) continue;
                const fe = factsOf(p.texture);
                if (fe && fe.mean < DARK_MEAN) add("dark env pass", s.checksum, mesh, p.texture);
                if (!hasNormals(mesh)) add("env without normals", s.checksum, mesh, p.texture);
            }
            if (blended && f0?.binaryAlpha && m.alphaCutoff <= 1)
                add("cut-out without test", s.checksum, mesh, p0.texture);
        }
    }
    return out;
}

export function blackReport(
    level: string,
    findings: ReadonlyMap<BlackCause, BlackFinding>,
    nameOf: (c: number) => string = (c) => c.toString(16).toUpperCase(),
): string[] {
    const lines = [`${level} - near-black surfaces (tools/pipeline/level_port/black_check.ts)`];
    for (const cause of CAUSES) {
        const f = findings.get(cause);
        if (!f) {
            lines.push(`  ${cause}: 0 materials`);
            continue;
        }
        lines.push(
            `  ${cause}: ${f.materials.size} materials, ${f.meshes} meshes, ${f.triangles} triangles` +
                (f.examples.length
                    ? ` (e.g. ${f.examples
                          .slice(0, EXAMPLES)
                          .map(
                              (e) =>
                                  `${nameOf(e.sector)} ${e.material.toString(16).toUpperCase()}/${e.texture.toString(16).toUpperCase()}`,
                          )
                          .join("; ")})`
                    : ""),
        );
    }
    return lines;
}
