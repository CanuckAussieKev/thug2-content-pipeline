// NOT ORIGINAL - THAW's BMX for THUG2, phase 4: THAW's own bike scripts -
// scripts\game\skater\bike_scripts.qb, bike_grindscripts.qb and bike_sfx.qb - ported to THUG2's commands under THAW's
// names (they replace phase 3's stand-ins: bike_enter_manual, BikeGrindTrickList ...). Two parts:
//
//   bikeGlobals   THAW's data, read from the user's THAW at convert time (qb.pak) and written as NeverScript: the trick
//                 lists (Bike_AirTricks, Bike_ManualTricks, Bike_NoseManualTricks - their triggers moved off THAW's
//                 right stick, see TRIGGERS), the exception tables, BikeGrindTrickList, bike_Wallplant_Trick, the wobble
//                 parameters, THAW's TERRAIN_BIKE_DEFAULT_* sound tables (as thaw_bmx_terrain_*: the DLL's bike sounds)
//                 and the grind tricks' scripts (Trick_Bike_*, data-like: a name, a score, three animations).
//   bikeScripts   the scripts themselves, ported to THUG2 (made at convert time from the user's THAW: our changes to
//                 THAW's scripts are stored as edits, bike_scripts.edits - see "the scripts" below; no THAW text is in
//                 the repository) - every THAW command that
//                 THUG2 has kept, the rest said in a comment where it was. THAW plays its animations through animation
//                 trees (Skater_Playanim -> Anim_Command DegenerateBlend_AddBranch on the rider and, Skater_Anim_Command,
//                 on the bike); here the shim thaw_bmx_playanim plays THUG2's PlayAnim on the rider and Obj_PlayAnim on
//                 the bike (when it has the animation), the partial branches (the barspin) as anim subsets. The manual's
//                 pose follows the manual angle in the DLL (src/game/skater/thaw_bmx_tricks.cpp ManualPose).
//
// Controls (THUG2's script buttons: X / Circle / Square / Triangle = the player's Ollie / Grab / Flip / Grind keys): THAW
// does its bike's flip tricks on the right stick (BikePress rightup ...), which THUG2's pad hasn't - here they are
// direction + Flip, like a skater's flip tricks; its grabs (THAW: square, down then square) direction + Grab.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FormatError } from "../level_port/binio.ts";
import * as qb from "../level_port/qb.ts";
import { Name, type QbValue, Struct } from "../level_port/qb.ts";
import { helpFromHeader } from "../lib/cli.ts";
import {
    applyOwnEdits,
    type Edits,
    EditsError,
    formatEdits,
    ownEdits,
    parseEdits,
    UnitIndex,
    type UnitLookup,
} from "../lib/edits.ts";
import { resolveInstall } from "../lib/install.ts";
import { isMain, print, runMain } from "../lib/py.ts";
import * as thaw from "../thaw_levels/thaw.ts";
import { plain, scriptToks } from "../thaw_levels/thaw_scripts.ts";
import { renderBody } from "./dump_scripts.ts";
import { renderNs } from "./thaw_ns.ts";

// The bike (convert.ts DETAILS' Name) and THAW's name for it.
export const BIKE = "ThawBmx";

// THAW's globals taken over as they are (bike_scripts.qb, bike_grindscripts.qb, physics / walltricks.qb), and the
// exception-table entries dropped - their scripts are THAW's network ones, which THUG2 hasn't.
export const COPIED_GLOBALS: readonly string[] = [
    "BikeWallRideExceptionTable",
    "BikeManualExceptionTable",
    "bike_backwards_ExceptionTable",
    "bike_manual_wobble_params",
    "bike_manual_ExceptionTable",
    "Bike_Start_ExceptionTable",
    "Bike_OnGroundExceptionTable",
    "Bike_InAirExceptionTable",
    "BikeAirAnimParams",
    "bike_SkitchExceptionTable",
    "BikeGrindTrickList",
    "bike_grind_ExceptionTable",
    "bike_Wallplant_Trick",
];
export const DROPPED_HANDLERS: readonly string[] = ["MadeOtherSkaterBail_Called", "SkaterCollideBail"];
// THAW's bike sound tables (its terrain.qb) and our names (src/game/skater/thaw_bmx_tricks.cpp kSoundTables).
export const SOUND_TABLES: readonly (readonly [string, string])[] = [
    ["TERRAIN_BIKE_DEFAULT_LAND", "thaw_bmx_terrain_land"],
    ["TERRAIN_BIKE_DEFAULT_GRINDLAND", "thaw_bmx_terrain_grindland"],
    ["TERRAIN_BIKE_DEFAULT_OLLIE", "thaw_bmx_terrain_ollie"],
    ["TERRAIN_BIKE_DEFAULT_GRINDJUMP", "thaw_bmx_terrain_grindjump"],
    ["TERRAIN_BIKE_DEFAULT_BONK", "thaw_bmx_terrain_bonk"],
    ["TERRAIN_BIKE_DEFAULT_ROLL", "thaw_bmx_terrain_roll"],
    ["TERRAIN_BIKE_DEFAULT_GRIND", "thaw_bmx_terrain_grind"],
];
// The trick lists whose triggers move (TRIGGERS).
export const TRICK_LISTS: readonly string[] = ["Bike_AirTricks", "Bike_ManualTricks", "Bike_NoseManualTricks"];
// The grind tricks' scripts (bike_grindscripts.qb).
export const GRIND_SCRIPTS = /^Trick_Bike_/;
// THAW's sounds the scripts and tables play (convert.ts converts these from THAW's global_sfx pak).
export const SOUNDS: readonly string[] = [
    "Bmx_Brake_01",
    "Bmx_Skid_01",
    "Bmx_Fall_02",
    "Bmx_pedal_on",
    "Bmx_pedal_loop",
    "Bmx_Freewheel",
    "bmx_conc_freewheel",
    "Bmx_default_ollie",
    "Bmx_land_default",
    "Bmx_Default_bonk",
    "Bmx_Metal_Grindloop",
];
// THUG2's own sounds THAW's bike tables / scripts use (THUG2 has them: Terrains\GrindMetalOff02 / On02,
// Skater\SK6_BoardRollIn01_11) - not converted.
export const THUG2_SOUNDS: readonly string[] = ["GrindMetalOff02", "GrindMetalOn02", "SK6_BoardRollIn01_11"];

// --- THAW's triggers on THUG2's pad ----------------------------------------------------------------------------------

// THAW's BikePress directions (its right stick; RightUpRight... are its diagonals) and THUG2's d-pad / stick names.
const STICK: Readonly<Record<string, string>> = {
    rightup: "Up",
    rightdown: "Down",
    rightleft: "Left",
    rightright: "Right",
};
// THUG2's air tricks' time for a button + a direction (airtricks.qb's AirTrickLogic triggers).
export const AIR_TRICK_TIME = 500;
// What a THAW trigger becomes (one THAW entry may become several - the tabletop on Grab with any side):
//   BikePress <right stick dir> n        -> {AirTrickLogic Square <dir> 500} (Flip + direction; THAW's n, 50, is a stick's flick -\n//                                            THUG2's skater has 500 for its button + direction)
//   InOrder leftdown square n (superman)  -> {AirTrickLogic Circle Down n}    (Grab + down)
//   Press square n (tabletop)             -> {AirTrickLogic Circle Left / Right / Up n}  (Grab + a side; up: THAW's
//                                            default right side)
//   anything else (Press circle - the x-up -, Press R2 - the pivot)  as THAW has it.
// The tricks' `buttons=[...]` (the buttons THAW's held checks look at) become `button=` THUG2's one button.
export function triggers(trigger: QbValue, names: ReadonlyMap<number, string>): { trigger: string; button?: string }[] {
    if (!(trigger instanceof Struct)) throw new Error("a trick's Trigger isn't a structure");
    const parts = trigger.entries.map(([, v]) => (v instanceof Name ? qb.nameText(v.value, names) : v));
    const kind = typeof parts[0] === "string" ? parts[0].toLowerCase() : "";
    const word = (k: number): string => (typeof parts[k] === "string" ? (parts[k] as string).toLowerCase() : "");
    const time = parts[parts.length - 1];
    if (typeof time !== "number") throw new Error(`a trick's Trigger without a time: ${qb.toNs(trigger, names)}`);
    if (kind === "bikepress") {
        const dir = STICK[word(1)];
        if (!dir) throw new Error(`BikePress ${word(1)}: not a right-stick direction`);
        return [{ trigger: `{AirTrickLogic, Square, ${dir}, ${AIR_TRICK_TIME}}`, button: "Square" }];
    }
    if (kind === "inorder" && word(1) === "leftdown" && word(2) === "square")
        return [{ trigger: `{AirTrickLogic, Circle, Down, ${time}}`, button: "Circle" }];
    if (kind === "press" && word(1) === "square")
        return ["Left", "Right", "Up"].map((dir) => ({
            trigger: `{AirTrickLogic, Circle, ${dir}, ${time}}`,
            button: "Circle",
        }));
    return [{ trigger: qb.toNs(trigger, names) }];
}

// A trick list with its triggers moved (TRIGGERS) - every other key (scr, params with THAW's names and scores) as
// THAW has it.
export function trickList(list: QbValue, names: Map<number, string>): string {
    if (!Array.isArray(list)) throw new Error("a trick list isn't an array");
    const out: string[] = [];
    const triggerKey = qb.checksum("Trigger");
    const paramsKey = qb.checksum("params");
    const buttonsKey = qb.checksum("buttons");
    const buttonKey = qb.checksum("button");
    for (const text of ["button", "Square", "Circle"])
        if (!names.has(qb.checksum(text))) names.set(qb.checksum(text), text);
    for (const entry of list) {
        if (!(entry instanceof Struct)) throw new Error("a trick list's entry isn't a structure");
        const trigger = entry.entries.find(([k]) => k?.value === triggerKey)?.[1];
        if (trigger === undefined) throw new Error("a trick without a Trigger");
        for (const moved of triggers(trigger, names)) {
            const items: [Name | null, QbValue][] = [];
            for (const [k, v] of entry.entries) {
                if (k?.value === triggerKey) continue;
                if (k?.value === paramsKey && v instanceof Struct && moved.button !== undefined) {
                    const params = v.entries.filter(([pk]) => pk?.value !== buttonsKey && pk?.value !== buttonKey);
                    params.push([new Name(buttonKey), new Name(qb.checksum(moved.button))]);
                    items.push([k, new Struct(params)]);
                } else {
                    items.push([k, v]);
                }
            }
            const rest = qb
                .toNs(new Struct(items), names)
                .replace(/^\{\n?/, "")
                .replace(/\n?\}$/, "");
            out.push(`    {\n        Trigger=${moved.trigger}\n${rest.replace(/^/gm, "    ")}\n    }`);
        }
    }
    return `[\n${out.join("\n")}\n]`;
}

// An exception table without the entries whose scripts THUG2 hasn't (DROPPED_HANDLERS).
function withoutNetHandlers(table: QbValue): QbValue {
    if (!Array.isArray(table)) return table;
    const scr = qb.checksum("scr");
    const dropped = new Set(DROPPED_HANDLERS.map(qb.checksum));
    return table.filter((e) => {
        if (!(e instanceof Struct)) return true;
        const v = e.entries.find(([k]) => k?.value === scr)?.[1];
        return !(v instanceof Name && dropped.has(v.value));
    });
}

// THAW's local strings as NeverScript's %"..." (qb.toNs and dump_scripts write them '...', which ns.exe doesn't read).
export const localStrings = (text: string): string => text.replace(/(=\s*)'([^'\n]*)'/g, '$1%"$2"');

// What bikeGlobals reads of THAW: its globals by name, and the grind trick scripts' bodies (with their byte order).
export interface ThawBike {
    get(name: string): QbValue | undefined;
    scripts: ReadonlyMap<string, { body: Buffer; order: "<" | ">" }>;
}

// THAW's qb files' globals and scripts (qb.pak.wpc) gathered for bikeGlobals.
export function readThawBike(qbPak: string, names: Map<number, string>): ThawBike {
    const globals = new Map<number, QbValue>();
    const scripts = new Map<string, { body: Buffer; order: "<" | ">" }>();
    for (const [e, d] of thaw.pakFiles(qbPak)) {
        if (e.extension !== ".qb" || !e.path) continue;
        const items = new thaw.QbItems(d, e.path, names);
        for (const [key, value] of items.globals) if (!globals.has(key.value)) globals.set(key.value, value);
        for (const [key, body] of items.scriptData) {
            const name = qb.nameText(key, names);
            if (GRIND_SCRIPTS.test(name)) scripts.set(name, { body, order: items.order });
        }
    }
    return { get: (name) => globals.get(qb.checksum(name)), scripts };
}

// THAW's thrown bike (BailBikeComponents: the bike as a rigid body, which its BailBoardControl / CreateBailBoard
// spawns on a bail while the ridden one hides) on THUG2's: our skeleton, model and animations (as the parked bike's
// components - THAW gives it its human skeleton and no animations), THAW's rigid body as it is but its SoundType
// (SkaterBikeWhenBail, a RigidBodySounds entry THUG2 hasn't - a missing one would be read through null; the bail's
// fall sound is bike_bail's Play_BikeSFX_Bike_Fall) and no shadow (THAW's volume shadow model isn't converted).
export const BAIL_BIKE_COMPONENTS = "thaw_bmx_bail_bike_components";
export const BIKE_SKELETON = "THAW_SI_BMX";
export const BIKE_MODEL = "specialitems/thaw_bmx/si_bmx.skin";
export function bailBikeComponents(thawComponents: QbValue, names: Map<number, string>): string {
    if (!Array.isArray(thawComponents)) throw new Error("THAW's BailBikeComponents isn't an array");
    const component = qb.checksum("component");
    const soundType = qb.checksum("SoundType");
    const rigid = thawComponents.find(
        (c) =>
            c instanceof Struct &&
            c.entries.some(
                ([k, v]) => k?.value === component && v instanceof Name && v.value === qb.checksum("rigidbody"),
            ),
    );
    if (!(rigid instanceof Struct)) throw new Error("THAW's BailBikeComponents: no rigidbody");
    for (const text of ["component", "rigidbody"]) names.set(qb.checksum(text), text);
    const body = new Struct(rigid.entries.filter(([k]) => k?.value !== soundType));
    return (
        `[\n    {component=motion}\n    {component=suspend}\n    {component=skeleton skeletonName=${BIKE_SKELETON}}\n` +
        `    {component=model UseModelLights model="${BIKE_MODEL}"}\n` +
        `    {component=animblender AnimName=animload_thaw_bmx_bike skeletonName=${BIKE_SKELETON}}\n` +
        `    ${qb.toNs(body, names, 1).trimStart()}\n    {component=modellightupdate}\n]`
    );
}

// The skitch (THAW's bike_skitch, which no bike table of THAW's starts): Skitched in the on-ground table.
export const SKITCH_TABLE = "Bike_OnGroundExceptionTable";

// THAW's sound tables name their sounds (sound=Bmx_land_default); THUG2's terrain tables give the file under sounds\
// (sound="Terrains\\LandConc") - ours under sounds\thaw_bmx (SOUND_FOLDER), THUG2's own in Terrains.
export function soundPaths(table: QbValue, names: ReadonlyMap<number, string>): QbValue {
    if (!Array.isArray(table)) throw new Error("a sound table isn't an array");
    const sound = qb.checksum("sound");
    const ours = new Map(SOUNDS.map((s) => [qb.checksum(s), `thaw_bmx\\${s}`]));
    const thug2 = new Map(THUG2_SOUNDS.map((s) => [qb.checksum(s), `Terrains\\${s}`]));
    return table.map((entry) => {
        if (!(entry instanceof Struct)) return entry;
        return new Struct(
            entry.entries.map(([k, v]) => {
                if (k?.value !== sound || !(v instanceof Name)) return [k, v];
                const file = ours.get(v.value) ?? thug2.get(v.value);
                if (file === undefined)
                    throw new Error(`THAW's bike sound ${qb.nameText(v.value, names)} isn't converted`);
                return [k, file];
            }),
        );
    });
}
// THAW's globals and grind trick scripts (see the file header) as NeverScript, from THAW's qb items.
export function bikeGlobals(thawBike: ThawBike, names: Map<number, string>): string {
    const need = (name: string): QbValue => {
        const value = thawBike.get(name);
        if (value === undefined) throw new Error(`THAW: no ${name}`);
        return value;
    };
    for (const text of ["Exception", "ex", "scr", "Skitched", "bike_skitch"]) names.set(qb.checksum(text), text);
    const lines: string[] = [];
    for (const name of COPIED_GLOBALS) {
        let value = withoutNetHandlers(need(name));
        if (name === SKITCH_TABLE && Array.isArray(value)) {
            const n = (text: string): Name => new Name(qb.checksum(text));
            value = [
                ...value,
                new Struct([
                    [null, n("Exception")],
                    [n("ex"), n("Skitched")],
                    [n("scr"), n("bike_skitch")],
                ]),
            ];
        }
        lines.push(`${name} = ${qb.toNs(value, names)}`);
    }
    for (const name of TRICK_LISTS) lines.push(`${name} = ${trickList(need(name), names)}`);
    lines.push(`${BAIL_BIKE_COMPONENTS} = ${bailBikeComponents(need("BailBikeComponents"), names)}`);
    for (const [theirs, ours] of SOUND_TABLES)
        lines.push(`${ours} = ${qb.toNs(soundPaths(need(theirs), names), names)}`);
    const grinds = [...thawBike.scripts.keys()].filter((n) => GRIND_SCRIPTS.test(n)).sort();
    if (grinds.length !== 10) throw new Error(`THAW: ${grinds.length} Trick_Bike_ grind scripts, not 10`);
    for (const name of grinds) {
        const { body, order } = thawBike.scripts.get(name)!;
        const toks = scriptToks(body, names, name, order);
        lines.push(`script ${name} {\n${localStrings(renderBody(toks, names))}\n}`);
    }
    return localStrings(`${lines.join("\n")}\n`);
}

// --- the scripts -----------------------------------------------------------------------------------------------------

// THAW's bike scripts (bike_sfx.qb, bike_scripts.qb, bike_grindscripts.qb) in THUG2's commands - made from the user's
// THAW at convert time: bike_scripts.ns holds our own scripts and, for each of THAW's we port, a line
// "//@unit <name>"; bike_scripts.edits holds the port's changes to each (tools/pipeline/lib/edits.ts: line operations
// on THAW's script as thaw_ns.ts writes it - THUG2's commands, the shims below, comments naming what THAW had where
// it differs). No THAW text is stored. To change a ported script: `dump` the whole text, edit it, `extract`.
//
//   node tools/pipeline/thaw_bmx/bike_scripts.ts dump [--thaw C:\Games\THAW] --out <file.ns>
//   node tools/pipeline/thaw_bmx/bike_scripts.ts extract [--thaw C:\Games\THAW] --from <file.ns>
//       (re)writes bike_scripts.ns and bike_scripts.edits from the whole text (and checks they give it back)
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OWN = path.join(HERE, "bike_scripts.ns");
export const EDITS = path.join(HERE, "bike_scripts.edits");

// A checksum as edits' unit key (lib/edits.ts keyOf: its bytes in file order).
function checksumKey(value: number): string {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value >>> 0);
    return `#${bytes.toString("hex")}`;
}

// THAW's qb files' scripts and globals as NeverScript (scripts: thaw_ns.ts; globals: qb.toNs), by the file's path in
// qb.pak (without .wpc) and name - what the port's edits start from. The names are THAW's own (dbg.pak), read here,
// so the text doesn't depend on what the convert added to its names.
export class ThawScripts implements UnitLookup {
    private readonly names: Map<number, string>;
    private readonly files = new Map<string, thaw.QbItems>();
    private readonly cache = new Map<string, string | null>();

    constructor(qbPak: string, thawRoot: string) {
        this.names = thaw.loadNames(thawRoot);
        for (const [e, d] of thaw.pakFiles(qbPak)) {
            if (e.extension !== ".qb" || !e.path) continue;
            try {
                this.files.set(e.path.replace(/\.wpc$/i, "").toLowerCase(), new thaw.QbItems(d, e.path, this.names));
            } catch {
                // (a file the reader can't take: not a source)
            }
        }
    }

    unit(file: string, key: string): string | undefined {
        const id = `${file.toLowerCase()}\n${key}`;
        let text = this.cache.get(id);
        if (text === undefined) {
            text = this.render(file.toLowerCase(), key);
            this.cache.set(id, text);
        }
        return text ?? undefined;
    }

    private render(file: string, key: string): string | null {
        const items = this.files.get(file);
        if (!items) return null;
        for (const [name, body] of items.scriptData) {
            if (checksumKey(name) !== key) continue;
            const n = qb.nameText(name, this.names);
            try {
                return `script ${n} {\n${renderNs(scriptToks(body, this.names, n, items.order), this.names).join("\n")}\n}`;
            } catch {
                return null;
            }
        }
        for (const [name, value] of items.globals) {
            if (checksumKey(name.value) !== key) continue;
            try {
                return `${qb.nameText(name.value, this.names)} = ${qb.toNs(plain(value), this.names)}`;
            } catch {
                return null;
            }
        }
        return null;
    }

    // every unit: [file, key, text]
    *all(): Generator<readonly [string, string, string]> {
        for (const [file, items] of this.files) {
            const keys = [...items.scriptData.keys(), ...items.globals.map(([name]) => name.value)];
            for (const name of keys) {
                const key = checksumKey(name);
                const text = this.unit(file, key);
                if (text !== undefined) yield [file, key, text];
            }
        }
    }
}

function readLatin1(file: string): string {
    return fs.readFileSync(file).toString("latin1").replace(/\r\n?/g, "\n");
}

// The port of THAW's bike scripts, from the user's THAW (see above).
export function bikeScripts(thawScripts: UnitLookup): string {
    try {
        return applyOwnEdits(
            readLatin1(OWN),
            parseEdits(readLatin1(EDITS), "bike_scripts.edits"),
            thawScripts,
            "thaw_bmx bike_scripts",
        );
    } catch (err) {
        if (err instanceof EditsError) throw new FormatError(`THAW's bike scripts: ${err.message}`);
        throw err;
    }
}

// bike_scripts.ns and .edits from the whole text: a script made from THAW's of the same name when that stores less
// than 90% of its text, from any other of THAW's when less than half.
export function extractBikeScripts(text: string, thawScripts: ThawScripts): [string, Edits | null] {
    const index = new UnitIndex(thawScripts, thawScripts.all());
    return ownEdits(
        text,
        index,
        thawScripts,
        "thaw_bmx bike_scripts",
        "# The ported THAW bike scripts' changes to THAW's own (tools/pipeline/lib/edits.ts; bike_scripts.ts)",
        0.5,
        0.9,
    );
}

function thawFiles(thawDir: string): [string, string] {
    const root = resolveInstall(thawDir, "thaw");
    const qbPak = path.join(root, "data", "pak", "qb.pak.wpc");
    if (!fs.existsSync(qbPak)) throw new FormatError(`THAW: ${qbPak} not found`);
    return [qbPak, root];
}

function main(argv: string[]): number {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            thaw: { type: "string", default: "C:\\Games\\THAW" },
            out: { type: "string" },
            from: { type: "string" },
        },
    });
    const [qbPak, root] = thawFiles(values.thaw!);
    const scripts = new ThawScripts(qbPak, root);
    if (positionals[0] === "dump" && values.out) {
        fs.writeFileSync(values.out, Buffer.from(bikeScripts(scripts), "latin1"));
        print(`wrote ${values.out}`);
        return 0;
    }
    if (positionals[0] === "extract" && values.from) {
        const [own, edits] = extractBikeScripts(readLatin1(values.from), scripts);
        fs.writeFileSync(OWN, Buffer.from(own, "latin1"));
        fs.writeFileSync(EDITS, Buffer.from(edits ? formatEdits(edits) : "# (no THAW scripts ported)\n", "latin1"));
        print(`wrote ${OWN} and ${EDITS}: ${edits?.blocks.length ?? 0} of THAW's scripts as edits`);
        return 0;
    }
    process.stderr.write("usage: bike_scripts.ts dump --out <file.ns> | extract --from <file.ns> [--thaw <THAW>]\n");
    return 2;
}

if (isMain(import.meta.url)) helpFromHeader(import.meta.url);
if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));
