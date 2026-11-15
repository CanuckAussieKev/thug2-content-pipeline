// NOT ORIGINAL - a contact sheet for judging the de-lighting (delight.ts) on a game's own textures: the textures
// version 1's sheet showed (each level's most-used surfaces, cut-outs, atlases, hard detail, skies, skaters - the same
// picks), each level's largest single (not tiled) pictures - facades, signs, backdrops - and every texture the census
// found de-lit, each shown as original | de-lit | removed | the model's evidence (the level's lines where surfaces meet
// the picture and the way up in it drawn on the original), with the model's report: each term (gradient, edges,
// bands), its share of the broad variation, its agreement with the level, and why it was taken, refused or skipped.
// On top, the census: every texture of the levels' dictionaries as base.ts --delight would treat it, counted by class
// (tiled both ways, one way, single picture, atlas, cut-out, soft alpha, sky...) - de-lit / left as it is / skipped,
// and why. One self-contained HTML file (the pictures inline); the game folder is only read.
//
//   node tools/pipeline/run.ts hd_textures/delight_review.ts --game <folder> --out <folder> [--pbrify N]
//        [--hd-dir <folder>] [--levels BO,AU,...]
//
// --pbrify N (default 0): N de-lit textures through PBRify twice (from the original, from the de-lit texture; a small
// GPU job: ~2 N images, 0.4 GB; needs fetch_models.ts pbrify; --hd-dir the folder holding its py\ and models\ -
// default the decomp's out\hd_textures). Its texel cache goes under the output folder.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as hd from "thug2-level-converter-core/level_port/hd_textures.ts";
import { readTex, type TexFile, type Texture } from "thug2-level-converter-core/level_port/tex.ts";
import { exitWith, helpFromHeader, isMain, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { decodePng, encodePng, type Image } from "thug2-level-converter-core/lib/frame_diff.ts";
import * as atlas from "./atlas.ts";
import { detectWrap, gameRoot, handledTexture, replaceTopLevel } from "./base.ts";
import * as dl from "./delight.ts";
import { Geometries, type SceneGeometry } from "./delight_geometry.ts";
import { HD_DIR, MODELS, RUNNER } from "./models.ts";

const DEFAULT_LEVELS = ["BO", "AU", "BA", "NO", "SE", "ST", "TR", "CA", "PH", "BE", "LA", "SC"];

type Category = "surface" | "cut-out" | "atlas" | "sky" | "character" | "hard detail" | "single picture" | "de-lit";

// What a texture is to the census (by how the level maps it).
type TextureClass =
    | "sky"
    | "model / character"
    | "soft alpha"
    | "cut-out"
    | "atlas"
    | "tiled both ways"
    | "tiled one way"
    | "single picture";

interface Candidate {
    file: string; // relative to the game's root
    texture: Texture;
    bgra: Buffer;
    category: Category;
    klass: TextureClass;
    regions: atlas.Region[] | null;
    wrap: hd.Addressing; // as the level maps it (delight.ts tilingOf)
    orientation: dl.Orientation | null;
    geometry: SceneGeometry | null;
    score: number; // within its category: higher first
    v1: boolean; // version 1's sheet could pick it (what version 1 de-lit: no soft alpha, drawn as a surface)
    extra: boolean; // a second entry of the same texture under another category (hard detail, single picture)
}

interface Judged {
    c: Candidate;
    result: dl.DelightResult;
    skip: string | null; // why base.ts --delight leaves it (delight.ts skipReason)
    evidence: dl.Evidence | null; // the whole texture's (atlases: none - each region its own)
}

const hex = (n: number): string => n.toString(16).padStart(8, "0");

function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
        .sort();
}

// the mean |gradient| of the luminance (0 - 255): hard detail - letters, stripes, edges
function edginess(bgra: Uint8Array, w: number, h: number): number {
    const luma = (i: number): number => 0.0722 * bgra[i * 4]! + 0.7152 * bgra[i * 4 + 1]! + 0.2126 * bgra[i * 4 + 2]!;
    let sum = 0;
    for (let y = 0; y < h - 1; y++)
        for (let x = 0; x < w - 1; x++) {
            const i = y * w + x;
            sum += Math.abs(luma(i) - luma(i + 1)) + Math.abs(luma(i) - luma(i + w));
        }
    return sum / Math.max(1, (w - 1) * (h - 1));
}

const uvIndexes = new atlas.UvIndexes();
const orientations = new dl.Orientations();
const geometries = new Geometries();

// Every handled texture of a dictionary as a candidate (its category the version 1 sheet's; its class the census').
function candidatesOf(root: string, rel: string, kind: "level" | "sky" | "character"): Candidate[] {
    const file = path.join(root, rel);
    let tex: TexFile;
    try {
        tex = readTex(fs.readFileSync(file), rel);
    } catch {
        return [];
    }
    const uv = uvIndexes.of(file).index;
    const faces = orientations.of(file);
    const geometry = kind === "level" ? geometries.of(file) : null;
    const out: Candidate[] = [];
    for (const t of tex.textures) {
        if (!handledTexture(t)) continue;
        const bgra = hd.topLevel(t);
        if (bgra.every((v, i) => v === bgra[i & 3])) continue;
        const uses = uv.get(t.checksum);
        const found = uses ? atlas.findRegions(uses, bgra, t.width, t.height) : null;
        const regions = found?.kind === "atlas" ? found.regions : null;
        const orientation = faces.get(t.checksum) ?? null;
        const alpha = hd.alphaKind(bgra);
        const wrap = dl.tilingOf(uses, detectWrap(bgra, t.width, t.height));
        const klass: TextureClass =
            kind === "sky"
                ? "sky"
                : kind === "character"
                  ? "model / character"
                  : alpha === "smooth"
                    ? "soft alpha"
                    : alpha === "binary"
                      ? "cut-out"
                      : regions
                        ? "atlas"
                        : wrap.wrapU && wrap.wrapV
                          ? "tiled both ways"
                          : wrap.wrapU || wrap.wrapV
                            ? "tiled one way"
                            : "single picture";
        const area = orientation?.area ?? 0;
        let category: Category;
        let score: number;
        if (kind === "sky") [category, score] = ["sky", t.width * t.height];
        else if (kind === "character") [category, score] = ["character", t.width * t.height];
        else if (regions) [category, score] = ["atlas", regions.length * 1000 + area];
        else if (alpha === "binary") [category, score] = ["cut-out", area];
        else [category, score] = ["surface", area];
        const c: Candidate = {
            file: rel,
            texture: t,
            bgra,
            category,
            klass,
            regions,
            wrap,
            orientation,
            geometry,
            score,
            // (version 1's picks: what its base.ts --delight de-lit - soft alpha and light-only textures left out)
            v1: kind !== "level" || (alpha !== "smooth" && !!orientation?.surface),
            extra: false,
        };
        out.push(c);
        if (kind === "level" && c.v1 && !regions && alpha === "opaque" && orientation?.area)
            out.push({ ...c, category: "hard detail", score: edginess(bgra, t.width, t.height), extra: true });
        if (kind === "level" && c.v1 && klass === "single picture")
            out.push({ ...c, category: "single picture", score: area, extra: true });
    }
    return out;
}

// ---- pictures ----

const toImage = (bgra: Uint8Array, w: number, h: number, checker = true): Image => {
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const a = bgra[i * 4 + 3]! / 255;
            const bg = checker ? (((x >> 3) + (y >> 3)) & 1 ? 200 : 150) : 0;
            rgb[i * 3] = Math.round(bgra[i * 4 + 2]! * a + bg * (1 - a));
            rgb[i * 3 + 1] = Math.round(bgra[i * 4 + 1]! * a + bg * (1 - a));
            rgb[i * 3 + 2] = Math.round(bgra[i * 4]! * a + bg * (1 - a));
        }
    return { width: w, height: h, rgb };
};

const greyImage = (grey: Uint8Array, w: number, h: number): Image => {
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) rgb.fill(grey[i]!, i * 3, i * 3 + 3);
    return { width: w, height: h, rgb };
};

function crop(img: Image, size: number): Image {
    const w = Math.min(size, img.width);
    const h = Math.min(size, img.height);
    const x0 = (img.width - w) >> 1;
    const y0 = (img.height - h) >> 1;
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++)
        rgb.set(img.rgb.subarray(((y0 + y) * img.width + x0) * 3, ((y0 + y) * img.width + x0 + w) * 3), y * w * 3);
    return { width: w, height: h, rgb };
}

const dataUri = (img: Image): string => `data:image/png;base64,${encodePng(img).toString("base64")}`;

// a picture `s` times larger (nearest)
function enlarge(img: Image, s: number): Image {
    if (s === 1) return img;
    const width = img.width * s;
    const height = img.height * s;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const i = (Math.floor(y / s) * img.width + Math.floor(x / s)) * 3;
            rgb.set(img.rgb.subarray(i, i + 3), (y * width + x) * 3);
        }
    return { width, height, rgb };
}

// pictures side by side (top-aligned, 4 texels apart; black behind)
function strip(images: readonly Image[]): Image {
    const width = images.reduce((s, i) => s + i.width + 4, -4);
    const height = Math.max(...images.map((i) => i.height));
    const rgb = new Uint8Array(width * height * 3);
    let x0 = 0;
    for (const img of images) {
        for (let y = 0; y < img.height; y++)
            rgb.set(img.rgb.subarray(y * img.width * 3, (y + 1) * img.width * 3), (y * width + x0) * 3);
        x0 += img.width + 4;
    }
    return { width, height, rgb };
}

// ---- PBRify (upscale.py, a folder of PNGs; the same arguments as base.ts's pythonUpscaler) ----

function pbrifyUpscaler(hdDir: string, work: string): hd.Upscaler {
    return (images) => {
        const python = path.join(hdDir, "py", "Scripts", "python.exe");
        if (!fs.existsSync(python))
            throw Error(`${python} not found: node tools/pipeline/hd_textures/fetch_models.ts pbrify`);
        const run = fs.mkdtempSync(path.join(work, "run-"));
        const inDir = path.join(run, "in");
        const outDir = path.join(run, "out");
        fs.mkdirSync(inDir, { recursive: true });
        for (const [name, img] of images) fs.writeFileSync(path.join(inDir, `${name}.png`), encodePng(img));
        const args = [
            "-I",
            RUNNER,
            "--model",
            "pbrify",
            "--in",
            inDir,
            "--out",
            outDir,
            "--models",
            path.join(hdDir, "models"),
        ];
        args.push("--vram-gb", "3", "--times", path.join(run, "times.json"));
        const result = spawnSync(python, args, { encoding: "utf8", windowsHide: true });
        if (result.status !== 0)
            throw Error(`upscale.py failed (${result.status}): ${(result.stderr ?? "").slice(-2000)}`);
        const out = new Map<string, Image>();
        for (const name of images.keys()) out.set(name, decodePng(fs.readFileSync(path.join(outDir, `${name}.png`))));
        fs.rmSync(run, { recursive: true, force: true });
        return out;
    };
}

// Textures through the model in one call (one model load): each texels-and-wrap pair upscaled x4, as 32-bit texels.
function upscaledAll(
    jobs: readonly { texture: Texture; bgra: Buffer; wrap: hd.Addressing }[],
    options: hd.HdOptions,
    upscaler: hd.Upscaler,
): Image[] {
    const textures = jobs.map((job, k) => {
        const t: Texture = { ...job.texture, levels: [...job.texture.levels] };
        replaceTopLevel(t, job.bgra);
        t.checksum = k + 1;
        return t;
    });
    hd.upscaleTexFile(
        { version: 1, textures },
        new Map(jobs.map((job, k) => [k + 1, job.wrap])),
        { ...options, compress: false },
        hd.newStats(),
        upscaler,
    );
    return textures.map((t) => toImage(hd.topLevel(t), t.width, t.height));
}

// the picks: version 1's (per level its three most-used surfaces; then the strongest of each other category across
// all), each level's largest single pictures, then every texture the census de-lit (up to `delitCap`)
function pick(
    pool: readonly Candidate[],
    levels: readonly string[],
    census: readonly Judged[],
    delitCap = 40,
): Candidate[] {
    const picked: Candidate[] = [];
    const taken = new Set<string>();
    const key = (c: Candidate): string => `${c.file} ${hex(c.texture.checksum)}`;
    const take = (c: Candidate): void => {
        if (taken.has(key(c))) return;
        taken.add(key(c));
        picked.push(c);
    };
    for (const level of levels) {
        pool.filter((c) => c.v1 && c.category === "surface" && c.file.split(/[\\/]/).at(-2) === level)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .forEach(take);
    }
    const wanted: [Category, number][] = [
        ["cut-out", 6],
        ["atlas", 6],
        ["sky", 5],
        ["character", 6],
        ["hard detail", 6],
        ["single picture", 12],
    ];
    for (const [category, count] of wanted) {
        // (one per file first: spread across the levels)
        const of = pool.filter((c) => c.v1 && c.category === category).sort((a, b) => b.score - a.score);
        const files = new Set<string>();
        let n = 0;
        for (const c of of) {
            if (n >= count || files.has(c.file) || taken.has(key(c))) continue;
            files.add(c.file);
            take(c);
            n++;
        }
        for (const c of of) {
            if (n >= count || taken.has(key(c))) continue;
            take(c);
            n++;
        }
    }
    let n = 0;
    for (const j of census)
        if (j.result.stats.changed && !j.skip && n < delitCap && !taken.has(key(j.c))) {
            take({ ...j.c, category: "de-lit" });
            n++;
        }
    return picked;
}

// A texture as base.ts --delight treats it: skipped (and why), or the model's result with its evidence.
function judge(c: Candidate): Judged {
    const t = c.texture;
    const facts = c.geometry?.facts(t.checksum);
    const skip = dl.skipReason(c.file, c.bgra, hd.alphaKind(c.bgra), c.orientation ?? undefined, facts);
    const geometry = c.geometry ?? undefined;
    if (skip) {
        const evidence = c.regions ? null : dl.textureEvidence(geometry, t.checksum, c.wrap);
        const unchanged: dl.DelightResult = {
            bgra: Buffer.from(c.bgra),
            shading: new Float32Array(t.width * t.height),
            stats: { ...emptyStats(), verdict: `skipped: ${skip}` },
        };
        return { c, result: unchanged, skip, evidence };
    }
    if (c.regions) {
        const result = dl.delightRegions(c.bgra, t.width, t.height, c.regions, {
            evidenceFor: dl.regionEvidence(geometry, t.checksum, t.width, t.height),
        });
        return { c, result, skip, evidence: null };
    }
    const evidence = dl.textureEvidence(geometry, t.checksum, c.wrap);
    return { c, result: dl.delight(c.bgra, t.width, t.height, { ...c.wrap, evidence }), skip, evidence };
}

function emptyStats(): dl.DelightStats {
    return {
        changed: false,
        verdict: "",
        terms: [],
        broadVariance: 0,
        structure: 0,
        explained: 0,
        visible: 0,
        meanChange: 0,
        maxFactor: 1,
        clipped: 0,
        chromaShift: 0,
    };
}

// ---- the evidence picture: the original with the level's lines (green: a term taken on it; amber: refused) and the
// way up (cyan, from the middle - its length the consistency), atlases region by region (grey outlines)

function drawLine(img: Image, x0: number, y0: number, x1: number, y1: number, rgb: readonly number[]): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const y = Math.round(y0 + ((y1 - y0) * s) / steps);
        for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
                const px = x + dx;
                const py = y + dy;
                if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
                img.rgb.set(rgb, (py * img.width + px) * 3);
            }
    }
}

function evidencePicture(j: Judged, scale: number): Image {
    const t = j.c.texture;
    const img = enlarge(toImage(j.c.bgra, t.width, t.height), scale);
    const parts: { r: dl.DelightRegion; evidence: dl.Evidence | null; prefix: string }[] = j.c.regions
        ? j.c.regions.map((r, n) => ({
              r,
              evidence: dl.regionEvidence(j.c.geometry ?? undefined, t.checksum, t.width, t.height)(r),
              prefix: `region ${n + 1}: `,
          }))
        : [{ r: { x0: 0, y0: 0, x1: t.width, y1: t.height, ...j.c.wrap }, evidence: j.evidence, prefix: "" }];
    const takenNames = new Set(j.result.stats.terms.filter((x) => x.taken).map((x) => x.name));
    for (const { r, evidence, prefix } of parts) {
        const X = (v: number): number => (r.x0 + v * (r.x1 - r.x0)) * scale;
        const Y = (v: number): number => (r.y0 + v * (r.y1 - r.y0)) * scale;
        if (j.c.regions) {
            const grey = [160, 160, 160];
            drawLine(img, X(0), Y(0), X(1) - 1, Y(0), grey);
            drawLine(img, X(0), Y(1) - 1, X(1) - 1, Y(1) - 1, grey);
            drawLine(img, X(0), Y(0), X(0), Y(1) - 1, grey);
            drawLine(img, X(1) - 1, Y(0), X(1) - 1, Y(1) - 1, grey);
        }
        if (!evidence) continue;
        for (const line of evidence.lines) {
            if (line.meets < dl.GATE.minMeets) continue;
            const sideName =
                line.at === 0
                    ? line.axis === "x"
                        ? "left"
                        : "top"
                    : line.at === 1
                      ? line.axis === "x"
                          ? "right"
                          : "bottom"
                      : "";
            const taken = [...takenNames].some((n) =>
                sideName
                    ? n === `${prefix}edge ${sideName}`
                    : n.startsWith(`${prefix}band ${line.axis}=${line.at.toFixed(2)}`),
            );
            const colour = taken ? [40, 220, 60] : [255, 170, 0];
            const at = Math.min(0.995, line.at);
            if (line.axis === "x") drawLine(img, X(at), Y(0), X(at), Y(1) - 1, colour);
            else drawLine(img, X(0), Y(at), X(1) - 1, Y(at), colour);
        }
        if (evidence.light) {
            const [lx, ly] = evidence.light;
            const cx = X(0.5);
            const cy = Y(0.5);
            const len = 0.45 * Math.min(r.x1 - r.x0, r.y1 - r.y0) * scale;
            const hx = cx + lx * len;
            const hy = cy + ly * len;
            drawLine(img, cx, cy, hx, hy, [0, 220, 255]);
            drawLine(img, hx - 2, hy - 2, hx + 2, hy + 2, [0, 220, 255]);
            drawLine(img, hx - 2, hy + 2, hx + 2, hy - 2, [0, 220, 255]);
        }
    }
    return img;
}

// ---- the page ----

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const pct = (v: number): string => `${Math.round(100 * v)}%`;

// a verdict or skip reason without its numbers (the census' groups)
const reasonOf = (j: Judged): string =>
    j.skip
        ? `skipped: ${j.skip}`
        : j.result.stats.changed
          ? `de-lit: ${[...new Set(j.result.stats.terms.filter((t) => t.taken).map((t) => t.kind))].sort().join(" + ")}`
          : j.result.stats.verdict.replace(/\s*\(.*?\)/g, "").replace(/\d+%/g, "N%");

const CLASSES: TextureClass[] = [
    "single picture",
    "atlas",
    "tiled one way",
    "tiled both ways",
    "cut-out",
    "soft alpha",
    "sky",
];

function censusHtml(census: readonly Judged[]): string {
    const rows = CLASSES.map((klass) => {
        const of = census.filter((j) => j.c.klass === klass);
        const changed = of.filter((j) => !j.skip && j.result.stats.changed).length;
        const skipped = of.filter((j) => j.skip).length;
        return `<tr><td>${klass}</td><td>${of.length}</td><td>${changed}</td><td>${of.length - changed - skipped}</td><td>${skipped}</td></tr>`;
    });
    const total = census.length;
    const changed = census.filter((j) => !j.skip && j.result.stats.changed).length;
    const skipped = census.filter((j) => j.skip).length;
    const reasons = new Map<string, number>();
    for (const j of census) reasons.set(reasonOf(j), (reasons.get(reasonOf(j)) ?? 0) + 1);
    const list = [...reasons].sort((a, b) => b[1] - a[1]);
    return `<table><tr><th>class</th><th>textures</th><th>de-lit</th><th>left as they are</th><th>skipped</th></tr>
${rows.join("\n")}
<tr><th>all</th><th>${total}</th><th>${changed}</th><th>${total - changed - skipped}</th><th>${skipped}</th></tr></table>
<h3>Why</h3><table><tr><th>outcome</th><th>textures</th></tr>${list.map(([r, n]) => `<tr><td>${esc(r)}</td><td>${n}</td></tr>`).join("")}</table>`;
}

function page(rows: readonly Judged[], census: readonly Judged[], controls: string[], levels: string): string {
    const n = (v: number, d = 2): string => v.toFixed(d);
    const card = (j: Judged): string => {
        const t = j.c.texture;
        const s = j.result.stats;
        const scale = Math.max(1, Math.floor(192 / Math.max(t.width, t.height)));
        const cells: [string, string][] = [
            ["original", dataUri(toImage(j.c.bgra, t.width, t.height))],
            ["de-lit", dataUri(toImage(j.result.bgra, t.width, t.height))],
            ["removed", dataUri(greyImage(dl.shadingPicture(j.result.shading), t.width, t.height))],
            ["evidence", dataUri(evidencePicture(j, scale))],
        ];
        const tags = [
            j.c.category,
            j.c.klass,
            j.c.regions
                ? `atlas, ${j.c.regions.length} regions`
                : `${j.c.wrap.wrapU ? "tiles u" : "u single"}, ${j.c.wrap.wrapV ? "tiles v" : "v single"}`,
            j.evidence ? `${j.evidence.faces} faces` : j.c.geometry ? "" : "no level geometry",
        ].filter((x) => x);
        const terms = s.terms.length
            ? `<table><tr><th>term</th><th>share alone</th><th>size</th><th>level agrees</th><th>colour / brightness</th><th></th><th>why</th></tr>
${s.terms.map((x) => `<tr class="${x.taken ? "taken" : ""}"><td>${esc(x.name)}</td><td>${pct(x.share)}</td><td>${pct(x.amplitude)}</td><td>${x.agreement === null ? "-" : n(x.agreement)}</td><td>${n(x.chroma)}</td><td>${x.taken ? "taken" : ""}</td><td>${esc(x.why)}</td></tr>`).join("\n")}</table>`
            : "";
        const numbers = s.changed
            ? `<p class="small">explains ${pct(s.explained)} of the broad variation (std ${n(Math.sqrt(s.broadVariance))}); every candidate term ${pct(s.structure)}; mean colour change ${n(s.meanChange, 1)} / 255; largest factor x${n(s.maxFactor)}; at the limit ${pct(s.clipped)}; chroma shift ${n(s.chromaShift, 1)}</p>`
            : s.broadVariance
              ? `<p class="small">broad variation std ${n(Math.sqrt(s.broadVariance))}; every candidate term together ${pct(s.structure)}</p>`
              : "";
        return `<section class="card${s.changed ? " changed" : ""}" id="t${hex(t.checksum)}-${j.c.category.replace(" ", "_")}">
<h3>${esc(j.c.file)} <code>${hex(t.checksum)}</code> <span>${t.width}x${t.height}</span></h3>
<p class="tags">${tags.map((x) => `<span>${esc(x)}</span>`).join("")}</p>
<p class="verdict">${esc(j.skip ? `skipped: ${j.skip}` : s.verdict)}</p>
<div class="cells">${cells.map(([label, uri]) => `<figure><img src="${uri}" alt=""><figcaption>${label}</figcaption></figure>`).join("")}</div>
${numbers}${terms}
</section>`;
    };
    const changedRows = rows.filter((r) => r.result.stats.changed);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>De-light review v2</title>
<style>
:root { --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --card: #fff; --line: #ddd; --on: #1f7a33; --risk: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #e8e8e4; --muted: #9a9a94; --card: #20201e; --line: #3a3a36; --on: #7ddc8e; --risk: #ff8a80; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 1400px; padding: 16px; }
h1 { font-size: 22px; } h3 { font-size: 14px; margin: 0 0 4px; } h3 span, .tags span { color: var(--muted); }
.tags span { border: 1px solid var(--line); border-radius: 10px; padding: 0 8px; margin-right: 6px; font-size: 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 12px 0; }
.card.changed { border-color: var(--on); }
.verdict { margin: 4px 0; font-weight: 600; } .small { color: var(--muted); font-size: 12px; margin: 4px 0; }
.cells { display: flex; flex-wrap: wrap; gap: 8px; }
figure { margin: 0; } figcaption { color: var(--muted); font-size: 12px; }
img { width: 192px; height: auto; image-rendering: pixelated; display: block; max-width: 100%; }
table { border-collapse: collapse; margin-top: 8px; font-size: 12px; } td, th { border: 1px solid var(--line); padding: 2px 8px; text-align: left; }
tr.taken td { color: var(--on); font-weight: 600; }
code { font-size: 12px; } ul { padding-left: 20px; } .wrap { overflow-x: auto; }
</style></head><body>
<h1>De-light review, version 2</h1>
<p>delight.ts v${dl.DELIGHT_VERSION}: painted light removed only where the texels' broad variation takes a shape light takes (a gradient brightening up the face toward the sky, darkening toward an edge or a line where the level has surfaces meeting this one) and the level agrees; everything else left exactly as it is. Pictures: original | de-lit | removed (grey 128 nothing; darker: shadow lifted; lighter: light taken out; black / white a factor of 2) | evidence (green: a line where surfaces meet with a term taken on it; amber: such a line, refused; cyan: the way up (the sky) in the picture, its length how consistently the faces say so; grey: atlas regions). Levels: ${esc(levels)}.</p>
<h2>Census: every texture of the levels' dictionaries</h2>
<div class="wrap">${censusHtml(census)}</div>
<h2>Controls</h2><ul>${controls.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
<h2>De-lit on this sheet (${changedRows.length})</h2>
<ul>${changedRows.map((r) => `<li><a href="#t${hex(r.c.texture.checksum)}-${r.c.category.replace(" ", "_")}">${esc(r.c.file)} ${hex(r.c.texture.checksum)}</a>: ${esc(r.result.stats.verdict)}</li>`).join("")}</ul>
<h2>Textures (${rows.length})</h2>
${rows.map(card).join("\n")}
</body></html>
`;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const args = [...argv];
    const value = (name: string): string | undefined => {
        const at = args.indexOf(name);
        return at >= 0 ? args[at + 1] : undefined;
    };
    const game = value("--game");
    const out = value("--out");
    if (!game || !out)
        exitWith(
            "usage: delight_review.ts --game <folder> --out <folder> [--pbrify N] [--hd-dir <folder>] [--levels BO,AU]",
        );
    const root = gameRoot(game);
    const levels = value("--levels")?.split(",") ?? DEFAULT_LEVELS;
    const pbrifyCount = Number(value("--pbrify") ?? "0");
    fs.mkdirSync(out, { recursive: true });
    // every candidate: the levels', their skies', the characters'
    const pool: Candidate[] = [];
    for (const level of levels) {
        pool.push(...candidatesOf(root, path.join("Data", "levels", level, `${level}.tex.xbx`), "level"));
        pool.push(...candidatesOf(root, path.join("Data", "levels", `${level}_Sky`, `${level}_Sky.tex.xbx`), "sky"));
    }
    for (const folder of ["Skater_Pro", "Skater_Male", "Skater_female", "Peds"]) {
        const files = walk(path.join(root, "Data", "models", folder)).filter((f) => /\.tex\.xbx$/i.test(f));
        for (const f of files.slice(0, 6)) pool.push(...candidatesOf(root, path.relative(root, f), "character"));
    }
    // the census: each level and sky texture once
    const census = pool.filter((c) => !c.extra && c.category !== "character").map(judge);
    print(`census: ${census.length} textures, ${census.filter((j) => j.result.stats.changed).length} de-lit`);
    const judged = new Map(census.map((j) => [`${j.c.file} ${hex(j.c.texture.checksum)}`, j]));
    const rows = pick(pool, levels, census).map((c) => {
        const known = judged.get(`${c.file} ${hex(c.texture.checksum)}`);
        return known ? { ...known, c } : judge(c);
    });
    print(`${rows.length} textures on the sheet`);
    // the controls: textures whose broad variation is their own - they must come out byte for byte
    const controls = [
        ["SE", "8ed6ea58", "black / white stripes"],
        ["BO", "cc04f86c", "water"],
    ].map(([level, sum, what]) => {
        const j = census.find((x) => x.c.file.split(/[\\/]/).at(-2) === level && hex(x.c.texture.checksum) === sum);
        if (!j) return `${level} ${sum} (${what}): not found`;
        return `${level} ${sum} (${what}): ${j.result.bgra.equals(j.c.bgra) ? "unchanged, byte for byte" : "CHANGED"} - ${j.skip ? `skipped: ${j.skip}` : j.result.stats.verdict}`;
    });
    for (const c of controls) print(`control ${c}`);
    if (pbrifyCount > 0) {
        const work = path.join(out, "work");
        fs.mkdirSync(work, { recursive: true });
        const options: hd.HdOptions = {
            ...hd.defaultOptions(4),
            maxSize: 1024,
            minSize: 32,
            model: MODELS.pbrify.tag,
            cacheDir: path.join(out, "cache"),
        };
        const upscaler = pbrifyUpscaler(value("--hd-dir") ?? HD_DIR, work);
        const list = rows
            .filter(
                (r) => r.result.stats.changed && !r.c.regions && Math.max(r.c.texture.width, r.c.texture.height) <= 256,
            )
            .slice(0, pbrifyCount);
        const made = upscaledAll(
            list.flatMap((r) => [
                { texture: r.c.texture, bgra: r.c.bgra, wrap: r.c.wrap },
                { texture: r.c.texture, bgra: r.result.bgra, wrap: r.c.wrap },
            ]),
            options,
            upscaler,
        );
        const pbrify = path.join(out, "pbrify");
        fs.mkdirSync(pbrify, { recursive: true });
        list.forEach((r, k) => {
            fs.writeFileSync(
                path.join(pbrify, `${hex(r.c.texture.checksum)}.png`),
                encodePng(strip([crop(made[2 * k]!, 384), crop(made[2 * k + 1]!, 384)])),
            );
        });
        fs.rmSync(work, { recursive: true, force: true });
    }
    // each row also as a PNG strip: original | de-lit | removed | evidence
    const strips = path.join(out, "strips");
    fs.rmSync(strips, { recursive: true, force: true });
    fs.mkdirSync(strips, { recursive: true });
    rows.forEach((r, k) => {
        const t = r.c.texture;
        const s = Math.max(1, Math.floor(256 / t.height));
        const images = [
            enlarge(toImage(r.c.bgra, t.width, t.height), s),
            enlarge(toImage(r.result.bgra, t.width, t.height), s),
            enlarge(greyImage(dl.shadingPicture(r.result.shading), t.width, t.height), s),
            evidencePicture(r, s),
        ];
        const name = `${String(k).padStart(3, "0")}-${r.c.category.replace(" ", "_")}-${hex(t.checksum)}.png`;
        fs.writeFileSync(path.join(strips, name), encodePng(strip(images)));
    });
    const file = path.join(out, "index.html");
    fs.writeFileSync(file, page(rows, census, controls, levels.join(", ")));
    const tsv = (list: readonly Judged[]): string =>
        list
            .map((r) => {
                const s = r.result.stats;
                return [
                    r.c.file,
                    hex(r.c.texture.checksum),
                    r.c.category,
                    r.c.klass,
                    `${r.c.wrap.wrapU ? "u" : "-"}${r.c.wrap.wrapV ? "v" : "-"}`,
                    s.changed ? "de-lit" : r.skip ? "skipped" : "untouched",
                    s.explained.toFixed(2),
                    s.meanChange.toFixed(1),
                    s.maxFactor.toFixed(2),
                    r.skip ? r.skip : s.verdict,
                ].join("\t");
            })
            .join("\n");
    const header = "file\tchecksum\tcategory\tclass\ttiles\toutcome\texplained\tchange\tmaxFactor\twhy\n";
    fs.writeFileSync(path.join(out, "numbers.tsv"), `${header}${tsv(rows)}\n`);
    fs.writeFileSync(path.join(out, "census.tsv"), `${header}${tsv(census)}\n`);
    print(`${file}: ${rows.length} textures, ${rows.filter((r) => r.result.stats.changed).length} de-lit`);
    return 0;
}

if (isMain(import.meta.url)) helpFromHeader(import.meta.url);
if (isMain(import.meta.url)) await runMain(() => main());
