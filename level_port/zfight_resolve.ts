// NOT ORIGINAL - resolves z-fighting in a converted level's scene (any port) by what each pair of coplanar surfaces
// is, before the game ever draws it - step 1 of the plan to end z-fighting in ported levels (step 0: the detector,
// zfight_raster.ts; step 2: a NOT ORIGINAL slope-scaled depth bias for what is left here).
//
//     node tools/pipeline/level_port/zfight_resolve.ts <levels folder> [<level> ...] [--out FOLDER] [--dry-run] [--quiet]
//
// The converters call resolveLevelFolder() on each level they write, after its qb (common.resolveZFight): the scene
// file (<level>.scn.xbx) is read, changed and written again; collision (.col.xbx), textures and scripts are never
// touched. --out writes the changed scene into another levels folder instead (with the level's qb and collision
// copied, so zfight_raster.ts can measure it there).
//
// What is looked at: the triangles of every mesh the game draws at start in world space (zfight_raster's rules:
// LevelGeometry without CreatedAtStart, LevelObject / GameObject sectors, billboards and skinned sectors are left
// out). Two triangles of different meshes - or of one mesh - that lie in one plane (normals within ~2.6 degrees,
// within kPlaneTolerance inches of each other over their overlap) and overlap by more than kMinOverlap square
// inches are a pair. Bit-identical copies facing the same way are not (the hardware draws them at identical depths -
// zfight_raster's rule), nor are a card's two sides in one material.
//
// Classes and what is done:
// - states (two sectors the level's scripts show and hide apart - script_toggles.ts: neither is there whenever the
//   other is; THPS3 Foundry's ValveC_Panel_Red / _OFF, THPS4's PROSET sets): left alone, most likely never drawn
//   together.
// - opposite (the two face opposite ways): each side seen from behind fights the other's front. The overlapping
//   triangles of a two-sided mesh go into a one-sided copy of their material (singleSided 1, noBackfaceCulling 0 - its
//   own checksum): seen from either side, only the side facing the camera is drawn (a glass pane made of two panes
//   facing away from each other, a crate's bottom on the floor). A card's other side in the same material goes with
//   it (or the two sides, now of two materials, would fight).
// - duplicate / self (both opaque, or both of one see-through material: the same look - one material, or the same
//   pass-0 texture): the hidden copy is cut away - the triangles of the one later in the cutting order (the meshes the
//   scripts never touch first, then by area; in one mesh, by triangle area) that lie under the other are dropped, or
//   cut by polygon subtraction in their plane and re-triangulated where only part is covered, exactly along the
//   cover's edges (new vertices interpolated: uv, colour, normal). A triangle is cut only under one before it in the
//   order, or under a later one that is locked from then on - no loop of cuts can take a surface away everywhere. The
//   cover must be there whenever the copy is (never hidden by the scripts, hidden and shown with it, or in its own
//   sector) and, for another material, opaque without cut-out texels. Bit-identical copies of the copy (one
//   material) are cut alike, or not at all - cut apart, they would fight each other.
// - overlap (both opaque, other looks): the one more of whose surface lies on the other is a detail on it (a sign on
//   a wall): the base under it is cut away the same way, when the detail can cover; else (cut-outs, toggled, too many
//   pieces) the detail gets a z bias above the base, as a layer.
// - layer (a see-through layer - blended, or a decal without z writes - over an opaque surface; of two see-through
//   ones, the detail): the layer must be drawn after its base and win the depth test. Drawn before it (and neither
//   depth-sorted): its material's draw order is put after the base's. Then its material gets a z bias one above the
//   base's (THUG2's own way for its decals: a constant depth bias, pc_material.cpp), and the smaller of the two is put
//   on the other's plane where it lies on the wrong side (the layer behind its base, or the base in front of its
//   layer) - exact for a layer on its base at any distance. Depth-sorted layers over each other, a bias that would pass
//   16, a loop of biases or draw orders: left as they are, counted as `pending` - for step 2's slope-scaled bias.
// Merging a layer into its base's material as another pass, as planned, isn't done: where the layer's triangles
// coincide with the base's, the snap makes them copies drawn at the same depths, with the layer's bias on top - the
// same look as a pass in one draw call, without another vertex layout or pixel shader.
//
// Deterministic: the same input gives the same output (no random choice, no hash order).

import * as fs from "node:fs";
import * as path from "node:path";
import { parseCli } from "../lib/cli.ts";
import { isMain, print, pyExit, runMain } from "../lib/py.ts";
import { emptyToggles, levelToggles, named, type Toggles, thereWhenever } from "./script_toggles.ts";
import * as tex from "./tex.ts";
import { texels } from "./texture_check.ts";
import * as thug2Scene from "./thug2_scene.ts";
import { buildRasterScene, hiddenSectors, type RasterScene } from "./zfight_raster.ts";

type Vec = [number, number, number];
type P2 = [number, number];

export const kPlaneTolerance = 2.0; // inches: surfaces this close over their overlap count as one plane (they fight
// from ~250 m - zfight.ts' fightDistance with THUG2's near plane of 2)
export const kMinNormalDot = 0.999; // |cos| between the planes (~2.6 degrees)
export const kMinOverlap = 0.25; // square inches of overlap below which a pair is left alone
export const kSeam = 0; // inches the cover is shrunk by before it is cut away (0: the pieces end exactly on its edges;
// any overlap left is a strip that fights - measured: 0.02 left ~1 pixel in 30 along every cut edge)
export const kMaxPieces = 256; // triangles a cut triangle may become (more: left whole)
export const kMaxZBias = 16; // the loader clamps the material's bias to 16 (pc_material_load.cpp)
const FINE_CELL = 128; // inches: the grid the triangles are bucketed in
const COARSE_CELL = 4096; // for triangles spanning more than FINE_SPAN fine cells along an axis
const FINE_SPAN = 16;

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mainAxis = (n: Vec): number => {
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
};
const otherAxes = (axis: number): [number, number] => (axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]);

// --- the scene's meshes and triangles -------------------------------------------------------------------------------

interface MeshRec {
    sector: number;
    mesh: number;
    sectorChecksum: number;
    material: thug2Scene.Material | undefined;
    draw: number; // index in the RasterScene's meshes (-1: not drawn)
    editable: boolean; // a plain FVF mesh this can rewrite
    stable: boolean; // its sector is always there (never shown or hidden by the level's scripts)
    seeThrough: boolean;
    twoSided: boolean;
    holes: boolean; // pass 0's texture has cut-out texels (alpha tested)
    texture: number;
    area: number;
    tris: number[]; // triangle ids
}

interface TriRec {
    id: number;
    m: number; // MeshRec index
    pos: number; // its place in the mesh's strip (the index of its last corner)
    v: [number, number, number]; // vertex indices, wound as drawn
    p: [Vec, Vec, Vec];
    n: Vec;
    d: number;
    area: number;
    lo: Vec;
    hi: Vec;
    axis: number;
}

function vertexPosition(mesh: thug2Scene.Mesh, i: number): Vec {
    const b = mesh.buffers[0]![1];
    const at = i * mesh.stride;
    return [b.readFloatLE(at), b.readFloatLE(at + 4), b.readFloatLE(at + 8)];
}

function editableMesh(mesh: thug2Scene.Mesh): boolean {
    // (a vertex shader word of 0..6 is a built-in - skinned - shader; anything else is a Direct3D FVF)
    return (
        mesh.buffers.length === 1 &&
        mesh.stride >= 12 &&
        mesh.vertexShader[0]! > 6 &&
        (mesh.vertexShader[0]! & thug2Scene.FVF_XYZ) !== 0 &&
        mesh.buffers[0]![1].length >= mesh.stride * mesh.vertexCount
    );
}

// --- what the level's files say -----------------------------------------------------------------------------------

// Textures with cut-out texels at the material's alpha cutoff (unknown kinds: assumed to have some).
export function cutOutTextures(textures: tex.TexFile | null, scene: thug2Scene.Scene): Set<number> {
    const out = new Set<number>();
    const byChecksum = new Map((textures?.textures ?? []).map((t) => [t.checksum, t]));
    const lowest = new Map<number, number>(); // texture -> the lowest cutoff a material tests it with
    for (const m of scene.materials) {
        const t = m.passes[0]?.texture ?? 0;
        if (!t || m.alphaCutoff <= 0) continue;
        lowest.set(t, Math.max(lowest.get(t) ?? 0, m.alphaCutoff));
    }
    for (const [checksum, cutoff] of [...lowest.entries()].sort((a, b) => a[0] - b[0])) {
        const t = byChecksum.get(checksum);
        const bgra = t ? texels(t) : null;
        if (!bgra) {
            out.add(checksum);
            continue;
        }
        for (let k = 3; k < bgra.length; k += 4) {
            if (bgra[k]! < cutoff) {
                out.add(checksum);
                break;
            }
        }
    }
    return out;
}

// --- 2D polygons in a triangle's plane ----------------------------------------------------------------------------

function area2(poly: readonly P2[]): number {
    let a = 0;
    for (let k = 0; k < poly.length; k++) {
        const p = poly[k]!;
        const q = poly[(k + 1) % poly.length]!;
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

// The part of a convex polygon on the left of a -> b (keep > 0) or on its right (keep < 0); `shift` moves the line
// that far to the left.
function clipHalf(poly: readonly P2[], a: P2, b: P2, keep: number, shift = 0): P2[] {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    const side = (p: P2): number => keep * ((ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / len - shift);
    const out: P2[] = [];
    for (let k = 0; k < poly.length; k++) {
        const p = poly[k]!;
        const q = poly[(k + 1) % poly.length]!;
        const sp = side(p);
        const sq = side(q);
        if (sp >= 0) out.push(p);
        if (sp >= 0 !== sq >= 0) {
            const f = sp / (sp - sq);
            out.push([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]);
        }
    }
    return out;
}

function ccw(poly: P2[]): P2[] {
    return area2(poly) < 0 ? [...poly].reverse() : poly;
}

// Counter-clockwise from its lowest corner: two bit-identical triangles (corners in any order) give bit-identical
// polygons, pieces and triangulations.
function canon(poly: P2[]): P2[] {
    const q = ccw(poly);
    let first = 0;
    for (let k = 1; k < q.length; k++) {
        const a = q[k]!;
        const b = q[first]!;
        if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) first = k;
    }
    return [...q.slice(first), ...q.slice(0, first)];
}

// A convex polygon shrunk by `by` (each edge moved inwards).
function shrink(poly: readonly P2[], by: number): P2[] {
    let out: P2[] = [...poly];
    for (let k = 0; k < poly.length && out.length >= 3; k++) {
        out = clipHalf(out, poly[k]!, poly[(k + 1) % poly.length]!, 1, by);
    }
    return out;
}

// What is left of convex `p` with convex `cover` taken out: convex pieces (both counter-clockwise).
function subtract(p: readonly P2[], cover: readonly P2[], minArea: number): P2[][] {
    const out: P2[][] = [];
    let rest: P2[] = [...p];
    for (let k = 0; k < cover.length && rest.length >= 3; k++) {
        const a = cover[k]!;
        const b = cover[(k + 1) % cover.length]!;
        const outside = clipHalf(rest, a, b, -1);
        if (outside.length >= 3 && Math.abs(area2(outside)) > minArea) out.push(outside);
        rest = clipHalf(rest, a, b, 1); // (what is left inside the cover: gone)
    }
    return out;
}

// --- the pairs ----------------------------------------------------------------------------------------------------

interface Pair {
    t: number;
    u: number;
    area: number; // square inches of overlap
    sep: number; // inches apart, the most over the overlap
    partial: boolean; // only part of their overlap within the tolerance (not cut: bias, or left)
    facing: number; // 1 same way, -1 opposite
    card?: boolean; // a card's two sides in one material: no fight, until one side is made one-sided
}

function projectTri(t: TriRec, axis: number): P2[] {
    const [i, j] = otherAxes(axis);
    return canon(t.p.map((p): P2 => [p[i]!, p[j]!]));
}

// A triangle's plane from its corners in a fixed order (the same for bit-identical copies): [normal, d].
function canonPlane(t: TriRec): [Vec, number] {
    const c = [...t.p].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const n = cross(sub(c[1]!, c[0]!), sub(c[2]!, c[0]!));
    return [n, dot(n, c[0]!)];
}

// The part of a convex polygon where a x + b y + c >= 0.
function clipLinear(poly: readonly P2[], a: number, b: number, c: number): P2[] {
    const out: P2[] = [];
    for (let k = 0; k < poly.length; k++) {
        const p = poly[k]!;
        const q = poly[(k + 1) % poly.length]!;
        const sp = a * p[0] + b * p[1] + c;
        const sq = a * q[0] + b * q[1] + c;
        if (sp >= 0) out.push(p);
        if (sp >= 0 !== sq >= 0) {
            const f = sp / (sp - sq);
            out.push([p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])]);
        }
    }
    return out;
}

// The overlap of two near-coplanar triangles (square inches, in t's plane) - the part where they are within the
// tolerance of each other (`partial`: not all of it; two surfaces meeting at a shallow angle) - and how far apart they
// are there (the most), or area 0.
function overlapArea(t: TriRec, u: TriRec): { area: number; sep: number; partial: boolean } {
    const none = { area: 0, sep: 0, partial: false };
    const axis = t.axis;
    const na = t.n[axis]!;
    const ua = u.n[axis]!;
    if (Math.abs(ua) < 1e-6) return none;
    let poly = projectTri(t, axis);
    const clip = projectTri(u, axis);
    for (let k = 0; k < clip.length && poly.length >= 3; k++) {
        poly = clipHalf(poly, clip[k]!, clip[(k + 1) % clip.length]!, 1);
    }
    if (poly.length < 3) return none;
    const full = Math.abs(area2(poly));
    // h(x, y) = (ht - hu) na, linear: kept where |h| <= the tolerance
    const [i, j] = otherAxes(axis);
    const ha = (-t.n[i]! / na + u.n[i]! / ua) * na;
    const hb = (-t.n[j]! / na + u.n[j]! / ua) * na;
    const hc = (t.d / na - u.d / ua) * na;
    poly = clipLinear(poly, -ha, -hb, kPlaneTolerance - hc);
    if (poly.length >= 3) poly = clipLinear(poly, ha, hb, kPlaneTolerance + hc);
    if (poly.length < 3) return none;
    const flat = Math.abs(area2(poly));
    let sep = 0;
    for (const [x, y] of poly) sep = Math.max(sep, Math.abs(ha * x + hb * y + hc));
    return { area: flat / Math.abs(na), sep, partial: flat < full * (1 - 1e-6) };
}

function exactCopy(t: TriRec, u: TriRec): boolean {
    return t.p.every((a) => u.p.some((b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]));
}

function findPairs(tris: readonly TriRec[], meshes: readonly MeshRec[], copies: [number, number][]): Pair[] {
    const fine = new Map<string, number[]>();
    const coarse = new Map<string, number[]>();
    const isCoarse = new Uint8Array(tris.length);
    const cellRange = (t: TriRec, size: number): [number[], number[]] => [
        [0, 1, 2].map((k) => Math.floor((t.lo[k]! - kPlaneTolerance) / size)),
        [0, 1, 2].map((k) => Math.floor((t.hi[k]! + kPlaneTolerance) / size)),
    ];
    const insert = (grid: Map<string, number[]>, t: TriRec, size: number): void => {
        const [lo, hi] = cellRange(t, size);
        for (let x = lo[0]!; x <= hi[0]!; x++)
            for (let y = lo[1]!; y <= hi[1]!; y++)
                for (let z = lo[2]!; z <= hi[2]!; z++) {
                    const key = `${x},${y},${z}`;
                    const list = grid.get(key);
                    if (list) list.push(t.id);
                    else grid.set(key, [t.id]);
                }
    };
    for (const t of tris) {
        const [lo, hi] = cellRange(t, FINE_CELL);
        if ([0, 1, 2].some((k) => hi[k]! - lo[k]! >= FINE_SPAN)) {
            isCoarse[t.id] = 1;
            insert(coarse, t, COARSE_CELL);
        } else insert(fine, t, FINE_CELL);
    }
    const seen = new Set<number>();
    const pairs: Pair[] = [];
    const N = tris.length;
    const consider = (a: number, b: number): void => {
        if (a === b) return;
        const t = tris[Math.min(a, b)]!;
        const u = tris[Math.max(a, b)]!;
        const key = t.id * N + u.id;
        if (seen.has(key)) return;
        if (
            t.lo[0] > u.hi[0] + kPlaneTolerance ||
            u.lo[0] > t.hi[0] + kPlaneTolerance ||
            t.lo[1] > u.hi[1] + kPlaneTolerance ||
            u.lo[1] > t.hi[1] + kPlaneTolerance ||
            t.lo[2] > u.hi[2] + kPlaneTolerance ||
            u.lo[2] > t.hi[2] + kPlaneTolerance
        )
            return;
        const c = dot(t.n, u.n);
        if (Math.abs(c) < kMinNormalDot) return;
        // (u's corners all on one side of t's plane, beyond the tolerance: apart)
        const du = u.p.map((p) => dot(t.n, p) - t.d);
        if (du.every((x) => x > kPlaneTolerance) || du.every((x) => x < -kPlaneTolerance)) return;
        seen.add(key);
        if (c > 0 && exactCopy(t, u)) {
            copies.push([t.id, u.id]);
            return;
        }
        const mt = meshes[t.m]!;
        const mu = meshes[u.m]!;
        const { area, sep, partial } = overlapArea(t, u);
        if (area < kMinOverlap) return;
        const pair: Pair = { t: t.id, u: u.id, area, sep, partial, facing: c > 0 ? 1 : -1 };
        if (c < 0 && mt.material === mu.material) pair.card = true;
        pairs.push(pair);
    };
    const within = (list: readonly number[]): void => {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) consider(list[i]!, list[j]!);
    };
    for (const key of [...fine.keys()].sort()) within(fine.get(key)!);
    for (const key of [...coarse.keys()].sort()) within(coarse.get(key)!);
    // fine against coarse
    for (const t of tris) {
        if (isCoarse[t.id]) continue;
        const [lo, hi] = cellRange(t, COARSE_CELL);
        for (let x = lo[0]!; x <= hi[0]!; x++)
            for (let y = lo[1]!; y <= hi[1]!; y++)
                for (let z = lo[2]!; z <= hi[2]!; z++) {
                    for (const o of coarse.get(`${x},${y},${z}`) ?? []) consider(t.id, o);
                }
    }
    pairs.sort((a, b) => b.area - a.area || a.t - b.t || a.u - b.u);
    return pairs;
}

// --- the draw order -------------------------------------------------------------------------------------------------

// Whether mesh `later` is always drawn after mesh `earlier` (zfight_raster's buckets: pass 0x55's opaque meshes, then
// pass 0x46's transparent ones before the depth-sorted ones, the depth-sorted ones, the rest).
const sortedPlaces = new WeakMap<RasterScene, Map<number, number>>();
function placeOf(rs: RasterScene, m: number): number {
    let at = sortedPlaces.get(rs);
    if (!at) {
        const place = new Map<number, number>();
        rs.sorted.forEach((x, i) => {
            place.set(x, i);
        });
        sortedPlaces.set(rs, place);
        at = place;
    }
    return at.get(m)!;
}
function drawBucket(rs: RasterScene, m: number): number {
    const i = placeOf(rs, m);
    return i < rs.firstTransparent
        ? 0
        : rs.flaggedCount === 0 || i < rs.firstFlagged
          ? 1
          : i < rs.firstFlagged + rs.flaggedCount
            ? 2
            : 3;
}
function drawnAfter(rs: RasterScene, later: number, earlier: number): boolean {
    const ba = drawBucket(rs, later);
    const bb = drawBucket(rs, earlier);
    if (ba !== bb) return ba > bb;
    if (ba === 2) return false; // (by depth: either way round)
    return placeOf(rs, later) > placeOf(rs, earlier);
}

// --- the result -----------------------------------------------------------------------------------------------------

export interface ResolveReport {
    pairs: number; // triangle pairs found
    meshPairs: Record<string, number>; // mesh pairs by class
    dropped: number; // triangles taken out whole
    cut: number; // triangles cut into pieces
    pieces: number; // triangles those became
    culled: number; // triangles moved into one-sided copies of their material
    oneSided: number; // materials made for them
    biased: number; // materials whose z bias was raised
    reordered: number; // materials whose draw order was raised
    snapped: number; // vertices moved onto the plane under them
    pending: Record<string, number>; // mesh pairs left for step 2, by why
    pendingMaterials: number[]; // the see-through materials those are (for step 2's flag)
}

function emptyReport(): ResolveReport {
    return {
        pairs: 0,
        meshPairs: {},
        dropped: 0,
        cut: 0,
        pieces: 0,
        culled: 0,
        oneSided: 0,
        biased: 0,
        reordered: 0,
        snapped: 0,
        pending: {},
        pendingMaterials: [],
    };
}

const bump = (r: Record<string, number>, k: string, n = 1): void => {
    r[k] = (r[k] ?? 0) + n;
};

export interface ResolveOptions {
    hidden?: ReadonlySet<number>; // sectors not drawn at start (zfight_raster.hiddenSectors)
    toggles?: Toggles; // what the level's scripts show and hide (script_toggles.ts)
    cutOut?: ReadonlySet<number>; // textures with cut-out texels (cutOutTextures)
    log?: string[]; // each mesh pair's decision, as text (--explain)
}

// A one-sided copy's checksum: the material's, mixed - not used by any material of the scene.
function freshChecksum(base: number, used: Set<number>): number {
    let c = (Math.imul(base ^ 0x5a17c0de, 0x9e3779b1) ^ 0x0e51ded) >>> 0;
    while (used.has(c) || c === 0) c = (Math.imul(c, 0x01000193) + 0x2f) >>> 0;
    used.add(c);
    return c;
}

// --- resolving ------------------------------------------------------------------------------------------------------

// Changes the scene in place; returns what was done.
export function resolveScene(scene: thug2Scene.Scene, o: ResolveOptions = {}): ResolveReport {
    const report = emptyReport();
    const hidden = o.hidden ?? new Set<number>();
    const toggles = o.toggles ?? emptyToggles();
    const cutOut = o.cutOut ?? new Set<number>();
    const rs = buildRasterScene(scene, { hidden });
    const drawIndex = new Map<string, number>();
    rs.meshes.forEach((m, i) => {
        drawIndex.set(`${m.sector}:${m.mesh}`, i);
    });
    const materialOf = new Map(scene.materials.map((m) => [m.checksum, m]));

    // the meshes and their triangles
    const meshes: MeshRec[] = [];
    const tris: TriRec[] = [];
    scene.sectors.forEach((sector, s) => {
        sector.meshes.forEach((mesh, k) => {
            const draw = drawIndex.get(`${s}:${k}`);
            if (draw === undefined) return;
            const dm = rs.meshes[draw]!;
            const material = materialOf.get(mesh.material);
            const rec: MeshRec = {
                sector: s,
                mesh: k,
                sectorChecksum: sector.checksum,
                material,
                draw,
                editable: editableMesh(mesh),
                stable: !named(toggles, sector.checksum),
                seeThrough: dm.seeThrough,
                twoSided: dm.twoSided,
                holes: cutOut.has(dm.texture),
                texture: dm.texture,
                area: 0,
                tris: [],
            };
            const mi = meshes.length;
            meshes.push(rec);
            const strip = mesh.strips[0] ?? [];
            const count = Math.min(mesh.vertexCount, Math.floor((mesh.buffers[0]?.[1].length ?? 0) / mesh.stride));
            for (let j = 2; j < strip.length; j++) {
                const a = strip[j - 2]!;
                const b = strip[j - 1]!;
                const c = strip[j]!;
                if (a === b || b === c || a === c || a >= count || b >= count || c >= count) continue;
                const v: [number, number, number] = j % 2 ? [b, a, c] : [a, b, c];
                const p = v.map((i) => vertexPosition(mesh, i)) as [Vec, Vec, Vec];
                const nn = cross(sub(p[1], p[0]), sub(p[2], p[0]));
                const len = Math.hypot(...nn);
                if (!(len > 1e-6)) continue;
                const n: Vec = [nn[0] / len, nn[1] / len, nn[2] / len];
                const t: TriRec = {
                    id: tris.length,
                    m: mi,
                    pos: j,
                    v,
                    p,
                    n,
                    d: dot(n, p[0]),
                    area: len / 2,
                    lo: [0, 1, 2].map((q) => Math.min(p[0][q]!, p[1][q]!, p[2][q]!)) as Vec,
                    hi: [0, 1, 2].map((q) => Math.max(p[0][q]!, p[1][q]!, p[2][q]!)) as Vec,
                    axis: mainAxis(n),
                };
                tris.push(t);
                rec.tris.push(t.id);
                rec.area += t.area;
            }
        });
    });

    const copies: [number, number][] = []; // bit-identical triangles facing one way
    const found = findPairs(tris, meshes, copies);
    const pairs = found.filter((p) => !p.card);
    const cards = found.filter((p) => p.card);
    report.pairs = pairs.length;

    // per mesh pair: how much of each lies on the other
    const meshPairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
    const coverOf = new Map<string, number>(); // `${m}>${other}` -> m's area over other
    for (const p of pairs) {
        const a = tris[p.t]!.m;
        const b = tris[p.u]!.m;
        coverOf.set(`${a}>${b}`, (coverOf.get(`${a}>${b}`) ?? 0) + p.area);
        if (a !== b) coverOf.set(`${b}>${a}`, (coverOf.get(`${b}>${a}`) ?? 0) + p.area);
    }
    const covered = (m: number, by: number): number => (coverOf.get(`${m}>${by}`) ?? 0) / (meshes[m]!.area || 1);

    const sameLook = (a: MeshRec, b: MeshRec): boolean =>
        a.material === b.material || (a.texture !== 0 && a.texture === b.texture);

    // decisions
    const cuts = new Map<number, number[]>(); // triangle -> the triangles covering it (to be cut away)
    const locked = new Uint8Array(tris.length); // keepers: never cut
    const overlapCuts = new Set<string>(); // `${base}:${detail}`: cuts under a detail of another look
    const cullTris = new Set<number>(); // into a one-sided copy
    const biasEdges: { over: number; under: number; pair: string; layer: number }[] = []; // material indices
    const orderEdges: { over: number; under: number; pair: string }[] = []; // material indices: drawn after
    // (which of two materials is on top: decided once, by the pair with the most overlap - each later pair of the two
    // goes the same way, or their biases would loop)
    const onTop = new Map<string, thug2Scene.Material>();
    const sameWay = (x: MeshRec, y: MeshRec, xOnTop: boolean): boolean => {
        if (!x.material || !y.material) return xOnTop;
        const k =
            materialIndex.get(x.material)! < materialIndex.get(y.material)!
                ? `${materialIndex.get(x.material)}:${materialIndex.get(y.material)}`
                : `${materialIndex.get(y.material)}:${materialIndex.get(x.material)}`;
        const known = onTop.get(k);
        if (known) return known === x.material;
        onTop.set(k, xOnTop ? x.material : y.material);
        return xOnTop;
    };
    const snaps: { t: number; plane: number; side: number }[] = []; // t's corners on the `side` of plane's: onto it
    // (the smaller of the two is moved: the top's corners behind the other's plane, or the under one's in front)
    const snapPair = (top: TriRec, under: TriRec): void => {
        const T = meshes[top.m]!;
        const U = meshes[under.m]!;
        if (T.area <= U.area ? T.editable : !U.editable) {
            if (T.editable) snaps.push({ t: top.id, plane: under.id, side: -1 });
        } else snaps.push({ t: under.id, plane: top.id, side: 1 });
    };
    const decided = new Map<string, string>(); // mesh pair -> class (counted once)
    const materialIndex = new Map(scene.materials.map((m, i) => [m, i]));
    const pendingMaterials = new Set<number>();
    const pend = (key: string, why: string, layer?: MeshRec): void => {
        const k = `${key}|pending`;
        if (!decided.has(k)) {
            decided.set(k, why);
            bump(report.pending, why);
            say(key, `pending - ${why}`);
        }
        if (layer?.material) pendingMaterials.add(layer.material.checksum);
    };
    const hex = (x: number): string => x.toString(16).toUpperCase().padStart(8, "0");
    const label = (m: number): string =>
        `${hex(meshes[m]!.sectorChecksum)}#${meshes[m]!.mesh} (mat ${hex(meshes[m]!.material?.checksum ?? 0)})`;
    const say = (key: string, what: string): void => {
        if (!o.log) return;
        const [a, b] = key.split(":").map(Number) as [number, number];
        o.log.push(`${label(a)} / ${label(b)}: ${what}`);
    };
    const count = (key: string, cls: string): void => {
        if (!decided.has(key)) {
            decided.set(key, cls);
            bump(report.meshPairs, cls);
            say(key, cls);
        }
    };
    // The cutting order: the meshes by area (the biggest first), in each its triangles by area. A triangle is cut only
    // under one before it - the first is never cut, so no loop of cuts can take a surface away everywhere -, or under
    // a later one that is then locked (never cut afterwards, and not cut before: the same holds).
    const rank = new Int32Array(tris.length);
    {
        // (the meshes the scripts never show or hide first: they can keep for any other)
        const meshOrder = meshes
            .map((_, i) => i)
            .sort(
                (a, b) =>
                    Number(!meshes[a]!.stable) - Number(!meshes[b]!.stable) ||
                    meshes[b]!.area - meshes[a]!.area ||
                    a - b,
            );
        const meshRank = new Int32Array(meshes.length);
        meshOrder.forEach((m, i) => {
            meshRank[m] = i;
        });
        tris.map((t) => t.id)
            .sort((a, b) => meshRank[tris[a]!.m]! - meshRank[tris[b]!.m]! || tris[b]!.area - tris[a]!.area || a - b)
            .forEach((t, i) => {
                rank[t] = i;
            });
    }
    const cut = (victim: number, keeper: number): boolean => {
        if (locked[victim]) return false;
        if (rank[keeper]! > rank[victim]!) {
            if (cuts.has(keeper)) return false;
            locked[keeper] = 1;
        }
        const list = cuts.get(victim);
        if (list) list.push(keeper);
        else cuts.set(victim, [keeper]);
        return true;
    };
    // (a keeper must be there whenever the other is: always, or in the same sector - shown and hidden with it)
    const there = (k: MeshRec, other: MeshRec): boolean =>
        k.sector === other.sector || thereWhenever(toggles, k.sectorChecksum, other.sectorChecksum);
    const canKeep = (k: MeshRec, other: MeshRec): boolean =>
        there(k, other) && (k.material === other.material || (!k.seeThrough && !k.holes));
    // Two of one look: the one later in the cutting order cut away under the other (or the other way round, when
    // only that can be).
    const cutCopy = (t: TriRec, u: TriRec, key: string): void => {
        let [keeper, victim] = rank[t.id]! < rank[u.id]! ? [t, u] : [u, t];
        const ok = (k: TriRec, v: TriRec): boolean => meshes[v.m]!.editable && canKeep(meshes[k.m]!, meshes[v.m]!);
        if (!ok(keeper, victim) && ok(victim, keeper)) [keeper, victim] = [victim, keeper];
        if (!ok(keeper, victim)) {
            const K = meshes[keeper.m]!;
            const V = meshes[victim.m]!;
            pend(
                key,
                !V.editable
                    ? "duplicate: mesh not editable"
                    : there(K, V)
                      ? "duplicate: cover has cut-outs"
                      : "duplicate: cover not always there",
            );
            return;
        }
        if (cut(victim.id, keeper.id)) return;
        if (ok(victim, keeper) && cut(keeper.id, victim.id)) return;
        pend(key, "duplicate: both locked");
    };

    for (const p of pairs) {
        const t = tris[p.t]!;
        const u = tris[p.u]!;
        const A = meshes[t.m]!;
        const B = meshes[u.m]!;
        const key = meshPairKey(t.m, u.m);
        if (!there(A, B) && !there(B, A)) {
            count(key, "states");
            continue;
        }
        if (p.facing < 0) {
            count(key, "opposite");
            // each two-sided side made one-sided where the other lies on it
            for (const [x, X] of [
                [t, A],
                [u, B],
            ] as const) {
                if (!X.twoSided) continue;
                if (!X.editable || !X.material) {
                    pend(key, "opposite: mesh not editable");
                    continue;
                }
                cullTris.add(x.id);
            }
            continue;
        }
        // (the source's own order between two biased materials kept: one raised for another pair must not catch up
        // with the other)
        if (A.material && B.material && A.material !== B.material && A.material.zBias !== B.material.zBias) {
            const [hi, lo] = A.material.zBias > B.material.zBias ? [A, B] : [B, A];
            biasEdges.push({
                over: materialIndex.get(hi.material!)!,
                under: materialIndex.get(lo.material!)!,
                pair: key,
                layer: hi === A ? t.m : u.m,
            });
        }
        if (!A.seeThrough && !B.seeThrough) {
            if (t.m === u.m || sameLook(A, B)) {
                count(key, t.m === u.m ? "self" : "duplicate");
                if (!p.partial) cutCopy(t, u, key);
                else if (A.material !== B.material && A.material && B.material) {
                    // (meeting at a shallow angle: not one surface to cut - the smaller biased over the other)
                    const [over, under] = A.area <= B.area ? [t, u] : [u, t];
                    biasEdges.push({
                        over: materialIndex.get(meshes[over.m]!.material!)!,
                        under: materialIndex.get(meshes[under.m]!.material!)!,
                        pair: key,
                        layer: over.m,
                    });
                } else pend(key, "duplicate: a crease in one material");
                continue;
            }
            count(key, "overlap");
            // the detail (biased higher by the source, else more of it covered) stays; the base under it is cut away
            const za = A.material?.zBias ?? 0;
            const zb = B.material?.zBias ?? 0;
            const detailT =
                za !== zb
                    ? za > zb
                    : covered(t.m, u.m) !== covered(u.m, t.m)
                      ? covered(t.m, u.m) > covered(u.m, t.m)
                      : t.m > u.m;
            const [detail, base] = sameWay(A, B, detailT) ? [t, u] : [u, t];
            const D = meshes[detail.m]!;
            const Bm = meshes[base.m]!;
            if (!p.partial && Bm.editable && canKeep(D, Bm) && cut(base.id, detail.id)) {
                overlapCuts.add(`${base.id}:${detail.id}`);
                continue;
            }
            // else: the detail biased over the base
            if (D.material && Bm.material) {
                biasEdges.push({
                    over: materialIndex.get(D.material)!,
                    under: materialIndex.get(Bm.material)!,
                    pair: key,
                    layer: detail.m,
                });
                snapPair(detail, base);
            } else pend(key, "overlap: no material");
            continue;
        }
        // a see-through layer: the one on top must be drawn after the other and win the depth test
        count(key, t.m === u.m ? "self" : "layer");
        if (t.m === u.m || A.material === B.material) {
            // (two triangles of one see-through mesh or material - the same look: cut as an opaque duplicate; the
            // pair drawn once, not blended twice where it overlaps)
            if (!p.partial) cutCopy(t, u, key);
            else pend(key, "layer: a crease in one material", A);
            continue;
        }
        // the see-through one over an opaque one; of two see-through ones the one the source biased higher, else the
        // one drawn later (at equal depths the later wins: the source's look), else the detail (more of it covered)
        let topT: boolean;
        const za = A.material?.zBias ?? 0;
        const zb = B.material?.zBias ?? 0;
        if (A.seeThrough !== B.seeThrough) topT = A.seeThrough;
        else if (za !== zb) topT = za > zb;
        else if (drawnAfter(rs, A.draw, B.draw)) topT = true;
        else if (drawnAfter(rs, B.draw, A.draw)) topT = false;
        else if (covered(t.m, u.m) !== covered(u.m, t.m)) topT = covered(t.m, u.m) > covered(u.m, t.m);
        else topT = t.m > u.m;
        const [top, under] = sameWay(A, B, topT) ? [t, u] : [u, t];
        const T = meshes[top.m]!;
        const U = meshes[under.m]!;
        if (!T.material || !U.material) {
            pend(key, "layer: no material", T);
            continue;
        }
        if (!U.seeThrough && !drawnAfter(rs, T.draw, U.draw)) {
            // (drawn before the opaque surface it lies on, it would show what is behind that surface through it, its
            // bias keeping the surface out: its material's draw order put after the surface's. Over a see-through
            // one the bias alone settles it - the order kept, as the source has it)
            orderEdges.push({
                over: materialIndex.get(T.material)!,
                under: materialIndex.get(U.material)!,
                pair: key,
            });
        }
        biasEdges.push({
            over: materialIndex.get(T.material)!,
            under: materialIndex.get(U.material)!,
            pair: key,
            layer: top.m,
        });
        snapPair(top, under);
    }

    // A detail's base left whole after all: the detail biased over it instead.
    const biasInstead = (vi: number, ki: number): void => {
        if (!overlapCuts.has(`${vi}:${ki}`)) return;
        const k = tris[ki]!;
        const t = tris[vi]!;
        const D = meshes[k.m]!.material;
        const Bm = meshes[t.m]!.material;
        if (!D || !Bm) return;
        biasEdges.push({
            over: materialIndex.get(D)!,
            under: materialIndex.get(Bm)!,
            pair: meshPairKey(k.m, t.m),
            layer: k.m,
        });
        snapPair(k, t);
    };

    // --- bit-identical copies are cut alike (one material: the same keepers, the same pieces) or not at all ---------
    {
        const parent = new Map<number, number>();
        const find = (x: number): number => {
            let r = x;
            while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
            parent.set(x, r);
            return r;
        };
        for (const [a, b] of copies) {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
        }
        const groups = new Map<number, number[]>();
        for (const x of [...parent.keys()].sort((a, b) => a - b)) {
            const r = find(x);
            const g = groups.get(r);
            if (g) g.push(x);
            else groups.set(r, [x]);
        }
        for (const members of groups.values()) {
            if (!members.some((x) => cuts.has(x))) continue;
            // (the covers that may cut every copy: before all of them in the order, or locked and not cut)
            const keepers = [...new Set(members.flatMap((x) => cuts.get(x) ?? []))]
                .filter(
                    (k) =>
                        !members.includes(k) &&
                        members.every((x) => rank[k]! < rank[x]! || (locked[k] && !cuts.has(k))),
                )
                .sort((a, b) => a - b);
            const material = meshes[tris[members[0]!]!.m]!.material;
            const alike =
                keepers.length > 0 &&
                members.every((x) => {
                    const X = meshes[tris[x]!.m]!;
                    return X.material === material && X.editable && !locked[x];
                });
            for (const x of members) {
                for (const k of cuts.get(x) ?? []) if (!alike || !keepers.includes(k)) biasInstead(x, k);
                if (alike) cuts.set(x, [...keepers]);
                else cuts.delete(x);
            }
            if (!alike) bump(report.pending, "copies: not cut alike");
        }
    }

    // --- the cuts: each victim's pieces ------------------------------------------------------------------------------
    // pieces per triangle, as 2D polygons in its own projection (counter-clockwise)
    const pieces = new Map<number, P2[][]>();
    for (const [vi, keepers] of [...cuts.entries()].sort((a, b) => a[0] - b[0])) {
        const t = tris[vi]!;
        const axis = t.axis;
        const [i, j] = otherAxes(axis);
        let current: P2[][] = [projectTri(t, axis)];
        const full = Math.abs(area2(current[0]!));
        const minArea = Math.max(1e-6, full * 1e-6);
        // the keepers' corners as seen across t's axis (they lie in t's plane, within the tolerance)
        const covers = keepers.map((ki) => canon(tris[ki]!.p.map((p): P2 => [p[i]!, p[j]!])));
        const without = (polys: P2[][], cover: readonly P2[]): P2[][] =>
            polys.flatMap((piece) => subtract(piece, cover, minArea));
        for (const cover of covers) {
            const small = kSeam > 0 ? shrink(cover, kSeam) : cover;
            if (small.length >= 3) current = without(current, small);
            if (!current.length) break;
        }
        // (slivers the shrunk covers leave that the whole ones cover: gone - a copy wholly under another goes whole)
        current = current.filter((piece) => {
            let rest: P2[][] = [piece];
            for (const cover of covers) rest = without(rest, cover);
            return rest.some((q) => Math.abs(area2(q)) > minArea * 10);
        });
        const left = current.reduce((n, q) => n + Math.abs(area2(q)), 0);
        const untouched = current.length === 1 && Math.abs(left - full) <= full * 1e-9;
        const tooMany = current.reduce((n, q) => n + q.length - 2, 0) > kMaxPieces;
        o.log?.push(
            `${label(t.m)} triangle at ${t.pos}: ${keepers.length} covers (${keepers.map((k) => `${label(tris[k]!.m)} at ${tris[k]!.pos}`).join(", ")}) -> ` +
                (untouched ? "untouched" : tooMany ? "too many pieces: whole" : `${current.length} pieces`),
        );
        if (tooMany) {
            for (const ki of keepers) biasInstead(vi, ki);
        }
        if (untouched || tooMany) continue;
        pieces.set(vi, current);
    }

    // a card's side made one-sided takes the other side with it (or the two sides, now of two materials, would fight)
    {
        const partners = new Map<number, number[]>();
        for (const c of cards) {
            for (const [a, b] of [
                [c.t, c.u],
                [c.u, c.t],
            ] as const) {
                const list = partners.get(a);
                if (list) list.push(b);
                else partners.set(a, [b]);
            }
        }
        const stack = [...cullTris].sort((a, b) => a - b);
        while (stack.length) {
            const at = stack.pop()!;
            for (const other of partners.get(at) ?? []) {
                const O = meshes[tris[other]!.m]!;
                if (cullTris.has(other) || !O.twoSided || !O.editable || !O.material) continue;
                cullTris.add(other);
                stack.push(other);
            }
        }
    }

    // --- z biases: each material over the ones under it (the surest - most overlap - first; loops left out) ------
    {
        const over: Set<number>[] = scene.materials.map(() => new Set<number>());
        const reaches = (from: number, to: number): boolean => {
            const seenM = new Set<number>([from]);
            const stack = [from];
            while (stack.length) {
                const at = stack.pop()!;
                if (at === to) return true;
                for (const next of over[at]!) {
                    if (!seenM.has(next)) {
                        seenM.add(next);
                        stack.push(next);
                    }
                }
            }
            return false;
        };
        const failed = new Set<string>();
        for (const e of biasEdges) {
            if (e.over === e.under) {
                failed.add(`${e.pair}|same material`);
                continue;
            }
            if (over[e.over]!.has(e.under)) continue;
            if (reaches(e.under, e.over)) {
                failed.add(`${e.pair}|loop`);
                continue;
            }
            over[e.over]!.add(e.under);
        }
        const before = scene.materials.map((m) => m.zBias);
        const level = new Map<number, number>();
        const settle = (i: number): number => {
            const known = level.get(i);
            if (known !== undefined) return known;
            let z = Math.max(0, scene.materials[i]!.zBias);
            for (const under of [...over[i]!].sort((a, b) => a - b)) z = Math.max(z, settle(under) + 1);
            level.set(i, z);
            return z;
        };
        for (let i = 0; i < scene.materials.length; i++) settle(i);
        for (let i = 0; i < scene.materials.length; i++) {
            const z = level.get(i)!;
            if (z > kMaxZBias) {
                scene.materials[i]!.zBias = Math.max(before[i]!, kMaxZBias);
                failed.add(`m${i}|over 16`);
                pendingMaterials.add(scene.materials[i]!.checksum);
            } else if (z > before[i]!) scene.materials[i]!.zBias = z;
        }
        report.biased = scene.materials.filter((m, i) => m.zBias !== before[i]).length;
        for (const f of [...failed].sort()) {
            const why = f.split("|")[1]!;
            bump(report.pending, `bias: ${why}`);
            const e = biasEdges.find((x) => `${x.pair}|${why}` === f);
            const lm = e ? meshes[e.layer]?.material : undefined;
            if (lm) pendingMaterials.add(lm.checksum);
        }
    }

    // --- draw orders: a layer drawn before what it lies on gets a draw order above it (loops left out) -----------
    {
        const after: Set<number>[] = scene.materials.map(() => new Set<number>());
        const reaches = (from: number, to: number): boolean => {
            const seenM = new Set<number>([from]);
            const stack = [from];
            while (stack.length) {
                const at = stack.pop()!;
                if (at === to) return true;
                for (const next of after[at]!) {
                    if (!seenM.has(next)) {
                        seenM.add(next);
                        stack.push(next);
                    }
                }
            }
            return false;
        };
        for (const e of orderEdges) {
            if (e.over === e.under || after[e.over]!.has(e.under)) continue;
            if (reaches(e.under, e.over)) {
                bump(report.pending, "order: loop");
                continue;
            }
            after[e.over]!.add(e.under);
        }
        const before = scene.materials.map((m) => m.drawOrder);
        const order = new Map<number, number>();
        const settle = (i: number): number => {
            const known = order.get(i);
            if (known !== undefined) return known;
            let z = scene.materials[i]!.drawOrder;
            // (a sixteenth above: exact in a float, and below the next whole draw order the exporters use)
            for (const under of [...after[i]!].sort((a, b) => a - b)) z = Math.max(z, settle(under) + 1 / 16);
            order.set(i, z);
            return z;
        };
        for (let i = 0; i < scene.materials.length; i++) scene.materials[i]!.drawOrder = Math.fround(settle(i));
        report.reordered = scene.materials.filter((m, i) => m.drawOrder !== before[i]).length;
    }

    // --- the snaps: a layer's corners behind its base's plane put on it ---------------------------------------------
    const moved = new Map<string, Vec>(); // `${mesh rec}:${vertex}` -> new position
    for (const { t: ti, plane: bi, side } of snaps) {
        const t = tris[ti]!;
        const b = tris[bi]!;
        for (let k = 0; k < 3; k++) {
            const key = `${t.m}:${t.v[k]}`;
            if (moved.has(key)) continue;
            const p = t.p[k]!;
            const dist = dot(b.n, p) - b.d; // (along the plane's front - the pair faces one way)
            if (dist * side <= 0 || Math.abs(dist) > kPlaneTolerance) continue;
            moved.set(key, [p[0] - dist * b.n[0], p[1] - dist * b.n[1], p[2] - dist * b.n[2]]);
        }
    }
    report.snapped = moved.size;

    // --- writing the meshes ------------------------------------------------------------------------------------------
    const usedChecksums = new Set(scene.materials.map((m) => m.checksum));
    const oneSidedOf = new Map<thug2Scene.Material, thug2Scene.Material>();
    const oneSided = (m: thug2Scene.Material): thug2Scene.Material => {
        let c = oneSidedOf.get(m);
        if (!c) {
            c = structuredClone(m);
            c.checksum = freshChecksum(m.checksum, usedChecksums);
            c.singleSided = 1;
            c.noBackfaceCulling = 0;
            oneSidedOf.set(m, c);
            scene.materials.push(c);
        }
        return c;
    };
    const bySector = new Map<number, MeshRec[]>();
    meshes.forEach((m) => {
        const list = bySector.get(m.sector);
        if (list) list.push(m);
        else bySector.set(m.sector, [m]);
    });
    const meshIndexOf = new Map<MeshRec, number>(meshes.map((m, i) => [m, i]));
    for (const [s, recs] of [...bySector.entries()].sort((a, b) => a[0] - b[0])) {
        const sector = scene.sectors[s]!;
        const removeMeshes = new Set<number>();
        const added: thug2Scene.Mesh[] = [];
        for (const rec of recs) {
            const mi = meshIndexOf.get(rec)!;
            const touched = rec.tris.some((ti) => pieces.has(ti) || cullTris.has(ti));
            const snapped = rec.tris.some((ti) => tris[ti]!.v.some((v) => moved.has(`${mi}:${v}`)));
            if (!touched && !snapped) continue;
            if (!rec.editable) continue;
            const mesh = sector.meshes[rec.mesh]!;
            const result = rewriteMesh(mesh, rec, mi, tris, pieces, cullTris, moved, report);
            if (!result) continue;
            const [kept, culled] = result;
            if (culled) {
                culled.material = oneSided(rec.material!).checksum;
                added.push(culled);
            }
            if (kept) sector.meshes[rec.mesh] = kept;
            else removeMeshes.add(rec.mesh);
        }
        if (removeMeshes.size || added.length) {
            const meshesNow = sector.meshes.filter((_, k) => !removeMeshes.has(k));
            meshesNow.push(...added);
            if (!meshesNow.length) {
                // (a sector keeps one mesh: an empty strip drawn as nothing)
                const first = sector.meshes[0]!;
                meshesNow.push({ ...first, lods: [[0, 0, 0]], strips: [[0, 0, 0]] });
            }
            sector.meshes = meshesNow;
        }
    }
    report.oneSided = oneSidedOf.size;
    report.pendingMaterials = [...pendingMaterials].filter((c) => c !== 0).sort((a, b) => a - b);
    return report;
}

// A mesh rewritten: its strip without the dropped / cut / culled triangles plus the cut ones' pieces (new vertices
// interpolated), the snapped corners moved; and the culled triangles as a mesh of their own (to be given the one-sided
// material). [kept (null: nothing left), culled (null: none)], or null when it can't be written (too many indices).
function rewriteMesh(
    mesh: thug2Scene.Mesh,
    rec: MeshRec,
    mi: number,
    tris: readonly TriRec[],
    pieces: ReadonlyMap<number, P2[][]>,
    cullTris: ReadonlySet<number>,
    moved: ReadonlyMap<string, Vec>,
    report: ResolveReport,
): [thug2Scene.Mesh | null, thug2Scene.Mesh | null] | null {
    const strip = mesh.strips[0] ?? [];
    const buffer = mesh.buffers[0]![1];
    const stride = mesh.stride;
    const fvf = mesh.vertexShader[0]!;
    const hasNormal = (fvf & thug2Scene.FVF_NORMAL) !== 0;
    const hasColor = (fvf & thug2Scene.FVF_DIFFUSE) !== 0;
    const uvCount = (fvf >>> thug2Scene.FVF_TEXCOUNT_SHIFT) & 0xf;
    const [normalAt, colorAt, uvAt] = mesh.offsets as [number, number, number];
    const extra: Buffer[] = [];
    const wibbleExtra: number[] = [];
    let vertexCount = mesh.vertexCount;
    // a new vertex at barycentric (w0, w1, w2) of corners a, b, c (its position given)
    const newVertex = (a: number, b: number, c: number, w: [number, number, number], at3: Vec): number => {
        const corners = [a, b, c];
        const strongest = w[0] >= w[1] && w[0] >= w[2] ? 0 : w[1] >= w[2] ? 1 : 2;
        const out = Buffer.from(buffer.subarray(corners[strongest]! * stride, corners[strongest]! * stride + stride));
        const floats = (at: number, n: number, normalise: boolean): void => {
            const v: number[] = [];
            for (let q = 0; q < n; q++) {
                let x = 0;
                for (let k = 0; k < 3; k++) x += w[k]! * buffer.readFloatLE(corners[k]! * stride + at + 4 * q);
                v.push(x);
            }
            if (normalise) {
                const l = Math.hypot(...v) || 1;
                for (let q = 0; q < n; q++) v[q] = v[q]! / l;
            }
            v.forEach((x, q) => {
                out.writeFloatLE(x, at + 4 * q);
            });
        };
        out.writeFloatLE(at3[0], 0);
        out.writeFloatLE(at3[1], 4);
        out.writeFloatLE(at3[2], 8);
        if (hasNormal && normalAt + 12 <= stride) floats(normalAt, 3, true);
        if (hasColor && colorAt + 4 <= stride) {
            for (let q = 0; q < 4; q++) {
                let x = 0;
                for (let k = 0; k < 3; k++) x += w[k]! * buffer[corners[k]! * stride + colorAt + q]!;
                out[colorAt + q] = Math.max(0, Math.min(255, Math.round(x)));
            }
        }
        if (uvCount && uvAt + 8 * uvCount <= stride) floats(uvAt, 2 * uvCount, false);
        extra.push(out);
        if (mesh.hasWibble) wibbleExtra.push(mesh.wibble![corners[strongest]!]!);
        return vertexCount++;
    };

    // the strip's triangles to leave out (by their place in the strip)
    const removed = new Set<number>();
    const newTris: [number, number, number][] = [];
    const culledTris: [number, number, number][] = [];
    for (const ti of rec.tris) {
        const t = tris[ti]!;
        const cull = cullTris.has(ti);
        const piece = pieces.get(ti);
        if (!cull && piece === undefined) continue;
        removed.add(t.pos);
        if (piece !== undefined && !piece.length) {
            report.dropped++;
            continue;
        }
        const target = cull ? culledTris : newTris;
        if (piece === undefined) {
            target.push(t.v);
            report.culled++;
            continue;
        }
        report.cut++;
        if (cull) report.culled++;
        // the pieces' corners: barycentric in t (in its projection)
        const [i, j] = otherAxes(t.axis);
        const q = t.p.map((p): P2 => [p[i]!, p[j]!]);
        const det = (q[1]![0] - q[0]![0]) * (q[2]![1] - q[0]![1]) - (q[2]![0] - q[0]![0]) * (q[1]![1] - q[0]![1]);
        const flip = det < 0; // (t's drawn winding is clockwise in this projection: pieces reversed)
        const cache = new Map<string, number>();
        const [pn, pd] = canonPlane(t);
        const vertexAt = (pt: P2): number => {
            const w1 = ((pt[0] - q[0]![0]) * (q[2]![1] - q[0]![1]) - (q[2]![0] - q[0]![0]) * (pt[1] - q[0]![1])) / det;
            const w2 = ((q[1]![0] - q[0]![0]) * (pt[1] - q[0]![1]) - (pt[0] - q[0]![0]) * (q[1]![1] - q[0]![1])) / det;
            const w: [number, number, number] = [1 - w1 - w2, w1, w2];
            for (let k = 0; k < 3; k++) if (Math.abs(w[k]! - 1) < 1e-7) return t.v[k]!;
            const key = `${w[1].toFixed(7)},${w[2].toFixed(7)}`;
            const hit = cache.get(key);
            if (hit !== undefined) return hit;
            // (the position on the plane of t's corners in a fixed order: alike for a bit-identical copy)
            const at3: Vec = [0, 0, 0];
            at3[i] = pt[0];
            at3[j] = pt[1];
            at3[t.axis] = (pd - pn[i]! * pt[0] - pn[j]! * pt[1]) / pn[t.axis]!;
            const v = newVertex(t.v[0], t.v[1], t.v[2], w, at3);
            cache.set(key, v);
            return v;
        };
        for (const poly of piece) {
            const ids = canon(poly).map(vertexAt);
            for (let k = 1; k + 1 < ids.length; k++) {
                const tri: [number, number, number] = flip
                    ? [ids[0]!, ids[k + 1]!, ids[k]!]
                    : [ids[0]!, ids[k]!, ids[k + 1]!];
                if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
                target.push(tri);
                report.pieces++;
            }
        }
    }
    if (vertexCount > 0xffff) return null;

    // the vertex buffer: the snaps, then the new vertices
    let data = Buffer.concat([Buffer.from(buffer.subarray(0, mesh.vertexCount * stride)), ...extra]);
    for (let v = 0; v < mesh.vertexCount; v++) {
        const p = moved.get(`${mi}:${v}`);
        if (!p) continue;
        data.writeFloatLE(p[0], v * stride);
        data.writeFloatLE(p[1], v * stride + 4);
        data.writeFloatLE(p[2], v * stride + 8);
    }
    if (buffer.length > mesh.vertexCount * stride)
        data = Buffer.concat([data, buffer.subarray(mesh.vertexCount * stride)]);

    const keptStrip = restrip(strip, removed, newTris);
    const culledStrip = culledTris.length ? restrip([], new Set(), culledTris) : null;
    if (keptStrip.length > 0xffff || (culledStrip && culledStrip.length > 0xffff)) return null;
    const wibble = mesh.hasWibble ? Buffer.concat([mesh.wibble!, Buffer.from(wibbleExtra)]) : undefined;
    const make = (s: number[]): thug2Scene.Mesh => {
        const sameLod = mesh.lods.length === 1 && sameList(mesh.lods[0]!, strip);
        const out: thug2Scene.Mesh = {
            ...mesh,
            lods: sameLod ? [s] : mesh.lods,
            strips: [s, ...mesh.strips.slice(1)],
            vertexCount,
            buffers: [[mesh.buffers[0]![0], data]],
        };
        if (wibble) out.wibble = wibble;
        return out;
    };
    const kept = keptStrip.length >= 3 ? make(keptStrip) : null;
    let culled: thug2Scene.Mesh | null = null;
    if (culledStrip) {
        culled = make(culledStrip);
        culled.lods = [culledStrip];
        culled.strips = [culledStrip];
    }
    return [kept, culled];
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// A strip with the triangles at `removed` (their last corner's place) left out and `extra` triangles (wound as drawn)
// added, joined by degenerate triangles with each piece kept on its own parity (D3D's alternating winding).
export function restrip(strip: readonly number[], removed: ReadonlySet<number>, extra: readonly number[][]): number[] {
    // pieces [a, b]: strip[a..b], its triangles at a + 2 .. b
    const pieces: [number, number][] = [];
    let a = 0;
    for (let j = 2; j < strip.length; j++) {
        if (!removed.has(j)) continue;
        if (j - 1 - a >= 2) pieces.push([a, j - 1]);
        a = j - 1;
    }
    if (strip.length - 1 - a >= 2) pieces.push([a, strip.length - 1]);
    const out: number[] = [];
    const append = (vertices: readonly number[], start: number): void => {
        if (out.length) {
            out.push(out[out.length - 1]!, vertices[0]!);
        }
        if (out.length % 2 !== start % 2) out.push(vertices[0]!);
        out.push(...vertices);
    };
    for (const [x, y] of pieces) append(strip.slice(x, y + 1), x);
    for (const t of extra) append(t, 0);
    return out;
}

// --- a level folder -----------------------------------------------------------------------------------------------

function findFile(dir: string, file: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const want = file.toLowerCase();
    const hit = fs
        .readdirSync(dir)
        .sort()
        .find((f) => f.toLowerCase() === want);
    return hit ? path.join(dir, hit) : null;
}

export interface LevelInputs {
    scene: thug2Scene.Scene;
    hidden: Set<number>;
    toggles: Toggles;
    cutOut: Set<number>;
    files: { scn: string; qb: string | null; col: string | null };
}

export function readLevelInputs(dir: string, name: string): LevelInputs {
    const scn = findFile(dir, `${name}.scn.xbx`);
    if (!scn) throw new Error(`${name}: no ${name}.scn.xbx in ${dir}`);
    const scene = thug2Scene.readScene(fs.readFileSync(scn), scn);
    const qb = findFile(dir, `${name}.qb`);
    const hidden = qb ? hiddenSectors(fs.readFileSync(qb), qb).hidden : new Set<number>();
    const toggles = levelToggles(dir, scene);
    const texFile = findFile(dir, `${name}.tex.xbx`);
    let textures: tex.TexFile | null = null;
    if (texFile) {
        try {
            textures = tex.readTex(fs.readFileSync(texFile), texFile);
        } catch {
            textures = null;
        }
    }
    return {
        scene,
        hidden,
        toggles,
        cutOut: cutOutTextures(textures, scene),
        files: { scn, qb, col: findFile(dir, `${name}.col.xbx`) },
    };
}

// Resolves a written level in place (or into `outDir`: the scene there, the qb and collision copied). Returns the
// report and the scene's bytes.
export function resolveLevelFolder(dir: string, name: string, outDir: string | null = null): ResolveReport {
    const inputs = readLevelInputs(dir, name);
    const report = resolveScene(inputs.scene, inputs);
    const data = thug2Scene.writeScene(inputs.scene);
    thug2Scene.readScene(data, name);
    const target = outDir ?? dir;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, path.basename(inputs.files.scn)), data);
    if (outDir) {
        for (const f of [inputs.files.qb, inputs.files.col])
            if (f) fs.copyFileSync(f, path.join(outDir, path.basename(f)));
    }
    return report;
}

// The note a converter leaves next to its staging's levels: <staging>\zfight\<level>.json (not installed -
// make_menu_level copies levels\ only): what was done, what is left for step 2 (the see-through materials that need a
// slope-scaled bias), and that the scene written then is resolved (the z-fight gates in the converters' tests check
// only such levels).
export function noteFile(levelDir: string, name: string): string {
    return path.join(path.dirname(path.dirname(levelDir)), "zfight", `${name}.json`);
}

export function writeNote(levelDir: string, name: string, r: ResolveReport): void {
    const file = noteFile(levelDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const hex = (x: number): string => x.toString(16).toUpperCase().padStart(8, "0");
    const note = { level: name, ...r, pendingMaterials: r.pendingMaterials.map(hex) };
    fs.writeFileSync(file, `${JSON.stringify(note, null, 1)}\n`);
}

export function reportLine(name: string, r: ResolveReport): string {
    const classes = Object.entries(r.meshPairs)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
    const pending = Object.entries(r.pending)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
    return (
        `${name}: z-fight pairs ${r.pairs} (mesh pairs: ${classes || "none"}); ${r.dropped} triangles dropped, ` +
        `${r.cut} cut into ${r.pieces}, ${r.culled} one-sided (${r.oneSided} materials), ${r.biased} materials ` +
        `biased, ${r.reordered} drawn later, ${r.snapped} vertices snapped; left for step 2: ${pending || "none"}`
    );
}

// --- command line ---------------------------------------------------------------------------------------------------

const USAGE = `usage: zfight_resolve.ts [-h] [--out FOLDER] [--dry-run] folder [level ...]

Resolves coplanar overlaps (z-fighting) in converted levels' scenes, by class.

positional arguments:
  folder        a levels folder (<folder>\\<level>\\<level>.scn.xbx)
  level         levels (default: every folder in it with a scene, skies left out)

options:
  --out FOLDER  write into this levels folder (scene changed, qb and collision copied) instead of in place
  --dry-run     report only
  --explain HEX the decisions on the pairs a sector / material checksum is in (repeatable; nothing written)`;

export function main(argv: readonly string[] = process.argv.slice(2)): number {
    const { values, positionals } = parseCli(USAGE, {
        args: [...argv],
        allowPositionals: true,
        options: {
            out: { type: "string" },
            "dry-run": { type: "boolean" },
            explain: { type: "string", multiple: true },
        },
    });
    const [folder, ...wanted] = positionals;
    if (!folder) pyExit(USAGE);
    const levels = wanted.length
        ? wanted
        : fs
              .readdirSync(folder)
              .filter((d) => !/_sky$/i.test(d) && findFile(path.join(folder, d), `${d}.scn.xbx`))
              .sort();
    for (const level of levels) {
        const dir = findFile(folder, level) ?? path.join(folder, level);
        let r: ResolveReport;
        const log: string[] = [];
        if (values["dry-run"] || values.explain) {
            const inputs = readLevelInputs(dir, level);
            r = resolveScene(inputs.scene, { ...inputs, log });
        } else r = resolveLevelFolder(dir, level, values.out ? path.join(values.out, level) : null);
        print(reportLine(level, r));
        const wantedText = (values.explain ?? []).map((x) => x.toUpperCase());
        for (const line of log) if (wantedText.some((w) => line.includes(w))) print(`  ${line}`);
    }
    return 0;
}

if (isMain(import.meta.url)) runMain(() => main());
