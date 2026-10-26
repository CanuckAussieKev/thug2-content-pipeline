// NOT ORIGINAL - tests of the THAW BMX converter's pure parts (no game data): the animation key forms, the header
// rewrite, the rider remap and the skeleton file.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checksum } from "../level_port/qb.ts";
import type { Quat } from "../thps3_levels/thps3_skin.ts";
import * as skel from "../thps3_levels/thps3_skin.ts";
import {
    type Bone,
    humanMap,
    loadRows,
    readThawSkeleton,
    remapRider,
    slerpFromIdentity,
    writeSkeleton,
} from "./convert.ts";
import * as ska from "./ska.ts";

// standard key tables: entry n = x n, y 2n, z 3n (rotation), w (one-component table) 10 + n
const tables: ska.KeyTables = {
    q: Buffer.alloc(2048),
    t: Buffer.alloc(2048),
};
for (let n = 0; n < 256; n++) {
    tables.q.writeUInt16LE(n, 8 * n);
    tables.q.writeUInt16LE(2 * n, 8 * n + 2);
    tables.q.writeUInt16LE(3 * n, 8 * n + 4);
    tables.q.writeUInt16LE(100 + n, 8 * n + 6);
    tables.t.writeUInt16LE(5 * n, 8 * n);
    tables.t.writeUInt16LE(6 * n, 8 * n + 2);
    tables.t.writeUInt16LE(7 * n, 8 * n + 4);
}

// A THAW file of `bones` bones: rotation keys / translation keys per bone as raw bytes.
function thawFile(flags: number, bones: number, q: Buffer[], t: Buffer[], partial?: number[]): Buffer {
    const sizes = Buffer.alloc(4 * bones);
    q.forEach((b, i) => {
        sizes.writeUInt16LE(b.length, 2 * i);
    });
    t.forEach((b, i) => {
        sizes.writeUInt16LE(b.length, 2 * bones + 2 * i);
    });
    const head = Buffer.alloc(0x30);
    head.writeUInt32LE(0x28, 0);
    head.writeUInt32LE(flags, 4);
    head.writeFloatLE(0.5, 8);
    head[0xd] = bones;
    head.writeUInt16LE(q.reduce((n, b) => n + b.length, 0) ? 1 : 0, 0xe);
    head.writeUInt32LE(Buffer.concat(q).length, 0x28);
    head.writeUInt32LE(Buffer.concat(t).length, 0x2c);
    let rest = Buffer.concat([sizes]);
    rest = Buffer.concat([rest, Buffer.alloc(((rest.length + 0x30 + 3) & ~3) - rest.length - 0x30)]);
    if (partial !== undefined) {
        const bits = Buffer.alloc(8);
        bits.writeInt32LE(bones, 0);
        bits.writeUInt32LE(partial[0]! >>> 0, 4);
        rest = Buffer.concat([rest, bits]);
    }
    const body = Buffer.concat([...q, ...t]);
    return Buffer.concat([head, rest, body, Buffer.alloc(((body.length + 3) & ~3) - body.length)]);
}

const u16 = (...v: number[]): Buffer => {
    const b = Buffer.alloc(2 * v.length);
    v.forEach((x, i) => {
        b.writeUInt16LE(x & 0xffff, 2 * i);
    });
    return b;
};

test("rotation key forms: full, table, one-component table and bytes", () => {
    const flags = 0x06834000; // (0x10000: the bytes of a mixed key index the one-component table)
    const full = Buffer.concat([u16(5, 100, 200, 300)]); // time 5
    const table = Buffer.concat([u16(0x4000 | 0x8000 | 6), Buffer.from([7])]); // packed, table entry 7, w negative, time 6
    const mixed = Buffer.concat([u16(0x4000 | 0x2000 | 9), Buffer.from([4]), u16(11, 12)]); // x from the table (entry 4), y, z full
    const data = thawFile(flags, 1, [Buffer.concat([full, table, mixed])], [Buffer.alloc(0)]);
    const s = ska.readSka(data, "thaw", tables, "t");
    const keys = s.rotations[0]!;
    assert.deepEqual(keys[0], { time: 5, negative: false, xyz: [100, 200, 300] });
    assert.deepEqual(keys[1], { time: 6, negative: true, xyz: [7, 14, 21] });
    assert.deepEqual(keys[2], { time: 9, negative: false, xyz: [104, 11, 12] });
});

test("translation key forms: time in the byte, table entry", () => {
    const flags = 0x06834000;
    const a = Buffer.concat([Buffer.from([0x40 | 0x80 | 3, 2])]); // time 3, table entry 2
    const b = Buffer.concat([Buffer.from([0x00]), u16(300, 1, 2, 3)]); // time 300 (a u16), plain
    const data = thawFile(flags, 1, [Buffer.alloc(0)], [Buffer.concat([a, b])]);
    const s = ska.readSka(data, "thaw", tables, "t");
    assert.deepEqual(s.translations[0], [
        { time: 3, xyz: [10, 12, 14] },
        { time: 300, xyz: [1, 2, 3] },
    ]);
});

test("a THAW file written as THUG2's reads back the same, with the header counts in place", () => {
    const flags = 0x068b4000;
    const q = [Buffer.concat([u16(1, 1, 2, 3), Buffer.concat([u16(0x4000 | 8), Buffer.from([9])])]), Buffer.alloc(0)];
    const t = [Buffer.from([0x40 | 0x80 | 1, 5]), Buffer.alloc(0)];
    const data = thawFile(flags, 2, q, t, [0b10]);
    const s = ska.readSka(data, "thaw", tables, "t");
    assert.deepEqual(s.partial, { count: 2, bits: [2] });
    const out = ska.writeSka(s);
    assert.equal(out.readUInt32LE(0), 1);
    assert.equal(out.readUInt32LE(4), flags);
    assert.equal(out.readUInt32LE(0xc), 2);
    assert.equal(out.readUInt32LE(0x10), 2); // rotation keys
    assert.equal(out.readUInt32LE(0x14), 1); // translation keys
    assert.equal(out.readUInt32LE(0x1c), 16); // 2 x 8 bytes: the table key written out
    assert.equal(out.readUInt32LE(0x20), 9);
    assert.deepEqual(ska.readSka(out, "thug2", tables, "t"), s);
    // the rotation key that read the table is a full one now
    assert.equal(out.readUInt16LE(out.length - 9 - 8 - 0) & 0x4000, 0);
});

test("a key stream that doesn't end where its size says is an error", () => {
    const data = thawFile(0x06834000, 1, [u16(1, 2, 3, 4)], [Buffer.alloc(0)]);
    data.writeUInt16LE(7, 0x30); // 7 bytes for an 8-byte key
    data.writeUInt32LE(7, 0x28);
    assert.throws(() => ska.readSka(data, "thaw", tables, "t"));
});

test("quaternion keys: a Hamilton quaternion in, the same out", () => {
    const q = skel.normalize([0.1, -0.5, 0.3, 0.8]) as Quat;
    const back = ska.keyQuat(ska.quatKey(4, q));
    q.forEach((v, i) => {
        assert.ok(Math.abs(v - back[i]!) < 1e-3);
    });
    const neg = ska.keyQuat(ska.quatKey(0, [0, 0, 0.6, -0.8]));
    assert.ok(neg[3] < 0);
});

test("slerpFromIdentity halves the angle, shortest way", () => {
    const half = slerpFromIdentity([Math.sin(0.5), 0, 0, Math.cos(0.5)], 0.5); // 1 rad about x
    assert.ok(Math.abs(half[0] - Math.sin(0.25)) < 1e-9 && Math.abs(half[3] - Math.cos(0.25)) < 1e-9);
    const flipped = slerpFromIdentity([-Math.sin(0.5), 0, 0, -Math.cos(0.5)], 0.5);
    assert.ok(Math.abs(flipped[0] - Math.sin(0.25)) < 1e-9 && flipped[3] > 0); // (the same rotation: the sign of q is free)
    assert.deepEqual(slerpFromIdentity([0, 0, 0, 1], 0.5), [0, 0, 0, 1]);
});

const bone = (id: number, parent: number, t: [number, number, number], q: Quat = [0, 0, 0, 1]): Bone => ({
    id,
    parent,
    mirror: 0,
    t,
    q,
});

test("remapRider: shared bones' keys kept in THUG2's order, the shoulder from the bicep, THAW's twist bones dropped", () => {
    // THAW: root(1) collar(2) bicep(3) twist(4) twist(5); THUG2: root collar bicep shoulder
    const bicepRest = skel.normalize([0, -0.7, 0, 0.7]) as Quat;
    const thaw: Bone[] = [
        bone(1, 0, [0, 0, 0]),
        bone(2, 1, [0, 1, 0]),
        bone(3, 2, [1, 0, 0], bicepRest),
        bone(4, 3, [0, 0, 1]),
        bone(5, 3, [0, 0, 0]),
    ];
    const thug2: Bone[] = [
        bone(1, 0, [0, 0, 0]),
        bone(2, 1, [0, 1, 0]),
        bone(3, 2, [1, 0, 0], bicepRest),
        bone(9, 2, [1, 0.01, 0]),
    ];
    const map = humanMap(thaw, thug2, 2);
    assert.deepEqual(map.from, [0, 1, 2, -1]);
    assert.deepEqual(map.bicep, [-1, -1, -1, 2]);
    // the bicep turned 1 rad about z from its rest: the shoulder half a radian
    const turned = skel.qmul([0, 0, Math.sin(0.5), Math.cos(0.5)], bicepRest);
    const src: ska.Ska = {
        flags: 0x068b4000,
        duration: 1,
        rotations: [[], [], [ska.quatKey(7, turned)], [ska.quatKey(7, [0, 0, 1, 0])], []],
        translations: [[{ time: 0, xyz: [1, 2, 3] }], [], [], [], []],
        partial: { count: 5, bits: [0b00101] }, // root and the bicep animated
        tail: Buffer.alloc(0),
    };
    const out = remapRider(src, map);
    assert.equal(out.rotations.length, 4);
    assert.deepEqual(out.rotations[2], src.rotations[2]);
    assert.deepEqual(out.translations[0], src.translations[0]);
    const shoulder = ska.keyQuat(out.rotations[3]![0]!);
    assert.equal(out.rotations[3]![0]!.time, 7);
    assert.ok(Math.abs(shoulder[2] - Math.sin(0.25)) < 1e-3 && Math.abs(shoulder[3] - Math.cos(0.25)) < 1e-3);
    assert.deepEqual(out.translations[3], []);
    assert.deepEqual(out.partial, { count: 4, bits: [0b1101] }); // root, bicep and the shoulder
});

test("humanMap wants exactly 4 THAW bones with no THUG2 bone", () => {
    const thaw: Bone[] = [bone(1, 0, [0, 0, 0]), bone(2, 1, [0, 1, 0])];
    assert.throws(() => humanMap(thaw, [bone(1, 0, [0, 0, 0]), bone(2, 1, [0, 1, 0])], 4));
});

test("writeSkeleton: THUG2's .ske.xbx, readable by the THPS3 reader", () => {
    const q = skel.normalize([0.2, 0.1, -0.6, 0.7]) as Quat;
    const bones: Bone[] = [bone(0xabc, 0, [0, 0, 0]), { ...bone(0xdef, 0xabc, [1, 2, 3], q), mirror: 0xabc }];
    const d = writeSkeleton(bones);
    assert.equal(d.length, 12 + 12 * 2 + 32 * 2);
    const back = skel.readSkeleton(d);
    assert.deepEqual(back.parents, [-1, 0]);
    back.rest[1]!.q.forEach((v, i) => {
        assert.ok(Math.abs(v - q[i]!) < 1e-6);
    });
    assert.deepEqual(back.rest[1]!.t, [1, 2, 3]);
    assert.equal(d.readUInt32LE(12 + 8 * 2 + 4), 0xabc); // bone 1's mirror
});

test("readThawSkeleton: a rotated root and a child; the local rotation is parent^-1 * child", () => {
    // two bones; matrices (rows) as THAW stores them: bone 0 rotated -90 degrees about x, bone 1 the same
    const d = Buffer.alloc(0x400);
    d.writeUInt16LE(1, 0);
    d.writeUInt32LE(2, 4);
    const names = 0x100;
    d.writeUInt32LE(names, 0x10);
    d.writeUInt32LE(names + 8, 0x14);
    d.writeUInt32LE(names + 16, 0x18);
    d.writeUInt32LE(0x2c0, 0x28);
    d.writeUInt32LE(0x30, 0x2c);
    d.writeUInt32LE(11, names);
    d.writeUInt32LE(22, names + 4);
    d.writeUInt32LE(0, names + 8);
    d.writeUInt32LE(11, names + 12);
    [0, 0, 0, 1, 0, 3, 4, 1].forEach((v, i) => {
        d.writeFloatLE(v, 0x30 + 4 * i);
    });
    const rows = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
    for (const b of [0, 1]) {
        rows.forEach((v, i) => {
            d.writeFloatLE(v, 0x2c0 + 64 * b + 4 * i);
        });
    }
    const bones = readThawSkeleton(d, "t");
    assert.deepEqual(
        bones.map((b) => b.id),
        [11, 22],
    );
    assert.equal(bones[1]!.parent, 11);
    const root = bones[0]!.q;
    assert.ok(Math.abs(Math.abs(root[0]) - Math.SQRT1_2) < 1e-6);
    const local = bones[1]!.q;
    assert.ok(Math.abs(Math.abs(local[3]) - 1) < 1e-6);
    assert.deepEqual(bones[1]!.t, [0, 3, 4]);
});

test("loadRows: the LoadAnim lines under their SetReferenceChecksum", () => {
    const t = (tok: number, payload: Buffer = Buffer.alloc(0)): Buffer => Buffer.concat([Buffer.from([tok]), payload]);
    const name = (n: string): Buffer => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(checksum(n));
        return t(0x16, b);
    };
    const str = (s: string): Buffer => {
        const text = Buffer.from(`${s}\0`, "latin1");
        const len = Buffer.alloc(4);
        len.writeUInt32LE(text.length);
        return t(0x1b, Buffer.concat([len, text]));
    };
    const line = (path: string, desc: string): Buffer =>
        Buffer.concat([name("name"), t(0x07), str(path), name("descChecksum"), t(0x07), name(desc), t(0x01)]);
    const body = Buffer.concat([
        name("SetReferenceChecksum"),
        name("si_bmx"),
        t(0x01),
        line("anims\\SI_BMX\\A.ska", "a_one"),
        line("anims\\SI_BMX\\B.ska", "b_two"),
        t(0x24),
    ]);
    const names = new Map(
        [checksum("si_bmx"), checksum("a_one"), checksum("b_two")].map((c, i) => [c, ["si_bmx", "a_one", "b_two"][i]!]),
    );
    assert.deepEqual(
        loadRows(body, "s", names).map((r) => [r.reference, r.path, r.desc]),
        [
            ["si_bmx", "anims\\SI_BMX\\A.ska", "a_one"],
            ["si_bmx", "anims\\SI_BMX\\B.ska", "b_two"],
        ],
    );
});
