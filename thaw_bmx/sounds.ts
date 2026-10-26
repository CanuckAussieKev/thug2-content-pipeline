// NOT ORIGINAL - THAW's BMX for THUG2, phase 4: the bike's sounds. THAW keeps its
// global sounds in one file, data\sounds\pak\global_sfx.pak.wpc - each sound a 0x80-byte header (a WAVEFORMATEX: PCM,
// 16 bits, mono, its rate) and its samples, at the Offset / Size that scripts\game\sounds\global_sfx_dat_wpc.qb's
// global_sfx_addresses_wpc lists by the checksum of the sound's name (LOOPING for the loops); its bike's are in it.
// THUG2 PC's sounds are data\sounds\<path>.snd: a RIFF WAVE whose "fmt " says PCM 16-bit but whose "data" is 4-bit
// IMA ADPCM (low nibble first, one channel, from 0 at step 0 - THUG2's decoder Platform::DecodeAdpcm 0x005F5A20,
// src/game/sys/platform_system.cpp), its fmt's bytes-per-second holding the decoded size in bytes, and a "smpl" chunk
// with one loop for a looping sound (PCWave::Load 0x0047C870). So each bike sound is encoded to that.

import * as fs from "node:fs";
import * as qb from "../level_port/qb.ts";
import { Name, type QbValue, Struct } from "../level_port/qb.ts";
import * as thaw from "../thaw_levels/thaw.ts";

export const ADDRESSES_FILE = "scripts\\game\\sounds\\global_sfx_dat_wpc.qb";
export const ADDRESSES = "global_sfx_addresses_wpc";
export const HEADER = 0x80;

// THUG2's decoder's tables (platform_system.cpp kIndexSteps / kSteps - IMA ADPCM's).
const INDEX_STEPS = [-1, -1, -1, -1, 2, 4, 6, 8];
const STEPS = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];

export interface SfxEntry {
    offset: number;
    size: number;
    looping: boolean;
}

// THAW's sound index: name checksum -> where the sound is in global_sfx.pak.wpc.
export function readIndex(qbPak: string, names: Map<number, string>): Map<number, SfxEntry> {
    for (const [e, d] of thaw.pakFiles(qbPak)) {
        if (!e.path || e.path.toLowerCase().replaceAll(".wpc", "") !== ADDRESSES_FILE) continue;
        const list = new thaw.QbItems(d, e.path, names).get(ADDRESSES);
        if (!Array.isArray(list)) throw new Error(`THAW: ${ADDRESSES} isn't an array`);
        const out = new Map<number, SfxEntry>();
        const key = (s: Struct, k: string): QbValue | undefined =>
            s.entries.find(([n]) => n?.value === qb.checksum(k))?.[1];
        const looping = qb.checksum("LOOPING");
        for (const s of list) {
            if (!(s instanceof Struct)) continue;
            const c = key(s, "Checksum");
            const offset = key(s, "Offset");
            const size = key(s, "Size");
            if (typeof c !== "number" || typeof offset !== "number" || typeof size !== "number") continue;
            const loop = s.entries.some(([n, v]) => n === null && v instanceof Name && v.value === looping);
            out.set(c >>> 0, { offset, size, looping: loop });
        }
        return out;
    }
    throw new Error(`${qbPak}: no ${ADDRESSES_FILE}`);
}

// One sound's 16-bit samples and rate out of global_sfx.pak.wpc (PCM, mono, 16 bits - anything else refused).
export function readSound(pak: Buffer, entry: SfxEntry, name = "sound"): { rate: number; samples: Int16Array } {
    if (entry.offset + HEADER + entry.size > pak.length) throw new Error(`${name}: past the end of global_sfx`);
    const format = pak.readUInt16LE(entry.offset);
    const channels = pak.readUInt16LE(entry.offset + 2);
    const rate = pak.readUInt32LE(entry.offset + 4);
    const bits = pak.readUInt16LE(entry.offset + 14);
    if (format !== 1 || channels !== 1 || bits !== 16)
        throw new Error(`${name}: format ${format}, ${channels} channels, ${bits} bits`);
    const count = entry.size >> 1;
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) samples[i] = pak.readInt16LE(entry.offset + HEADER + 2 * i);
    return { rate, samples };
}

// THUG2's decoder (Platform::DecodeAdpcm), for the round trip.
export function decode(data: Uint8Array, count: number): Int16Array {
    const out = new Int16Array(count);
    let sample = 0;
    let index = 0;
    for (let i = 0; i < count; i++) {
        const byte = data[i >> 1] ?? 0;
        const nibble = i & 1 ? byte >> 4 : byte & 0xf;
        const magnitude = nibble & 7;
        index = Math.min(88, Math.max(0, index + INDEX_STEPS[magnitude]!));
        const step = STEPS[index]!;
        let change = ((step * magnitude) >> 2) + (step >> 3);
        if (nibble >> 3) change = -change;
        sample = Math.min(32767, Math.max(-32768, sample + change));
        out[i] = sample;
    }
    return out;
}

// The samples as THUG2's 4-bit ADPCM: each nibble the one of the 16 whose decoded sample is nearest (the decoder's
// state followed exactly, so decode() gives back what was chosen).
export function encode(samples: Int16Array): Buffer {
    const out = Buffer.alloc((samples.length + 1) >> 1);
    let sample = 0;
    let index = 0;
    for (let i = 0; i < samples.length; i++) {
        let best = 0;
        let bestError = Infinity;
        let bestSample = 0;
        let bestIndex = 0;
        for (let nibble = 0; nibble < 16; nibble++) {
            const magnitude = nibble & 7;
            const nextIndex = Math.min(88, Math.max(0, index + INDEX_STEPS[magnitude]!));
            const step = STEPS[nextIndex]!;
            let change = ((step * magnitude) >> 2) + (step >> 3);
            if (nibble >> 3) change = -change;
            const next = Math.min(32767, Math.max(-32768, sample + change));
            const error = Math.abs(next - samples[i]!);
            if (error < bestError) {
                bestError = error;
                best = nibble;
                bestSample = next;
                bestIndex = nextIndex;
            }
        }
        sample = bestSample;
        index = bestIndex;
        out[i >> 1] = (out[i >> 1] ?? 0) | (i & 1 ? best << 4 : best);
    }
    return out;
}

// A THUG2 .snd: RIFF WAVE, "fmt " PCM 16-bit mono at `rate` with the decoded size where the bytes per second go,
// "data" the ADPCM, and for a loop a "smpl" chunk with one loop over the whole sound.
export function writeSnd(samples: Int16Array, rate: number, looping: boolean): Buffer {
    const data = encode(samples);
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0);
    fmt.writeUInt16LE(1, 2);
    fmt.writeUInt32LE(rate, 4);
    fmt.writeUInt32LE(samples.length * 2, 8);
    fmt.writeUInt16LE(2, 12);
    fmt.writeUInt16LE(16, 14);
    const chunks: Buffer[] = [chunk("fmt ", fmt), chunk("data", data)];
    if (looping) {
        const smpl = Buffer.alloc(36 + 24);
        smpl.writeUInt32LE(Math.round(1e9 / rate), 8); // sample period (ns)
        smpl.writeUInt32LE(60, 12); // MIDI unity note
        smpl.writeUInt32LE(1, 28); // one loop
        smpl.writeUInt32LE(0, 36 + 8); // its start
        smpl.writeUInt32LE(Math.max(0, samples.length - 1), 36 + 12); // its end
        chunks.push(chunk("smpl", smpl));
    }
    const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...chunks]);
    const head = Buffer.alloc(8);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
}

function chunk(id: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.write(id, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}

// What PCWave::Load reads of a .snd: its fmt's rate and decoded size, whether it loops, the ADPCM bytes.
export function readSnd(d: Buffer): { rate: number; decodedBytes: number; looping: boolean; data: Buffer } {
    if (d.toString("latin1", 0, 4) !== "RIFF" || d.toString("latin1", 8, 12) !== "WAVE")
        throw new Error("not a RIFF WAVE");
    let at = 12;
    let rate = 0;
    let decodedBytes = 0;
    let looping = false;
    let data = Buffer.alloc(0);
    while (at + 8 <= d.length) {
        const id = d.toString("latin1", at, at + 4);
        const size = d.readUInt32LE(at + 4);
        const body = d.subarray(at + 8, at + 8 + size);
        if (id === "fmt ") {
            rate = body.readUInt32LE(4);
            decodedBytes = body.readUInt32LE(8);
        } else if (id === "data") data = Buffer.from(body);
        else if (id === "smpl") looping = body.readUInt32LE(28) > 0;
        at += 8 + size + (size & 1);
    }
    return { rate, decodedBytes, looping, data };
}

// The named sounds from THAW into `<out>\sounds\<folder>\<name>.snd`; the files written (relative).
export function convertSounds(
    qbPak: string,
    sfxPak: string,
    names: Map<number, string>,
    wanted: readonly string[],
    write: (rel: string, data: Buffer) => void,
    folder: string,
): string[] {
    const index = readIndex(qbPak, names);
    const pak = fs.readFileSync(sfxPak);
    const done: string[] = [];
    for (const name of wanted) {
        const entry = index.get(qb.checksum(name));
        if (!entry) throw new Error(`THAW: no sound ${name} in ${ADDRESSES}`);
        const { rate, samples } = readSound(pak, entry, name);
        const rel = `sounds\\${folder}\\${name}.snd`;
        write(rel, writeSnd(samples, rate, entry.looping));
        done.push(rel);
    }
    return done;
}
