// NOT ORIGINAL - tests of the bike manual meter's image conversion (meter.ts) with synthetic data (no game files).

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeImg } from "../hd_textures/ui.ts";
import * as dxt from "../level_port/dxt.ts";
import { imagePath, readWpcDxtImg, writeImg32 } from "./meter.ts";

// An 8 x 8 picture, top-down: the top half red and opaque, the bottom half blue and transparent.
function picture(): Buffer {
    const bgra = Buffer.alloc(8 * 8 * 4);
    for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
            const o = (y * 8 + x) * 4;
            if (y < 4) bgra.set([0, 0, 255, 255], o);
            else bgra.set([255, 0, 0, 0], o);
        }
    return bgra;
}

// THAW's file for it: the header, then DXT5 blocks of the rows bottom-up.
function wpc(top: Buffer, format = 5): Buffer {
    const stored = Buffer.alloc(top.length);
    for (let y = 0; y < 8; y++) top.copy(stored, (7 - y) * 32, y * 32, (y + 1) * 32);
    const blocks = dxt.encode(stored, 8, 8, format);
    const head = Buffer.alloc(28);
    head.writeUInt32LE(0xabadd00d, 0);
    head.writeUInt32LE(0x140002, 4);
    head.writeUInt16LE(8, 12);
    head.writeUInt16LE(8, 14);
    head.writeUInt16LE(8, 16);
    head.writeUInt16LE(8, 18);
    head.writeUInt16LE(0x2001, 20);
    head.writeUInt16LE(0x2000 | format, 22);
    head.writeUInt32LE(blocks.length, 24);
    return Buffer.concat([head, blocks]);
}

test("readWpcDxtImg: THAW's DXT5 picture, rows bottom-up, read top-down", () => {
    const p = readWpcDxtImg(wpc(picture()));
    assert.equal(p.width, 8);
    assert.equal(p.height, 8);
    assert.deepEqual([...p.bgra.subarray(0, 4)], [0, 0, 255, 255]); // top left: red, opaque
    assert.deepEqual([...p.bgra.subarray(7 * 32, 7 * 32 + 4)], [255, 0, 0, 0]); // bottom left: blue, clear
});

test("readWpcDxtImg: not a THAW image / not DXT / too short", () => {
    assert.throws(() => readWpcDxtImg(Buffer.alloc(64)), /not a THAW image/);
    const raw = wpc(picture());
    raw.writeUInt16LE(0x2002, 22);
    assert.throws(() => readWpcDxtImg(raw), /not DXT1 \/ DXT5/);
    assert.throws(() => readWpcDxtImg(wpc(picture()).subarray(0, 40)), /too short/);
});

test("writeImg32: a THUG2 32-bit image the UI reader reads back", () => {
    const top = picture();
    const file = writeImg32({ width: 8, height: 8, bgra: top });
    assert.equal(file.readUInt32LE(16), 0); // 32-bit
    assert.equal(file.readUInt32LE(20), 0); // no HD marker
    assert.equal(file.readUInt32LE(28), 0); // no palette
    assert.equal(file.length, 32 + 8 * 8 * 4);
    const back = decodeImg(file);
    assert.equal(back.iw, 8);
    assert.equal(back.ih, 8);
    assert.ok(back.bgra.equals(top));
    // not a power of two: rows as stored (bottom-up), not swizzled
    const wide = Buffer.alloc(12 * 2 * 4);
    wide.set([1, 2, 3, 4], 0);
    const odd = writeImg32({ width: 12, height: 2, bgra: wide });
    assert.deepEqual([...odd.subarray(32 + 12 * 4, 32 + 12 * 4 + 4)], [1, 2, 3, 4]);
    assert.throws(() => writeImg32({ width: 4, height: 4, bgra: Buffer.alloc(8) }), /wrong size/);
});

test("imagePath: under images\\thaw_bmx", () => {
    assert.equal(imagePath("bike_arc"), "images\\thaw_bmx\\bike_arc.img.xbx");
});
