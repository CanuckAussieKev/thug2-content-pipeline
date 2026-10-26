// NOT ORIGINAL - which of a level's sectors its scripts show and hide, and where: for z-fighting (zfight_resolve.ts
// cuts a surface away only under one that is always there when it is; zfight_raster.ts counts two alternate states
// apart).
//
// Read from the level's compiled qb files: every script statement that starts with a command naming sectors by
// `name=` (a checksum) or `prefix="..."` (a string: every sector whose name starts with it - the names from the qb's
// checksum table). Invisible / Kill / Shatter / ShatterAndDie / Die hide what they name; Visible / Create show it.
// A sector named in any other way (a script's parameter, an object command, a global list) is `unknown`: anything
// may happen to it.
//
// Where: in runs - consecutive statements of one script with the same kind of command (hide or show), broken by any
// other statement (if / else, a wait, another command). An area's culling script hides a hundred pieces in one run
// (they come and go together); alternate states are shown and hidden in different runs (if ... Visible A, Invisible
// B else Invisible A, Visible B).

import * as fs from "node:fs";
import * as path from "node:path";
import { checksum, Name, QbFile, type QbValue, Struct } from "./qb.ts";

const HIDE = new Set(["Invisible", "Kill", "Shatter", "ShatterAndDie", "Die"].map(checksum));
const SHOW = new Set(["Visible", "Create"].map(checksum));
const NAME = checksum("name");
const PREFIX = checksum("prefix");

export interface Toggles {
    hides: Map<number, Set<number>>; // sector -> the runs that hide it
    shows: Map<number, Set<number>>; // sector -> the runs that show it
    unknown: Set<number>; // sectors named otherwise
    runs: number; // (runs numbered so far)
}

export function emptyToggles(): Toggles {
    return { hides: new Map(), shows: new Map(), unknown: new Set(), runs: 0 };
}

function parse(data: Uint8Array, name: string): QbFile | null {
    try {
        return new QbFile(data, name, true);
    } catch {
        try {
            return new QbFile(data, name);
        } catch {
            return null;
        }
    }
}

// Adds a qb file's statements to `into`. `sectorNames`: checksum -> name text of the scene's sectors (for prefixes;
// the file's own checksum table is used too).
export function addToggles(
    into: Toggles,
    data: Uint8Array,
    file: string,
    sectors: ReadonlySet<number>,
    sectorNames: ReadonlyMap<number, string> = new Map(),
): void {
    const q = parse(data, file);
    if (!q) return;
    const nameText = new Map<number, string>(sectorNames);
    for (const [k, v] of q.names) if (sectors.has(k) && !nameText.has(k)) nameText.set(k, v);
    const byPrefix = (prefix: string): number[] => {
        const low = prefix.toLowerCase();
        return [...nameText.entries()]
            .filter(([c, n]) => sectors.has(c) && n.toLowerCase().startsWith(low))
            .map(([c]) => c);
    };
    const add = (map: Map<number, Set<number>>, sector: number, script: number): void => {
        const set = map.get(sector);
        if (set) set.add(script);
        else map.set(sector, new Set([script]));
    };
    for (const [, statements] of [...q.scripts.entries()].sort((a, b) => a[0] - b[0])) {
        let last = 0;
        for (const line of statements) {
            const verb = line[0]?.[0] === 0x16 && line[0][1].length === 4 ? line[0][1].readUInt32LE(0) : -1;
            const map = HIDE.has(verb) ? into.hides : SHOW.has(verb) ? into.shows : null;
            const kind = map === into.hides ? 1 : map ? 2 : 0;
            if (kind === 0 || kind !== last) into.runs++;
            last = kind;
            const script = into.runs;
            for (let k = 0; k < line.length; k++) {
                const [t, payload] = line[k]!;
                if (t === 0x16 && payload.length === 4) {
                    const c = payload.readUInt32LE(0);
                    if (k === 0 || !sectors.has(c)) continue;
                    // name=X after a show / hide command; anything else is another use
                    const isName =
                        k >= 2 &&
                        line[k - 1]![0] === 0x07 &&
                        line[k - 2]![0] === 0x16 &&
                        line[k - 2]![1].readUInt32LE(0) === NAME;
                    if (map && isName) add(map, c, script);
                    else into.unknown.add(c);
                } else if ((t === 0x1b || t === 0x1c) && k >= 2 && line[k - 1]![0] === 0x07) {
                    const key = line[k - 2]!;
                    if (key[0] !== 0x16 || key[1].readUInt32LE(0) !== PREFIX) continue;
                    const text = payload.subarray(
                        0,
                        Math.max(0, payload.indexOf(0) < 0 ? payload.length : payload.indexOf(0)),
                    );
                    for (const c of byPrefix(text.toString("latin1"))) {
                        if (map) add(map, c, script);
                        else into.unknown.add(c);
                    }
                }
            }
        }
    }
    // (globals other than the node array: lists of sectors some script walks)
    let nodeArray: QbValue[] | null = null;
    for (const [, value] of q.globals) {
        if (!Array.isArray(value) || (nodeArray && value.length <= nodeArray.length)) continue;
        if (value.some((v) => v instanceof Struct && v.get("Name") instanceof Name)) nodeArray = value;
    }
    const walk = (v: QbValue | undefined): void => {
        if (v instanceof Name) {
            if (sectors.has(v.value)) into.unknown.add(v.value);
        } else if (Array.isArray(v)) for (const x of v) walk(x);
        else if (v instanceof Struct) for (const [, x] of v.entries) walk(x);
    };
    for (const [, value] of q.globals) if (value !== nodeArray) walk(value);
}

const subset = (a: ReadonlySet<number> | undefined, b: ReadonlySet<number> | undefined): boolean =>
    !a || [...a].every((x) => b?.has(x));

export function named(t: Toggles, sector: number): boolean {
    return t.unknown.has(sector) || t.hides.has(sector) || t.shows.has(sector);
}

// Whether sector `k` is there whenever sector `v` is: never toggled, or hidden only where v is hidden too and shown
// wherever v is shown.
export function thereWhenever(t: Toggles, k: number, v: number): boolean {
    if (k === v || !named(t, k)) return true;
    if (t.unknown.has(k)) return false;
    if (!t.hides.has(k)) return true; // (only ever shown: always there)
    return subset(t.hides.get(k), t.hides.get(v)) && subset(t.shows.get(v), t.shows.get(k));
}

// Every qb file in a level's folder (<level>.qb and any other: THUG1's <level>_thugpro.qb).
export function levelToggles(dir: string, scene: { sectors: { checksum: number }[] }): Toggles {
    const out = emptyToggles();
    const sectors = new Set(scene.sectors.map((s) => s.checksum));
    for (const f of fs
        .readdirSync(dir)
        .filter((x) => x.toLowerCase().endsWith(".qb"))
        .sort()) {
        addToggles(out, fs.readFileSync(path.join(dir, f)), f, sectors);
    }
    return out;
}
