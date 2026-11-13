// NOT ORIGINAL - HD textures for the base game: every level texture dictionary (.tex.xbx) of the game (Data's - loose
// in every install, packed or unpacked by tools/qbjs/unpack_game.ts) and of our overlays (thug2-decomp-<x>\levels:
// the ported levels, the data overlay's own) upscaled by 4 with one of two AI models (models.ts: PBRify UpscalerV4 or
// SeedVR2-3B, run by upscale.py on the local NVIDIA GPU), installed, and taken out again on --restore. No file the
// game was installed with is written: a Data dictionary's HD version goes into the data overlay (thug2-decomp-data, at
// the same path - the game reads it before its archives and Data: src/engine/file/data_overlay.h), an overlay's own
// dictionary is replaced in place (its original kept).
//
//   node tools/pipeline/hd_textures/base.ts --game <folder> --model pbrify|seedvr2|none [--levels BO,AU,foun]
//        [--scope levels|all] [--build-only] [--no-match] [--vram-gb 10]
//   node tools/pipeline/hd_textures/base.ts --game <folder> --restore | --status
//
// --model installs that model's set (made first where its cache doesn't have it yet; the previous set put back
// first), none only puts the originals back. --levels: only those levels (each with its _Sky); --scope all: every
// .tex.xbx (peds, skaters, vehicles, props too) - the default is the levels' dictionaries. --build-only fills the
// model's cache without installing anything (both sets made once, switching is then a copy). unpack_game.ts
// --hd-textures <model> runs the same after unpacking. --no-match keeps the model's own colours and contrast (default:
// every 4 x 4 block pulled back to the original texel - which also brings back a faint trace of the original's DXT
// blocks); its files are a set of their own in the cache (made from the same model output: no model run).
//
// Per texture (thug2-level-converter-core level_port/hd_textures.ts does the per-texture work, as for converted
// levels; this adds what the base game needs):
// - tiling found by edge continuity (detectWrap): the texture wraps in u (v) when the step from its last column (row)
//   to its first is no larger than its typical step between neighbouring columns (rows) - the materials' own
//   addressing isn't read; the model then sees the other edge as padding, so tiled surfaces show no seams;
// - atlases found and skipped (detectAtlas): a hard straight seam right across, well inside the texture, between
//   two sides that are different pictures (several images packed side by side) - wrap padding and the model's reach
//   would mix the neighbouring images; each is listed in the report;
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
// once is a copy. The record (<game>\thug2-decomp-backup\hd_textures\record.json) lists every file written, the
// SHA-256 of the file it replaced (none for one added to the data overlay) and of the installed one; replaced
// originals are kept beside it (originals\<path>). --restore removes each added file and puts each replaced one back,
// unless it changed or went since (make_menu_level.ts remade the data overlay, a converter its level: theirs is kept).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as hd from "thug2-level-converter-core/level_port/hd_textures.ts";
import { readTex, type TexFile, type Texture, writeTex } from "thug2-level-converter-core/level_port/tex.ts";
import { exitWith, helpFromHeader, isMain, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { decodePng, encodePng, type Image } from "thug2-level-converter-core/lib/frame_diff.ts";
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
export const BASE_VERSION = 1;
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
                !/^thug2-decomp-(backup|check)/i.test(e.name) &&
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

// ---- the record ----

export interface HdRecord {
    model: ModelName;
    match?: boolean; // (false: --no-match)
    // target: the file written; original: the SHA-256 of the file it replaced (null: there was none - a Data file's
    // HD version added to the data overlay); installed: the written one's
    files: { target: string; original: string | null; installed: string }[];
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function readRecord(root: string): HdRecord | null {
    const file = path.join(root, HD_BACKUP, "record.json");
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as HdRecord) : null;
}

function writeRecord(root: string, record: HdRecord): void {
    fs.mkdirSync(path.join(root, HD_BACKUP), { recursive: true });
    fs.writeFileSync(path.join(root, HD_BACKUP, "record.json"), `${JSON.stringify(record, null, 1)}\n`);
}

// A dictionary's original bytes: the record's copy while an HD set has replaced it, else the file itself.
export function originalBytes(root: string, e: TexEntry): Buffer {
    const f = readRecord(root)?.files.find((r) => r.target.toLowerCase() === e.target.toLowerCase());
    const current = fs.readFileSync(path.join(root, e.rel));
    if (f && f.original !== null && sha256(current) === f.installed)
        return fs.readFileSync(path.join(root, HD_BACKUP, "originals", f.target));
    return current;
}

// Every file written taken back - an added one removed, a replaced one's original put back - unless it changed or
// went since it was installed (make_menu_level.ts or a converter remade it: theirs is kept); the record and the
// originals removed.
export function restore(root: string): { restored: number; kept: number } {
    const record = readRecord(root);
    let restored = 0;
    let kept = 0;
    for (const f of record?.files ?? []) {
        const target = path.join(root, f.target);
        if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== f.installed) {
            kept++;
            continue;
        }
        if (f.original === null) fs.rmSync(target);
        else fs.copyFileSync(path.join(root, HD_BACKUP, "originals", f.target), target);
        restored++;
    }
    fs.rmSync(path.join(root, HD_BACKUP), { recursive: true, force: true });
    // (thug2-decomp-backup made only for this: removed again)
    const backup = path.join(root, BACKUP);
    if (fs.existsSync(backup) && fs.readdirSync(backup).length === 0) fs.rmdirSync(backup);
    return { restored, kept };
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

export function fileKey(original: Uint8Array, model: ModelName, match = true): string {
    const h = createHash("sha256");
    const settings = { base: BASE_VERSION, pass: hd.PASS_VERSION, model: MODELS[model].tag, MIN_SIZE, MAX_SIZE };
    h.update(JSON.stringify(match ? settings : { ...settings, match }));
    h.update(original);
    return h.digest("hex");
}

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
    atlases: string[]; // "<file> <checksum>: <reason>"
    skipped: Map<string, number>;
    bytesBefore: number;
    bytesAfter: number;
    seconds: number;
    timings: Timing[];
}

// One dictionary's HD version: its textures with their atlas / wrap found, the rest through core's pass. Several
// dictionaries go through one call of the model (their textures given unique numbers for the call).
function upscaleDictionaries(
    files: { name: string; tex: TexFile }[],
    options: hd.HdOptions,
    upscaler: hd.Upscaler,
    report: BuildReport,
): void {
    const combined: TexFile = { version: 1, textures: [] };
    const addressing = new Map<number, hd.Addressing>();
    const checksums = new Map<Texture, number>();
    let n = 0;
    for (const { name, tex } of files) {
        for (const t of tex.textures) {
            report.textures++;
            const handled = !t.palette.length && [0, 1, 2, 5].includes(t.dxt) && (t.dxt !== 0 || t.texelDepth === 32);
            if (handled && Math.max(t.width, t.height) >= MIN_SIZE && Math.max(t.width, t.height) < MAX_SIZE) {
                const bgra = hd.topLevel(t);
                const atlas = detectAtlas(bgra, t.width, t.height);
                if (atlas) {
                    report.atlases.push(`${name} ${t.checksum.toString(16).padStart(8, "0")}: ${atlas}`);
                    report.skipped.set("atlas", (report.skipped.get("atlas") ?? 0) + 1);
                    continue;
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
        upscaleDictionaries(pending, hdOpts, upscaler, report);
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
    for (const o of originals) {
        report.bytesBefore += o.bytes.length;
        const key = fileKey(o.bytes, model, match);
        files.set(key, cachedFile(options.cacheRoot, model, key));
        if (fs.existsSync(files.get(key)!) || seen.has(key)) continue;
        seen.add(key);
        const tex = readTex(o.bytes, o.name);
        pending.push({ name: o.name, key, tex });
        pendingTextures += tex.textures.length;
        if (pendingTextures >= CHUNK) flush();
    }
    flush();
    for (const o of originals) report.bytesAfter += fs.statSync(files.get(fileKey(o.bytes, model, match))!).size;
    report.seconds = (performance.now() - start) / 1000;
    return { files, report };
}

export interface InstallOptions extends BuildOptions {
    scope: "levels" | "all";
    levels: readonly string[] | null;
    buildOnly: boolean;
}

// The model's set installed (the previous one put back first); none: only put back.
export function install(
    root: string,
    model: ModelName | "none",
    options: InstallOptions,
): { report: BuildReport | null; installed: number } {
    if (!options.buildOnly) restore(root);
    if (model === "none") return { report: null, installed: 0 };
    const entries = collect(root, options.scope, options.levels);
    const originals = entries.map((e) => ({ name: e.rel, bytes: originalBytes(root, e) }));
    const { files, report } = buildSet(originals, model, options);
    if (options.buildOnly) return { report, installed: 0 };
    const record: HdRecord = { model, match: options.match ?? true, files: [] };
    writeRecord(root, record); // (first: a stopped run can still be put back)
    entries.forEach((e, k) => {
        const original = originals[k]!.bytes;
        const hdBytes = fs.readFileSync(files.get(fileKey(original, model, options.match ?? true))!);
        if (hdBytes.equals(original)) return; // (nothing in it upscaled)
        const target = path.join(root, e.target);
        let before: string | null = null;
        if (fs.existsSync(target)) {
            const backup = path.join(root, HD_BACKUP, "originals", e.target);
            fs.mkdirSync(path.dirname(backup), { recursive: true });
            fs.copyFileSync(target, backup);
            before = sha256(fs.readFileSync(target));
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, hdBytes);
        record.files.push({ target: e.target, original: before, installed: sha256(hdBytes) });
        writeRecord(root, record);
    });
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
    for (const a of r.atlases) lines.push(`  atlas, left as it was: ${a}`);
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
        log: print,
    });
    if (result.report && cli.model !== "none") {
        const lines = reportLines(cli.model, result.report);
        for (const line of lines) print(line);
        const file = path.join(defaultCacheRoot(), cli.model, "report.txt");
        fs.writeFileSync(file, `${lines.join("\n")}\n`);
    }
    if (cli.model === "none") print("HD textures: the originals are in place");
    else if (!cli.buildOnly) print(`HD textures (${cli.model}): ${result.installed} files installed`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const args = [...argv];
    const at = args.indexOf("--game");
    const game = at >= 0 ? args[at + 1] : undefined;
    if (!game)
        exitWith("usage: base.ts --game <folder> --model pbrify|seedvr2|none [--levels a,b] | --restore | --status");
    args.splice(at, 2);
    const root = gameRoot(game);
    if (args.includes("--status")) {
        const record = readRecord(root);
        print(record ? `${record.model}: ${record.files.length} files installed` : "originals (no HD set installed)");
        return 0;
    }
    if (args.includes("--restore")) {
        const r = restore(root);
        print(`put back: ${r.restored} files${r.kept ? ` (${r.kept} changed since, kept as they are)` : ""}`);
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
