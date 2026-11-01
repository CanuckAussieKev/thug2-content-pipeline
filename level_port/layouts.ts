// NOT ORIGINAL - the level editor's saved layouts (<game>\thug2-decomp-layouts\<scene checksum>.txt,
// src/game/front/level_editor_layout.cpp) moved to a renamed or moved level: migrateText (moved from
// thaw_levels/migrate_layouts.ts with the converters' split: the THPS4 and THUG1 converters' migrate_layouts use it).

import { formatG, hex8, pyIntHex, pyParseFloat, pyParseInt, pySplit, pySplitlines } from "../lib/py.ts";

// As the level editor's QuarterTurn (level_editor_scenery.cpp).
export function quarterTurn(v: readonly number[], quarters: number): readonly number[] {
    const [x, y, z] = v as [number, number, number];
    const q = quarters & 3;
    if (q === 1) return [z, y, -x];
    if (q === 2) return [-x, y, -z];
    if (q === 3) return [-z, y, x];
    return v;
}

const number = (v: number): string => formatG(v, 9);

// str.partition(sep)
function partition(text: string, sep: string): [string, string, string] {
    const at = text.indexOf(sep);
    return at < 0 ? [text, "", ""] : [text.slice(0, at), sep, text.slice(at + sep.length)];
}

// The layout's text with its scene and positions changed. Returns [text, records moved].
export function migrateText(
    text: string,
    oldScene: number,
    newScene: number,
    d: readonly number[],
    newName: string | null = null,
): [string, number] {
    const out: string[] = [];
    let moved = 0;
    for (const line of pySplitlines(text, true)) {
        let [body, hash, comment] = partition(line, "#");
        const ending = line.endsWith("\n") ? "\n" : "";
        const words = pySplit(body);
        if (!words.length) {
            out.push(line);
            continue;
        }
        const kind = words[0]!;
        if (kind === "scene") {
            if (pyIntHex(words[1]!) !== oldScene) throw new RangeError(`scene ${words[1]}, not ${hex8(oldScene)}`);
            words[1] = hex8(newScene);
            if (newName && hash) comment = ` ${newName}`;
        } else if (kind === "sector" || kind === "rail" || kind === "clone") {
            const q = pyParseInt(words[2]!);
            const offset = words.slice(3, 6).map(pyParseFloat);
            const turned = quarterTurn(d, q);
            words.splice(3, 3, ...[0, 1, 2].map((k) => number(offset[k]! + d[k]! - turned[k]!)));
            moved += 1;
        } else if (kind === "object" || kind === "copy") {
            const at = kind === "object" ? 2 : 3;
            words.splice(at, 3, ...[0, 1, 2].map((k) => number(pyParseFloat(words[at + k]!) + d[k]!)));
            moved += 1;
        }
        let rebuilt = words.join(" ");
        if (hash) rebuilt += `  #${comment.replace(/[\r\n]+$/, "")}`;
        out.push(rebuilt + ending);
    }
    return [out.join(""), moved];
}
