// NOT ORIGINAL - reading aid for the BMX port: THAW's game scripts and globals as rough
// NeverScript-like text, from the user's THAW install (read only; nothing is stored). Globals are written with
// qb.toNs; script bodies by a plain token printer (if / else / endif as THAW's 0x25 / 0x26 / 0x28, inline structures
// as { }) - for reading, not for compiling.
//
//   node tools/pipeline/thaw_bmx/dump_scripts.ts [--thaw C:\Games\THAW] [--file <part of a qb path>]... [--name <regex>] [--pak <file>]... [--out <file>]
//
// --file picks the qb files of data\pak\qb.pak.wpc (and dbgq.pak.wpc) whose path contains the text (case-insensitive);
// --name only the scripts / globals whose name matches; --pak <file> (repeatable) other paks instead (e.g. a mod's
// data\mod\qb.pak.wpc). Without --out the text goes to stdout.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as qb from "../level_port/qb.ts";
import type { Tok } from "../level_port/script_port.ts";
import { helpFromHeader } from "../lib/cli.ts";
import { resolveInstall } from "../lib/install.ts";
import { decodeLatin1, isMain, print, runMain } from "../lib/py.ts";
import * as thaw from "../thaw_levels/thaw.ts";
import { scriptToks } from "../thaw_levels/thaw_scripts.ts";

const SIMPLE: Readonly<Record<number, string>> = {
    3: "{",
    4: "}",
    5: "[",
    6: "]",
    7: "=",
    8: ".",
    9: ",",
    10: "-",
    11: "+",
    12: "/",
    13: "*",
    14: "(",
    15: ")",
    18: "<",
    19: "<=",
    20: ">",
    21: ">=",
    17: "==",
    32: "while",
    33: "repeat",
    34: "break",
    37: "if",
    38: "else",
    39: "elseif",
    40: "endif",
    41: "return",
    44: "<...>",
    45: "<",
    57: "not",
    58: "and",
    59: "or",
    60: "switch",
    61: "endswitch",
    62: "case",
    63: "default",
    66: ":",
    71: "if",
    72: "else",
    73: "endswitch",
};

export function renderBody(toks: readonly Tok[], names: ReadonlyMap<number, string>): string {
    const out: string[] = [];
    let line: string[] = [];
    let depth = 1;
    const flush = (): void => {
        if (!line.length) return;
        const text = line
            .join(" ")
            .replaceAll("< ", "<")
            .replaceAll(" . ", ".")
            .replaceAll(" :", ":")
            .replaceAll(": ", ":");
        const first = line[0]!;
        const dedent = ["else", "endif", "repeat", "endswitch", "case", "default", "elseif", "}", "]"].includes(first)
            ? 1
            : 0;
        out.push(`${"    ".repeat(Math.max(0, depth - dedent))}${text}`);
        if (["if", "while", "switch"].includes(first) || line[line.length - 1] === "{") depth += 1;
        if (["endif", "repeat", "endswitch"].includes(first)) depth -= 1;
        line = [];
    };
    for (let k = 0; k < toks.length; k++) {
        const tok = toks[k]!;
        const t = tok.t;
        const p = tok.p;
        if (t === 0x01 || t === 0x02) {
            flush();
            continue;
        }
        if (t === 0x16) {
            const v = p.readUInt32LE(0);
            const name = qb.nameText(v, names);
            // a local <name>: the previous token was 0x2D
            if (line.length && line[line.length - 1] === "<") line[line.length - 1] = `<${name}>`;
            else line.push(name);
            continue;
        }
        if (t === 0x17 || t === 0x18) line.push(String(p.readInt32LE(0)));
        else if (t === 0x1a) line.push(qb.fmtFloat(p.readFloatLE(0)));
        else if (t === 0x1b) line.push(JSON.stringify(decodeLatin1(qb.rstripNul(p))));
        else if (t === 0x1c) line.push(`'${decodeLatin1(qb.rstripNul(p))}'`);
        else if (t === 0x1e) line.push(`(${[0, 4, 8].map((o) => qb.fmtFloat(p.readFloatLE(o))).join(", ")})`);
        else if (t === 0x1f) line.push(`(${[0, 4].map((o) => qb.fmtFloat(p.readFloatLE(o))).join(", ")})`);
        else if (t === 0x2f || t === 0x37 || t === 0x40 || t === 0x41) line.push(`random(${p.readUInt32LE(0)})`);
        else if (t === 0x2e) line.push("@jump");
        else if (SIMPLE[t] !== undefined) {
            if (
                ["if", "else", "endif", "while", "repeat", "switch", "endswitch", "case", "default", "elseif"].includes(
                    SIMPLE[t]!,
                ) &&
                line.length
            )
                flush();
            line.push(SIMPLE[t]!);
            if (t === 0x26 || t === 0x28 || t === 0x48) flush();
        } else line.push(`<#${t.toString(16)}>`);
    }
    flush();
    return out.join("\n");
}

export function main(argv: string[]): number {
    const { values } = parseArgs({
        args: argv,
        options: {
            thaw: { type: "string", default: "C:\\Games\\THAW" },
            file: { type: "string", multiple: true, default: [] },
            name: { type: "string" },
            out: { type: "string" },
            pak: { type: "string", multiple: true, default: [] },
        },
    });
    const game = resolveInstall(values.thaw!, "thaw");
    const names = thaw.loadNames(values.thaw!);
    const filter = values.name ? new RegExp(values.name, "i") : null;
    const parts = (values.file ?? []).map((f) => f.toLowerCase());
    const text: string[] = [];
    const paks = values.pak?.length
        ? values.pak
        : ["qb.pak.wpc", "dbgq.pak.wpc"].map((p) => path.join(game, "data", "pak", p));
    for (const file of paks) {
        const pak = path.basename(file);
        if (!fs.existsSync(file)) continue;
        for (const [e, d] of thaw.pakFiles(file)) {
            if (e.extension !== ".qb" || !e.path) continue;
            const label = e.path.toLowerCase();
            if (parts.length && !parts.some((p) => label.includes(p))) continue;
            let items: thaw.QbItems;
            try {
                items = new thaw.QbItems(d, e.path, names);
            } catch (err) {
                text.push(`// ${e.path}: not read (${String(err)})`);
                continue;
            }
            text.push(`// ===== ${pak}: ${e.path}`);
            for (const [key, value] of items.globals) {
                const n = qb.nameText(key.value, names);
                if (filter && !filter.test(n)) continue;
                try {
                    text.push(`${n} = ${qb.toNs(value, names)}`);
                } catch (err) {
                    text.push(`${n} = <not written: ${String(err)}>`);
                }
            }
            for (const [key, body] of items.scriptData) {
                const n = qb.nameText(key, names);
                if (filter && !filter.test(n)) continue;
                try {
                    const toks = scriptToks(body, names, n, items.order);
                    text.push(`script ${n} {\n${renderBody(toks, names)}\n}`);
                } catch (err) {
                    text.push(`script ${n} <not read: ${String(err)}>`);
                }
            }
        }
    }
    const all = text.join("\n");
    if (values.out) fs.writeFileSync(values.out, all, "utf8");
    else print(all);
    return 0;
}

if (isMain(import.meta.url)) {
    helpFromHeader(import.meta.url);
    await runMain(() => main(process.argv.slice(2)));
}
