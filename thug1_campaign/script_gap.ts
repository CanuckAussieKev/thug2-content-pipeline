// NOT ORIGINAL - the THUG1 campaign survey's script gap: every CFunction,
// member function, script and global THUG1's scripts call or read, checked against THUG2.
//
//   node tools/pipeline/thug1_campaign/script_gap.ts [--thug1 C:\Games\THUG1] [--thug2 C:\Games\THUG2]
//        [--thug2-exe <reference build exe>] [--cfuncs data/derived/cfuncs.csv]
//        [--json <out.json>] [--list <out.md>] [--story] [--dump <folder> [--ns out\neverscript\ns.exe]]
//
// THUG1's side (all read from the user's install, nothing of it is committed):
//   - its scripts: every .qb in Data\pre\qb.pre and in each level archive (<LV>.pre: the level's node array,
//     _scripts and _sfx, the vehicles' .qb);
//   - its CFunctions: THUG.exe's table of {char* name, function} pairs (0x00686AC0, 1144 of them - found by a scan,
//     not by address), its member functions: the exe's by-name list (0x00688E80, 597 char* names: THUG1 registers
//     every member by name; THUG2 registers 250 so and the rest in components' tables).
// THUG2's side: data/derived/cfuncs.csv (tools/extract_cfuncs.ts; made from --thug2-exe when missing), the members
// of tools/pipeline/level_port/thug2_members.ts (tools/extract_members.ts: the table members' checksums and the by-name
// ones), its scripts and globals from Data\pre\qb_scripts.prx and the loose Data\scripts (the game-wide ones) and
// - only for how THUG2 calls a function - every .qb in Data\pre\*.prx.
//
// A name is classified by where it appears in THUG1's scripts: a statement's first name (also after if / not / and /
// or) is a command - a CFunction when THUG1's table has it, a script when THUG1 defines one, else a member function
// (THUG1's list, or `unknown`); `x:cmd` / `<x>:cmd` is a member function; any other name is a value - counted only
// when THUG1 defines a script (a script reference: SpawnScript / goal callbacks) or a global (a read) of that name.
// Against THUG2:
//   cfunc / member: `same` (THUG2 has it, and no parameter THUG1's calls pass is unknown to THUG2's own calls),
//     `params` (THUG2 has it, but THUG1's calls pass parameters THUG2's scripts never pass - listed; a heuristic:
//     THUG2's C++ may still read them), `unused` (THUG2 has it, its scripts never call it: parameters unverified),
//     `moved` (THUG2 has the name as the other kind - a CFunction became a member or a script, or the reverse),
//     `missing`;
//   script / global: `same` (THUG2's has the same tokens, line numbers and jump offsets aside), `differs` (THUG2 has
//     one of that name: carrying THUG1's over replaces or shadows it), `missing` (THUG1's must be carried).
// Each name gets a subsystem (goals, story, cutscenes, vehicles, peds, menus, saves, camera, walking, ...) from its
// name, else from the files that use it. --story keeps only names reached from the story: the scripts of the story
// levels' files and of THUG1's goal / chapter / cutscene / game-flow files, and every script they reach.
//
// --dump writes every THUG1 .qb to <folder>\qb\<path> and, with NeverScript, its decompiled .ns to <folder>\ns\<path>.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as prx from "../level_port/prx.ts";
import { checksum, type Token, tokens } from "../level_port/qb.ts";
import { NAMED_MEMBERS, TABLE_MEMBERS } from "../level_port/thug2_members.ts";
import { helpFromHeader } from "../lib/cli.ts";
import { REFERENCE_EXE } from "../lib/decomp.ts";
import { findCaseless, resolveInstall } from "../lib/install.ts";
import { decodeLatin1, isMain, print, pyExit, runMain } from "../lib/py.ts";

// --- tokens -----------------------------------------------------------------------------------------------------

const T = {
    EOL: 0x01,
    EOLN: 0x02,
    STRUCT: 0x03,
    END_STRUCT: 0x04,
    ARRAY: 0x05,
    END_ARRAY: 0x06,
    EQUALS: 0x07,
    DOT: 0x08,
    PAREN: 0x0e,
    END_PAREN: 0x0f,
    NAME: 0x16,
    SCRIPT: 0x23,
    END_SCRIPT: 0x24,
    IF: 0x25,
    NAME_TABLE: 0x2b,
    LOCAL: 0x2d,
    OR: 0x32,
    AND: 0x33,
    XOR: 0x34,
    NOT: 0x39,
    COLON: 0x42,
    SHORT_IF: 0x47,
} as const;
const OPEN = new Set([T.STRUCT, T.ARRAY, T.PAREN]);
const CLOSE = new Set([T.END_STRUCT, T.END_ARRAY, T.END_PAREN]);
// After these a command may start (a condition's command, or the next of several).
const COMMAND_AFTER = new Set([T.EOL, T.EOLN, T.IF, T.SHORT_IF, T.NOT, T.OR, T.AND, T.XOR]);
// Tokens whose payload is a jump offset or a line number: left out when two bodies are compared.
const POSITIONAL = new Set([0x02, 0x2e, 0x47, 0x48, 0x49, 0x2f, 0x37, 0x40, 0x41]);

const u32 = (b: Buffer): number => b.readUInt32LE(0);

// --- one game's scripts ----------------------------------------------------------------------------------------

export type Kind = "cfunc" | "member" | "script" | "global" | "unknown";

// A command / member call: the parameters given by name (`k=v`, also the entries of a structure given unnamed) and the
// bare names (flags - or unnamed values: a sound's or an animation's name; no telling them apart).
interface Call {
    name: number;
    member: boolean;
    params: Set<number>;
    flags: Set<number>;
}

interface Use {
    params: Set<number>; // the parameter names passed at the calls
    files: Map<string, number>; // file -> uses
    count: number;
}

// What one set of .qb files defines and uses.
export class ScriptSet {
    readonly names = new Map<number, string>(); // 0x2B entries
    readonly scripts = new Map<number, { file: string; body: Buffer }>(); // name -> normalised body
    readonly globals = new Map<number, { file: string; body: Buffer }>();
    // command / member uses, by script: script -> [kind hint, name, params]
    readonly calls = new Map<number, Call[]>();
    readonly valueRefs = new Map<number, Set<number>>(); // script -> names used as values
    readonly fileOfScript = new Map<number, string>();
    readonly keys = new Map<number, Map<string, number>>(); // every `name =` (parameters, structure entries): file -> uses

    add(file: string, data: Buffer): void {
        let toks: Token[];
        try {
            toks = [...tokens(data, true)];
        } catch {
            return; // (a file the reader can't take)
        }
        for (let k = 0; k < toks.length; k++) {
            const [, t, p] = toks[k]!;
            if (t === T.NAME_TABLE) this.names.set(u32(p), decodeLatin1(p.subarray(4, p.length - 1)));
            if (t === T.NAME && toks[k + 1]?.[1] === T.EQUALS && toks[k - 1]?.[1] !== T.LOCAL) {
                const m = this.keys.get(u32(p)) ?? new Map<string, number>();
                m.set(file, (m.get(file) ?? 0) + 1);
                this.keys.set(u32(p), m);
            }
        }
        let i = 0;
        let lineStart = true;
        while (i < toks.length) {
            const t = toks[i]![1];
            if (t === T.SCRIPT && toks[i + 1]?.[1] === T.NAME) {
                const name = u32(toks[i + 1]![2]);
                let j = i + 2;
                while (j < toks.length && toks[j]![1] !== T.END_SCRIPT) j++;
                this.addScript(file, name, toks.slice(i + 2, j));
                i = j + 1;
                lineStart = true;
                continue;
            }
            if (lineStart && t === T.NAME && toks[i + 1]?.[1] === T.EQUALS) {
                // a global: up to the end of its line at depth 0
                const name = u32(toks[i]![2]);
                let j = i + 2;
                let depth = 0;
                for (; j < toks.length; j++) {
                    const u = toks[j]![1];
                    if (OPEN.has(u as never)) depth++;
                    else if (CLOSE.has(u as never)) depth--;
                    else if ((u === T.EOL || u === T.EOLN) && depth <= 0) break;
                    else if (u === 0x00) break;
                }
                const body = toks.slice(i + 2, j);
                this.globals.set(name, { file, body: normalise(body) });
                this.addRefs(name, body, file);
                i = j;
                continue;
            }
            lineStart = t === T.EOL || t === T.EOLN || t === T.NAME_TABLE;
            i++;
        }
    }

    // Global bodies also read names (a structure naming scripts: goal parameters' callbacks).
    private addRefs(owner: number, body: Token[], file: string): void {
        const refs = this.valueRefs.get(owner) ?? new Set<number>();
        for (let k = 0; k < body.length; k++) {
            if (body[k]![1] === T.NAME && body[k + 1]?.[1] !== T.EQUALS && body[k - 1]?.[1] !== T.LOCAL) {
                refs.add(u32(body[k]![2]));
            }
        }
        this.valueRefs.set(owner, refs);
        if (!this.fileOfScript.has(owner)) this.fileOfScript.set(owner, file);
    }

    private addScript(file: string, name: number, body: Token[]): void {
        this.scripts.set(name, { file, body: normalise(body) });
        this.fileOfScript.set(name, file);
        const calls: Call[] = [];
        const refs = new Set<number>();
        let commandPos = false; // (the script line's own default parameters come first)
        let current: Call | null = null;
        // The open brackets of the statement: true for a structure given unnamed at the parameters' level (its entries
        // are the call's parameters), false for anything else (a named parameter's value, an array, an expression).
        const stack: boolean[] = [];
        let depth = 0; // 0: the keys / flags met are the call's parameters
        for (let k = 0; k < body.length; k++) {
            const [, t, p] = body[k]!;
            const prev = body[k - 1]?.[1];
            const next = body[k + 1]?.[1];
            if (OPEN.has(t as never)) {
                stack.push(t === T.STRUCT && prev !== T.EQUALS && depth === 0);
                depth = stack.every((m) => m) ? 0 : 1;
                commandPos = false;
                continue;
            }
            if (CLOSE.has(t as never)) {
                stack.pop();
                depth = stack.every((m) => m) ? 0 : 1;
                continue;
            }
            if (stack.length === 0 && (t === T.EOL || t === T.EOLN)) {
                current = null;
                commandPos = true;
                continue;
            }
            if (t === T.EOL || t === T.EOLN) continue; // (a structure over several lines)
            if (stack.length === 0 && COMMAND_AFTER.has(t as never)) {
                commandPos = true;
                current = null;
                continue;
            }
            if (commandPos && t === T.NAME && next === T.EQUALS) {
                commandPos = false; // `x = value`: sets a parameter of the script
                current = null;
                k++;
                continue;
            }
            if (commandPos && t === T.NAME) {
                commandPos = false;
                if (next === T.COLON && body[k + 2]?.[1] === T.NAME) {
                    refs.add(u32(p)); // the object's name
                    current = { name: u32(body[k + 2]![2]), member: true, params: new Set(), flags: new Set() };
                    k += 2;
                } else {
                    current = { name: u32(p), member: false, params: new Set(), flags: new Set() };
                }
                calls.push(current);
                depth = 0;
                continue;
            }
            if (commandPos && t === T.LOCAL) {
                commandPos = false;
                if (next === T.NAME && body[k + 2]?.[1] === T.COLON && body[k + 3]?.[1] === T.NAME) {
                    current = { name: u32(body[k + 3]![2]), member: true, params: new Set(), flags: new Set() };
                    calls.push(current);
                    k += 3;
                    depth = 0;
                } else {
                    k += 1; // <script>: a script named by a parameter - not followable
                    current = null;
                }
                continue;
            }
            commandPos = false;
            if (t !== T.NAME || prev === T.LOCAL || prev === T.DOT) continue;
            const value = u32(p);
            if (next === T.EQUALS) {
                if (current && depth === 0) current.params.add(value);
                continue;
            }
            refs.add(value);
            if (current && depth === 0 && prev !== T.EQUALS) current.flags.add(value); // a flag
        }
        this.calls.set(name, calls);
        this.valueRefs.set(name, refs);
    }
}

// A body's tokens without line numbers, jump offsets and name tables, as bytes - for comparing two definitions.
function normalise(body: Token[]): Buffer {
    const parts: Buffer[] = [];
    for (const [, t, p] of body) {
        if (t === T.NAME_TABLE) continue;
        if (t === T.EOLN) {
            parts.push(Buffer.from([T.EOL]));
            continue;
        }
        parts.push(Buffer.from([t]));
        if (!POSITIONAL.has(t)) parts.push(p);
    }
    return Buffer.concat(parts);
}

// --- the exes' tables --------------------------------------------------------------------------------------------

interface Section {
    va: number;
    vsize: number;
    rsize: number;
    raw: number;
}

function sections(d: Buffer): [number, Section[]] {
    const pe = d.readUInt32LE(0x3c);
    const base = d.readUInt32LE(pe + 24 + 28);
    const o = pe + 24 + d.readUInt16LE(pe + 20);
    const out: Section[] = [];
    for (let i = 0; i < d.readUInt16LE(pe + 6); i++) {
        const s = o + i * 40;
        out.push({
            va: base + d.readUInt32LE(s + 12),
            vsize: d.readUInt32LE(s + 8),
            rsize: d.readUInt32LE(s + 16),
            raw: d.readUInt32LE(s + 20),
        });
    }
    return [base, out];
}

export interface ExeTables {
    cfuncs: Map<string, number>; // name -> function address
    cfuncTable: number;
    members: string[]; // the by-name member list
    memberTable: number;
    hollow: Set<number>; // CFunctions (checksums) that only print "stubbed"
}

// The CFunction table (the longest run of {char* identifier, pointer into .text}) and the by-name member list (the
// longest run of char* identifiers) in an exe's data sections.
export function exeTables(file: string): ExeTables {
    const d = fs.readFileSync(file);
    const [, secs] = sections(d);
    const text = secs[0]!;
    const off = (va: number): number => {
        for (const s of secs) if (va >= s.va && va < s.va + s.rsize) return va - s.va + s.raw;
        return -1;
    };
    const ident = (va: number): string | null => {
        const o = off(va);
        if (o < 0) return null;
        const end = d.indexOf(0, o);
        if (end <= o || end - o > 96) return null;
        const s = d.toString("latin1", o, end);
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : null;
    };
    let best: { at: number; rows: [string, number][] } = { at: 0, rows: [] };
    let bestList: { at: number; rows: string[] } = { at: 0, rows: [] };
    for (const s of secs.slice(1)) {
        let run: [string, number][] = [];
        let start = 0;
        let list: string[] = [];
        let listStart = 0;
        for (let o = s.raw; o + 8 <= s.raw + s.rsize; o += 4) {
            const va = s.va + o - s.raw;
            const name = ident(d.readUInt32LE(o));
            if (name !== null) {
                if (!list.length) listStart = va;
                list.push(name);
            } else {
                if (list.length > bestList.rows.length) bestList = { at: listStart, rows: list };
                list = [];
            }
            const fn = d.readUInt32LE(o + 4);
            if (name !== null && fn >= text.va && fn < text.va + text.vsize) {
                if (!run.length) start = va;
                run.push([name, fn]);
                o += 4;
                list = []; // (a pair table isn't a name list)
            } else if (run.length) {
                if (run.length > best.rows.length) best = { at: start, rows: run };
                run = [];
            }
        }
    }
    return {
        cfuncs: new Map(best.rows),
        cfuncTable: best.at,
        members: bestList.rows,
        memberTable: bestList.at,
        hollow: hollowFunctions(d, secs, best.rows),
    };
}

// The CFunctions that only print that they're stubbed: a `push <string>` within their first 0x60 bytes whose string
// says "stub" (THUG2's CGoalManager::SetGoalChaptersAndStages / AdvanceStage: "...Stubbed", "STUBBED!").
function hollowFunctions(d: Buffer, secs: Section[], rows: [string, number][]): Set<number> {
    const text = secs[0]!;
    const toVa = (o: number): number => {
        for (const s of secs) if (o >= s.raw && o < s.raw + s.rsize) return s.va + o - s.raw;
        return -1;
    };
    const stubStrings = new Set<number>();
    for (let at = d.indexOf("tubbed"); at >= 0; at = d.indexOf("tubbed", at + 1))
        stubStrings.add(toVa(d.lastIndexOf(0, at) + 1));
    for (let at = d.indexOf("STUBBED"); at >= 0; at = d.indexOf("STUBBED", at + 1))
        stubStrings.add(toVa(d.lastIndexOf(0, at) + 1));
    const out = new Set<number>();
    for (const [name, fn] of rows) {
        const o = fn - text.va + text.raw;
        for (let k = o; k < o + 0x60 && k + 5 <= d.length; k++) {
            if (d[k] === 0x68 && stubStrings.has(d.readUInt32LE(k + 1))) {
                out.add(checksum(name));
                break;
            }
            if (d[k] === 0xc3 && d[k + 1] === 0xcc) break; // (the function's end: ret, then padding)
        }
        // `mov ecx, [manager]; call <get>; mov al, 1; ret`: fetches its manager and returns (THUG2's
        // GoalManager_RunLastStageScript)
        // - when <get> is only a getter (`mov eax, [ecx + imm32]; ret`), the call does no work
        if (d[o] === 0x8b && d[o + 1] === 0x0d && d[o + 6] === 0xe8 && d.readUInt32BE(o + 11) === 0xb001c3cc) {
            const callee = fn + 11 + d.readInt32LE(o + 7) - text.va + text.raw;
            if (d[callee] === 0x8b && d[callee + 1] === 0x81 && d[callee + 6] === 0xc3) out.add(checksum(name));
        }
    }
    return out;
}

// --- reading the games ------------------------------------------------------------------------------------------

function* qbFiles(archive: string): Generator<[string, Buffer]> {
    for (const [name, data] of prx.entries(archive)) {
        if (name.toLowerCase().endsWith(".qb")) yield [name, data];
    }
}

function* looseQb(folder: string, rel = ""): Generator<[string, Buffer]> {
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
        const p = path.join(folder, e.name);
        const r = rel ? `${rel}\\${e.name}` : e.name;
        if (e.isDirectory()) yield* looseQb(p, r);
        else if (e.name.toLowerCase().endsWith(".qb")) yield [`scripts\\${r}`, fs.readFileSync(p)];
    }
}

export function readThug1(game: string): { set: ScriptSet; files: [string, Buffer][] } {
    const pre = findCaseless(game, "Data", "pre");
    if (pre === null) pyExit(`${game}: no Data\\pre`);
    const set = new ScriptSet();
    const files: [string, Buffer][] = [];
    const seen = new Set<string>();
    const archives = fs
        .readdirSync(pre)
        .filter((f) => f.toLowerCase().endsWith(".pre"))
        .sort((a, b) => (a.toLowerCase() === "qb.pre" ? -1 : b.toLowerCase() === "qb.pre" ? 1 : a.localeCompare(b)));
    for (const a of archives) {
        for (const [name, data] of qbFiles(path.join(pre, a))) {
            if (seen.has(name.toLowerCase())) continue;
            seen.add(name.toLowerCase());
            files.push([name, data]);
            set.add(name, data);
        }
    }
    return { set, files };
}

export interface Thug2 {
    global: ScriptSet; // qb_scripts.prx + the loose scripts: what every level has
    all: ScriptSet; // + every archive's .qb: only for how THUG2 calls things
    cfuncs: Set<number>;
    cfuncStubs: Set<number>; // CFunctions whose function is one of the shared do-nothing ones (stubs)
    members: Set<number>;
    names: Map<number, string>;
}

export function readThug2(game: string, cfuncsCsv: string, exe: string): Thug2 {
    const pre = findCaseless(game, "Data", "pre");
    if (pre === null) pyExit(`${game}: no Data\\pre`);
    const global = new ScriptSet();
    const all = new ScriptSet();
    const qbPrx = findCaseless(pre, "qb_scripts.prx");
    if (qbPrx === null) pyExit(`${game}: no Data\\pre\\qb_scripts.prx`);
    const loose = findCaseless(game, "Data", "scripts");
    const seen = new Set<string>();
    // The loose files first: the game reads qdir.txt's after qb_scripts.prx (the later definition wins).
    for (const [name, data] of [...(loose ? looseQb(loose) : []), ...qbFiles(qbPrx)]) {
        if (!seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            global.add(name, data);
        }
        all.add(name, data);
    }
    for (const a of fs
        .readdirSync(pre)
        .filter((f) => f.toLowerCase().endsWith(".prx"))
        .sort()) {
        if (a.toLowerCase() === "qb_scripts.prx") continue;
        for (const [name, data] of qbFiles(path.join(pre, a))) all.add(name, data);
    }
    const names = new Map([...all.names]);
    let rows: [string, number][];
    if (fs.existsSync(cfuncsCsv)) {
        rows = fs
            .readFileSync(cfuncsCsv, "latin1")
            .split(/\r?\n/)
            .slice(1)
            .filter((l) => l.includes(","))
            .map((l) => [l.split(",")[1]!.trim(), parseInt(l.split(",")[0]!, 16)]);
    } else {
        if (!fs.existsSync(exe)) pyExit(`no ${cfuncsCsv} and no ${exe} to make it from (tools/extract_cfuncs.ts)`);
        rows = [...exeTables(exe).cfuncs];
    }
    const cfuncs = new Set<number>();
    for (const [n] of rows) {
        cfuncs.add(checksum(n));
        names.set(checksum(n), n);
    }
    const cfuncStubs = stubs(rows);
    // (and the ones that only print "stubbed": THUG2 kept the name, not the feature)
    if (fs.existsSync(exe)) for (const v of exeTables(exe).hollow) cfuncStubs.add(v);
    const members = new Set<number>(TABLE_MEMBERS.map(([v]) => v));
    for (const [n] of NAMED_MEMBERS) {
        members.add(checksum(n));
        names.set(checksum(n), n);
    }
    return { global, all, cfuncs, cfuncStubs, members, names };
}

// The CFunctions sharing one of the do-nothing functions: a function ten names or more point at (THUG2's
// 0x005B9760 `mov al, 1; ret` - 68 names - and 0x005B9E50; THUG1's 0x00529020 - 80 - and 0x00526720 `xor al, al`).
export function stubs(rows: Iterable<[string, number]>): Set<number> {
    const list = [...rows];
    const count = new Map<number, number>();
    for (const [, a] of list) count.set(a, (count.get(a) ?? 0) + 1);
    return new Set(list.filter(([, a]) => (count.get(a) ?? 0) >= 10).map(([n]) => checksum(n)));
}

// --- classification ---------------------------------------------------------------------------------------------

export type Status = "same" | "params" | "unused" | "stub" | "thug1-stub" | "moved" | "missing" | "differs";

export interface Entry {
    name: string;
    checksum: number;
    kind: Kind;
    status: Status;
    subsystem: string;
    uses: number;
    files: string[]; // the files using it, most uses first
    newParams: string[]; // (params) the parameters THUG1's calls give by name that THUG2's calls never pass
    newFlags: string[]; // the bare names THUG1's calls pass that THUG2's never do (flags or values: not judged)
    thug2Kind?: string; // (moved)
    story: boolean;
    thug1Address?: number; // (cfunc) THUG1's function
}

// Subsystems by name, first match wins; then by the using files.
const BY_NAME: [string, RegExp][] = [
    [
        "cutscenes / movies",
        /cutscene|^cut_|movie|bink|playstream|cinematic|^ska_|_cam_anim|camanim|^playskatercamanim/i,
    ],
    ["vehicles / driving", /vehicle|^veh_|car_|_car|drive|driving|skitch|horn|^pcv/i],
    [
        "goals",
        /goal|minigame|competition|^comp_|^horse|trickspot|^gap_|^setgap|_gap$|tetris|combo_letter|skate_letter|secret_tape|killskater/i,
    ],
    [
        "story / progression",
        /chapter|story|career|progress|unlock|flag|cash|money|stat(s)?_|_stat|sponsor|^pro_|reward|^beat|level_select|levelselect/i,
    ],
    ["saves / memcard", /memcard|savegame|save_|_save|loadgame|^mc_|vault|card/i],
    ["net / online", /^net|_net|online|lobby|server|^join|host|gamespy|buddy|^lan/i],
    ["camera", /camera|^cam_|_cam$|viewer|^fov|lookat/i],
    ["walking / ledges", /walk|ledge|hang|ladder|climb|shimmy|^ped_skater|wallplant|onfoot|^jump/i],
    ["peds", /ped|^ai_|_ai$|^anl_|pedai|crowd/i],
    ["CAS / appearance", /^cas|_cas|part|deck|board|appearance|profile|skin|scale|^edit_skater|color|logo|tattoo/i],
    [
        "menus / UI",
        /menu|screen|element|dialog|panel|text|sprite|font|helper|message|^hud|keyboard|button|highlight|_ui|ui_/i,
    ],
    ["sound / music", /sound|sfx|music|audio|stream|volume|reverb|^playsound|^vo_|^speech/i],
    [
        "skater / tricks",
        /trick|skater|grind|manual|spin|score|bail|combo|special|balance|^lip|^air|^ollie|landed|^revert|focus|^slap/i,
    ],
    [
        "objects / nodes",
        /^obj_|node|^create|^kill|visible|^shatter|rigid|bouncy|object|^proximity|emitter|particle|light|^sk3_/i,
    ],
    ["park / goal editor", /park|editor|^rail_|^ed_|cursor|piece/i],
];
const BY_FILE: [string, RegExp][] = [
    ["cutscenes / movies", /cutscene|movies/i],
    ["vehicles / driving", /vehicle|car_scripts/i],
    ["goals", /goal|minigame/i],
    ["story / progression", /chapter|gameflow|game_progress|levels\.qb|global_flags|level_flags|cheats/i],
    ["saves / memcard", /memcard/i],
    ["net / online", /\\net\\|netmenu|onlinestats/i],
    ["walking / ledges", /walking/i],
    ["peds", /ped/i],
    ["CAS / appearance", /cas|edit_skater|skateshop|deck|logo/i],
    ["menus / UI", /menu|panel|sprites|dialog|keyboard|helper/i],
    ["sound / music", /sfx|sound|music/i],
    ["skater / tricks", /skater|trick|physics/i],
    ["park / goal editor", /edpieces|park_ed|parked|rail_editor|goal_editor/i],
    ["levels", /^levels\\/i],
];

export function subsystem(name: string, files: string[]): string {
    for (const [s, re] of BY_NAME) if (re.test(name)) return s;
    for (const f of files) for (const [s, re] of BY_FILE) if (re.test(f)) return s;
    return "engine / misc";
}

// THUG1's story: the files its scripts start from.
const STORY_FILES =
    /^levels\\(nj|ny|fl|sd|hi|vc|sj|ru|se|au|nj_skateshop)\\|goal|chapter|cutscene|gameflow|game_progress|global_flags|level_flags|mapguy|minigame/i;

export interface Survey {
    entries: Entry[];
    thug1Exe: ExeTables;
}

export function survey(t1: ScriptSet, t1Exe: ExeTables, t2: Thug2): Survey {
    const names = new Map<number, string>([...t2.names, ...t1.names]);
    const t1Cfunc = new Map<number, [string, number]>();
    for (const [n, a] of t1Exe.cfuncs) {
        t1Cfunc.set(checksum(n), [n, a]);
        names.set(checksum(n), n);
    }
    const t1Member = new Set<number>();
    for (const n of t1Exe.members) {
        t1Member.add(checksum(n));
        names.set(checksum(n), n);
    }
    const nameOf = (v: number): string => names.get(v) ?? `0x${v.toString(16).padStart(8, "0")}`;
    const t1Stubs = stubs(t1Exe.cfuncs);
    for (const v of t1Exe.hollow) t1Stubs.add(v);

    // the story's reach
    const reached = new Set<number>();
    const todo: number[] = [];
    for (const [s, f] of t1.fileOfScript) if (STORY_FILES.test(f)) todo.push(s);
    while (todo.length) {
        const s = todo.pop()!;
        if (reached.has(s)) continue;
        reached.add(s);
        for (const c of t1.calls.get(s) ?? []) if (t1.scripts.has(c.name) || t1.globals.has(c.name)) todo.push(c.name);
        for (const r of t1.valueRefs.get(s) ?? []) if (t1.scripts.has(r) || t1.globals.has(r)) todo.push(r);
    }

    // THUG1's uses
    const uses = new Map<number, Use & { kind: Kind; story: boolean; flags: Set<number> }>();
    const use = (v: number, kind: Kind, owner: number, call?: Call): void => {
        let u = uses.get(v);
        if (!u) {
            u = { params: new Set(), flags: new Set(), files: new Map(), count: 0, kind, story: false };
            uses.set(v, u);
        }
        u.count++;
        const f = t1.fileOfScript.get(owner) ?? "?";
        u.files.set(f, (u.files.get(f) ?? 0) + 1);
        if (call) {
            for (const p of call.params) u.params.add(p);
            for (const p of call.flags) u.flags.add(p);
        }
        if (reached.has(owner)) u.story = true;
    };
    for (const [owner, calls] of t1.calls) {
        for (const c of calls) {
            let kind: Kind;
            if (c.member) kind = t1Cfunc.has(c.name) && !t1Member.has(c.name) ? "cfunc" : "member";
            else if (t1.scripts.has(c.name)) kind = "script";
            else if (t1Cfunc.has(c.name)) kind = "cfunc";
            else if (t1Member.has(c.name)) kind = "member";
            else if (t1.globals.has(c.name)) kind = "global";
            else kind = "unknown";
            use(c.name, kind, owner, kind === "cfunc" || kind === "member" || kind === "unknown" ? c : undefined);
        }
    }
    for (const [owner, refs] of t1.valueRefs) {
        for (const r of refs) {
            if (t1.scripts.has(r)) use(r, "script", owner);
            else if (t1.globals.has(r)) use(r, "global", owner);
        }
    }

    // THUG2's calls' parameters
    const t2Params = new Map<number, Set<number>>();
    for (const calls of t2.all.calls.values()) {
        for (const c of calls) {
            const s = t2Params.get(c.name) ?? new Set<number>();
            for (const p of c.params) s.add(p);
            for (const p of c.flags) s.add(p);
            t2Params.set(c.name, s);
        }
    }
    // Commands that take any parameters (they test, print, format or hand them on): not judged.
    const passThrough = new Set(
        [
            "GotParam",
            "Printf",
            "FormatText",
            "SetTags",
            "GetTags",
            "SpawnScript",
            "RunScriptOnObject",
            "RunScriptOnScreenElement",
            "Goto",
            "GotoPreserveParams",
            "ForEachSkaterProfile",
            "GetArraySize",
            "RemoveParameter",
            "StructureContains",
            "Obj_SpawnScript",
            "SpawnSkaterScript",
            "SetProps",
            "ScriptAssert",
        ].map(checksum),
    );
    // parameters that are names of things (scripts / globals passed whole) aren't parameters
    const isThing = (v: number): boolean => t1.scripts.has(v) || t1.globals.has(v) || t2.global.scripts.has(v);

    const entries: Entry[] = [];
    for (const [v, u] of uses) {
        const files = [...u.files].sort((a, b) => b[1] - a[1]).map(([f]) => f);
        const name = nameOf(v);
        const e: Entry = {
            name,
            checksum: v,
            kind: u.kind,
            status: "missing",
            subsystem: subsystem(name, files),
            uses: u.count,
            files,
            newParams: [],
            newFlags: [],
            story: u.story,
        };
        if (u.kind === "cfunc" || u.kind === "member" || u.kind === "unknown") {
            const address = t1Cfunc.get(v)?.[1];
            if (u.kind === "cfunc" && address !== undefined) e.thug1Address = address;
            if (t1Stubs.has(v)) {
                e.status = "thug1-stub"; // THUG1's own does nothing: nothing to make
                entries.push(e);
                continue;
            }
            if (t2.cfuncStubs.has(v)) {
                e.status = "stub"; // THUG2 has the name, but its function does nothing
                entries.push(e);
                continue;
            }
            const t2Has = u.kind === "cfunc" ? t2.cfuncs.has(v) : t2.members.has(v);
            const t2Other = u.kind === "cfunc" ? t2.members.has(v) : t2.cfuncs.has(v);
            if (t2Has || (u.kind === "unknown" && (t2.cfuncs.has(v) || t2.members.has(v)))) {
                const theirs = t2Params.get(v);
                if (passThrough.has(v)) {
                    e.status = "same";
                } else if (!theirs) {
                    e.status = "unused";
                } else {
                    const fresh = (set: Set<number>): string[] =>
                        [...set]
                            .filter((p) => !theirs.has(p) && !isThing(p))
                            .map(nameOf)
                            .sort();
                    e.newParams = fresh(u.params);
                    e.newFlags = fresh(u.flags);
                    e.status = e.newParams.length ? "params" : "same";
                }
            } else if (t2Other) {
                e.status = "moved";
                e.thug2Kind = u.kind === "cfunc" ? "member" : "cfunc";
            } else if (t2.global.scripts.has(v)) {
                e.status = "moved";
                e.thug2Kind = "script";
            } else {
                e.status = "missing";
            }
        } else {
            const mine = u.kind === "script" ? t1.scripts.get(v) : t1.globals.get(v);
            const theirs = u.kind === "script" ? t2.global.scripts.get(v) : t2.global.globals.get(v);
            if (theirs === undefined) {
                e.status = t2.cfuncs.has(v) || t2.members.has(v) ? "moved" : "missing";
                if (e.status === "moved") e.thug2Kind = t2.cfuncs.has(v) ? "cfunc" : "member";
            } else e.status = mine?.body.equals(theirs.body) ? "same" : "differs";
        }
        entries.push(e);
    }
    entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.subsystem.localeCompare(b.subsystem) || b.uses - a.uses);
    return { entries, thug1Exe: t1Exe };
}

// --- the engines' side: names the exes use -------------------------------------------------------------------

// Every u32 in an exe: at each byte of the code (an imm32 needn't be aligned), each 4 bytes of the data. A script's or
// global's checksum among them: the C++ calls / reads it by name (a few false hits: 2.7M words of 2^32).
export function exeWords(file: string): Set<number> {
    const d = fs.readFileSync(file);
    const [, secs] = sections(d);
    const out = new Set<number>();
    secs.forEach((s, i) => {
        const end = Math.min(d.length, s.raw + s.rsize) - 4;
        for (let o = s.raw; o <= end; o += i === 0 ? 1 : 4) out.add(d.readUInt32LE(o));
    });
    return out;
}

export interface ContractEntry {
    name: string;
    kind: "script" | "global";
    side: "thug2 engine" | "thug1 engine";
    status: string;
    subsystem: string;
}

// The scripts / globals one engine uses by name that the other side doesn't provide:
//   THUG2's exe names a THUG2 script / global that THUG1's scripts don't define - THUG2's engine calls or reads it,
//     so a THUG1 script set needs it (THUG2's own, or a shim);
//   THUG1's exe names a THUG1 script / global that THUG2's exe never names - THUG1's engine called / read it, THUG2's
//     won't: whatever it did has to be triggered some other way.
export function contract(
    t1: ScriptSet,
    t1Words: Set<number>,
    t2: Thug2,
    t2Words: Set<number>,
    names: Map<number, string>,
): ContractEntry[] {
    const nameOf = (v: number): string => names.get(v) ?? `0x${v.toString(16).padStart(8, "0")}`;
    const out: ContractEntry[] = [];
    for (const [kind, mine, theirs] of [
        ["script", t2.global.scripts, t1.scripts],
        ["global", t2.global.globals, t1.globals],
    ] as const) {
        for (const [v, def] of mine) {
            if (!t2Words.has(v) || v < 0x10000) continue;
            const name = nameOf(v);
            const t1Def = theirs.get(v);
            const status =
                t1Def === undefined ? "THUG1 lacks it" : t1Def.body.equals(def.body) ? "same" : "THUG1's differs";
            out.push({ name, kind, side: "thug2 engine", status, subsystem: subsystem(name, [def.file]) });
        }
    }
    for (const [kind, mine] of [
        ["script", t1.scripts],
        ["global", t1.globals],
    ] as const) {
        for (const [v, def] of mine) {
            if (!t1Words.has(v) || v < 0x10000) continue;
            const name = nameOf(v);
            const status = t2Words.has(v) ? "THUG2's exe names it too" : "only THUG1's exe";
            out.push({ name, kind, side: "thug1 engine", status, subsystem: subsystem(name, [def.file]) });
        }
    }
    return out;
}

export interface KeyEntry {
    name: string;
    uses: number;
    files: string[];
    subsystem: string;
}

// The parameter / structure keys THUG1's scripts give (`key = value`) whose checksum THUG1's exe holds and THUG2's
// doesn't: what THUG1's C++ read from its scripts (a goal's parameters, a cutscene's settings...) that THUG2's never
// looks at - behaviour of THUG1's engine to rebuild, or nothing (a key only scripts read: then no exe holds it).
export function engineKeys(
    t1: ScriptSet,
    t1Words: Set<number>,
    t2Words: Set<number>,
    names: Map<number, string>,
): KeyEntry[] {
    const out: KeyEntry[] = [];
    for (const [v, files] of t1.keys) {
        if (v < 0x10000 || !t1Words.has(v) || t2Words.has(v)) continue;
        const sorted = [...files].sort((a, b) => b[1] - a[1]);
        const name = names.get(v) ?? `0x${v.toString(16).padStart(8, "0")}`;
        out.push({
            name,
            uses: sorted.reduce((a, [, n]) => a + n, 0),
            files: sorted.map(([f]) => f),
            subsystem: subsystem(
                name,
                sorted.map(([f]) => f),
            ),
        });
    }
    return out.sort((a, b) => a.subsystem.localeCompare(b.subsystem) || b.uses - a.uses);
}

export function contractSummary(entries: ContractEntry[]): string {
    const out: string[] = [];
    for (const side of ["thug2 engine", "thug1 engine"] as const) {
        const es = entries.filter((e) => e.side === side);
        const statuses = [...new Set(es.map((e) => e.status))].sort();
        out.push(
            `${side === "thug2 engine" ? "THUG2's exe names these THUG2" : "THUG1's exe names these THUG1"} scripts / globals:`,
            "",
        );
        out.push(
            table([
                ["kind", ...statuses],
                ["---", ...statuses.map(() => "---:")],
            ]),
        );
        for (const k of ["script", "global"] as const) {
            out.push(
                table([[k, ...statuses.map((s) => String(es.filter((e) => e.kind === k && e.status === s).length))]]),
            );
        }
        out.push("");
    }
    return out.join("\n");
}

// --- output -----------------------------------------------------------------------------------------------------

const KINDS: Kind[] = ["cfunc", "member", "unknown", "script", "global"];
const STATUSES: Status[] = ["same", "params", "unused", "thug1-stub", "stub", "moved", "differs", "missing"];

function table(rows: string[][]): string {
    return rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
}

export function summary(entries: Entry[]): string {
    const out: string[] = [];
    const count = (es: Entry[], k: Kind, s: Status): number => es.filter((e) => e.kind === k && e.status === s).length;
    out.push("By kind (names; uses in brackets are call sites):", "");
    out.push(
        table([
            ["kind", ...STATUSES, "total"],
            ["---", ...STATUSES.map(() => "---:"), "---:"],
        ]),
    );
    for (const k of KINDS) {
        const es = entries.filter((e) => e.kind === k);
        if (!es.length) continue;
        out.push(table([[k, ...STATUSES.map((s) => String(count(es, k, s))), String(es.length)]]));
    }
    out.push(
        "",
        "Engine-side gaps (cfunc + member; `unknown` - names THUG1 defines nothing for, dead calls - left out) by subsystem:",
        "",
    );
    const subs = [...new Set(entries.map((e) => e.subsystem))].sort();
    out.push(
        table([
            ["subsystem", "same/unused/thug1-stub", "params", "stub", "moved", "missing", "missing uses"],
            ["---", "---:", "---:", "---:", "---:", "---:", "---:"],
        ]),
    );
    for (const s of subs) {
        const es = entries.filter((e) => e.subsystem === s && (e.kind === "cfunc" || e.kind === "member"));
        if (!es.length) continue;
        const n = (st: Status[]): number => es.filter((e) => st.includes(e.status)).length;
        const missUses = es.filter((e) => e.status === "missing").reduce((a, e) => a + e.uses, 0);
        out.push(
            table([
                [
                    s,
                    String(n(["same", "unused", "thug1-stub"])),
                    String(n(["params"])),
                    String(n(["stub"])),
                    String(n(["moved"])),
                    String(n(["missing"])),
                    String(missUses),
                ],
            ]),
        );
    }
    out.push(
        "",
        "Scripts / globals by subsystem (same / differs / missing - what carrying THUG1's scripts over means):",
        "",
    );
    out.push(
        table([
            ["subsystem", "scripts same", "differs", "missing", "globals same", "differs", "missing"],
            ["---", "---:", "---:", "---:", "---:", "---:", "---:"],
        ]),
    );
    for (const s of subs) {
        const es = entries.filter((e) => e.subsystem === s);
        const n = (k: Kind, st: Status): number => es.filter((e) => e.kind === k && e.status === st).length;
        if (!es.some((e) => e.kind === "script" || e.kind === "global")) continue;
        out.push(
            table([
                [
                    s,
                    ...(["script", "global"] as Kind[]).flatMap((k) =>
                        (["same", "differs", "missing"] as Status[]).map((st) => String(n(k, st))),
                    ),
                ],
            ]),
        );
    }
    return out.join("\n");
}

export function listing(entries: Entry[]): string {
    const out: string[] = [];
    for (const k of KINDS) {
        const es = entries.filter((e) => e.kind === k && e.status !== "same");
        if (!es.length) continue;
        out.push(`## ${k}: not the same in THUG2 (${es.length})`, "");
        out.push(
            table([
                ["name", "status", "subsystem", "uses", "story", "detail", "files"],
                ["---", "---", "---", "---:", "---", "---", "---"],
            ]),
        );
        for (const e of es) {
            const detail =
                e.status === "params"
                    ? `new params: ${e.newParams.join(" ")}`
                    : e.status === "moved"
                      ? `THUG2: ${e.thug2Kind}`
                      : e.thug1Address !== undefined
                        ? `THUG1 0x${e.thug1Address.toString(16).toUpperCase()}`
                        : "";
            out.push(
                table([
                    [
                        e.name,
                        e.status,
                        e.subsystem,
                        String(e.uses),
                        e.story ? "y" : "",
                        detail,
                        e.files.slice(0, 3).join(" "),
                    ],
                ]),
            );
        }
        out.push("");
    }
    return out.join("\n");
}

function contractListing(entries: ContractEntry[]): string {
    const out: string[] = [];
    for (const [side, status] of [
        ["thug2 engine", "THUG1 lacks it"],
        ["thug2 engine", "THUG1's differs"],
        ["thug1 engine", "only THUG1's exe"],
    ] as const) {
        const es = entries
            .filter((e) => e.side === side && e.status === status)
            .sort((a, b) => a.subsystem.localeCompare(b.subsystem) || a.name.localeCompare(b.name));
        out.push(`## ${side}: ${status} (${es.length})`, "");
        out.push(
            table([
                ["name", "kind", "subsystem"],
                ["---", "---", "---"],
            ]),
        );
        for (const e of es) out.push(table([[e.name, e.kind, e.subsystem]]));
        out.push("");
    }
    return out.join("\n");
}

function dump(files: [string, Buffer][], folder: string, ns: string | undefined): void {
    for (const [name, data] of files) {
        const rel = name.replace(/\\/g, path.sep);
        const qbPath = path.join(folder, "qb", rel);
        fs.mkdirSync(path.dirname(qbPath), { recursive: true });
        fs.writeFileSync(qbPath, data);
        if (!ns) continue;
        const nsPath = path.join(folder, "ns", rel.replace(/\.qb$/i, ".ns"));
        fs.mkdirSync(path.dirname(nsPath), { recursive: true });
        const r = childProcess.spawnSync(ns, ["-lenient", "-d", qbPath, "-o", nsPath], { encoding: "latin1" });
        if (r.status !== 0) print(`ns: ${name}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
    }
}

function main(argv: string[]): number {
    const { values } = parseArgs({
        args: argv,
        options: {
            thug1: { type: "string", default: "C:\\Games\\THUG1" },
            thug2: { type: "string", default: "C:\\Games\\THUG2" },
            "thug1-exe": { type: "string" },
            "thug2-exe": { type: "string", default: REFERENCE_EXE },
            cfuncs: { type: "string", default: "data/derived/cfuncs.csv" },
            json: { type: "string" },
            list: { type: "string" },
            story: { type: "boolean", default: false },
            dump: { type: "string" },
            ns: { type: "string" },
        },
    });
    const thug1 = resolveInstall(values.thug1, "thug1");
    const thug2 = resolveInstall(values.thug2, "thug2");
    const t1ExePath = values["thug1-exe"] ?? findCaseless(thug1, "THUG.exe") ?? findCaseless(thug1, "THUGPM.exe");
    if (!t1ExePath) pyExit(`${thug1}: no THUG.exe`);
    const t1Exe = exeTables(t1ExePath);
    const t1 = readThug1(thug1);
    if (values.dump) dump(t1.files, values.dump, values.ns);
    const t2 = readThug2(thug2, values.cfuncs, values["thug2-exe"]);
    let { entries } = survey(t1.set, t1Exe, t2);
    if (values.story) entries = entries.filter((e) => e.story);
    print(
        `THUG1: ${t1.files.length} .qb files, ${t1.set.scripts.size} scripts, ${t1.set.globals.size} globals; ` +
            `${t1Exe.cfuncs.size} CFunctions (table 0x${t1Exe.cfuncTable.toString(16).toUpperCase()}), ` +
            `${t1Exe.members.length} by-name members (0x${t1Exe.memberTable.toString(16).toUpperCase()})`,
    );
    print(
        `THUG2: ${t2.global.scripts.size} game-wide scripts, ${t2.global.globals.size} globals; ${t2.cfuncs.size} ` +
            `CFunctions, ${t2.members.size} members`,
    );
    print(`${entries.length} names${values.story ? " reached from the story" : ""}`, "");
    print(summary(entries));
    const names = new Map<number, string>([...t2.names, ...t1.set.names]);
    for (const n of [...t1Exe.cfuncs.keys(), ...t1Exe.members]) names.set(checksum(n), n);
    const t1Words = exeWords(t1ExePath);
    const t2Words = exeWords(values["thug2-exe"]);
    const deal = contract(t1.set, t1Words, t2, t2Words, names);
    print("", contractSummary(deal));
    const keys = engineKeys(t1.set, t1Words, t2Words, names);
    const bySub = new Map<string, number>();
    for (const k of keys) bySub.set(k.subsystem, (bySub.get(k.subsystem) ?? 0) + 1);
    print(
        `Keys THUG1's scripts give that THUG1's exe reads and THUG2's doesn't: ${keys.length} ` +
            `(${[...bySub].map(([s, n]) => `${s} ${n}`).join(", ")})`,
    );
    if (values.list) fs.writeFileSync(values.list, listing(entries));
    if (values.list) {
        fs.appendFileSync(values.list, contractListing(deal));
        fs.appendFileSync(
            values.list,
            [
                `## keys THUG1's exe reads, THUG2's doesn't (${keys.length})`,
                "",
                table([
                    ["key", "subsystem", "uses", "files"],
                    ["---", "---", "---:", "---"],
                ]),
                ...keys.map((k) => table([[k.name, k.subsystem, String(k.uses), k.files.slice(0, 3).join(" ")]])),
                "",
            ].join("\n"),
        );
    }
    if (values.json) fs.writeFileSync(values.json, JSON.stringify({ entries, contract: deal, keys }, null, 1));
    return 0;
}

if (isMain(import.meta.url)) {
    helpFromHeader(import.meta.url);
    await runMain(() => main(process.argv.slice(2)));
}
