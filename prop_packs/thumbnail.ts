// NOT ORIGINAL - the level editor Content Browser's piece pictures (prop_packs.ts thumbs / prefab-thumb): a small
// software renderer of THUG2 scene sectors, our own.
//
// What it draws, `size` pixels square (rendered at twice that and averaged down 2 x 2 for smooth edges):
//   - a three-quarter view from above (pitch 30 degrees, yaw 35 degrees plus the quarter turn that shows most of the
//     piece's front faces - a facade from its front, not its back), orthographic, fitted to the piece's bounds;
//   - each mesh's first material pass: its texture (the level's .tex, DXT decoded - the mip level that matches the
//     triangle's size on screen) sampled with the mesh's first UV set, bilinear, wrapped or clamped as the pass says,
//     times the vertex colours (THUG2's 0x80 = 1.0, so x 2);
//   - lit: an ambient term plus a key light from the upper left, from the vertex normals (the face's when the mesh
//     has none) turned towards the camera (both sides drawn: the editor's pieces are often open shells);
//   - the material's alpha: texels under its cut-off (at least 1) left out (fences, foliage); the alpha-blended
//     passes (blend 5 / 6) drawn after the solid ones, far triangles first, over them; the additive ones (1 / 2)
//     added last; the subtractive and modulating passes (lightmaps, shadows) not drawn.
//   - the editor's panel grey behind (THUG2's picture files have no alpha - nativeImg makes it opaque).

import * as dxt from "thug2-level-converter-core/level_port/dxt.ts";
import type { TexFile, Texture } from "thug2-level-converter-core/level_port/tex.ts";
import type { Material, Sector } from "thug2-level-converter-core/level_port/thug2_scene.ts";
import type { Picture } from "../menu_level/loading_art.ts";

// Pictures drawn by another version of this renderer are drawn again (prop_packs.ts thumbs' stamp): raise it when
// the pictures change.
export const THUMB_VERSION = 3; // (3: the files swizzled, as the game stores power-of-two pictures)

const BACKGROUND = [0x26, 0x28, 0x2c]; // (r, g, b: the editor's panel grey)

const FVF_XYZ = 0x002;
const FVF_POSITION_MASK = 0x400e;
const FVF_NORMAL = 0x010;
const FVF_DIFFUSE = 0x040;
const FVF_SPECULAR = 0x080;

interface Mip {
    w: number;
    h: number;
    rgba: Float32Array; // 0..1, the colour times the alpha (no colour of see-through texels bleeding into their edges)
}

// A level's (or several packs') textures, decoded on first use, one mip level at a time.
export class TextureSet {
    private readonly sources = new Map<number, Texture>();
    private readonly mips = new Map<number, (Mip | null)[]>();

    constructor(...files: (TexFile | null | undefined)[]) {
        for (const f of files) if (f) this.add(f);
    }

    // (the first texture of a checksum kept)
    add(file: TexFile): void {
        for (const t of file.textures) if (!this.sources.has(t.checksum)) this.sources.set(t.checksum, t);
    }

    size(checksum: number): [number, number] | null {
        const t = this.sources.get(checksum);
        return t ? [t.width, t.height] : null;
    }

    // Mip `level` (or the smallest one of at least 4 x 4 texels below it) of the texture; null when it has none
    // or it can't be read.
    mip(checksum: number, level: number): Mip | null {
        const t = this.sources.get(checksum);
        if (!t?.levels.length) return null;
        let n = Math.max(0, Math.min(level, t.levels.length - 1));
        while (n > 0 && (t.width >> n < 4 || t.height >> n < 4)) n--;
        let list = this.mips.get(checksum);
        if (!list) {
            list = [];
            this.mips.set(checksum, list);
        }
        if (list[n] === undefined) list[n] = decodeLevel(t, n);
        return list[n]!;
    }
}

function decodeLevel(t: Texture, n: number): Mip | null {
    const w = Math.max(1, t.width >> n);
    const h = Math.max(1, t.height >> n);
    const data = t.levels[n]!;
    let bgra: Uint8Array;
    try {
        if (t.dxt) bgra = dxt.decode(data, w, h, t.dxt);
        else if (t.texelDepth === 8 && t.palette.length >= 4) {
            bgra = new Uint8Array(w * h * 4);
            for (let i = 0; i < w * h && i < data.length; i++)
                bgra.set(t.palette.subarray(data[i]! * 4, data[i]! * 4 + 4), i * 4);
        } else if (t.texelDepth === 32 && data.length >= w * h * 4) bgra = data;
        else return null;
    } catch {
        return null;
    }
    const rgba = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const a = bgra[i * 4 + 3]! / 255;
        rgba[i * 4] = (bgra[i * 4 + 2]! / 255) * a;
        rgba[i * 4 + 1] = (bgra[i * 4 + 1]! / 255) * a;
        rgba[i * 4 + 2] = (bgra[i * 4]! / 255) * a;
        rgba[i * 4 + 3] = a;
    }
    return { w, h, rgba };
}

// Bilinear, into out[0..3] (rgba, the colour not multiplied by the alpha).
function sample(m: Mip, u: number, v: number, wrapU: boolean, wrapV: boolean, out: Float32Array): void {
    const x = u * m.w - 0.5;
    const y = v * m.h - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const ix = (i: number): number => (wrapU ? ((i % m.w) + m.w) % m.w : Math.max(0, Math.min(m.w - 1, i)));
    const iy = (i: number): number => (wrapV ? ((i % m.h) + m.h) % m.h : Math.max(0, Math.min(m.h - 1, i)));
    const a = ix(x0);
    const b = ix(x0 + 1);
    const r0 = iy(y0) * m.w;
    const r1 = iy(y0 + 1) * m.w;
    const p = m.rgba;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    for (let c = 0; c < 4; c++) {
        out[c] =
            p[(r0 + a) * 4 + c]! * w00 +
            p[(r0 + b) * 4 + c]! * w10 +
            p[(r1 + a) * 4 + c]! * w01 +
            p[(r1 + b) * 4 + c]! * w11;
    }
    const alpha = out[3]!;
    if (alpha > 1e-6) for (let c = 0; c < 3; c++) out[c] = out[c]! / alpha;
}

// (how a pass is drawn)
const Kind = { Solid: 0, Blend: 1, Add: 2 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

interface Tri {
    kind: Kind;
    // view space: x right, y up, z away from the camera; per corner
    p: Float64Array; // 9
    uv: Float64Array; // 6
    colour: Float64Array; // 12 (rgba, with the light in rgb)
    texture: number;
    wrapU: boolean;
    wrapV: boolean;
    cutoff: number; // 0..1
    depth: number; // the middle's z (the blended ones' order)
}

interface Raw {
    kind: Kind;
    pos: number[]; // world, 9
    normal: number[] | null; // world, 9
    uv: number[];
    colour: number[]; // 12, rgba 0..1 (vertex colour x 2)
    texture: number;
    wrapU: boolean;
    wrapV: boolean;
    cutoff: number;
}

function kindOf(material: Material | undefined): Kind | null {
    const pass = material?.passes[0];
    if (!pass) return Kind.Solid;
    const mode = pass.blendMode & 0xffffff;
    if (mode === 0) return Kind.Solid;
    if (mode === 5 || mode === 6) return Kind.Blend;
    if (mode === 1 || mode === 2) return Kind.Add;
    return null;
}

function rawTriangles(parts: readonly Sector[], materials: ReadonlyMap<number, Material>): Raw[] {
    const out: Raw[] = [];
    for (const mesh of parts.flatMap((s) => s.meshes)) {
        const data = mesh.buffers[0]?.[1];
        const fvf = mesh.vertexShader[0] ?? 0;
        const stride = mesh.stride;
        if (!data || stride < 12 || data.length < stride * mesh.vertexCount) continue;
        const plain = fvf < 0x10000 && (fvf & FVF_POSITION_MASK) === FVF_XYZ;
        const normalAt = plain && fvf & FVF_NORMAL ? 12 : -1;
        const colourAt = plain && fvf & FVF_DIFFUSE ? (normalAt >= 0 ? 24 : 12) : -1;
        const uvAt = plain
            ? 12 + (normalAt >= 0 ? 12 : 0) + (colourAt >= 0 ? 4 : 0) + (fvf & FVF_SPECULAR ? 4 : 0)
            : -1;
        const hasUv = plain && ((fvf >> 8) & 0xf) >= 1 && uvAt + 8 <= stride;
        const material = materials.get(mesh.material);
        const kind = kindOf(material);
        if (kind === null) continue;
        const pass = material?.passes[0];
        const cutoff = Math.max(1, material?.alphaCutoff ?? 1) / 255;
        // (the mesh's own strip, numbered from its vertex 0; else its first LOD's list - in the shipped levels
        // numbered in the sector's vertex range, not always from the mesh's first vertex: its lowest index taken as
        // vertex 0)
        const own = mesh.strips[0] ?? [];
        const ownFits = own.length >= 3 && own.every((v) => v < mesh.vertexCount);
        const strip = ownFits ? own : (mesh.lods[0] ?? []);
        const first = ownFits ? 0 : strip.reduce((m, v) => Math.min(m, v), Infinity);
        const corner = (i: number, r: Raw, k: number): void => {
            const o = i * stride;
            r.pos[k * 3] = data.readFloatLE(o);
            r.pos[k * 3 + 1] = data.readFloatLE(o + 4);
            r.pos[k * 3 + 2] = data.readFloatLE(o + 8);
            if (r.normal) {
                r.normal[k * 3] = data.readFloatLE(o + 12);
                r.normal[k * 3 + 1] = data.readFloatLE(o + 16);
                r.normal[k * 3 + 2] = data.readFloatLE(o + 20);
            }
            if (colourAt >= 0) {
                const c = o + colourAt;
                r.colour[k * 4] = Math.min(1, (data[c + 2]! * 2) / 255);
                r.colour[k * 4 + 1] = Math.min(1, (data[c + 1]! * 2) / 255);
                r.colour[k * 4 + 2] = Math.min(1, (data[c]! * 2) / 255);
                r.colour[k * 4 + 3] = Math.min(1, (data[c + 3]! * 2) / 255);
            } else r.colour.fill(1, k * 4, k * 4 + 4);
            if (hasUv) {
                r.uv[k * 2] = data.readFloatLE(o + uvAt);
                r.uv[k * 2 + 1] = data.readFloatLE(o + uvAt + 4);
            }
        };
        for (let i = 2; i < strip.length; i++) {
            const [ia, ib, ic] = [strip[i - 2]! - first, strip[i - 1]! - first, strip[i]! - first];
            if (ia === ib || ib === ic || ia === ic || Math.max(ia, ib, ic) >= mesh.vertexCount) continue;
            const r: Raw = {
                kind,
                pos: new Array<number>(9),
                normal: normalAt >= 0 ? new Array<number>(9) : null,
                uv: [0, 0, 0, 0, 0, 0],
                colour: new Array<number>(12),
                texture: hasUv && pass ? pass.texture : 0,
                wrapU: pass?.uAddress !== 1,
                wrapV: pass?.vAddress !== 1,
                cutoff,
            };
            corner(ia, r, 0);
            corner(ib, r, 1);
            corner(ic, r, 2);
            out.push(r);
        }
    }
    return out;
}

// The face normal (not unit length: its length is twice the area), turned to agree with the vertex normals.
function faceNormal(r: Raw): [number, number, number] {
    const p = r.pos;
    const ux = p[3]! - p[0]!;
    const uy = p[4]! - p[1]!;
    const uz = p[5]! - p[2]!;
    const vx = p[6]! - p[0]!;
    const vy = p[7]! - p[1]!;
    const vz = p[8]! - p[2]!;
    let n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    if (r.normal) {
        const q = r.normal;
        const s = n[0] * (q[0]! + q[3]! + q[6]!) + n[1] * (q[1]! + q[4]! + q[7]!) + n[2] * (q[2]! + q[5]! + q[8]!);
        if (s < 0) n = [-n[0], -n[1], -n[2]];
    }
    return n;
}

const PITCH = (30 * Math.PI) / 180;
const YAW = (35 * Math.PI) / 180;

function viewOf(yaw: number): (x: number, y: number, z: number, out: Float64Array, at: number) => void {
    const [sy, cy, sp, cp] = [Math.sin(yaw), Math.cos(yaw), Math.sin(PITCH), Math.cos(PITCH)];
    return (x, y, z, out, at) => {
        const vx = x * cy - z * sy;
        const z1 = x * sy + z * cy;
        out[at] = vx;
        // (pitched down: up is (0, cos, sin), the view direction (0, -sin, cos) - higher points nearer)
        out[at + 1] = y * cp + z1 * sp;
        out[at + 2] = -y * sp + z1 * cp;
    };
}

// The quarter turn whose view shows most front-facing area (only meshes with normals know their front).
function bestYaw(raws: readonly Raw[]): number {
    let best = YAW;
    let bestScore = -Infinity;
    const v = new Float64Array(3);
    for (let q = 0; q < 4; q++) {
        const yaw = YAW + (q * Math.PI) / 2;
        const view = viewOf(yaw);
        let score = 0;
        for (const r of raws) {
            if (!r.normal) continue;
            const n = faceNormal(r);
            view(n[0], n[1], n[2], v, 0);
            // (towards the camera is -z)
            if (v[2]! < 0) score -= v[2]!;
        }
        // (a small preference for the usual view when they're alike)
        if (score > bestScore * 1.02 || bestScore === -Infinity) {
            bestScore = score;
            best = yaw;
        }
    }
    return best;
}

const LIGHT = (() => {
    // (towards the light, in view space: from the upper left, in front)
    const l = [-0.45, 0.75, -0.5];
    const n = Math.hypot(l[0]!, l[1]!, l[2]!);
    return [l[0]! / n, l[1]! / n, l[2]! / n] as const;
})();
const AMBIENT = 0.5;
const EXPOSURE = 0.48; // (the drawn pixels' mean brightness aimed at)
const EXPOSURE_MAX = 3;
const DIFFUSE = 0.62;

function viewTriangles(raws: readonly Raw[], yaw: number): Tri[] {
    const view = viewOf(yaw);
    const tris: Tri[] = [];
    const n3 = new Float64Array(3);
    const fv = new Float64Array(3);
    for (const r of raws) {
        const p = new Float64Array(9);
        for (let k = 0; k < 3; k++) view(r.pos[k * 3]!, r.pos[k * 3 + 1]!, r.pos[k * 3 + 2]!, p, k * 3);
        const f = faceNormal(r);
        view(f[0], f[1], f[2], fv, 0);
        const fl = Math.hypot(fv[0]!, fv[1]!, fv[2]!) || 1;
        // (seen from behind: the light falls on the side we see)
        const flip = fv[2]! > 0 ? -1 : 1;
        const back = fv[2]! > 0 && r.normal !== null;
        const colour = new Float64Array(12);
        for (let k = 0; k < 3; k++) {
            if (r.normal) {
                view(r.normal[k * 3]!, r.normal[k * 3 + 1]!, r.normal[k * 3 + 2]!, n3, 0);
                const l = Math.hypot(n3[0]!, n3[1]!, n3[2]!);
                if (l > 1e-6) for (let c = 0; c < 3; c++) n3[c] = (n3[c]! / l) * flip;
                else for (let c = 0; c < 3; c++) n3[c] = (fv[c]! / fl) * flip;
            } else for (let c = 0; c < 3; c++) n3[c] = (fv[c]! / fl) * flip;
            const lit = n3[0]! * LIGHT[0] + n3[1]! * LIGHT[1] + n3[2]! * LIGHT[2];
            const shade = (AMBIENT + DIFFUSE * Math.max(0, lit)) * (back ? 0.75 : 1);
            for (let c = 0; c < 3; c++) colour[k * 4 + c] = r.colour[k * 4 + c]! * shade;
            colour[k * 4 + 3] = r.colour[k * 4 + 3]!;
        }
        tris.push({
            kind: r.kind,
            p,
            uv: Float64Array.from(r.uv),
            colour,
            texture: r.texture,
            wrapU: r.wrapU,
            wrapV: r.wrapV,
            cutoff: r.cutoff,
            depth: (p[2]! + p[5]! + p[8]!) / 3,
        });
    }
    return tris;
}

function blank(size: number): Picture {
    const bgra = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        bgra[i * 4] = BACKGROUND[2]!;
        bgra[i * 4 + 1] = BACKGROUND[1]!;
        bgra[i * 4 + 2] = BACKGROUND[0]!;
        bgra[i * 4 + 3] = 255;
    }
    return { width: size, height: size, bgra };
}

// Sectors drawn small (above), `size` pixels square.
export function thumbnail(
    parts: readonly Sector[],
    materials: ReadonlyMap<number, Material>,
    textures: TextureSet,
    size: number,
): Picture {
    const raws = rawTriangles(parts, materials);
    if (!raws.length) return blank(size);
    const tris = viewTriangles(raws, bestYaw(raws));
    const S = size * 2;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const t of tris)
        for (let k = 0; k < 3; k++) {
            minX = Math.min(minX, t.p[k * 3]!);
            maxX = Math.max(maxX, t.p[k * 3]!);
            minY = Math.min(minY, t.p[k * 3 + 1]!);
            maxY = Math.max(maxY, t.p[k * 3 + 1]!);
        }
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const scale = (S * 0.9) / span;
    const ox = S / 2 - ((minX + maxX) / 2) * scale;
    const oy = S / 2 + ((minY + maxY) / 2) * scale;

    const colour = new Float32Array(S * S * 3);
    for (let i = 0; i < S * S; i++) {
        colour[i * 3] = BACKGROUND[0]! / 255;
        colour[i * 3 + 1] = BACKGROUND[1]! / 255;
        colour[i * 3 + 2] = BACKGROUND[2]! / 255;
    }
    const depth = new Float32Array(S * S).fill(Infinity);
    const solid = new Uint8Array(S * S);
    let measured = 0;
    let measuredWeight = 0;
    const texel = new Float32Array(4);
    const sx = new Float64Array(3);
    const sy = new Float64Array(3);

    // (gain: the exposure, below; measure: only the drawn colours' brightness summed, nothing drawn)
    const draw = (t: Tri, gain: number, measure: boolean): void => {
        for (let k = 0; k < 3; k++) {
            sx[k] = t.p[k * 3]! * scale + ox;
            sy[k] = oy - t.p[k * 3 + 1]! * scale;
        }
        const area = (sx[1]! - sx[0]!) * (sy[2]! - sy[0]!) - (sy[1]! - sy[0]!) * (sx[2]! - sx[0]!);
        if (Math.abs(area) < 1e-9) return;
        let mip: ReturnType<TextureSet["mip"]> = null;
        if (t.texture) {
            const dims = textures.size(t.texture);
            if (dims) {
                const uvArea = Math.abs(
                    (t.uv[2]! - t.uv[0]!) * (t.uv[5]! - t.uv[1]!) - (t.uv[3]! - t.uv[1]!) * (t.uv[4]! - t.uv[0]!),
                );
                const ratio = (uvArea * dims[0] * dims[1]) / Math.abs(area);
                const level = ratio > 1 ? Math.round(0.5 * Math.log2(ratio)) : 0;
                mip = textures.mip(t.texture, level);
            }
        }
        const x0 = Math.max(0, Math.floor(Math.min(sx[0]!, sx[1]!, sx[2]!)));
        const x1 = Math.min(S - 1, Math.ceil(Math.max(sx[0]!, sx[1]!, sx[2]!)));
        const y0 = Math.max(0, Math.floor(Math.min(sy[0]!, sy[1]!, sy[2]!)));
        const y1 = Math.min(S - 1, Math.ceil(Math.max(sy[0]!, sy[1]!, sy[2]!)));
        const c = t.colour;
        for (let y = y0; y <= y1; y++) {
            const py = y + 0.5;
            for (let x = x0; x <= x1; x++) {
                const px = x + 0.5;
                const w0 = ((sx[1]! - px) * (sy[2]! - py) - (sy[1]! - py) * (sx[2]! - px)) / area;
                const w1 = ((sx[2]! - px) * (sy[0]! - py) - (sy[2]! - py) * (sx[0]! - px)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * t.p[2]! + w1 * t.p[5]! + w2 * t.p[8]!;
                const at = y * S + x;
                if (z >= depth[at]!) continue;
                let r = w0 * c[0]! + w1 * c[4]! + w2 * c[8]!;
                let g = w0 * c[1]! + w1 * c[5]! + w2 * c[9]!;
                let b = w0 * c[2]! + w1 * c[6]! + w2 * c[10]!;
                let a = w0 * c[3]! + w1 * c[7]! + w2 * c[11]!;
                if (mip) {
                    const u = w0 * t.uv[0]! + w1 * t.uv[2]! + w2 * t.uv[4]!;
                    const v = w0 * t.uv[1]! + w1 * t.uv[3]! + w2 * t.uv[5]!;
                    sample(mip, u, v, t.wrapU, t.wrapV, texel);
                    r *= texel[0]!;
                    g *= texel[1]!;
                    b *= texel[2]!;
                    a *= texel[3]!;
                }
                if (a < t.cutoff) continue;
                if (measure) {
                    measured += (0.3 * r + 0.59 * g + 0.11 * b) * a;
                    measuredWeight += a;
                    continue;
                }
                r *= gain;
                g *= gain;
                b *= gain;
                const o = at * 3;
                if (t.kind === Kind.Solid) {
                    solid[at] = 1;
                    depth[at] = z;
                    colour[o] = r;
                    colour[o + 1] = g;
                    colour[o + 2] = b;
                } else if (t.kind === Kind.Blend) {
                    if (a >= 0.98) depth[at] = z;
                    colour[o] = colour[o]! + (r - colour[o]!) * a;
                    colour[o + 1] = colour[o + 1]! + (g - colour[o + 1]!) * a;
                    colour[o + 2] = colour[o + 2]! + (b - colour[o + 2]!) * a;
                } else {
                    colour[o] = colour[o]! + r * a;
                    colour[o + 1] = colour[o + 1]! + g * a;
                    colour[o + 2] = colour[o + 2]! + b * a;
                }
            }
        }
    };
    // Exposure: the levels' vertex colours are their baked light - often dim; the piece brought to a middling
    // brightness, never darkened - measured on the solid surfaces as drawn, or (none) on the see-through ones'
    // colours (a shadow decal stays dark).
    const exposure = (sum: number, weight: number): number =>
        weight > 0 && sum > 0 ? Math.max(1, Math.min(EXPOSURE_MAX, (EXPOSURE * weight) / sum)) : 1;
    for (const t of tris) if (t.kind === Kind.Solid) draw(t, 1, false);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < S * S; i++) {
        if (!solid[i]) continue;
        sum += 0.3 * colour[i * 3]! + 0.59 * colour[i * 3 + 1]! + 0.11 * colour[i * 3 + 2]!;
        count++;
    }
    const blended = tris.filter((x) => x.kind === Kind.Blend).sort((a, b) => b.depth - a.depth);
    if (!count) for (const t of blended) draw(t, 1, true);
    const gain = count ? exposure(sum, count) : exposure(measured, measuredWeight);
    if (gain !== 1) {
        for (let i = 0; i < S * S; i++) {
            if (!solid[i]) continue;
            for (let c = 0; c < 3; c++) colour[i * 3 + c] = colour[i * 3 + c]! * gain;
        }
    }
    for (const t of blended) draw(t, gain, false);
    for (const t of tris) if (t.kind === Kind.Add) draw(t, gain, false);

    const picture = blank(size);
    const out = picture.bgra;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * 2 * S + x * 2) * 3;
            const j = i + S * 3;
            const at = (y * size + x) * 4;
            for (let ch = 0; ch < 3; ch++) {
                const v = (colour[i + ch]! + colour[i + 3 + ch]! + colour[j + ch]! + colour[j + 3 + ch]!) / 4;
                out[at + 2 - ch] = Math.round(Math.max(0, Math.min(1, v)) * 255);
            }
        }
    }
    return picture;
}
