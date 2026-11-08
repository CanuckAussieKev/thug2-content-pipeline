// NOT ORIGINAL - the retail export: converted levels (the staging folders the level converters write, as
// make_menu_level installs them into this project's data overlay) installed into a THUG2 install's own data, so the
// original game - not only this project's engine - plays them:
//
//   node tools/pipeline/retail/retail_export.ts install   --retail <THUG2 folder> [--levels a,b|thps2|all] [--from F]
//   node tools/pipeline/retail/retail_export.ts uninstall --retail <THUG2 folder> [--levels a,b]   (default: all)
//   node tools/pipeline/retail/retail_export.ts status    --retail <THUG2 folder>
//   node tools/pipeline/retail/retail_export.ts check     --retail <THUG2 folder> [--levels ...]   (the budget alone)
//   (--from: the folder holding the converters' thug2-decomp-* staging folders, default the --retail folder;
//    --raised-limits: with the THUG2 decompilation's retail-limits DLL (limits_dll.ts): install puts it beside
//    THUG2.exe as dinput8.dll (from --limits-dll <file>, else retail_limits\dinput8.dll beside this pipeline's folder,
//    as the level editor's tools folder has it) and levels are checked against its raised limits
//    (retail_budget.RAISED_LIMITS); an install without it takes ours out again, as uninstalling every level does. A limits
//    DLL the player put there himself counts as raised limits. --pre: the level archives too; --ns <ns.exe>;
//    --thps2 ... --thp8 <install>: the games' own loading pictures, as make_menu_level's; --ignore-budget: levels too
//    big are installed anyway - for measuring them)
//
// What it writes into the install (each file listed, with its hash, in <THUG2>\thug2-retail-export\state.json, and
// taken out again by uninstall unless it changed since):
//   Data\levels\<level>\...       the level's files (scene, textures, collision, node array, its sky's folder too),
//                                 where THUG2's own levels are; with no archive keys in its level structure the game
//                                 loads them as loose files (it finds a file in a loaded archive first, then in Data\).
//   Data\pre\<level>scn.prx, <level>col.prx, <level>_scripts.prx  only with --pre: the same files as THUG2's own
//                                 levels' archives, named by the level structure's scnpre= / colpre= / pre=. The game
//                                 loads them (scnpre= always, the others because its start-up sets
//                                 UsePreFilesForLevelLoading) - and a scene archive is held in memory whole while its
//                                 files are unpacked beside it: measured, THPS3's Rio runs out of the 64 MB main block
//                                 that way and loads with half of it free from loose files. Hence loose by default.
//   Data\models, anims, skeletons\...  what a converter brings along for its levels (shared by its levels).
//   Data\images\loadscrn_<game>_<level>.img.xbx  the level's own game's loading picture, when that game is installed.
//   dinput8.dll, thug2-limits.ini  with --raised-limits: the limits DLL (limits_dll.ts).
//   Data\levels\<L>_Props\...      the level editor's prop packs placed in THUG2's own level <L> (its layouts in --from's
//                                 thug2-decomp-layouts, the packs in thug2-decomp-props), baked at their places into a
//                                 scene the level loads after its own (prop_packs/retail_props.ts: two insertions into
//                                 Levels.qb). Every install bakes them again from the layouts; uninstalling everything
//                                 takes them out.
//   Data\pre\qb_scripts.prx        the game's scripts archive with our lines added to Levels.qb and the level select
//                                 (retail_levels.ts) - the user's current files, mods and all, decompiled, added to
//                                 and compiled again; every other file of the archive byte for byte as it was. THUG1's
//                                 levels also replace THUG2's empty driving scripts (only while they are empty); the
//                                 levels' own people (their converters' peds.json) are added to cas_ped_m.qb,
//                                 cas_ped_f.qb and profile_ped.qb the same way as the level structures.
// The first install keeps a copy of the archive as it was (thug2-retail-export\qb_scripts.prx.original) and each
// changed file's entry as it was before our lines (entries\); uninstall and every later install take only our lines
// out of the files as they are then (the user's edits made since stay), and give back a file's own bytes where only
// our lines had changed it. Anything it can't do safely - our lines changed or gone, a file it would overwrite that
// isn't ours, a level too big for the original game - is refused before anything is written.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { textOutput } from "thug2-level-converter-core/level_port/common.ts";
import * as pedModels from "thug2-level-converter-core/level_port/ped_models.ts";
import type { LevelEntry } from "thug2-level-converter-core/level_port/ported_levels.ts";
import * as portedLevels from "thug2-level-converter-core/level_port/ported_levels.ts";
import {
    type Archive,
    type ArchiveEntry,
    entryData,
    entryIndex,
    makeEntry,
    PRX_VERSION,
    readArchive,
    writeArchive,
} from "thug2-level-converter-core/level_port/prx.ts";
import { checksum, tokens } from "thug2-level-converter-core/level_port/qb.ts";
import * as budget from "thug2-level-converter-core/level_port/retail_budget.ts";
import { readScene } from "thug2-level-converter-core/level_port/thug2_scene.ts";
import { exitWith, isMain, parseCli, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { resolveInstall } from "thug2-level-converter-core/lib/install.ts";
import { requireNs } from "thug2-level-converter-core/lib/neverscript.ts";
import { decodeLatin1, encodeLatin1 } from "thug2-level-converter-core/lib/text.ts";
import * as loadingArtGames from "../menu_level/loading_art_games.ts";
import * as retailProps from "../prop_packs/retail_props.ts";
import * as limitsDll from "./limits_dll.ts";
import { retailLevelQb } from "./no_rotate.ts";
import {
    archiveNames,
    isEmptyScript,
    LEVEL_SELECT_QB,
    LEVELS_QB,
    levelSelectInsertions,
    levelsInsertion,
    levelsText,
    signText,
} from "./retail_levels.ts";
import {
    applyInsertions,
    type Insertion,
    type InsertionRecord,
    insertionsFrom,
    lines,
    MergeError,
    recordInsertions,
    sameEnding,
    stripInsertions,
} from "./script_merge.ts";

const USAGE =
    "usage: retail_export.ts install|uninstall|status|check --retail THUG2 [--levels LIST] [--from FOLDER] [--raised-limits [--limits-dll FILE]] [--pre] [--ns NS] [--ignore-budget]";

export const STATE_FOLDER = "thug2-retail-export";
export const STATE_FILE = "state.json";
export const BACKUP = "qb_scripts.prx.original";
export const SCRIPTS_ARCHIVE = ["Data", "pre", "qb_scripts.prx"] as const;
const REGISTER = "__register_checksums__";

// --- the state ---------------------------------------------------------------------------------------------------

export interface ScriptChange {
    file: string; // its name in the archive
    kind: "insert" | "replace";
    baseEntry: string; // the entry as it was before our change (entries\<n>.bin, the state folder's)
    baseBodySha256: string; // insert: the file's text before (without its checksum list)
    installedBodySha256?: string; // insert: its text with our lines
    names?: string[]; // insert: the checksum list's names our lines added
    insertions?: InsertionRecord[];
    installedEntrySha256?: string; // replace: our entry
}

export interface InstalledFile {
    path: string; // relative to the game folder, "/"-separated
    sha256: string;
    owner: string; // a level, or "staging:<folder>" for what a converter's levels share
}

export interface State {
    format: 1 | 2; // (2: with `limits`)
    levels: { level: string; staging: string }[];
    archive: { originalSha256: string; baseSha256: string; installedSha256: string };
    scripts: ScriptChange[];
    files: InstalledFile[];
    limits?: limitsDll.LimitsState; // the limits DLL, when the export installed it
}

export function sha256(data: Uint8Array | string): string {
    return createHash("sha256").update(data).digest("hex");
}

// A file's text without its checksum list and the empty lines at its end (NeverScript writes the list again from the
// names it compiles: it isn't part of what a change is).
// (NeverScript writes the list on the file's last line - after the closing "]" of a last array when the file ends
// with one, on that same line)
export function body(text: string): string {
    const kept: string[] = [];
    for (const l of lines(text)) {
        const at = l.indexOf(REGISTER);
        if (at < 0) kept.push(l);
        else if (l.slice(0, at).trim()) kept.push(l.slice(0, at));
    }
    while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
    return kept.map((l) => `${l}\n`).join("");
}

function registerNames(text: string): string[] {
    const line = lines(text).find((l) => l.includes(REGISTER));
    return line
        ? line
              .slice(line.indexOf(REGISTER) + REGISTER.length)
              .trim()
              .split(/\s+/)
              .filter(Boolean)
        : [];
}

// The checksum list without `names` (case as written).
export function withoutNames(text: string, names: readonly string[]): string {
    if (!names.length) return text;
    const drop = new Set(names.map((n) => n.toLowerCase()));
    const out = lines(text)
        .map((l) =>
            l.includes(REGISTER)
                ? l.slice(0, l.indexOf(REGISTER)) +
                  [REGISTER, ...registerNames(l).filter((n) => !drop.has(n.toLowerCase()))].join(" ")
                : l,
        )
        .map((l) => `${l}\n`)
        .join("");
    return sameEnding(text, out);
}

// One entry as its own bytes (and back): kept in the state folder.
export function entryBytes(e: ArchiveEntry): Buffer {
    return writeArchive({ version: PRX_VERSION, entries: [e] }).subarray(12);
}

export function entryFromBytes(data: Buffer): ArchiveEntry {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(data.length + 12, 0);
    header.writeUInt32LE(PRX_VERSION, 4);
    header.writeInt32LE(1, 8);
    return readArchive(Buffer.concat([header, data])).entries[0]!;
}

// --- NeverScript --------------------------------------------------------------------------------------------------

export class Scripts {
    private readonly tool: string;
    private readonly work: string;
    private n = 0;
    constructor(tool: string) {
        this.tool = tool;
        this.work = fs.mkdtempSync(path.join(os.tmpdir(), "retail-export-"));
    }
    private run(...args: string[]): void {
        const result = spawnSync(this.tool, args, { maxBuffer: 1 << 30 });
        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new MergeError(
                `ns ${args.join(" ")} failed:\n${textOutput(result.stdout)}${textOutput(result.stderr)}`,
            );
        }
    }
    // (Latin-1 both ways: byte for byte, whatever the file's foreign letters are)
    decompile(data: Uint8Array): string {
        const file = path.join(this.work, `d${this.n++}.qb`);
        fs.writeFileSync(file, data);
        this.run("-d", file, "-o", `${file}.ns`);
        return decodeLatin1(fs.readFileSync(`${file}.ns`)).replaceAll("\r\n", "\n");
    }
    compile(text: string): Buffer {
        const file = path.join(this.work, `c${this.n++}.ns`);
        fs.writeFileSync(file, encodeLatin1(text));
        this.run("-c", file, "-o", `${file}.qb`, "-targetGame", "thug2");
        return fs.readFileSync(`${file}.qb`);
    }
    close(): void {
        fs.rmSync(this.work, { recursive: true, force: true });
    }
}

// --- the scripts archive ------------------------------------------------------------------------------------------

function copyArchive(a: Archive): Archive {
    return { version: a.version, entries: [...a.entries] };
}

function entryAt(archive: Archive, file: string): number {
    const at = entryIndex(archive, file);
    if (at < 0) throw new MergeError(`qb_scripts.prx has no ${file} any more`);
    return at;
}

// The archive without our changes (as the state records them): each changed file's own entry where only our lines
// changed it, else its current text without our lines, compiled.
export function removeOurs(current: Archive, state: State, stateDir: string, ns: Scripts): Archive {
    const out = copyArchive(current);
    for (const change of state.scripts) {
        const at = entryAt(out, change.file);
        const e = out.entries[at]!;
        const base = entryFromBytes(fs.readFileSync(path.join(stateDir, change.baseEntry)));
        if (change.kind === "replace") {
            if (sha256(entryBytes(e)) !== change.installedEntrySha256) {
                throw new MergeError(`${change.file} changed since the install replaced it: not touching it`);
            }
            out.entries[at] = base;
            continue;
        }
        const text = ns.decompile(entryData(e));
        if (sha256(body(text)) === change.installedBodySha256) {
            out.entries[at] = base; // (only our lines changed it)
            continue;
        }
        let stripped: string;
        try {
            stripped = withoutNames(stripInsertions(text, change.insertions ?? []), change.names ?? []);
        } catch (err) {
            throw new MergeError(`${change.file}: ${(err as Error).message}`);
        }
        if (sha256(body(stripped)) === change.baseBodySha256) {
            out.entries[at] = base;
        } else {
            // (the user changed the file since: their changes stay)
            const compiled = ns.compile(stripped);
            out.entries[at] = { ...makeEntry(e.name, compiled), nameField: e.nameField, checksum: e.checksum };
        }
    }
    return out;
}

export interface Planned {
    archive: Archive;
    scripts: ScriptChange[];
    baseEntries: Map<string, Buffer>; // state-folder file -> an entry's bytes
}

// Our changes on the archive without them: the level structures, the level select's signs, THUG1's driving scripts.
export function addOurs(
    base: Archive,
    entries: readonly LevelEntry[],
    art: ReadonlyMap<string, string>,
    archives: boolean,
    replaced: ReadonlyMap<string, Buffer>,
    ns: Scripts,
    people: pedModels.Additions | null = null,
    propLevels: readonly string[] = [],
): Planned {
    const out = copyArchive(base);
    const scripts: ScriptChange[] = [];
    const baseEntries = new Map<string, Buffer>();
    if (!entries.length && !propLevels.length) return { archive: out, scripts, baseEntries };
    const edits: [string, (text: string) => Insertion[]][] = [
        [
            LEVELS_QB,
            (text) => [
                ...(entries.length ? [levelsInsertion(text, entries, art, archives)] : []),
                ...retailProps.levelsQbInsertions(text, propLevels),
            ],
        ],
    ];
    if (entries.length) edits.push([LEVEL_SELECT_QB, (text) => levelSelectInsertions(text, entries)]);
    // the levels' own people (their converters' peds.json: profiles and CAS parts appended to THUG2's lists - as
    // make_menu_level adds them to the overlay; without them a ported ped with its own profile crashes the game)
    if (people && !pedModels.empty(people)) {
        const add = people;
        edits.push(
            ["scripts\\cas_ped_m.qb", (text) => insertionsFrom(text, pedModels.casEdit(add, "cas_ped_m")(text))],
            ["scripts\\cas_ped_f.qb", (text) => insertionsFrom(text, pedModels.casEdit(add, "cas_ped_f")(text))],
            ["scripts\\profile_ped.qb", (text) => insertionsFrom(text, pedModels.profileEdit(add)(text))],
        );
    }
    for (const [file, edit] of edits) {
        const at = entryAt(out, file);
        const e = out.entries[at]!;
        const text = ns.decompile(entryData(e));
        let insertions: Insertion[];
        try {
            insertions = edit(text);
        } catch (err) {
            throw new MergeError(`${file}: ${(err as Error).message}`);
        }
        const changed = applyInsertions(text, insertions);
        const compiled = ns.compile(changed);
        const back = ns.decompile(compiled);
        let records: InsertionRecord[];
        if (body(back) === body(changed)) {
            records = recordInsertions(text, insertions);
        } else {
            // (NeverScript writes our lines its own way - another tool's text, the people's CAS parts: what it gives
            // back must still be the file's own text with lines added, and those are what is recorded)
            try {
                records = recordInsertions(body(text), insertionsFrom(body(text), body(back)));
            } catch (err) {
                throw new MergeError(
                    `${file}: NeverScript doesn't give back the file with only our lines added (${(err as Error).message}) - not changing it`,
                );
            }
        }
        const before = new Set(registerNames(text).map((n) => n.toLowerCase()));
        const names = registerNames(back).filter((n) => !before.has(n.toLowerCase()));
        const baseFile = `entries/${scripts.length}.bin`;
        baseEntries.set(baseFile, entryBytes(e));
        scripts.push({
            file,
            kind: "insert",
            baseEntry: baseFile,
            baseBodySha256: sha256(body(text)),
            installedBodySha256: sha256(body(back)),
            names,
            insertions: records,
        });
        out.entries[at] = { ...makeEntry(e.name, compiled), nameField: e.nameField, checksum: e.checksum };
    }
    for (const [file, data] of replaced) {
        const at = entryAt(out, file);
        const e = out.entries[at]!;
        if (!isEmptyScript(entryData(e))) {
            throw new MergeError(`${file} isn't THUG2's empty file (a mod's?): not replacing it`);
        }
        const ours: ArchiveEntry = { ...makeEntry(e.name, data), nameField: e.nameField, checksum: e.checksum };
        const baseFile = `entries/${scripts.length}.bin`;
        baseEntries.set(baseFile, entryBytes(e));
        scripts.push({
            file,
            kind: "replace",
            baseEntry: baseFile,
            baseBodySha256: "",
            installedEntrySha256: sha256(entryBytes(ours)),
        });
        out.entries[at] = ours;
    }
    return { archive: out, scripts, baseEntries };
}

// --- the levels' files --------------------------------------------------------------------------------------------

export interface PlannedFile {
    path: string; // relative to the game folder, "/"-separated
    data: Buffer;
    owner: string;
}

function listFiles(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(full).map((f) => `${entry.name}/${f}`));
        else if (entry.isFile()) out.push(entry.name);
    }
    return out.sort();
}

// The level's own files and its archives (THUG2's levels' layout: levels\<level>\<level>.scn.xbx ...). `qb`: what the
// retail game needs changed in a level's scripts (no_rotate.ts), given the file's name and bytes.
export function levelFiles(
    from: string,
    entry: LevelEntry,
    archives: boolean,
    qb: (name: string, data: Buffer) => Buffer = (_, data) => data,
): PlannedFile[] {
    const staging = String(entry.staging);
    const folders = [entry.level, ...(typeof entry.sky === "string" && entry.sky ? [entry.sky] : [])];
    const out: PlannedFile[] = [];
    const scene: ArchiveEntry[] = [];
    const collision: ArchiveEntry[] = [];
    const scripts: ArchiveEntry[] = [];
    for (const folder of folders) {
        const dir = path.join(from, staging, "levels", folder);
        const files = listFiles(dir);
        if (folder === entry.level && !files.length) throw new MergeError(`${entry.level}: no files in ${dir}`);
        for (const rel of files) {
            const read = fs.readFileSync(path.join(dir, ...rel.split("/")));
            const data = rel.toLowerCase().endsWith(".qb") ? qb(`${folder}/${rel}`, read) : read;
            out.push({ path: `Data/levels/${folder}/${rel}`, data, owner: entry.level });
            if (!archives) continue;
            const name = `levels\\${folder}\\${rel.replaceAll("/", "\\")}`;
            const lower = rel.toLowerCase();
            if (lower.endsWith(".scn.xbx") || lower.endsWith(".tex.xbx")) scene.push(makeEntry(name, data));
            else if (lower.endsWith(".col.xbx")) collision.push(makeEntry(name, data));
            else if (folder === entry.level) scripts.push(makeEntry(name, data));
        }
    }
    if (archives) {
        const names = archiveNames(entry.level);
        const prx = (name: string): string => `Data/pre/${name.replace(/\.pre$/i, ".prx")}`;
        for (const [name, list] of [
            [names.scene, scene],
            [names.collision, collision],
            [names.scripts, scripts],
        ] as const) {
            if (list.length) {
                out.push({
                    path: prx(name),
                    data: writeArchive({ version: PRX_VERSION, entries: list }),
                    owner: entry.level,
                });
            }
        }
    }
    return out;
}

// What a converter brings along for its levels (models, anims, skeletons - shared by its levels).
export function stagingFiles(from: string, staging: string): PlannedFile[] {
    const out: PlannedFile[] = [];
    for (const folder of ["models", "anims", "skeletons"]) {
        const dir = path.join(from, staging, folder);
        for (const rel of listFiles(dir)) {
            out.push({
                path: `Data/${folder}/${rel}`,
                data: fs.readFileSync(path.join(dir, ...rel.split("/"))),
                owner: `staging:${staging}`,
            });
        }
    }
    return out;
}

// THUG1's driving scripts a converter brings (<staging>\scripts\...: replacing THUG2's empty ones in the archive).
export function replacedScripts(from: string, stagings: Iterable<string>): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    for (const staging of stagings) {
        const dir = path.join(from, staging, "scripts");
        for (const rel of listFiles(dir)) {
            out.set(`scripts\\${rel.replaceAll("/", "\\")}`, fs.readFileSync(path.join(dir, ...rel.split("/"))));
        }
    }
    return out;
}

// The people the levels' converters brought (peds.json of the staging folders of the levels installed).
export function people(from: string, stagings: Iterable<string>): pedModels.Additions {
    const all: pedModels.Additions = { cas: {}, profiles: [] };
    for (const staging of stagings) {
        const file = path.join(from, staging, "peds.json");
        if (!fs.existsSync(file)) continue;
        const one = JSON.parse(fs.readFileSync(file, "utf-8")) as pedModels.Additions;
        for (const [list, entries] of Object.entries(one.cas)) all.cas[list] = [...(all.cas[list] ?? []), ...entries];
        all.profiles.push(...one.profiles);
    }
    return all;
}

// The names a level's scripts use (every name token of its folder's .qb files: its node array and scripts).
export function levelNames(from: string, entry: LevelEntry): Set<number> {
    const out = new Set<number>();
    const dir = path.join(from, String(entry.staging), "levels", entry.level);
    for (const rel of listFiles(dir)) {
        if (!rel.toLowerCase().endsWith(".qb")) continue;
        for (const [, t, payload] of tokens(fs.readFileSync(path.join(dir, ...rel.split("/"))))) {
            if (t === 0x16) out.add(payload.readUInt32LE(0));
        }
    }
    return out;
}

// Only the people `entries` use: a converter's peds.json has every person of its game's levels - each level's own
// profiles (named in its node array or scripts) and the CAS parts those name. The parts are all no_random (never
// picked for a random ped), so the rest are left out: the original game's pools have no room to spare (THUG1's 242
// profiles and their parts are ~1,200 structures, ~250 symbols).
export function peopleOf(from: string, entries: readonly LevelEntry[]): pedModels.Additions {
    const all = people(from, new Set(entries.map((e) => String(e.staging))));
    const used = new Set<number>();
    for (const e of entries) for (const n of levelNames(from, e)) used.add(n);
    const profiles = all.profiles.filter((text) => {
        const name = /^\s*(\w+)\s*=/.exec(text)?.[1];
        return name === undefined || used.has(checksum(name));
    });
    const parts = new Set<number>();
    for (const text of profiles) for (const m of text.matchAll(/desc_id=(\w+)/g)) parts.add(checksum(m[1]!));
    const cas: Record<string, string[]> = {};
    for (const [list, entriesOf] of Object.entries(all.cas)) {
        const kept = entriesOf.filter((text) => {
            const id = /desc_id=(\w+)/.exec(text)?.[1];
            return id === undefined || !/\bno_random\b/.test(text) || parts.has(checksum(id)) || used.has(checksum(id));
        });
        if (kept.length) cas[list] = kept;
    }
    return { cas, profiles };
}

// --- the commands -------------------------------------------------------------------------------------------------

function readState(stateDir: string): State | null {
    const file = path.join(stateDir, STATE_FILE);
    if (!fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, "utf-8")) as State;
    if (state.format !== 1 && state.format !== 2)
        exitWith(`${file}: a state this tool doesn't know (format ${state.format})`);
    return state;
}

// (a file replaced in one step: never half written)
function writeAtomic(file: string, data: Uint8Array): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.retail-export-tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
}

function selectLevels(all: readonly LevelEntry[], wanted: string | undefined): LevelEntry[] {
    if (!wanted || wanted === "all") return [...all];
    const keys = wanted
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    const out: LevelEntry[] = [];
    for (const key of keys) {
        const hit = all.filter(
            (e) =>
                e.level.toLowerCase() === key ||
                portedLevels.loadOf(e).toLowerCase() === key ||
                String(e.game ?? "").toLowerCase() === key ||
                String(e.staging).toLowerCase() === `thug2-decomp-${key}`,
        );
        if (!hit.length) exitWith(`--levels: no converted level ${key}`);
        for (const e of hit) if (!out.includes(e)) out.push(e);
    }
    return out;
}

// (a scene archive's packed size, of its files' - LZSS on scenes and textures: ~0.65 measured, rounded up)
const PACKED_SHARE = 0.75;

// A level's counts for the budget: every .qb of its folder (its node array and scripts) and the size of its scene,
// textures and collision; with `archives`, what its scene archive holds while the level loads (the archive packed,
// and its biggest file unpacked beside it).
export function levelCounts(from: string, entry: LevelEntry, archives = false): budget.QbCounts {
    let sum = budget.emptyCounts();
    const dir = path.join(from, String(entry.staging), "levels", entry.level);
    let scene = 0;
    let biggest = 0;
    for (const rel of listFiles(dir)) {
        const file = path.join(dir, ...rel.split("/"));
        const lower = rel.toLowerCase();
        if (lower.endsWith(".qb")) sum = budget.addCounts(sum, budget.countQb(fs.readFileSync(file)));
        else if (/\.(scn|tex|col)\.xbx$/.test(lower)) {
            const size = fs.statSync(file).size;
            sum.sceneBytes += size;
            if (!lower.endsWith(".col.xbx")) {
                scene += size;
                biggest = Math.max(biggest, size);
            }
        }
    }
    if (archives) sum.archiveBytes = Math.round(scene * PACKED_SHARE) + biggest;
    return sum;
}

// What the export adds to THUG2's own scripts for `entries` (their level structures and load scripts, their level
// select signs, the people of their converters' staging folders), counted as the game's loader allocates them -
// the budget's share of the installed levels (retail_budget's `scripts`).
export function scriptCounts(
    from: string,
    entries: readonly LevelEntry[],
    archives: boolean,
    ns: Scripts,
    everyone = false, // (all of the staging folders' people, as the export merged them before peopleOf)
): budget.QbCounts {
    if (!entries.length) return budget.emptyCounts();
    const add = everyone ? people(from, new Set(entries.map((e) => String(e.staging)))) : peopleOf(from, entries);
    const cas = Object.values(add.cas).flat();
    const text = [
        levelsText(entries, new Map(), archives),
        `retail_budget_signs = [\n${entries.map(signText).join("")}] \n`,
        ...add.profiles.map((p) => `${p} \n`),
        cas.length ? `retail_budget_cas = [\n${cas.join("\n")}\n] \n` : "",
    ].join("");
    const counts = budget.countQb(ns.compile(text));
    // (less the two arrays and their names that only hold the signs and the CAS parts here)
    const wrappers = cas.length ? 2 : 1;
    counts.symbols -= wrappers;
    counts.arrays -= wrappers;
    return counts;
}

// Each level's budget line with `levels` installed together (what they add to THUG2's scripts counted); returns the
// levels too big.
export function checkLevels(
    from: string,
    levels: readonly LevelEntry[],
    archives: boolean,
    raised: boolean,
    ns: Scripts,
): LevelEntry[] {
    const scripts = scriptCounts(from, levels, archives, ns);
    const limits = raised ? budget.RAISED_LIMITS : budget.RETAIL_LIMITS;
    const shadowRoom = raised ? SHADOW_VERTICES.raised : SHADOW_VERTICES.retail;
    const over: LevelEntry[] = [];
    for (const e of levels) {
        const result = budget.checkBudget(
            levelCounts(from, e, archives),
            levels.length,
            limits,
            undefined,
            budget.CALIBRATION,
            scripts,
            typeof e.game === "string" ? e.game : undefined,
        );
        const mesh = mostMeshVertices(from, e);
        let text = budget.budgetText(result);
        if (mesh > shadowRoom) {
            const line = `shadow buffer (a mesh of ${mesh} vertices; ${shadowRoom} fit)`;
            text = result.ok ? `too big for retail: ${line}` : `${text}, ${line}`;
        }
        print(`${e.level}: ${text}`);
        if (!result.ok || mesh > shadowRoom) over.push(e);
    }
    return over;
}

// The skater's shadow projects every vertex of each scene mesh in its view into a fixed buffer the original game
// never checks: 4,096 vertices (THUG2's own meshes fit; a ported one can have more and run past it). The retail-limits
// DLL gives it room for every vertex a mesh can index (its src/retail_limits/limits.h kShadowVertices, mirrored).
export const SHADOW_VERTICES = { retail: 0x1000, raised: 0x10000 } as const;

// The most vertices of one mesh in the level's own scenes (not its sky's: the shadow isn't cast there).
export function mostMeshVertices(from: string, entry: LevelEntry): number {
    let most = 0;
    const dir = path.join(from, String(entry.staging), "levels", entry.level);
    for (const rel of listFiles(dir)) {
        if (!rel.toLowerCase().endsWith(".scn.xbx")) continue;
        const scene = readScene(fs.readFileSync(path.join(dir, ...rel.split("/"))), rel);
        for (const sector of scene.sectors) for (const mesh of sector.meshes) most = Math.max(most, mesh.vertexCount);
    }
    return most;
}

interface Options {
    game: string;
    from: string;
    levels?: string | undefined;
    raisedLimits: boolean;
    limitsDll?: string | undefined; // the DLL to install (default: limitsDll.findDll's)
    ignoreBudget?: boolean;
    archives: boolean;
    ns?: string | undefined;
    artInstalls: Partial<Record<loadingArtGames.Game, string>>;
}

// The pipeline's own folder (limits_dll.findDll looks beside it).
const PIPELINE = path.resolve(import.meta.dirname, "..");

// The limits DLL to install, read and checked.
function readDll(given: string | undefined): Buffer {
    const file = limitsDll.findDll(given, PIPELINE);
    if (!file) {
        exitWith(
            `--raised-limits: no limits DLL to install - give --limits-dll <dinput8.dll> (the THUG2 decompilation's thug2_retail_limits_dll, an x86 build)${given ? ` (${given} not found)` : ""}`,
        );
    }
    const data = fs.readFileSync(file);
    const problem = limitsDll.dllProblem(data);
    if (problem) exitWith(`${file}: ${problem}`);
    return data;
}

// The install (or uninstall, or update) of `wanted` levels: everything planned and checked first, then written.
export function apply(options: Options, mode: "install" | "uninstall"): void {
    const ns = new Scripts(requireNs(options.ns));
    try {
        applyWith(options, mode, ns);
    } finally {
        ns.close();
    }
}

function applyWith(options: Options, mode: "install" | "uninstall", ns: Scripts): void {
    const { game } = options;
    const stateDir = path.join(game, STATE_FOLDER);
    const archiveFile = path.join(game, ...SCRIPTS_ARCHIVE);
    if (!fs.existsSync(archiveFile)) exitWith(`${archiveFile} not found`);
    const state = readState(stateDir);
    if (mode === "uninstall" && !state) exitWith(`${game}: nothing installed by the retail export`);

    // the levels wanted after this run
    let wanted: LevelEntry[];
    const manifest = portedLevels.loadManifest(options.from);
    const known = manifest?.levels ?? [];
    const installed = new Set((state?.levels ?? []).map((l) => l.level.toLowerCase()));
    // the level editor's prop packs placed in THUG2's own levels (prop_packs/retail_props.ts): with every install, and
    // kept by an uninstall of some levels; an uninstall of everything takes them out too
    const props = mode === "install" || options.levels ? retailProps.plan(options.from, game) : [];
    for (const p of props) {
        if (p.missing.length)
            print(`${p.level}: prop packs not found in ${options.from} (skipped): ${p.missing.join(", ")}`);
        if (p.pieces) print(`${p.level}: ${p.pieces} placed piece(s) baked into ${p.scene}`);
        if (p.rails)
            print(
                `${p.level}: ${p.rails} rail point(s) of the packs not carried (retail: not yet - the level's node array)`,
            );
    }
    const propLevels = props.filter((p) => p.files.length);
    if (mode === "install") {
        if (!known.length && !propLevels.length)
            exitWith(
                `${options.from}: no converted levels (no thug2-decomp-* staging folder with a levels.json) and no placed prop packs`,
            );
        const chosen = selectLevels(known, options.levels);
        const keep = known.filter((e) => installed.has(e.level.toLowerCase()) && !chosen.includes(e));
        const missing = [...installed].filter((l) => !known.some((e) => e.level.toLowerCase() === l));
        if (missing.length)
            exitWith(
                `installed levels no longer converted in ${options.from}: ${missing.join(", ")} - uninstall them first`,
            );
        wanted = [...keep, ...chosen];
    } else {
        const drop = options.levels
            ? new Set(selectLevels(known, options.levels).map((e) => e.level.toLowerCase()))
            : null;
        const left = drop ? [...installed].filter((l) => !drop.has(l)) : [];
        wanted = known.filter((e) => left.includes(e.level.toLowerCase()));
        if (left.length !== wanted.length)
            exitWith(`levels still installed but no longer converted in ${options.from}: uninstall all of them`);
    }

    // the limits DLL: wanted with --raised-limits (an install) or while it is in (an uninstall leaving levels)
    const hadDll = state?.limits ?? null;
    const wantDll = wanted.length > 0 && (mode === "install" ? options.raisedLimits : hadDll !== null);
    const dll = wantDll && (mode === "install" || !hadDll) ? readDll(options.limitsDll) : null;
    // (a limits DLL of the player's own, not ours: the raised limits too)
    const playersDll = !hadDll?.dll.installed && limitsDll.hasLimitsDll(game);
    const raised = wantDll || playersDll;
    const lowered = hadDll !== null && !raised;

    // the budget (the levels being added; those already in stay as they are - unless the limits go down)
    const refused = checkLevels(options.from, wanted, options.archives, raised, ns).filter(
        (e) => lowered || !installed.has(e.level.toLowerCase()),
    ).length;
    if (refused && options.ignoreBudget) {
        print(`${refused} level(s) too big - installed anyway (--ignore-budget)`);
    } else if (refused) {
        exitWith(
            raised
                ? `${refused} level(s) too big even with the limits DLL - nothing written`
                : `${refused} level(s) too big for the original game - nothing written (--raised-limits: install the THUG2 decompilation's retail-limits DLL with them)`,
        );
    }
    let dllPlan: limitsDll.LimitsPlan | null = null;
    if (dll && hadDll?.dll.installed) {
        // (ours in already: brought up to this build when it changed)
        const now = path.join(game, limitsDll.DLL);
        if (!fs.existsSync(now) || limitsDll.sha256Of(fs.readFileSync(now)) !== hadDll.dll.sha256) {
            exitWith(`${now} changed since the export put it there - refused, nothing written`);
        }
        const next: limitsDll.LimitsState = { ...hadDll, dll: { sha256: limitsDll.sha256Of(dll), installed: true } };
        dllPlan = { state: next, lines: [], run: () => writeAtomic(now, dll) };
        if (next.dll.sha256 !== hadDll.dll.sha256) dllPlan.lines.push(`${limitsDll.DLL}: brought up to this build`);
    } else if (dll && !hadDll) {
        dllPlan = limitsDll.planInstall(game, stateDir, dll);
    } else if (dll && hadDll) {
        dllPlan = { state: hadDll, lines: [], run: () => {} }; // (the same DLL there already: not ours)
    }
    if (hadDll && !wantDll) {
        const problems = limitsDll.uninstallProblems(game, hadDll);
        if (problems.length) exitWith(`refused - nothing written:\n  ${problems.join("\n  ")}`);
    }

    // the archive: ours out, ours (for the levels wanted) in
    const currentBytes = fs.readFileSync(archiveFile);
    const current = readArchive(currentBytes);
    const base = state ? removeOurs(current, state, stateDir, ns) : current;
    const baseBytes = writeArchive(base);
    const loads = new Set(wanted.map((e) => `load_${portedLevels.loadOf(e)}`.toLowerCase()));
    const art = wanted.length
        ? loadingArtGames.buildArt(loadingArtGames.findInstalls(options.artInstalls), loads)
        : null;
    for (const line of art?.lines ?? []) print(`loading pictures: ${line}`);
    const stagings = new Set(wanted.map((e) => String(e.staging)));
    const replaced = replacedScripts(
        options.from,
        [...stagings].filter((s) =>
            wanted.some((e) => e.staging === s && String(e.game ?? "").toUpperCase() === "THUG1"),
        ),
    );
    const planned = addOurs(
        base,
        wanted,
        art?.art ?? new Map(),
        options.archives,
        replaced,
        ns,
        peopleOf(options.from, wanted),
        propLevels.map((p) => p.level),
    );
    const newBytes = writeArchive(planned.archive);

    // the files
    const files: PlannedFile[] = [];
    for (const e of wanted)
        files.push(...levelFiles(options.from, e, options.archives, (name, data) => retailLevelQb(name, data, ns)));
    for (const staging of stagings) files.push(...stagingFiles(options.from, staging));
    for (const p of propLevels) for (const f of p.files) files.push({ ...f, owner: `props:${p.level}` });
    for (const [name, data] of art?.images ?? []) {
        const owner = [...(art?.art ?? [])].find(([, n]) => n === name)?.[0] ?? "";
        const level = wanted.find((e) => `load_${portedLevels.loadOf(e)}`.toLowerCase() === owner)?.level ?? "images";
        files.push({ path: `Data/images/${name}.img.xbx`, data, owner: level });
    }
    const ours = new Map((state?.files ?? []).map((f) => [f.path.toLowerCase(), f]));
    const keepFiles: InstalledFile[] = [];
    const problems: string[] = [];
    const toWrite: PlannedFile[] = [];
    for (const f of files) {
        const target = path.join(game, ...f.path.split("/"));
        const mine = ours.get(f.path.toLowerCase());
        if (fs.existsSync(target)) {
            const now = fs.readFileSync(target);
            if (!mine && !now.equals(f.data)) problems.push(`${f.path}: there already, not ours`);
            else if (mine && sha256(now) !== mine.sha256 && !now.equals(f.data))
                problems.push(`${f.path}: changed since we wrote it`);
            if (!mine && now.equals(f.data)) continue; // (the same file is there already: not ours to remove)
            if (!now.equals(f.data)) toWrite.push(f); // (ours and the same: left as it is)
        } else {
            toWrite.push(f);
        }
        keepFiles.push({ path: f.path, sha256: sha256(f.data), owner: f.owner });
    }
    if (problems.length) exitWith(`refused - nothing written:\n  ${problems.join("\n  ")}`);
    const wantedPaths = new Set(keepFiles.map((f) => f.path.toLowerCase()));
    const toRemove = (state?.files ?? []).filter((f) => !wantedPaths.has(f.path.toLowerCase()));

    // --- writing ---
    if (!state && !fs.existsSync(path.join(stateDir, BACKUP))) {
        fs.mkdirSync(stateDir, { recursive: true });
        writeAtomic(path.join(stateDir, BACKUP), currentBytes);
        print(`kept the scripts archive as it was: ${path.join(stateDir, BACKUP)}`);
    }
    for (const [file, data] of planned.baseEntries) writeAtomic(path.join(stateDir, ...file.split("/")), data);
    if (!newBytes.equals(currentBytes)) writeAtomic(archiveFile, newBytes);
    for (const f of toWrite) writeAtomic(path.join(game, ...f.path.split("/")), f.data);
    let left = 0;
    for (const f of toRemove) {
        const target = path.join(game, ...f.path.split("/"));
        if (!fs.existsSync(target)) continue;
        if (sha256(fs.readFileSync(target)) !== f.sha256) {
            print(`left in place (changed since we wrote it): ${f.path}`);
            left += 1;
            continue;
        }
        fs.rmSync(target);
        removeEmptyFolders(path.dirname(target), path.join(game, "Data"));
    }
    // the limits DLL
    for (const line of dllPlan?.lines ?? []) print(line);
    dllPlan?.run();
    if (hadDll && !wantDll) for (const line of limitsDll.uninstall(game, stateDir, hadDll)) print(line);
    if (wanted.length || propLevels.length || left) {
        const limits = wantDll ? (dllPlan?.state ?? hadDll ?? undefined) : undefined;
        const next: State = {
            format: limits ? 2 : 1,
            levels: wanted.map((e) => ({ level: e.level, staging: String(e.staging) })),
            archive: {
                originalSha256: state?.archive.originalSha256 ?? sha256(currentBytes),
                baseSha256: sha256(baseBytes),
                installedSha256: sha256(newBytes),
            },
            scripts: planned.scripts,
            files: keepFiles,
            ...(limits ? { limits } : {}),
        };
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, STATE_FILE), `${JSON.stringify(next, null, 1)}\n`);
    } else {
        // nothing of ours left: the state goes; the archive's first copy stays (the user's, as it was)
        fs.rmSync(path.join(stateDir, STATE_FILE), { force: true });
        fs.rmSync(path.join(stateDir, "entries"), { recursive: true, force: true });
    }
    // old entries no longer named
    const named = new Set(planned.scripts.map((s) => s.baseEntry));
    const entriesDir = path.join(stateDir, "entries");
    if (fs.existsSync(entriesDir)) {
        for (const name of fs.readdirSync(entriesDir))
            if (!named.has(`entries/${name}`)) fs.rmSync(path.join(entriesDir, name));
    }
    const original = path.join(stateDir, BACKUP);
    const restored = fs.existsSync(original) && sha256(fs.readFileSync(original)) === sha256(newBytes);
    print(
        `${mode}: ${wanted.length} level(s) in the install (${wanted.map((e) => e.level).join(", ") || "none"}); ` +
            `${propLevels.length ? `prop packs in ${propLevels.map((p) => p.level).join(", ")}; ` : ""}` +
            `${toWrite.length} file(s) written, ${toRemove.length - left} removed; qb_scripts.prx ` +
            (newBytes.equals(currentBytes)
                ? "unchanged"
                : restored
                  ? "back as it was before the first install"
                  : "updated"),
    );
}

function removeEmptyFolders(dir: string, stop: string): void {
    let at = dir;
    while (
        path.resolve(at).toLowerCase() !== path.resolve(stop).toLowerCase() &&
        path.resolve(at).toLowerCase().startsWith(path.resolve(stop).toLowerCase())
    ) {
        try {
            if (fs.readdirSync(at).length) return;
            fs.rmdirSync(at);
        } catch {
            return;
        }
        at = path.dirname(at);
    }
}

export function status(game: string): void {
    const stateDir = path.join(game, STATE_FOLDER);
    const state = readState(stateDir);
    const archiveFile = path.join(game, ...SCRIPTS_ARCHIVE);
    const backup = path.join(stateDir, BACKUP);
    if (!state) {
        print(
            `${game}: no levels installed by the retail export${fs.existsSync(backup) ? ` (the archive's first copy is kept: ${backup})` : ""}`,
        );
        return;
    }
    print(`${game}: ${state.levels.length} level(s): ${state.levels.map((l) => l.level).join(", ")}`);
    const now = fs.existsSync(archiveFile) ? sha256(fs.readFileSync(archiveFile)) : "";
    print(
        `qb_scripts.prx: ${now === state.archive.installedSha256 ? "as the install left it" : "changed since the install (uninstall takes out only our lines)"}; ` +
            `changed files: ${state.scripts.map((s) => s.file).join(", ")}`,
    );
    let missing = 0;
    let changed = 0;
    for (const f of state.files) {
        const target = path.join(game, ...f.path.split("/"));
        if (!fs.existsSync(target)) missing += 1;
        else if (sha256(fs.readFileSync(target)) !== f.sha256) changed += 1;
    }
    print(`files: ${state.files.length} (${missing} missing, ${changed} changed since)`);
    const propLevels = [
        ...new Set(state.files.filter((f) => f.owner.startsWith("props:")).map((f) => f.owner.slice(6))),
    ];
    if (propLevels.length) print(`prop packs: placed pieces in ${propLevels.join(", ")}`);
    if (state.limits) {
        const there = path.join(game, limitsDll.DLL);
        const now = fs.existsSync(there) ? sha256(fs.readFileSync(there)) : "";
        print(
            `limits DLL: ${state.limits.dll.installed ? "installed by the export" : "there before the export (not ours)"}` +
                `${now === state.limits.dll.sha256 ? "" : now ? ", changed since" : ", missing"}` +
                `${state.limits.chained ? `; the folder's own dinput8.dll chained as ${state.limits.chained.name}` : ""}`,
        );
    } else if (limitsDll.hasLimitsDll(game)) {
        print("limits DLL: one is there (not the export's)");
    }
}

async function main(): Promise<number> {
    const { values, positionals } = parseCli(USAGE, {
        allowPositionals: true,
        options: {
            retail: { type: "string" },
            from: { type: "string" },
            levels: { type: "string" },
            "raised-limits": { type: "boolean" },
            "limits-dll": { type: "string" },
            "ignore-budget": { type: "boolean" },
            pre: { type: "boolean" },
            "no-pre": { type: "boolean" }, // (the default now: kept for older command lines)
            ns: { type: "string" },
            thps2: { type: "string" },
            thps3: { type: "string" },
            thps4: { type: "string" },
            thug1: { type: "string" },
            thaw: { type: "string" },
            thp8: { type: "string" },
        },
    });
    const command = positionals[0];
    if (!values.retail || !["install", "uninstall", "status", "check"].includes(command ?? "")) exitWith(USAGE);
    const game = resolveInstall(values.retail, "thug2");
    if (command === "status") {
        status(game);
        return 0;
    }
    if (command === "check") {
        // (the budget alone: nothing written)
        const from = values.from ? values.from : game;
        const known = portedLevels.loadManifest(from)?.levels ?? [];
        const levels = selectLevels(known, values.levels);
        // (checked as installed together with those in the install already; a limits DLL there counts as
        // --raised-limits)
        const state = readState(path.join(game, STATE_FOLDER));
        const inAlready = known.filter(
            (e) => !levels.includes(e) && state?.levels.some((l) => l.level.toLowerCase() === e.level.toLowerCase()),
        );
        const raised = values["raised-limits"] === true || limitsDll.hasLimitsDll(game);
        const ns = new Scripts(requireNs(values.ns));
        try {
            checkLevels(from, [...levels, ...inAlready], values.pre === true, raised, ns);
        } finally {
            ns.close();
        }
        return 0;
    }
    const artInstalls: Partial<Record<loadingArtGames.Game, string>> = {};
    for (const g of loadingArtGames.GAMES) if (values[g]) artInstalls[g] = values[g];
    try {
        apply(
            {
                game,
                from: values.from ? values.from : game,
                levels: values.levels,
                raisedLimits: values["raised-limits"] === true,
                limitsDll: values["limits-dll"],
                ignoreBudget: values["ignore-budget"] === true,
                archives: values.pre === true && values["no-pre"] !== true,
                ns: values.ns,
                artInstalls,
            },
            command as "install" | "uninstall",
        );
    } catch (err) {
        if (err instanceof MergeError) exitWith(`refused - nothing written: ${err.message}`);
        throw err;
    }
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
