// NOT ORIGINAL - skeletal animation (.ska) files of THAW and THUG2 as key lists, and THUG2's written back from them.
//
// THUG2's player: FUN_00484760 (0x00484760) with the key decoders 0x00482C20 (rotation) and 0x00482E70 (translation);
// THAW's files have the same key forms and flag family (0x06834000 / 0x06810000 / 0x068B4000 partial) in a header laid
// out differently:
//   THAW:  u32 0x28, u32 flags, f32 duration, u8 0, u8 bones, u16 rotation keys, u32 translation keys, 5 x u32 -1,
//          u32 rotation bytes, u32 translation bytes, u16 rotation bytes per bone, u16 translation bytes per bone,
//          (aligned to 4; flag 0x80000, a partial animation: u32 count and its bits, aligned) the rotation keys, the
//          translation keys.
//   THUG2: u32 1, u32 flags, f32 duration, u32 bones, u32 rotation keys, u32 translation keys, u32 custom keys,
//          u32 rotation bytes, u32 translation bytes, then the same (tools/pipeline/thug1_levels/thug1.ts untableAnim).
// A rotation key: u16 h (a sign bit 0x8000 for w; the time: h & 0x3fff in the full form, h & 0x7ff in the packed
// ones), then
//   h & 0x4000 clear: x, y, z as u16 each (flag 0x8000: a byte each, << 8);
//   h & 0x3800 clear: a byte, the index of the standard rotation table's entry (8 bytes: x, y, z u16, then a u16
//     that is the one-component table);
//   else, flag 0x10000: x / y / z (h bits 0x2000 / 0x1000 / 0x800) a byte, the index into the one-component table
//     (the entry's fourth u16), else the full form; without the flag the byte is the value itself.
// A translation key: byte b (b & 0x40: the time is b & 0x3f, else a u16 follows), then b & 0x80: a byte, the standard
// translation table's entry (x, y, z u16), else x, y, z u16.
// The game's standard key tables (anims\standardkeyQ.bin / standardkeyT.bin) differ between the games, so a key that
// reads the table is written out in full.
//
// Quaternion keys are the file's stored form: (x, y, z) / 16384 of the conjugate, w recovered and negative when the
// sign bit is set (tools/pipeline/thps3_levels/thps3_skin.ts).

import { FormatError } from "../level_port/binio.ts";

export const Q_SCALE = 16384;
export const T_SCALE = 32;
export const FLAG_PARTIAL = 0x80000;
export const FLAG_BYTE_VALUES = 0x8000;
export const FLAG_ONE_COMPONENT_TABLE = 0x10000;
// (flags the readers don't handle: 0x100 the extended time, 0x2000 a table of its own in the file)
const UNSUPPORTED = 0x100 | 0x2000;

export interface RotationKey {
    time: number; // frames
    negative: boolean; // w < 0
    xyz: [number, number, number]; // the file's u16 as a signed 16-bit value
}
export interface TranslationKey {
    time: number;
    xyz: [number, number, number];
}

export interface Ska {
    flags: number;
    duration: number;
    rotations: RotationKey[][]; // per bone
    translations: TranslationKey[][];
    partial?: { count: number; bits: number[] }; // flag 0x80000: the bones that are animated (a set bit)
    tail: Buffer; // anything after the translation keys (none in the files seen)
}

export interface KeyTables {
    q: Buffer; // anims\standardkeyQ.bin: 256 x 8 bytes
    t: Buffer; // anims\standardkeyT.bin
}

export type Layout = "thaw" | "thug2";

const s16 = (v: number): number => (v << 16) >> 16;

export function boneCount(data: Buffer, layout: Layout): number {
    return layout === "thaw" ? data[0xd]! : data.readUInt32LE(0xc);
}

function decodeRotation(d: Buffer, at: number, flags: number, tables: KeyTables, name: string): [RotationKey, number] {
    let p = at;
    const h = d.readUInt16LE(p);
    p += 2;
    const full = !(h & 0x4000);
    const time = full ? h & 0x3fff : h & 0x7ff;
    const comp = (): number => {
        if (flags & FLAG_BYTE_VALUES) return s16(d[p++]! << 8);
        const v = d.readUInt16LE(p);
        p += 2;
        return s16(v);
    };
    let xyz: [number, number, number];
    if (full) {
        xyz = [comp(), comp(), comp()];
    } else if (!(h & 0x3800)) {
        const e = d[p++]! * 8;
        xyz = [s16(tables.q.readUInt16LE(e)), s16(tables.q.readUInt16LE(e + 2)), s16(tables.q.readUInt16LE(e + 4))];
    } else {
        const out: number[] = [];
        for (const bit of [0x2000, 0x1000, 0x800]) {
            if (h & bit) {
                const b = d[p++]!;
                out.push(flags & FLAG_ONE_COMPONENT_TABLE ? s16(tables.q.readUInt16LE(b * 8 + 6)) : b);
            } else {
                out.push(comp());
            }
        }
        xyz = out as [number, number, number];
    }
    if (p > d.length) throw new FormatError(`${name}: rotation key past the end`);
    return [{ time, negative: Boolean(h & 0x8000), xyz }, p];
}

function decodeTranslation(d: Buffer, at: number, tables: KeyTables, name: string): [TranslationKey, number] {
    let p = at;
    const b = d[p++]!;
    let time: number;
    if (b & 0x40) {
        time = b & 0x3f;
    } else {
        time = d.readUInt16LE(p);
        p += 2;
    }
    let xyz: [number, number, number];
    if (b & 0x80) {
        const e = d[p++]! * 8;
        xyz = [s16(tables.t.readUInt16LE(e)), s16(tables.t.readUInt16LE(e + 2)), s16(tables.t.readUInt16LE(e + 4))];
    } else {
        xyz = [s16(d.readUInt16LE(p)), s16(d.readUInt16LE(p + 2)), s16(d.readUInt16LE(p + 4))];
        p += 6;
    }
    if (p > d.length) throw new FormatError(`${name}: translation key past the end`);
    return [{ time, xyz }, p];
}

export function readSka(data: Buffer, layout: Layout, tables: KeyTables, name = "ska"): Ska {
    const flags = data.readUInt32LE(4);
    if (flags & UNSUPPORTED) throw new FormatError(`${name}: flags ${flags.toString(16)}`);
    const duration = data.readFloatLE(8);
    let bones: number;
    let sizesAt: number;
    let qSize: number;
    let tSize: number;
    if (layout === "thaw") {
        if (data.readUInt32LE(0) !== 0x28) throw new FormatError(`${name}: version ${data.readUInt32LE(0)}`);
        bones = data[0xd]!;
        sizesAt = 0x30;
        qSize = data.readUInt32LE(0x28);
        tSize = data.readUInt32LE(0x2c);
    } else {
        if (data.readUInt32LE(0) !== 1) throw new FormatError(`${name}: version ${data.readUInt32LE(0)}`);
        if (data.readUInt32LE(0x18) !== 0) throw new FormatError(`${name}: custom keys`);
        bones = data.readUInt32LE(0xc);
        sizesAt = 0x24;
        qSize = data.readUInt32LE(0x1c);
        tSize = data.readUInt32LE(0x20);
    }
    let p = (sizesAt + 4 * bones + 3) & ~3;
    let partial: Ska["partial"];
    if (flags & FLAG_PARTIAL) {
        const count = data.readInt32LE(p);
        const words = ((count - 1) >> 5) + 1;
        const bits = [...Array(words)].map((_, i) => data.readUInt32LE(p + 4 + 4 * i));
        partial = { count, bits };
        p = (p + 4 * (((count - 1) >> 5) + 2) + 3) & ~3;
    }
    const start = p;
    const rotations: RotationKey[][] = [];
    for (let b = 0; b < bones; b++) {
        const end = p + data.readUInt16LE(sizesAt + 2 * b);
        const keys: RotationKey[] = [];
        while (p < end) {
            const [k, next] = decodeRotation(data, p, flags, tables, name);
            keys.push(k);
            p = next;
        }
        if (p !== end) throw new FormatError(`${name}: bone ${b}'s rotation keys overrun`);
        rotations.push(keys);
    }
    if (p !== start + qSize) throw new FormatError(`${name}: rotation bytes don't add up`);
    const translations: TranslationKey[][] = [];
    for (let b = 0; b < bones; b++) {
        const end = p + data.readUInt16LE(sizesAt + 2 * bones + 2 * b);
        const keys: TranslationKey[] = [];
        while (p < end) {
            const [k, next] = decodeTranslation(data, p, tables, name);
            keys.push(k);
            p = next;
        }
        if (p !== end) throw new FormatError(`${name}: bone ${b}'s translation keys overrun`);
        translations.push(keys);
    }
    if (p !== start + qSize + tSize) throw new FormatError(`${name}: translation bytes don't add up`);
    const tail = Buffer.from(data.subarray(p));
    if (tail.some((x) => x !== 0)) throw new FormatError(`${name}: ${tail.length} bytes after the keys`);
    const ska: Ska = { flags, duration, rotations, translations, tail: Buffer.alloc(0) };
    if (partial !== undefined) ska.partial = partial;
    return ska;
}

// The header counts of a THAW file (u16 at 0xE: rotation keys, u32 at 0x10: translation keys - checked against the
// keys read, see convert.test.ts).
export function thawKeyCounts(data: Buffer): [number, number] {
    return [data.readUInt16LE(0xe), data.readUInt32LE(0x10)];
}

// --- THUG2's file ------------------------------------------------------------------------------------------------

export function writeSka(ska: Ska): Buffer {
    const bones = ska.rotations.length;
    if (ska.translations.length !== bones) throw new FormatError("writeSka: rotation and translation bones differ");
    if (ska.flags & (FLAG_BYTE_VALUES | UNSUPPORTED))
        throw new FormatError(`writeSka: flags ${ska.flags.toString(16)}`);
    const rot = ska.rotations.map((keys) => {
        const b = Buffer.alloc(8 * keys.length);
        keys.forEach((k, i) => {
            if (k.time < 0 || k.time > 0x3fff) throw new FormatError(`writeSka: rotation key at frame ${k.time}`);
            b.writeUInt16LE(k.time | (k.negative ? 0x8000 : 0), 8 * i);
            for (let c = 0; c < 3; c++) b.writeInt16LE(k.xyz[c]!, 8 * i + 2 + 2 * c);
        });
        return b;
    });
    const tra = ska.translations.map((keys) => {
        const b = Buffer.alloc(9 * keys.length);
        keys.forEach((k, i) => {
            if (k.time < 0 || k.time > 0xffff) throw new FormatError(`writeSka: translation key at frame ${k.time}`);
            b[9 * i] = 0;
            b.writeUInt16LE(k.time, 9 * i + 1);
            for (let c = 0; c < 3; c++) b.writeInt16LE(k.xyz[c]!, 9 * i + 3 + 2 * c);
        });
        return b;
    });
    for (const b of [...rot, ...tra])
        if (b.length > 0xffff) throw new FormatError("writeSka: a bone's keys past 64 KB");
    const q = Buffer.concat(rot);
    const t = Buffer.concat(tra);
    let head = Buffer.alloc((0x24 + 4 * bones + 3) & ~3);
    head.writeUInt32LE(1, 0);
    head.writeUInt32LE(ska.flags, 4);
    head.writeFloatLE(ska.duration, 8);
    head.writeUInt32LE(bones, 0xc);
    head.writeUInt32LE(
        rot.reduce((n, b) => n + b.length / 8, 0),
        0x10,
    );
    head.writeUInt32LE(
        tra.reduce((n, b) => n + b.length / 9, 0),
        0x14,
    );
    head.writeUInt32LE(0, 0x18);
    head.writeUInt32LE(q.length, 0x1c);
    head.writeUInt32LE(t.length, 0x20);
    rot.forEach((b, i) => {
        head.writeUInt16LE(b.length, 0x24 + 2 * i);
    });
    tra.forEach((b, i) => {
        head.writeUInt16LE(b.length, 0x24 + 2 * bones + 2 * i);
    });
    if (ska.flags & FLAG_PARTIAL) {
        if (ska.partial === undefined) throw new FormatError("writeSka: a partial animation without its bone bits");
        const extra = Buffer.alloc(4 * (((ska.partial.count - 1) >> 5) + 2));
        extra.writeInt32LE(ska.partial.count, 0);
        ska.partial.bits.forEach((w, i) => {
            extra.writeUInt32LE(w >>> 0, 4 + 4 * i);
        });
        head = Buffer.concat([head, extra]);
        head = Buffer.concat([head, Buffer.alloc(((head.length + 3) & ~3) - head.length)]);
    }
    const body = Buffer.concat([q, t]);
    return Buffer.concat([head, body, Buffer.alloc(((body.length + 3) & ~3) - body.length)]);
}

// A quaternion key as Hamilton floats (x y z w) of the conjugate - the file's stored form unconjugated.
export function keyQuat(k: RotationKey): [number, number, number, number] {
    const x = k.xyz[0] / Q_SCALE;
    const y = k.xyz[1] / Q_SCALE;
    const z = k.xyz[2] / Q_SCALE;
    const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z)) * (k.negative ? -1 : 1);
    return [-x, -y, -z, w];
}

// The inverse: a Hamilton quaternion into a key at `time`.
export function quatKey(time: number, q: readonly [number, number, number, number]): RotationKey {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    // (stored = conjugate)
    const x = -q[0] / n;
    const y = -q[1] / n;
    const z = -q[2] / n;
    const w = q[3] / n;
    const c = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * Q_SCALE)));
    return { time, negative: w < 0, xyz: [c(x), c(y), c(z)] };
}
