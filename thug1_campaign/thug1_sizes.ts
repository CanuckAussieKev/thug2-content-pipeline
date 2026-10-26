// NOT ORIGINAL - sizes THUG1 features for the campaign survey from the
// function list tools/pipeline/thug1_campaign/thug1_functions.py dumps out of THUG1's THUG.exe (Ghidra's analysis: entry,
// size, callees). Nothing is decompiled.
//
//   node tools/pipeline/thug1_campaign/thug1_sizes.ts [--functions data/derived/thug1_functions.json] [--exe <THUG.exe>]
//        [--cfunc <name>]... [--member <name>]... [--checksum <script / global name>]...
//
// For a CFunction (THUG.exe's table, found as script_gap.ts finds it): its own size and the code under it - the
// functions it reaches that nothing outside its reach calls (its private callees), as a count and bytes. For a name
// given with --checksum (a global the engine reads, a member function's name): the functions whose code holds its
// checksum as an imm32, and the same sizes for each. --member is --checksum for a member function's name.

import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { checksum } from "../level_port/qb.ts";
import { helpFromHeader } from "../lib/cli.ts";
import { isMain, print, pyExit, runMain } from "../lib/py.ts";
import { exeTables } from "./script_gap.ts";

interface Fn {
    entry: number;
    size: number;
    callees: number[];
}

export class CallGraph {
    readonly byEntry = new Map<number, Fn>();
    readonly callers = new Map<number, Set<number>>();
    private readonly sorted: Fn[];

    constructor(fns: Fn[]) {
        for (const f of fns) this.byEntry.set(f.entry, f);
        for (const f of fns) {
            for (const c of f.callees) {
                const s = this.callers.get(c) ?? new Set<number>();
                s.add(f.entry);
                this.callers.set(c, s);
            }
        }
        this.sorted = [...fns].sort((a, b) => a.entry - b.entry);
    }

    // The function whose body starts at or before `va` and covers it (by entry + size: bodies are mostly contiguous).
    containing(va: number): Fn | undefined {
        let lo = 0;
        let hi = this.sorted.length - 1;
        let best: Fn | undefined;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.sorted[mid]!.entry <= va) {
                best = this.sorted[mid];
                lo = mid + 1;
            } else hi = mid - 1;
        }
        return best && va < best.entry + best.size ? best : undefined;
    }

    // Everything reachable from `root`, and the part of it only reachable through `root` (its private code): a
    // function counts when every caller of it is itself private (iterated to a fixed point).
    reach(root: number): { all: Set<number>; private: Set<number> } {
        const all = new Set<number>();
        const todo = [root];
        while (todo.length) {
            const e = todo.pop()!;
            if (all.has(e)) continue;
            all.add(e);
            for (const c of this.byEntry.get(e)?.callees ?? []) todo.push(c);
        }
        const mine = new Set(all);
        let changed = true;
        while (changed) {
            changed = false;
            for (const e of mine) {
                if (e === root) continue;
                for (const c of this.callers.get(e) ?? []) {
                    if (!mine.has(c)) {
                        mine.delete(e);
                        changed = true;
                        break;
                    }
                }
            }
        }
        return { all, private: mine };
    }

    bytes(set: Set<number>): number {
        let n = 0;
        for (const e of set) n += this.byEntry.get(e)?.size ?? 0;
        return n;
    }
}

const hex = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(8, "0")}`;

function codeRefs(exe: Buffer, value: number): number[] {
    const pe = exe.readUInt32LE(0x3c);
    const base = exe.readUInt32LE(pe + 24 + 28);
    const o = pe + 24 + exe.readUInt16LE(pe + 20);
    const va = base + exe.readUInt32LE(o + 12);
    const rsize = exe.readUInt32LE(o + 16);
    const raw = exe.readUInt32LE(o + 20);
    const out: number[] = [];
    for (let i = raw; i + 4 <= raw + rsize; i++) if (exe.readUInt32LE(i) === value) out.push(va + i - raw);
    return out;
}

function main(argv: string[]): number {
    const { values } = parseArgs({
        args: argv,
        options: {
            functions: { type: "string", default: "data/derived/thug1_functions.json" },
            exe: { type: "string", default: "C:\\Games\\THUG1\\Game\\THUG.exe" },
            cfunc: { type: "string", multiple: true, default: [] },
            member: { type: "string", multiple: true, default: [] },
            checksum: { type: "string", multiple: true, default: [] },
        },
    });
    if (!fs.existsSync(values.functions))
        pyExit(`no ${values.functions}: run tools/pipeline/thug1_campaign/thug1_functions.py`);
    const graph = new CallGraph(JSON.parse(fs.readFileSync(values.functions, "utf-8")) as Fn[]);
    const tables = exeTables(values.exe);
    const exe = fs.readFileSync(values.exe);
    const line = (label: string, entry: number): void => {
        const f = graph.byEntry.get(entry);
        const r = graph.reach(entry);
        print(
            `${label}\t${hex(entry)}\t${f?.size ?? "?"} B\treach ${r.all.size} fns / ${graph.bytes(r.all)} B\t` +
                `private ${r.private.size} fns / ${graph.bytes(r.private)} B`,
        );
    };
    for (const name of values.cfunc) {
        const entry = [...tables.cfuncs].find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
        if (entry === undefined) print(`${name}\tnot a THUG1 CFunction`);
        else line(name, entry);
    }
    for (const name of [...values.member, ...values.checksum]) {
        const refs = codeRefs(exe, checksum(name));
        const fns = new Set(refs.map((va) => graph.containing(va)?.entry).filter((e): e is number => e !== undefined));
        if (!fns.size) print(`${name}\tno code holds ${hex(checksum(name))}`);
        for (const e of fns) line(`${name} (in)`, e);
    }
    return 0;
}

if (isMain(import.meta.url)) {
    helpFromHeader(import.meta.url);
    await runMain(() => main(process.argv.slice(2)));
}
