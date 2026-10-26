// NOT ORIGINAL - THAW's script bodies (thaw_scripts.ts scriptToks: THUG2's tokens) written as NeverScript, in the
// layout of THUG2's decompiled scripts: if / else / endif as braces, `name = value` statements, `key=value`
// arguments, `!` for not, float32s in their shortest form. bike_scripts.ts starts its ports of THAW's bike scripts
// from this text (the port's own changes are its edits, bike_scripts.edits): it is never stored.

import * as qb from "../level_port/qb.ts";
import type { Tok } from "../level_port/script_port.ts";
import { decodeLatin1 } from "../lib/py.ts";

// A float32 as its shortest decimal form that reads back the same (20.0, 0.4, 1.5).
export function shortFloat(f: number): string {
    const want = Math.fround(f);
    let text = String(want);
    for (let p = 1; p <= 9; p++) {
        const t = want.toPrecision(p);
        if (Math.fround(Number(t)) === want) {
            text = String(Number(t));
            break;
        }
    }
    if (/e/.test(text)) text = want.toFixed(9).replace(/0+$/, "");
    if (!text.includes(".") && /^-?\d+$/.test(text)) text += ".0";
    return text;
}

const WORDS: Readonly<Record<number, string>> = {
    7: "=",
    8: ".",
    9: ",",
    10: "-",
    11: "+",
    12: "/",
    13: "*",
    17: "=",
    18: "<",
    19: "<=",
    20: ">",
    21: ">=",
    34: "break",
    41: "return",
    44: "<...>",
    50: "or",
    51: "and",
    57: "!",
    58: "and",
    59: "or",
    66: ":",
};

// The script's body lines (4 spaces a level, the body at level 1).
export function renderNs(toks: readonly Tok[], names: ReadonlyMap<number, string>): string[] {
    const out: string[] = [];
    let depth = 1;
    let line: Tok[] = [];
    // per open switch: whether a case is open
    const switches: boolean[] = [];
    const emit = (text: string, at = depth): void => {
        out.push(`${"    ".repeat(Math.max(0, at))}${text}`);
    };
    const flush = (): void => {
        if (line.length) emit(join(words(line, names)));
        line = [];
    };
    for (let k = 0; k < toks.length; k++) {
        const { t } = toks[k]!;
        if (t === 0x01 || t === 0x02) {
            flush();
        } else if (t === 0x25 || t === 0x47) {
            flush();
            // (the condition runs to the line's end)
            let j = k + 1;
            const cond: Tok[] = [];
            while (j < toks.length && toks[j]!.t !== 0x01 && toks[j]!.t !== 0x02) cond.push(toks[j++]!);
            emit(`${join(["if", ...words(cond, names)])} {`);
            depth += 1;
            k = j - 1;
        } else if (t === 0x27) {
            flush();
            let j = k + 1;
            const cond: Tok[] = [];
            while (j < toks.length && toks[j]!.t !== 0x01 && toks[j]!.t !== 0x02) cond.push(toks[j++]!);
            emit(`} elseif ${join(words(cond, names))} {`, depth - 1);
            k = j - 1;
        } else if (t === 0x26 || t === 0x48) {
            flush();
            emit("} else {", depth - 1);
        } else if (t === 0x28) {
            flush();
            depth -= 1;
            emit("}");
        } else if (t === 0x20) {
            flush();
            emit("while {");
            depth += 1;
        } else if (t === 0x21) {
            // repeat [count]: to the line's end
            flush();
            let j = k + 1;
            const count: Tok[] = [];
            while (j < toks.length && toks[j]!.t !== 0x01 && toks[j]!.t !== 0x02) count.push(toks[j++]!);
            depth -= 1;
            emit(count.length ? `} repeat ${join(words(count, names))}` : "}");
            k = j - 1;
        } else if (t === 0x3c) {
            flush();
            let j = k + 1;
            const value: Tok[] = [];
            while (j < toks.length && toks[j]!.t !== 0x01 && toks[j]!.t !== 0x02 && toks[j]!.t !== 0x3e)
                value.push(toks[j++]!);
            emit(`switch ${join(words(value, names))}`);
            switches.push(false);
            depth += 1;
            k = j - 1;
        } else if (t === 0x3e || t === 0x3f) {
            flush();
            if (switches[switches.length - 1]) {
                depth -= 1;
                emit("}");
            }
            let j = k + 1;
            const value: Tok[] = [];
            if (t === 0x3e) {
                while (j < toks.length && toks[j]!.t === 0x49) j++;
                while (j < toks.length && ![0x01, 0x02, 0x49].includes(toks[j]!.t)) value.push(toks[j++]!);
            }
            emit(t === 0x3e ? `case ${join(words(value, names))} {` : "default {");
            switches[switches.length - 1] = true;
            depth += 1;
            k = j - 1;
        } else if (t === 0x3d) {
            flush();
            if (switches.pop()) {
                depth -= 1;
                emit("}");
            }
            depth -= 1;
            emit("endswitch");
        } else if (t === 0x49 || t === 0x2e) {
            // (jumps: the structure is in the other tokens)
        } else {
            line.push(toks[k]!);
        }
    }
    flush();
    return out;
}

// One token's words (a local's < and its name as one word).
function words(toks: readonly Tok[], names: ReadonlyMap<number, string>): string[] {
    const out: string[] = [];
    for (let k = 0; k < toks.length; k++) {
        const { t, p } = toks[k]!;
        if (t === 0x2d && toks[k + 1]?.t === 0x16) {
            out.push(`<${qb.nameText(toks[k + 1]!.p.readUInt32LE(0), names)}>`);
            k++;
        } else if (t === 0x16) out.push(qb.nameText(p.readUInt32LE(0), names));
        else if (t === 0x17 || t === 0x18) out.push(String(p.readInt32LE(0)));
        else if (t === 0x1a) out.push(shortFloat(p.readFloatLE(0)));
        else if (t === 0x1b) out.push(JSON.stringify(decodeLatin1(qb.rstripNul(p))));
        else if (t === 0x1c) out.push(`%"${decodeLatin1(qb.rstripNul(p))}"`);
        else if (t === 0x1e) out.push(`(${[0, 4, 8].map((o) => shortFloat(p.readFloatLE(o))).join(", ")})`);
        else if (t === 0x1f) out.push(`(${[0, 4].map((o) => shortFloat(p.readFloatLE(o))).join(", ")})`);
        else if (t === 0x03) out.push("{");
        else if (t === 0x04) out.push("}");
        else if (t === 0x05) out.push("[");
        else if (t === 0x06) out.push("]");
        else if (t === 0x0e) out.push("(");
        else if (t === 0x0f) out.push(")");
        else if (WORDS[t] !== undefined) out.push(WORDS[t]!);
        else out.push(`<#${t.toString(16)}>`);
    }
    return out;
}

// Words as a line: `key=value` (a statement's `name = value` and a comparison's ` = ` spaced), brackets and
// `obj:Command` tight, `, ` between a vector's or an argument list's parts.
function join(ws: readonly string[]): string {
    let text = "";
    let parens = 0;
    for (let i = 0; i < ws.length; i++) {
        const w = ws[i]!;
        const prev = i ? ws[i - 1]! : "";
        let sep = i ? " " : "";
        if (w === "=") {
            sep = i === 1 || parens > 0 ? " " : "";
            text += `${sep}=`;
            if (i === 1 || parens > 0) text += " ";
            continue;
        }
        if (prev === "=" && !(i === 2 || parens > 0)) sep = "";
        if (prev === "=" && (i === 2 || parens > 0)) sep = "";
        if (w === ")" || w === "]" || w === "}" || w === "," || w === ":" || w === ".") sep = "";
        if (prev === "(" || prev === "[" || prev === "{" || prev === ":" || prev === ".") sep = "";
        if (w === "(") parens++;
        if (w === ")") parens--;
        text += sep + w;
    }
    return text;
}
