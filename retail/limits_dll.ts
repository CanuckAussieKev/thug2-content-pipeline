// NOT ORIGINAL - the retail export's limits DLL: the THUG2 decompilation's retail-limits patch (its src/retail_limits:
// a dinput8.dll that raises the original game's script pools, heaps and name tables while the game runs) put next to
// THUG2.exe with the levels that need it, and taken out again (retail_export.ts --raised-limits).
//
// What it does in the game folder (each step recorded in the export's state.json, undone by uninstall):
//   dinput8.dll         ours (from --limits-dll, else retail_limits\dinput8.dll beside the pipeline's folder - the level
//                       editor's tools folder has it there). Another dinput8.dll already there (a mod's) is renamed
//                       (dinput8_chained.dll) and chained: thug2-limits.ini [loader] chain= names it, so the game's
//                       DirectInput still goes through it. An older limits DLL there is kept in the state folder and
//                       put back by uninstall; the same one as ours is left as it is (not ours to take out).
//   thug2-limits.ini    written only to chain a renamed DLL (or its chain= set, the file's bytes kept to put back);
//                       otherwise the DLL writes its own on its first start.
//   thug2-limits.ini / thug2-limits.log that the DLL wrote are removed with it when they weren't there before.
// Nothing is ever deleted that isn't ours: a file changed since we wrote it is left in place (and said so).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const DLL = "dinput8.dll";
export const INI = "thug2-limits.ini";
export const LOG = "thug2-limits.log";
export const CHAINED = "dinput8_chained.dll";
const STATE_SUBFOLDER = "limits";
// (a limits DLL has its settings' and log's names in it)
const MARKERS = [INI, LOG].map((s) => Buffer.from(s, "latin1"));
const PE_I386 = 0x14c;

// What the export did about the DLL (state.json's `limits`).
export interface LimitsState {
    dll: { sha256: string; installed: boolean }; // installed: false - the same DLL was there already (not ours)
    replaced?: { backup: string; sha256: string }; // an older limits DLL that was there (kept in the state folder)
    chained?: { name: string; sha256: string }; // another dinput8.dll, renamed and chained
    ini?: { created: boolean; backup?: string; sha256: string }; // the ini as we left it (created: not there before)
    hadIni: boolean; // thug2-limits.ini there before the install
    hadLog: boolean; // thug2-limits.log there before the install
}

export const sha256Of = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const sha256 = sha256Of;

export function isLimitsDll(data: Uint8Array): boolean {
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return MARKERS.every((m) => b.includes(m));
}

// The machine of a PE file (0x14c: 32-bit x86), or null.
export function peMachine(data: Uint8Array): number | null {
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return null;
    const pe = b.readUInt32LE(0x3c);
    if (pe + 6 > b.length || b.readUInt32LE(pe) !== 0x4550) return null;
    return b.readUInt16LE(pe + 4);
}

// The DLL to install: `given`, else the editor tools folder's (retail_limits\dinput8.dll beside the pipeline's folder).
export function findDll(given: string | undefined, pipelineFolder: string): string | null {
    const file = given ?? path.join(pipelineFolder, "..", "retail_limits", DLL);
    return fs.existsSync(file) ? file : null;
}

// A limits DLL in the game folder now (ours or the player's own).
export function hasLimitsDll(game: string): boolean {
    const file = path.join(game, DLL);
    return fs.existsSync(file) && isLimitsDll(fs.readFileSync(file));
}

// Why a DLL file can't be installed (null: it can).
export function dllProblem(data: Uint8Array): string | null {
    if (peMachine(data) !== PE_I386) return "not a 32-bit Windows DLL (the original game is 32-bit: an x86 build's)";
    if (!isLimitsDll(data)) return "not the retail-limits DLL";
    return null;
}

// The ini's [loader] chain= set to `name` (the line added when there is none).
export function withChain(text: string, name: string): string {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const out = text.split(/\r?\n/);
    let section = "";
    let loaderAt = -1;
    for (let i = 0; i < out.length; i++) {
        const line = out[i]!.trim();
        const head = /^\[(.*)\]$/.exec(line);
        if (head) {
            section = head[1]!.trim().toLowerCase();
            if (section === "loader") loaderAt = i;
            continue;
        }
        if (section === "loader" && /^chain\s*=/i.test(line)) {
            out[i] = `chain=${name}`;
            return out.join(eol);
        }
    }
    if (loaderAt >= 0) {
        out.splice(loaderAt + 1, 0, `chain=${name}`);
        return out.join(eol);
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return [...out, "", "[loader]", `chain=${name}`, ""].join(eol);
}

// The ini's [loader] chain= ("" when it has none).
export function chainOf(text: string): string {
    let section = "";
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const head = /^\[(.*)\]$/.exec(line);
        if (head) section = head[1]!.trim().toLowerCase();
        else if (section === "loader" && /^chain\s*=/i.test(line)) return line.slice(line.indexOf("=") + 1).trim();
    }
    return "";
}

// The ini written to chain a renamed DLL when the folder has none (the DLL fills in nothing more: its defaults are on).
export function chainIni(name: string): string {
    return [
        "; The original game's limits raised for large levels (thug2-limits.log says what was done).",
        "; 1 = on, 0 = off.",
        "[limits]",
        "enabled=1",
        "script_pools=1",
        "hash_items=1",
        "script_heap=1",
        "node_hash=1",
        "rail_table=1",
        "shadow_buffers=1",
        "",
        "[loader]",
        "; the game folder's own dinput8.dll, renamed by the retail export: DirectInput goes through it",
        `chain=${name}`,
        "",
    ].join("\r\n");
}

function freeName(game: string, wanted: string): string {
    if (!fs.existsSync(path.join(game, wanted))) return wanted;
    const stem = wanted.replace(/\.dll$/i, "");
    for (let n = 2; ; n++) if (!fs.existsSync(path.join(game, `${stem}${n}.dll`))) return `${stem}${n}.dll`;
}

export interface LimitsPlan {
    state: LimitsState;
    lines: string[];
    run: () => void; // the writes (after every check of the export has passed)
}

// The install of `dll` (its bytes) into `game`; `stateDir`: the export's state folder. Nothing is written until run().
export function planInstall(game: string, stateDir: string, dll: Buffer): LimitsPlan {
    const target = path.join(game, DLL);
    const iniFile = path.join(game, INI);
    const hadIni = fs.existsSync(iniFile);
    const hadLog = fs.existsSync(path.join(game, LOG));
    const ours = sha256(dll);
    const lines: string[] = [];
    const steps: (() => void)[] = [];
    const state: LimitsState = { dll: { sha256: ours, installed: true }, hadIni, hadLog };
    if (fs.existsSync(target)) {
        const there = fs.readFileSync(target);
        if (there.equals(dll)) {
            state.dll.installed = false;
            lines.push(`${DLL}: this limits DLL is there already (left as it is)`);
            return { state, lines, run: () => {} };
        }
        if (isLimitsDll(there)) {
            const backup = `${STATE_SUBFOLDER}/${DLL}.original`;
            state.replaced = { backup, sha256: sha256(there) };
            lines.push(`${DLL}: another build of the limits DLL there - replaced (kept to put back on uninstall)`);
            steps.push(() => {
                fs.mkdirSync(path.join(stateDir, STATE_SUBFOLDER), { recursive: true });
                fs.writeFileSync(path.join(stateDir, ...backup.split("/")), there);
            });
        } else {
            const name = freeName(game, CHAINED);
            state.chained = { name, sha256: sha256(there) };
            lines.push(`${DLL}: the folder's own ${DLL} renamed ${name} and chained ([loader] chain=${name})`);
            const before = hadIni ? fs.readFileSync(iniFile) : null;
            const text = before ? withChain(before.toString("latin1"), name) : chainIni(name);
            const data = Buffer.from(text, "latin1");
            if (before) {
                const backup = `${STATE_SUBFOLDER}/${INI}.original`;
                state.ini = { created: false, backup, sha256: sha256(data) };
                steps.push(() => {
                    fs.mkdirSync(path.join(stateDir, STATE_SUBFOLDER), { recursive: true });
                    fs.writeFileSync(path.join(stateDir, ...backup.split("/")), before);
                });
            } else {
                state.ini = { created: true, sha256: sha256(data) };
            }
            steps.push(() => {
                fs.renameSync(target, path.join(game, name));
                fs.writeFileSync(iniFile, data);
            });
        }
    } else {
        lines.push(`${DLL}: the limits DLL installed beside the game's exe`);
    }
    steps.push(() => {
        const temp = `${target}.retail-export-tmp`;
        fs.writeFileSync(temp, dll);
        fs.renameSync(temp, target);
    });
    return {
        state,
        lines,
        run: () => {
            for (const step of steps) step();
        },
    };
}

// What uninstall would leave in place (a file changed since we wrote it): checked before anything is written.
export function uninstallProblems(game: string, state: LimitsState): string[] {
    const problems: string[] = [];
    if (state.chained && fs.existsSync(path.join(game, state.chained.name))) {
        const now = sha256(fs.readFileSync(path.join(game, state.chained.name)));
        if (now !== state.chained.sha256) problems.push(`${state.chained.name} changed since it was renamed`);
    }
    return problems;
}

// Uninstall: our DLL out, the folder's own back. Returns what was done.
export function uninstall(game: string, stateDir: string, state: LimitsState): string[] {
    const lines: string[] = [];
    const target = path.join(game, DLL);
    if (!state.dll.installed) return [`${DLL}: left as it is (it was there before the export)`];
    let removed = false;
    if (fs.existsSync(target)) {
        if (sha256(fs.readFileSync(target)) === state.dll.sha256) {
            fs.rmSync(target);
            removed = true;
        } else {
            lines.push(`${DLL}: left in place (changed since the export put it there)`);
        }
    } else {
        removed = true;
    }
    if (removed && state.replaced) {
        const backup = path.join(stateDir, ...state.replaced.backup.split("/"));
        if (fs.existsSync(backup)) {
            fs.renameSync(backup, target);
            lines.push(`${DLL}: the limits DLL that was there before put back`);
        }
    } else if (removed && state.chained) {
        const chained = path.join(game, state.chained.name);
        if (fs.existsSync(chained)) {
            fs.renameSync(chained, target);
            lines.push(`${DLL}: the folder's own put back (was ${state.chained.name})`);
        }
    } else if (removed) {
        lines.push(`${DLL}: the limits DLL taken out`);
    }
    if (!removed) return lines;
    const iniFile = path.join(game, INI);
    if (state.ini?.backup) {
        const backup = path.join(stateDir, ...state.ini.backup.split("/"));
        if (fs.existsSync(iniFile) && fs.existsSync(backup)) {
            const now = fs.readFileSync(iniFile);
            if (sha256(now) === state.ini.sha256) fs.copyFileSync(backup, iniFile);
            else {
                // (changed since: only chain= put back as it was)
                const before = chainOf(fs.readFileSync(backup).toString("latin1"));
                fs.writeFileSync(iniFile, withChain(now.toString("latin1"), before), "latin1");
            }
        }
    } else if (!state.hadIni && fs.existsSync(iniFile)) {
        // (ours or the DLL's own, written at its first start: it goes with the DLL)
        fs.rmSync(iniFile);
    }
    if (!state.hadLog) fs.rmSync(path.join(game, LOG), { force: true });
    fs.rmSync(path.join(stateDir, STATE_SUBFOLDER), { recursive: true, force: true });
    return lines;
}
