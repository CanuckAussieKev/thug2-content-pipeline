// NOT ORIGINAL - a contact sheet for judging the de-lighting (delight.ts) on a game's own textures: about 60 textures
// across the levels, the skies and the characters - picked by what they are to the game (the most-used surfaces of
// each level, cut-outs, atlases, skies, skaters and peds, textures with hard detail such as signs) - each shown as
// original | de-lit | the shading taken out, with its numbers (the strength used and the faces' coherence, the share of
// the broad shading removed, the mean colour change, the chroma shift, the largest factor), and for a few of them the
// x4 PBRify result made from the original and from the de-lit texture side by side (the middle of each). The page is
// one self-contained HTML file (the pictures inline); the game folder is only read; textures flagged risky (a large
// change, the factor at its limit, a chroma shift, a sky or a character changed much) are listed at the top.
//
//   node tools/pipeline/run.ts hd_textures/delight_review.ts --game <folder> --out <folder> [--pbrify N]
//        [--hd-dir <folder>] [--levels BO,AU,...]
//
// --pbrify N (default 0): N textures through PBRify twice (a small GPU job: ~2 N images, 0.4 GB; needs
// fetch_models.ts pbrify; --hd-dir the folder holding its py\ and models\ - default the decomp's out\hd_textures).
// Its texel cache goes under the output folder.

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
import { HD_DIR, MODELS, RUNNER } from "./models.ts";

const DEFAULT_LEVELS = ["BO", "AU", "BA", "NO", "SE", "ST", "TR", "CA", "PH", "BE", "LA", "SC"];

type Category = "surface" | "cut-out" | "atlas" | "sky" | "character" | "hard detail";

interface Candidate {
    file: string; // relative to the game's root
    texture: Texture;
    bgra: Buffer;
    category: Category;
    regions: atlas.Region[] | null;
    wrap: hd.Addressing;
    orientation: dl.Orientation | null;
    score: number; // within its category: higher first
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

function candidatesOf(root: string, rel: string, kind: "level" | "sky" | "character"): Candidate[] {
    const file = path.join(root, rel);
    let tex: TexFile;
    try {
        tex = readTex(fs.readFileSync(file), rel);
    } catch {
        return [];
    }
    const uv = new atlas.UvIndexes().of(file).index;
    const faces = new dl.Orientations().of(file);
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
        // (the levels: only what base.ts --delight de-lits - soft alpha and light-only textures are left as they are)
        if (kind === "level" && (alpha === "smooth" || !orientation?.surface)) continue;
        const area = orientation?.area ?? 0;
        let category: Category;
        let score: number;
        if (kind === "sky") [category, score] = ["sky", t.width * t.height];
        else if (kind === "character") [category, score] = ["character", t.width * t.height];
        else if (regions) [category, score] = ["atlas", regions.length * 1000 + area];
        else if (alpha === "binary") [category, score] = ["cut-out", area];
        else [category, score] = ["surface", area];
        out.push({
            file: rel,
            texture: t,
            bgra,
            category,
            regions,
            wrap: detectWrap(bgra, t.width, t.height),
            orientation,
            score,
        });
        if (kind === "level" && !regions && alpha === "opaque" && !orientation?.area) continue;
        if (kind === "level" && !regions && alpha === "opaque")
            out.push({ ...out[out.length - 1]!, category: "hard detail", score: edginess(bgra, t.width, t.height) });
    }
    return out;
}

// the picks: per level its three most-used surfaces; then the strongest of each other category across all
function pick(root: string, levels: readonly string[]): Candidate[] {
    const picked: Candidate[] = [];
    const taken = new Set<string>();
    const take = (c: Candidate): void => {
        const key = `${c.file} ${hex(c.texture.checksum)}`;
        if (taken.has(key)) return;
        taken.add(key);
        picked.push(c);
    };
    const pool: Candidate[] = [];
    for (const level of levels) {
        const own = candidatesOf(root, path.join("Data", "levels", level, `${level}.tex.xbx`), "level");
        own.filter((c) => c.category === "surface")
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .forEach(take);
        pool.push(...own.filter((c) => c.category !== "surface"));
        pool.push(...candidatesOf(root, path.join("Data", "levels", `${level}_Sky`, `${level}_Sky.tex.xbx`), "sky"));
    }
    for (const folder of ["Skater_Pro", "Skater_Male", "Skater_female", "Peds"]) {
        const files = walk(path.join(root, "Data", "models", folder)).filter((f) => /\.tex\.xbx$/i.test(f));
        for (const f of files.slice(0, 6)) pool.push(...candidatesOf(root, path.relative(root, f), "character"));
    }
    const wanted: [Category, number][] = [
        ["cut-out", 6],
        ["atlas", 6],
        ["sky", 5],
        ["character", 6],
        ["hard detail", 6],
    ];
    for (const [category, count] of wanted) {
        // (one per file first: spread across the levels)
        const of = pool.filter((c) => c.category === category).sort((a, b) => b.score - a.score);
        const files = new Set<string>();
        let n = 0;
        for (const c of of) {
            if (n >= count || files.has(c.file) || taken.has(`${c.file} ${hex(c.texture.checksum)}`)) continue;
            files.add(c.file);
            take(c);
            n++;
        }
        for (const c of of) {
            if (n >= count || taken.has(`${c.file} ${hex(c.texture.checksum)}`)) continue;
            take(c);
            n++;
        }
    }
    return picked;
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

// ---- the page ----

interface Row {
    c: Candidate;
    result: dl.DelightResult;
    risks: string[];
    left: string | null; // why base.ts --delight leaves it as it is (delight.ts leftAsItIs)
    pbrify?: { original: Image; delit: Image };
}

function risksOf(c: Candidate, s: dl.DelightStats): string[] {
    const risks: string[] = [];
    if (s.meanChange > 12) risks.push(`large change (${s.meanChange.toFixed(1)} of 255)`);
    if (s.clipped > 0.05)
        risks.push(
            `${(100 * s.clipped).toFixed(0)}% of texels at the x2 limit: broad colour variation may be taken for light`,
        );
    if (s.chromaShift > 4) risks.push(`chroma shift ${s.chromaShift.toFixed(1)} (clipped highlights)`);
    if ((c.category === "sky" || c.category === "character") && s.meanChange > 6)
        risks.push(`${c.category}: its shading may be the picture (sky gradient, a face's modelling)`);
    if (c.category === "hard detail" && s.meanChange > 8) risks.push("hard detail (text, signs) changed noticeably");
    return risks;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function page(rows: Row[], game: string): string {
    const n = (v: number, d = 2): string => v.toFixed(d);
    const risky = rows.filter((r) => r.risks.length);
    const summary = rows.reduce(
        (a, r) => ({
            removed: a.removed + r.result.stats.shadingRemoved,
            change: a.change + r.result.stats.meanChange,
        }),
        { removed: 0, change: 0 },
    );
    const card = (r: Row): string => {
        const t = r.c.texture;
        const s = r.result.stats;
        const shadingGrey = dl.shadingPicture(r.result.shading);
        const cells = [
            ["original", dataUri(toImage(r.c.bgra, t.width, t.height))],
            ["de-lit", dataUri(toImage(r.result.bgra, t.width, t.height))],
            ["shading removed", dataUri(greyImage(shadingGrey, t.width, t.height))],
        ];
        if (r.pbrify) {
            cells.push(["PBRify x4 from original (middle)", dataUri(r.pbrify.original)]);
            cells.push(["PBRify x4 from de-lit (middle)", dataUri(r.pbrify.delit)]);
        }
        const tags = [
            r.c.category,
            r.c.regions
                ? `atlas, ${r.c.regions.length} regions`
                : r.c.wrap.wrapU || r.c.wrap.wrapV
                  ? `tiles ${r.c.wrap.wrapU ? "u" : ""}${r.c.wrap.wrapV ? "v" : ""}`
                  : "clamped",
            r.c.orientation ? `coherence ${n(r.c.orientation.coherence)}` : "no mesh",
            `reliability ${n(s.reliability)}`,
            r.left ? `base.ts --delight leaves it: ${r.left} (shown as it would be)` : "de-lit by base.ts --delight",
        ];
        return `<section class="card${r.risks.length ? " risky" : ""}" id="t${hex(t.checksum)}">
<h3>${esc(r.c.file)} <code>${hex(t.checksum)}</code> <span>${t.width}x${t.height}</span></h3>
<p class="tags">${tags.map((x) => `<span>${esc(x)}</span>`).join("")}</p>
<div class="cells">${cells.map(([label, uri]) => `<figure><img src="${uri}" alt=""><figcaption>${label}</figcaption></figure>`).join("")}</div>
<table><tr><th>strength k</th><th>broad shading removed</th><th>log-luma variance</th><th>mean colour change</th><th>chroma shift</th><th>largest factor</th><th>at the limit</th></tr>
<tr><td>${n(s.strength)}</td><td>${n(s.shadingRemoved * 100, 0)}% of ${n(s.shadingVariance, 4)}</td><td>${n(s.lumaVariance, 4)} &rarr; ${n(s.lumaVarianceAfter, 4)}</td><td>${n(s.meanChange, 1)}</td><td>${n(s.chromaShift, 1)}</td><td>x${n(s.maxFactor)}</td><td>${n(s.clipped * 100, 0)}%</td></tr></table>
${r.risks.length ? `<p class="risk">${r.risks.map(esc).join("; ")}</p>` : ""}
</section>`;
    };
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>De-light review</title>
<style>
:root { --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --card: #fff; --line: #ddd; --risk: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #e8e8e4; --muted: #9a9a94; --card: #20201e; --line: #3a3a36; --risk: #ff8a80; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 1400px; padding: 16px; }
h1 { font-size: 22px; } h3 { font-size: 14px; margin: 0 0 4px; } h3 span, .tags span { color: var(--muted); }
.tags span { border: 1px solid var(--line); border-radius: 10px; padding: 0 8px; margin-right: 6px; font-size: 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 12px 0; }
.card.risky { border-color: var(--risk); }
.cells { display: flex; flex-wrap: wrap; gap: 8px; }
figure { margin: 0; } figcaption { color: var(--muted); font-size: 12px; }
img { width: 192px; height: auto; image-rendering: pixelated; display: block; max-width: 100%; }
table { border-collapse: collapse; margin-top: 8px; font-size: 12px; } td, th { border: 1px solid var(--line); padding: 2px 8px; text-align: left; }
.risk { color: var(--risk); } code { font-size: 12px; } ul { padding-left: 20px; }
</style></head><body>
<h1>De-light review</h1>
<p>${rows.length} textures from ${esc(game)} through delight.ts v${dl.DELIGHT_VERSION} (the shading picture: grey 128 nothing removed; lighter: painted light taken out; darker: painted shadow lifted; black / white a factor of 2). Mean broad shading removed ${((100 * summary.removed) / Math.max(1, rows.length)).toFixed(0)}%, mean colour change ${(summary.change / Math.max(1, rows.length)).toFixed(1)} of 255.</p>
<h2>Risky (${risky.length})</h2>
<ul>${risky.map((r) => `<li><a href="#t${hex(r.c.texture.checksum)}">${esc(r.c.file)} ${hex(r.c.texture.checksum)}</a> (${r.c.category}): ${r.risks.map(esc).join("; ")}</li>`).join("")}</ul>
<h2>Textures</h2>
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
        exitWith("usage: delight_review.ts --game <folder> --out <folder> [--pbrify N] [--hd-dir <folder>]");
    const root = gameRoot(game);
    const levels = value("--levels")?.split(",") ?? DEFAULT_LEVELS;
    const pbrifyCount = Number(value("--pbrify") ?? "0");
    fs.mkdirSync(out, { recursive: true });
    const picks = pick(root, levels);
    print(`${picks.length} textures picked`);
    const rows: Row[] = [];
    for (const c of picks) {
        const coherence = c.orientation?.coherence ?? null;
        const result = c.regions
            ? dl.delightRegions(c.bgra, c.texture.width, c.texture.height, c.regions, { coherence })
            : dl.delight(c.bgra, c.texture.width, c.texture.height, { ...c.wrap, coherence });
        const left = dl.leftAsItIs(c.file, hd.alphaKind(c.bgra), c.orientation ?? undefined);
        rows.push({ c, result, risks: left ? [] : risksOf(c, result.stats), left });
    }
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
        // (one of each category first, atlases left out: their regions take the atlas pass)
        const order: Category[] = [
            "surface",
            "cut-out",
            "hard detail",
            "character",
            "sky",
            "surface",
            "surface",
            "cut-out",
            "surface",
            "hard detail",
        ];
        const chosen = new Set<Row>();
        for (const category of order) {
            const next = rows.find(
                (r) =>
                    r.c.category === category &&
                    !chosen.has(r) &&
                    Math.max(r.c.texture.width, r.c.texture.height) <= 256,
            );
            if (next && chosen.size < pbrifyCount) chosen.add(next);
        }
        const list = [...chosen];
        for (const r of list)
            print(`PBRify: ${r.c.file} ${hex(r.c.texture.checksum)} (${r.c.texture.width}x${r.c.texture.height})`);
        const made = upscaledAll(
            list.flatMap((r) => [
                { texture: r.c.texture, bgra: r.c.bgra, wrap: r.c.wrap },
                { texture: r.c.texture, bgra: r.result.bgra, wrap: r.c.wrap },
            ]),
            options,
            upscaler,
        );
        list.forEach((r, k) => {
            r.pbrify = { original: crop(made[2 * k]!, 384), delit: crop(made[2 * k + 1]!, 384) };
        });
        fs.rmSync(work, { recursive: true, force: true });
    }
    // (each row also as a PNG strip: original | de-lit | shading [| PBRify from original | from de-lit])
    const strips = path.join(out, "strips");
    fs.rmSync(strips, { recursive: true, force: true });
    fs.mkdirSync(strips, { recursive: true });
    rows.forEach((r, k) => {
        const t = r.c.texture;
        const images = [
            toImage(r.c.bgra, t.width, t.height),
            toImage(r.result.bgra, t.width, t.height),
            greyImage(dl.shadingPicture(r.result.shading), t.width, t.height),
        ];
        if (r.pbrify) images.push(r.pbrify.original, r.pbrify.delit);
        const name = `${String(k).padStart(2, "0")}-${r.c.category.replace(" ", "_")}-${hex(t.checksum)}.png`;
        const s = Math.max(1, Math.floor((r.pbrify ? 384 : 256) / t.height));
        fs.writeFileSync(
            path.join(strips, name),
            encodePng(strip(images.map((img, k) => (k < 3 ? enlarge(img, s) : img)))),
        );
    });
    const file = path.join(out, "index.html");
    fs.writeFileSync(file, page(rows, "the game's Data"));
    const tsv = rows.map((r) => {
        const s = r.result.stats;
        return [
            r.c.file,
            hex(r.c.texture.checksum),
            r.c.category,
            s.strength.toFixed(2),
            s.shadingRemoved.toFixed(2),
            s.meanChange.toFixed(1),
            s.chromaShift.toFixed(2),
            s.maxFactor.toFixed(2),
            s.clipped.toFixed(3),
            r.left ? `left: ${r.left}` : r.risks.join("; "),
        ].join("\t");
    });
    fs.writeFileSync(
        path.join(out, "numbers.tsv"),
        `file\tchecksum\tcategory\tk\tremoved\tchange\tchroma\tmaxFactor\tclipped\trisks\n${tsv.join("\n")}\n`,
    );
    print(`${file}: ${rows.length} textures, ${rows.filter((r) => r.risks.length).length} risky`);
    return 0;
}

if (isMain(import.meta.url)) helpFromHeader(import.meta.url);
if (isMain(import.meta.url)) await runMain(() => main());
