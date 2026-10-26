// NOT ORIGINAL - offline audit of a converted level's collision for holes in the floor: slits of missing ground between
// two pieces of floor at about one height, narrow enough to roll over, where the skater's downward ray (the uber frig's:
// no collision within uber_frig_current_height under him - put back, velocity negated; src/game/skater/
// collision_events.h, "paths=no-ground") finds nothing although floor lies on both sides. The user met one in BEAVER
// VALLEY's skatepark bowl (2026-10-25): the bowl's round floor, a Havok cylinder, was
// an inscribed 8-sided prism, 26 inches short of the bowl mesh at every flat.
//
//   node tools/pipeline/thp8_levels/hole_audit.ts [levels... | file.col.xbx ...] [--staging DIR] [--top N] [--json]
//
// Levels are THP8 level names (thp8_net_beavervalley, net_beavervalley, beavervalley; default every thp8_ level in the
// staging folder); a path ending .col.xbx is read as it is (any game's converted level). Ground: collidable faces
// (not 0x10 / 0x40) facing up (normal y >= GROUND_NORMAL). Each ground face's open edges (no other ground face has the
// same two corners, to within WELD inches) are walked every STEP inches; from each point, probes go out across the edge
// (in x / z, away from the face) at 2, 4, 8, ... inches: the first probe with ground within [h - DROP, h + STEP_UP] of
// the edge's height h ends the walk - if it was the first probe (2 in) the floor goes on (a seam), if a later one and
// that ground is within LEVEL inches of h it is a hole of that width (up to MAX_WIDTH); no ground up to MAX_WIDTH is a
// floor edge (edge_audit's business), and a wall (a collidable steep face across the probe line between h and
// h + WALL_TALL) ends it as no hole. Hole points within LINK inches of each other are one hole.

import * as fs from "node:fs";
import * as path from "node:path";
import * as thug2Col from "../level_port/thug2_col.ts";
import { parseCli } from "../lib/cli.ts";
import { isMain, print, runMain } from "../lib/py.ts";

export const GROUND_NORMAL = 0.7;
export const WELD = 0.25; // inches: corners this close are the same corner
export const STEP = 6; // inches between the points walked along an open edge
export const FIRST = 2; // inches: ground this close across the edge = the floor goes on
export const MAX_WIDTH = 48; // inches: a gap wider than this is a floor edge, not a hole
export const DROP = 120; // inches below the edge still counted as ground under the skater (about uber_frig_current_height)
export const STEP_UP = 30;
export const LEVEL = 12; // inches: the ground beyond is about as high as the edge (one floor, not a ledge below)
export const WALL_TALL = 60;
export const LINK = 18; // inches: hole points this close are one hole
export const MIN_POINTS = 2; // a hole is at least this many points (about a foot long)
const CELL = 48; // the spatial index's cell (inches)

type V = readonly number[];

interface Tri {
    a: V;
    b: V;
    c: V;
    ground: boolean;
    y0: number;
    y1: number;
}

export interface Hole {
    points: number;
    at: [number, number, number]; // its middle (inches)
    lengthIn: number;
    widthIn: number; // the widest gap across it
    box: [number, number, number, number]; // x0, z0, x1, z1
    object: number; // the collision object of the edge (index), the first point's
    covered: boolean; // ground (any face facing up) over the hole higher up: a roof - gapFills sees no void there
    below: number | null; // inches down to the nearest ground under the hole's middle point (null: none)
}

export interface HoleAudit {
    groundFaces: number;
    openEdges: number;
    holes: Hole[];
}

// The height of triangle t at (x, z), or null when (x, z) is outside it (by more than `eps` inches) or t is edge-on.
export function heightAt(t: { a: V; b: V; c: V }, x: number, z: number, eps = 0.01): number | null {
    const d = (t.b[0]! - t.a[0]!) * (t.c[2]! - t.a[2]!) - (t.c[0]! - t.a[0]!) * (t.b[2]! - t.a[2]!);
    if (Math.abs(d) < 1e-6) return null;
    // signed distances (inches) from each edge's line, positive inside
    const side = (p: V, q: V): number => {
        const ex = q[0]! - p[0]!;
        const ez = q[2]! - p[2]!;
        const len = Math.hypot(ex, ez) || 1;
        return (Math.sign(d) * (ex * (z - p[2]!) - ez * (x - p[0]!))) / len;
    };
    if (side(t.a, t.b) < -eps || side(t.b, t.c) < -eps || side(t.c, t.a) < -eps) return null;
    const u = ((x - t.a[0]!) * (t.c[2]! - t.a[2]!) - (t.c[0]! - t.a[0]!) * (z - t.a[2]!)) / d;
    const v = ((t.b[0]! - t.a[0]!) * (z - t.a[2]!) - (x - t.a[0]!) * (t.b[2]! - t.a[2]!)) / d;
    return t.a[1]! + u * (t.b[1]! - t.a[1]!) + v * (t.c[1]! - t.a[1]!);
}

const cellKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

export function holeAudit(file: thug2Col.ColFile): HoleAudit {
    const tris: Tri[] = [];
    const objectOf: number[] = [];
    const index = new Map<number, number[]>();
    file.objects.forEach((o, k) => {
        for (const f of o.faces) {
            if (f[0] & (thug2Col.FACE_NON_COLLIDABLE | thug2Col.FACE_TRIGGER)) continue;
            const a = o.verts[f[2]]!;
            const b = o.verts[f[3]]!;
            const c = o.verts[f[4]]!;
            const u = [0, 1, 2].map((i) => b[i]! - a[i]!);
            const v = [0, 1, 2].map((i) => c[i]! - a[i]!);
            const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
            const len = Math.hypot(n[0]!, n[1]!, n[2]!);
            if (!len) continue;
            const t: Tri = {
                a,
                b,
                c,
                ground: n[1]! / len >= GROUND_NORMAL,
                y0: Math.min(a[1]!, b[1]!, c[1]!),
                y1: Math.max(a[1]!, b[1]!, c[1]!),
            };
            const id = tris.length;
            tris.push(t);
            objectOf.push(k);
            const xs = [a[0]!, b[0]!, c[0]!];
            const zs = [a[2]!, b[2]!, c[2]!];
            for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
                for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
                    const key = cellKey(cx, cz);
                    const list = index.get(key);
                    if (list) list.push(id);
                    else index.set(key, [id]);
                }
            }
        }
    });
    const near = (x: number, z: number): number[] =>
        index.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
    const groundNear = (x: number, z: number, lo: number, hi: number): number | null => {
        // the highest ground at (x, z) within [lo, hi]
        let best: number | null = null;
        for (const id of near(x, z)) {
            const t = tris[id]!;
            if (!t.ground || t.y1 < lo || t.y0 > hi) continue;
            const y = heightAt(t, x, z);
            if (y !== null && y >= lo && y <= hi && (best === null || y > best)) best = y;
        }
        return best;
    };
    // a wall across the segment p -> q (x / z) reaching over h .. h + WALL_TALL
    const wallAcross = (px: number, pz: number, qx: number, qz: number, h: number): boolean => {
        const seen = new Set<number>();
        for (const [x, z] of [
            [px, pz],
            [qx, qz],
        ] as const) {
            for (const id of near(x, z)) {
                if (seen.has(id)) continue;
                seen.add(id);
                const t = tris[id]!;
                if (t.ground || t.y1 < h + 1 || t.y0 > h + WALL_TALL) continue;
                const pts = [t.a, t.b, t.c];
                for (let i = 0; i < 3; i++) {
                    const s = pts[i]!;
                    const e = pts[(i + 1) % 3]!;
                    if (segmentsCross(px, pz, qx, qz, s[0]!, s[2]!, e[0]!, e[2]!)) return true;
                }
            }
        }
        return false;
    };
    // open edges of ground faces
    const q = (v: V): string => v.map((c) => Math.round(c / WELD)).join(",");
    const edgeCount = new Map<string, number>();
    const edgeKey = (p: V, r: V): string => {
        const a = q(p);
        const b = q(r);
        return a < b ? `${a}|${b}` : `${b}|${a}`;
    };
    let groundFaces = 0;
    for (const t of tris) {
        if (!t.ground) continue;
        groundFaces++;
        for (const [p, r] of [
            [t.a, t.b],
            [t.b, t.c],
            [t.c, t.a],
        ] as const) {
            const k = edgeKey(p, r);
            edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
        }
    }
    const found: { x: number; y: number; z: number; w: number; object: number }[] = [];
    // (the highest / nearest-below ground at a hole point, any height)
    const groundAny = (x: number, z: number, lo: number, hi: number): number[] => {
        const ys: number[] = [];
        for (const id of near(x, z)) {
            const t = tris[id]!;
            if (!t.ground || t.y1 < lo || t.y0 > hi) continue;
            const y = heightAt(t, x, z);
            if (y !== null && y >= lo && y <= hi) ys.push(y);
        }
        return ys;
    };
    let openEdges = 0;
    tris.forEach((t, id) => {
        if (!t.ground) return;
        const mid = [0, 2].map((i) => (t.a[i]! + t.b[i]! + t.c[i]!) / 3);
        for (const [p, r] of [
            [t.a, t.b],
            [t.b, t.c],
            [t.c, t.a],
        ] as const) {
            if (edgeCount.get(edgeKey(p, r))! > 1) continue;
            const ex = r[0]! - p[0]!;
            const ez = r[2]! - p[2]!;
            const len = Math.hypot(ex, ez);
            if (len < 1) continue;
            openEdges++;
            // outward across the edge (away from the face's middle)
            let nx = ez / len;
            let nz = -ex / len;
            if (nx * (mid[0]! - p[0]!) + nz * (mid[1]! - p[2]!) > 0) {
                nx = -nx;
                nz = -nz;
            }
            const steps = Math.max(1, Math.floor(len / STEP));
            for (let s = 0; s <= steps; s++) {
                const f = (s + 0.5) / (steps + 1);
                const x = p[0]! + ex * f;
                const z = p[2]! + ez * f;
                const h = p[1]! + (r[1]! - p[1]!) * f;
                for (let d = FIRST; d <= MAX_WIDTH; d *= 2) {
                    const px = x + nx * d;
                    const pz = z + nz * d;
                    const g = groundNear(px, pz, h - DROP, h + STEP_UP);
                    if (g === null) continue;
                    if (d === FIRST) break; // the floor goes on
                    if (wallAcross(x, z, px, pz, Math.min(h, g))) break;
                    if (Math.abs(g - h) <= LEVEL) {
                        // (the width: the first ground across, to the inch)
                        let w = d / 2;
                        while (w < d && groundNear(x + nx * w, z + nz * w, h - DROP, h + STEP_UP) === null) w++;
                        found.push({ x: x + nx * (w / 2), y: h, z: z + nz * (w / 2), w, object: objectOf[id]! });
                    }
                    break;
                }
            }
        }
    });
    // cluster
    const holes: Hole[] = [];
    const grid = new Map<number, number[]>();
    found.forEach((p, i) => {
        const k = cellKey(Math.floor(p.x / LINK), Math.floor(p.z / LINK));
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
    });
    const seen = new Set<number>();
    for (let i = 0; i < found.length; i++) {
        if (seen.has(i)) continue;
        seen.add(i);
        const members = [i];
        const stack = [i];
        while (stack.length) {
            const m = found[stack.pop()!]!;
            const cx = Math.floor(m.x / LINK);
            const cz = Math.floor(m.z / LINK);
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    for (const j of grid.get(cellKey(cx + dx, cz + dz)) ?? []) {
                        const o = found[j]!;
                        if (seen.has(j) || Math.hypot(o.x - m.x, o.z - m.z) > LINK || Math.abs(o.y - m.y) > LEVEL)
                            continue;
                        seen.add(j);
                        members.push(j);
                        stack.push(j);
                    }
                }
            }
        }
        if (members.length < MIN_POINTS) continue;
        const ps = members.map((j) => found[j]!);
        const avg = (f: (p: (typeof ps)[number]) => number): number => ps.reduce((s, p) => s + f(p), 0) / ps.length;
        holes.push({
            points: ps.length,
            at: [avg((p) => p.x), avg((p) => p.y), avg((p) => p.z)],
            lengthIn: ps.length * STEP,
            widthIn: Math.max(...ps.map((p) => p.w)),
            box: [
                Math.min(...ps.map((p) => p.x)),
                Math.min(...ps.map((p) => p.z)),
                Math.max(...ps.map((p) => p.x)),
                Math.max(...ps.map((p) => p.z)),
            ],
            object: ps[0]!.object,
            covered: ps.some((p) => groundAny(p.x, p.z, p.y + STEP_UP, Infinity).length > 0),
            below: ((): number | null => {
                const m = ps[Math.floor(ps.length / 2)]!;
                const ys = groundAny(m.x, m.z, -Infinity, m.y - DROP);
                return ys.length ? m.y - Math.max(...ys) : null;
            })(),
        });
    }
    holes.sort((a, b) => b.lengthIn * b.widthIn - a.lengthIn * a.widthIn);
    return { groundFaces, openEdges, holes };
}

function segmentsCross(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    cx: number,
    cz: number,
    dx: number,
    dz: number,
): boolean {
    const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number =>
        (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
    const d1 = o(cx, cz, dx, dz, ax, az);
    const d2 = o(cx, cz, dx, dz, bx, bz);
    const d3 = o(ax, az, bx, bz, cx, cz);
    const d4 = o(ax, az, bx, bz, dx, dz);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const USAGE = "usage: hole_audit.ts [levels... | file.col.xbx ...] [--staging DIR] [--top N] [--json]";

export function main(argv: readonly string[] = process.argv.slice(2)): number {
    const { values, positionals } = parseCli(USAGE, {
        args: [...argv],
        allowPositionals: true,
        options: { staging: { type: "string" }, top: { type: "string" }, json: { type: "boolean" } },
    });
    const staging = values.staging ?? "C:\\Games\\THUG2-4\\thug2-decomp-thp8";
    const levelsDir = path.join(staging, "levels");
    const files: [string, string][] = [];
    if (positionals.length) {
        for (const p of positionals) {
            if (p.toLowerCase().endsWith(".col.xbx")) files.push([path.basename(p, ".col.xbx"), p]);
            else {
                const level = p.startsWith("thp8_") ? p : p.startsWith("net_") ? `thp8_${p}` : `thp8_net_${p}`;
                files.push([level, path.join(levelsDir, level, `${level}.col.xbx`)]);
            }
        }
    } else {
        for (const d of fs
            .readdirSync(levelsDir)
            .filter((d) => d.startsWith("thp8_") && d !== "thp8_sky")
            .sort())
            files.push([d, path.join(levelsDir, d, `${d}.col.xbx`)]);
    }
    const top = Number(values.top ?? 10);
    const out: Record<string, HoleAudit> = {};
    for (const [level, file] of files) {
        if (!fs.existsSync(file)) {
            print(`${level}: no ${file}`);
            continue;
        }
        const a = holeAudit(thug2Col.readCol(fs.readFileSync(file), level));
        out[level] = a;
        if (values.json) continue;
        const area = a.holes.reduce((s, h) => s + h.lengthIn * h.widthIn, 0) / (39.37 * 39.37);
        print(
            `${level}: ${a.holes.length} holes in the floor (${area.toFixed(1)} m2; ${a.holes.filter((h) => h.covered).length} under cover); ${a.groundFaces} ground faces, ` +
                `${a.openEdges} open edges`,
        );
        for (const h of a.holes.slice(0, top))
            print(
                `    hole ${h.lengthIn} x ${h.widthIn} in at ${h.at.map((v) => v.toFixed(0)).join(",")} ` +
                    `(x ${h.box[0].toFixed(0)}..${h.box[2].toFixed(0)}, z ${h.box[1].toFixed(0)}..${h.box[3].toFixed(0)}; object ${h.object}` +
                    `${h.covered ? "; under cover" : ""}; ${h.below === null ? "nothing below" : `ground ${h.below.toFixed(0)} in below`})`,
            );
    }
    if (values.json) print(JSON.stringify(out, null, 1));
    return 0;
}

if (isMain(import.meta.url)) runMain(main);
