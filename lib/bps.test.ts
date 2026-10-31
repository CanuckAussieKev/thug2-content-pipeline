// NOT ORIGINAL - unit test of bps.ts on a patch made here (each of the four commands once).

import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { applyBps, bpsMadeFor } from "./bps.ts";

// BPS's varint
function varint(n: number): number[] {
    const out: number[] = [];
    for (;;) {
        const x = n & 0x7f;
        n = Math.floor(n / 128);
        if (n === 0) {
            out.push(0x80 | x);
            return out;
        }
        out.push(x);
        n -= 1;
    }
}
const command = (kind: number, length: number): number[] => varint((length - 1) * 4 + kind);
const offset = (n: number): number[] => varint(Math.abs(n) * 2 + (n < 0 ? 1 : 0));
const word = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24];

function makePatch(source: Buffer, target: Buffer, commands: number[]): Buffer {
    const body = [..."BPS1"].map((c) => c.charCodeAt(0));
    body.push(...varint(source.length), ...varint(target.length), ...varint(2), 0x68, 0x69, ...commands);
    body.push(...word(zlib.crc32(source) >>> 0), ...word(zlib.crc32(target) >>> 0));
    const withoutOwn = Buffer.from(body);
    return Buffer.concat([withoutOwn, Buffer.from(word(zlib.crc32(withoutOwn) >>> 0))]);
}

const source = Buffer.from("abcdefgh");
const target = Buffer.from("abcXYdefXYde");
// abc (source read) + XY (target read) + def (source copy from 3) + XYde (target copy from 3)
const patch = makePatch(source, target, [
    ...command(0, 3),
    ...command(1, 2),
    0x58,
    0x59,
    ...command(2, 3),
    ...offset(3),
    ...command(3, 4),
    ...offset(3),
]);

test("a patch applied to its source gives its target", () => {
    assert.ok(bpsMadeFor(patch, source));
    assert.deepEqual(applyBps(patch, source), target);
});

test("a patch is refused for another source", () => {
    const other = Buffer.from("abcdefgX");
    assert.equal(bpsMadeFor(patch, other), false);
    assert.throws(() => applyBps(patch, other), /not the source/);
});
