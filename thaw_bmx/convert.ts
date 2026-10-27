// NOT ORIGINAL - THAW's BMX for THUG2, phase 1: the assets. Reads the user's THAW (PC 1.01) and THUG2 installs, read only; nothing of either
// game is stored in the repo.
//
//   node tools/pipeline/thaw_bmx/convert.ts [convert] --thug2 <game folder> [--thaw <game folder>] [--ns <ns.exe>]
//   node tools/pipeline/thaw_bmx/convert.ts convert --out <scratch folder> ...
//   node tools/pipeline/thaw_bmx/convert.ts selfcheck [--thaw ..] [--thug2 ..]
//
// Writes the staging folder <game>\thug2-decomp-thaw-bmx (or --out), laid out as the data overlay
// (tools/pipeline/menu_level/make_menu_level.ts copies models, anims and skeletons into thug2-decomp-data and appends the
// scripts to the overlay's specialitems.qb - tools/pipeline/thaw_bmx/install.ts):
//   models\specialitems\thaw_bmx\si_bmx.skin.xbx / .tex.xbx / .cas.xbx   the bike, a THUG2 special item's model
//   skeletons\THAW_SI_BMX.ske.xbx                                        its 8 bones
//   anims\THAW_BMX\<THAW's folder>\<name>.ska.xbx                        the 234 + 5 animations
//   scripts\thaw_bmx\thaw_bmx.ns (and a compiled .qb, a syntax check)    animload_thaw_bmx_rider / _bike (LoadAnim
//                                                                        lists), thaw_bmx_details (the special item's
//                                                                        structure), thaw_bmx_test_* (for a test run)
//   thaw_bmx.json                                                        the manifest (phase 2 reads it)
//
// What THAW's files are, and how each becomes THUG2's:
// - The bike (models\SpecialItems\BMX\si_bmx.skin.wpc, .tex.wpc): a memory image like the levels' .geom (tools/pipeline/thaw_levels
//   readGeom reads it), with a skinned vertex that is THUG2's own (position, packed weights, four bone numbers x 3,
//   packed normal, colour, uv - stride 40) - written as a THUG2 skin with sector flags 0x80002097 as the special items'.
//   The 0x90 bytes after the meshes are a fixed trailer (see TRAILER below).
// - The skeleton (worlds\Global\global.pak.wpc, the .ske whose pak key is the checksum of "si_bmx"): THAW's .ske v1 -
//   bone / parent / mirror checksums, each bone's local translation and the INVERSE BIND MATRIX (rows of the rotation and
//   minus the world position). THUG2's .ske.xbx wants each bone's local rest quaternion: from the matrices, the world
//   rotation is conj(matrixQuat(rows)) and the local one conj(parent world) * world (checked on THAW's human against
//   THUG2's THPS6_Human: 48 of 48 bones equal to 1e-4, the translations to 4e-6).
// - Animations: ska.ts. The pak (data\pak\bmx_anims\bmx_anims.pak.wpc) names its files by an unknown hash; they are in
//   the order of THAW's animload scripts (scripts\allanims.qb in dbgq.pak.wpc: animload_THPS7_Veh_BMX_0/1/2 for the
//   rider's 114, animload_SI_BMX_0/1/2 for the bike's 120; confirmed by the partial animations' places) - the names
//   come from there. The bike's five permanent animations (animload_SI_BMX_P: Default, the tyre rotations, Bail_Manual_FT,
//   getup) are in pak\perm_anims at 458-462, the only 8-bone animations there.
// - The rider: THAW's skeleton is THUG2's THPS6_Human with 4 more bones (remapRider below).

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { FormatError } from "../level_port/binio.ts";
import * as common from "../level_port/common.ts";
import * as geometry from "../level_port/geometry.ts";
import * as prx from "../level_port/prx.ts";
import * as qb from "../level_port/qb.ts";
import { checksum } from "../level_port/qb.ts";
import { Thug2 } from "../level_port/script_port.ts";
import * as tex from "../level_port/tex.ts";
import * as thug2Scene from "../level_port/thug2_scene.ts";
import { helpFromHeader } from "../lib/cli.ts";
import { resolveInstall } from "../lib/install.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import * as thaw from "../thaw_levels/thaw.ts";
import { findPath, toThug2Material } from "../thaw_levels/thaw_levels.ts";
import type { Quat, Vec } from "../thps3_levels/thps3_skin.ts";
import * as skel from "../thps3_levels/thps3_skin.ts";
import * as bikeScripts from "./bike_scripts.ts";
import * as check from "./check.ts";
import * as ride from "./ride.ts";
import * as ska from "./ska.ts";
import * as sounds from "./sounds.ts";

export { STAGING } from "./install.ts";

import { STAGING } from "./install.ts";
export const SKELETON = "THAW_SI_BMX"; // (THAW's own name is si_bmx; THUG2 has no skeleton of that name, ours can't collide)
export const MODEL = "specialitems/thaw_bmx/si_bmx.skin";
export const DETAILS = "thaw_bmx_details";
export const RIDER_SCRIPT = "animload_thaw_bmx_rider";
export const BIKE_SCRIPT = "animload_thaw_bmx_bike";
export const SKELETON_SCRIPT = "thaw_bmx_load_skeleton"; // (a special item's skeleton must be loaded first: CSkeletonComponent::InitSkeleton crashes on a missing one)
export const ANIM_ROOT = "anims\\THAW_BMX";
// What the bike's 8 bones are (their names aren't in THAW's debug names): from the animations - bmx_front_tire_rotate
// keys bone 6 only, bmx_rear_tire_rotate bone 7, bmx_barspin_partial bone 5, the crank flips bones 2, 3 and 4 (3 and 4
// are each other's mirror: the pedals).
export const BIKE_ROLES = ["root", "frame", "crank", "pedal", "pedal", "fork_and_bars", "front_wheel", "rear_wheel"];
export const HUMAN = "THPS6_human"; // (THUG2's skater skeleton, the reference the rider's animations are loaded under)

// The 0x90 bytes after the last mesh of every THAW .skin (all 589 of the game's skins that read: the same bytes): 0x60
// zero bytes, then a 0x30 block of 0x20 zeros and the four words 0x00FE1001, 0, 0, 0x10. The file's first word is the
// offset of that block (file size - 0x30). The loader (THAW.exe 0x005083B0's skin path) is the runtime's pointer-fixup
// footer of the memory image - empty here: the image has no pointers left to patch after the meshes. Nothing is read
// from it; THUG2's skin has no such trailer.
export const TRAILER = 0x90;

const CAS = Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // (the 12-byte .cas.xbx every special item has)
const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");

// --- THAW's skeleton ---------------------------------------------------------------------------------------------

export interface Bone {
    id: number; // the name's checksum
    parent: number; // its checksum, 0: none
    mirror: number; // its checksum, 0: none
    t: Vec; // local rest translation
    q: Quat; // local rest rotation (Hamilton)
}

// THAW .ske v1: u16 1, u16 0x30, u32 count, 8 bytes 0, six u32 offsets {names, parents, mirrors, mirror indices, 0s, junk}
// of `count` words each, u32 offset of the matrices at 0x28 and of the translations at 0x2C; translations: 4f (x y z 1)
// per bone; matrices: 4x4 floats per bone, the inverse bind pose.
export function readThawSkeleton(d: Buffer, name = "ske"): Bone[] {
    if (d.readUInt16LE(0) !== 1) throw new FormatError(`${name}: version ${d.readUInt16LE(0)}`);
    const count = d.readUInt32LE(4);
    const array = (k: number): number[] => {
        const o = d.readUInt32LE(0x10 + 4 * k);
        return [...Array(count)].map((_, i) => d.readUInt32LE(o + 4 * i));
    };
    const ids = array(0);
    const parents = array(1);
    const mirrors = array(2);
    const matrices = d.readUInt32LE(0x28);
    const translations = d.readUInt32LE(0x2c);
    const world = (b: number): Quat => {
        const o = matrices + 64 * b;
        const rows = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => d.readFloatLE(o + 4 * i));
        return skel.conj(skel.matrixQuat(rows));
    };
    return ids.map((id, i) => {
        const p = parents[i] === 0 ? -1 : ids.indexOf(parents[i]!);
        if (parents[i] !== 0 && p < 0) throw new FormatError(`${name}: bone ${i}'s parent isn't a bone`);
        if (p >= i) throw new FormatError(`${name}: bone ${i} before its parent`);
        const q = p < 0 ? world(i) : skel.qmul(skel.conj(world(p)), world(i));
        const t = [0, 1, 2].map((j) => d.readFloatLE(translations + 16 * i + 4 * j)) as Vec;
        return { id, parent: parents[i]!, mirror: mirrors[i]!, t, q };
    });
}

// THUG2's .ske.xbx from bones with checksums (thps3_skin.writeSkeleton takes names): u32 2, u32 0, u32 count, the ids, the
// parents', the mirrors', then per bone the conjugate of the rest quaternion and the translation (w 1).
export function writeSkeleton(bones: readonly Bone[]): Buffer {
    const b = Buffer.alloc(12 + 12 * bones.length + 32 * bones.length);
    b.writeUInt32LE(2, 0);
    b.writeUInt32LE(0, 4);
    b.writeUInt32LE(bones.length, 8);
    const n = bones.length;
    bones.forEach((bone, i) => {
        b.writeUInt32LE(bone.id, 12 + 4 * i);
        b.writeUInt32LE(bone.parent, 12 + 4 * n + 4 * i);
        b.writeUInt32LE(bone.mirror, 12 + 8 * n + 4 * i);
        const at = 12 + 12 * n + 32 * i;
        const q = skel.conj(bone.q);
        [...q, ...bone.t, 1].forEach((v, k) => {
            b.writeFloatLE(v, at + 4 * k);
        });
    });
    return b;
}

// --- the rider -----------------------------------------------------------------------------------------------------
//
// THAW's human (thps7_human, 52 bones) is THUG2's THPS6_Human (50) with the same 48 bones at the same rest poses and
// 4 more: for each arm two bones below the bicep (85fe92a0 / d64a3323 left, 7ff1afc3 / 2c450e40 right; at the bicep's
// end and at its start, a twist about the arm's axis of 0.1 and 0.2 rad in the rest pose - sleeve helpers), where
// THUG2 has Bone_Shoulder_L / _R as a SIBLING of the bicep under the collar (same place, rest rotation ~ identity).
//
// So the 48 shared bones' keys are copied; THAW's 4 twist bones are dropped (THUG2's forearm carries the whole twist);
// and THUG2's shoulder bones get keys that THAW has no bone for. What THUG2's own animations do with them (measured on
// the 1,601 shoulder keys of THUG2's 76 fifty-bone animations in anims.prx, shoulder against the bicep): the shoulder
// is the bicep's rotation from its rest pose, in the collar's frame, HALF WAY: slerp(identity, bicep * rest_bicep^-1,
// f) with the best f per key 0.51 on average (0.62 at most); the mean angle between that and the actual key 0.14 rad
// (8 degrees), 0.48 at most (the animators' hand work), against 0.66 for no rotation at all. So: f = 0.5, keys at the
// bicep's key times. In a partial animation the shoulder is animated when the bicep is.

export const SHOULDER_FRACTION = 0.5;

export interface HumanMap {
    thug2: Bone[]; // THUG2's THPS6_Human, 50 bones
    from: number[]; // THAW's bone for each of THUG2's (-1: a shoulder, made from the bicep)
    bicep: number[]; // for a shoulder, THUG2's bicep bone (else -1)
}

export function humanMap(thawHuman: readonly Bone[], thug2: Bone[], dropped = 4): HumanMap {
    const from = thug2.map((b) => thawHuman.findIndex((x) => x.id === b.id));
    const bicep = thug2.map((b, k) => {
        if (from[k]! >= 0) return -1;
        // a bone THAW lacks: the shoulder, a sibling of the bicep (same parent, nearest rest position)
        const sibs = thug2
            .map((x, i) => [x, i] as const)
            .filter(([x, i]) => x.parent === b.parent && i !== k && from[i]! >= 0);
        const near = sibs
            .map(([x, i]) => [Math.hypot(...x.t.map((v, j) => v - b.t[j]!)), i] as const)
            .sort((a, c) => a[0] - c[0])[0];
        if (near === undefined) throw new FormatError(`bone ${hex8(b.id)} has no THAW bone and no sibling`);
        // (the bicep, not the other child of the collar - the chest's - checked below: only the bones near it count)
        if (near[0] > 1) throw new FormatError(`bone ${hex8(b.id)}: no bone of THAW's near it`);
        return near[1];
    });
    // THAW's bones with no THUG2 bone
    const used = new Set(from);
    const extra = thawHuman.map((_, i) => i).filter((i) => !used.has(i));
    if (extra.length !== dropped)
        throw new FormatError(`${extra.length} bones of THAW's human aren't THUG2's (${dropped} expected)`);
    return { thug2, from, bicep };
}

export function slerpFromIdentity(q: Quat, f: number): Quat {
    let [x, y, z, w] = q;
    if (w < 0) {
        x = -x;
        y = -y;
        z = -z;
        w = -w;
    }
    const angle = Math.acos(Math.min(1, w));
    if (angle < 1e-7) return [0, 0, 0, 1];
    const s = Math.sin(angle);
    const a = Math.sin(f * angle) / s;
    return [x * a, y * a, z * a, Math.cos(f * angle)];
}

// A THAW rider animation as THUG2's (50 bones).
export function remapRider(src: ska.Ska, map: HumanMap): ska.Ska {
    const rotations: ska.RotationKey[][] = [];
    const translations: ska.TranslationKey[][] = [];
    map.thug2.forEach((_, k) => {
        const f = map.from[k]!;
        if (f >= 0) {
            rotations.push(src.rotations[f]!);
            translations.push(src.translations[f]!);
            return;
        }
        const parent = map.bicep[k]!;
        const rest = map.thug2[parent]!.q;
        const keys = src.rotations[map.from[parent]!]!.map((key) => {
            const delta = skel.qmul(ska.keyQuat(key), skel.conj(rest));
            return ska.quatKey(key.time, slerpFromIdentity(delta, SHOULDER_FRACTION));
        });
        rotations.push(keys);
        translations.push([]);
    });
    const out: ska.Ska = { flags: src.flags, duration: src.duration, rotations, translations, tail: Buffer.alloc(0) };
    if (src.partial !== undefined) {
        const set = (i: number): boolean =>
            i < src.partial!.count && Boolean(src.partial!.bits[i >> 5]! & (1 << (i & 31)));
        const bits = [...Array(((map.thug2.length - 1) >> 5) + 1)].map(() => 0);
        map.thug2.forEach((_, k) => {
            const animated = map.from[k]! >= 0 ? set(map.from[k]!) : set(map.from[map.bicep[k]!]!);
            if (animated) bits[k >> 5] = (bits[k >> 5]! | (1 << (k & 31))) >>> 0;
        });
        out.partial = { count: map.thug2.length, bits };
    }
    return out;
}

// --- the bike's skin ------------------------------------------------------------------------------------------------

export const SKIN_SECTOR_FLAGS = 0x80002097; // as THUG2's special items' skins (THAW's is 0x80400097)

// THAW's skin as a THUG2 scene. Its skinned vertex is THUG2's (thug2_scene.readSkinVertices); the strips, materials and
// boxes are carried over. `bones`: the skeleton's bone count (an index past it throws).
export function convertSkin(geom: thaw.Geom, bones: number, name = "skin"): thug2Scene.Scene {
    const materials = geom.materials.map(toThug2Material);
    const byChecksum = new Map(materials.map((m) => [m.checksum, m]));
    const sectors: thug2Scene.Sector[] = [];
    for (const s of geom.sectors) {
        if (s.flags & 0x800) throw new FormatError(`${name}: sector ${hex8(s.checksum)} has colour wibbles`);
        const meshes: thug2Scene.Mesh[] = [];
        const points: number[][] = [];
        for (const m of s.meshes) {
            if (m.strip.length < 3 || !m.vertexCount) continue;
            const material = byChecksum.get(m.material);
            if (material === undefined) throw new FormatError(`${name}: material ${hex8(m.material)} missing`);
            if (m.fvf !== 0 || m.stride < 40 || (m.stride - 32) % 8 || m.buffers !== 1)
                throw new FormatError(`${name}: a vertex of FVF ${m.fvf.toString(16)}, stride ${m.stride}`);
            const sets = (m.stride - 32) / 8;
            const vertices = thug2Scene.readSkinVertices({
                stride: m.stride,
                vertexCount: m.vertexCount,
                buffers: [[0, m.vertices]],
            } as thug2Scene.Mesh);
            for (const v of vertices) {
                for (const b of v.bones)
                    if (b >= bones) throw new FormatError(`${name}: bone ${b} past the skeleton's ${bones}`);
            }
            for (const i of m.strip)
                if (i >= m.vertexCount) throw new FormatError(`${name}: strip index ${i} past the vertices`);
            const positions = vertices.map((v) => v.position);
            points.push(...positions);
            const [lo, hi] = geometry.bounds(positions);
            meshes.push(
                thug2Scene.skinnedMesh({
                    sphere: m.sphere,
                    bbox: [...lo, ...hi],
                    flags: 0,
                    material: m.material,
                    vertices,
                    uvSets: sets,
                    strip: m.strip,
                    pixelShader: geometry.pixelShader(material),
                }),
            );
        }
        if (!meshes.length) continue;
        const [lo, hi, center, radius] = geometry.bounds(points);
        sectors.push({
            checksum: s.checksum,
            bone: -1,
            flags: SKIN_SECTOR_FLAGS,
            bbox: [...lo, ...hi],
            sphere: [center[0]!, center[1]!, center[2]!, radius],
            meshes,
        });
    }
    return { versions: [1, 1, 1], materials, sectors, hierarchyCount: 0, tail: Buffer.alloc(0) };
}

// --- the animation sets ----------------------------------------------------------------------------------------------

export interface LoadRow {
    script: string;
    reference: string; // the SetReferenceChecksum in force
    path: string; // THAW's "anims\\<folder>\\<name>.ska"
    desc: string; // descChecksum's name
}

// The LoadAnim lines of THAW's animload scripts (scripts\allanims.qb): {Name = "<path>" descChecksum = <name>} after
// SetReferenceChecksum <reference>.
export function loadRows(body: Buffer, script: string, names: ReadonlyMap<number, string>): LoadRow[] {
    const rows: LoadRow[] = [];
    const toks = [...thaw.tokens(body)];
    const kName = checksum("name");
    const kDesc = checksum("descchecksum");
    const kRef = checksum("setreferencechecksum");
    const nameOf = (v: number): string => names.get(v) ?? hex8(v);
    let reference = "";
    for (let i = 0; i < toks.length; i++) {
        const [, t, p] = toks[i]!;
        if (t !== 0x16) continue;
        const v = p.readUInt32LE(0);
        if (v === kRef && toks[i + 1]?.[1] === 0x16) {
            const r = toks[i + 1]![2].readUInt32LE(0);
            reference = r === 0 ? "" : nameOf(r);
        } else if (v === kName && toks[i + 1]?.[1] === 0x07 && toks[i + 2]?.[1] === 0x1b) {
            const text = toks[i + 2]![2].toString("latin1").replace(/\0.*$/s, "");
            const d = toks[i + 3];
            const e = toks[i + 5];
            if (d?.[1] !== 0x16 || d[2].readUInt32LE(0) !== kDesc || e?.[1] !== 0x16)
                throw new FormatError(`${script}: a LoadAnim of "${text}" without its descChecksum`);
            rows.push({ script, reference, path: text, desc: nameOf(e[2].readUInt32LE(0)) });
        }
    }
    return rows;
}

export interface Anim {
    set: "rider" | "bike" | "bike_permanent";
    row: LoadRow;
    data: Buffer; // THAW's file
}

export interface Context {
    thaw: string; // the game folder (the one with data\)
    thug2: string;
    names: Map<number, string>;
}

export function context(thawDir: string, thug2Dir: string): Context {
    const root = resolveInstall(thawDir, "thaw");
    return { thaw: root, thug2: resolveInstall(thug2Dir, "thug2"), names: thaw.loadNames(root) };
}

function pak(c: Context, ...parts: string[]): [thaw.PakEntry, Buffer][] {
    const p = findPath(c.thaw, "data", "pak", ...parts);
    if (p === null) throw new FormatError(`THAW: data\\pak\\${parts.join("\\")} not found`);
    return thaw.pakFiles(p);
}

export function keyTables(c: Context): ska.KeyTables {
    const dir = path.join(c.thaw, "data", "anims");
    return {
        q: fs.readFileSync(findPath(c.thaw, "data", "anims", "standardkeyQ.bin") ?? path.join(dir, "standardkeyQ.bin")),
        t: fs.readFileSync(findPath(c.thaw, "data", "anims", "standardkeyT.bin") ?? path.join(dir, "standardkeyT.bin")),
    };
}

// The animation sets: the files of pak\bmx_anims in the order of the load scripts' rows, the five permanent ones from
// pak\perm_anims.
export function readAnims(c: Context): Anim[] {
    let scripts: Map<string, Buffer> | undefined;
    for (const [e, d] of pak(c, "dbgq.pak.wpc")) {
        if (e.extension === ".qb" && /allanims/i.test(e.path ?? "")) {
            const items = new thaw.QbItems(d, "allanims.qb", c.names);
            scripts = new Map([...items.scriptData].map(([k, body]) => [c.names.get(k) ?? hex8(k), body]));
        }
    }
    if (scripts === undefined) throw new FormatError("THAW: no scripts\\allanims.qb in dbgq.pak");
    const rowsOf = (name: string): LoadRow[] => {
        const body = scripts!.get(name);
        if (body === undefined) throw new FormatError(`THAW: no script ${name}`);
        return loadRows(body, name, c.names);
    };
    const unique = (rows: LoadRow[]): LoadRow[] => {
        const seen = new Set<string>();
        return rows.filter((r) => !seen.has(r.path.toLowerCase()) && seen.add(r.path.toLowerCase()));
    };
    const riderRows = unique(["0", "1", "2"].flatMap((n) => rowsOf(`animload_THPS7_Veh_BMX_${n}`)));
    const bikeRows = unique(["0", "1", "2"].flatMap((n) => rowsOf(`animload_SI_BMX_${n}`)));
    const permanentRows = rowsOf("animload_SI_BMX_P");
    const files = pak(c, "bmx_anims", "bmx_anims.pak.wpc")
        .filter(([e]) => e.extension === ".ska")
        .map(([, d]) => d);
    if (files.length !== riderRows.length + bikeRows.length)
        throw new FormatError(
            `THAW: ${files.length} animations in bmx_anims, ${riderRows.length + bikeRows.length} in the scripts`,
        );
    const out: Anim[] = [];
    riderRows.forEach((row, i) => {
        if (files[i]![0xd]! < 52) throw new FormatError(`${row.path}: ${files[i]![0xd]} bones, not the rider's`);
        out.push({ set: "rider", row, data: files[i]! });
    });
    bikeRows.forEach((row, i) => {
        const d = files[riderRows.length + i]!;
        if (d[0xd] !== 8) throw new FormatError(`${row.path}: ${d[0xd]} bones, not the bike's`);
        out.push({ set: "bike", row, data: d });
    });
    const perm = pak(c, "perm_anims", "perm_anims.pak.wpc").filter(([e]) => e.extension === ".ska");
    const eight = perm.filter(([, d]) => d[0xd] === 8);
    if (eight.length !== permanentRows.length)
        throw new FormatError(`THAW: ${eight.length} 8-bone animations in perm_anims for ${permanentRows.length} rows`);
    permanentRows.forEach((row, i) => {
        out.push({ set: "bike_permanent", row, data: eight[i]![1] });
    });
    return out;
}

// --- the scripts -----------------------------------------------------------------------------------------------------

export function ourPath(row: LoadRow): string {
    // "anims\\THPS7_Veh_BMX\\BMX_idle.ska" -> "anims\\THAW_BMX\\THPS7_Veh_BMX\\BMX_idle.ska"
    return `${ANIM_ROOT}\\${row.path.replace(/^anims[\\/]/i, "")}`;
}

// The load scripts, the special item and the tests; then `ride` (ride.ts, phase 2: the bike's physics, cameras,
// vehicle and scripts - thaw_bmx_bike_script, the special item's TriggerScript, among them).
export function scriptsText(anims: readonly Anim[], ride = ""): string {
    const names = new Map<number, string>();
    for (const a of anims) names.set(checksum(a.row.desc), a.row.desc);
    const load = (reference: string, set: readonly Anim[]): string =>
        `    SetReferenceChecksum ${reference}\n` +
        set
            .map(
                (a) =>
                    `    LoadAnim name="${ourPath(a.row).replaceAll("\\", "\\\\")}" descChecksum=${qb.nameText(checksum(a.row.desc), names)}`,
            )
            .join("\n") +
        "\n    SetReferenceChecksum 0\n";
    return (
        `script ${RIDER_SCRIPT} {\n${load(
            HUMAN,
            anims.filter((a) => a.set === "rider"),
        )}}\n` +
        `script ${SKELETON_SCRIPT} {\n    LoadSkeleton name="skeletons/${SKELETON}.ske" ${SKELETON}\n}\n` +
        `script ${BIKE_SCRIPT} {\n${load(
            SKELETON,
            anims.filter((a) => a.set !== "rider"),
        )}}\n` +
        `${DETAILS} = {\n` +
        `    Position=(0.0, 0.0, 0.0)\n    Angles=(0.0, 0.0, 0.0)\n    Name=ThawBmx\n    Class=GameObject\n    Type=SpecialItem\n` +
        `    CollisionMode=None\n    IgnoredLights=[0, 1]\n    skeletonName=${SKELETON}\n    animName=${BIKE_SCRIPT}\n` +
        `    model="${MODEL}"\n    SuspendDistance=0\n    lod_dist1=400\n    lod_dist2=401\n    TriggerScript=thaw_bmx_bike_script\n}\n` +
        `script thaw_bmx_test_load {\n    ${SKELETON_SCRIPT}\n    ${RIDER_SCRIPT}\n    ${BIKE_SCRIPT}\n}\n` +
        `script thaw_bmx_test_bike {\n    TurnOnSpecialItem specialitem_details=${DETAILS}\n}\n` +
        `script thaw_bmx_test_anim {\n    PlayAnim Anim=bmx_idle BlendPeriod=0.3 Cycle\n}\n` +
        `script thaw_bmx_test_on_skater {\n    thaw_bmx_test_load\n    thaw_bmx_test_bike\n    thaw_bmx_test_anim\n}\n` +
        `script thaw_bmx_test {\n    SpawnSkaterScript thaw_bmx_test_on_skater\n}\n` +
        ride
    );
}

// --- converting ----------------------------------------------------------------------------------------------------

export interface Manifest {
    format: number;
    generator: string;
    staging: string;
    skeleton: unknown;
    model: unknown;
    scripts: unknown;
    anims: unknown[];
    notes: string[];
}

export interface Result {
    files: string[];
    manifest: Manifest;
    report: string[];
}

function write(out: string, rel: string, data: Buffer | string, files: string[]): void {
    const target = path.join(out, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files.push(rel);
}

export function thug2Human(c: Context): Bone[] {
    const file = path.join(c.thug2, "Data", "pre", "skeletons.prx");
    const d = prx.find(file, "skeletons\\THPS6_Human.ske.xbx");
    if (d === null) throw new FormatError(`${file}: no THPS6_Human.ske.xbx`);
    const n = d.readUInt32LE(8);
    const ids = [...Array(n)].map((_, i) => d.readUInt32LE(12 + 4 * i));
    const parents = [...Array(n)].map((_, i) => d.readUInt32LE(12 + 4 * n + 4 * i));
    const mirrors = [...Array(n)].map((_, i) => d.readUInt32LE(12 + 8 * n + 4 * i));
    const rest = skel.readSkeleton(d);
    return ids.map((id, i) => ({
        id,
        parent: parents[i]!,
        mirror: mirrors[i]!,
        t: rest.rest[i]!.t,
        q: rest.rest[i]!.q,
    }));
}

export function thawSkeletons(c: Context): { bike: Bone[]; human: Bone[] } {
    let bike: Bone[] | undefined;
    let human: Bone[] | undefined;
    const file = findPath(c.thaw, "data", "worlds", "Global", "global.pak.wpc");
    if (file === null) throw new FormatError("THAW: data\\worlds\\Global\\global.pak.wpc not found");
    for (const [e, d] of thaw.pakFiles(file)) {
        if (e.extension !== ".ske") continue;
        if (e.pak === checksum("si_bmx")) bike = readThawSkeleton(d, "si_bmx.ske");
        else if (e.pak === checksum("thps7_human")) human = readThawSkeleton(d, "thps7_human.ske");
    }
    if (bike === undefined || human === undefined) throw new FormatError("THAW: si_bmx / thps7_human skeleton missing");
    return { bike, human };
}

export function convert(c: Context, out: string, ns: string | null): Result {
    const report: string[] = [];
    const files: string[] = [];
    const notes: string[] = [];
    // skeletons
    const sk = thawSkeletons(c);
    const humanMapping = humanMap(sk.human, thug2Human(c));
    write(out, `skeletons\\${SKELETON}.ske.xbx`, writeSkeleton(sk.bike), files);
    report.push(`skeleton ${SKELETON}: ${sk.bike.length} bones`);
    // the bike
    const modelDir = findPath(c.thaw, "data", "models", "SpecialItems", "BMX");
    if (modelDir === null) throw new FormatError("THAW: data\\models\\SpecialItems\\BMX not found");
    const skinData = fs.readFileSync(findPath(c.thaw, "data", "models", "SpecialItems", "BMX", "si_bmx.skin.wpc")!);
    const geom = thaw.readGeom(skinData.subarray(0, skinData.length - TRAILER), "si_bmx.skin");
    if (skinData.readUInt32LE(0) !== skinData.length - 0x30) throw new FormatError("si_bmx.skin: the trailer's offset");
    const scene = convertSkin(geom, sk.bike.length, "si_bmx.skin");
    const skinOut = thug2Scene.writeScene(scene);
    thug2Scene.readScene(skinOut, "si_bmx");
    const textures = thaw.readTex(
        fs.readFileSync(findPath(c.thaw, "data", "models", "SpecialItems", "BMX", "si_bmx.tex.wpc")!),
        "si_bmx.tex",
    );
    tex.checkLoadable(textures, "si_bmx");
    const texOut = tex.writeTex(textures);
    tex.readTex(texOut, "si_bmx");
    const have = new Set(textures.textures.map((t) => t.checksum));
    for (const m of scene.materials)
        for (const p of m.passes)
            if (p.texture && !have.has(p.texture)) throw new FormatError(`si_bmx: texture ${hex8(p.texture)} missing`);
    const base = `models\\${MODEL.replaceAll("/", "\\").replace(/\.skin$/, "")}`;
    write(out, `${base}.skin.xbx`, skinOut, files);
    write(out, `${base}.tex.xbx`, texOut, files);
    write(out, `${base}.cas.xbx`, CAS, files);
    report.push(
        `model: ${scene.sectors.length} sector, ${scene.sectors.reduce((n, s) => n + s.meshes.length, 0)} mesh, ` +
            `${scene.sectors[0]?.meshes[0]?.vertexCount ?? 0} vertices, ${textures.textures.length} textures`,
    );
    // animations
    const tables = keyTables(c);
    const anims = readAnims(c);
    const manifestAnims: unknown[] = [];
    let bytes = 0;
    for (const a of anims) {
        const src = ska.readSka(a.data, "thaw", tables, a.row.path);
        const result = a.set === "rider" ? remapRider(src, humanMapping) : src;
        const data = ska.writeSka(result);
        bytes += data.length;
        const rel = `${ourPath(a.row)}.xbx`;
        write(out, rel, data, files);
        manifestAnims.push({
            set: a.set,
            desc: a.row.desc,
            descChecksum: hex8(checksum(a.row.desc)),
            reference: a.set === "rider" ? HUMAN : SKELETON,
            thawPath: a.row.path,
            thawReference: a.row.reference,
            file: rel,
            thawFlags: hex8(src.flags),
            thawBones: src.rotations.length,
            bones: result.rotations.length,
            partial: Boolean(src.flags & ska.FLAG_PARTIAL),
            duration: src.duration,
            rotationKeys: result.rotations.reduce((n, k) => n + k.length, 0),
            translationKeys: result.translations.reduce((n, k) => n + k.length, 0),
        });
    }
    report.push(
        `animations: ${anims.filter((a) => a.set === "rider").length} rider (52 -> 50 bones), ` +
            `${anims.filter((a) => a.set === "bike").length} bike, ${anims.filter((a) => a.set === "bike_permanent").length} permanent bike (${(bytes / 1024).toFixed(0)} KB)`,
    );
    // scripts
    const qbPak = findPath(c.thaw, "data", "pak", "qb.pak.wpc");
    if (qbPak === null) throw new FormatError("THAW: data\\pak\\qb.pak.wpc not found");
    const text = scriptsText(
        anims,
        ride.physicsText(ride.thawPhysics(qbPak, c.names), c.names) +
            bikeScripts.bikeGlobals(bikeScripts.readThawBike(qbPak, c.names), c.names) +
            ride.rideScripts(new bikeScripts.ThawScripts(qbPak, c.thaw)),
    );
    report.push(
        `ride: ${ride.PHYSICS}, ${ride.THAW_CAMERAS.length} bike cameras; THAW's bike scripts (phase 4): ` +
            `${bikeScripts.TRICK_LISTS.join(", ")}, ${bikeScripts.COPIED_GLOBALS.length} tables, the grind tricks`,
    );
    write(out, "scripts\\thaw_bmx\\thaw_bmx.ns", text, files); // (the source, for reading; not read by the game)
    let compiled = false;
    if (ns !== null) {
        const target = path.join(out, "scripts", "thaw_bmx", "thaw_bmx.qb");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        common.nsCompile(ns, text, target);
        files.push("scripts\\thaw_bmx\\thaw_bmx.qb");
        compiled = true;
        // (phase 4) every command the scripts run is THUG2's or ours (check.ts) - with the game's scripts to hand
        if (fs.existsSync(path.join(c.thug2, "Data", "pre", "qb_scripts.prx"))) {
            const thug2 = new Thug2(c.thug2);
            const unknown = check.unknownCommands(fs.readFileSync(target), thug2, c.names);
            if (unknown.length)
                throw new FormatError(
                    `thaw_bmx.qb: commands neither THUG2 nor ours have: ${unknown.map(([s, n]) => `${s}: ${n}`).join(", ")}`,
                );
            report.push("scripts: every command THUG2's or ours");
            // every animation the scripts name is converted or THUG2's own
            const have = new Set([...thug2.anims, ...anims.map((a) => checksum(a.row.desc))]);
            const missing = check.unknownAnimations(text, have);
            if (missing.length)
                throw new FormatError(`thaw_bmx.ns: animations neither converted nor THUG2's: ${missing.join(", ")}`);
            report.push(`scripts: all ${check.namedAnimations(text).size} animations named converted or THUG2's`);
        }
    }
    // the bike's sounds (phase 4: THAW's global_sfx, sounds.ts)
    const sfxPak = findPath(c.thaw, "data", "sounds", "pak", "global_sfx.pak.wpc");
    if (sfxPak === null) throw new FormatError("THAW: data\\sounds\\pak\\global_sfx.pak.wpc not found");
    const soundFiles = sounds.convertSounds(
        qbPak,
        sfxPak,
        c.names,
        bikeScripts.SOUNDS,
        (rel, data) => write(out, rel, data, files),
        ride.SOUND_FOLDER,
    );
    report.push(`sounds: ${soundFiles.length} (sounds\\${ride.SOUND_FOLDER})`);
    report.push(compiled ? "scripts: compiled" : "scripts: NeverScript source only (no --ns)");
    notes.push(
        "Rider animations are on THUG2's THPS6_human: the 48 shared bones' keys as THAW has them, the two Bone_Shoulder bones made from the biceps (SHOULDER_FRACTION), THAW's 4 twist bones dropped.",
        "The animation names are THAW's descChecksum names (collide with none of THUG2's animation names for the same reference; checked in selfcheck).",
        "The 5 bike_permanent animations are THAW's perm_anims 458-462 (animload_SI_BMX_P).",
    );
    const manifest: Manifest = {
        format: 1,
        generator: "tools/pipeline/thaw_bmx/convert.ts",
        staging: STAGING,
        skeleton: {
            name: SKELETON,
            checksum: hex8(checksum(SKELETON)),
            thawName: "si_bmx",
            file: `skeletons\\${SKELETON}.ske.xbx`,
            bones: sk.bike.map((b, i) => ({
                index: i,
                id: hex8(b.id),
                role: BIKE_ROLES[i] ?? "",
                parent: b.parent ? sk.bike.findIndex((x) => x.id === b.parent) : -1,
                mirror: b.mirror ? sk.bike.findIndex((x) => x.id === b.mirror) : -1,
                translation: b.t,
            })),
            rider: {
                reference: HUMAN,
                thawReference: "thps7_human",
                droppedThawBones:
                    humanMapping.from.length === 0
                        ? []
                        : sk.human
                              .map((_, i) => (humanMapping.from.includes(i) ? -1 : i))
                              .filter((i) => i >= 0)
                              .map((i) => hex8(sk.human[i]!.id)),
                shoulders: humanMapping.from
                    .map((f, k) =>
                        f < 0
                            ? {
                                  bone: hex8(humanMapping.thug2[k]!.id),
                                  index: k,
                                  bicepIndex: humanMapping.bicep[k],
                                  fraction: SHOULDER_FRACTION,
                              }
                            : null,
                    )
                    .filter(Boolean),
            },
        },
        model: {
            skin: `${base}.skin.xbx`,
            tex: `${base}.tex.xbx`,
            cas: `${base}.cas.xbx`,
            modelPath: MODEL,
            details: DETAILS,
            specialItemName: "ThawBmx",
            vertices: scene.sectors[0]?.meshes[0]?.vertexCount ?? 0,
            textures: textures.textures.map((t) => hex8(t.checksum)),
        },
        scripts: {
            source: "scripts\\thaw_bmx\\thaw_bmx.ns",
            compiled: "scripts\\thaw_bmx\\thaw_bmx.qb",
            installedIn: "scripts\\game\\skater\\specialitems.qb (appended by make_menu_level)",
            loadSkeleton: SKELETON_SCRIPT,
            riderAnims: RIDER_SCRIPT,
            bikeAnims: BIKE_SCRIPT,
            details: DETAILS,
            triggerScript: "thaw_bmx_bike_script",
            tests: [
                "thaw_bmx_test (run from outside: SpawnSkaterScript thaw_bmx_test_on_skater)",
                "thaw_bmx_test_load",
                "thaw_bmx_test_bike",
                "thaw_bmx_test_anim",
            ],
        },
        anims: manifestAnims,
        notes,
    };
    write(out, "thaw_bmx.json", `${JSON.stringify(manifest, null, 2)}\n`, files);
    return { files, manifest, report };
}

// --- checks ----------------------------------------------------------------------------------------------------------

function fk(bones: readonly Bone[], rot: (b: number) => Quat, trans: (b: number) => Vec): Vec[] {
    const worldQ: Quat[] = [];
    const worldP: Vec[] = [];
    bones.forEach((bone, i) => {
        const p = bone.parent === 0 ? -1 : bones.findIndex((x) => x.id === bone.parent);
        const q = rot(i);
        const t = trans(i);
        if (p < 0) {
            worldQ.push(q);
            worldP.push(t);
        } else {
            const r = skel.rotate(worldQ[p]!, t);
            worldP.push([worldP[p]![0] + r[0], worldP[p]![1] + r[1], worldP[p]![2] + r[2]]);
            worldQ.push(skel.qmul(worldQ[p]!, q));
        }
    });
    return worldP;
}

// Sample a rotation track at `frame` (nearest earlier key; the check needs agreement, not interpolation).
function sample<T extends { time: number }>(keys: readonly T[], frame: number): T | undefined {
    let best: T | undefined;
    for (const k of keys) if (k.time <= frame) best = k;
    return best ?? keys[0];
}

export function selfcheck(c: Context, ns: string | null): string[] {
    const report: string[] = [];
    const fail = (m: string): never => {
        throw new FormatError(`selfcheck: ${m}`);
    };
    const sk = thawSkeletons(c);
    const human = thug2Human(c);
    const mapping = humanMap(sk.human, human);
    // rest poses after the remap: THAW's matrices against THUG2's own
    let worstQ = 0;
    let worstT = 0;
    human.forEach((b, k) => {
        const f = mapping.from[k]!;
        if (f < 0) return;
        const a = sk.human[f]!;
        worstQ = Math.max(
            worstQ,
            Math.min(Math.hypot(...a.q.map((v, j) => v - b.q[j]!)), Math.hypot(...a.q.map((v, j) => v + b.q[j]!))),
        );
        worstT = Math.max(worstT, Math.hypot(...a.t.map((v, j) => v - b.t[j]!)));
        if (
            a.parent !== b.parent &&
            sk.human.findIndex((x) => x.id === a.parent) !== mapping.from[human.findIndex((x) => x.id === b.parent)]
        )
            fail(`bone ${hex8(b.id)}'s parent differs`);
    });
    report.push(
        `rest poses of the 48 shared rider bones: rotations within ${worstQ.toExponential(1)}, translations within ${worstT.toExponential(1)}`,
    );
    if (worstQ > 1e-3 || worstT > 1e-3) fail("rest poses differ");
    // our skeleton file reads back
    const written = writeSkeleton(sk.bike);
    const back = skel.readSkeleton(written);
    sk.bike.forEach((b, i) => {
        if (Math.hypot(...back.rest[i]!.t.map((v, j) => v - b.t[j]!)) > 1e-5) fail(`bike bone ${i} translation`);
    });
    report.push(
        `bike skeleton: ${sk.bike.length} bones written and read back; parents ${JSON.stringify(back.parents)}`,
    );
    // animations
    const tables = keyTables(c);
    const anims = readAnims(c);
    let poses = 0;
    let worstPose = 0;
    let worstShoulder = 0;
    for (const a of anims) {
        const src = ska.readSka(a.data, "thaw", tables, a.row.path);
        const result = a.set === "rider" ? remapRider(src, mapping) : src;
        const data = ska.writeSka(result);
        const back2 = ska.readSka(data, "thug2", tables, a.row.path);
        if (JSON.stringify(back2) !== JSON.stringify(result)) fail(`${a.row.path}: written and read back differ`);
        if (data.readUInt32LE(0xc) !== (a.set === "rider" ? 50 : 8)) fail(`${a.row.path}: bone count`);
        if (a.set === "rider" && result.partial !== undefined && result.partial.count !== 50)
            fail(`${a.row.path}: partial bits`);
        if (a.set !== "rider") continue;
        // pose check: the same pose from THAW's 52 bones and our 50 on THUG2's skeleton - the 48 shared bones' world
        // positions agree (same keys, same rest translations)
        for (const frame of [0, Math.round(src.duration * 30), Math.round(src.duration * 60)]) {
            const thawPose = fk(
                sk.human,
                (i) => {
                    const k = sample(src.rotations[i]!, frame);
                    return k ? skel.conj(ska.keyQuat(k)) : [0, 0, 0, 1];
                },
                (i) => {
                    const k = sample(src.translations[i]!, frame);
                    return k
                        ? [k.xyz[0] / ska.T_SCALE, k.xyz[1] / ska.T_SCALE, k.xyz[2] / ska.T_SCALE]
                        : sk.human[i]!.t;
                },
            );
            const ours = fk(
                human,
                (i) => {
                    const k = sample(result.rotations[i]!, frame);
                    return k ? skel.conj(ska.keyQuat(k)) : [0, 0, 0, 1];
                },
                (i) => {
                    const k = sample(result.translations[i]!, frame);
                    return k ? [k.xyz[0] / ska.T_SCALE, k.xyz[1] / ska.T_SCALE, k.xyz[2] / ska.T_SCALE] : human[i]!.t;
                },
            );
            human.forEach((_, k) => {
                const f = mapping.from[k]!;
                if (f < 0) return;
                worstPose = Math.max(worstPose, Math.hypot(...ours[k]!.map((v, j) => v - thawPose[f]![j]!)));
            });
            poses += 1;
        }
        mapping.from.forEach((f, k) => {
            if (f >= 0) return;
            const bicep = mapping.bicep[k]!;
            const sh = result.rotations[k]!;
            const bi = result.rotations[bicep]!;
            if (sh.length !== bi.length) fail(`${a.row.path}: shoulder keys ${sh.length} for ${bi.length} bicep keys`);
            sh.forEach((key, n) => {
                const half = skel.qmul(ska.keyQuat(bi[n]!), skel.conj(human[bicep]!.q));
                const angle = 2 * Math.acos(Math.min(1, Math.abs(ska.keyQuat(key)[3])));
                const full = 2 * Math.acos(Math.min(1, Math.abs(half[3])));
                worstShoulder = Math.max(worstShoulder, Math.abs(angle - full / 2));
            });
        });
    }
    report.push(
        `animations: ${anims.length} written and read back equal; rider poses (${poses} samples): shared bones' world positions within ${worstPose.toExponential(1)} units`,
    );
    report.push(`shoulder keys: half the bicep's swing from rest to within ${worstShoulder.toExponential(1)} rad`);
    if (worstPose > 0.05) fail("pose positions differ");
    // the rider's animation names (under THPS6_human) against THUG2's own: a name both have would be loaded twice
    const loose = path.join(c.thug2, "Data", "scripts", "allanims.ns");
    if (fs.existsSync(loose)) {
        const text = fs.readFileSync(loose, "latin1");
        const theirs = new Set([...text.matchAll(/descChecksum=(\S+)/g)].map((m) => m[1]!.toLowerCase()));
        const clash = anims
            .filter((a) => a.set === "rider" && theirs.has(a.row.desc.toLowerCase()))
            .map((a) => a.row.desc);
        report.push(
            `rider animation names also in THUG2's allanims.ns: ${clash.length}${clash.length ? ` (${clash.slice(0, 8).join(", ")})` : ""}`,
        );
        if (clash.length) fail("an animation name THUG2 has too");
    } else {
        report.push("(no Data\\scripts\\allanims.ns: the animation names weren't compared with THUG2's)");
    }
    void ns;
    return report;
}

// --- command line ------------------------------------------------------------------------------------------------------

export function main(argv: string[]): number {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            thaw: { type: "string", default: "C:\\Games\\THAW" },
            thug2: { type: "string", default: "C:\\Games\\THUG2" },
            out: { type: "string" },
            ns: { type: "string" },
        },
        allowPositionals: true,
    });
    const what = positionals[0] ?? "convert";
    const c = context(values.thaw!, values.thug2!);
    const ns = values.ns ?? null;
    if (what === "selfcheck") {
        for (const line of selfcheck(c, ns)) print(line);
        return 0;
    }
    if (what !== "convert") {
        process.stderr.write(`unknown command ${what}\n`);
        return 2;
    }
    const out = values.out ?? path.join(c.thug2, STAGING);
    fs.rmSync(out, { recursive: true, force: true });
    const result = convert(c, out, ns);
    for (const line of result.report) print(line);
    print(`${result.files.length} files into ${out}`);
    return 0;
}

if (isMain(import.meta.url)) {
    helpFromHeader(import.meta.url);
    await runMain(() => main(process.argv.slice(2)));
}
