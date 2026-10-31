// NOT ORIGINAL - Tony Hawk's Proving Ground's scenes (.scn in the zone archives, and the models' .mdl; Xbox 360,
// big-endian) read into tools/pipeline/thp8_levels/geom.ts's forms - worked out from the data (no code of the game used).
//
// The container and the scene are THP8's (geom.ts): u32 0, 7 x 0xCABAAAFA, the material block at 0x20 (u16 version,
// u16 count, u32 size from 0x20, u32 offset of the first record from 0x20), then 0xBABEFACE and the scene (sectors,
// sector nodes, meshes as THP8's). What differs:
//
// - Materials (block version 0x0410): records one after another, each as long as its own size word, the parameters
//   inline (THP8's 0x0310 has 0x134-byte records and separate parameter blocks). From the record's start R:
//     +0x00  the material's checksum, then 0x9C bytes of 0
//     +0xA0  the shader template (FXFILES\MaterialLibrary.bin's: D_3ChkBox_Pass0, D_N_S_4ChkBox_Pass1...)
//     +0xA8  count, +0xAC offset (from R) of 16-byte animation entries (the wibble / water templates')
//     +0xB0  float4 count, +0xB4 their offset; +0xB8 texture count, +0xBC their offset (checksums)
//     +0xC4  the record's size (again at +0xE4)
//     +0xCC  state bits (0x44 on most solid materials, 0x04 on blended / alpha-tested ones, 0x20 soft-edged sprites)
//     +0xD0  a checksum (the surface's sound / terrain kind, 0 on many), +0xD4 a float
//     +0xD8  the blend mode: 0 none, 1 add, 3 alpha blend (2 on a few)
//     +0xE8  top byte: the alpha test reference (0 = none)
//   Checked over all 72 zone archives: 6,609 records, each block walked to its end exactly.
//   A record is given to the converter as THP8's GeomMaterial, its parameter block made in THP8's layout (the header's
//   template, texture count, float4 count, blend and alpha reference words at THP8's places, then the float4s and the
//   textures - materials.ts reads them there).
// - Sectors: 0x60 bytes (THP8's 0x50), the sphere at +0x40 (THP8's +0x30); the sector nodes and meshes as THP8's.
// - Textures: a lit material lists its zone's light map last - one map (THP8 lists two: an ambient and a shadow map),
//   2048 x 2048 DXT1 in the city's zones, its own uv field the mesh's last. Unlit ones list a 32 x 32 white stand-in
//   there (PAK\global_env_tex.pak.xen's D729D3B1). The global stand-ins (white, black, grey, the default cube maps and
//   normal maps) are in global_env_tex, not in the zones' .tex.
// - Vertices: the uv fields keep their slot numbers with gaps between them (slots 0 and 5: layout 0x08020078) and a
//   field kind 3 (four 16-bit floats, 8 bytes: the vertex-colour wibble templates' meshes - geom.ts uvFields). Each
//   mesh's vertices are re-packed in THP8's plainest layout here: position, normal word, colour at 16, the uv fields
//   one after the other from 20 (a kind-3 field as its first two halves), so geom.readVertices reads them in order.

import { FormatError } from "../level_port/binio.ts";
import * as geom from "../thp8_levels/geom.ts";

export const VERSION = 0x0410;
export const SECTOR_SIZE = 0x60; // (THP8's 0x50: +0 0, +4 the node's name, +8 flags, then -1, -1)
export const SECTOR_SPHERE = 0x40;
export const REC_TEMPLATE = 0xa0;
export const REC_FLOAT4S = 0xb0; // count, offset
export const REC_TEXTURES = 0xb8; // count, offset
export const REC_SIZE = 0xc4;
export const REC_STATE = 0xcc;
export const REC_SURFACE = 0xd0;
export const REC_BLEND = 0xd8;
export const REC_ALPHA_REF = 0xe8;

// THP8's parameter block (geom.ts / materials.ts): where its header words are.
const P_TEMPLATE = 0x04;
const P_TEXTURES = 0x08;
const P_SIZE = 0x0c;
const P_FLOAT4S = 0x18;
const P_TERRAIN = 0x1c;
const P_BLEND = 0x30;
const P_ALPHA_REF = 0x38;
const P_STATE = 0x3c;
const P_HEADER = 0x50;

// One material record (at `at`) as THP8's GeomMaterial.
export function readMaterial(data: Buffer, at: number, end: number, name: string): geom.GeomMaterial {
    const u32 = (o: number): number => data.readUInt32BE(at + o);
    const size = u32(REC_SIZE);
    if (size < REC_ALPHA_REF + 4 || at + size > end)
        throw new FormatError(`${name}: material record of 0x${size.toString(16)} bytes`);
    const nf = u32(REC_FLOAT4S);
    const nt = u32(REC_TEXTURES);
    const fAt = u32(REC_FLOAT4S + 4);
    const tAt = u32(REC_TEXTURES + 4);
    if ((nf && fAt + 16 * nf > size) || (nt && tAt + 4 * nt > size) || nt > 32)
        throw new FormatError(`${name}: material ${u32(0).toString(16)}: its float4s / textures past the record`);
    const textures = Array.from({ length: nt }, (_, k) => u32(tAt + 4 * k));
    const params = Buffer.alloc(P_HEADER + 16 * nf + 4 * nt);
    params.writeUInt32BE(u32(REC_TEMPLATE), P_TEMPLATE);
    params.writeUInt32BE(nt, P_TEXTURES);
    params.writeUInt32BE(params.length - 0x10, P_SIZE);
    params.writeUInt32BE(nf, P_FLOAT4S);
    params.writeUInt32BE(u32(REC_SURFACE), P_TERRAIN);
    params.writeUInt32BE(u32(REC_BLEND), P_BLEND);
    params.writeUInt32BE(u32(REC_ALPHA_REF), P_ALPHA_REF);
    params.writeUInt32BE(u32(REC_STATE), P_STATE);
    data.copy(params, P_HEADER, at + fAt, at + fAt + 16 * nf);
    textures.forEach((t, k) => {
        params.writeUInt32BE(t, P_HEADER + 16 * nf + 4 * k);
    });
    return {
        checksum: u32(0),
        flags: 0,
        template: u32(REC_TEMPLATE),
        textures,
        terrain: u32(REC_SURFACE),
        state: u32(REC_STATE),
        params,
    };
}

// The mesh's vertices in THP8's plain layout (position, normal word, colour at 16, the uv fields from 20 in order);
// `copyLast` adds a copy of the last uv field (the light map's: see light.ts).
export function repack(m: geom.GeomMesh, copyLast = false): geom.GeomMesh {
    const fields = geom.uvFields(m.layout);
    const n = fields.length + (copyLast && fields.length ? 1 : 0);
    const stride = 20 + 4 * n;
    const out = Buffer.alloc(stride * m.vertexCount);
    for (let i = 0; i < m.vertexCount; i++) {
        const v = i * m.stride;
        const w = i * stride;
        m.vertices.copy(out, w, v, v + 12);
        // (the packed normal word, when the layout has one before the colour)
        if (m.colorOffset >= 16) m.vertices.copy(out, w + 12, v + 12, v + 16);
        m.vertices.copy(out, w + 16, v + m.colorOffset, v + m.colorOffset + 4);
        fields.forEach((f, k) => {
            m.vertices.copy(out, w + 20 + 4 * k, v + m.uvOffset + f.offset, v + m.uvOffset + f.offset + 4);
        });
        if (n > fields.length)
            out.copyWithin(w + 20 + 4 * fields.length, w + 20 + 4 * (fields.length - 1), w + 20 + 4 * fields.length);
    }
    let layout = m.layout & 0xffff & ~0xc00; // (no tangent words)
    for (let k = 0; k < n; k++) layout |= 2 << (16 + 2 * k);
    return { ...m, layout: layout >>> 0, colorOffset: 16, uvOffset: 20, stride, vertices: out };
}

export function readThpgGeom(data: Buffer, name = "scn"): geom.Geom {
    const version = data.readUInt16BE(0x20);
    if (version !== VERSION) throw new FormatError(`${name}: material block version ${version.toString(16)}`);
    const count = data.readUInt16BE(0x22);
    const end = 0x20 + data.readUInt32BE(0x24);
    let at = 0x20 + data.readUInt32BE(0x28);
    const materials: geom.GeomMaterial[] = [];
    for (let i = 0; i < count; i++) {
        const m = readMaterial(data, at, end, name);
        materials.push(m);
        at += data.readUInt32BE(at + REC_SIZE);
    }
    if (at !== end)
        throw new FormatError(
            `${name}: the material records end at 0x${at.toString(16)}, the block at 0x${end.toString(16)}`,
        );
    // (sectors of 0x60 bytes, their sphere at +0x40: the sector nodes follow them straight on)
    const h = end + data.readUInt32BE(end + 4);
    const sectors = data.readUInt32BE(h + 0x74);
    const gap = data.readUInt32BE(h + 0x7c) - data.readUInt32BE(h + 0x78);
    if (sectors && gap !== SECTOR_SIZE * sectors)
        throw new FormatError(`${name}: ${sectors} sectors in 0x${gap.toString(16)} bytes`);
    const g = geom.readScene(data, end, materials, name, SECTOR_SIZE, SECTOR_SPHERE);
    // (the meshes re-packed: the sectors share the mesh objects)
    const packed = new Map<geom.GeomMesh, geom.GeomMesh>();
    for (const s of g.sectors) {
        s.meshes = s.meshes.map((m) => {
            let p = packed.get(m);
            if (p === undefined) {
                p = repack(m);
                packed.set(m, p);
            }
            return p;
        });
    }
    return g;
}

geom.READERS.set(VERSION, readThpgGeom);
