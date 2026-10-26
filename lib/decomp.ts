// NOT ORIGINAL - where this repository and the THUG2 decompilation checkout around it are.
//
// This repository is the decomp's submodule tools/pipeline, but it can be cloned alone. Every path into the decomp
// comes from here, found by walking up from this repository to the first folder with the decomp's CMakeLists.txt and
// src/game (or THUG2_DECOMP=<folder>), never by a fixed number of folders up:
//   - PIPELINE: this repository's root (lib/..), for its own data (compat/, fonts/, menu_level/scenic_art/...);
//   - DECOMP: the decomp's root, or null when this repository is on its own;
//   - WORK: where out/ goes (the decomp's out/ - what the tools always used -, else this repository's out/);
//   - NS_DEFAULT: NeverScript's ns.exe, built by the decomp's tools\build_neverscript.ps1 into out\neverscript;
//   - needDecomp(why): the decomp's root, or exit 1 with a message saying this tool needs the decomp checkout and why.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PIPELINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const isDecompRoot = (dir: string): boolean =>
    fs.existsSync(path.join(dir, "CMakeLists.txt")) && fs.existsSync(path.join(dir, "src", "game"));

// The decomp's root: THUG2_DECOMP if set (it must be one), else the nearest folder above this repository that is one.
export function findDecompRoot(start: string = PIPELINE): string | null {
    const env = process.env.THUG2_DECOMP;
    if (env) return isDecompRoot(env) ? path.resolve(env) : null;
    for (let dir = path.dirname(path.resolve(start)); ; dir = path.dirname(dir)) {
        if (isDecompRoot(dir)) return dir;
        if (path.dirname(dir) === dir) return null;
    }
}

export const DECOMP: string | null = findDecompRoot();
export const WORK: string = DECOMP ?? PIPELINE;
export const NS_DEFAULT: string = path.join(WORK, "out", "neverscript", "ns.exe");

export const NEEDS_DECOMP =
    "it needs the THUG2 decompilation checkout around this repository (github.com/CanuckAussieKev/thug2-decomp, " +
    "with this repository as its submodule tools/pipeline), or THUG2_DECOMP=<its folder>";

// The decomp's root for a tool that can't work without it; `why` says what it reads there ("src/game/*.cpp").
export function needDecomp(why: string): string {
    if (DECOMP) return DECOMP;
    process.stderr.write(`error: this tool reads the decomp's ${why}: ${NEEDS_DECOMP}\n`);
    process.exit(1);
}

// The message for a missing ns.exe (the converters' and builders' --ns).
export const nsMissing = (ns: string): string =>
    DECOMP
        ? `${ns} not found: build it with tools\\build_neverscript.ps1 (in the decomp) or pass --ns`
        : `${ns} not found: NeverScript's ns.exe is built by the THUG2 decomp (tools\\build_neverscript.ps1); pass --ns <ns.exe>`;

// The decomp checkout's local.json (gitignored - this machine's settings, the decomp's README "Contributing"):
//   referenceExe   the reference build of THUG2.exe the decompilation's addresses come from (the tools that read the
//                  original code default to it);
//   exeNames       other exe names a game folder may have besides THUG2.exe (the game tools accept them too);
//   ghidraProject / ghidraProgram   the Ghidra project's and program's names (tools/ghidra);
//   protectedFolders   folders the tools never write into (backups you keep), besides the built-in ones.
export interface LocalConfig {
    referenceExe?: string;
    exeNames?: string[];
    ghidraProject?: string;
    ghidraProgram?: string;
    protectedFolders?: string[];
}

function readLocal(): LocalConfig {
    const file = DECOMP ? path.join(DECOMP, "local.json") : "";
    if (!file || !fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf-8")) as LocalConfig;
}

export const LOCAL: LocalConfig = readLocal();
// The names a game folder's exe may have: THUG2.exe, then local.json's exeNames.
export const GAME_EXE_NAMES: readonly string[] = ["THUG2.exe", ...(LOCAL.exeNames ?? [])];

// The reference build's path for a tool's default (`--exe` and the like): local.json's referenceExe, or "" (the tool
// then asks for it).
export const REFERENCE_EXE: string = LOCAL.referenceExe ?? "";

// Folders nothing is ever written into, lower case without a trailing separator: an untouched backup install,
// THUGPRO's install, and local.json's protectedFolders.
export const NEVER_WRITTEN: readonly string[] = [
    "c:\\games\\thug2-backup",
    "c:\\games\\thugpro",
    ...(LOCAL.protectedFolders ?? []).map((f) =>
        path
            .resolve(f)
            .toLowerCase()
            .replace(/[\\/]+$/, ""),
    ),
];
