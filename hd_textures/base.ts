// NOT ORIGINAL - HD textures for the base game: every level texture dictionary (.tex.xbx) of the game (Data's - loose
// in every install, packed or unpacked by tools/qbjs/unpack_game.ts) and of our overlays (thug2-decomp-<x>\levels:
// the ported levels, the data overlay's own) upscaled by 4 with one of two AI models (models.ts: PBRify UpscalerV4 or
// SeedVR2-3B, run by upscale.py on the local NVIDIA GPU), installed, and taken out again on --restore. No file the
// game was installed with or our overlays hold is written: each model's set is a folder of its own beside them,
// <game>\thug2-decomp-textures\<model>\, holding a dictionary's HD version under the name the game asks for
// (levels\bo\bo.tex.xbx - relative to Data or to the data overlay, lower case). Both sets can be installed at once; the
// game reads the one [Graphics] texture_set names (original - the default -, pbrify, seedvr2) before the data overlay
// and Data, and switches between them while it runs (the Options screen, the console's `textures <set>`:
// src/engine/gfx/texture_sets.h).
//
//   node tools/pipeline/hd_textures/base.ts --game <folder> --model pbrify|seedvr2|none [--levels BO,AU,foun]
//        [--scope levels|all] [--build-only] [--no-match] [--no-select] [--vram-gb 10]
//   node tools/pipeline/hd_textures/base.ts --game <folder> --remove pbrify|seedvr2
//   node tools/pipeline/hd_textures/base.ts --game <folder> --restore | --status
//
// --model installs that model's set (made first where its cache doesn't have it yet; the set's folder made again -
// the other model's set is left as it is) and selects it ([Graphics] texture_set in the game folder's
// thug2-decomp.ini; --no-select leaves the ini alone); none takes every set out, as --restore does (the ini's
// texture_set too). --remove takes one set out (texture_set too when it names that set). --levels: only those levels
// (each with its _Sky); --scope all: every .tex.xbx (peds, skaters, vehicles, props too) - the default is the levels'
// dictionaries. --build-only fills the model's cache without installing anything. unpack_game.ts --hd-textures
// <model> runs the same after unpacking. --no-match keeps the model's own colours and contrast (default: every 4 x 4
// block pulled back to the original texel - which also brings back a faint trace of the original's DXT blocks); its
// files are a set of their own in the cache (made from the same model output: no model run). --status lists the
// installed sets, the one selected and any file whose original changed since its set was made (a level converted
// again: install the set again).
//
// Per texture (thug2-level-converter-core level_port/hd_textures.ts does the per-texture work, as for converted
// levels; this adds what the base game needs):
// - tiling found by edge continuity (detectWrap): the texture wraps in u (v) when the step from its last column (row)
//   to its first is no larger than its typical step between neighbouring columns (rows) - the materials' own
//   addressing isn't read; the model then sees the other edge as padding, so tiled surfaces show no seams;
// - atlases (several pictures packed in one texture) found from the meshes beside the dictionary - the uv rectangles
//   their material passes use, clustered into regions - and upscaled region by region, each padded with its own
//   edges, with region-aware mips (atlas.ts): wrap padding and the model's reach would mix neighbouring pictures;
//   a texture no mesh uses falls back to the seam heuristic (detectAtlas: a hard straight seam right across, well
//   inside, between two sides that are different pictures) and such an atlas is left as it was; both listed;
// - colour through the model (RGB: neither model takes alpha), alpha on its own: cut-outs scaled bilinearly and
//   thresholded, soft alpha through the model as grey, opaque stays opaque (core);
// - textures under 32 texels on their longer side left alone (decals, lights, gradients - the models invent
//   noise there), the longer side capped at 1024 (a 512 texture x2, 1024 and up left alone);
// - only .tex.xbx: the 2D images (.img.xbx) and fonts (.fnt.xbx) are the menus', which have their own HD path (hd_ui);
// - the result pulled back so every 4 x 4 block averages to the original texel (colours and contrast kept), a full
//   mip chain made again, written as DXT1 / DXT5 as it came (a 32-bit one compressed: DXT1, DXT1 with 1-bit alpha,
//   DXT5). BC7 isn't used: the Direct3D 9 renderer has no BC7 and the texture loaders know DXT1 / 3 / 5 only.
//
// Caches (out\hd_textures\base\<model>\, git-ignored): `texels` the model's output per texture (core's cache), `files`
// each finished dictionary by the SHA-256 of the original's bytes and the settings - installing a set that was made
// once is a copy. Each set's record (<game>\thug2-decomp-textures\<model>\set.json) lists its files by the game's name
// with the SHA-256 of the original it was made from and of the file itself. Only the dictionaries the game reads are in
// a set: Data's and the data overlay's (a converter's own output folder, thug2-decomp-<game>, is copied into the data
// overlay by make_menu_level.ts - that copy is the one taken).
//
// Earlier versions wrote the HD files into the data overlay and over our overlays' own files (the record
// thug2-decomp-backup\hd_textures\record.json); such an install is put back first by every install and --restore
// (restoreLegacy: added files removed, replaced ones put back unless they changed since).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as hd from "thug2-level-converter-core/level_port/hd_textures.ts";
import { readTex, type TexFile, type Texture, writeTex } from "thug2-level-converter-core/level_port/tex.ts";
import { exitWith, helpFromHeader, isMain, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { decodePng, encodePng, type Image } from "thug2-level-converter-core/lib/frame_diff.ts";
import * as atlas from "./atlas.ts";
import {
    HD_DIR,
    isModelName,
    MODEL_NAMES,
    MODELS,
    MODELS_DIR,
    type ModelName,
    PYTHON,
    RUNNER,
    seedvr2Code,
} from "./models.ts";

// bumped whenever this pass makes different files from the same input (the files cache keys on it)
export const BASE_VERSION = 2;
export const MIN_SIZE = 32;
export const MAX_SIZE = 1024;
// textures per call of the model (one model load each; bounds the memory the upscaled texels take)
const CHUNK = 160;
export const BACKUP = "thug2-decomp-backup";
export const HD_BACKUP = path.join(BACKUP, "hd_textures");

// ---- analysis ----

// The mean RGB step (0-255, averaged over the channels) between column a and column b, over the texture's height.
function columnStep(bgra: Uint8Array, w: number, h: number, a: number, b: number): number {
    let sum = 0;
    for (let y = 0; y < h; y++) {
        const i = (y * w + a) * 4;
        const j = (y * w + b) * 4;
        sum +=
            Math.abs(bgra[i]! - bgra[j]!) +
            Math.abs(bgra[i + 1]! - bgra[j + 1]!) +
            Math.abs(bgra[i + 2]! - bgra[j + 2]!);
    }
    return sum / (3 * h);
}

function rowStep(bgra: Uint8Array, w: number, a: number, b: number): number {
    let sum = 0;
    for (let x = 0; x < w; x++) {
        const i = (a * w + x) * 4;
        const j = (b * w + x) * 4;
        sum +=
            Math.abs(bgra[i]! - bgra[j]!) +
            Math.abs(bgra[i + 1]! - bgra[j + 1]!) +
            Math.abs(bgra[i + 2]! - bgra[j + 2]!);
    }
    return sum / (3 * w);
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export interface Seams {
    edgeU: number; // the step from the last column to the first
    edgeV: number; // ... last row to the first
    stepU: number; // the median step between neighbouring columns
    stepV: number; // ... rows
    columns: number[]; // every step between neighbouring columns (index x: x-1 to x; 0 unused)
    rows: number[];
}

export function seams(bgra: Uint8Array, w: number, h: number): Seams {
    const columns = [0];
    for (let x = 1; x < w; x++) columns.push(columnStep(bgra, w, h, x - 1, x));
    const rows = [0];
    for (let y = 1; y < h; y++) rows.push(rowStep(bgra, w, y - 1, y));
    return {
        edgeU: columnStep(bgra, w, h, w - 1, 0),
        edgeV: rowStep(bgra, w, h - 1, 0),
        stepU: median(columns.slice(1)),
        stepV: median(rows.slice(1)),
        columns,
        rows,
    };
}

// Tiling by edge continuity: a texture whose far edge meets its near one as smoothly as its neighbouring texels meet
// (within twice the typical step, plus a little for flat textures) is taken to wrap that way.
export function detectWrap(bgra: Uint8Array, w: number, h: number): hd.Addressing {
    if (w < 4 || h < 4) return { wrapU: true, wrapV: true };
    const s = seams(bgra, w, h);
    return { wrapU: s.edgeU <= 2 * s.stepU + 3, wrapV: s.edgeV <= 2 * s.stepV + 3 };
}

// The mean colour (0-255, the channels averaged) of the visible texels in a rectangle; null when none is visible.
function meanColour(bgra: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): number[] | null {
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            if (bgra[i + 3]! <= 8) continue;
            for (let k = 0; k < 3; k++) sum[k] = sum[k]! + bgra[i + k]!;
            n++;
        }
    return n ? sum.map((v) => v / n) : null;
}

// Whether the texture repeats along y (rows; `columns`: along x) within itself: shifted by some p (up to half the
// size) its rows are far more alike than at a smaller shift - rows of windows, stripes, planks. (Two different
// pictures stacked grow less alike the further they're shifted: no dip.)
function repeats(c: Uint8Array, w: number, h: number, columns: boolean): boolean {
    const size = columns ? w : h;
    let worst = 0;
    for (let p = 1; p <= size / 2; p++) {
        let sum = 0;
        for (let a = 0; a + p < size; a++) sum += columns ? columnStep(c, w, h, a, a + p) : rowStep(c, w, a, a + p);
        const step = sum / (size - p);
        if (p > 1 && step < 0.35 * worst) return true;
        worst = Math.max(worst, step);
    }
    return false;
}

// An atlas (several different images packed side by side in one texture), or null: the reason it was taken for one -
// a straight seam right across, well inside (not a border or trim within an eighth of the size from an edge), far
// stronger than the texture's typical step, a jump at nearly every texel along it, the two sides different pictures
// (their mean colours far apart) and the texture not a repeating pattern that way (rows of windows, stripes). Colour
// under transparent texels does not count (filled from the visible neighbours first, as the pass does); cut-out
// sheets - images apart on transparent texels - are not atlases here: the gaps keep them apart.
export function detectAtlas(bgra: Uint8Array, w: number, h: number): string | null {
    if (w < 16 || h < 16) return null;
    const c = hd.fillHidden(bgra, w, h, true, true);
    const s = seams(c, w, h);
    const jumpsAlong = (x: number | null, y: number | null, limit: number): number => {
        let n = 0;
        const count = x !== null ? h : w;
        for (let k = 0; k < count; k++) {
            const i = x !== null ? (k * w + x - 1) * 4 : ((y! - 1) * w + k) * 4;
            const j = x !== null ? (k * w + x) * 4 : (y! * w + k) * 4;
            const d = (Math.abs(c[i]! - c[j]!) + Math.abs(c[i + 1]! - c[j + 1]!) + Math.abs(c[i + 2]! - c[j + 2]!)) / 3;
            if (d > limit) n++;
        }
        return n / count;
    };
    const apart = (a: number[] | null, b: number[] | null): boolean =>
        a !== null &&
        b !== null &&
        (Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!)) / 3 > 24;
    for (let x = Math.ceil(w / 8); x <= w - Math.ceil(w / 8); x++) {
        if (s.columns[x]! <= Math.max(8 * s.stepU, 40) || jumpsAlong(x, null, Math.max(3 * s.stepU, 16)) < 0.9)
            continue;
        if (!apart(meanColour(bgra, w, 0, 0, x, h), meanColour(bgra, w, x, 0, w, h))) continue;
        if (repeats(c, w, h, true)) break;
        return `seam at column ${x}`;
    }
    for (let y = Math.ceil(h / 8); y <= h - Math.ceil(h / 8); y++) {
        if (s.rows[y]! <= Math.max(8 * s.stepV, 40) || jumpsAlong(null, y, Math.max(3 * s.stepV, 16)) < 0.9) continue;
        if (!apart(meanColour(bgra, w, 0, 0, w, y), meanColour(bgra, w, 0, y, w, h))) continue;
        if (repeats(c, w, h, false)) break;
        return `seam at row ${y}`;
    }
    return null;
}

// A texture this pass may upscale: a format core handles, its longer side within MIN_SIZE .. MAX_SIZE.
export function handledTexture(t: Texture): boolean {
    const format = !t.palette.length && [0, 1, 2, 5].includes(t.dxt) && (t.dxt !== 0 || t.texelDepth === 32);
    return format && Math.max(t.width, t.height) >= MIN_SIZE && Math.max(t.width, t.height) < MAX_SIZE;
}

// ---- the files ----

export const OVERLAY = "thug2-decomp-data";

export interface TexEntry {
    rel: string; // the original, under the game's root
    target: string; // where its HD version goes, under the game's root: Data's in the data overlay, an overlay's in place
    level: string; // the level folder's name (lower case; "" outside levels)
}

const walk = (dir: string): string[] =>
    !fs.existsSync(dir)
        ? []
        : fs
              .readdirSync(dir, { withFileTypes: true })
              .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// The folders holding game data: Data and our overlays (thug2-decomp-<x> with a levels or models folder).
export function dataFolders(root: string): string[] {
    const overlays = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
            (e) =>
                e.isDirectory() &&
                /^thug2-decomp-/i.test(e.name) &&
                !/^thug2-decomp-(backup|check|textures)/i.test(e.name) &&
                ["levels", "models"].some((sub) => fs.existsSync(path.join(root, e.name, sub))),
        )
        .map((e) => e.name);
    return ["Data", ...overlays];
}

// The texture dictionaries and where each one's HD version goes. A Data file's goes into the data overlay at the
// same path (the game reads the overlay before its archives and Data: src/engine/file/data_overlay.h) - no file the
// game was installed with is ever written; one the overlay has already (make_menu_level.ts's) is taken from there.
export function collect(root: string, scope: "levels" | "all", levels: readonly string[] | null): TexEntry[] {
    const wanted = levels ? new Set(levels.flatMap((l) => [l.toLowerCase(), `${l.toLowerCase()}_sky`])) : null;
    const out: TexEntry[] = [];
    const taken = new Set<string>();
    // (an HD set's files added to the data overlay are Data's: not originals)
    const added = new Set(
        (readRecord(root)?.files ?? []).filter((f) => f.original === null).map((f) => f.target.toLowerCase()),
    );
    // (the overlays first: a Data file the data overlay holds already is the overlay's)
    for (const folder of [...dataFolders(root).slice(1), "Data"]) {
        for (const file of walk(path.join(root, folder))) {
            if (!/\.tex\.xbx$/i.test(file) || added.has(path.relative(root, file).toLowerCase())) continue;
            const inFolder = path.relative(path.join(root, folder), file);
            const parts = inFolder.split(path.sep);
            const inLevels = parts.length >= 3 && parts[0]!.toLowerCase() === "levels";
            const level = inLevels ? parts[1]!.toLowerCase() : "";
            if (scope === "levels" && !inLevels) continue;
            if (wanted && !wanted.has(level)) continue;
            const target = folder === "Data" ? path.join(OVERLAY, inFolder) : path.relative(root, file);
            if (taken.has(target.toLowerCase())) continue;
            taken.add(target.toLowerCase());
            out.push({ rel: path.relative(root, file), target, level });
        }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ---- the sets ----

export const SETS_DIR = "thug2-decomp-textures";
export const SET_RECORD = "set.json";
const SEARCH_FOLDERS = ["anteara\\front_end\\", "anteara\\", "front_end\\", "hd_ui\\"];

// A set's record: name - the game's name for the file (relative to Data or the data overlay, lower case, '\'), as
// the set's folder holds it; original - the SHA-256 of the dictionary it was made from; installed - the HD file's.
export interface SetRecord {
    model: ModelName;
    match: boolean; // (false: --no-match)
    files: { name: string; original: string; installed: string }[];
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

// The name the game asks for a dictionary by - Data's relative to Data, the data overlay's relative to the overlay (a
// search folder's - front_end\, anteara\ - without it: the game looks in the set under the plain name), lower case
// with '\' - or null: a folder the game doesn't read (a converter's own output, copied into the data overlay).
export function gameName(e: TexEntry): string | null {
    const rel = e.rel.split(/[\\/]/).join("\\");
    const lower = rel.toLowerCase();
    let name: string | null = null;
    if (lower.startsWith("data\\")) name = lower.slice("data\\".length);
    else if (lower.startsWith(`${OVERLAY}\\`)) {
        name = lower.slice(OVERLAY.length + 1);
        const prefix = SEARCH_FOLDERS.find((p) => name!.startsWith(p));
        if (prefix) name = name.slice(prefix.length);
    }
    return name;
}

export const setFolder = (root: string, model: ModelName): string => path.join(root, SETS_DIR, model);

export function readSet(root: string, model: ModelName): SetRecord | null {
    const file = path.join(setFolder(root, model), SET_RECORD);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as SetRecord) : null;
}

// The sets installed (a folder with its record), in MODEL_NAMES' order.
export function installedSets(root: string): ModelName[] {
    return MODEL_NAMES.filter((m) => readSet(root, m) !== null);
}

// One set taken out: its folder removed (the sets' folder too once empty). Returns its file count (0: it wasn't there).
export function removeSet(root: string, model: ModelName): number {
    const record = readSet(root, model);
    const folder = setFolder(root, model);
    if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
    const sets = path.join(root, SETS_DIR);
    if (fs.existsSync(sets) && fs.readdirSync(sets).length === 0) fs.rmdirSync(sets);
    return record?.files.length ?? 0;
}

// ---- the game folder's ini ([Graphics] texture_set) ----

export const INI = "thug2-decomp.ini";

// The ini text with [section] key = value (null: the key's lines taken out): the first such line replaced in place, or
// a line added after the section's last line that isn't blank (the section added at the end when missing); every
// other line kept, the file's line ending too (\r\n unless it uses \n alone). As the game's Options screen writes it
// (src/frontend/new_frontend_options.h ini_set).
export function iniWith(text: string, section: string, key: string, value: string | null): string {
    const eol = text.includes("\r\n") || !text.includes("\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const endsWithBreak = text === "" || lines[lines.length - 1] === "";
    if (endsWithBreak) lines.pop();
    const keyOf = (line: string): string | null => {
        const t = line.trim();
        if (!t || t.startsWith(";") || t.startsWith("#") || t.startsWith("[")) return null;
        const eq = line.indexOf("=");
        return eq < 0 ? null : line.slice(0, eq).trim().toLowerCase();
    };
    let inSection = false;
    let sectionAt = -1;
    let insertAt = -1;
    let done = false;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i]!.trim();
        if (t.startsWith("[") && t.includes("]")) {
            if (inSection) break;
            inSection = t.slice(1, t.indexOf("]")).trim().toLowerCase() === section.toLowerCase();
            if (inSection) {
                sectionAt = i;
                insertAt = i + 1;
            }
            continue;
        }
        if (!inSection) continue;
        if (keyOf(lines[i]!) === key.toLowerCase()) {
            if (value === null) lines.splice(i--, 1);
            else if (!done) {
                lines[i] = `${lines[i]!.slice(0, lines[i]!.indexOf("=") + 1)}${value}`;
                done = true;
            }
            continue;
        }
        if (t) insertAt = i + 1;
    }
    let appended = false;
    if (value !== null && !done) {
        if (sectionAt >= 0) lines.splice(insertAt, 0, `${key}=${value}`);
        else {
            if (lines.length) lines.push("");
            lines.push(`[${section}]`, `${key}=${value}`);
            appended = true;
        }
    }
    return lines.length ? lines.join(eol) + (endsWithBreak || appended ? eol : "") : "";
}

// [Graphics] texture_set in the game folder's ini (made when it isn't there; null: the key taken out - an ini that
// isn't there left so).
export function selectSet(root: string, model: ModelName | null): void {
    const file = path.join(root, INI);
    if (!fs.existsSync(file) && model === null) return;
    const before = fs.existsSync(file) ? fs.readFileSync(file, "latin1") : "";
    const after = iniWith(before, "Graphics", "texture_set", model);
    if (after !== before) fs.writeFileSync(file, after, "latin1");
}

// The set [Graphics] texture_set names ("original" when none is named).
export function selectedSet(root: string): string {
    const file = path.join(root, INI);
    if (!fs.existsSync(file)) return "original";
    let section = "";
    for (const line of fs.readFileSync(file, "latin1").split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith("[") && t.includes("]")) section = t.slice(1, t.indexOf("]")).trim().toLowerCase();
        else if (section === "graphics" && /^texture_set\s*=/i.test(t))
            return t.slice(t.indexOf("=") + 1).trim() || "original";
    }
    return "original";
}

// ---- earlier versions' installs (the HD files in the data overlay and over our overlays' own) ----

export interface HdRecord {
    model: ModelName;
    match?: boolean;
    files: { target: string; original: string | null; installed: string }[];
}

export function readRecord(root: string): HdRecord | null {
    const file = path.join(root, HD_BACKUP, "record.json");
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as HdRecord) : null;
}

// A dictionary's original bytes: the earlier install's copy while it has replaced it, else the file itself.
export function originalBytes(root: string, e: TexEntry): Buffer {
    const f = readRecord(root)?.files.find((r) => r.target.toLowerCase() === e.target.toLowerCase());
    const current = fs.readFileSync(path.join(root, e.rel));
    if (f && f.original !== null && sha256(current) === f.installed)
        return fs.readFileSync(path.join(root, HD_BACKUP, "originals", f.target));
    return current;
}

// An earlier version's install taken back - an added file removed, a replaced one's original put back - unless it
// changed or went since it was installed (make_menu_level.ts or a converter remade it: theirs is kept); its record and
// originals removed.
export function restoreLegacy(root: string): { restored: number; kept: number } {
    const record = readRecord(root);
    let restored = 0;
    let kept = 0;
    for (const f of record?.files ?? []) {
        const target = path.join(root, f.target);
        if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== f.installed) {
            kept++;
            continue;
        }
        if (f.original === null) {
            fs.rmSync(target);
            // (the folders it alone needed, up to the overlay's own)
            for (let dir = path.dirname(target); path.relative(root, dir).split(path.sep).length > 2; ) {
                if (fs.readdirSync(dir).length) break;
                fs.rmdirSync(dir);
                dir = path.dirname(dir);
            }
        } else fs.copyFileSync(path.join(root, HD_BACKUP, "originals", f.target), target);
        restored++;
    }
    fs.rmSync(path.join(root, HD_BACKUP), { recursive: true, force: true });
    // (thug2-decomp-backup made only for this: removed again)
    const backup = path.join(root, BACKUP);
    if (fs.existsSync(backup) && fs.readdirSync(backup).length === 0) fs.rmdirSync(backup);
    return { restored, kept };
}

// Every set taken out (and an earlier version's install), [Graphics] texture_set too: the originals in use.
export function restore(root: string): { removed: number; restored: number; kept: number } {
    const legacy = restoreLegacy(root);
    let removed = 0;
    for (const model of MODEL_NAMES) removed += removeSet(root, model);
    const sets = path.join(root, SETS_DIR);
    if (fs.existsSync(sets)) fs.rmSync(sets, { recursive: true, force: true });
    selectSet(root, null);
    return { removed, ...legacy };
}

// A set's files whose original changed since it was made (a level converted again, make_menu_level.ts run again):
// "<name>" each.
export function staleFiles(root: string, model: ModelName): string[] {
    const record = readSet(root, model);
    if (!record) return [];
    const now = new Map<string, string>();
    for (const e of collect(root, "all", null)) {
        const name = gameName(e);
        if (name !== null && !now.has(name)) now.set(name, e.rel);
    }
    return record.files
        .filter((f) => {
            const rel = now.get(f.name);
            return rel === undefined || sha256(fs.readFileSync(path.join(root, rel))) !== f.original;
        })
        .map((f) => f.name);
}

// ---- making a set ----

export interface Timing {
    seconds: number;
    peakVramMB: number;
}

export interface BuildOptions {
    cacheRoot: string; // <cache>\<model>\files, \texels
    vramGb: number;
    upscaler?: hd.Upscaler; // (tests: a stand-in for the model)
    log?: (line: string) => void;
    // false: the model's own colours and contrast (default: pulled back to the original's - core's matchOriginal)
    match?: boolean;
    // the uv rectangles of the meshes beside each dictionary (atlases' regions); absent: no mesh is known - every
    // texture goes to the seam heuristic
    scenes?: SceneSource;
}

export function defaultCacheRoot(): string {
    return path.join(HD_DIR, "base");
}

export function hdOptions(model: ModelName, cacheRoot: string, match = true): hd.HdOptions {
    return {
        ...hd.defaultOptions(4),
        match,
        maxSize: MAX_SIZE,
        minSize: MIN_SIZE,
        model: MODELS[model].tag,
        cacheDir: path.join(cacheRoot, model, "texels"),
    };
}

// `scenes`: the signature of the scene files beside the dictionary (atlas.ts UvIndexes - its atlases' regions come
// from them).
export function fileKey(original: Uint8Array, model: ModelName, match = true, scenes = ""): string {
    const h = createHash("sha256");
    const settings = {
        base: BASE_VERSION,
        pass: hd.PASS_VERSION,
        model: MODELS[model].tag,
        MIN_SIZE,
        MAX_SIZE,
        scenes,
    };
    h.update(JSON.stringify(match ? settings : { ...settings, match }));
    h.update(original);
    return h.digest("hex");
}

// The scene files' uv rectangles beside the game's dictionaries (names relative to the game's root).
export function scenesOf(root: string): SceneSource {
    const indexes = new atlas.UvIndexes();
    return (name) => indexes.of(path.join(root, name));
}

export type SceneSource = (name: string) => { index: atlas.UvIndex; signature: string; errors: string[] };

const cachedFile = (cacheRoot: string, model: ModelName, key: string): string =>
    path.join(cacheRoot, model, "files", key.slice(0, 2), `${key}.tex.xbx`);

// The model run over a set of images by upscale.py (one process: the model loads once). Timings per image added to
// `timings`; its output in <cache>\<model>\last-run.log.
export function pythonUpscaler(model: ModelName, cacheRoot: string, vramGb: number, timings: Timing[]): hd.Upscaler {
    return (images) => {
        if (!fs.existsSync(PYTHON))
            throw Error(`${PYTHON} not found: node tools/pipeline/hd_textures/fetch_models.ts ${model}`);
        fs.mkdirSync(HD_DIR, { recursive: true });
        const work = fs.mkdtempSync(path.join(HD_DIR, "work-"));
        try {
            const inDir = path.join(work, "in");
            const outDir = path.join(work, "out");
            fs.mkdirSync(inDir);
            for (const [name, img] of images) fs.writeFileSync(path.join(inDir, `${name}.png`), encodePng(img));
            const times = path.join(work, "times.json");
            const log = path.join(cacheRoot, model, "last-run.log");
            fs.mkdirSync(path.dirname(log), { recursive: true });
            const args = ["-I", RUNNER, "--model", model, "--in", inDir, "--out", outDir, "--models", MODELS_DIR];
            args.push("--seedvr2-code", seedvr2Code(), "--vram-gb", String(vramGb), "--times", times);
            // (a run stopped part-way - the GPU driver crashing under other work - goes on from where it was, twice)
            for (let attempt = 1; ; attempt++) {
                const fd = fs.openSync(log, attempt === 1 ? "w" : "a");
                const result = spawnSync(PYTHON, args, { stdio: ["ignore", fd, fd], windowsHide: true });
                fs.closeSync(fd);
                if (result.status === 0) break;
                const tail = fs.readFileSync(log, "utf8").split(/\r?\n/).slice(-15).join("\n");
                if (attempt === 3) throw Error(`upscale.py ${model} failed (exit ${result.status}; ${log}):\n${tail}`);
                print(`  upscale.py ${model} stopped (exit ${result.status}) - going on from where it was`);
            }
            for (const t of Object.values(JSON.parse(fs.readFileSync(times, "utf8")) as Record<string, Timing>))
                timings.push(t);
            const out = new Map<string, Image>();
            for (const name of images.keys())
                out.set(name, decodePng(fs.readFileSync(path.join(outDir, `${name}.png`))));
            return out;
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    };
}

export interface BuildReport {
    files: number;
    made: number; // files made now (the rest from the cache)
    textures: number;
    upscaled: number;
    atlases: string[]; // upscaled region by region: "<file> <checksum>: <n> regions"
    regions: number; // their regions
    unreferenced: string[]; // textures no mesh beside them uses: "<file> <checksum>" (+ the seam heuristic's verdict)
    skippedAtlases: string[]; // left as they were (no mesh uses them, the seam heuristic took them for atlases)
    skipped: Map<string, number>;
    bytesBefore: number;
    bytesAfter: number;
    seconds: number;
    timings: Timing[];
}

// A texture's atlas regions from the meshes beside its dictionary (atlas.ts), or why it has none: "unreferenced"
// (no mesh uses it - the seam heuristic decides), "whole" (not an atlas).
export function atlasRegionsOf(t: Texture, bgra: Uint8Array, uses: readonly atlas.UvUse[] | null): atlas.RegionResult {
    if (uses === null) return { kind: "unreferenced" };
    // (one colour: core leaves it as it is)
    if (bgra.every((v, i) => v === bgra[i & 3])) return { kind: "whole", why: "one colour" };
    return atlas.findRegions(uses, bgra, t.width, t.height);
}

// One dictionary's HD version: its textures with their atlas regions / wrap found; atlases region by region
// (atlas.ts), the rest through core's pass. Several dictionaries go through one call of the model (their textures
// given unique numbers for the call).
function upscaleDictionaries(
    files: { name: string; tex: TexFile }[],
    options: hd.HdOptions,
    upscaler: hd.Upscaler,
    report: BuildReport,
    scenes: SceneSource | undefined,
): void {
    const combined: TexFile = { version: 1, textures: [] };
    const addressing = new Map<number, hd.Addressing>();
    const checksums = new Map<Texture, number>();
    const atlases: atlas.AtlasItem[] = [];
    let n = 0;
    for (const { name, tex } of files) {
        const index = scenes?.(name).index ?? null;
        for (const t of tex.textures) {
            report.textures++;
            if (handledTexture(t)) {
                const bgra = hd.topLevel(t);
                const id = `${name} ${t.checksum.toString(16).padStart(8, "0")}`;
                const found = atlasRegionsOf(t, bgra, index ? (index.get(t.checksum) ?? []) : null);
                if (found.kind === "atlas") {
                    atlases.push({ texture: t, regions: found.regions });
                    report.atlases.push(`${id}: ${found.regions.length} regions`);
                    continue;
                }
                if (found.kind === "unreferenced") {
                    // (no mesh says where its pictures are: the seam heuristic's atlases are left as they are)
                    const seam = detectAtlas(bgra, t.width, t.height);
                    report.unreferenced.push(
                        `${id}${seam ? `: seam heuristic - atlas (${seam}), left as it was` : ""}`,
                    );
                    if (seam) {
                        report.skippedAtlases.push(`${id}: ${seam}`);
                        report.skipped.set("atlas", (report.skipped.get("atlas") ?? 0) + 1);
                        continue;
                    }
                }
                addressing.set(n, detectWrap(bgra, t.width, t.height));
            }
            checksums.set(t, t.checksum);
            t.checksum = n++;
            combined.textures.push(t);
        }
    }
    const stats = hd.newStats();
    try {
        hd.upscaleTexFile(combined, addressing, options, stats, upscaler);
    } finally {
        for (const [t, checksum] of checksums) t.checksum = checksum;
    }
    report.upscaled += stats.upscaled;
    for (const [why, count] of stats.skipped) report.skipped.set(why, (report.skipped.get(why) ?? 0) + count);
    if (atlases.length) {
        const done = atlas.upscaleAtlases(atlases, options, upscaler);
        report.upscaled += done.upscaled;
        report.regions += done.regions;
    }
}

// Every file's HD version into the model's cache (the ones not there yet). Returns the cached file per original key.
export function buildSet(
    originals: { name: string; bytes: Buffer }[],
    model: ModelName,
    options: BuildOptions,
): { files: Map<string, string>; report: BuildReport } {
    const start = performance.now();
    const report: BuildReport = {
        files: originals.length,
        made: 0,
        textures: 0,
        upscaled: 0,
        atlases: [],
        regions: 0,
        unreferenced: [],
        skippedAtlases: [],
        skipped: new Map(),
        bytesBefore: 0,
        bytesAfter: 0,
        seconds: 0,
        timings: [],
    };
    const match = options.match ?? true;
    const hdOpts = hdOptions(model, options.cacheRoot, match);
    const upscaler = options.upscaler ?? pythonUpscaler(model, options.cacheRoot, options.vramGb, report.timings);
    const files = new Map<string, string>();
    let pending: { name: string; key: string; tex: TexFile }[] = [];
    let pendingTextures = 0;
    const flush = (): void => {
        if (!pending.length) return;
        upscaleDictionaries(pending, hdOpts, upscaler, report, options.scenes);
        for (const p of pending) {
            const file = cachedFile(options.cacheRoot, model, p.key);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(`${file}.tmp`, writeTex(p.tex));
            fs.renameSync(`${file}.tmp`, file);
            report.made++;
        }
        options.log?.(`  ${report.made} files made (${report.upscaled} textures upscaled so far)`);
        pending = [];
        pendingTextures = 0;
    };
    const seen = new Set<string>();
    const keyOf = (o: { name: string; bytes: Buffer }): string =>
        fileKey(o.bytes, model, match, options.scenes?.(o.name).signature ?? "");
    for (const o of originals) {
        report.bytesBefore += o.bytes.length;
        for (const error of options.scenes?.(o.name).errors ?? [])
            options.log?.(`  ${o.name}: scene not read: ${error}`);
        const key = keyOf(o);
        files.set(key, cachedFile(options.cacheRoot, model, key));
        if (fs.existsSync(files.get(key)!) || seen.has(key)) continue;
        seen.add(key);
        const tex = readTex(o.bytes, o.name);
        pending.push({ name: o.name, key, tex });
        pendingTextures += tex.textures.length;
        if (pendingTextures >= CHUNK) flush();
    }
    flush();
    for (const o of originals) report.bytesAfter += fs.statSync(files.get(keyOf(o))!).size;
    report.seconds = (performance.now() - start) / 1000;
    return { files, report };
}

export interface InstallOptions extends BuildOptions {
    scope: "levels" | "all";
    levels: readonly string[] | null;
    buildOnly: boolean;
    // (default true) [Graphics] texture_set set to the model in the game folder's ini
    select?: boolean;
}

// The model's set installed in its own folder (made again - the other model's set left as it is) and selected; none:
// every set taken out (restore). An earlier version's install is put back first.
export function install(
    root: string,
    model: ModelName | "none",
    options: InstallOptions,
): { report: BuildReport | null; installed: number } {
    if (model === "none") {
        if (!options.buildOnly) restore(root);
        return { report: null, installed: 0 };
    }
    if (!options.buildOnly) restoreLegacy(root);
    // (only what the game reads: Data's and the data overlay's)
    const entries = collect(root, options.scope, options.levels).filter((e) => gameName(e) !== null);
    const originals = entries.map((e) => ({ name: e.rel, bytes: originalBytes(root, e) }));
    const scenes = options.scenes ?? scenesOf(root);
    const { files, report } = buildSet(originals, model, { ...options, scenes });
    if (options.buildOnly) return { report, installed: 0 };
    removeSet(root, model);
    const folder = setFolder(root, model);
    const record: SetRecord = { model, match: options.match ?? true, files: [] };
    const taken = new Set<string>();
    entries.forEach((e, k) => {
        const name = gameName(e)!;
        if (taken.has(name)) return; // (the first one the game finds: the data overlay's - collect's order)
        taken.add(name);
        const original = originals[k]!.bytes;
        const key = fileKey(original, model, options.match ?? true, scenes(e.rel).signature);
        const hdBytes = fs.readFileSync(files.get(key)!);
        if (hdBytes.equals(original)) return; // (nothing in it upscaled)
        const target = path.join(folder, ...name.split("\\"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, hdBytes);
        record.files.push({ name, original: sha256(original), installed: sha256(hdBytes) });
    });
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, SET_RECORD), `${JSON.stringify(record, null, 1)}\n`);
    if (options.select ?? true) selectSet(root, model);
    return { report, installed: record.files.length };
}

export function reportLines(model: ModelName, r: BuildReport): string[] {
    const mb = (n: number): string => (n / 1048576).toFixed(1);
    const skipped = [...r.skipped].map(([why, n]) => `${n} ${why}`).join(", ");
    const lines = [
        `HD textures (${MODELS[model].title}): ${r.files} files (${r.made} made now, ${r.files - r.made} from the cache); ` +
            `${r.upscaled} of ${r.textures} textures upscaled in the files made${skipped ? `; left as they were: ${skipped}` : ""}`,
        `  ${mb(r.bytesBefore)} MB -> ${mb(r.bytesAfter)} MB; ${r.seconds.toFixed(1)} s`,
    ];
    if (r.timings.length) {
        const total = r.timings.reduce((s, t) => s + t.seconds, 0);
        const peak = Math.max(...r.timings.map((t) => t.peakVramMB));
        const slowest = Math.max(...r.timings.map((t) => t.seconds));
        lines.push(
            `  model: ${r.timings.length} images, ${total.toFixed(1)} s (${(total / r.timings.length).toFixed(2)} s each, ` +
                `slowest ${slowest.toFixed(1)} s), peak VRAM ${peak} MB`,
        );
    }
    if (r.atlases.length) lines.push(`  ${r.atlases.length} atlases upscaled region by region (${r.regions} regions)`);
    for (const a of r.atlases) lines.push(`  atlas: ${a}`);
    for (const u of r.unreferenced) lines.push(`  no mesh uses: ${u}`);
    return lines;
}

export function gameRoot(folder: string): string {
    if (fs.existsSync(path.join(folder, "Data"))) return folder;
    if (fs.existsSync(path.join(folder, "Game", "Data"))) return path.join(folder, "Game");
    throw Error(`${folder}: no Data folder - not a game folder`);
}

export interface BaseCli {
    model: ModelName | "none" | null;
    levels: string[] | null;
    scope: "levels" | "all";
    buildOnly: boolean;
    vramGb: number;
    match: boolean;
    select: boolean;
}

// The options unpack_game.ts and this tool share; `args` keeps whatever isn't theirs.
export function parseBaseArgs(args: string[]): BaseCli {
    const take = (name: string): string | undefined => {
        const at = args.indexOf(name);
        if (at < 0) return undefined;
        const value = args[at + 1];
        if (value === undefined) exitWith(`${name} needs a value`);
        args.splice(at, 2);
        return value;
    };
    const flag = (name: string): boolean => {
        const at = args.indexOf(name);
        if (at >= 0) args.splice(at, 1);
        return at >= 0;
    };
    const model = take("--hd-textures") ?? take("--model");
    if (model !== undefined && model !== "none" && !isModelName(model))
        exitWith(`unknown model ${model} (${MODEL_NAMES.join(", ")} or none)`);
    const levels = take("--levels") ?? take("--hd-levels");
    const scope = take("--scope") ?? take("--hd-scope") ?? "levels";
    if (scope !== "levels" && scope !== "all") exitWith(`--scope levels|all, not ${scope}`);
    const vram = Number(take("--vram-gb") ?? "10");
    if (!(vram > 0)) exitWith("--vram-gb: a number of GB");
    return {
        model: (model as ModelName | "none" | undefined) ?? null,
        levels: levels ? levels.split(",").filter(Boolean) : null,
        scope,
        buildOnly: flag("--build-only"),
        vramGb: vram,
        match: !(flag("--no-match") || flag("--hd-no-match")),
        select: !(flag("--no-select") || flag("--hd-no-select")),
    };
}

// What unpack_game.ts and the command line run: the set installed, the report printed.
export function installAndReport(root: string, cli: BaseCli): void {
    if (!cli.model) return;
    const result = install(root, cli.model, {
        scope: cli.scope,
        levels: cli.levels,
        buildOnly: cli.buildOnly,
        cacheRoot: defaultCacheRoot(),
        vramGb: cli.vramGb,
        match: cli.match,
        select: cli.select,
        log: print,
    });
    if (result.report && cli.model !== "none") {
        const lines = reportLines(cli.model, result.report);
        for (const line of lines) print(line);
        const file = path.join(defaultCacheRoot(), cli.model, "report.txt");
        fs.writeFileSync(file, `${lines.join("\n")}\n`);
    }
    if (cli.model === "none") print("HD textures: every set taken out - the originals in use");
    else if (!cli.buildOnly)
        print(
            `HD textures (${cli.model}): ${result.installed} files installed in ${path.join(SETS_DIR, cli.model)}` +
                (cli.select ? ` - [Graphics] texture_set=${cli.model}` : ""),
        );
}

// --status: the sets installed, the one selected and the files out of date.
export function statusLines(root: string): string[] {
    const lines: string[] = [];
    for (const model of installedSets(root)) {
        const record = readSet(root, model)!;
        const stale = staleFiles(root, model);
        lines.push(
            `${model}: ${record.files.length} files${record.match ? "" : " (--no-match)"}` +
                (stale.length ? `; ${stale.length} out of date (their originals changed): ${stale.join(", ")}` : ""),
        );
    }
    if (!lines.length) lines.push("no HD texture set installed");
    if (readRecord(root))
        lines.push(`an earlier version's install (${readRecord(root)!.model}): --restore takes it out`);
    lines.push(`[Graphics] texture_set: ${selectedSet(root)}`);
    return lines;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const args = [...argv];
    const at = args.indexOf("--game");
    const game = at >= 0 ? args[at + 1] : undefined;
    if (!game)
        exitWith(
            "usage: base.ts --game <folder> --model pbrify|seedvr2|none [--levels a,b] | --remove <model> | --restore | --status",
        );
    args.splice(at, 2);
    const root = gameRoot(game);
    if (args.includes("--status")) {
        for (const line of statusLines(root)) print(line);
        return 0;
    }
    if (args.includes("--restore")) {
        const r = restore(root);
        print(
            `taken out: ${r.removed} set files` +
                (r.restored || r.kept
                    ? `; an earlier install put back: ${r.restored} files${r.kept ? ` (${r.kept} changed since, kept as they are)` : ""}`
                    : ""),
        );
        return 0;
    }
    const removeAt = args.indexOf("--remove");
    if (removeAt >= 0) {
        const model = args[removeAt + 1];
        if (model === undefined || !isModelName(model)) exitWith(`--remove ${MODEL_NAMES.join("|")}`);
        const removed = removeSet(root, model);
        if (selectedSet(root) === model) selectSet(root, null);
        print(removed ? `${model}: ${removed} files taken out` : `${model}: not installed`);
        return 0;
    }
    const cli = parseBaseArgs(args);
    if (args.length) exitWith(`unknown: ${args.join(" ")}`);
    if (!cli.model) exitWith("--model pbrify|seedvr2|none");
    installAndReport(root, cli);
    return 0;
}

if (isMain(import.meta.url)) helpFromHeader(import.meta.url);
if (isMain(import.meta.url)) await runMain(() => main());
