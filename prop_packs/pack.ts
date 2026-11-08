// NOT ORIGINAL - prop packs: pieces of a THUG2 level (a scenery sector, the collision that belongs to it and the
// grind rails on it) cut out of the level's own files into a small scene of their own, which another level loads
// beside its own scene (LoadScene / LoadCollision - prop_packs.ts, retail_props.ts).
//
// A pack is levels\<id>\<id>.scn.xbx / .tex.xbx / .col.xbx (THUG2's formats, written by the converter core) and
// <id>.txt, its manifest (below). The piece is moved so that the middle of its bottom is at the origin: the level
// editor puts it where it is dropped (its layout's sector / clone records), the retail export bakes it there.
//
// What belongs to a piece (as the level editor's own grouping - src/editor/level_editor_scenery.h select_group, and
// its shared collision rules):
//   - its render sector (a LevelGeometry node's Name=), with the materials and textures its meshes use;
//   - its collision object (the same checksum), and the collision-only objects (no render sector of their name)
//     lying wholly inside its box grown by NEAR - LA's Fire_Coll01 beside Fire_Tender - merged into one object;
//   - the rail nodes whose Cluster= is the piece, or that lie inside its box grown by NEAR: their positions, terrain
//     and the links between them (links out of the set are dropped). Their TriggerScripts (gaps, sounds) are not
//     carried (a later stage: scripts).

import * as fs from "node:fs";
import * as path from "node:path";
import * as dxt from "thug2-level-converter-core/level_port/dxt.ts";
import { expandIncludes } from "thug2-level-converter-core/level_port/nodes.ts";
import { checksum, Name, QbFile, type QbValue, Struct, Vector } from "thug2-level-converter-core/level_port/qb.ts";
import { readTex, type TexFile, type Texture, writeTex } from "thug2-level-converter-core/level_port/tex.ts";
import {
    buildTree,
    type ColFile,
    type ColObject,
    type Face,
    readCol,
    setReaches,
    writeCol,
} from "thug2-level-converter-core/level_port/thug2_col.ts";
import {
    type Material,
    readScene,
    type Scene,
    type Sector,
    writeScene,
} from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { findCaseless } from "thug2-level-converter-core/lib/install.ts";
import { hex8 } from "thug2-level-converter-core/lib/text.ts";
import type { Picture } from "../menu_level/loading_art.ts";

export const PREFIX = "pp_";
export const NEAR = 24;
export const MANIFEST_VERSION = 1;

export interface V3 {
    x: number;
    y: number;
    z: number;
}

export interface Placement {
    quarters: number;
    offset: V3;
    scale: V3;
}

export const IDENTITY: Placement = { quarters: 0, offset: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };

// --- placing (as tools/game/apply_layout.ts: the editor's get_quarter_turn(per_axis(v, scale), quarters) + offset) ---

export function quarterTurn(v: V3, quarters: number): V3 {
    switch (quarters & 3) {
        case 1:
            return { x: v.z, y: v.y, z: -v.x };
        case 2:
            return { x: -v.x, y: v.y, z: -v.z };
        case 3:
            return { x: -v.z, y: v.y, z: v.x };
        default:
            return { x: v.x, y: v.y, z: v.z };
    }
}

export function applyPlacement(p: Placement, v: V3): V3 {
    const t = quarterTurn({ x: v.x * p.scale.x, y: v.y * p.scale.y, z: v.z * p.scale.z }, p.quarters);
    return { x: t.x + p.offset.x, y: t.y + p.offset.y, z: t.z + p.offset.z };
}

const FVF_XYZ = 0x002;
const FVF_POSITION_MASK = 0x400e;
const FVF_NORMAL = 0x010;
const FVF_DIFFUSE = 0x040;

function normalOffset(fvf: number, stride: number): number {
    if (fvf >= 0x10000 || (fvf & FVF_POSITION_MASK) !== FVF_XYZ || !(fvf & FVF_NORMAL) || stride < 24) return -1;
    return 12;
}

function colourOffset(fvf: number): number {
    if (fvf >= 0x10000 || (fvf & FVF_POSITION_MASK) !== FVF_XYZ || !(fvf & FVF_DIFFUSE)) return -1;
    return fvf & FVF_NORMAL ? 24 : 12;
}

interface Box {
    min: V3;
    max: V3;
}

function boundsOf(points: readonly V3[]): Box & { centre: V3; radius: number } {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const p of points) {
        min.x = Math.min(min.x, p.x);
        min.y = Math.min(min.y, p.y);
        min.z = Math.min(min.z, p.z);
        max.x = Math.max(max.x, p.x);
        max.y = Math.max(max.y, p.y);
        max.z = Math.max(max.z, p.z);
    }
    const centre = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
    let radius = 0;
    for (const p of points) radius = Math.max(radius, Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z));
    return { min, max, centre, radius };
}

// A sector's render vertices (and normals) placed; its meshes' and its own boxes and spheres made again. Scaled
// normals are turned only (stage 1: the editor's prop placements aren't scaled by the pack itself).
export function placeSector(sector: Sector, p: Placement): void {
    const all: V3[] = [];
    for (const mesh of sector.meshes) {
        const fvf = mesh.vertexShader[0] ?? 0;
        const stride = mesh.stride;
        const normalAt = normalOffset(fvf, stride);
        const points: V3[] = [];
        mesh.buffers = mesh.buffers.map(([flag, data]) => {
            const copy = Buffer.from(data);
            if (!(fvf & FVF_XYZ) || stride < 12 || copy.length < stride * mesh.vertexCount) return [flag, copy];
            for (let v = 0; v < mesh.vertexCount; v++) {
                const at = v * stride;
                const q = applyPlacement(p, {
                    x: copy.readFloatLE(at),
                    y: copy.readFloatLE(at + 4),
                    z: copy.readFloatLE(at + 8),
                });
                copy.writeFloatLE(q.x, at);
                copy.writeFloatLE(q.y, at + 4);
                copy.writeFloatLE(q.z, at + 8);
                points.push(q);
                if (normalAt >= 0 && (p.quarters & 3) !== 0) {
                    const n = quarterTurn(
                        {
                            x: copy.readFloatLE(at + normalAt),
                            y: copy.readFloatLE(at + normalAt + 4),
                            z: copy.readFloatLE(at + normalAt + 8),
                        },
                        p.quarters,
                    );
                    copy.writeFloatLE(n.x, at + normalAt);
                    copy.writeFloatLE(n.y, at + normalAt + 4);
                    copy.writeFloatLE(n.z, at + normalAt + 8);
                }
            }
            return [flag, copy];
        });
        if (points.length) {
            const b = boundsOf(points);
            mesh.bbox = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
            mesh.sphere = [b.centre.x, b.centre.y, b.centre.z, b.radius];
            all.push(...points);
        }
    }
    if (all.length) {
        const b = boundsOf(all);
        sector.bbox = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
        sector.sphere = [b.centre.x, b.centre.y, b.centre.z, b.radius];
    }
}

// A collision object placed: vertices, box, tree and reaches made again (floats: fixed-point vertices dropped).
export function placeCollision(o: ColObject, p: Placement): void {
    o.verts = o.verts.map((v) => {
        const q = applyPlacement(p, { x: v[0]!, y: v[1]!, z: v[2]! });
        return [q.x, q.y, q.z];
    });
    if (!o.verts.length) return;
    const b = boundsOf(o.verts.map((v) => ({ x: v[0]!, y: v[1]!, z: v[2]! })));
    o.bbox = [b.min.x, b.min.y, b.min.z, 1, b.max.x, b.max.y, b.max.z, 1];
    o.fixedVerts = 0;
    o.bsp = buildTree(o.verts, o.faces);
    setReaches(o);
}

export function cloneSector(s: Sector, name: number): Sector {
    return {
        ...s,
        checksum: name,
        bbox: [...s.bbox],
        sphere: [...s.sphere],
        meshes: s.meshes.map((m) => ({
            ...m,
            buffers: m.buffers.map(([f, d]) => [f, Buffer.from(d)] as [number, Buffer]),
        })),
    };
}

export function cloneCollision(o: ColObject, name: number): ColObject {
    return {
        ...o,
        checksum: name,
        bbox: [...o.bbox],
        verts: o.verts.map((v) => [...v]),
        faces: o.faces.map((f) => [...f] as Face),
        intensities: Buffer.from(o.intensities),
        reach: Buffer.from(o.reach),
    };
}

// Several collision objects as one (named `name`): vertices and faces appended, the tree and reaches made again.
export function mergeCollision(objects: readonly ColObject[], name: number): ColObject {
    const first = objects[0]!;
    const verts: number[][] = [];
    const faces: Face[] = [];
    const intensities: Buffer[] = [];
    for (const o of objects) {
        const base = verts.length;
        verts.push(...o.verts.map((v) => [v[0]!, v[1]!, v[2]!]));
        faces.push(...o.faces.map((f) => [f[0], f[1], f[2] + base, f[3] + base, f[4] + base] as Face));
        const own = Buffer.alloc(o.verts.length, 0x80);
        o.intensities.copy(own, 0, 0, Math.min(o.intensities.length, o.verts.length));
        intensities.push(own);
    }
    const merged: ColObject = {
        ...first,
        checksum: name,
        smallFaces: verts.length > 255 ? 0 : first.smallFaces,
        fixedVerts: 0,
        verts,
        faces,
        intensities: Buffer.concat(intensities),
        reach: Buffer.alloc(0),
        bbox: [...first.bbox],
    };
    placeCollision(merged, IDENTITY);
    return merged;
}

// --- a level's files ------------------------------------------------------------------------------------------------

export interface RailPoint {
    name: number;
    pos: V3;
    terrain: number; // a TerrainType checksum (0: none)
    links: number[]; // names of the points it links to (within the piece)
    trickObject: boolean;
}

export interface LevelData {
    level: string; // the folder's name (LA)
    dir: string;
    scene: Scene;
    col: ColFile;
    tex: TexFile;
    names: Map<number, string>;
    nodes: Struct[];
}

const SKIPPED = /(_sky|_shell|_net)$|^(mainmenu|default|sk5ed\d*)$/i;

// The THUG2 levels of a game folder (Data\levels\<x> with <x>.scn.xbx and <x>.qb), skies and shells left out.
export function levelsOf(game: string): string[] {
    const root = findCaseless(game, "Data", "levels");
    if (!root) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || SKIPPED.test(entry.name)) continue;
        const dir = path.join(root, entry.name);
        if (findCaseless(dir, `${entry.name}.scn.xbx`) && findCaseless(dir, `${entry.name}.qb`)) out.push(entry.name);
    }
    return out.sort((a, b) => a.localeCompare(b));
}

export function levelDir(game: string, level: string): string {
    const dir = findCaseless(game, "Data", "levels", level);
    if (!dir) throw new Error(`${game}: no Data\\levels\\${level}`);
    return dir;
}

function levelFile(dir: string, level: string, suffix: string): string {
    const file = findCaseless(dir, `${level}${suffix}`);
    if (!file) throw new Error(`${dir}: no ${level}${suffix}`);
    return file;
}

export function readLevel(game: string, level: string, withTextures = true): LevelData {
    const dir = levelDir(game, level);
    const real = path.basename(dir);
    const qb = new QbFile(fs.readFileSync(levelFile(dir, real, ".qb")), `${real}.qb`);
    const globals = new Map<number, QbValue>(qb.globals.map(([n, v]) => [n.value, v]));
    let array: QbValue | undefined;
    for (const [n, v] of qb.globals)
        if (Array.isArray(v) && /_nodearray$/i.test(qb.names.get(n.value) ?? "")) array = v;
    const nodes = Array.isArray(array) ? expandIncludes(array, globals).filter((n) => n instanceof Struct) : [];
    return {
        level: real,
        dir,
        scene: readScene(fs.readFileSync(levelFile(dir, real, ".scn.xbx")), `${real}.scn.xbx`),
        col: readCol(fs.readFileSync(levelFile(dir, real, ".col.xbx")), `${real}.col.xbx`),
        tex: withTextures
            ? readTex(fs.readFileSync(levelFile(dir, real, ".tex.xbx")), `${real}.tex.xbx`)
            : { version: 1, textures: [] },
        names: qb.names,
        nodes: nodes as Struct[],
    };
}

function nameOf(v: QbValue | undefined): number {
    return v instanceof Name ? v.value : 0;
}

function vec(v: QbValue | undefined): V3 | null {
    if (!(v instanceof Vector) || v.values.length < 3) return null;
    return { x: v.values[0]!, y: v.values[1]!, z: v.values[2]! };
}

function boxOf(bbox: readonly number[]): Box {
    return { min: { x: bbox[0]!, y: bbox[1]!, z: bbox[2]! }, max: { x: bbox[3]!, y: bbox[4]!, z: bbox[5]! } };
}

function colBox(o: ColObject): Box {
    return {
        min: { x: o.bbox[0]!, y: o.bbox[1]!, z: o.bbox[2]! },
        max: { x: o.bbox[4]!, y: o.bbox[5]!, z: o.bbox[6]! },
    };
}

function inside(p: V3, b: Box, grow: number): boolean {
    return (
        p.x >= b.min.x - grow &&
        p.x <= b.max.x + grow &&
        p.y >= b.min.y - grow &&
        p.y <= b.max.y + grow &&
        p.z >= b.min.z - grow &&
        p.z <= b.max.z + grow
    );
}

function boxInside(a: Box, b: Box, grow: number): boolean {
    return inside(a.min, b, grow) && inside(a.max, b, grow);
}

export interface Piece {
    name: string;
    checksum: number; // the piece's own sector (a cluster's: the sector the cluster is named after)
    members: number[]; // its sectors: its own first, then the rest of its cluster
    box: Box; // all of them
    triangles: number;
    textures: number[];
    collision: Map<number, number[]>; // a member -> the collision objects that go with it (its own first)
    rails: RailPoint[];
}

function unionBox(boxes: readonly Box[]): Box {
    return boundsOf(boxes.flatMap((b) => [b.min, b.max]));
}

function triangleCount(sector: Sector): number {
    let n = 0;
    for (const mesh of sector.meshes) {
        const strip = mesh.lods[0] ?? [];
        for (let i = 2; i < strip.length; i++) {
            const a = strip[i - 2]!;
            const b = strip[i - 1]!;
            const c = strip[i]!;
            if (a !== b && b !== c && a !== c) n++;
        }
    }
    return n;
}

function texturesOf(sector: Sector, materials: ReadonlyMap<number, Material>): number[] {
    const out = new Set<number>();
    for (const mesh of sector.meshes) {
        for (const pass of materials.get(mesh.material)?.passes ?? []) if (pass.texture) out.add(pass.texture);
    }
    return [...out];
}

// The level's pieces: every named render sector with a LevelGeometry node, with what belongs to it - a trick-object
// cluster (the nodes' Cluster=) is one piece, named after its own sector (LA's Fire_Tender: the truck, its cabs and
// tyres); its other sectors aren't listed alone.
export function piecesOf(data: LevelData): Piece[] {
    const materials = new Map(data.scene.materials.map((m) => [m.checksum, m]));
    const sectors = new Map(data.scene.sectors.map((s) => [s.checksum, s]));
    const classOf = (n: Struct) => nameOf(n.get("Class"));
    const kLevelGeometry = checksum("LevelGeometry");
    const kRailNode = checksum("RailNode");
    const kTrickObject = checksum("TrickObject");
    const clusterOf = new Map<number, number>();
    for (const node of data.nodes) {
        if (classOf(node) !== kLevelGeometry) continue;
        const name = nameOf(node.get("Name"));
        const cluster = nameOf(node.get("Cluster"));
        clusterOf.set(name, cluster && sectors.has(cluster) ? cluster : name);
    }
    const members = new Map<number, number[]>();
    for (const sector of data.scene.sectors) {
        const head = clusterOf.get(sector.checksum);
        if (head === undefined || !sector.meshes.length || !data.names.has(sector.checksum)) continue;
        const list = members.get(head) ?? [];
        if (sector.checksum === head) list.unshift(head);
        else list.push(sector.checksum);
        members.set(head, list);
    }
    const collisionOnly = data.col.objects.filter((o) => !sectors.has(o.checksum) && o.verts.length);
    const rails = data.nodes.filter((node) => classOf(node) === kRailNode && vec(node.get("Pos")) !== null);
    const nameAt = (index: number) => nameOf(data.nodes[index]?.get("Name"));
    const out: Piece[] = [];
    for (const [head, list] of members) {
        if (list[0] !== head) continue; // (a cluster named after a sector without geometry)
        const parts = list.map((c) => sectors.get(c)!);
        const box = unionBox(parts.map((s) => boxOf(s.bbox)));
        const collision = new Map<number, number[]>();
        for (const s of parts)
            collision.set(s.checksum, data.col.objects.some((o) => o.checksum === s.checksum) ? [s.checksum] : []);
        for (const o of collisionOnly) if (boxInside(colBox(o), box, NEAR)) collision.get(head)!.push(o.checksum);
        const own = rails.filter((node) => {
            const pos = vec(node.get("Pos"))!;
            return inside(pos, box, NEAR) || (list.includes(nameOf(node.get("Cluster"))) && inside(pos, box, 4 * NEAR));
        });
        const names = new Set(own.map((node) => nameOf(node.get("Name"))));
        out.push({
            name: data.names.get(head)!,
            checksum: head,
            members: list,
            box,
            triangles: parts.reduce((n, s) => n + triangleCount(s), 0),
            textures: [...new Set(parts.flatMap((s) => texturesOf(s, materials)))],
            collision,
            rails: own.map((node) => {
                const links = node.get("Links");
                return {
                    name: nameOf(node.get("Name")),
                    pos: vec(node.get("Pos"))!,
                    terrain: nameOf(node.get("TerrainType")),
                    links: (Array.isArray(links) ? links : [])
                        .filter((l): l is number => typeof l === "number")
                        .map(nameAt)
                        .filter((n) => names.has(n)),
                    trickObject: node.entries.some(
                        ([k, v]) => k === null && v instanceof Name && v.value === kTrickObject,
                    ),
                };
            }),
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// --- a pack ---------------------------------------------------------------------------------------------------------

export function packId(level: string, piece: string): string {
    const text = `${PREFIX}${level}_${piece}`.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_");
    return text.length > 48 ? `${text.slice(0, 39)}_${hex8(checksum(text)).toLowerCase()}` : text;
}

export function railName(id: string, name: string): string {
    return `${id}_${name}`;
}

export interface Pack {
    id: string;
    scene: Scene;
    col: ColFile;
    tex: TexFile;
    manifest: string;
}

function nameText(names: ReadonlyMap<number, string>, value: number): string {
    return names.get(value) ?? hex8(value);
}

// A pack's sectors' names: its own sector `id`, the rest of its cluster `id`_1, _2...
export function memberName(id: string, index: number): string {
    return index === 0 ? id : `${id}_${index}`;
}

// The piece cut out into a pack: its sectors (renamed), each with its collision (the collision-only objects merged
// into its own sector's), the materials and textures they use, its rails - all moved so the middle of its bottom is at
// the origin.
export function makePack(data: LevelData, piece: Piece): Pack {
    const id = packId(data.level, piece.name);
    const anchor = {
        x: (piece.box.min.x + piece.box.max.x) / 2,
        y: piece.box.min.y,
        z: (piece.box.min.z + piece.box.max.z) / 2,
    };
    const toLocal: Placement = {
        quarters: 0,
        offset: { x: -anchor.x, y: -anchor.y, z: -anchor.z },
        scale: IDENTITY.scale,
    };
    const sectors: Sector[] = [];
    const col: ColFile = { ...data.col, objects: [] };
    const sectorLines: string[] = [];
    piece.members.forEach((member, index) => {
        const name = memberName(id, index);
        const value = checksum(name);
        const sector = cloneSector(data.scene.sectors.find((s) => s.checksum === member)!, value);
        placeSector(sector, toLocal);
        sectors.push(sector);
        const objects = (piece.collision.get(member) ?? [])
            .map((c) => data.col.objects.find((o) => o.checksum === c))
            .filter((o): o is ColObject => o !== undefined);
        if (objects.length) {
            const merged = mergeCollision(objects, value);
            placeCollision(merged, toLocal);
            col.objects.push(merged);
        }
        sectorLines.push(`sector ${hex8(value).toLowerCase()} ${name} ${nameText(data.names, member)}`);
    });
    const used = new Set(sectors.flatMap((s) => s.meshes.map((m) => m.material)));
    const materials = data.scene.materials.filter((m) => used.has(m.checksum));
    const wanted = new Set(piece.textures);
    const textures: Texture[] = data.tex.textures.filter((t) => wanted.has(t.checksum));
    const scene: Scene = { ...data.scene, materials, sectors, hierarchyCount: 0, tail: Buffer.alloc(0) };
    const local = unionBox(sectors.map((s) => boxOf(s.bbox)));
    const r3 = (v: number) => Number(v.toFixed(3));
    const lines = [
        `prop-pack ${MANIFEST_VERSION}`,
        `id ${id}`,
        `source ${data.level} ${piece.name} ${hex8(piece.checksum).toLowerCase()}`,
        `anchor ${r3(anchor.x)} ${r3(anchor.y)} ${r3(anchor.z)}`,
        ...sectorLines,
        `size ${[local.min.x, local.min.y, local.min.z, local.max.x, local.max.y, local.max.z].map(r3).join(" ")}`,
        `triangles ${piece.triangles}`,
        `textures ${textures.length}`,
        `collision ${col.objects.reduce((n, o) => n + o.faces.length, 0)}`,
    ];
    for (const r of piece.rails) {
        const p = applyPlacement(toLocal, r.pos);
        const links = r.links.map((l) => railName(id, nameText(data.names, l)));
        const terrain = r.terrain ? nameText(data.names, r.terrain) : "-";
        lines.push(
            `rail ${railName(id, nameText(data.names, r.name))} ${r3(p.x)} ${r3(p.y)} ${r3(p.z)} ${terrain} ${links.length ? links.join(",") : "-"}${r.trickObject ? " trick" : ""}`,
        );
    }
    return { id, scene, col, tex: { version: data.tex.version, textures }, manifest: `${lines.join("\n")}\n` };
}

export function writePack(pack: Pack, folder: string): string[] {
    const dir = path.join(folder, "levels", pack.id);
    fs.mkdirSync(dir, { recursive: true });
    const files: [string, Buffer | string][] = [
        [`${pack.id}.scn.xbx`, writeScene(pack.scene)],
        [`${pack.id}.tex.xbx`, writeTex(pack.tex)],
        [`${pack.id}.col.xbx`, writeCol(pack.col)],
        [`${pack.id}.txt`, pack.manifest],
    ];
    for (const [name, data] of files) fs.writeFileSync(path.join(dir, name), data);
    return files.map(([name]) => path.join(dir, name));
}

export interface PackManifest {
    id: string;
    sourceLevel: string;
    sourcePiece: string;
    sectors: number[];
    rails: { name: string; pos: V3; terrain: string; links: string[]; trick: boolean }[];
}

export function readManifest(text: string): PackManifest {
    const out: PackManifest = { id: "", sourceLevel: "", sourcePiece: "", sectors: [], rails: [] };
    for (const line of text.split(/\r?\n/)) {
        const w = line.trim().split(/\s+/);
        if (w[0] === "id") out.id = w[1] ?? "";
        else if (w[0] === "source") [out.sourceLevel, out.sourcePiece] = [w[1] ?? "", w[2] ?? ""];
        else if (w[0] === "sector") out.sectors.push(Number.parseInt(w[1] ?? "0", 16));
        else if (w[0] === "rail" && w.length >= 7)
            out.rails.push({
                name: w[1]!,
                pos: { x: Number(w[2]), y: Number(w[3]), z: Number(w[4]) },
                terrain: w[5]!,
                links: w[6] === "-" ? [] : w[6]!.split(","),
                trick: w[7] === "trick",
            });
    }
    return out;
}

// --- thumbnails -----------------------------------------------------------------------------------------------------

const BACKGROUND = [0x2c, 0x28, 0x26]; // (b, g, r: the editor's panel grey)

// A texture's average colour (r, g, b in 0..1) from its smallest level of at least 4x4 texels.
export function averageColour(t: Texture): [number, number, number] {
    let level = 0;
    let w = t.width;
    let h = t.height;
    while (level + 1 < t.levels.length && w > 4 && h > 4) {
        level++;
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
    }
    const data = t.levels[level]!;
    let bgra: Buffer;
    try {
        if (t.dxt) bgra = dxt.decode(data, w, h, t.dxt);
        else if (t.texelDepth === 8 && t.palette.length >= 4) {
            bgra = Buffer.alloc(data.length * 4);
            for (let i = 0; i < data.length; i++) t.palette.copy(bgra, i * 4, data[i]! * 4, data[i]! * 4 + 4);
        } else if (t.texelDepth === 32) bgra = data;
        else return [0.6, 0.6, 0.6];
    } catch {
        return [0.6, 0.6, 0.6];
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i + 3 < bgra.length; i += 4) {
        b += bgra[i]!;
        g += bgra[i + 1]!;
        r += bgra[i + 2]!;
        n++;
    }
    return n ? [r / n / 255, g / n / 255, b / n / 255] : [0.6, 0.6, 0.6];
}

// A sector drawn small (a three-quarter view from above, flat shaded with its vertex colours and its textures'
// average colours), `size` pixels square.
export function thumbnail(
    parts: readonly Sector[],
    materials: ReadonlyMap<number, Material>,
    colours: ReadonlyMap<number, [number, number, number]>,
    size: number,
): Picture {
    const bgra = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        bgra[i * 4] = BACKGROUND[0]!;
        bgra[i * 4 + 1] = BACKGROUND[1]!;
        bgra[i * 4 + 2] = BACKGROUND[2]!;
        bgra[i * 4 + 3] = 255;
    }
    const depth = new Float32Array(size * size).fill(Infinity);
    const yaw = (35 * Math.PI) / 180;
    const pitch = (28 * Math.PI) / 180;
    const [sy, cy, sp, cp] = [Math.sin(yaw), Math.cos(yaw), Math.sin(pitch), Math.cos(pitch)];
    const view = (p: V3): V3 => {
        const x = p.x * cy - p.z * sy;
        const z1 = p.x * sy + p.z * cy;
        return { x, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
    };
    const light = (() => {
        const l = { x: 0.4, y: 0.8, z: 0.45 };
        const n = Math.hypot(l.x, l.y, l.z);
        return { x: l.x / n, y: l.y / n, z: l.z / n };
    })();
    interface Tri {
        a: V3;
        b: V3;
        c: V3;
        colour: [number, number, number];
    }
    const tris: Tri[] = [];
    for (const mesh of parts.flatMap((s) => s.meshes)) {
        const data = mesh.buffers[0]?.[1];
        const fvf = mesh.vertexShader[0] ?? 0;
        if (!data || mesh.stride < 12 || data.length < mesh.stride * mesh.vertexCount) continue;
        const material = materials.get(mesh.material);
        const pass = material?.passes[0];
        const base = pass ? (colours.get(pass.texture) ?? [0.7, 0.7, 0.7]) : [0.7, 0.7, 0.7];
        const colourAt = colourOffset(fvf);
        const at = (i: number): V3 => ({
            x: data.readFloatLE(i * mesh.stride),
            y: data.readFloatLE(i * mesh.stride + 4),
            z: data.readFloatLE(i * mesh.stride + 8),
        });
        const vc = (i: number): [number, number, number] => {
            if (colourAt < 0) return [0.5, 0.5, 0.5];
            const o = i * mesh.stride + colourAt;
            return [data[o + 2]! / 255, data[o + 1]! / 255, data[o]! / 255];
        };
        // (the shipped levels' index lists count from the mesh's first vertex in the sector's vertex range: their
        // lowest index is the mesh's vertex 0)
        const strip = mesh.lods[0] ?? [];
        const first = strip.reduce((m, v) => Math.min(m, v), Infinity);
        for (let i = 2; i < strip.length; i++) {
            const [ia, ib, ic] = [strip[i - 2]! - first, strip[i - 1]! - first, strip[i]! - first];
            if (ia === ib || ib === ic || ia === ic || Math.max(ia, ib, ic) >= mesh.vertexCount) continue;
            const [a, b, c] = [at(ia), at(ib), at(ic)];
            const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
            const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
            const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
            const len = Math.hypot(n.x, n.y, n.z) || 1;
            const shade = 0.55 + 0.45 * Math.abs((n.x * light.x + n.y * light.y + n.z * light.z) / len);
            const [ca, cb, cc] = [vc(ia), vc(ib), vc(ic)];
            const colour: [number, number, number] = [0, 1, 2].map((k) =>
                Math.min(1, base[k]! * ((ca[k]! + cb[k]! + cc[k]!) / 3) * 2 * shade),
            ) as [number, number, number];
            tris.push({ a: view(a), b: view(b), c: view(c), colour });
        }
    }
    if (!tris.length) return { width: size, height: size, bgra };
    const box = boundsOf(tris.flatMap((t) => [t.a, t.b, t.c]));
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, 1);
    const scale = (size * 0.86) / span;
    const ox = size / 2 - ((box.min.x + box.max.x) / 2) * scale;
    const oy = size / 2 + ((box.min.y + box.max.y) / 2) * scale;
    const screen = (p: V3) => ({ x: p.x * scale + ox, y: oy - p.y * scale, z: p.z });
    for (const t of tris) {
        const [a, b, c] = [screen(t.a), screen(t.b), screen(t.c)];
        const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(area) < 1e-6) continue;
        const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
        const x1 = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
        const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
        const y1 = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const px = x + 0.5;
                const py = y + 0.5;
                const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
                const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                // (nearer the camera: smaller z along the view - the camera looks along +z after `view`)
                const z = w0 * a.z + w1 * b.z + w2 * c.z;
                const at = y * size + x;
                if (z >= depth[at]!) continue;
                depth[at] = z;
                bgra[at * 4] = Math.round(t.colour[2] * 255);
                bgra[at * 4 + 1] = Math.round(t.colour[1] * 255);
                bgra[at * 4 + 2] = Math.round(t.colour[0] * 255);
            }
        }
    }
    return { width: size, height: size, bgra };
}

export function textureColours(tex: TexFile): Map<number, [number, number, number]> {
    return new Map(tex.textures.map((t) => [t.checksum, averageColour(t)]));
}
