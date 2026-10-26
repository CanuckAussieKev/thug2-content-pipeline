// NOT ORIGINAL - z-fighting as the player sees it: an offline software rasterizer that draws a converted level (any
// port, or THUG2's own) from the skater camera at a few hundred places with THUG2's projection, depth buffer, z bias,
// culling and draw order, and counts the pixels whose visible surface depends on depth differences the hardware
// can't resolve - real z-fight pixels, per mesh pair, per level, per viewpoint.
//
//     node tools/pipeline/level_port/zfight_raster.ts <levels folder> [<level> ...] [--views N] [--headings K] [--seed S]
//            [--size WxH] [--aspect A] [--jitter UNITS] [--top N] [--workers N] [--orders] [--draw-distance-scale X]
//            [--at x,y,z[,heading]]... [--camera x,y,z,dx,dy,dz]... [--png FILE] [--csv FILE] [--json FILE]
//
// e.g. node tools/pipeline/level_port/zfight_raster.ts C:\Games\THUG2-4\thug2-decomp-thp8\levels thp8_net_beavervalley
//      node tools/pipeline/level_port/zfight_raster.ts C:\Games\THUG2\Game\Data\levels AP
//      node tools/pipeline/level_port/zfight_raster.ts <levels> thp8_net_beavervalley --camera -5720,1010,8244,-0.983,-0.18,-0.033
//           --png out\bv.png          (one view: the user's screenshot; fights in magenta)
// (npm run zfight-raster -- <args>)
//
// The level: <folder>\<level>\<level>.scn.xbx (every sector the game draws at start: sectors whose node is a
// LevelGeometry without CreatedAtStart, or a LevelObject / GameObject - drawn in their own space by the game - are
// left out, from <level>.qb's node array; billboards and skinned sectors too; the sky is another scene, not read).
// Viewpoints: <level>.col.xbx's up-facing faces (area-weighted, a fixed seed) as the skater's spot, each looked from
// `--headings` directions; or the explicit `--at` (skater spot, try_spot.ts's x,y,z,heading) / `--camera` (eye and
// direction, the screenshot sidecar's [camera]).
//
// How it models the engine (our decompiled renderer, src/game/gfx):
// - Projection: Nx::SetCamera 0x004DB200 (render.cpp): D3DXMatrixPerspectiveRH with near 2 (the world passes; the
//   camera objects' own 12 / 12000 aren't what is drawn with) and far 96000 (PartyMod's; x draw_distance_scale), the
//   horizontal angle Camera::GetAdjustedHFOV 0x00485AA0 (camera.cpp): camera_fov 72 widened by
//   GetScreenAngleFactor 0x004A07C0 (aspect / (4/3) past 4:3), the vertical tan = tanX / (aspect x 0.90909094) with
//   the viewport's aspect 0x004A0D20 (screen aspect x the viewport's width / height).
// - Depth: D24S8 (24-bit unorm: z rounded to 1 / (2^24 - 1)), z / w interpolated linearly over the screen as the
//   hardware does, ZFUNC LESSEQUAL (SetState kZTest, render_state.cpp 0x004DAB60); z writes on for both world passes
//   (RenderViewport sets state 1) except meshes whose material's pass 0 has the decal flag 0x10 (mesh flag 0x100 at
//   load, pc_mesh_load.cpp; sMesh::Render 0x004D5290 turns z writes off for them).
// - Z bias: the material's bias clamped to 16 and kept as a byte (pc_material_load.cpp), D3DRS_DEPTHBIAS = value x
//   -2e-6 (the float 0xB60637BD at 0x0064AAA4; SetState kDepthBias, sMaterial::SetCommonStates 0x004D1F00) - added
//   to z before the depth test (no slope scale).
// - Culling: D3DCULL_NONE for a two-sided material (its flag, or pass 0 blended unless the "keep culling" byte is
//   set - the load), else D3DCULL_CW.
// - Draw order: the scene's meshes sorted by CompareMeshes 0x004DDD50 (mesh_list.cpp: the material's sort key, its
//   sort flag, decal flag, the mesh's load order, the material); RenderScene 0x004DC700 (scene_render.cpp): pass
//   0x55 (render.cpp RenderViewport) draws the meshes before the first transparent one (pass 0 flag 0x40) - the near
//   ones (depth <= 600) first when there are fewer than 4096 - for every scene; then the sky; then pass 0x46: the
//   rest in order, the transparent ones with the sort flag sorted by depth.
//
// Detection: a fragment whose depth is within `--jitter` units (default 1: one step of the 24-bit buffer) of the
// stored depth of another mesh - with nearly the same depth slope (the two surfaces stay that close for at least a
// pixel, so a crease where two surfaces meet isn't counted) - is contested: the result there flips with a 1-ulp
// change of either surface's depth, which is what the hardware's interpolation does from frame to frame as the camera
// moves. A later fragment that covers it opaquely and decisively clears it. A pixel still contested at the end of the
// frame is a z-fight pixel; its pair is the two meshes. This includes the pixels whose surface differs when the draw
// order is reversed within a bucket (equal depths: the later one wins with LESSEQUAL) - `--orders` renders that
// literally too and reports how many such pixels there were (the depth-writing surface; exact copies aside) and how
// many weren't contested: single pixels where two surfaces cross at equal depth (no fight).
// Approximations: alpha-tested (cut-out) surfaces cover as if solid (no textures are read); LOD 0 always; no occlusion
// culling (it only skips hidden meshes); the skater camera is the script's Skater_Camera_Standard_Medium
// (game/skater/physics.qb: behind 12 ft, above 4.3 ft, tilt 0.18 rad; the camera component isn't decompiled yet).
//
// Exact copies are not fights: triangles with bit-identical corners get identical depths on the hardware (D3D's
// invariance - what multi-pass drawing relies on; THUG2's own levels draw glass and its reflection as two meshes of
// the same triangles, materials X and X + 1), so with LESSEQUAL the later always wins. Pixels contested between them,
// and between a card's two sides in one material, are counted apart ("same surface"; this float model's interpolation
// can't tell them apart). Corners equal within 0.01 inch but not exactly are fights ("copy").
// Pair classes: "copy" (near-copies of the triangles), "self" (two triangles of one mesh), "layer" (one of the two is
// see-through: blended, or a decal without z writes), "opposite" (they face
// opposite ways - two-sided back-to-back shells), "duplicate" (both opaque with the same pass-0 texture), "overlap"
// (other opaque surfaces in one plane).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as zlib from "node:zlib";
import { parseCli } from "../lib/cli.ts";
import { isMain, print, pyExit, runMain } from "../lib/py.ts";
import { expandIncludes } from "./nodes.ts";
import { checksum, Name, QbFile, type QbValue, Struct } from "./qb.ts";
import { levelToggles, type Toggles, thereWhenever } from "./script_toggles.ts";
import * as thug2Col from "./thug2_col.ts";
import * as thug2Scene from "./thug2_scene.ts";

export type Vec = [number, number, number];

// --- the engine's numbers ------------------------------------------------------------------------------------------

export const DEPTH_MAX = 0xffffff; // D24S8
export const NEAR_PLANE = 2; // SetCamera: camera.nearZ (the world passes)
export const FAR_PLANE = 96000; // SetCamera: PartyMod's far plane (the original's 32000)
export const CAMERA_FOV = 72; // camera_fov (engine/camera.qb), Skater_Camera_*'s horiz_fov
export const HEIGHT_FACTOR = Math.fround(0.90909094); // SetCamera: the height is width / (aspect x this)
export const DEPTH_BIAS_UNIT = new DataView(new Uint32Array([0xb60637bd]).buffer).getFloat32(0, true); // -2e-6
export const NEAR_FIRST_DEPTH = 600; // RenderScene: kNear (0x0064AA98)
export const NEAR_FIRST_LIMIT = 0x1000; // RenderScene: no near-first pass from this many opaque meshes
export const SKATER_CAMERA = { behind: 12 * 12, above: 4.3 * 12, tilt: 0.18 }; // Skater_Camera_Standard_Medium (feet)
export const DEFAULT_SIZE: [number, number] = [320, 180];
export const DEFAULT_ASPECT = 16 / 9; // the workspaces' 1280 x 720 window
export const DEFAULT_JITTER = 1;
export const DEFAULT_VIEWS = 300; // skater spots
export const DEFAULT_HEADINGS = 4;

const PASS_DECAL = thug2Scene.PASS_DECAL; // 0x10: no z writes (mesh flag 0x100), sorted after
const PASS_TRANSPARENT = thug2Scene.PASS_TRANSPARENT; // 0x40: the transparent pass

// --- the scene as drawn -------------------------------------------------------------------------------------------

export interface DrawMesh {
    sector: number; // index in scene.sectors
    mesh: number; // index in the sector's meshes
    sectorChecksum: number;
    materialChecksum: number;
    materialIndex: number; // -1: not in the scene
    texture: number; // pass 0's texture checksum (0: none)
    textures: number[];
    vStart: number; // first vertex in RasterScene.positions
    vCount: number;
    tStart: number; // first triangle in RasterScene.tris
    tCount: number;
    centre: Vec;
    radius: number;
    twoSided: boolean;
    transparent: boolean; // pass 0 flag 0x40: drawn in the transparent pass
    zWrite: boolean;
    seeThrough: boolean; // blended (or a decal without z writes): what is under it stays visible
    bias: number; // added to z (0..1 space)
    zBias: number; // the material's own value
    sortKey: number;
    sortFlag: boolean;
    decal: boolean;
}

export interface RasterScene {
    positions: Float32Array; // x, y, z per vertex
    tris: Uint32Array; // 3 vertex indices (into positions) per triangle, wound as drawn
    meshes: DrawMesh[];
    sorted: number[]; // mesh indices in CompareMeshes' order
    firstTransparent: number; // positions in `sorted`
    firstFlagged: number;
    flaggedCount: number;
}

// The material as the game's loader keeps it (pc_material_load.cpp).
function drawState(m: thug2Scene.Material | undefined) {
    if (!m) {
        return { twoSided: false, transparent: false, zWrite: true, seeThrough: false, bias: 0, decal: false };
    }
    const pass0 = m.passes[0];
    const flags = pass0?.flags ?? 0;
    const blend = (pass0?.blendMode ?? 0) & 0xffffff;
    const twoSided = !!m.noBackfaceCulling || (!m.singleSided && blend !== 0);
    const byte = (Math.min(m.zBias, 0x10) & 0xff) >>> 0; // static_cast<uint8_t>(bias > 16 ? 16 : bias)
    const decal = (flags & PASS_DECAL) !== 0;
    return {
        twoSided,
        transparent: (flags & PASS_TRANSPARENT) !== 0,
        zWrite: !decal,
        seeThrough: decal || (blend !== 0 && blend !== 0xb),
        bias: Math.fround(byte * DEPTH_BIAS_UNIT),
        decal,
    };
}

export interface BuildOptions {
    hidden?: ReadonlySet<number>; // sector checksums not drawn
    shared?: boolean; // typed arrays on SharedArrayBuffers (for worker threads)
}

// THUG2's scene as RasterScene: each mesh's first strip (LOD 0) as triangles, D3D's strip winding.
export function buildRasterScene(scene: thug2Scene.Scene, options: BuildOptions = {}): RasterScene {
    const materialIndex = new Map(scene.materials.map((m, i) => [m.checksum, i]));
    const meshes: DrawMesh[] = [];
    const positions: number[] = [];
    const tris: number[] = [];
    scene.sectors.forEach((sector, s) => {
        if (options.hidden?.has(sector.checksum)) return;
        if (sector.flags & (thug2Scene.SEC_BILLBOARD | thug2Scene.SEC_WEIGHTS)) return;
        sector.meshes.forEach((mesh, k) => {
            const buffer = mesh.buffers[0]?.[1];
            const strip = mesh.strips[0] ?? [];
            if (buffer === undefined || mesh.stride < 12 || strip.length < 3) return;
            const vStart = positions.length / 3;
            const count = Math.min(mesh.vertexCount, Math.floor(buffer.length / mesh.stride));
            let lo: Vec = [Infinity, Infinity, Infinity];
            let hi: Vec = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < count; i++) {
                const at = i * mesh.stride;
                const p: Vec = [buffer.readFloatLE(at), buffer.readFloatLE(at + 4), buffer.readFloatLE(at + 8)];
                positions.push(p[0], p[1], p[2]);
                lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
                hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
            }
            const tStart = tris.length / 3;
            for (let j = 2; j < strip.length; j++) {
                const a = strip[j - 2]!;
                const b = strip[j - 1]!;
                const c = strip[j]!;
                if (a === b || b === c || a === c || a >= count || b >= count || c >= count) continue;
                if (j % 2) tris.push(vStart + b, vStart + a, vStart + c);
                else tris.push(vStart + a, vStart + b, vStart + c);
            }
            const tCount = tris.length / 3 - tStart;
            if (!tCount) {
                positions.length = vStart * 3;
                return;
            }
            const centre: Vec = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
            let radius = 0;
            for (let i = vStart; i < vStart + count; i++) {
                radius = Math.max(
                    radius,
                    Math.hypot(
                        positions[3 * i]! - centre[0],
                        positions[3 * i + 1]! - centre[1],
                        positions[3 * i + 2]! - centre[2],
                    ),
                );
            }
            const mi = materialIndex.get(mesh.material) ?? -1;
            const m = mi >= 0 ? scene.materials[mi] : undefined;
            const state = drawState(m);
            meshes.push({
                sector: s,
                mesh: k,
                sectorChecksum: sector.checksum,
                materialChecksum: mesh.material,
                materialIndex: mi,
                texture: m?.passes[0]?.texture ?? 0,
                textures: m ? m.passes.map((p) => p.texture) : [],
                vStart,
                vCount: count,
                tStart,
                tCount,
                centre,
                radius,
                zBias: m?.zBias ?? 0,
                sortKey: m?.drawOrder ?? 0,
                sortFlag: !!m?.sorted,
                ...state,
            });
        });
    });
    const P = options.shared
        ? new Float32Array(new SharedArrayBuffer(positions.length * 4))
        : new Float32Array(positions.length);
    P.set(positions);
    const T = options.shared ? new Uint32Array(new SharedArrayBuffer(tris.length * 4)) : new Uint32Array(tris.length);
    T.set(tris);
    return { positions: P, tris: T, meshes, ...sortMeshes(meshes) };
}

// CompareMeshes 0x004DDD50 (the load order: the mesh's index here; the material pointer: its index), then
// sScene::Recount.
export function compareMeshes(a: DrawMesh, b: DrawMesh, ia: number, ib: number): number {
    if (!(a.sortKey === b.sortKey)) return a.sortKey > b.sortKey ? 1 : -1;
    if (a.sortFlag !== b.sortFlag) return a.sortFlag ? 1 : -1;
    if (a.materialIndex === b.materialIndex) return 0;
    if (a.decal !== b.decal) return a.decal ? 1 : -1;
    if (ia !== ib) return ib < ia ? 1 : -1;
    return b.materialIndex < a.materialIndex ? 1 : -1;
}

export function sortMeshes(meshes: readonly DrawMesh[]) {
    const sorted = meshes.map((_, i) => i);
    sorted.sort((i, j) => compareMeshes(meshes[i]!, meshes[j]!, i, j) || i - j);
    let firstTransparent = sorted.length;
    let firstFlagged = sorted.length;
    let flaggedCount = 0;
    sorted.forEach((m, i) => {
        if (!meshes[m]!.transparent) return;
        if (i < firstTransparent) firstTransparent = i;
        if (meshes[m]!.sortFlag) {
            flaggedCount++;
            if (i < firstFlagged) firstFlagged = i;
        }
    });
    return { sorted, firstTransparent, firstFlagged, flaggedCount };
}

// --- the camera -----------------------------------------------------------------------------------------------------

export interface Camera {
    eye: Vec;
    f: Vec; // forward
    r: Vec; // right on the screen
    u: Vec; // up on the screen
    tanX: number;
    tanY: number;
    near: number;
    far: number;
}

export interface LensOptions {
    aspect?: number;
    fov?: number;
    drawDistanceScale?: number;
}

const norm = (v: Vec): Vec => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec, b: Vec): Vec => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];

// A camera at `eye` looking along `dir` (world up +y), with THUG2's lens.
export function lookCamera(eye: Vec, dir: Vec, o: LensOptions = {}): Camera {
    const aspect = o.aspect ?? DEFAULT_ASPECT;
    const half = ((o.fov ?? CAMERA_FOV) * Math.PI) / 360;
    const factor = aspect > 4 / 3 ? aspect / (4 / 3) : 1; // GetScreenAngleFactor
    const tanX = Math.tan(half) * factor; // the adjusted angle's tangent
    const tanY = tanX / (aspect * HEIGHT_FACTOR);
    const f = norm(dir);
    // (a right-handed view, D3DXMatrixLookAtRH: looking along +z, +x is to the left)
    let r = cross(f, [0, 1, 0]);
    if (Math.hypot(...r) < 1e-6) r = [1, 0, 0];
    r = norm(r);
    const u = cross(r, f);
    return { eye, f, r, u, tanX, tanY, near: NEAR_PLANE, far: FAR_PLANE * (o.drawDistanceScale ?? 1) };
}

// The skater camera behind a skater standing at `ground` facing `heading` (degrees: 0 = +z, 90 = +x).
export function skaterCamera(ground: Vec, heading: number, o: LensOptions = {}): Camera {
    const h = (heading * Math.PI) / 180;
    const { behind, above, tilt } = SKATER_CAMERA;
    const look: Vec = [Math.sin(h) * Math.cos(tilt), -Math.sin(tilt), Math.cos(h) * Math.cos(tilt)];
    const target: Vec = [ground[0], ground[1] + above, ground[2]];
    return lookCamera(
        [target[0] - look[0] * behind, target[1] - look[1] * behind, target[2] - look[2] * behind],
        look,
        o,
    );
}

// --- the rasterizer -------------------------------------------------------------------------------------------------

export interface RenderOptions {
    width: number;
    height: number;
    jitter: number; // depth units within which the test counts as contested
    track: boolean; // contest tracking (off: plain rendering)
    reverse?: boolean; // the draw order reversed within each bucket
    probe?: { pixel: number; fragments: [number, number, number][] }; // every fragment at a pixel: mesh, depth, stored
}

export class Frame {
    readonly width: number;
    readonly height: number;
    readonly depth: Uint32Array;
    readonly owner: Int32Array; // the mesh whose depth is stored
    readonly gx: Float64Array; // its depth slope (units per pixel)
    readonly gy: Float64Array;
    readonly face: Int8Array; // its facing (1 front, -1 back)
    readonly ownerTri: Int32Array; // its triangle
    readonly contestA: Int32Array; // the fragment's mesh (-1: none)
    readonly contestB: Int32Array; // the stored mesh
    readonly contestOpposite: Uint8Array;
    readonly contestTriA: Int32Array; // the two triangles
    readonly contestTriB: Int32Array;
    readonly signature: Int32Array; // what is seen (the top opaque mesh, see-through ones over it hashed in)
    drawn = 0; // pixels covered
    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        const n = width * height;
        this.depth = new Uint32Array(n);
        this.owner = new Int32Array(n);
        this.gx = new Float64Array(n);
        this.gy = new Float64Array(n);
        this.face = new Int8Array(n);
        this.ownerTri = new Int32Array(n);
        this.contestA = new Int32Array(n);
        this.contestB = new Int32Array(n);
        this.contestOpposite = new Uint8Array(n);
        this.contestTriA = new Int32Array(n);
        this.contestTriB = new Int32Array(n);
        this.signature = new Int32Array(n);
    }
    clear(): void {
        this.depth.fill(DEPTH_MAX); // Clear(z = 1)
        this.owner.fill(-1);
        this.contestA.fill(-1);
        this.contestB.fill(-1);
        this.contestOpposite.fill(0);
        this.signature.fill(0);
        this.drawn = 0;
    }
}

// Whether the sphere is (partly) inside the view volume, and its depth along the view.
function sphereDepth(cam: Camera, c: Vec, radius: number): number {
    const dx = c[0] - cam.eye[0];
    const dy = c[1] - cam.eye[1];
    const dz = c[2] - cam.eye[2];
    const z = dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2];
    if (z + radius < cam.near || z - radius > cam.far) return Number.NaN;
    const x = dx * cam.r[0] + dy * cam.r[1] + dz * cam.r[2];
    const y = dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2];
    // side planes: |x| <= z tanX, distance to the plane through the eye
    const kx = Math.hypot(1, cam.tanX);
    const ky = Math.hypot(1, cam.tanY);
    if ((Math.abs(x) - z * cam.tanX) / kx > radius) return Number.NaN;
    if ((Math.abs(y) - z * cam.tanY) / ky > radius) return Number.NaN;
    return z;
}

// The meshes in the order RenderScene draws them for this camera, as buckets (pass 0x55's near and far opaque
// meshes; pass 0x46's transparent meshes before the flagged ones, the flagged ones by depth, the rest).
export function drawBuckets(rs: RasterScene, cam: Camera): number[][] {
    const depthOf = new Map<number, number>();
    const visible = (m: number): boolean => {
        const mesh = rs.meshes[m]!;
        const d = sphereDepth(cam, mesh.centre, mesh.radius);
        depthOf.set(m, d);
        return !Number.isNaN(d);
    };
    const { sorted, firstTransparent, firstFlagged, flaggedCount } = rs;
    const nearFirst = firstTransparent < NEAR_FIRST_LIMIT;
    const near: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < firstTransparent; i++) {
        const m = sorted[i]!;
        if (!visible(m)) continue;
        if (!nearFirst || depthOf.get(m)! <= NEAR_FIRST_DEPTH) near.push(m);
        else far.push(m);
    }
    const before: number[] = [];
    let i = firstTransparent;
    for (; i < firstFlagged && i < sorted.length; i++) if (visible(sorted[i]!)) before.push(sorted[i]!);
    const flagged: number[] = [];
    const rest: number[] = [];
    if (flaggedCount > 0) {
        const end = firstFlagged + flaggedCount;
        for (; i < end; i++) if (visible(sorted[i]!)) flagged.push(sorted[i]!);
        flagged.sort((a, b) => depthOf.get(a)! - depthOf.get(b)!); // CompareDistances, ascending
        for (; i < sorted.length; i++) if (visible(sorted[i]!)) rest.push(sorted[i]!);
    }
    return [near, far, before, flagged, rest];
}

const HASH = 0x9e3779b1;

// Draws the scene into `frame`.
export function renderView(rs: RasterScene, cam: Camera, frame: Frame, o: RenderOptions): void {
    frame.clear();
    const W = frame.width;
    const H = frame.height;
    const Q = cam.far / (cam.far - cam.near);
    const near = cam.near;
    const { positions, tris, meshes } = rs;
    const {
        depth,
        owner,
        ownerTri,
        gx,
        gy,
        face,
        contestA,
        contestB,
        contestOpposite,
        contestTriA,
        contestTriB,
        signature,
    } = frame;
    const jitter = o.jitter;
    const gradTolerance = Math.max(jitter, 1);
    const ex = cam.eye[0];
    const ey = cam.eye[1];
    const ez = cam.eye[2];
    const [fx, fy, fz] = cam.f;
    const [rx, ry, rz] = cam.r;
    const [ux, uy, uz] = cam.u;
    const sx = 0.5 * W;
    const sy = 0.5 * H;
    let view = new Float64Array(3 * 1024);
    // the clipped polygon's corners: view space (x, y, dist) - up to 4 after the near plane
    const poly = new Float64Array(12);
    const tmp = new Float64Array(12);
    const scr = new Float64Array(12); // screen x, y, z per corner
    let drawn = 0;

    let meshId = 0;
    let triId = 0;
    let mesh: DrawMesh;
    let bias = 0;
    let twoSided = false;
    let zWrite = true;
    let seeThrough = false;

    const E = new Float64Array(18);
    const edge = (k: number, ax: number, ay: number, bx: number, by: number): void => {
        const swap = ay > by || (ay === by && ax > bx);
        const at = 6 * k;
        E[at] = swap ? bx : ax;
        E[at + 1] = swap ? by : ay;
        E[at + 2] = swap ? ax - bx : bx - ax;
        E[at + 3] = swap ? ay - by : by - ay;
        E[at + 4] = swap ? -1 : 1;
        E[at + 5] = by - ay < 0 || (by === ay && bx - ax > 0) ? 1 : 0;
    };

    const triangle = (i0: number, i1: number, i2: number): void => {
        const x0 = scr[i0]!;
        const y0 = scr[i0 + 1]!;
        const z0 = scr[i0 + 2]!;
        let x1 = scr[i1]!;
        let y1 = scr[i1 + 1]!;
        let z1 = scr[i1 + 2]!;
        let x2 = scr[i2]!;
        let y2 = scr[i2 + 1]!;
        let z2 = scr[i2 + 2]!;
        let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (!(area !== 0)) return;
        // (screen y down: a positive area is clockwise on the screen - D3DCULL_CW culls it)
        const front = area < 0;
        if (!front && !twoSided) return;
        if (area < 0) {
            let t = x1;
            x1 = x2;
            x2 = t;
            t = y1;
            y1 = y2;
            y2 = t;
            t = z1;
            z1 = z2;
            z2 = t;
            area = -area;
        }
        const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
        const maxX = Math.min(W - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
        const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
        const maxY = Math.min(H - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
        if (minX > maxX || minY > maxY) return;
        const A = ((z1 - z0) * (y2 - y0) - (z2 - z0) * (y1 - y0)) / area;
        const B = ((z2 - z0) * (x1 - x0) - (z1 - z0) * (x2 - x0)) / area;
        const gA = A * DEPTH_MAX;
        const gB = B * DEPTH_MAX;
        const faceSign = front ? 1 : -1;
        // edges (a -> b): w = (bx - ax)(py - ay) - (by - ay)(px - ax) >= 0 inside, a tie belonging to "top-left"
        // edges; each computed from its lower corner (sign flipped when a is the upper one) so that an edge two
        // triangles share gives exactly opposite values - every pixel along it is drawn by one of them only
        edge(0, x0, y0, x1, y1);
        edge(1, x1, y1, x2, y2);
        edge(2, x2, y2, x0, y0);
        const o0x = E[0]!,
            o0y = E[1]!,
            d0x = E[2]!,
            d0y = E[3]!,
            s0 = E[4]!,
            t0 = E[5]! > 0;
        const o1x = E[6]!,
            o1y = E[7]!,
            d1x = E[8]!,
            d1y = E[9]!,
            s1 = E[10]!,
            t1 = E[11]! > 0;
        const o2x = E[12]!,
            o2y = E[13]!,
            d2x = E[14]!,
            d2y = E[15]!,
            s2 = E[16]!,
            t2 = E[17]! > 0;
        for (let py = minY; py <= maxY; py++) {
            const cy = py + 0.5;
            const row = py * W;
            for (let px = minX; px <= maxX; px++) {
                const cx = px + 0.5;
                const w0 = s0 * (d0x * (cy - o0y) - d0y * (cx - o0x));
                if (w0 < 0 || (w0 === 0 && !t0)) continue;
                const w1 = s1 * (d1x * (cy - o1y) - d1y * (cx - o1x));
                if (w1 < 0 || (w1 === 0 && !t1)) continue;
                const w2 = s2 * (d2x * (cy - o2y) - d2y * (cx - o2x));
                if (w2 < 0 || (w2 === 0 && !t2)) continue;
                const z = z0 + A * (cx - x0) + B * (cy - y0);
                if (z < 0 || z > 1) continue;
                let zb = z + bias;
                zb = zb < 0 ? 0 : zb > 1 ? 1 : zb;
                const zq = Math.round(zb * DEPTH_MAX);
                const p = row + px;
                const stored = depth[p]!;
                const o2 = owner[p]!;
                const d = zq - stored;
                if (o.probe && o.probe.pixel === p) o.probe.fragments.push([meshId, zq, stored]);
                if (
                    o.track &&
                    o2 >= 0 &&
                    (o2 !== meshId || ownerTri[p] !== triId) &&
                    d <= jitter &&
                    d >= -jitter &&
                    Math.abs(gA - gx[p]!) + Math.abs(gB - gy[p]!) <= gradTolerance
                ) {
                    contestA[p] = meshId;
                    contestB[p] = o2;
                    contestOpposite[p] = face[p] !== faceSign ? 1 : 0;
                    contestTriA[p] = triId;
                    contestTriB[p] = ownerTri[p]!;
                } else if (d < -jitter && !seeThrough) {
                    contestA[p] = -1;
                }
                if (d <= 0) {
                    if (zWrite) {
                        depth[p] = zq;
                        owner[p] = meshId;
                        ownerTri[p] = triId;
                        gx[p] = gA;
                        gy[p] = gB;
                        face[p] = faceSign;
                    } else if (o2 < 0) {
                        owner[p] = -2 - meshId; // (seen, depth not written)
                    }
                    // (see-through layers summed: what is seen, not the order blended)
                    signature[p] = seeThrough ? (signature[p]! + Math.imul(meshId + 1, HASH)) | 0 : meshId + 1;
                }
            }
        }
    };

    const clipNear = (n: number): number => {
        // Sutherland-Hodgman on dist >= near (poly -> tmp -> poly)
        let out = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const ad = poly[3 * i + 2]!;
            const bd = poly[3 * j + 2]!;
            const ain = ad >= near;
            const bin = bd >= near;
            if (ain) {
                tmp[3 * out] = poly[3 * i]!;
                tmp[3 * out + 1] = poly[3 * i + 1]!;
                tmp[3 * out + 2] = ad;
                out++;
            }
            if (ain !== bin) {
                const t = (near - ad) / (bd - ad);
                tmp[3 * out] = poly[3 * i]! + t * (poly[3 * j]! - poly[3 * i]!);
                tmp[3 * out + 1] = poly[3 * i + 1]! + t * (poly[3 * j + 1]! - poly[3 * i + 1]!);
                tmp[3 * out + 2] = near;
                out++;
            }
        }
        poly.set(tmp.subarray(0, 3 * out));
        return out;
    };

    const project = (n: number): void => {
        for (let i = 0; i < n; i++) {
            const d = poly[3 * i + 2]!;
            scr[3 * i] = (poly[3 * i]! / (d * cam.tanX) + 1) * sx;
            scr[3 * i + 1] = (1 - poly[3 * i + 1]! / (d * cam.tanY)) * sy;
            scr[3 * i + 2] = (Q * (d - near)) / d;
        }
    };

    for (const bucket of drawBuckets(rs, cam)) {
        const list = o.reverse ? [...bucket].reverse() : bucket;
        for (const m of list) {
            mesh = meshes[m]!;
            meshId = m;
            bias = mesh.bias;
            twoSided = mesh.twoSided;
            zWrite = mesh.zWrite;
            seeThrough = mesh.seeThrough;
            if (view.length < mesh.vCount * 3) view = new Float64Array(mesh.vCount * 3);
            for (let v = 0; v < mesh.vCount; v++) {
                const k = 3 * (mesh.vStart + v);
                const dx = positions[k]! - ex;
                const dy = positions[k + 1]! - ey;
                const dz = positions[k + 2]! - ez;
                view[3 * v] = dx * rx + dy * ry + dz * rz;
                view[3 * v + 1] = dx * ux + dy * uy + dz * uz;
                view[3 * v + 2] = dx * fx + dy * fy + dz * fz;
            }
            const vs = mesh.vStart;
            for (let t = mesh.tStart; t < mesh.tStart + mesh.tCount; t++) {
                const a = 3 * (tris[3 * t]! - vs);
                const b = 3 * (tris[3 * t + 1]! - vs);
                const c = 3 * (tris[3 * t + 2]! - vs);
                const da = view[a + 2]!;
                const db = view[b + 2]!;
                const dc = view[c + 2]!;
                if (da < near && db < near && dc < near) continue;
                if (da > cam.far && db > cam.far && dc > cam.far) continue;
                poly[0] = view[a]!;
                poly[1] = view[a + 1]!;
                poly[2] = da;
                poly[3] = view[b]!;
                poly[4] = view[b + 1]!;
                poly[5] = db;
                poly[6] = view[c]!;
                poly[7] = view[c + 1]!;
                poly[8] = dc;
                triId = t;
                let n = 3;
                if (da < near || db < near || dc < near) n = clipNear(3);
                project(n);
                for (let k = 1; k + 1 < n; k++) triangle(0, 3 * k, 3 * k + 3);
            }
        }
    }
    for (let p = 0; p < W * H; p++) if (signature[p] !== 0) drawn++;
    frame.drawn = drawn;
}

// --- analysis -------------------------------------------------------------------------------------------------------

export interface ViewSpec {
    camera: Camera;
    spot: number[]; // the skater spot (x, y, z, heading) or the camera (x, y, z, dx, dy, dz) it came from
    label: string;
}

export interface PairStat {
    a: number; // mesh indices, a < b
    b: number;
    pixels: number;
    opposite: number; // of them, facing opposite ways
    copies: number; // of them, between triangles with nearly the same corners
    views: number;
    sum: Vec; // world positions summed
    nearest: number; // inches from the camera
    bestView: number; // the view index with the most pixels of this pair
    bestPixels: number;
}

export interface ViewStat {
    index: number;
    fight: number;
    drawn: number;
    topPair: string;
    topPixels: number;
    orderDiff?: number; // --orders: pixels whose depth-writing surface differs between the two orders
    orderMissed?: number; // of them, not found contested
}

export interface Analysis {
    views: number;
    pixels: number; // width x height x views
    drawn: number; // pixels covered by the level
    fight: number;
    sameSurface: number; // contested pixels between exact copies, or a card's sides in one material (not fights)
    pairs: Map<string, PairStat>;
    perView: ViewStat[];
    orderDiff: number;
    orderMissed: number;
    seconds: number;
}

export interface AnalyseOptions {
    width?: number;
    height?: number;
    jitter?: number;
    orders?: boolean;
    png?: string; // the first view's picture
}

export const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

// The world position seen at a pixel of `depth` (the frame's stored depth).
function unproject(cam: Camera, W: number, H: number, px: number, py: number, depthValue: number): [Vec, number] {
    const Q = cam.far / (cam.far - cam.near);
    const z = Math.min(depthValue / DEPTH_MAX, 0.9999999);
    const dist = cam.near / (1 - z / Q);
    const nx = ((px + 0.5) / W) * 2 - 1;
    const ny = 1 - ((py + 0.5) / H) * 2;
    const p: Vec = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
        p[k] = cam.eye[k]! + dist * (cam.f[k]! + nx * cam.tanX * cam.r[k]! + ny * cam.tanY * cam.u[k]!);
    }
    return [p, dist];
}

// Whether two triangles have the same corners (any order).
export function sameCorners(rs: RasterScene, t: number, u: number, eps = 0.01): boolean {
    if (t === u) return true;
    const P = rs.positions;
    for (let i = 0; i < 3; i++) {
        const a = 3 * rs.tris[3 * t + i]!;
        let found = false;
        for (let j = 0; j < 3 && !found; j++) {
            const b = 3 * rs.tris[3 * u + j]!;
            found =
                Math.abs(P[a]! - P[b]!) <= eps &&
                Math.abs(P[a + 1]! - P[b + 1]!) <= eps &&
                Math.abs(P[a + 2]! - P[b + 2]!) <= eps;
        }
        if (!found) return false;
    }
    return true;
}

export function analyseViews(rs: RasterScene, views: readonly ViewSpec[], o: AnalyseOptions = {}, base = 0): Analysis {
    const start = performance.now();
    const W = o.width ?? DEFAULT_SIZE[0];
    const H = o.height ?? DEFAULT_SIZE[1];
    const jitter = o.jitter ?? DEFAULT_JITTER;
    const frame = new Frame(W, H);
    const plain = o.orders ? new Frame(W, H) : null;
    const reversed = o.orders ? new Frame(W, H) : null;
    const out: Analysis = {
        views: views.length,
        pixels: W * H * views.length,
        drawn: 0,
        fight: 0,
        sameSurface: 0,
        pairs: new Map(),
        perView: [],
        orderDiff: 0,
        orderMissed: 0,
        seconds: 0,
    };
    views.forEach((v, vi) => {
        renderView(rs, v.camera, frame, { width: W, height: H, jitter, track: true });
        out.drawn += frame.drawn;
        const local = new Map<string, number>();
        let fight = 0;
        let invisible = 0;
        for (let p = 0; p < W * H; p++) {
            const a = frame.contestA[p]!;
            if (a < 0) continue;
            const b = frame.contestB[p]!;
            const ta = frame.contestTriA[p]!;
            const tb = frame.contestTriB[p]!;
            const copy = sameCorners(rs, ta, tb);
            const opposite = frame.contestOpposite[p]! !== 0;
            if (
                (copy && sameCorners(rs, ta, tb, 0)) ||
                ((copy || opposite) && rs.meshes[a]!.materialChecksum === rs.meshes[b]!.materialChecksum)
            ) {
                // an exact copy (equal depths on the hardware), or a card's two sides in one material: nothing flickers
                invisible++;
                continue;
            }
            fight++;
            const key = pairKey(a, b);
            local.set(key, (local.get(key) ?? 0) + 1);
            let s = out.pairs.get(key);
            if (!s) {
                s = {
                    a: Math.min(a, b),
                    b: Math.max(a, b),
                    pixels: 0,
                    opposite: 0,
                    copies: 0,
                    views: 0,
                    sum: [0, 0, 0],
                    nearest: Infinity,
                    bestView: -1,
                    bestPixels: 0,
                };
                out.pairs.set(key, s);
            }
            s.pixels++;
            s.opposite += frame.contestOpposite[p]!;
            if (copy) s.copies++;
            const [w, dist] = unproject(v.camera, W, H, p % W, Math.floor(p / W), frame.depth[p]!);
            s.sum[0] += w[0];
            s.sum[1] += w[1];
            s.sum[2] += w[2];
            s.nearest = Math.min(s.nearest, dist);
        }
        let topPair = "";
        let topPixels = 0;
        for (const [key, n] of local) {
            const s = out.pairs.get(key)!;
            s.views++;
            if (n > s.bestPixels) {
                s.bestPixels = n;
                s.bestView = base + vi;
            }
            if (n > topPixels) {
                topPixels = n;
                topPair = key;
            }
        }
        out.fight += fight;
        out.sameSurface += invisible;
        const stat: ViewStat = { index: base + vi, fight, drawn: frame.drawn, topPair, topPixels };
        if (plain && reversed) {
            renderView(rs, v.camera, plain, { width: W, height: H, jitter, track: false });
            renderView(rs, v.camera, reversed, { width: W, height: H, jitter, track: false, reverse: true });
            let diff = 0;
            let missed = 0;
            for (let p = 0; p < W * H; p++) {
                // (the surface whose depth is kept: see-through layers seen or not by the order - a sorting matter,
                // not a fight - and exact copies - drawn in one fixed order in the game - left out)
                const x = plain.owner[p]!;
                const y = reversed.owner[p]!;
                if (x === y) continue;
                if (x >= 0 && y >= 0 && sameCorners(rs, plain.ownerTri[p]!, reversed.ownerTri[p]!, 0)) continue;
                diff++;
                if (frame.contestA[p]! < 0) missed++;
            }
            stat.orderDiff = diff;
            stat.orderMissed = missed;
            out.orderDiff += diff;
            out.orderMissed += missed;
        }
        out.perView.push(stat);
        if (o.png && vi === 0) writePng(o.png, frame);
    });
    out.seconds = (performance.now() - start) / 1000;
    return out;
}

// Merges analyses of disjoint view sets.
export function mergeAnalyses(parts: readonly Analysis[]): Analysis {
    const out: Analysis = {
        views: 0,
        pixels: 0,
        drawn: 0,
        fight: 0,
        sameSurface: 0,
        pairs: new Map(),
        perView: [],
        orderDiff: 0,
        orderMissed: 0,
        seconds: 0,
    };
    for (const a of parts) {
        out.views += a.views;
        out.pixels += a.pixels;
        out.drawn += a.drawn;
        out.fight += a.fight;
        out.sameSurface += a.sameSurface;
        out.orderDiff += a.orderDiff;
        out.orderMissed += a.orderMissed;
        out.seconds = Math.max(out.seconds, a.seconds);
        out.perView.push(...a.perView);
        for (const [key, s] of a.pairs) {
            const t = out.pairs.get(key);
            if (!t) {
                out.pairs.set(key, { ...s, sum: [...s.sum] });
                continue;
            }
            t.pixels += s.pixels;
            t.opposite += s.opposite;
            t.copies += s.copies;
            t.views += s.views;
            for (let k = 0; k < 3; k++) t.sum[k]! += s.sum[k]!;
            t.nearest = Math.min(t.nearest, s.nearest);
            if (s.bestPixels > t.bestPixels) {
                t.bestPixels = s.bestPixels;
                t.bestView = s.bestView;
            }
        }
    }
    out.perView.sort((x, y) => x.index - y.index);
    return out;
}

// --- picture (one view: the meshes in hashed colours, the fight pixels magenta) ---------------------------------

function crcTable(): Uint32Array {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
}

export function writePng(file: string, frame: Frame): void {
    const { width: W, height: H } = frame;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W * 3 + 1)] = 0;
        for (let x = 0; x < W; x++) {
            const p = y * W + x;
            const at = y * (W * 3 + 1) + 1 + x * 3;
            let rgb: [number, number, number];
            if (frame.contestA[p]! >= 0) rgb = [255, 0, 255];
            else if (frame.signature[p] === 0) rgb = [0, 0, 0];
            else {
                const h = Math.imul(frame.signature[p]!, HASH) >>> 0;
                // shaded by depth (near light)
                const shade = 0.35 + 0.65 * (1 - ((frame.depth[p]! / DEPTH_MAX) ** 64 || 0));
                rgb = [64 + (h & 0x7f), 64 + ((h >>> 8) & 0x7f), 64 + ((h >>> 16) & 0x7f)].map((c) =>
                    Math.round(c * shade),
                ) as [number, number, number];
            }
            raw[at] = rgb[0];
            raw[at + 1] = rgb[1];
            raw[at + 2] = rgb[2];
        }
    }
    const table = crcTable();
    const crc = (b: Buffer): number => {
        let c = 0xffffffff;
        for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer): Buffer => {
        const head = Buffer.alloc(4);
        head.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
        const tail = Buffer.alloc(4);
        tail.writeUInt32BE(crc(body));
        return Buffer.concat([head, body, tail]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    fs.writeFileSync(
        file,
        Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk("IHDR", ihdr),
            chunk("IDAT", zlib.deflateSync(raw)),
            chunk("IEND", Buffer.alloc(0)),
        ]),
    );
}

// --- the level's files ----------------------------------------------------------------------------------------------

export interface Level {
    name: string;
    scene: thug2Scene.Scene;
    col: thug2Col.ColFile | null;
    hidden: Set<number>; // sectors not drawn at start
    names: Map<number, string>; // checksum -> text (the level's qb)
    toggles: Toggles; // what its scripts show and hide
}

const CLASS_GEOMETRY = checksum("LevelGeometry");
const CLASS_LOCAL = new Set([checksum("LevelObject"), checksum("GameObject")]);

// The node array's sectors the game doesn't draw at start in world space.
export function hiddenSectors(qbData: Uint8Array, name = "qb"): { hidden: Set<number>; names: Map<number, string> } {
    const hidden = new Set<number>();
    let q: QbFile;
    try {
        // (THUG2's qb: the random tokens carry u16 weights - read without them, a level whose scripts have a Random
        // fails to parse and every sector would count as drawn)
        q = new QbFile(qbData, name, true);
    } catch {
        try {
            q = new QbFile(qbData, name);
        } catch {
            return { hidden, names: new Map() };
        }
    }
    let array: QbValue[] = [];
    for (const [, value] of q.globals) {
        if (!Array.isArray(value) || value.length <= array.length) continue;
        if (value.some((v) => v instanceof Struct && v.get("Name") instanceof Name)) array = value;
    }
    // (shared parts - an unnamed name of a global structure, ncomp_LevelGeometry_1 - put in the nodes)
    const globals = new Map<number, QbValue>(q.globals.map(([k, v]) => [k.value, v]));
    for (const node of expandIncludes(array, globals)) {
        if (!(node instanceof Struct)) continue;
        const n = node.get("Name");
        const c = node.get("Class");
        if (!(n instanceof Name) || !(c instanceof Name)) continue;
        if (CLASS_LOCAL.has(c.value)) hidden.add(n.value);
        else if (c.value === CLASS_GEOMETRY && !node.hasFlag("CreatedAtStart")) hidden.add(n.value);
    }
    return { hidden, names: q.names };
}

function findFile(dir: string, file: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const want = file.toLowerCase();
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === want);
    return hit ? path.join(dir, hit) : null;
}

export function readLevel(folder: string, level: string): Level {
    const dir = findFile(folder, level) ?? path.join(folder, level);
    const scn = findFile(dir, `${level}.scn.xbx`);
    if (!scn) pyExit(`${level}: no ${level}.scn.xbx in ${dir}`);
    const scene = thug2Scene.readScene(fs.readFileSync(scn), scn);
    const colFile = findFile(dir, `${level}.col.xbx`);
    let col: thug2Col.ColFile | null = null;
    if (colFile) {
        try {
            col = thug2Col.readCol(fs.readFileSync(colFile), colFile);
        } catch {
            col = null;
        }
    }
    const qbFile = findFile(dir, `${level}.qb`);
    const { hidden, names } = qbFile
        ? hiddenSectors(fs.readFileSync(qbFile), qbFile)
        : { hidden: new Set<number>(), names: new Map() };
    return { name: level, scene, col, hidden, names, toggles: levelToggles(dir, scene) };
}

// --- viewpoints -----------------------------------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SKIP_FACES = thug2Col.FACE_NON_COLLIDABLE | thug2Col.FACE_TRIGGER;

// Skater spots over the level's up-facing collision (area-weighted, `seed`): x, y, z, heading - `headings` each.
export function groundSpots(
    col: thug2Col.ColFile,
    count: number,
    headings: number,
    seed = 1,
    hidden: ReadonlySet<number> = new Set(),
): number[][] {
    const faces: [Vec, Vec, Vec][] = [];
    const cumulative: number[] = [];
    let total = 0;
    let up = 0;
    let down = 0;
    const candidates: [Vec, Vec, Vec, number][] = [];
    for (const o of col.objects) {
        if (hidden.has(o.checksum)) continue;
        for (const f of o.faces) {
            if (f[0] & SKIP_FACES) continue;
            const a = o.verts[f[2]] as Vec | undefined;
            const b = o.verts[f[3]] as Vec | undefined;
            const c = o.verts[f[4]] as Vec | undefined;
            if (!a || !b || !c) continue;
            const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            const area = Math.hypot(...n) / 2;
            if (!(area > 1)) continue;
            const ny = n[1] / (2 * area);
            if (ny > 0.7) up += area;
            if (ny < -0.7) down += area;
            candidates.push([a, b, c, ny]);
        }
    }
    // (the collision's winding: whichever way most level ground faces)
    const sign = up >= down ? 1 : -1;
    for (const [a, b, c, ny] of candidates) {
        if (ny * sign < 0.7) continue;
        const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        total += Math.hypot(...n) / 2;
        faces.push([a, b, c]);
        cumulative.push(total);
    }
    if (!faces.length) return [];
    const rnd = mulberry32(seed);
    const out: number[][] = [];
    for (let i = 0; i < count; i++) {
        const target = rnd() * total;
        let lo = 0;
        let hi = cumulative.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cumulative[mid]! < target) lo = mid + 1;
            else hi = mid;
        }
        const [a, b, c] = faces[lo]!;
        let u = rnd();
        let v = rnd();
        if (u + v > 1) {
            u = 1 - u;
            v = 1 - v;
        }
        const p: Vec = [0, 1, 2].map((k) => a[k]! + u * (b[k]! - a[k]!) + v * (c[k]! - a[k]!)) as Vec;
        const h0 = rnd() * 360;
        for (let k = 0; k < headings; k++) out.push([p[0], p[1], p[2], (h0 + (k * 360) / headings) % 360]);
    }
    return out;
}

export function spotView(spot: readonly number[], lens: LensOptions = {}): ViewSpec {
    const camera = skaterCamera([spot[0]!, spot[1]!, spot[2]!], spot[3] ?? 0, lens);
    return { camera, spot: [...spot], label: `at ${fmt(spot)}` };
}

export function cameraView(c: readonly number[], lens: LensOptions = {}): ViewSpec {
    const camera = lookCamera([c[0]!, c[1]!, c[2]!], [c[3]!, c[4]!, c[5]!], lens);
    return { camera, spot: [...c], label: `camera ${fmt(c)}` };
}

const fmt = (v: readonly number[]): string => v.map((x) => (Math.abs(x) < 10 ? x.toFixed(3) : x.toFixed(0))).join(",");

// --- threads --------------------------------------------------------------------------------------------------------

interface WorkerInput {
    zfightRaster: true;
    positions: Float32Array;
    tris: Uint32Array;
    meshes: DrawMesh[];
    sorted: number[];
    firstTransparent: number;
    firstFlagged: number;
    flaggedCount: number;
    views: ViewSpec[];
    base: number;
    options: AnalyseOptions;
}

const serialise = (a: Analysis) => ({ ...a, pairs: [...a.pairs.entries()] });
type Serialised = ReturnType<typeof serialise>;
const deserialise = (s: Serialised): Analysis => ({ ...s, pairs: new Map(s.pairs) });

if (!isMainThread && (workerData as WorkerInput | null)?.zfightRaster) {
    const w = workerData as WorkerInput;
    const rs: RasterScene = {
        positions: w.positions,
        tris: w.tris,
        meshes: w.meshes,
        sorted: w.sorted,
        firstTransparent: w.firstTransparent,
        firstFlagged: w.firstFlagged,
        flaggedCount: w.flaggedCount,
    };
    parentPort!.postMessage(serialise(analyseViews(rs, w.views, w.options, w.base)));
}

// The views shared out over `workers` threads (rs built with shared: true).
export async function analyseParallel(
    rs: RasterScene,
    views: readonly ViewSpec[],
    o: AnalyseOptions,
    workers: number,
): Promise<Analysis> {
    if (workers <= 1 || views.length < 2) return analyseViews(rs, views, o);
    const n = Math.min(workers, views.length);
    const chunks: ViewSpec[][] = Array.from({ length: n }, () => []);
    const bases: number[][] = Array.from({ length: n }, () => []);
    // (interleaved so each thread gets a mix; each view keeps its index)
    views.forEach((v, i) => {
        chunks[i % n]!.push(v);
        bases[i % n]!.push(i);
    });
    const parts = await Promise.all(
        chunks.map(
            (chunk, k) =>
                new Promise<Analysis>((resolve, reject) => {
                    // one worker per chunk; views keep their global index through `base` + a remap below
                    const input: WorkerInput = {
                        zfightRaster: true,
                        positions: rs.positions,
                        tris: rs.tris,
                        meshes: rs.meshes,
                        sorted: rs.sorted,
                        firstTransparent: rs.firstTransparent,
                        firstFlagged: rs.firstFlagged,
                        flaggedCount: rs.flaggedCount,
                        views: chunk,
                        base: 0,
                        options: { ...o },
                    };
                    if (k !== 0) delete input.options.png;
                    const worker = new Worker(new URL(import.meta.url), { workerData: input });
                    worker.once("message", (m: Serialised) => {
                        const a = deserialise(m);
                        const remap = bases[k]!;
                        for (const v of a.perView) v.index = remap[v.index]!;
                        for (const s of a.pairs.values()) if (s.bestView >= 0) s.bestView = remap[s.bestView]!;
                        resolve(a);
                    });
                    worker.once("error", reject);
                }),
        ),
    );
    return mergeAnalyses(parts);
}

// --- report ---------------------------------------------------------------------------------------------------------

export type PairClass = "states" | "copy" | "layer" | "opposite" | "duplicate" | "overlap" | "self";

// `toggles`: what the level's scripts show and hide - two sectors neither of which is there whenever the other is
// are alternate states ("states": THPS3 Foundry's ValveC_Panel_Red / _OFF), most likely never drawn together.
export function classOf(s: PairStat, rs: RasterScene, toggles?: Toggles): PairClass {
    const a = rs.meshes[s.a]!;
    const b = rs.meshes[s.b]!;
    if (s.a === s.b) return "self";
    if (
        toggles &&
        a.sector !== b.sector &&
        !thereWhenever(toggles, a.sectorChecksum, b.sectorChecksum) &&
        !thereWhenever(toggles, b.sectorChecksum, a.sectorChecksum)
    )
        return "states";
    if (s.copies * 2 > s.pixels) return "copy";
    if (a.seeThrough || b.seeThrough) return "layer";
    if (s.opposite * 2 > s.pixels) return "opposite";
    if (a.texture === b.texture && a.texture !== 0) return "duplicate";
    return "overlap";
}

const hex = (x: number): string => x.toString(16).toUpperCase().padStart(8, "0");
const pct = (a: number, b: number): string => (b ? ((100 * a) / b).toFixed(3) : "0.000");

export interface LevelResult {
    level: string;
    analysis: Analysis;
    rs: RasterScene;
    views: ViewSpec[];
    names: Map<number, string>;
    toggles?: Toggles;
    loadSeconds: number;
}

export function meshLabel(r: LevelResult, m: number): string {
    const mesh = r.rs.meshes[m]!;
    const name = r.names.get(mesh.sectorChecksum) ?? hex(mesh.sectorChecksum);
    const flags = [
        mesh.seeThrough ? "see-through" : "",
        mesh.decal ? "decal" : "",
        mesh.zBias ? `zbias ${mesh.zBias}` : "",
        mesh.twoSided ? "2-sided" : "",
    ].filter(Boolean);
    return `${name}#${mesh.mesh} (mat ${hex(mesh.materialChecksum)}, tex ${mesh.textures.map(hex).join("/") || "-"}${flags.length ? `, ${flags.join(", ")}` : ""})`;
}

export function sortedPairs(a: Analysis): PairStat[] {
    return [...a.pairs.values()].sort((x, y) => y.pixels - x.pixels || x.a - y.a || x.b - y.b);
}

export function report(r: LevelResult, top: number): string[] {
    const a = r.analysis;
    const out: string[] = [];
    out.push(
        `${r.level}: ${a.views} views, z-fight pixels ${a.fight} / ${a.pixels} = ${pct(a.fight, a.pixels)}% ` +
            `(${pct(a.fight, a.drawn)}% of the level's drawn pixels), ${a.pairs.size} mesh pairs; ` +
            `${a.sameSurface} more between exact copies / a card's sides; ` +
            `${r.rs.meshes.length} meshes, ${r.rs.tris.length / 3} triangles; ` +
            `load ${r.loadSeconds.toFixed(1)} s, render ${a.seconds.toFixed(1)} s`,
    );
    if (a.orderDiff || a.orderMissed) {
        out.push(
            `  draw order reversed: the surface kept differs at ${a.orderDiff} pixels (exact copies aside), ` +
                `${a.orderMissed} of them not contested (where two surfaces cross)`,
        );
    }
    const classes = new Map<PairClass, [number, number]>();
    const pairs = sortedPairs(a);
    for (const s of pairs) {
        const c = classOf(s, r.rs, r.toggles);
        const v = classes.get(c) ?? [0, 0];
        classes.set(c, [v[0] + s.pixels, v[1] + 1]);
    }
    out.push(
        `  by class: ${[...classes.entries()]
            .sort((x, y) => y[1][0] - x[1][0])
            .map(([c, [px, n]]) => `${c} ${px} px / ${n} pairs`)
            .join("; ")}`,
    );
    for (const s of pairs.slice(0, top)) {
        const at = s.sum.map((x) => x / s.pixels);
        const best = r.views[s.bestView];
        out.push(
            `  ${s.pixels} px in ${s.views} views [${classOf(s, r.rs, r.toggles)}${s.opposite ? `, ${s.opposite} px opposite` : ""}] ` +
                `around (${at.map((x) => x.toFixed(0)).join(", ")}), nearest ${(s.nearest / 39.37).toFixed(1)} m`,
        );
        out.push(`      ${meshLabel(r, s.a)}`);
        out.push(`      ${meshLabel(r, s.b)}`);
        if (best) out.push(`      worst view: ${best.label} (${s.bestPixels} px)`);
    }
    const worst = [...a.perView].sort((x, y) => y.fight - x.fight).slice(0, Math.min(top, 10));
    if (worst.length && worst[0]!.fight) {
        out.push("  worst views:");
        for (const v of worst) {
            if (!v.fight) break;
            const spec = r.views[v.index]!;
            out.push(`    ${v.fight} px ${spec.label} (top pair ${v.topPixels} px)`);
        }
    }
    return out;
}

export const CSV_HEADER =
    "level,pixels,views,class,opposite,x,y,z,nearest_m,sector_a,mesh_a,material_a,texture_a,sector_b,mesh_b,material_b,texture_b,worst_view";

export function csvRows(r: LevelResult): string[] {
    return sortedPairs(r.analysis).map((s) => {
        const a = r.rs.meshes[s.a]!;
        const b = r.rs.meshes[s.b]!;
        const at = s.sum.map((x) => (x / s.pixels).toFixed(0));
        const name = (c: number): string => r.names.get(c) ?? hex(c);
        return [
            r.level,
            s.pixels,
            s.views,
            classOf(s, r.rs, r.toggles),
            s.opposite,
            ...at,
            (s.nearest / 39.37).toFixed(1),
            name(a.sectorChecksum),
            a.mesh,
            hex(a.materialChecksum),
            hex(a.texture),
            name(b.sectorChecksum),
            b.mesh,
            hex(b.materialChecksum),
            hex(b.texture),
            `"${r.views[s.bestView]?.label ?? ""}"`,
        ].join(",");
    });
}

// --- the level as a whole -------------------------------------------------------------------------------------------

export interface LevelOptions extends AnalyseOptions, LensOptions {
    views?: number;
    headings?: number;
    seed?: number;
    at?: number[][];
    cameras?: number[][];
    workers?: number;
}

export function levelViews(level: Level, o: LevelOptions): ViewSpec[] {
    const lens: LensOptions = {};
    if (o.aspect !== undefined) lens.aspect = o.aspect;
    if (o.fov !== undefined) lens.fov = o.fov;
    if (o.drawDistanceScale !== undefined) lens.drawDistanceScale = o.drawDistanceScale;
    const views: ViewSpec[] = [];
    for (const c of o.cameras ?? []) views.push(cameraView(c, lens));
    for (const s of o.at ?? []) views.push(spotView(s, lens));
    if (!views.length && level.col) {
        for (const s of groundSpots(
            level.col,
            o.views ?? DEFAULT_VIEWS,
            o.headings ?? DEFAULT_HEADINGS,
            o.seed ?? 1,
            level.hidden,
        )) {
            views.push(spotView(s, lens));
        }
    }
    return views;
}

export async function checkLevel(folder: string, name: string, o: LevelOptions = {}): Promise<LevelResult> {
    const t0 = performance.now();
    const level = readLevel(folder, name);
    const rs = buildRasterScene(level.scene, { hidden: level.hidden, shared: (o.workers ?? 1) > 1 });
    const views = levelViews(level, o);
    const loadSeconds = (performance.now() - t0) / 1000;
    const analysis = await analyseParallel(rs, views, o, o.workers ?? 1);
    return { level: name, analysis, rs, views, names: level.names, toggles: level.toggles, loadSeconds };
}

// A gate for converter tests (not on real levels yet): the level's z-fight pixels, single-threaded, at most `maxPixels`.
export function assertNoZFight(
    level: { folder: string; name: string } | thug2Scene.Scene,
    maxPixels: number,
    views?: readonly ViewSpec[],
    o: LevelOptions = {},
): Analysis {
    let rs: RasterScene;
    let list: readonly ViewSpec[];
    if ("sectors" in level) {
        rs = buildRasterScene(level);
        list = views ?? [];
    } else {
        const l = readLevel(level.folder, level.name);
        rs = buildRasterScene(l.scene, { hidden: l.hidden });
        list = views ?? levelViews(l, o);
    }
    const a = analyseViews(rs, list, o);
    assert.ok(
        a.fight <= maxPixels,
        `z-fighting: ${a.fight} pixels (at most ${maxPixels}), ${a.pairs.size} mesh pairs: ` +
            sortedPairs(a)
                .slice(0, 5)
                .map(
                    (s) =>
                        `${hex(rs.meshes[s.a]!.sectorChecksum)}/${hex(rs.meshes[s.b]!.sectorChecksum)} ${s.pixels} px`,
                )
                .join(", "),
    );
    return a;
}

// --- command line ---------------------------------------------------------------------------------------------------

const USAGE = `usage: zfight_raster.ts [-h] [--views N] [--headings K] [--seed S] [--size WxH] [--aspect A] [--jitter U]
                        [--top N] [--workers N] [--orders] [--draw-distance-scale X] [--at x,y,z[,heading]]...
                        [--camera x,y,z,dx,dy,dz]... [--png FILE] [--csv FILE] [--json FILE] folder [level ...]

Z-fight pixels of converted levels, rendered from the skater camera with THUG2's projection and depth buffer.

positional arguments:
  folder               a levels folder (<folder>\\<level>\\<level>.scn.xbx)
  level                levels to check (default: every folder in it with a scene, skies left out)

options:
  --views N            skater spots sampled over the level's ground (default ${DEFAULT_VIEWS})
  --headings K         directions looked from each (default ${DEFAULT_HEADINGS})
  --seed S             the spots' random seed (default 1)
  --size WxH           the picture's size (default ${DEFAULT_SIZE[0]}x${DEFAULT_SIZE[1]})
  --aspect A           the screen's aspect (default 16:9 = ${DEFAULT_ASPECT.toFixed(4)})
  --jitter U           depth steps within which a test is contested (default ${DEFAULT_JITTER})
  --top N              mesh pairs listed per level (default 15)
  --workers N          threads (default: CPUs - 1)
  --orders             also render with the draw order reversed in each bucket and compare
  --draw-distance-scale X   the far plane's scale (default 1)
  --at x,y,z[,heading] a skater spot to look from (repeatable; instead of the sampled ones)
  --camera x,y,z,dx,dy,dz   a camera to look from (repeatable; the screenshot sidecar's position / looking along)
  --png FILE           the first view's picture (fight pixels magenta)
  --csv FILE           every pair of every level
  --json FILE          the per-level summary`;

const numbers = (s: string): number[] =>
    s
        .replace(/[()\s]/g, "")
        .split(",")
        .map((x) => {
            const n = Number(x);
            if (!Number.isFinite(n)) pyExit(`not a number list: ${s}`);
            return n;
        });

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const { values, positionals } = parseCli(USAGE, {
        args: [...argv],
        allowPositionals: true,
        options: {
            views: { type: "string" },
            headings: { type: "string" },
            seed: { type: "string" },
            size: { type: "string" },
            aspect: { type: "string" },
            jitter: { type: "string" },
            top: { type: "string" },
            workers: { type: "string" },
            orders: { type: "boolean" },
            "draw-distance-scale": { type: "string" },
            at: { type: "string", multiple: true },
            camera: { type: "string", multiple: true },
            png: { type: "string" },
            csv: { type: "string" },
            json: { type: "string" },
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
    const [w, h] = (values.size ?? `${DEFAULT_SIZE[0]}x${DEFAULT_SIZE[1]}`).split("x").map(Number) as [number, number];
    const o: LevelOptions = {
        width: w,
        height: h,
        workers: values.workers ? Number(values.workers) : Math.max(1, os.cpus().length - 1),
        views: values.views ? Number(values.views) : DEFAULT_VIEWS,
        headings: values.headings ? Number(values.headings) : DEFAULT_HEADINGS,
        seed: values.seed ? Number(values.seed) : 1,
        jitter: values.jitter ? Number(values.jitter) : DEFAULT_JITTER,
        orders: !!values.orders,
        at: (values.at ?? []).map(numbers),
        cameras: (values.camera ?? []).map(numbers),
    };
    if (values.aspect) o.aspect = Number(values.aspect);
    if (values["draw-distance-scale"]) o.drawDistanceScale = Number(values["draw-distance-scale"]);
    if (values.png) o.png = values.png;
    const top = values.top ? Number(values.top) : 15;
    const csv: string[] = [CSV_HEADER];
    const summary: object[] = [];
    for (const level of levels) {
        const r = await checkLevel(folder, level, o);
        for (const line of report(r, top)) print(line);
        csv.push(...csvRows(r));
        const classes: Record<string, number> = {};
        for (const s of r.analysis.pairs.values()) {
            const c = classOf(s, r.rs, r.toggles);
            classes[c] = (classes[c] ?? 0) + s.pixels;
        }
        summary.push({
            level,
            views: r.analysis.views,
            pixels: r.analysis.pixels,
            drawn: r.analysis.drawn,
            fight: r.analysis.fight,
            pairs: r.analysis.pairs.size,
            classes,
            seconds: r.loadSeconds + r.analysis.seconds,
            top: sortedPairs(r.analysis)
                .slice(0, 5)
                .map((s) => ({
                    pixels: s.pixels,
                    class: classOf(s, r.rs, r.toggles),
                    a: meshLabel(r, s.a),
                    b: meshLabel(r, s.b),
                })),
        });
    }
    if (values.csv) fs.writeFileSync(values.csv, `${csv.join("\n")}\n`);
    if (values.json) fs.writeFileSync(values.json, `${JSON.stringify(summary, null, 1)}\n`);
    return 0;
}

if (isMainThread && isMain(import.meta.url)) await runMain(() => main());
