// NOT ORIGINAL - BPS ("beat") binary patches, by Near's published format: "BPS1", the source / target / metadata sizes
// as varints, then SourceRead / TargetRead / SourceCopy / TargetCopy commands, and the CRC-32s of the source, the target
// and the patch itself at the end.

import * as zlib from "node:zlib";

const crc32 = (data: Uint8Array): number => zlib.crc32(data) >>> 0;

interface Header {
    sourceSize: number;
    targetSize: number;
    commandsAt: number;
    sourceCrc: number;
    targetCrc: number;
}

function readHeader(patch: Uint8Array): { header: Header; num: (at: { i: number }) => number } {
    if (patch.length < 16 || String.fromCharCode(...patch.subarray(0, 4)) !== "BPS1")
        throw new Error("not a BPS1 patch");
    // (a varint: 7 bits a byte, the top bit ends it, each continuation adds one)
    const num = (at: { i: number }): number => {
        let value = 0;
        let shift = 1;
        for (;;) {
            const byte = patch[at.i++];
            if (byte === undefined) throw new Error("BPS patch cut short");
            value += (byte & 0x7f) * shift;
            if (byte & 0x80) return value;
            shift *= 128;
            value += shift;
        }
    };
    const at = { i: 4 };
    const sourceSize = num(at);
    const targetSize = num(at);
    const metadataSize = num(at);
    at.i += metadataSize; // (the metadata, skipped)
    const view = Buffer.from(patch.buffer, patch.byteOffset, patch.byteLength);
    const end = patch.length - 12;
    return {
        header: {
            sourceSize,
            targetSize,
            commandsAt: at.i,
            sourceCrc: view.readUInt32LE(end),
            targetCrc: view.readUInt32LE(end + 4),
        },
        num,
    };
}

// Whether `patch` was made for `source` (its size and CRC-32).
export function bpsMadeFor(patch: Uint8Array, source: Uint8Array): boolean {
    const { header } = readHeader(patch);
    return header.sourceSize === source.length && header.sourceCrc === crc32(source);
}

// `patch` applied to `source`; throws unless the source is the one the patch was made for and the result is the
// patch's target (their CRC-32s).
export function applyBps(patch: Uint8Array, source: Uint8Array): Buffer {
    const { header, num } = readHeader(patch);
    if (header.sourceSize !== source.length || header.sourceCrc !== crc32(source))
        throw new Error("BPS patch: not the source it was made for");
    const target = Buffer.alloc(header.targetSize);
    const at = { i: header.commandsAt };
    const end = patch.length - 12;
    let out = 0;
    let sourceAt = 0;
    let targetAt = 0;
    const offset = (): number => {
        const v = num(at);
        return (v % 2 ? -1 : 1) * Math.floor(v / 2);
    };
    while (at.i < end) {
        const head = num(at);
        const length = Math.floor(head / 4) + 1;
        if (out + length > target.length) throw new Error("BPS patch: writes past its target");
        switch (head % 4) {
            case 0: // SourceRead: the source's bytes at the same place
                target.set(source.subarray(out, out + length), out);
                break;
            case 1: // TargetRead: bytes from the patch
                target.set(patch.subarray(at.i, at.i + length), out);
                at.i += length;
                break;
            case 2: // SourceCopy: the source's bytes from elsewhere
                sourceAt += offset();
                target.set(source.subarray(sourceAt, sourceAt + length), out);
                sourceAt += length;
                break;
            default: // TargetCopy: the target's own earlier bytes (one at a time: they may overlap)
                targetAt += offset();
                for (let k = 0; k < length; ++k) target[out + k] = target[targetAt++]!;
                break;
        }
        out += length;
    }
    if (out !== target.length || crc32(target) !== header.targetCrc)
        throw new Error("BPS patch: the result isn't its target");
    return target;
}
