// NOT ORIGINAL - the retail export's changes to the game's script files (retail_export.ts), made so they can be taken
// out again from whatever the file has become: every change is lines inserted into the file's text (as NeverScript
// decompiles it), never a line changed or removed, and each insertion is recorded with the lines around it - enough
// to find it again once only it in the file is ours. Other changes in the file (the user's own mods, before or after
// ours) stay as they are.

import { SequenceMatcher } from "thug2-level-converter-core/lib/difflib.ts";

// Lines inserted at a line start of the base text.
export interface Insertion {
    at: number; // character offset in the base text (0, or just after a "\n")
    text: string; // whole lines, each ending "\n"
}

// An insertion as recorded: its lines and the base text's lines around it (as many as make it unique).
export interface InsertionRecord {
    before: string[];
    lines: string[];
    after: string[];
}

export class MergeError extends Error {}

export function lines(text: string): string[] {
    const out = text.replaceAll("\r\n", "\n").split("\n");
    if (out.length && out[out.length - 1] === "") out.pop();
    return out;
}

function join(list: readonly string[]): string {
    return list.map((l) => `${l}\n`).join("");
}

// The base text with the insertions (in any order; two at one place keep their order).
export function applyInsertions(base: string, insertions: readonly Insertion[]): string {
    const sorted = insertions.map((ins, i) => ({ ins, i })).sort((a, b) => a.ins.at - b.ins.at || a.i - b.i);
    let out = "";
    let from = 0;
    for (const { ins } of sorted) {
        if (ins.at < 0 || ins.at > base.length || (ins.at > 0 && base[ins.at - 1] !== "\n")) {
            throw new MergeError(`an insertion not at a line start (${ins.at})`);
        }
        if (!ins.text.endsWith("\n")) throw new MergeError("an insertion that isn't whole lines");
        out += base.slice(from, ins.at) + ins.text;
        from = ins.at;
    }
    return out + base.slice(from);
}

// Where `block` (lines) starts in `text` (lines): every index.
function occurrences(text: readonly string[], block: readonly string[], from = 0): number[] {
    const out: number[] = [];
    if (!block.length) return out;
    for (let i = from; i + block.length <= text.length; i++) {
        let k = 0;
        while (k < block.length && text[i + k] === block[k]) k++;
        if (k === block.length) out.push(i);
    }
    return out;
}

function matchesAt(text: readonly string[], at: number, block: readonly string[]): boolean {
    if (at < 0 || at + block.length > text.length) return false;
    return block.every((l, k) => text[at + k] === l);
}

// The records of the insertions: each with the fewest lines of context (before and after, at least one each where
// there are any; up to 40) that make it found once in the new text.
export function recordInsertions(base: string, insertions: readonly Insertion[]): InsertionRecord[] {
    const sorted = [...insertions].sort((a, b) => a.at - b.at);
    const newLines = lines(applyInsertions(base, insertions));
    const baseLines = lines(base);
    const records: InsertionRecord[] = [];
    let shift = 0; // lines inserted before this one
    for (const ins of sorted) {
        const baseLine = lines(base.slice(0, ins.at)).length;
        const block = lines(ins.text);
        const start = baseLine + shift;
        let record: InsertionRecord | null = null;
        for (let k = 1; k <= 40; k++) {
            const before = baseLines.slice(Math.max(0, baseLine - k), baseLine);
            const after = baseLines.slice(baseLine, baseLine + k);
            const all = [...before, ...block, ...after];
            const found = occurrences(newLines, all);
            if (found.length === 1 && found[0] === start - before.length) {
                record = { before, lines: block, after };
                break;
            }
        }
        if (!record)
            throw new MergeError(`an insertion of ${block.length} lines can't be told from the text around it`);
        records.push(record);
        shift += block.length;
    }
    return records;
}

// The text with the recorded insertions taken out. Each is found by its lines with the lines recorded before and
// after it (else before or after alone, else its lines alone) - where exactly one place matches; anything else is a
// MergeError (the file changed around it too much to tell what is ours).
export function stripInsertions(text: string, records: readonly InsertionRecord[]): string {
    let current = lines(text);
    for (const record of records) {
        const found = occurrences(current, record.lines);
        const tries: ((at: number) => boolean)[] = [
            (at) =>
                matchesAt(current, at - record.before.length, record.before) &&
                matchesAt(current, at + record.lines.length, record.after),
            (at) => matchesAt(current, at - record.before.length, record.before),
            (at) => matchesAt(current, at + record.lines.length, record.after),
            () => true,
        ];
        let chosen: number | null = null;
        for (const test of tries) {
            const hits = found.filter(test);
            if (hits.length === 1) {
                chosen = hits[0]!;
                break;
            }
            if (hits.length > 1) break; // (more than one place: a looser test only finds more)
        }
        if (chosen === null) {
            const first = record.lines[0]?.trim() ?? "";
            throw new MergeError(
                found.length
                    ? `our lines starting "${first}" are there ${found.length} times - can't tell which is ours`
                    : `our lines starting "${first}" aren't there any more (changed or removed since we added them)`,
            );
        }
        current = [...current.slice(0, chosen), ...current.slice(chosen + record.lines.length)];
    }
    return sameEnding(text, join(current));
}

// `result` (whole lines) ending as `original` does: with a line end or without (NeverScript writes its files without
// one, and a line end more compiles to one more byte).
export function sameEnding(original: string, result: string): string {
    return original.endsWith("\n") || !result.endsWith("\n") ? result : result.slice(0, -1);
}

// The insertions that make `edited` of `base` - for an edit made by another tool that only adds lines (the level
// converters' people: their profiles and CAS parts appended to THUG2's lists). Anything else is a MergeError.
export function insertionsFrom(base: string, edited: string): Insertion[] {
    const a = lines(base);
    const b = lines(edited);
    const out: Insertion[] = [];
    for (const [tag, i1, , j1, j2] of new SequenceMatcher(a, b, false).getOpcodes()) {
        if (tag === "equal") continue;
        if (tag !== "insert") throw new MergeError("an edit that changes or removes lines, not only adds them");
        out.push({ at: lineStart(base, i1), text: join(b.slice(j1, j2)) });
    }
    if (applyInsertions(base, out) !== edited && join(lines(applyInsertions(base, out))) !== join(b)) {
        throw new MergeError("an edit that can't be told as added lines");
    }
    return out;
}

// The character offset of the start of line `index` (0-based) in `text` (its length past the last line).
export function lineStart(text: string, index: number): number {
    let at = 0;
    for (let i = 0; i < index; i++) {
        const next = text.indexOf("\n", at);
        if (next < 0) return text.length;
        at = next + 1;
    }
    return at;
}

// The offset just after the line holding `offset`.
export function afterLine(text: string, offset: number): number {
    const next = text.indexOf("\n", offset);
    return next < 0 ? text.length : next + 1;
}
