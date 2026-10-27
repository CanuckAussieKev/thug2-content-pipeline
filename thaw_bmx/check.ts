// NOT ORIGINAL - THAW's BMX for THUG2, phase 4: a check of the ported scripts (convert.ts runs it on the compiled
// thaw_bmx.qb against the user's THUG2): every command a script runs - a name in command position - is THUG2's
// (a C function, a member function, a script), ours (a script or global of thaw_bmx.qb) or one of the DLL's bike
// members (OUR_MEMBERS, src/game/skater/thaw_bmx.cpp kMembers). THAW's scripts call many THAW-only commands; one left
// in by mistake would do nothing in THUG2 (a member) or stop the script (a script call to nothing).

import * as qb from "../level_port/qb.ts";
import { checksum } from "../level_port/qb.ts";
import { Thug2 } from "../level_port/script_port.ts";

// The DLL's bike members (src/game/skater/thaw_bmx.cpp kMembers; ride.test.ts checks the two lists agree).
export const OUR_MEMBERS: readonly string[] = [
    "SkaterOnBike",
    "SkaterOffBike",
    "IsSkaterOnBike",
    "BikeIsInOverGrind",
    "GetBikeManualAngle",
    "ResetBikeManualAngle",
    "BikeInManual",
    "BikeInXup",
    "BikeEnterXup",
    "BikeExitXup",
    "BikeInTireTap",
    "BikeEnterSkid",
    "BikeExitSkid",
    "bikeinskid",
    "BikeCanSkid",
    "BikeExitTireTap",
    "exitbikeendo",
    "EnterWheelieFromAir",
    "ThawBmxLoadAssets",
    "DisplayPitchGreaterThan",
    "LandedFromTireTap",
    "InTireTap",
    "PitchingForward",
    "PitchingBackward",
    "ShouldRunStallScript",
    "ClearStallScriptFlag",
    "ExitStallBoost",
    "OnStall",
];
// Ours that are C functions (thaw_bmx.cpp RegisterScriptFunctions; the parked bikes': thaw_bmx_parked.cpp).
export const OUR_CFUNCS: readonly string[] = [
    "ThawBmx_Available",
    "ThawBmx_HomeSpot",
    "ThawBmx_WalkToBike",
    "ThawBmx_BikeReachable",
];

// The scripts and globals a compiled qb defines, and each script's commands.
export function qbContents(data: Uint8Array): {
    scripts: Set<number>;
    globals: Set<number>;
    commands: Map<number, number[]>;
} {
    const toks = [...qb.tokens(data, true)].map(([, t, p]) => [t, p] as const);
    const scripts = new Set<number>();
    const globals = new Set<number>();
    const commands = new Map<number, number[]>();
    for (let k = 0; k < toks.length; k++) {
        const [t, p] = toks[k]!;
        const next = toks[k + 1];
        if (t === 0x23 && next?.[0] === 0x16) {
            const name = next[1].readUInt32LE(0);
            scripts.add(name);
            let end = k + 2;
            while (end < toks.length && toks[end]![0] !== 0x24) end += 1;
            commands.set(
                name,
                Thug2.commandsOf(toks.slice(k + 2, end)).map((u) => u.name),
            );
            k = end;
            continue;
        }
        if (t === 0x16 && next?.[0] === 0x07) globals.add(p.readUInt32LE(0));
    }
    return { scripts, globals, commands };
}

// The commands no one has: [script, command] (names as `names` has them, else hex).
export function unknownCommands(
    data: Uint8Array,
    thug2: Thug2,
    names: ReadonlyMap<number, string>,
): [string, string][] {
    const { scripts, globals, commands } = qbContents(data);
    const ours = new Set([...OUR_MEMBERS, ...OUR_CFUNCS].map(checksum));
    const out: [string, string][] = [];
    for (const [script, used] of commands) {
        for (const name of new Set(used)) {
            if (
                thug2.cfuncs.has(name) ||
                thug2.members.has(name) ||
                thug2.scripts.has(name) ||
                scripts.has(name) ||
                globals.has(name) ||
                ours.has(name)
            )
                continue;
            out.push([qb.nameText(script, names), qb.nameText(name, names)]);
        }
    }
    return out;
}
