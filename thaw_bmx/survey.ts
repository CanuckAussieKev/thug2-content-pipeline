// NOT ORIGINAL - scoping survey for THAW's BMX riding in THUG2. Reads the user's THAW

// (PC 1.01) and THUG2 installs, read only; nothing of either game is stored.
//
//   node tools/pipeline/thaw_bmx/survey.ts [--thaw C:\Games\THAW] [--thug2 C:\Games\THUG2] [--exe <THAW's exe>]
//                                         [members|scripts|assets|all]
//
// --exe: the THAW exe the members are read from - by default THAW's reference build (the decomp's local.json:
// thawReferenceExe; the addresses the BMX work names are its), else the install's THAW.exe.
//
// members  THAW's script member tables ({u32 name, u32 component, u32 function, 3 x u32 0} - 0x18 bytes, the
//          functions mostly stored by a static initialiser: `mov eax, imm32; mov [entry+8], eax`) and its CFunction
//          table ({char* name, function}); the bike members (and every component's count) against THUG2's
//          (tools/pipeline/level_port/thug2_members.ts, the reference build's CFunction table)
// scripts  the BMX scripts in data\pak\qb.pak.wpc (names with bike / bmx, the files under a bike / bmx path, and the
//          scripts those call, two levels down): every command they run (script_port's Thug2.commandsOf - statement
//          position, not `obj:` calls), classed as THAW script / THUG2 CFunction / THUG2 member / THAW-only CFunction /
//          THAW-only member / unknown (a by-name member, or a parameter)
// assets   THAW's skeletons (worlds\Global\global.pak.wpc) against THUG2's (Data\pre\skeletons.prx), and the .ska headers
//          of pak\bmx_anims (version, flags, bones, per-bone key stream sizes adding up)

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as prx from "../level_port/prx.ts";
import { checksum } from "../level_port/qb.ts";
import { Thug2 } from "../level_port/script_port.ts";
import { NAMED_MEMBERS, TABLE_MEMBERS, COMPONENTS as THUG2_COMPONENTS } from "../level_port/thug2_members.ts";
import { helpFromHeader } from "../lib/cli.ts";
import { GAME_EXE_NAMES, THAW_REFERENCE_EXE } from "../lib/decomp.ts";
import { resolveInstall } from "../lib/install.ts";
import { decodeLatin1, isMain, print, runMain } from "../lib/py.ts";
import * as thaw from "../thaw_levels/thaw.ts";

const BMX = /bike|bmx/i;
const hex8 = (n: number): string => n.toString(16).padStart(8, "0");

// --- THAW's exe -----------------------------------------------------------------------------------------------------

interface Section {
    va: number;
    vsize: number;
    rsize: number;
    raw: number;
}

export class Exe {
    readonly data: Buffer;
    readonly sections: Section[] = [];
    constructor(file: string) {
        this.data = fs.readFileSync(file);
        const d = this.data;
        const pe = d.readUInt32LE(0x3c);
        const first = pe + 24 + d.readUInt16LE(pe + 20);
        for (let i = 0; i < d.readUInt16LE(pe + 6); i++) {
            const o = first + 40 * i;
            this.sections.push({
                vsize: d.readUInt32LE(o + 8),
                va: 0x400000 + d.readUInt32LE(o + 12),
                rsize: d.readUInt32LE(o + 16),
                raw: d.readUInt32LE(o + 20),
            });
        }
    }
    offset(va: number): number | null {
        for (const s of this.sections) if (va >= s.va && va < s.va + s.rsize) return s.raw + va - s.va;
        return null;
    }
    u32(va: number): number | null {
        const o = this.offset(va);
        return o === null || o + 4 > this.data.length ? null : this.data.readUInt32LE(o);
    }
    cString(va: number): string | null {
        const o = this.offset(va);
        if (o === null) return null;
        const end = this.data.indexOf(0, o);
        if (end < 0 || end - o > 80 || end === o) return null;
        const bytes = this.data.subarray(o, end);
        for (const b of bytes) if (b < 0x20 || b > 0x7e) return null;
        return decodeLatin1(bytes);
    }
    // the first section is THAW's own code
    isCode(va: number): boolean {
        const s = this.sections[0]!;
        return va >= s.va && va < s.va + s.vsize;
    }
    // `mov eax, imm32` (B8) then `mov [addr], eax` (A3) pairs in the code: address -> value (the static initialisers)
    storedPointers(): Map<number, number> {
        const out = new Map<number, number>();
        const s = this.sections[0]!;
        const d = this.data;
        let eax: number | null = null;
        for (let p = s.raw; p < s.raw + s.rsize - 5; p++) {
            if (d[p] === 0xb8 && this.isCode(d.readUInt32LE(p + 1))) {
                eax = d.readUInt32LE(p + 1);
                if (d[p + 5] === 0xa3) out.set(d.readUInt32LE(p + 6), eax);
            } else if (d[p] === 0xa3 && eax !== null && !out.has(d.readUInt32LE(p + 1))) {
                // (eax loaded further up: the last `mov eax, imm32` seen)
                out.set(d.readUInt32LE(p + 1), eax);
            }
        }
        return out;
    }
}

export interface Member {
    name: number;
    component: number;
    fn: number; // 0: not found
    table: number;
}

// Runs of at least 3 member entries of one component in the data sections.
export function memberTables(exe: Exe, names: ReadonlyMap<number, string>): Member[] {
    const stored = exe.storedPointers();
    const out: Member[] = [];
    for (const s of exe.sections.slice(1, 3)) {
        let va = s.va;
        const end = s.va + s.rsize - 0x18;
        const entry = (at: number): [number, number, number] | null => {
            const w = [0, 4, 8, 12, 16, 20].map((o) => exe.u32(at + o));
            if (w.some((x) => x === null)) return null;
            const [name, comp, fn, a, b, c] = w as number[];
            if (!names.has(name!) || !names.has(comp!) || a || b || c) return null;
            if (fn && !exe.isCode(fn)) return null;
            return [name!, comp!, fn!];
        };
        while (va < end) {
            const first = entry(va);
            if (first === null) {
                va += 4;
                continue;
            }
            const run: [number, number, number, number][] = [];
            let at = va;
            for (let e = entry(at); e !== null && e[1] === first[1]; e = entry(at)) {
                run.push([at, ...e]);
                at += 0x18;
            }
            if (run.length >= 3) {
                for (const [where, name, comp, fn] of run)
                    out.push({ name, component: comp, fn: fn || (stored.get(where + 8) ?? 0), table: va });
                va = at;
            } else va += 4;
        }
    }
    return out;
}

// THAW's CFunction table: {char* name, function} pairs around the entry naming SpawnScript.
export function cfunctions(exe: Exe): { name: string; fn: number }[] {
    const target = (() => {
        for (const s of exe.sections.slice(1, 3)) {
            const o = exe.data.indexOf(Buffer.from("SpawnScript\0", "latin1"), s.raw);
            if (o >= 0 && o < s.raw + s.rsize) return s.va + (o - s.raw);
        }
        return null;
    })();
    if (target === null) throw new Error("THAW's exe: no SpawnScript string");
    for (const s of exe.sections.slice(1, 3)) {
        for (let va = s.va; va < s.va + s.rsize - 8; va += 4) {
            if (exe.u32(va) !== target || !exe.isCode(exe.u32(va + 4) ?? 0)) continue;
            const ok = (at: number): boolean => {
                const n = exe.u32(at);
                const f = exe.u32(at + 4);
                return n !== null && f !== null && exe.isCode(f) && exe.cString(n) !== null;
            };
            let lo = va;
            while (ok(lo - 8)) lo -= 8;
            let hi = va;
            while (ok(hi + 8)) hi += 8;
            const out: { name: string; fn: number }[] = [];
            for (let at = lo; at <= hi; at += 8) out.push({ name: exe.cString(exe.u32(at)!)!, fn: exe.u32(at + 4)! });
            if (out.length > 100) return out;
        }
    }
    throw new Error("THAW's exe: the CFunction table wasn't found");
}

// --- the survey ---------------------------------------------------------------------------------------------------

interface Context {
    thaw: string;
    thug2: string;
    names: Map<number, string>;
    exe: Exe;
    members: Member[];
    cfuncs: { name: string; fn: number }[];
    thug2Cfuncs: Set<number>;
    thug2Members: Map<number, readonly string[]>;
}

const nameOf = (c: Context, v: number): string => c.names.get(v) ?? hex8(v);
const thug2ComponentName = new Map(THUG2_COMPONENTS.map(([k, n]) => [k, n]));

function context(thawDir: string, thug2Dir: string, exePath: string): Context {
    const names = thaw.loadNames(thawDir);
    const game = resolveInstall(thawDir, "thaw");
    const exe = new Exe(exePath || path.join(game, "THAW.exe"));
    const thug2Game = resolveInstall(thug2Dir, "thug2");
    let thug2Exe: Buffer | null = null;
    for (const n of GAME_EXE_NAMES) {
        const f = path.join(thug2Game, n);
        if (fs.existsSync(f)) {
            thug2Exe = fs.readFileSync(f);
            break;
        }
    }
    if (thug2Exe === null) throw new Error(`no THUG2 exe in ${thug2Game}`);
    const [thug2Members] = Thug2.memberTable();
    return {
        thaw: game,
        thug2: thug2Game,
        names,
        exe,
        members: memberTables(exe, names),
        cfuncs: cfunctions(exe),
        thug2Cfuncs: new Set(Thug2.cfuncNames(thug2Exe).map(checksum)),
        thug2Members,
    };
}

function surveyMembers(c: Context): void {
    print("== THAW member tables");
    const byComp = new Map<number, Member[]>();
    for (const m of c.members) {
        if (!byComp.has(m.component)) byComp.set(m.component, []);
        byComp.get(m.component)!.push(m);
    }
    const thug2Table = new Map<number, number>(); // component checksum -> member count
    for (const [, comp] of TABLE_MEMBERS) {
        const k = checksum(comp);
        thug2Table.set(k, (thug2Table.get(k) ?? 0) + 1);
    }
    print(
        "component                          THAW  in THUG2  THAW-only   (THUG2: the member exists there, any component)",
    );
    for (const [comp, list] of [...byComp].sort((a, b) => b[1].length - a[1].length)) {
        const only = list.filter((m) => !c.thug2Members.has(m.name)).length;
        const known = thug2ComponentName.has(comp) || thug2Table.has(comp) ? "" : "  (no such THUG2 component)";
        print(
            `${nameOf(c, comp).padEnd(34)} ${String(list.length).padStart(4)} ${String(list.length - only).padStart(9)} ${String(only).padStart(10)}${known}`,
        );
    }
    print(
        `(${c.members.length} table members; THUG2: ${TABLE_MEMBERS.length} table + ${NAMED_MEMBERS.length} by name)`,
    );
    print("\n== bike members (name matches bike/bmx, or skatercorephysics members THUG2 lacks)");
    const core = checksum("skatercorephysics");
    for (const m of c.members) {
        const n = nameOf(c, m.name);
        if (!BMX.test(n) && !(m.component === core && !c.thug2Members.has(m.name))) continue;
        print(
            `  ${n.padEnd(28)} ${nameOf(c, m.component).padEnd(20)} fn ${hex8(m.fn)}  ${c.thug2Members.has(m.name) ? "in THUG2" : "THAW only"}`,
        );
    }
    const only = c.cfuncs.filter((f) => !c.thug2Cfuncs.has(checksum(f.name)));
    print(`\n== CFunctions: THAW ${c.cfuncs.length}, not in THUG2 ${only.length}; bike / bmx ones:`);
    for (const f of c.cfuncs) if (BMX.test(f.name)) print(`  ${f.name} ${hex8(f.fn)}`);
}

interface ScriptSet {
    scripts: Map<number, Buffer>; // every THAW script
    files: Map<number, string>; // script -> its qb file
    globals: Map<number, string>;
}

function readScripts(c: Context): ScriptSet {
    const out: ScriptSet = { scripts: new Map(), files: new Map(), globals: new Map() };
    for (const [e, d] of thaw.pakFiles(path.join(c.thaw, "data", "pak", "qb.pak.wpc"))) {
        if (e.extension !== ".qb") continue;
        const file = e.path ?? nameOf(c, e.full);
        let items: thaw.QbItems;
        try {
            items = new thaw.QbItems(d, file, c.names);
        } catch {
            continue;
        }
        for (const [k, body] of items.scriptData) {
            out.scripts.set(k, body);
            out.files.set(k, file);
        }
        for (const [k] of items.globals) out.globals.set(k.value, file);
    }
    return out;
}

function commands(body: Buffer): number[] {
    const toks = [...thaw.tokens(body)].map(([, t, p]) => [t, p] as const);
    return Thug2.commandsOf(toks).map((u) => u.name);
}

function surveyScripts(c: Context): void {
    const s = readScripts(c);
    const thawMembers = new Map(c.members.map((m) => [m.name, m.component]));
    const thawCfuncs = new Set(c.cfuncs.map((f) => checksum(f.name)));
    // the BMX scripts: by name or file, then two levels of the scripts they run
    const roots = [...s.scripts.keys()].filter((k) => BMX.test(nameOf(c, k)) || BMX.test(s.files.get(k) ?? ""));
    const set = new Set(roots);
    let frontier = roots;
    for (let level = 0; level < 2; level++) {
        const next: number[] = [];
        for (const k of frontier)
            for (const n of commands(s.scripts.get(k)!))
                if (s.scripts.has(n) && !set.has(n)) {
                    set.add(n);
                    next.push(n);
                }
        frontier = next;
    }
    const bmxGlobals = [...s.globals.keys()].filter((k) => BMX.test(nameOf(c, k)));
    let bytes = 0;
    for (const k of set) bytes += s.scripts.get(k)!.length;
    print(
        `== scripts: ${roots.length} BMX scripts (+${set.size - roots.length} they call, 2 levels: ${bytes} bytes of tokens), ${bmxGlobals.length} BMX globals`,
    );
    const files = new Map<string, number>();
    for (const k of roots) files.set(s.files.get(k)!, (files.get(s.files.get(k)!) ?? 0) + 1);
    for (const [f, n] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 15)) print(`  ${String(n).padStart(4)} ${f}`);
    const classes = new Map<string, Map<number, number>>();
    const add = (cls: string, n: number): void => {
        if (!classes.has(cls)) classes.set(cls, new Map());
        const m = classes.get(cls)!;
        m.set(n, (m.get(n) ?? 0) + 1);
    };
    for (const k of set) {
        for (const n of commands(s.scripts.get(k)!)) {
            if (s.scripts.has(n)) add("THAW script", n);
            else if (c.thug2Cfuncs.has(n)) add("THUG2 CFunction", n);
            else if (c.thug2Members.has(n)) add("THUG2 member", n);
            else if (thawCfuncs.has(n)) add("THAW-only CFunction", n);
            else if (thawMembers.has(n)) add("THAW-only member", n);
            else add("unknown (by-name member / parameter / missing)", n);
        }
    }
    for (const cls of [
        "THAW script",
        "THUG2 CFunction",
        "THUG2 member",
        "THAW-only CFunction",
        "THAW-only member",
        "unknown (by-name member / parameter / missing)",
    ]) {
        const m = classes.get(cls) ?? new Map<number, number>();
        print(`\n-- ${cls}: ${m.size} names, ${[...m.values()].reduce((a, b) => a + b, 0)} uses`);
        if (cls === "THAW script") continue;
        const list = [...m]
            .sort((a, b) => b[1] - a[1])
            .map(([n, u]) => {
                const comp = thawMembers.get(n);
                return `${nameOf(c, n)}${comp !== undefined ? ` [${nameOf(c, comp)}]` : ""} x${u}`;
            });
        for (let i = 0; i < list.length; i += 4) print(`  ${list.slice(i, i + 4).join(", ")}`);
    }
    print("\n-- BMX globals (trick lists, tables):");
    const g = bmxGlobals.map((k) => nameOf(c, k)).sort();
    for (let i = 0; i < g.length; i += 6) print(`  ${g.slice(i, i + 6).join(", ")}`);
}

interface Ske {
    bones: number[];
    parents: number[];
}

function readThawSke(d: Buffer): Ske {
    const count = d.readUInt32LE(4);
    const at = (k: number): number[] => {
        const o = d.readUInt32LE(0x10 + 4 * k);
        return [...Array(count)].map((_, i) => d.readUInt32LE(o + 4 * i));
    };
    return { bones: at(0), parents: at(1) };
}

// A THAW .ska's key streams read with THUG2's key forms (tools/pipeline/thug1_levels/thug1.ts untableAnim): rotation keys
// {u16 h; h & 0x4000 clear: 3 x u16; else h & 0x3800 clear: a table byte; else x / y / z a byte or a u16 each},
// translation keys {byte b (b & 0x40: the time in it, else a u16); b & 0x80: a table byte, else 3 x u16}. The data
// after the per-bone sizes (aligned to 4; flag 0x80000, a partial animation: u32 count and its bits first). True when
// every bone's stream ends exactly at its size.
export function walkKeys(d: Buffer, bones: number, flags: number): boolean {
    let p = (0x30 + 4 * bones + 3) & ~3;
    if (flags & 0x80000) {
        const count = d.readInt32LE(p);
        p = (p + 4 * (((count - 1) >> 5) + 2) + 3) & ~3;
    }
    for (let b = 0; b < bones; b++) {
        const end = p + d.readUInt16LE(0x30 + 2 * b);
        while (p < end) {
            const h = d.readUInt16LE(p);
            if (!(h & 0x4000)) p += 8;
            else if (!(h & 0x3800)) p += 3;
            else p += 2 + (h & 0x2000 ? 1 : 2) + (h & 0x1000 ? 1 : 2) + (h & 0x800 ? 1 : 2);
        }
        if (p !== end) return false;
    }
    for (let b = 0; b < bones; b++) {
        const end = p + d.readUInt16LE(0x30 + 2 * bones + 2 * b);
        while (p < end) {
            const k = d[p]!;
            const head = 1 + (k & 0x40 ? 0 : 2);
            p += k & 0x80 ? head + 1 : head + 6;
        }
        if (p !== end) return false;
    }
    return p <= d.length;
}

function surveyAssets(c: Context): void {
    print("== skeletons");
    const thug2 = new Map<string, number[]>();
    for (const [name, d] of prx.entries(path.join(c.thug2, "Data", "pre", "skeletons.prx"))) {
        const count = d.readUInt32LE(8);
        thug2.set(
            name,
            [...Array(count)].map((_, i) => d.readUInt32LE(12 + 4 * i)),
        );
    }
    const human = thug2.get("skeletons\\THPS6_Human.ske.xbx") ?? [];
    for (const [e, d] of thaw.pakFiles(path.join(c.thaw, "data", "worlds", "Global", "global.pak.wpc"))) {
        if (e.extension !== ".ske") continue;
        const s = readThawSke(d);
        const version = d.readUInt16LE(0);
        let line = `  THAW .ske v${version} ${String(s.bones.length).padStart(2)} bones: ${s.bones
            .slice(0, 4)
            .map((b) => nameOf(c, b))
            .join(", ")}...`;
        if (s.bones.length > 40) {
            const extra = s.bones.filter((b) => !human.includes(b)).map((b) => nameOf(c, b));
            const missing = human.filter((b) => !s.bones.includes(b)).map((b) => nameOf(c, b));
            line += `\n     vs THUG2 THPS6_Human (${human.length}): THAW-only ${extra.join(", ")}; THUG2-only ${missing.join(", ")}`;
        }
        print(line);
    }
    print("\n== pak\\bmx_anims .ska");
    const stats = new Map<string, number>();
    let ok = 0;
    let bad = 0;
    let keysOk = 0;
    let keysBad = 0;
    for (const [e, d] of thaw.pakFiles(path.join(c.thaw, "data", "pak", "bmx_anims", "bmx_anims.pak.wpc"))) {
        if (e.extension !== ".ska") continue;
        const version = d.readUInt32LE(0);
        const flags = d.readUInt32LE(4);
        const bones = d[0xd]!;
        const key = `version 0x${version.toString(16)} flags ${hex8(flags)} bones ${bones}`;
        stats.set(key, (stats.get(key) ?? 0) + 1);
        // per-bone stream sizes (u16 x bones rotation, u16 x bones translation at 0x30) against the totals at 0x28
        const qSize = d.readUInt32LE(0x28);
        const tSize = d.readUInt32LE(0x2c);
        let q = 0;
        let t = 0;
        for (let b = 0; b < bones; b++) {
            q += d.readUInt16LE(0x30 + 2 * b);
            t += d.readUInt16LE(0x30 + 2 * bones + 2 * b);
        }
        if (q === qSize && t === tSize) ok++;
        else bad++;
        if (walkKeys(d, bones, flags)) keysOk++;
        else keysBad++;
    }
    print(
        `  every bone's keys walk to its stream's end with THUG2's key forms (tools/pipeline/thug1_levels untableAnim's rules): ${keysOk} yes, ${keysBad} no`,
    );
    for (const [k, n] of stats) print(`  ${String(n).padStart(4)} x ${k}`);
    print(`  per-bone key stream sizes add up to the header's totals: ${ok} yes, ${bad} no`);
    const tq = fs.readFileSync(path.join(c.thaw, "data", "anims", "standardkeyQ.bin"));
    const q2 = prx.find(path.join(c.thug2, "Data", "pre", "Bits.prx"), "anims\\standardkeyQ.bin");
    print(
        `  THAW's standard key table (anims\\standardkeyQ.bin) equals THUG2's: ${q2 ? Buffer.compare(tq, q2) === 0 : "THUG2's not found"}`,
    );
    print("\n== bike models");
    for (const rel of ["models\\SpecialItems\\BMX\\si_bmx.skin.wpc", "models\\Veh\\veh_BMX\\veh_bmx.skin.wpc"]) {
        const f = path.join(c.thaw, "data", rel);
        print(
            `  ${rel}: ${fs.existsSync(f) ? `${fs.statSync(f).size} bytes, header ${fs.readFileSync(f).subarray(0, 16).toString("hex")}` : "missing"}`,
        );
    }
}

export function main(argv: string[]): number {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            thaw: { type: "string", default: "C:\\Games\\THAW" },
            thug2: { type: "string", default: "C:\\Games\\THUG2" },
            exe: { type: "string", default: THAW_REFERENCE_EXE },
        },
        allowPositionals: true,
    });
    const what = positionals[0] ?? "all";
    const c = context(values.thaw!, values.thug2!, values.exe!);
    if (what === "members" || what === "all") surveyMembers(c);
    if (what === "scripts" || what === "all") surveyScripts(c);
    if (what === "assets" || what === "all") surveyAssets(c);
    return 0;
}

if (isMain(import.meta.url)) {
    helpFromHeader(import.meta.url);
    await runMain(() => main(process.argv.slice(2)));
}
