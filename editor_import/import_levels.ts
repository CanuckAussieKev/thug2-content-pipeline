// NOT ORIGINAL - the level editor's Import Level window, the converters' side: which game a folder holds, its levels,
// converting some of them and making the data overlay again (the editor runs these as child processes with the Node
// runtime it ships - the decomp's src/editor/level_editor_import.h).
//
//   node editor_import/import_levels.ts detect <folder>
//   node editor_import/import_levels.ts list <folder> [--game <game>] [--thug2 <THUG2 folder>]
//   node editor_import/import_levels.ts convert <folder> <level> [<level> ...] [--game <game>] --thug2 <THUG2 folder>
//   node editor_import/import_levels.ts overlay --thug2 <THUG2 folder> [--thps2 <folder>] ... [--thp8 <folder>]
//
//   detect   the game in <folder> (the install root or its Game folder - thug2-level-converter-core/lib/install.ts):
//            one line "game <key> <title> <folder holding its files>"; exit 1 with a message when it is none of them.
//   list     that line, then a line per level the game's converter makes:
//              "level <id> <title> <place> <flags> <load> <retail>"
//            (tab-separated; <id>: what `convert` takes; <flags>: comma-separated "default" - converted by default -,
//            "imported" - in <THUG2>\thug2-decomp-<game>\levels.json -, "missing" - its files aren't in the folder -, or
//            "-"; <load>: an imported level's load script, Load_<name>, else "-"; <retail>: whether it fits a retail
//            THUG2 install - "ok", "big" or "-" not checked: the budget checker's place).
//   convert  the game's converter's `convert` with those levels, from <folder> into <THUG2>\thug2-decomp-<game> (the
//            converter's own staging folder; the other levels there stay), its output as it writes it.
//   overlay  menu_level/make_menu_level.ts --game <THUG2>: the data overlay <THUG2>\thug2-decomp-data made again with
//            every converted level. What make_menu_level makes only on request and this can't - the HD menu art
//            (hd_ui\, --hd-ui) and the new front end's fonts (frontend\fonts\, --frontend-fonts) - is kept from the
//            overlay that was there; <THUG2>\thug2-decomp-art.txt (the level select's picture choices) is used when
//            it is there. --thps2 ... --thp8: the games' folders, for their loading pictures (make_menu_level's).
//
// The source game's folder is only read. <THUG2> is the folder the converted levels go to (the game folder: the
// converters' --thug2).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST } from "thug2-level-converter-core/level_port/ported_levels.ts";
import { exitWith, isMain, parseCli, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { findCaseless, findInstall, type InstallGame } from "thug2-level-converter-core/lib/install.ts";
import * as levelSelect from "../menu_level/level_select.ts";
import { PIPELINE } from "../pipeline.ts";
import { toolFile } from "../run.ts";

export type Game = Exclude<InstallGame, "thug2">;

interface GameInfo {
    title: string;
    tool: string; // the converter (run.ts's name for it)
    option: string; // its option naming the game's folder
    staging: string; // its output folder under <THUG2>
}

export const GAMES: Readonly<Record<Game, GameInfo>> = {
    thps2: {
        title: "Tony Hawk's Pro Skater 2",
        tool: "thps2_levels/thps2_levels.ts",
        option: "--thps2",
        staging: "thug2-decomp-thps2",
    },
    thps3: {
        title: "Tony Hawk's Pro Skater 3",
        tool: "thps3_levels/thps3_levels.ts",
        option: "--thps3",
        staging: "thug2-decomp-thps3",
    },
    thps4: {
        title: "Tony Hawk's Pro Skater 4",
        tool: "thps4_levels/thps4_levels.ts",
        option: "--thps4",
        staging: "thug2-decomp-thps4",
    },
    thug1: {
        title: "Tony Hawk's Underground",
        tool: "thug1_levels/thug1_levels.ts",
        option: "--thug1",
        staging: "thug2-decomp-thug1",
    },
    thaw: {
        title: "Tony Hawk's American Wasteland",
        tool: "thaw_levels/thaw_levels.ts",
        option: "--thaw",
        staging: "thug2-decomp-thaw",
    },
    thp8: {
        title: "Tony Hawk's Project 8",
        tool: "thp8_levels/thp8_levels.ts",
        option: "--thp8",
        staging: "thug2-decomp-thp8",
    },
    thpg: {
        title: "Tony Hawk's Proving Ground",
        tool: "thpg_levels/thpg_levels.ts",
        option: "--thpg",
        staging: "thug2-decomp-thpg",
    },
};

// The order a folder is tried in: a game whose markers another's contain first (THPG's data has THP8's marker and
// more, THPS4's data\levels is THPS3's Data\Levels and more).
export const DETECT_ORDER: readonly Game[] = ["thpg", "thp8", "thaw", "thug1", "thps4", "thps3", "thps2"];

// The games make_menu_level reads loading pictures from (its --thps2 ... --thp8).
export const LOADING_ART_GAMES: readonly Game[] = ["thps2", "thps3", "thps4", "thug1", "thaw", "thp8"];

export interface Detected {
    game: Game;
    folder: string; // the folder holding its files (the install root's Game folder, or the folder itself)
}

// Project 8 and Proving Ground have the same layout (the converters' markers fit both): told apart by a zone of each
// one's own city.
const OWN_ZONE: Partial<Record<Game, string>> = { thp8: "z_houses.pak.xen", thpg: "z_love.pak.xen" };

// The folder holding `game`'s files under `folder` (as findInstall), or null.
export function findGame(folder: string, game: Game): string | null {
    const found = findInstall(folder, game);
    const zone = OWN_ZONE[game];
    if (found === null || zone === undefined) return found;
    return findCaseless(found, "DATA", "COMPRESSED", "ZONES", zone) !== null ? found : null;
}

// The game in `folder` (null: none of them; "thug2": THUG2 itself - tried first, its data has THPS4's markers). A folder
// holding none of them is looked into one level down (a few folders: "Tony Hawk's Proving Grounds\ProvingGround").
export const MOST_SUBFOLDERS = 16;
export function detect(folder: string, deeper = true): Detected | "thug2" | null {
    if (findInstall(folder, "thug2") !== null) return "thug2";
    for (const game of DETECT_ORDER) {
        const found = findGame(folder, game);
        if (found !== null) return { game, folder: found };
    }
    if (!deeper) return null;
    let names: string[] = [];
    try {
        names = fs.readdirSync(folder).filter((n) => isDir(path.join(folder, n)));
    } catch {
        return null;
    }
    if (names.length > MOST_SUBFOLDERS) return null;
    for (const name of names.sort()) {
        const found = detect(path.join(folder, name), false);
        if (found !== null && found !== "thug2") return found;
    }
    return null;
}

export interface Level {
    id: string; // what the converter's convert takes
    title: string;
    place: string;
    byDefault: boolean;
    missing: boolean; // its files aren't in the folder (where that is easily told)
}

// "SKATE & FUN PARKS" -> "Skate & Fun Parks" (each word's first letter upper case, the rest lower; a word of one or two
// letters - NY, LA, DC - and a Roman number - SCHOOL II - kept as they are).
export function titleCase(text: string): string {
    return text.replace(/[A-Za-z0-9']+/g, (word) =>
        word.length <= 2 || /^[IVX]+$/.test(word) ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    );
}

// One line of a THP8 / THPG converter's `list`: "<level>  <number>  <SIGN TEXT>  <zones>".
export function parseListLine(line: string): Level | null {
    const match = /^(\S+)\s+(\d+)\s+(.+?)\s{2,}(\S.*)$/.exec(line.trimEnd());
    if (!match) return null;
    return { id: match[1]!, title: titleCase(match[3]!), place: match[4]!, byDefault: true, missing: false };
}

const isDir = (p: string): boolean => {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
};

// A folder under `folder` by its name, without regard to case.
function hasFolder(folder: string, ...parts: string[]): boolean {
    let p = folder;
    for (const part of parts) {
        let names: string[];
        try {
            names = fs.readdirSync(p);
        } catch {
            return false;
        }
        const match = names.find((n) => n.toLowerCase() === part.toLowerCase());
        if (match === undefined) return false;
        p = path.join(p, match);
    }
    return isDir(p);
}

// A converter's command module (its LEVELS table), loaded as run.ts loads it - its main block doesn't run on import.
async function converterModule(game: Game): Promise<Record<string, unknown>> {
    const file = toolFile(GAMES[game].tool);
    if (file === null) exitWith(`${GAMES[game].tool}: the converter isn't installed`);
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

type Row = readonly [string, string, string, string, number, boolean];

// The levels the game's converter makes, from its own tables (THP8 / THPG: its `list`, read from the game's files).
export async function levelsOf(game: Game, folder: string): Promise<Level[]> {
    if (game === "thp8" || game === "thpg") {
        const file = toolFile(GAMES[game].tool);
        if (file === null) exitWith(`${GAMES[game].tool}: the converter isn't installed`);
        const result = spawnSync(process.execPath, [file, "list", GAMES[game].option, folder], { encoding: "utf-8" });
        if (result.status !== 0) exitWith(`${GAMES[game].tool} list failed:\n${result.stdout}${result.stderr}`);
        return result.stdout
            .split(/\r?\n/)
            .map(parseListLine)
            .filter((l) => l !== null);
    }
    const module = await converterModule(game);
    if (game === "thps2") {
        const levels = module.LEVELS as readonly { base: string; sign: string; location: string }[];
        return levels.map((l) => ({
            id: l.base,
            title: titleCase(levelSelect.THPS2_LEVELS.get(l.base)?.text ?? l.sign),
            place: l.location,
            byDefault: true,
            missing: false,
        }));
    }
    if (game === "thps4") {
        const levels = module.LEVELS as readonly string[];
        const info = module.INFO as Readonly<Record<string, readonly [string, string]>>;
        return levels.map((name) => ({
            id: name,
            title: titleCase(levelSelect.THPS4_LEVELS.get(name)?.text ?? name),
            place: info[name.toLowerCase()]?.[0] ?? "",
            byDefault: true,
            missing: !hasFolder(folder, "data", "levels", name),
        }));
    }
    const rows = module.LEVELS as readonly Row[];
    const table = game === "thps3" ? levelSelect.THPS3_LEVELS : game === "thaw" ? levelSelect.THAW_LEVELS : null;
    return rows.map((row) => ({
        id: row[0],
        title: titleCase(table?.get(row[0])?.text ?? row[1]),
        place: row[2],
        byDefault: row[5],
        missing: game === "thps3" ? !hasFolder(folder, "Data", "Levels", row[0]) : false,
    }));
}

interface ManifestEntry {
    folder?: string;
    level?: string;
    load?: string;
}

// The levels already converted into <thug2>\<staging>: their folder / level names (lower case) -> load script name.
export function importedLevels(thug2: string, game: Game): Map<string, string> {
    const imported = new Map<string, string>();
    let manifest: { levels?: ManifestEntry[] };
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(thug2, GAMES[game].staging, MANIFEST), "utf-8"));
    } catch {
        return imported;
    }
    for (const entry of manifest.levels ?? []) {
        const name = entry.load ?? entry.level;
        if (typeof name !== "string") continue;
        for (const key of [entry.folder, entry.level])
            if (typeof key === "string") imported.set(key.toLowerCase(), `Load_${name}`);
    }
    return imported;
}

// A field of a list line: tabs and line ends can't be in it.
const field = (text: string): string => text.replace(/[\t\r\n]+/g, " ").trim() || "-";

export function levelLine(level: Level, load: string | undefined, retail = "-"): string {
    const flags = [level.byDefault ? "default" : "", load ? "imported" : "", level.missing ? "missing" : ""].filter(
        (f) => f,
    );
    return ["level", level.id, level.title, level.place, flags.join(",") || "-", load ?? "-", retail]
        .map(field)
        .join("\t");
}

const gameLine = (found: Detected): string =>
    ["game", found.game, GAMES[found.game].title, found.folder].map(field).join("\t");

// The folder as a game (--game: that game's, checked; else detected), or exit with what is wrong.
function resolveGame(folder: string, game: string | undefined): Detected {
    if (game !== undefined) {
        if (!(game in GAMES)) exitWith(`--game: one of ${Object.keys(GAMES).join(", ")}`);
        const found = findGame(folder, game as Game);
        if (found === null) exitWith(`No ${GAMES[game as Game].title} files in ${folder}`);
        return { game: game as Game, folder: found };
    }
    const found = detect(folder);
    if (found === "thug2") exitWith(`${folder} is a THUG2 install - choose the folder of the game to import from`);
    if (found === null) {
        exitWith(
            `No game found in ${folder} - choose the install folder of THPS2, THPS3, THPS4, THUG, THAW, Project 8 or Proving Ground`,
        );
    }
    return found;
}

const runNode = (args: readonly string[]): number =>
    spawnSync(process.execPath, args, { stdio: "inherit" }).status ?? 1;

// What make_menu_level makes only on request (kept from the overlay that was there).
export const KEPT = ["hd_ui", path.join("frontend", "fonts")];

function overlay(thug2: string, games: Partial<Record<Game, string>>): number {
    const out = path.join(thug2, "thug2-decomp-data");
    const aside = path.join(thug2, "thug2-decomp-data.kept");
    fs.rmSync(aside, { recursive: true, force: true });
    const kept: string[] = [];
    for (const part of KEPT) {
        if (!isDir(path.join(out, part))) continue;
        fs.mkdirSync(path.dirname(path.join(aside, part)), { recursive: true });
        fs.renameSync(path.join(out, part), path.join(aside, part));
        kept.push(part);
    }
    const args = [path.join(PIPELINE, "menu_level", "make_menu_level.ts"), "--game", thug2];
    const choices = path.join(thug2, "thug2-decomp-art.txt");
    if (fs.existsSync(choices)) args.push("--art-choices", choices);
    for (const game of LOADING_ART_GAMES) if (games[game]) args.push(`--${game}`, games[game]);
    const status = runNode(args);
    // (put back whatever happened: a failed run leaves the overlay as far as it got)
    for (const part of kept) {
        const target = path.join(out, part);
        if (isDir(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(path.join(aside, part), target);
        print(`kept ${target}`);
    }
    fs.rmSync(aside, { recursive: true, force: true });
    return status;
}

const USAGE =
    "usage: import_levels.ts {detect,list,convert,overlay} [folder] [levels ...] [--game GAME] [--thug2 THUG2] [--thps2 ... --thp8 FOLDER]";

async function main(): Promise<number> {
    const { values, positionals } = parseCli(USAGE, {
        allowPositionals: true,
        options: {
            game: { type: "string" },
            thug2: { type: "string" },
            ...Object.fromEntries(LOADING_ART_GAMES.map((g) => [g, { type: "string" as const }])),
        },
    });
    const [command, folder, ...levels] = positionals;
    const thug2 = values.thug2;
    if (command === "overlay") {
        if (!thug2) exitWith("overlay: --thug2 <folder> is needed");
        const games: Partial<Record<Game, string>> = {};
        for (const g of LOADING_ART_GAMES) {
            const given = (values as Record<string, string | undefined>)[g];
            if (given) games[g] = given;
        }
        return overlay(thug2, games);
    }
    if (!folder || !["detect", "list", "convert"].includes(command ?? "")) exitWith(USAGE);
    const found = resolveGame(folder, command === "detect" ? undefined : values.game);
    print(gameLine(found));
    if (command === "detect") return 0;
    if (command === "list") {
        const imported = thug2 ? importedLevels(thug2, found.game) : new Map<string, string>();
        for (const level of await levelsOf(found.game, found.folder)) {
            print(levelLine(level, imported.get(level.id.toLowerCase())));
        }
        return 0;
    }
    if (!thug2) exitWith("convert: --thug2 <folder> is needed");
    if (!levels.length) exitWith("convert: no levels given");
    const file = toolFile(GAMES[found.game].tool);
    if (file === null) exitWith(`${GAMES[found.game].tool}: the converter isn't installed`);
    // (the source game's folder only read: the converter writes into <thug2>\<staging>)
    return runNode([file, "convert", ...levels, GAMES[found.game].option, found.folder, "--thug2", thug2]);
}

if (isMain(import.meta.url)) await runMain(() => main());
