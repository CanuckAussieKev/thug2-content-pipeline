// NOT ORIGINAL - THAW's node flags (moved from thaw_levels.ts with the converters' split: Project 8's converter,
// thp8/thp8_levels.ts, reads its flags with the same scripts' form).

import { FormatError } from "../level_port/binio.ts";
import { checksum, Name, type QbValue, Struct } from "../level_port/qb.ts";
import * as thaw from "./thaw.ts";

// THAW's story areas make much of their geometry, rails and objects from node flags: a node with
// `CreatedFromVariable=NODEFLAG_...` (and no CreatedAtStart) is made when the level loads if its flag is on. The flags
// are set by scripts: a story game runs chapter_info.qb's game_progress_set_initial_story_mode_nodeflags (and its
// progress then changes them), every other game - free skate, classic, network - its
// game_progress_set_non_story_mode_nodeflags (which runs the initial one first, then sets its own list: every
// Skate Ranch piece built and its stand-in, `_DEF`, off; NODEFLAG_GAMEMODE_MULTIPLAYER on...). THAW.exe names both
// scripts (their checksums are in its code), and no qb file calls the non-story one. THUG2 has no node flags: a node
// left without CreatedAtStart is never made - Skate Ranch lost 2,208 nodes (the built pieces' ground, ramps and rails:
// holes onto the sky under the level), and HO / BH / DT / EL / SM / LV / OI 110-510 each.
const NODEFLAG_CHANGE = "ChangeNodeFlag";

// The flags a node flag script sets, in order ({flag value} entries of its Flags array; the scripts it calls run where
// they're called: a name token at a line's start that is a script of the same file).
export function nodeFlagScript(
    scripts: ReadonlyMap<number, Buffer>,
    script: number,
    label = "qb",
    out: Map<number, boolean> = new Map(),
    seen: Set<number> = new Set(),
): Map<number, boolean> {
    const body = scripts.get(script);
    if (body === undefined) throw new FormatError(`${label}: no script ${script.toString(16).padStart(8, "0")}`);
    seen.add(script);
    const t = [...thaw.tokens(body)];
    let lineStart = true;
    let own = 0;
    for (let i = 0; i < t.length; i++) {
        const [, kind, p] = t[i]!;
        if (kind === 0x16 && lineStart) {
            const callee = p.readUInt32LE(0);
            if (scripts.has(callee) && !seen.has(callee)) nodeFlagScript(scripts, callee, label, out, seen);
        }
        if (kind === 0x03 && t[i + 1]?.[1] === 0x16 && t[i + 2]?.[1] === 0x17 && t[i + 3]?.[1] === 0x04) {
            out.set(t[i + 1]![2].readUInt32LE(0), t[i + 2]![2].readInt32LE(0) !== 0);
            own++;
        }
        lineStart = kind === 0x01 || kind === 0x02;
    }
    // (the Flags array is applied by a ChangeNodeFlag loop - anything else would be a script this reading doesn't know)
    if (own && !t.some(([, kind, p]) => kind === 0x16 && p.readUInt32LE(0) === checksum(NODEFLAG_CHANGE))) {
        throw new FormatError(
            `${label}: node flag script ${script.toString(16).padStart(8, "0")} sets its flags some other way`,
        );
    }
    return out;
}

// The nodes made from a node flag that is on get CreatedAtStart (THUG2's form of "made when the level loads"); the
// ones whose flag is off (or never set: off, as THAW creates them) stay as they were - not made. Returns how many
// were turned on.
export function applyNodeFlags(array: readonly QbValue[], flags: ReadonlyMap<number, boolean>): number {
    let made = 0;
    for (const node of array) {
        if (!(node instanceof Struct)) continue;
        const flag = node.get("CreatedFromVariable");
        if (!(flag instanceof Name) || !flags.get(flag.value) || node.hasFlag("CreatedAtStart")) continue;
        node.entries.push([null, new Name(checksum("CreatedAtStart"))]);
        made++;
    }
    return made;
}
