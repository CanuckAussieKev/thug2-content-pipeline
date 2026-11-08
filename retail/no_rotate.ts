// NOT ORIGINAL - THAW's no_rotate locks for the retail export: THAW's Obj_LockToObject takes a bare `no_rotate` flag
// (the locked object keeps its own orientation and only follows the target's position - Santa Monica's ferris cars on
// their turning wheel). THUG2's lock has no such flag: the locked object always takes the target's orientation, so in
// the original game the cars would turn over with the wheel. (The THUG2 decompilation's own engine knows the flag:
// this is for the original game only.)
//
// The retail game's closest equivalent, done in the level's own scripts: the target's steady turn (its one
// `<target>:Obj_RotX|Y|Z speed=<degrees a second>`) becomes a script of ours, spawned in its place, that every frame
// sets the target's orientation from the time since it started (Obj_Rotate absolute=...) and locks each object again
// with the opposite turn (Obj_LockToObject ... Angles=...: the lock's orientation is the target's times that turn), so
// the two cancel - the objects go round with it, upright. Their first lock stays (without no_rotate), placing them
// at once. Only where it is exact: the target and the locked objects with no node angles (the turn starts from the
// identity) and the target turned by one Obj_Rot* line; anything else is left as it is and listed.

import { checksum } from "thug2-level-converter-core/level_port/qb.ts";
import { print } from "thug2-level-converter-core/lib/cli.ts";

// (the compiled flag: a name token, 0x16, and the checksum)
const FLAG = "no_rotate";

export interface Scripts {
    decompile(data: Uint8Array): string;
    compile(text: string): Buffer;
}

interface Lock {
    line: number;
    object: string;
    args: string; // the lock's parameters without no_rotate
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?`;
const LOCK = /^(\s*)(\w+):Obj_LockToObject\s+(.*?)\s*$/;
const DEGREES_TO_RADIANS = Math.PI / 180;

// Whether a compiled .qb has the flag at all (a name token with its checksum).
export function hasNoRotate(data: Uint8Array): boolean {
    const token = Buffer.alloc(5);
    token[0] = 0x16;
    token.writeUInt32LE(checksum(FLAG), 1);
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(token);
}

// The node angles of the node named `name` in the text's node array (null: no such node; (0, 0, 0) when it has
// none).
export function nodeAngles(lines: readonly string[], name: string): number[] | null {
    const nameRe = new RegExp(String.raw`^\s*Name=${name}\s*$`, "i");
    const at = lines.findIndex((l) => nameRe.test(l));
    if (at < 0) return null;
    let start = at;
    while (start > 0 && lines[start]!.trim() !== "{") start--;
    for (let i = start + 1; i < lines.length && lines[i]!.trim() !== "}"; i++) {
        const m = new RegExp(String.raw`^\s*Angles=\((${NUMBER}),\s*(${NUMBER}),\s*(${NUMBER})\)\s*$`, "i").exec(
            lines[i]!,
        );
        if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    return [0, 0, 0];
}

// The axes: the absolute angle's direction for Obj_RotX / Y / Z's turn (Obj_Rotate absolute's x and z go the other way
// round from Obj_RotX's and Obj_RotZ's, its y the same way as Obj_RotY's), and the lock's turn that cancels it (in
// radians, of that absolute angle).
const AXES = {
    X: { index: 0, absoluteSign: -1, lockSign: 1 },
    Y: { index: 1, absoluteSign: 1, lockSign: -1 },
    Z: { index: 2, absoluteSign: -1, lockSign: 1 },
} as const;

function vector(index: number, value: string): string {
    return `(${[0, 1, 2].map((i) => (i === index ? value : "0.0")).join(", ")})`;
}

function floatText(n: number): string {
    const s = String(Number(n.toPrecision(9)));
    return s.includes(".") || s.includes("e") ? s : `${s}.0`;
}

export interface Result {
    text: string;
    done: string[]; // the targets made to turn by our script
    left: string[]; // what couldn't be done (a retail difference)
}

// The text with the no_rotate locks made the retail way (`script`: the name for each target's script).
export function retailNoRotate(text: string, scriptName = (target: string) => `retail_turn_${target}`): Result {
    const lines = text.split("\n");
    const locks = new Map<string, Lock[]>();
    const flagRe = new RegExp(String.raw`(^|\s)${FLAG}(?=\s|$)`, "i");
    for (let i = 0; i < lines.length; i++) {
        const m = LOCK.exec(lines[i]!);
        if (!m || !flagRe.test(m[3]!)) continue;
        const target = /(?:^|\s)ObjectName=(\w+)/i.exec(m[3]!)?.[1];
        if (!target) continue;
        const args = m[3]!.replace(flagRe, "$1").replace(/\s+/g, " ").trim();
        const list = locks.get(target) ?? [];
        list.push({ line: i, object: m[2]!, args });
        locks.set(target, list);
    }
    const done: string[] = [];
    const left: string[] = [];
    const added: string[] = [];
    for (const [target, list] of locks) {
        const rotRe = new RegExp(String.raw`^(\s*)${target}:Obj_Rot([XYZ])\s+speed=(${NUMBER})\s*$`, "i");
        const turns = lines.map((l, i) => [i, rotRe.exec(l)] as const).filter(([, m]) => m);
        const zero = (name: string): boolean => {
            const a = nodeAngles(lines, name);
            return a?.every((v) => v === 0) === true;
        };
        const why =
            turns.length !== 1
                ? `${target} isn't turned by one Obj_RotX/Y/Z speed= line`
                : list.some((l) => /(?:^|\s)Angles=/i.test(l.args))
                  ? `a lock to ${target} has its own Angles`
                  : !zero(target)
                    ? `${target} has node angles`
                    : list.find((l) => !zero(l.object))
                      ? `${list.find((l) => !zero(l.object))!.object} has node angles (or no node)`
                      : null;
        if (why) {
            left.push(`${target}: ${why} - its locked objects turn with it in the original game`);
            continue;
        }
        const [turnLine, turn] = turns[0]!;
        const axis = AXES[turn![2]!.toUpperCase() as keyof typeof AXES];
        const speed = Number(turn![3]);
        const indent = turn![1]!;
        const name = scriptName(target);
        // (no_rotate out of the first locks: they place the objects; the script turns them back from then on)
        for (const l of list) lines[l.line] = `${LOCK.exec(lines[l.line]!)![1]}${l.object}:Obj_LockToObject ${l.args} `;
        lines[turnLine] = `${indent}spawnscript ${name} `;
        // the angle from the time: degrees a millisecond; the start moved on by whole turns every ten of them
        const perMs = (axis.absoluteSign * speed) / 1000;
        const period = speed === 0 ? 0 : Math.round(3600000 / Math.abs(speed));
        const exact = period > 0 && Math.abs((period * Math.abs(speed)) / 1000 - 3600) < 1e-6;
        const body = [
            `script ${name} {`,
            "    GetStartTime ",
            "    retail_turn_start = <StartTime> ",
            "    while {",
            "        GetElapsedTime StartTime=<retail_turn_start> ",
            ...(exact
                ? [
                      `        if (<ElapsedTime> > ${period}) {`,
                      `            retail_turn_start = (<retail_turn_start> + ${period}) `,
                      "            GetElapsedTime StartTime=<retail_turn_start> ",
                      "        } ",
                  ]
                : []),
            `        retail_turn_degrees = (<ElapsedTime> * ${floatText(perMs)}) `,
            `        if ISAlive Name=${target} {`,
            `            ${target}:Obj_Rotate absolute=(${vector(axis.index, "1.0")} * <retail_turn_degrees>) time=0 `,
            "        } ",
            `        retail_turn_back = (${vector(axis.index, floatText(axis.lockSign * DEGREES_TO_RADIANS))} * <retail_turn_degrees>) `,
            ...list.flatMap((l) => [
                `        if ISAlive Name=${l.object} {`,
                `            ${l.object}:Obj_LockToObject ${l.args} Angles=<retail_turn_back> `,
                "        } ",
            ]),
            "        wait 1 frame ",
            "    } ",
            "} ",
        ];
        added.push(...body);
        done.push(`${target} (${list.length} object(s))`);
    }
    if (added.length) {
        // (before NeverScript's checksum list, the file's last line)
        let at = lines.findIndex((l) => l.includes("__register_checksums__"));
        if (at < 0) {
            at = lines.length;
            while (at > 0 && lines[at - 1]!.trim() === "") at--;
        }
        lines.splice(at, 0, ...added);
    }
    return { text: lines.join("\n"), done, left };
}

// A level's .qb for the retail game: the no_rotate locks made the retail way (the file as it is when it has none).
export function retailLevelQb(name: string, data: Buffer, ns: Scripts): Buffer {
    if (!hasNoRotate(data)) return data;
    const result = retailNoRotate(ns.decompile(data));
    for (const line of result.left) print(`${name}: no_rotate: ${line}`);
    if (!result.done.length) return data;
    print(`${name}: no_rotate locks made the original game's way (turned back by a script): ${result.done.join(", ")}`);
    return ns.compile(result.text);
}
