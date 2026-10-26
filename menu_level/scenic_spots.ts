// NOT ORIGINAL - scenic camera spots for the new front end's level art (the user's request, 2026-10-25: "for each
// level, find a scenic spot from above that captures a good representation of the level, capture it in our game,
// apply a stylistic filter"; prototype for THPS3). This file picks the candidate camera poses from the converted
// level's own collision (levels\<level>\<level>.col.xbx in the converter's staging folder); scenic_capture.ts takes
// the pictures in the game, scenic_art.ts filters them into the front end's art.
//
// How a spot is picked (all deterministic, from the level's collision faces and its nodes):
//   0. The play area: the box of the level's RailNode and Restart nodes (3rd-97th percentile, widened a tenth) - the
//      far scenery (Rio's mountains, Airport's sea) is outside it. Its diagonal is the level's size below.
//   1. Each face gets an interest weight from its slope: ramps / banks / quarter pipes (the skate lines) most, walls
//      and flat ground a little, ceilings nothing. The sloped and wall faces' weights (flat ground is everywhere) and
//      the rail points are summed into an XZ grid over the play area (cell = its extent / 48; a face counts at most a
//      cell's area), blurred, and the grid's local maxima (at least a fifth of the extent apart) are the targets: the
//      densest skateable areas.
//   2. Around each target: a 3/4 aerial camera at 8 headings x 3 pitches (32-52 degrees down) x 3 distances (a
//      fraction of the level's size; under a ceiling - Airport's terminal - two more just below it), looking at it.
//   3. Each pose is ray cast at a coarse grid of the picture (the game's field of view): what each ray hits, how far,
//      the face's weight (a third outside the play area) and whether it's seen from the front; and the rail points
//      in the picture that nothing hides. The score rewards interest spread over the picture, seen rails and depth; it
//      punishes rays below the horizon that hit nothing (void outside the world), faces seen from the back (a level's
//      outer walls from outside - not drawn), the camera hugging a wall, much sky and a camera with something between
//      it and the target (a roof).
//      The level's drawn scene (its .scn.xbx, the solid-looking meshes) is cast too: a drawn face well in front of the
//      collision hit (Burnside's bridge girders - render-only, not in the collision) is an occluder - counted, punished,
//      and it hides rails and the target; a ray that hits only drawn scenery is not void. A roof over a target is looked
//      for in both (the drawn one too), so indoor levels get cameras under it.
//   4. The best poses, kept apart (another target or a heading 60+ degrees away), are the candidates: the pictures
//      are taken of those and the best is chosen by looking at them (scenic_art/<game>.json's `chosen`).
//
//   node tools/pipeline/menu_level/scenic_spots.ts <staging folder> <level>... [--count 6] [--out <json>]
// prints the candidates (and with --out merges them into that spots file, keeping each level's `chosen`).

import * as fs from "node:fs";
import * as path from "node:path";
import { materialSeeThrough } from "../game/pick_census.ts";
import { Struct } from "../level_port/qb.ts";
import * as thug2Col from "../level_port/thug2_col.ts";
import * as thug2Scene from "../level_port/thug2_scene.ts";
import { parseCli } from "../lib/cli.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import { isName, nodeArray, position } from "../thaw_levels/thugpro_compare.ts";

export type V3 = [number, number, number];

// The game's camera: horizontal field of view at 16:9 (THUG2's 72 degrees at 4:3 widened for the 16:9 window -
// src/game/gfx/camera.h m_adjustedHFov: tan(36) * (16/9) / (4/3) = tan(44)) and the picture's aspect.
export const FOV_H_DEG = 88;
export const ASPECT = 16 / 9;

// A triangle for ray casting: its corners, its interest weight, its normal (unit, oriented up for floors).
export interface Tri {
    a: V3;
    b: V3;
    c: V3;
    n: V3;
    w: number;
    area: number;
}

const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const cross = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const dot = (p: V3, q: V3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const len = (p: V3): number => Math.sqrt(dot(p, p));

// The interest of a face by its (up-oriented) normal's y and whether the level calls it vert.
export function faceWeight(ny: number, vert: boolean): number {
    if (vert) return 1.0;
    if (ny > 0.97) return 0.3; // flat ground
    if (ny > 0.2) return 1.0; // ramps, banks, quarter pipes
    if (ny >= -0.2) return 0.25; // walls
    return 0; // ceilings, undersides
}

// The faces that are seen (not triggers, invisible walls or non-collidable helpers), from a collision file.
export function trisFromCol(col: thug2Col.ColFile): Tri[] {
    const skip = thug2Col.FACE_TRIGGER | thug2Col.FACE_INVISIBLE | thug2Col.FACE_NON_COLLIDABLE;
    const raw: { a: V3; b: V3; c: V3; n: V3; area: number; vert: boolean }[] = [];
    for (const o of col.objects)
        for (const [flags, , ia, ib, ic] of o.faces) {
            if (flags & skip) continue;
            const a = o.verts[ia] as V3;
            const b = o.verts[ib] as V3;
            const c = o.verts[ic] as V3;
            const n = cross(sub(b, a), sub(c, a));
            const l = len(n);
            if (l < 1e-6) continue;
            raw.push({
                a,
                b,
                c,
                n: [n[0] / l, n[1] / l, n[2] / l],
                area: l / 2,
                vert: (flags & thug2Col.FACE_VERT) !== 0,
            });
        }
    return orientTris(raw);
}

// The winding's sign: the one that makes most of the near-horizontal area face up (floors outnumber ceilings).
export function orientTris(raw: readonly { a: V3; b: V3; c: V3; n: V3; area: number; vert?: boolean }[]): Tri[] {
    let up = 0;
    for (const t of raw) if (Math.abs(t.n[1]) > 0.7) up += Math.sign(t.n[1]) * t.area;
    const s = up >= 0 ? 1 : -1;
    return raw.map((t) => {
        const n: V3 = [t.n[0] * s, t.n[1] * s, t.n[2] * s];
        return { a: t.a, b: t.b, c: t.c, n, area: t.area, w: faceWeight(n[1], t.vert ?? false) };
    });
}

// --- ray casting over an XZ grid ----------------------------------------------------------------------------------

export class Scene {
    readonly tris: Tri[];
    readonly min: V3;
    readonly max: V3;
    readonly cell: number;
    readonly nx: number;
    readonly nz: number;
    private readonly cells: Int32Array[];
    private readonly stamp: Int32Array;
    private ray = 0;

    constructor(tris: Tri[], cells = 96) {
        this.tris = tris;
        const min: V3 = [Infinity, Infinity, Infinity];
        const max: V3 = [-Infinity, -Infinity, -Infinity];
        for (const t of tris)
            for (const p of [t.a, t.b, t.c])
                for (let k = 0; k < 3; k++) {
                    min[k] = Math.min(min[k]!, p[k]!);
                    max[k] = Math.max(max[k]!, p[k]!);
                }
        this.min = min;
        this.max = max;
        this.cell = Math.max(max[0] - min[0], max[2] - min[2], 1) / cells;
        this.nx = Math.max(1, Math.ceil((max[0] - min[0]) / this.cell) + 1);
        this.nz = Math.max(1, Math.ceil((max[2] - min[2]) / this.cell) + 1);
        const lists: number[][] = Array.from({ length: this.nx * this.nz }, () => []);
        tris.forEach((t, i) => {
            const x0 = this.cx(Math.min(t.a[0], t.b[0], t.c[0]));
            const x1 = this.cx(Math.max(t.a[0], t.b[0], t.c[0]));
            const z0 = this.cz(Math.min(t.a[2], t.b[2], t.c[2]));
            const z1 = this.cz(Math.max(t.a[2], t.b[2], t.c[2]));
            for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) lists[z * this.nx + x]!.push(i);
        });
        this.cells = lists.map((l) => Int32Array.from(l));
        this.stamp = new Int32Array(tris.length).fill(-1);
        this.playMin = [...min];
        this.playMax = [...max];
    }

    private cx(x: number): number {
        return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.min[0]) / this.cell)));
    }
    private cz(z: number): number {
        return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.min[2]) / this.cell)));
    }

    // The play area (the box the targets are picked in and the distances measured by): the geometry's box, or with
    // setPlay the box of the level's rails and restarts. `rails`: the rail points (interest of their own).
    playMin: V3 = [0, 0, 0];
    playMax: V3 = [0, 0, 0];
    rails: V3[] = [];
    // The drawn scene's faces (visibility only: no weights), when the level's scene file was read.
    drawn: Scene | null = null;

    // The nearest hit in the collision or (when present) the drawn scene: which one, for the occlusion tests.
    castBoth(o: V3, d: V3, far = 1e9): { col: { t: number; tri: Tri } | null; drawn: { t: number; tri: Tri } | null } {
        return { col: this.cast(o, d, far), drawn: this.drawn ? this.drawn.cast(o, d, far) : null };
    }

    // The play area from the level's nodes: their x / z between the 3rd and 97th percentiles, widened by a tenth on
    // each side (the far scenery - Rio's mountains, Airport's sea - left out). Fewer than 8 points: the geometry's box.
    setPlay(points: readonly V3[], rails: readonly V3[]): void {
        this.rails = [...rails];
        if (points.length < 8) return;
        const pct = (k: number, q: number): number => {
            const sorted = points.map((p) => p[k]!).sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
        };
        const min: V3 = [pct(0, 0.03), this.min[1], pct(2, 0.03)];
        const max: V3 = [pct(0, 0.97), this.max[1], pct(2, 0.97)];
        for (const k of [0, 2]) {
            const pad = Math.max((max[k]! - min[k]!) * 0.1, 300);
            min[k] = Math.max(this.min[k]!, min[k]! - pad);
            max[k] = Math.min(this.max[k]!, max[k]! + pad);
        }
        this.playMin = min;
        this.playMax = max;
    }

    inPlay(p: V3): boolean {
        return p[0] >= this.playMin[0] && p[0] <= this.playMax[0] && p[2] >= this.playMin[2] && p[2] <= this.playMax[2];
    }

    // The play area's diagonal (x / z).
    playSize(): number {
        return Math.hypot(this.playMax[0] - this.playMin[0], this.playMax[2] - this.playMin[2]);
    }

    // The nearest hit along o + t d (d unit), t < far: its distance and triangle, or null.
    cast(o: V3, d: V3, far = 1e9): { t: number; tri: Tri } | null {
        const id = ++this.ray;
        // clip the ray to the grid's XZ box
        let t0 = 0;
        let t1 = far;
        for (const k of [0, 2]) {
            const lo = this.min[k]!;
            const hi = this.min[k]! + (k === 0 ? this.nx : this.nz) * this.cell;
            if (Math.abs(d[k]!) < 1e-12) {
                if (o[k]! < lo || o[k]! > hi) return null;
            } else {
                let a = (lo - o[k]!) / d[k]!;
                let b = (hi - o[k]!) / d[k]!;
                if (a > b) [a, b] = [b, a];
                t0 = Math.max(t0, a);
                t1 = Math.min(t1, b);
            }
        }
        if (t0 > t1) return null;
        const px = o[0] + d[0] * t0;
        const pz = o[2] + d[2] * t0;
        let ix = this.cx(px);
        let iz = this.cz(pz);
        const stepX = d[0] > 0 ? 1 : -1;
        const stepZ = d[2] > 0 ? 1 : -1;
        const nextX = (ix + (stepX > 0 ? 1 : 0)) * this.cell + this.min[0];
        const nextZ = (iz + (stepZ > 0 ? 1 : 0)) * this.cell + this.min[2];
        let tMaxX = Math.abs(d[0]) < 1e-12 ? Infinity : (nextX - o[0]) / d[0];
        let tMaxZ = Math.abs(d[2]) < 1e-12 ? Infinity : (nextZ - o[2]) / d[2];
        const dX = Math.abs(d[0]) < 1e-12 ? Infinity : this.cell / Math.abs(d[0]);
        const dZ = Math.abs(d[2]) < 1e-12 ? Infinity : this.cell / Math.abs(d[2]);
        let best: { t: number; tri: Tri } | null = null;
        for (;;) {
            for (const i of this.cells[iz * this.nx + ix]!) {
                if (this.stamp[i] === id) continue;
                this.stamp[i] = id;
                const tri = this.tris[i]!;
                const t = intersect(o, d, tri);
                if (t !== null && t < far && (best === null || t < best.t)) best = { t, tri };
            }
            const cellExit = Math.min(tMaxX, tMaxZ);
            if (best !== null && best.t <= cellExit) return best;
            if (cellExit > t1) return best;
            if (tMaxX < tMaxZ) {
                ix += stepX;
                tMaxX += dX;
                if (ix < 0 || ix >= this.nx) return best;
            } else {
                iz += stepZ;
                tMaxZ += dZ;
                if (iz < 0 || iz >= this.nz) return best;
            }
        }
    }
}

// Möller-Trumbore, both sides: the distance or null.
export function intersect(o: V3, d: V3, tri: Tri): number | null {
    const e1 = sub(tri.b, tri.a);
    const e2 = sub(tri.c, tri.a);
    const p = cross(d, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-9) return null;
    const inv = 1 / det;
    const s = sub(o, tri.a);
    const u = dot(s, p) * inv;
    if (u < 0 || u > 1) return null;
    const q = cross(s, e1);
    const v = dot(d, q) * inv;
    if (v < 0 || u + v > 1) return null;
    const t = dot(e2, q) * inv;
    return t > 1e-3 ? t : null;
}

// --- poses --------------------------------------------------------------------------------------------------------

// A camera: position, heading (degrees, 0 = +z, 90 = +x) and pitch (degrees down).
export interface Pose {
    pos: V3;
    heading: number;
    pitch: number;
}

export function forward(heading: number, pitch: number): V3 {
    const h = (heading * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    return [Math.sin(h) * Math.cos(p), -Math.sin(p), Math.cos(h) * Math.cos(p)];
}

// The ray through picture point (u, v) in [-1, 1] (v up) of a pose.
export function viewRay(pose: Pose, u: number, v: number): V3 {
    const f = forward(pose.heading, pose.pitch);
    const h = (pose.heading * Math.PI) / 180;
    const right: V3 = [Math.cos(h), 0, -Math.sin(h)];
    const up = cross(right, f); // (right x forward: up for a right-handed y-up frame... checked by its y below)
    const upFixed: V3 = up[1] < 0 ? [-up[0], -up[1], -up[2]] : up;
    const tx = Math.tan(((FOV_H_DEG / 2) * Math.PI) / 180);
    const ty = tx / ASPECT;
    const d: V3 = [
        f[0] + right[0] * u * tx + upFixed[0] * v * ty,
        f[1] + right[1] * u * tx + upFixed[1] * v * ty,
        f[2] + right[2] * u * tx + upFixed[2] * v * ty,
    ];
    const l = len(d);
    return [d[0] / l, d[1] / l, d[2] / l];
}

export interface Score {
    score: number;
    interest: number;
    rails: number; // the rails seen (unhidden), as a share of a fifth of the level's (at most 1)
    spread: number; // of the picture's 4 x 3 tiles, the share with interest
    depth: number; // spread of log depth
    sky: number;
    void: number;
    back: number;
    near: number;
    occl: number; // the share of rays whose first hit is drawn scenery well in front of the collision (girders, lamps)
    blocked: boolean; // something between the camera and the target
}

// The pose's picture ray cast at gw x gh points. `target`: what it looks at; `size`: the level's size (for distances).
export function scorePose(scene: Scene, pose: Pose, target: V3, size: number, gw = 48, gh = 27): Score {
    const far = size * 2.5;
    let interest = 0;
    let sky = 0;
    let voids = 0;
    let back = 0;
    let near = 0;
    let occl = 0;
    const tiles = new Float64Array(12);
    const logs: number[] = [];
    for (let j = 0; j < gh; j++) {
        const v = 1 - (2 * (j + 0.5)) / gh;
        for (let i = 0; i < gw; i++) {
            const u = (2 * (i + 0.5)) / gw - 1;
            const d = viewRay(pose, u, v);
            const both = scene.castBoth(pose.pos, d, far);
            const hit = both.col;
            const drawn = both.drawn;
            if (hit === null) {
                // (only drawn scenery out there: not a void, not interesting either)
                if (drawn !== null) continue;
                if (d[1] > 0.03) sky += 1;
                else voids += 1;
                continue;
            }
            // drawn structure well in front of the collision hit hides what the player would skate on
            if (drawn !== null && drawn.t < hit.t - Math.max(40, hit.t * 0.06)) {
                occl += 1;
                if (drawn.t < Math.max(120, size * 0.02)) near += 1;
                continue;
            }
            if (dot(hit.tri.n, d) > 0) {
                back += 1;
                continue;
            }
            if (hit.t < Math.max(120, size * 0.02)) near += 1;
            // (detail fades with distance: a far face counts less)
            const fade = 1 / (1 + (hit.t / (size * 0.6)) ** 2);
            // (the scenery outside the play area counts a third)
            const at: V3 = [pose.pos[0] + d[0] * hit.t, pose.pos[1] + d[1] * hit.t, pose.pos[2] + d[2] * hit.t];
            const w = hit.tri.w * fade * (scene.inPlay(at) ? 1 : 0.35);
            interest += w;
            tiles[Math.min(2, Math.floor((j * 3) / gh)) * 4 + Math.min(3, Math.floor((i * 4) / gw))]! += w;
            logs.push(Math.log(hit.t));
        }
    }
    const n = gw * gh;
    const tileShare = n / 12;
    const spread = [...tiles].filter((t) => t / tileShare > 0.15).length / 12;
    let depth = 0;
    if (logs.length > 1) {
        const mean = logs.reduce((s, x) => s + x, 0) / logs.length;
        depth = Math.sqrt(logs.reduce((s, x) => s + (x - mean) ** 2, 0) / logs.length);
    }
    // between the camera and the target (a roof, a wall): the ray to the target stops well short of it
    const toTarget = sub(target, pose.pos);
    const dist = len(toTarget);
    const hitT = scene.cast(pose.pos, [toTarget[0] / dist, toTarget[1] / dist, toTarget[2] / dist], dist);
    const dirT: V3 = [toTarget[0] / dist, toTarget[1] / dist, toTarget[2] / dist];
    const hitDrawn = scene.drawn ? scene.drawn.cast(pose.pos, dirT, dist) : null;
    const blocked = (hitT !== null && hitT.t < dist * 0.8) || (hitDrawn !== null && hitDrawn.t < dist * 0.8);
    // the rails in the picture and not hidden: the skate lines
    let seen = 0;
    const f = forward(pose.heading, pose.pitch);
    const tx = Math.tan(((FOV_H_DEG / 2) * Math.PI) / 180);
    const cosHalf = Math.cos(Math.atan(Math.hypot(tx, tx / ASPECT)) * 0.85);
    for (const rail of scene.rails) {
        const to = sub(rail, pose.pos);
        const l = len(to);
        if (l < 1 || dot(to, f) / l < cosHalf || l > far) continue;
        const dir: V3 = [to[0] / l, to[1] / l, to[2] / l];
        const h = scene.cast(pose.pos, dir, l);
        const hd = scene.drawn ? scene.drawn.cast(pose.pos, dir, l) : null;
        if ((h === null || h.t > l - 40) && (hd === null || hd.t > l - 40)) seen += 1;
    }
    const rails = scene.rails.length ? Math.min(1, seen / Math.max(4, scene.rails.length * 0.2)) : 0;
    const r = {
        rails,
        interest: interest / n,
        spread,
        depth,
        sky: sky / n,
        void: voids / n,
        back: back / n,
        near: near / n,
        occl: occl / n,
    };
    const score =
        2 * r.interest +
        0.8 * r.rails +
        0.6 * r.spread +
        0.3 * Math.min(r.depth, 1) -
        4 * r.void -
        2.5 * r.back -
        3 * r.near -
        3 * Math.max(0, r.occl - 0.04) -
        1.5 * Math.max(0, r.sky - 0.3) -
        (blocked ? 1 : 0);
    return { score: Math.round(score * 1e4) / 1e4, ...round4(r), blocked };
}

function round4<T extends Record<string, number>>(o: T): T {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4])) as T;
}

// --- targets ------------------------------------------------------------------------------------------------------

// The densest interest spots: (x, ground y, z) of the blurred interest grid's local maxima, `count` at most, at least
// `apart` (a share of the extent) from each other.
export function pickTargets(scene: Scene, count = 6, cells = 48, apart = 0.2): V3[] {
    const lo = scene.playMin;
    const hi = scene.playMax;
    const ext = Math.max(hi[0] - lo[0], hi[2] - lo[2], 1);
    const cell = ext / cells;
    const nx = Math.ceil((hi[0] - lo[0]) / cell) + 1;
    const nz = Math.ceil((hi[2] - lo[2]) / cell) + 1;
    const index = (x: number, z: number): number => {
        const ix = Math.floor((x - lo[0]) / cell);
        const iz = Math.floor((z - lo[2]) / cell);
        return ix < 0 || iz < 0 || ix >= nx || iz >= nz ? -1 : iz * nx + ix;
    };
    const grid = new Float64Array(nx * nz);
    const heightSum = new Float64Array(nx * nz);
    const heightW = new Float64Array(nx * nz);
    for (const t of scene.tris) {
        // (flat ground is everywhere: the targets are where the ramps / walls are; a big face counts as at most a cell)
        if (t.w <= 0 || t.n[1] > 0.97) continue;
        const cx = (t.a[0] + t.b[0] + t.c[0]) / 3;
        const cy = (t.a[1] + t.b[1] + t.c[1]) / 3;
        const cz = (t.a[2] + t.b[2] + t.c[2]) / 3;
        const k = index(cx, cz);
        if (k < 0) continue;
        grid[k]! += t.w * Math.min(t.area, cell * cell);
        heightSum[k]! += cy * t.area;
        heightW[k]! += t.area;
    }
    // (a rail point weighs half a cell of ramp)
    for (const rail of scene.rails) {
        const k = index(rail[0], rail[2]);
        if (k >= 0) grid[k]! += 0.5 * cell * cell;
    }
    const blur = new Float64Array(nx * nz);
    const r = 2;
    for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++) {
            let s = 0;
            for (let dz = -r; dz <= r; dz++)
                for (let dx = -r; dx <= r; dx++) {
                    const xx = x + dx;
                    const zz = z + dz;
                    if (xx >= 0 && zz >= 0 && xx < nx && zz < nz) s += grid[zz * nx + xx]!;
                }
            blur[z * nx + x] = s;
        }
    const order = [...blur.keys()]
        .filter((k) => blur[k]! > 0 && heightW[k]! > 0)
        .sort((a, b) => blur[b]! - blur[a]! || a - b);
    const out: V3[] = [];
    for (const k of order) {
        const x = lo[0] + ((k % nx) + 0.5) * cell;
        const z = lo[2] + (Math.floor(k / nx) + 0.5) * cell;
        if (out.some((p) => Math.hypot(p[0] - x, p[2] - z) < ext * apart)) continue;
        out.push([Math.round(x), Math.round(heightSum[k]! / heightW[k]!), Math.round(z)]);
        if (out.length >= count) break;
    }
    return out;
}

// --- candidates ---------------------------------------------------------------------------------------------------

export interface Candidate {
    id: number;
    pose: Pose;
    target: V3;
    score: Score;
    ground: number | null; // the ground under the camera (y), where the skater is put out of the picture
}

export const HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315];
export const PITCHES = [32, 42, 52];
export const DISTANCES = [0.16, 0.26, 0.4];

// Every pose around every target, scored; the best `count` kept apart (another target, or a heading 60+ degrees
// away from every kept pose of the same target).
export function candidates(scene: Scene, count = 6, targetCount = 6): Candidate[] {
    const size = scene.playSize();
    const targets = pickTargets(scene, targetCount);
    const all: Omit<Candidate, "id">[] = [];
    for (const target of targets) {
        // indoors (a ceiling over the target - Airport's terminal): the camera also just under it
        const roofCol = scene.cast([target[0], target[1] + 20, target[2]], [0, 1, 0], 1e6);
        const roofDrawn = scene.drawn ? scene.drawn.cast([target[0], target[1] + 20, target[2]], [0, 1, 0], 1e6) : null;
        const up = roofCol && roofDrawn ? (roofCol.t < roofDrawn.t ? roofCol : roofDrawn) : (roofCol ?? roofDrawn);
        for (const heading of HEADINGS)
            for (const pitch of PITCHES) {
                const ds = DISTANCES.map((share) => Math.min(8000, Math.max(500, size * share)));
                if (up !== null) {
                    const under = (0.8 * up.t) / Math.sin((pitch * Math.PI) / 180);
                    ds.push(Math.max(200, under), Math.max(150, under * 0.6));
                }
                for (const d of ds) {
                    const f = forward(heading, pitch);
                    const pos: V3 = [
                        Math.round(target[0] - f[0] * d),
                        Math.round(target[1] - f[1] * d),
                        Math.round(target[2] - f[2] * d),
                    ];
                    const pose = { pos, heading, pitch };
                    const score = scorePose(scene, pose, target, size, 32, 18);
                    const down = scene.cast(pos, [0, -1, 0], 1e6);
                    all.push({ pose, target, score, ground: down ? Math.round(pos[1] - down.t) : null });
                }
            }
    }
    all.sort((a, b) => b.score.score - a.score.score);
    // (the short list re-scored finer before the final choice)
    const short = all.slice(0, Math.max(count * 8, 40)).map((c) => ({
        ...c,
        score: scorePose(scene, c.pose, c.target, size),
    }));
    short.sort((a, b) => b.score.score - a.score.score);
    const kept: Omit<Candidate, "id">[] = [];
    for (const c of short) {
        const clash = kept.some((k) => {
            if (k.target !== c.target) return false;
            const dh = Math.abs(((k.pose.heading - c.pose.heading + 540) % 360) - 180);
            return dh < 60;
        });
        if (clash) continue;
        kept.push(c);
        if (kept.length >= count) break;
    }
    return kept.map((c, id) => ({ id, ...c }));
}

// --- the spots file -----------------------------------------------------------------------------------------------

// scenic_art/<game>.json: per level its candidates and (after looking at the pictures) the chosen one and why.
export interface LevelSpots {
    // The level select's load script, when it isn't load_<key> (THPS4's skate shop is Load_practice), and the name the
    // game is started with (-level) when it isn't the key (THUG2's SkateShopLevel is the "mainmenu" scene).
    load?: string;
    start?: string;
    candidates: Candidate[];
    chosen?: number;
    why?: string;
}
export interface SpotsFile {
    game: string;
    note?: string;
    levels: Record<string, LevelSpots>;
}

export function readSpots(file: string): SpotsFile {
    return JSON.parse(fs.readFileSync(file, "utf-8").replace(/^﻿/, "")) as SpotsFile;
}

// The drawn scene's solid-looking faces (see-through materials - glass, additive effects - and billboards left out).
// A big scene (THP8's zones: millions of faces) keeps only the faces that can hide anything: long or large ones (a
// girder's pieces count, a bolt's do not); small scenes are kept whole. (Streamed: no per-face records for the rest.)
export function trisFromScene(scn: thug2Scene.Scene): Tri[] {
    const seeThrough = new Map(scn.materials.map((m) => [m.checksum, materialSeeThrough(m, "blend")]));
    let total = 0;
    for (const sector of scn.sectors) for (const mesh of sector.meshes) total += mesh.strips[0]?.length ?? 0;
    const big = total > BIG_SCENE;
    const out: Tri[] = [];
    for (const sector of scn.sectors) {
        if (sector.flags & thug2Scene.SEC_BILLBOARD) continue;
        for (const mesh of sector.meshes) {
            const buffer = mesh.buffers[0]?.[1];
            const strip = mesh.strips[0] ?? [];
            if (buffer === undefined || mesh.stride < 12 || seeThrough.get(mesh.material) === true) continue;
            const at = (i: number): V3 | null =>
                (i + 1) * mesh.stride > buffer.length
                    ? null
                    : [
                          buffer.readFloatLE(i * mesh.stride),
                          buffer.readFloatLE(i * mesh.stride + 4),
                          buffer.readFloatLE(i * mesh.stride + 8),
                      ];
            for (let j = 2; j < strip.length; j++) {
                const ia = strip[j - 2]!;
                const ib = strip[j - 1]!;
                const ic = strip[j]!;
                if (ia === ib || ib === ic || ia === ic) continue;
                const pa = at(ia);
                const pb = at(ib);
                const pc = at(ic);
                if (!pa || !pb || !pc) continue;
                const n = cross(sub(pb, pa), sub(pc, pa));
                const l = len(n);
                if (!(l > 1e-6)) continue;
                if (big && l < 300 && Math.max(len(sub(pb, pa)), len(sub(pc, pb)), len(sub(pa, pc))) < 60) continue;
                out.push({ a: pa, b: pb, c: pc, n: [n[0] / l, n[1] / l, n[2] / l], w: 0, area: l / 2 });
            }
        }
    }
    return out;
}
const BIG_SCENE = 300000;

export function levelScene(staging: string, level: string): Scene {
    const file = path.join(staging, "levels", level, `${level}.col.xbx`);
    const scene = new Scene(trisFromCol(thug2Col.readCol(fs.readFileSync(file), file)));
    // the drawn scene, for what is drawn but not solid
    const scnFile = path.join(staging, "levels", level, `${level}.scn.xbx`);
    if (fs.existsSync(scnFile)) {
        const tris = trisFromScene(thug2Scene.readScene(fs.readFileSync(scnFile), level));
        if (tris.length)
            scene.drawn = new Scene(tris, Math.min(400, Math.max(96, Math.round(Math.sqrt(tris.length / 6)))));
    }
    // the play area and the rails from the level's nodes (RailNode, Restart)
    const qbFile = path.join(staging, "levels", level, `${level}.qb`);
    if (fs.existsSync(qbFile)) {
        const [array] = nodeArray(fs.readFileSync(qbFile), qbFile);
        const play: V3[] = [];
        const rails: V3[] = [];
        for (const node of array) {
            if (!(node instanceof Struct)) continue;
            const isRail = isName(node.get("Class"), "RailNode");
            if (!isRail && !isName(node.get("Class"), "Restart")) continue;
            const p = position(node);
            if (p === null) continue;
            const v: V3 = [p[0]!, p[1]!, p[2]!];
            play.push(v);
            if (isRail) rails.push(v);
        }
        scene.setPlay(play, rails);
    }
    return scene;
}

// The automation commands that put the camera at a candidate (game/front/test_view.h's `camera`: position + view
// direction) - and the skater on the ground under it, out of the picture.
export function cameraCommands(c: Candidate): string[] {
    const f = forward(c.pose.heading, c.pose.pitch);
    const [x, y, z] = c.pose.pos;
    const out: string[] = [];
    if (c.ground !== null) out.push(`teleport ${x} ${c.ground + 5} ${z}`);
    out.push(`camera ${x} ${y} ${z} ${f.map((v) => v.toFixed(5)).join(" ")}`);
    return out;
}

const USAGE = "usage: scenic_spots.ts <staging folder> <level>... [--count N] [--out spots.json] [--game NAME]";

function main(): number {
    const { values, positionals } = parseCli(USAGE, {
        options: { count: { type: "string", default: "6" }, out: { type: "string" }, game: { type: "string" } },
        allowPositionals: true,
    });
    if (positionals.length < 2) {
        print(USAGE);
        return 2;
    }
    const [staging, ...levels] = positionals as [string, ...string[]];
    const file = values.out;
    const spots: SpotsFile =
        file && fs.existsSync(file) ? readSpots(file) : { game: values.game ?? path.basename(staging), levels: {} };
    for (const level of levels) {
        const started = Date.now();
        const scene = levelScene(staging, level);
        const list = candidates(scene, Number(values.count));
        print(
            `${level}: ${scene.tris.length} faces, ${list.length} candidates (${((Date.now() - started) / 1000).toFixed(1)} s)`,
        );
        for (const c of list)
            print(
                `  #${c.id} score ${c.score.score} pos ${c.pose.pos.join(",")} heading ${c.pose.heading} pitch ${c.pose.pitch} ` +
                    `interest ${c.score.interest} spread ${c.score.spread} sky ${c.score.sky} void ${c.score.void} back ${c.score.back}`,
            );
        const old = spots.levels[level];
        spots.levels[level] = {
            ...(old?.load !== undefined ? { load: old.load } : {}),
            ...(old?.start !== undefined ? { start: old.start } : {}),
            candidates: list,
            ...(old?.chosen !== undefined ? { chosen: old.chosen, why: old.why } : {}),
        };
    }
    if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(spots, null, 1)}\n`);
    }
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
