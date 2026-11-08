// NOT ORIGINAL - the retail export: converted levels (the staging folders the level converters write, as
// make_menu_level installs them into this project's data overlay) installed into a THUG2 install's own data, so the
// original game - not only this project's engine - plays them:
//
//   node tools/pipeline/retail/retail_export.ts install   --retail <THUG2 folder> [--levels a,b|thps2|all] [--from F]
//   node tools/pipeline/retail/retail_export.ts uninstall --retail <THUG2 folder> [--levels a,b]   (default: all)
//   node tools/pipeline/retail/retail_export.ts status    --retail <THUG2 folder>
//   node tools/pipeline/retail/retail_export.ts check     --retail <THUG2 folder> [--levels ...]   (the budget alone)
//   (--from: the folder holding the converters' thug2-decomp-* staging folders, default the --retail folder;
//    --raised-limits: the install has the decomp's retail-limits patch (dinput8.dll beside THUG2.exe) - levels are
//    checked against its raised limits (retail_budget.RAISED_LIMITS) instead of the original's; --no-pre: no level archives; --ns <ns.exe>; --thps2 ... --thp8 <install>: the games' own loading
//    pictures, as make_menu_level's)
//
// What it writes into the install (each file listed, with its hash, in <THUG2>\thug2-retail-export\state.json, and
// taken out again by uninstall unless it changed since):
//   Data\levels\<level>\...       the level's files (scene, textures, collision, node array, its sky's folder too),
//                                 where THUG2's own levels are: the game loads levels from loose files
//                                 (UsePreFilesForLevelLoading = 0) and finds a file in a loaded archive first, then
//                                 in Data\.
//   Data\pre\<level>scn.prx, <level>col.prx, <level>_scripts.prx  the same files as THUG2's own levels' archives (named
//                                 by the level structure's scnpre= / colpre= / pre=; used only where a mod sets
//                                 UsePreFilesForLevelLoading); --no-pre leaves them out.
//   Data\models, anims, skeletons\...  what a converter brings along for its levels (shared by its levels).
//   Data\images\loadscrn_<game>_<level>.img.xbx  the level's own game's loading picture, when that game is installed.
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
import * as budget from "thug2-level-converter-core/level_port/retail_budget.ts";
import { exitWith, isMain, parseCli, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { resolveInstall } from "thug2-level-converter-core/lib/install.ts";
import { requireNs } from "thug2-level-converter-core/lib/neverscript.ts";
import { decodeLatin1, encodeLatin1 } from "thug2-level-converter-core/lib/text.ts";
import * as loadingArtGames from "../menu_level/loading_art_games.ts";
import {
    archiveNames,
    isEmptyScript,
    LEVEL_SELECT_QB,
    LEVELS_QB,
    levelSelectInsertions,
    levelsInsertion,
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
    "usage: retail_export.ts install|uninstall|status|check --retail THUG2 [--levels LIST] [--from FOLDER] [--raised-limits] [--no-pre] [--ns NS]";

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
    format: 1;
    levels: { level: string; staging: string }[];
    archive: { originalSha256: string; baseSha256: string; installedSha256: string };
    scripts: ScriptChange[];
    files: InstalledFile[];
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
): Planned {
    const out = copyArchive(base);
    const scripts: ScriptChange[] = [];
    const baseEntries = new Map<string, Buffer>();
    if (!entries.length) return { archive: out, scripts, baseEntries };
    const edits: [string, (text: string) => Insertion[]][] = [
        [LEVELS_QB, (text) => [levelsInsertion(text, entries, art, archives)]],
        [LEVEL_SELECT_QB, (text) => levelSelectInsertions(text, entries)],
    ];
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

// The level's own files and its archives (THUG2's levels' layout: levels\<level>\<level>.scn.xbx ...).
export function levelFiles(from: string, entry: LevelEntry, archives: boolean): PlannedFile[] {
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
            const data = fs.readFileSync(path.join(dir, ...rel.split("/")));
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

// --- the commands -------------------------------------------------------------------------------------------------

function readState(stateDir: string): State | null {
    const file = path.join(stateDir, STATE_FILE);
    if (!fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, "utf-8")) as State;
    if (state.format !== 1) exitWith(`${file}: a state this tool doesn't know (format ${state.format})`);
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

// A level's counts for the budget: every .qb of its folder (its node array and scripts) and the size of its scene,
// textures and collision.
export function levelCounts(from: string, entry: LevelEntry): budget.QbCounts {
    let sum = budget.emptyCounts();
    const dir = path.join(from, String(entry.staging), "levels", entry.level);
    for (const rel of listFiles(dir)) {
        const file = path.join(dir, ...rel.split("/"));
        const lower = rel.toLowerCase();
        if (lower.endsWith(".qb")) sum = budget.addCounts(sum, budget.countQb(fs.readFileSync(file)));
        else if (/\.(scn|tex|col)\.xbx$/.test(lower)) sum.sceneBytes += fs.statSync(file).size;
    }
    return sum;
}

interface Options {
    game: string;
    from: string;
    levels?: string | undefined;
    raisedLimits: boolean;
    archives: boolean;
    ns?: string | undefined;
    artInstalls: Partial<Record<loadingArtGames.Game, string>>;
}

// The install (or uninstall, or update) of `wanted` levels: everything planned and checked first, then written.
export function apply(options: Options, mode: "install" | "uninstall"): void {
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
    if (mode === "install") {
        if (!known.length)
            exitWith(`${options.from}: no converted levels (no thug2-decomp-* staging folder with a levels.json)`);
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

    // the budget (the levels being added; those already in stay as they are)
    let refused = 0;
    for (const e of wanted) {
        const limits = options.raisedLimits ? budget.RAISED_LIMITS : budget.RETAIL_LIMITS;
        const result = budget.checkBudget(levelCounts(options.from, e), wanted.length, limits);
        print(`${e.level}: ${budget.budgetText(result)}`);
        if (!result.ok && !installed.has(e.level.toLowerCase())) refused += 1;
    }
    if (refused) {
        exitWith(
            options.raisedLimits
                ? `${refused} level(s) too big even with the limits patch - nothing written`
                : `${refused} level(s) too big for the original game - nothing written (--raised-limits: the install has the decomp's retail-limits patch, dinput8.dll beside THUG2.exe)`,
        );
    }

    const ns = new Scripts(requireNs(options.ns));
    try {
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
            people(options.from, stagings),
        );
        const newBytes = writeArchive(planned.archive);

        // the files
        const files: PlannedFile[] = [];
        for (const e of wanted) files.push(...levelFiles(options.from, e, options.archives));
        for (const staging of stagings) files.push(...stagingFiles(options.from, staging));
        for (const [name, data] of art?.images ?? []) {
            const owner = [...(art?.art ?? [])].find(([, n]) => n === name)?.[0] ?? "";
            const level =
                wanted.find((e) => `load_${portedLevels.loadOf(e)}`.toLowerCase() === owner)?.level ?? "images";
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
        if (wanted.length || left) {
            const next: State = {
                format: 1,
                levels: wanted.map((e) => ({ level: e.level, staging: String(e.staging) })),
                archive: {
                    originalSha256: state?.archive.originalSha256 ?? sha256(currentBytes),
                    baseSha256: sha256(baseBytes),
                    installedSha256: sha256(newBytes),
                },
                scripts: planned.scripts,
                files: keepFiles,
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
                `${toWrite.length} file(s) written, ${toRemove.length - left} removed; qb_scripts.prx ` +
                (newBytes.equals(currentBytes)
                    ? "unchanged"
                    : restored
                      ? "back as it was before the first install"
                      : "updated"),
        );
    } finally {
        ns.close();
    }
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
}

async function main(): Promise<number> {
    const { values, positionals } = parseCli(USAGE, {
        allowPositionals: true,
        options: {
            retail: { type: "string" },
            from: { type: "string" },
            levels: { type: "string" },
            "raised-limits": { type: "boolean" },
            "no-pre": { type: "boolean" },
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
        const levels = selectLevels(portedLevels.loadManifest(from)?.levels ?? [], values.levels);
        for (const e of levels)
            print(
                `${e.level}: ${budget.budgetText(budget.checkBudget(levelCounts(from, e), levels.length, values["raised-limits"] ? budget.RAISED_LIMITS : budget.RETAIL_LIMITS))}`,
            );
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
                archives: values["no-pre"] !== true,
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
