// NOT ORIGINAL - reading node arrays for the comparisons with THUGPRO's levels (moved from
// thaw_levels/thugpro_compare.ts with the converters' split: the THPS3, THPS4, THUG1 and THUG2 THUGPRO tools and
// the scenic art use them too).

import * as qb from "../level_port/qb.ts";
import { Name, type QbValue, Struct, Vector } from "../level_port/qb.ts";

export const TOLERANCE = 0.1; // units (the frames differ by under 1/32: ours in whole sixteenths)
export const CTF_NAMES = [
    ...["Red", "Blue", "Green", "Yellow"].flatMap((c) => ["", "_Base"].map((s) => `TRG_CTF_${c}${s}`)),
    ...["Red", "Blue", "Green", "Yellow"].map((c) => `TRG_Flag_${c}`),
];

// The file's node array, each node's compressed components (a flag naming a global structure: THUG2's
// ncomp_* - THUGPRO's compiler makes them) merged in.
export function nodeArray(data: Buffer, label: string): [QbValue[], Map<number, string>] {
    const q = new qb.QbFile(data, label, true); // (THUG2 random tokens carry weights)
    let array: QbValue[] | undefined = q.globals.find(
        ([k, v]) => Array.isArray(v) && (q.names.get(k.value) ?? "").toLowerCase().endsWith("_nodearray"),
    )?.[1] as QbValue[] | undefined;
    if (array === undefined) {
        array = (q.globals.find(([, v]) => Array.isArray(v) && v.length && v[0] instanceof Struct)?.[1] ??
            []) as QbValue[];
    }
    const structs = new Map<number, Struct>();
    for (const [k, v] of q.globals) if (v instanceof Struct) structs.set(k.value, v);
    const out: QbValue[] = [];
    for (let node of array) {
        if (node instanceof Struct) {
            const entries: qb.Entry[] = [];
            for (const [key, value] of node.entries) {
                const included = key === null && value instanceof Name ? structs.get(value.value) : undefined;
                if (included !== undefined) entries.push(...included.entries);
                else entries.push([key, value]);
            }
            node = new Struct(entries);
        }
        out.push(node);
    }
    return [out, q.names];
}

// In-game position: THUG2 takes Pos as it is and negates z of the older Position.
export function position(node: Struct): readonly number[] | null {
    let v = node.get("Pos");
    if (v instanceof Vector && v.kind === "vector") return v.values;
    v = node.get("Position");
    if (v instanceof Vector && v.kind === "vector") return [v.values[0]!, v.values[1]!, -v.values[2]!];
    return null;
}

export function nameOf(node: Struct): number | null {
    const v = node.get("Name");
    return v instanceof Name ? v.value : null;
}

export const isName = (v: QbValue | undefined, text: string): boolean =>
    v instanceof Name && v.value === qb.checksum(text);

export const isCrown = (node: Struct): boolean => isName(node.get("Type"), "Crown");

export function isMpRestart(node: Struct): boolean {
    const types = node.get("restart_types");
    return isName(node.get("Class"), "Restart") && Array.isArray(types) && types.some((t) => isName(t, "Multiplayer"));
}

export type Placed = [number | null, readonly number[] | null];

export function sequence(array: readonly QbValue[], test: (n: Struct) => boolean): Placed[] {
    return array.filter((n): n is Struct => n instanceof Struct && test(n)).map((n) => [nameOf(n), position(n)]);
}

export const maxDiff = (a: readonly number[], b: readonly number[]): number =>
    Math.max(...[0, 1, 2].map((k) => Math.abs(a[k]! - b[k]!)));

// [verdict, differing count]
export function sameSequence(a: readonly Placed[], b: readonly Placed[]): [string, number] {
    if (a.length !== b.length) return [`count ${a.length} vs ${b.length}`, Math.max(a.length, b.length)];
    let bad = 0;
    a.forEach(([, pa], i) => {
        const pb = b[i]![1];
        if (pa === null || pb === null || maxDiff(pa, pb) > TOLERANCE) bad += 1;
    });
    return [bad ? `${bad} of ${a.length} differ` : "same", bad];
}

// JSON with two-space indents, lists of plain values on one line (the profile's face edits run to thousands).
export function compactJson(value: unknown, indent = ""): string {
    const inner = `${indent}  `;
    if (Array.isArray(value)) {
        if (!value.length) return "[]";
        const line = `[${value.map((x) => JSON.stringify(x)).join(", ")}]`;
        if (value.every((x) => x === null || typeof x !== "object") && line.length <= 100) return line;
        return `[\n${value.map((x) => inner + compactJson(x, inner)).join(",\n")}\n${indent}]`;
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (!entries.length) return "{}";
        return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compactJson(v, inner)}`).join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(value);
}
