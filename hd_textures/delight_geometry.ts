// NOT ORIGINAL - the level geometry delight.ts's lighting model is checked against (DELIGHT_VERSION 2): where a
// texture sits in the level, which way is up (toward the sky) in its picture, and where other surfaces
// meet it. delight.ts removes painted light only where the texels' broad variation takes a shape lighting takes AND
// agrees with this:
// - the light's way in a picture: a flat face under the sun is lit evenly - what falls off across a face is the sky
//   and the ground (a wall darker toward its foot, lighter toward the open sky), so the way is straight up (world +y).
//   Per texture (or atlas region): for each triangle using it, up's part in the face's plane written in the
//   triangle's uv frame (how u, v change going up the face), turned into the picture's own coordinates, weighted by
//   the face's area and by how far up lies in its plane (a floor or a ceiling has no up across it); averaged - its
//   length is how consistently the picture is mapped (1: every face puts the sky on the same side of it; 0: no
//   telling - a floor, faces mapped every which way);
// - lines where surfaces meet: each triangle edge that runs straight along the picture's u or v (a facade's edge, a
//   ledge, the foot of a wall) and where another solid surface meets this one in a concave corner - within 8 units of
//   the edge, more than 25 degrees off its plane and reaching out in front of it (a floor at the foot of a wall, a
//   ledge's underside, an inside corner; not an outside corner, which catches light) - at a quarter, half and three
//   quarters along it. Collected per position in the picture (a 64th of its size): the share of their length that
//   meets something and which side of the line the face lies on - delight.ts's edge and band terms take their places
//   and their evidence from these;
// - the facts that leave a texture as it is (delight.ts skipReason): it moves (the water system's rule,
//   render_pc/water_materials.cpp: a material whose passes scroll or animate, first pass drawn as a surface - water,
//   lava, scrolling signs), or it is a backdrop (most of its area farther out than three times the radius that holds
//   nine tenths of the level's sectors - painted skylines, distant scenery).
//
// The faces' normals are their winding's, turned to agree with the vertex normals where the mesh has them. Sectors
// met again in another scene file of the folder (a level's _net copy) are read once (by checksum).

import * as fs from "node:fs";
import * as path from "node:path";
import * as scn from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { sceneFiles } from "./atlas.ts";

// A line in a texture's (or region's) picture, coordinates normalised to it (x across 0 - 1, y down 0 - 1).
export interface Line {
    axis: "x" | "y"; // "x": the line x = at (it runs down the picture); "y": the line y = at
    at: number;
    side: number; // where the faces using the texture lie: +1 at greater x (or y), -1 at smaller, 0 both
    meets: number; // the share of its length where another surface meets this one in a concave corner (0 - 1)
    length: number; // its total length (normalised units: 1 = the picture's side)
}

// What the level says about a picture: the way up in its coordinates and its lines.
export interface Evidence {
    // the way up (toward the sky) in the picture (x, y), its length the consistency (0 - 1); null: no faces
    light: [number, number] | null;
    lines: Line[];
    faces: number; // triangles taken
}

export interface TextureFacts {
    area: number; // its surface triangles' area
    moving: boolean; // drawn by a moving material (water, lava, scrolling)
    backdrop: number; // the share of its area far outside the play area (0 - 1)
}

const surfaceBlend = (mode: number): boolean => [0, 5, 6, 0xb].includes(mode & 0xffffff);

// A material moves as the water system's rule has it: a pass scrolls / wibbles or animates its texture.
function moving(material: scn.Material): boolean {
    return material.passes.some(
        (p) => (p.flags & (scn.PASS_UV_WIBBLE | scn.PASS_ANIMATES)) !== 0 || !!p.uvWibble || !!p.animation,
    );
}

const MEET_RADIUS = 8;
const MEET_ANGLE = Math.cos((25 * Math.PI) / 180);
const CELL = 128;
const MAX_CELLS = 4096;
const BUCKETS = 64;

interface Use {
    tris: number[];
    uvs: number[]; // 6 per triangle
}

export class SceneGeometry {
    private pos: Float32Array = new Float32Array(0); // 9 per triangle
    private nrm: Float32Array = new Float32Array(0); // 3 per triangle (unit)
    private area: Float32Array = new Float32Array(0);
    private readonly uses = new Map<number, Use>();
    private readonly movingTextures = new Set<number>();
    private readonly grid = new Map<number, number[]>();
    private readonly big: number[] = [];
    private meetCache: Float32Array = new Float32Array(0);
    private stamp: Uint32Array = new Uint32Array(0);
    private stampNow = 0;
    // the way toward the light that falls off across a face: straight up (the sky; the ground below)
    readonly light: [number, number, number] = [0, 1, 0];
    private readonly centre: [number, number];
    private readonly radius: number;

    constructor(scenes: readonly scn.Scene[]) {
        const pos: number[] = [];
        const nrm: number[] = [];
        const area: number[] = [];
        const seen = new Set<number>();
        const sectorX: number[] = [];
        const sectorZ: number[] = [];
        for (const scene of scenes) {
            const materials = new Map(scene.materials.map((m) => [m.checksum, m]));
            for (const sector of scene.sectors) {
                if (seen.has(sector.checksum)) continue;
                seen.add(sector.checksum);
                if (sector.bbox.length >= 6) {
                    sectorX.push((sector.bbox[0]! + sector.bbox[3]!) / 2);
                    sectorZ.push((sector.bbox[2]! + sector.bbox[5]!) / 2);
                }
                for (const mesh of sector.meshes) {
                    const material = materials.get(mesh.material);
                    const buffer = mesh.buffers[0]?.[1];
                    if (!material || !buffer || mesh.stride < 12) continue;
                    const moves = moving(material);
                    const first = material.passes[0];
                    if (moves && first && surfaceBlend(first.blendMode))
                        for (const t of [first.texture, ...(first.animation?.[3] ?? []).map((k) => k[1] ?? 0)])
                            if (t) this.movingTextures.add(t);
                    const billboard = (sector.flags & scn.SEC_BILLBOARD) !== 0;
                    const surfacePasses = material.passes
                        .map((p, n) => ({ p, n }))
                        .filter(({ p }) => !(p.flags & scn.PASS_ENVIRONMENT) && surfaceBlend(p.blendMode));
                    if (billboard || !surfacePasses.length) continue;
                    const stride = mesh.stride;
                    const shader = mesh.vertexShader[0] ?? 0;
                    const fvf = shader > 6;
                    const normalAt = fvf && shader & scn.FVF_NORMAL ? (mesh.offsets[0] ?? 0) : -1;
                    const uvAt = mesh.offsets[2] ?? 0;
                    const room = uvAt > 0 && stride > uvAt ? Math.floor((stride - uvAt) / 8) : 0;
                    const sets = fvf ? Math.min(room, (shader >>> scn.FVF_TEXCOUNT_SHIFT) & 0xf) : room;
                    const count = Math.min(mesh.vertexCount, Math.floor(buffer.length / stride));
                    const f = (i: number, at: number): number => buffer.readFloatLE(i * stride + at);
                    const strip = mesh.strips[0] ?? [];
                    for (let k = 0; k + 2 < strip.length; k++) {
                        let a = strip[k]!;
                        let b = strip[k + 1]!;
                        const c = strip[k + 2]!;
                        if (a === b || b === c || a === c || Math.max(a, b, c) >= count) continue;
                        if (k & 1) [a, b] = [b, a];
                        const p = [a, b, c].flatMap((i) => [f(i, 0), f(i, 4), f(i, 8)]);
                        if (!p.every(Number.isFinite)) continue;
                        const ux = p[3]! - p[0]!;
                        const uy = p[4]! - p[1]!;
                        const uz = p[5]! - p[2]!;
                        const vx = p[6]! - p[0]!;
                        const vy = p[7]! - p[1]!;
                        const vz = p[8]! - p[2]!;
                        let nx = uy * vz - uz * vy;
                        let ny = uz * vx - ux * vz;
                        let nz = ux * vy - uy * vx;
                        const len = Math.hypot(nx, ny, nz);
                        if (!(len > 1e-6)) continue;
                        nx /= len;
                        ny /= len;
                        nz /= len;
                        if (normalAt >= 0 && normalAt + 12 <= stride) {
                            let d = 0;
                            for (const i of [a, b, c])
                                d += nx * f(i, normalAt) + ny * f(i, normalAt + 4) + nz * f(i, normalAt + 8);
                            if (d < 0) [nx, ny, nz] = [-nx, -ny, -nz];
                        }
                        const tri = area.length;
                        pos.push(...p);
                        nrm.push(nx, ny, nz);
                        area.push(len / 2);
                        if (!sets || !(sector.flags & scn.SEC_TEXCOORDS)) continue;
                        for (const { p: pass, n } of surfacePasses) {
                            if (pass.flags & scn.PASS_UV_WIBBLE) continue;
                            const at = uvAt + 8 * Math.min(n, sets - 1);
                            const uv = [a, b, c].flatMap((i) => [f(i, at), f(i, at + 4)]);
                            if (!uv.every(Number.isFinite)) continue;
                            for (const t of [pass.texture, ...(pass.animation?.[3] ?? []).map((key) => key[1] ?? 0)]) {
                                if (!t) continue;
                                let use = this.uses.get(t);
                                if (!use) {
                                    use = { tris: [], uvs: [] };
                                    this.uses.set(t, use);
                                }
                                use.tris.push(tri);
                                use.uvs.push(...uv);
                            }
                        }
                    }
                }
            }
        }
        this.pos = Float32Array.from(pos);
        this.nrm = Float32Array.from(nrm);
        this.area = Float32Array.from(area);
        const n = area.length;
        this.meetCache = new Float32Array(n * 3).fill(-1);
        this.stamp = new Uint32Array(n);
        // the play area: the radius (across x, z) holding nine tenths of the sectors' middles round their median
        const median = (v: number[]): number => [...v].sort((p, q) => p - q)[v.length >> 1] ?? 0;
        this.centre = [median(sectorX), median(sectorZ)];
        const d = sectorX
            .map((x, k) => Math.hypot(x - this.centre[0], sectorZ[k]! - this.centre[1]))
            .sort((p, q) => p - q);
        this.radius = d[Math.floor(d.length * 0.9)] ?? 0;
        // the meeting test's grid
        for (let t = 0; t < n; t++) {
            const lo = [0, 1, 2].map((k) =>
                cellOf(Math.min(this.pos[t * 9 + k]!, this.pos[t * 9 + 3 + k]!, this.pos[t * 9 + 6 + k]!)),
            );
            const hi = [0, 1, 2].map((k) =>
                cellOf(Math.max(this.pos[t * 9 + k]!, this.pos[t * 9 + 3 + k]!, this.pos[t * 9 + 6 + k]!)),
            );
            const cells = (hi[0]! - lo[0]! + 1) * (hi[1]! - lo[1]! + 1) * (hi[2]! - lo[2]! + 1);
            if (cells > MAX_CELLS) {
                this.big.push(t);
                continue;
            }
            for (let x = lo[0]!; x <= hi[0]!; x++)
                for (let y = lo[1]!; y <= hi[1]!; y++)
                    for (let z = lo[2]!; z <= hi[2]!; z++) {
                        const key = cellKey(x, y, z);
                        let list = this.grid.get(key);
                        if (!list) {
                            list = [];
                            this.grid.set(key, list);
                        }
                        list.push(t);
                    }
        }
    }

    triangles(): number {
        return this.area.length;
    }

    facts(texture: number): TextureFacts | undefined {
        const use = this.uses.get(texture);
        if (!use && !this.movingTextures.has(texture)) return undefined;
        let total = 0;
        let far = 0;
        for (const t of use?.tris ?? []) {
            const a = this.area[t]!;
            total += a;
            const x = (this.pos[t * 9]! + this.pos[t * 9 + 3]! + this.pos[t * 9 + 6]!) / 3;
            const z = (this.pos[t * 9 + 2]! + this.pos[t * 9 + 5]! + this.pos[t * 9 + 8]!) / 3;
            if (this.radius > 0 && Math.hypot(x - this.centre[0], z - this.centre[1]) > 3 * this.radius) far += a;
        }
        return { area: total, moving: this.movingTextures.has(texture), backdrop: total > 0 ? far / total : 0 };
    }

    // The evidence for a texture's picture, or a rectangle of it (uv units: an atlas region): `wrapU` / `wrapV` its
    // tiling - a tiled axis has no lines across it (its picture repeats; a line would sit at every repeat) - and
    // `clampU` / `clampV` whether the passes clamp (else each triangle is taken in the tile its middle lies in).
    evidence(
        texture: number,
        rect: { u0: number; u1: number; v0: number; v1: number },
        wrap: { wrapU: boolean; wrapV: boolean },
    ): Evidence | null {
        const use = this.uses.get(texture);
        if (!use) return null;
        const sx = 1 / Math.max(1e-6, rect.u1 - rect.u0);
        const sy = 1 / Math.max(1e-6, rect.v1 - rect.v0);
        const light = [0, 0];
        let weight = 0;
        let faces = 0;
        const buckets = new Map<string, { length: number; meets: number; side: number }>();
        const L = this.light;
        for (let k = 0; k < use.tris.length; k++) {
            const t = use.tris[k]!;
            const uv = use.uvs.slice(k * 6, k * 6 + 6);
            const cu = (uv[0]! + uv[2]! + uv[4]!) / 3;
            const cv = (uv[1]! + uv[3]! + uv[5]!) / 3;
            const tu = Math.floor(cu);
            const tv = Math.floor(cv);
            // (the tile its middle lies in, unless the rectangle itself reaches past one)
            const ou = rect.u1 - rect.u0 > 1.001 ? 0 : tu;
            const ov = rect.v1 - rect.v0 > 1.001 ? 0 : tv;
            const x = [0, 1, 2].map((i) => (uv[i * 2]! - ou - rect.u0) * sx);
            const y = [0, 1, 2].map((i) => (uv[i * 2 + 1]! - ov - rect.v0) * sy);
            const mx = (x[0]! + x[1]! + x[2]!) / 3;
            const my = (y[0]! + y[1]! + y[2]!) / 3;
            if (mx < 0 || mx > 1 || my < 0 || my > 1) continue;
            faces++;
            const a = this.area[t]!;
            // the light's in-plane part in the picture: P(x, y) = P0 + T x + B y; Lp = alpha T + beta B
            const p = this.pos.subarray(t * 9, t * 9 + 9);
            const e1 = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
            const e2 = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
            const dx1 = x[1]! - x[0]!;
            const dy1 = y[1]! - y[0]!;
            const dx2 = x[2]! - x[0]!;
            const dy2 = y[2]! - y[0]!;
            const det = dx1 * dy2 - dx2 * dy1;
            if (Math.abs(det) > 1e-9) {
                const T = [0, 1, 2].map((i) => (e1[i]! * dy2 - e2[i]! * dy1) / det);
                const B = [0, 1, 2].map((i) => (e2[i]! * dx1 - e1[i]! * dx2) / det);
                const n = [this.nrm[t * 3]!, this.nrm[t * 3 + 1]!, this.nrm[t * 3 + 2]!];
                const ln = L[0] * n[0]! + L[1] * n[1]! + L[2] * n[2]!;
                const lp = [L[0] - ln * n[0]!, L[1] - ln * n[1]!, L[2] - ln * n[2]!];
                const inPlane = Math.hypot(...lp);
                const tt = dot(T, T);
                const tb = dot(T, B);
                const bb = dot(B, B);
                const g = tt * bb - tb * tb;
                if (inPlane > 1e-3 && g > 1e-12) {
                    const lt = dot(lp, T);
                    const lb = dot(lp, B);
                    const alpha = (lt * bb - lb * tb) / g;
                    const beta = (lb * tt - lt * tb) / g;
                    const len = Math.hypot(alpha, beta);
                    if (len > 0) {
                        light[0]! += (a * inPlane * alpha) / len;
                        light[1]! += (a * inPlane * beta) / len;
                    }
                }
                weight += a;
            }
            // the edges running along x or y
            for (let e = 0; e < 3; e++) {
                const i = e;
                const j = (e + 1) % 3;
                const o = (e + 2) % 3;
                const ddx = Math.abs(x[j]! - x[i]!);
                const ddy = Math.abs(y[j]! - y[i]!);
                let axis: "x" | "y";
                let at: number;
                let length: number;
                let other: number;
                if (ddx < 0.01 * ddy && ddy > 0.01) {
                    if (wrap.wrapU) continue;
                    axis = "x";
                    at = (x[i]! + x[j]!) / 2;
                    length = ddy;
                    other = x[o]! - at;
                } else if (ddy < 0.01 * ddx && ddx > 0.01) {
                    if (wrap.wrapV) continue;
                    axis = "y";
                    at = (y[i]! + y[j]!) / 2;
                    length = ddx;
                    other = y[o]! - at;
                } else continue;
                if (at < -0.02 || at > 1.02) continue;
                const bucket = at < 0.02 ? 0 : at > 0.98 ? BUCKETS : Math.round(at * BUCKETS);
                const key = `${axis}${bucket}`;
                let entry = buckets.get(key);
                if (!entry) {
                    entry = { length: 0, meets: 0, side: 0 };
                    buckets.set(key, entry);
                }
                entry.length += length;
                entry.meets += length * this.meeting(t, e);
                entry.side += Math.sign(other) * length;
            }
        }
        if (!faces) return null;
        const lines: Line[] = [];
        for (const [key, e] of buckets) {
            const axis = key[0] as "x" | "y";
            const at = Number(key.slice(1)) / BUCKETS;
            const lean = e.side / e.length;
            lines.push({
                axis,
                at,
                side: lean > 0.6 ? 1 : lean < -0.6 ? -1 : 0,
                meets: e.meets / e.length,
                length: e.length,
            });
        }
        lines.sort((p, q) => q.length * q.meets - p.length * p.meets || p.at - q.at || (p.axis < q.axis ? -1 : 1));
        return {
            light: weight > 0 ? [light[0]! / weight, light[1]! / weight] : null,
            lines,
            faces,
        };
    }

    // The share of the edge's three test points (a quarter, half, three quarters along) where another surface meets
    // the triangle in a concave corner (memoised).
    private meeting(t: number, e: number): number {
        const cached = this.meetCache[t * 3 + e]!;
        if (cached >= 0) return cached;
        const p = this.pos;
        const a = [p[t * 9 + e * 3]!, p[t * 9 + e * 3 + 1]!, p[t * 9 + e * 3 + 2]!];
        const f = ((e + 1) % 3) * 3;
        const b = [p[t * 9 + f]!, p[t * 9 + f + 1]!, p[t * 9 + f + 2]!];
        const n = [this.nrm[t * 3]!, this.nrm[t * 3 + 1]!, this.nrm[t * 3 + 2]!];
        let hits = 0;
        for (const s of [0.25, 0.5, 0.75]) {
            const q = [0, 1, 2].map((k) => a[k]! + (b[k]! - a[k]!) * s);
            if (this.meetsAt(t, q, n)) hits++;
        }
        const out = hits / 3;
        this.meetCache[t * 3 + e] = out;
        return out;
    }

    private meetsAt(self: number, q: number[], n: number[]): boolean {
        this.stampNow++;
        const lo = q.map((v) => cellOf(v - MEET_RADIUS));
        const hi = q.map((v) => cellOf(v + MEET_RADIUS));
        const test = (s: number): boolean => {
            if (s === self || this.stamp[s] === this.stampNow) return false;
            this.stamp[s] = this.stampNow;
            const ns = [this.nrm[s * 3]!, this.nrm[s * 3 + 1]!, this.nrm[s * 3 + 2]!];
            if (Math.abs(dot(n, ns)) > MEET_ANGLE) return false;
            const tri = this.pos.subarray(s * 9, s * 9 + 9);
            // (it reaches out in front of this face)
            let front = -Infinity;
            for (let v = 0; v < 3; v++)
                front = Math.max(
                    front,
                    (tri[v * 3]! - q[0]!) * n[0]! +
                        (tri[v * 3 + 1]! - q[1]!) * n[1]! +
                        (tri[v * 3 + 2]! - q[2]!) * n[2]!,
                );
            if (front < MEET_RADIUS) return false;
            return pointTriangleDistance(q, tri) <= MEET_RADIUS;
        };
        for (let x = lo[0]!; x <= hi[0]!; x++)
            for (let y = lo[1]!; y <= hi[1]!; y++)
                for (let z = lo[2]!; z <= hi[2]!; z++)
                    for (const s of this.grid.get(cellKey(x, y, z)) ?? []) if (test(s)) return true;
        for (const s of this.big) if (test(s)) return true;
        return false;
    }
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cellOf = (v: number): number => Math.max(-511, Math.min(511, Math.floor(v / CELL)));
const cellKey = (x: number, y: number, z: number): number => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);

// Small dense least squares: m x = r (Gaussian elimination with partial pivoting); null when singular.
export function solve(m: number[][], r: number[]): number[] | null {
    const n = r.length;
    const a = m.map((row, i) => [...row, r[i]!]);
    for (let c = 0; c < n; c++) {
        let best = c;
        for (let i = c + 1; i < n; i++) if (Math.abs(a[i]![c]!) > Math.abs(a[best]![c]!)) best = i;
        if (Math.abs(a[best]![c]!) < 1e-12) return null;
        [a[c], a[best]] = [a[best]!, a[c]!];
        for (let i = 0; i < n; i++) {
            if (i === c) continue;
            const f = a[i]![c]! / a[c]![c]!;
            if (f) for (let j = c; j <= n; j++) a[i]![j]! -= f * a[c]![j]!;
        }
    }
    return a.map((row, i) => row[n]! / row[i]!);
}

// The distance from a point to a triangle (9 floats) - the closest point by its region (Ericson, Real-Time Collision
// Detection 5.1.5).
export function pointTriangleDistance(p: readonly number[], t: ArrayLike<number>): number {
    const a = [t[0]!, t[1]!, t[2]!];
    const b = [t[3]!, t[4]!, t[5]!];
    const c = [t[6]!, t[7]!, t[8]!];
    const sub = (u: number[], v: readonly number[]): number[] => [u[0]! - v[0]!, u[1]! - v[1]!, u[2]! - v[2]!];
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub([...p], a);
    const at = (s: number, u: number[], v: number = 0, w: number[] = [0, 0, 0]): number[] => [
        a[0]! + s * u[0]! + v * w[0]!,
        a[1]! + s * u[1]! + v * w[1]!,
        a[2]! + s * u[2]! + v * w[2]!,
    ];
    const dist = (q: number[]): number => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return dist(a);
    const bp = sub([...p], b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return dist(b);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return dist(at(d1 / (d1 - d3), ab));
    const cp = sub([...p], c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return dist(c);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return dist(at(0, ab, d2 / (d2 - d6), ac));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        return dist([b[0]! + w * (c[0]! - b[0]!), b[1]! + w * (c[1]! - b[1]!), b[2]! + w * (c[2]! - b[2]!)]);
    }
    const denom = 1 / (va + vb + vc);
    return dist(at(vb * denom, ab, vc * denom, ac));
}

// The scene geometry of the scene files beside a dictionary (memoised per folder; atlas.ts' sceneFiles).
export class Geometries {
    private readonly folders = new Map<string, SceneGeometry>();

    of(dictionary: string): SceneGeometry {
        const dir = path.dirname(dictionary).toLowerCase();
        let found = this.folders.get(dir);
        if (!found) {
            const scenes: scn.Scene[] = [];
            for (const file of sceneFiles(dictionary)) {
                try {
                    scenes.push(scn.readScene(fs.readFileSync(file), file));
                } catch {
                    // (a scene not read: its textures have no evidence - left as they are)
                }
            }
            found = new SceneGeometry(scenes);
            this.folders.set(dir, found);
        }
        return found;
    }
}
