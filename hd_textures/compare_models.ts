// NOT ORIGINAL - the two base-game HD texture sets (base.ts: PBRify UpscalerV4, SeedVR2-3B) next to the originals,
// for choosing between them by eye.
//
//   node tools/pipeline/hd_textures/compare_models.ts --game <folder> --level BO [--out <folder>] [--count 12]
//        [--shots [--spots <plan.json>] [--build <build folder>] [--owner <name>] [--have-lock] [--no-crops]
//                 [--sets original,pbrify,seedvr2]]
//
// Textures (always; no game run): `count` of the level's textures both models upscaled - the most detailed ones, spread
// over the dictionary - each as original (texels enlarged x4) | PBRify | SeedVR2, the middle 64 x 64 texels (256 x 256
// at x4) shown twice the size, alpha over a checkerboard: <out>\<level>-tex-<checksum>.png, and all of them smaller in
// <out>\<level>-textures.png (one row each). Both sets must have been made (base.ts --model <m> --levels <level>
// [--build-only]); they're read from the models' caches, the originals from the game (or from the record's backup
// when a set is installed).
//
// --shots (a workspace C:\Games\THUG2-<n> only, unpacked - unpack_game.ts - with [features] ts_scripts=1): under the
// workspace's lock (taken for the whole run; released at the end, which puts the exe and the ini back) each set is
// installed in turn - originals, PBRify, SeedVR2 - and the level's spots of the plan (default tools/game/rt_shadows.json:
// its groups whose level is --level) captured on Vulkan (tools/game/renderer_parity.ts's runs); then the set that was
// installed before is put back. <out>\shots-<set>\ holds the frames, <out>\<level>-shot-<spot>.png the three side by
// side (original | PBRify | SeedVR2) over the middle of each enlarged x2 (-full.png: the whole frames). --build
// copies that build in first (deploy_build.ps1 -Arch x64). Each run's log is kept beside its pictures. --have-lock:
// the caller holds the lock already (the whole session under one hold: unpack, shots, restore); --no-crops: the
// shots only; --sets: only those sets captured (a set must have been made first) - the side-by-sides take every set
// with a picture of the spot in --out, earlier runs' too. --no-match: the sets made with base.ts --no-match.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "thug2-level-converter-core/level_port/common.ts";
import * as dxt from "thug2-level-converter-core/level_port/dxt.ts";
import { readTex, type Texture } from "thug2-level-converter-core/level_port/tex.ts";
import { exitWith, helpFromHeader, isMain, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import { decodePng, encodePng, type Image } from "thug2-level-converter-core/lib/frame_diff.ts";
import * as base from "./base.ts";
import { crop, sideBySide, zoom } from "./compare_shots.ts";
import { MODEL_NAMES, MODELS, type ModelName } from "./models.ts";

const SETS = ["original", ...MODEL_NAMES] as const;
// --no-match: the sets made with the models' own colours and contrast (base.ts --no-match)
let match = true;
type SetName = (typeof SETS)[number];

// BGRA texels over a checkerboard as RGB.
export function flatten(bgra: Uint8Array, w: number, h: number): Image {
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const a = bgra[i + 3]! / 255;
            const check = ((x >> 3) + (y >> 3)) & 1 ? 200 : 150;
            const o = (y * w + x) * 3;
            rgb[o] = Math.round(bgra[i + 2]! * a + check * (1 - a));
            rgb[o + 1] = Math.round(bgra[i + 1]! * a + check * (1 - a));
            rgb[o + 2] = Math.round(bgra[i]! * a + check * (1 - a));
        }
    return { width: w, height: h, rgb };
}

const texels = (t: Texture): Buffer =>
    t.dxt ? dxt.decode(t.levels[0]!, t.width, t.height, t.dxt) : Buffer.from(t.levels[0]!);

// How much detail a texture has: the standard deviation of its luminance.
function detail(bgra: Uint8Array): number {
    let sum = 0;
    let sq = 0;
    const n = bgra.length / 4;
    for (let i = 0; i < bgra.length; i += 4) {
        const l = 0.114 * bgra[i]! + 0.587 * bgra[i + 1]! + 0.299 * bgra[i + 2]!;
        sum += l;
        sq += l * l;
    }
    return Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
}

// The level's dictionaries as the game had them (the record's backup when a set is installed) with each model's.
function levelSets(
    root: string,
    level: string,
    models: readonly ModelName[] = MODEL_NAMES,
): { name: string; sets: Record<SetName, Buffer> }[] {
    const out: { name: string; sets: Record<SetName, Buffer> }[] = [];
    for (const e of base.collect(root, "levels", [level])) {
        const original = base.originalBytes(root, e);
        const sets = { original } as Record<SetName, Buffer>;
        for (const model of models) {
            const file = path.join(
                base.defaultCacheRoot(),
                model,
                "files",
                base.fileKey(original, model, match).slice(0, 2),
                `${base.fileKey(original, model, match)}.tex.xbx`,
            );
            if (!fs.existsSync(file))
                exitWith(
                    `${e.rel}: no ${model} set made yet - node tools/pipeline/hd_textures/base.ts --game <folder> ` +
                        `--model ${model} --levels ${level} --build-only`,
                );
            sets[model] = fs.readFileSync(file);
        }
        out.push({ name: e.rel, sets });
    }
    if (!out.length) exitWith(`no texture dictionary of level ${level} in ${root}`);
    return out;
}

export function textureCrops(root: string, level: string, outDir: string, count: number): string[] {
    const candidates: { name: string; detail: number; t: Record<SetName, Texture> }[] = [];
    for (const { name, sets } of levelSets(root, level)) {
        const files = Object.fromEntries(SETS.map((s) => [s, readTex(sets[s], `${name} ${s}`)])) as Record<
            SetName,
            ReturnType<typeof readTex>
        >;
        files.original.textures.forEach((t, k) => {
            const p = files.pbrify.textures[k]!;
            const s = files.seedvr2.textures[k]!;
            if (p.width === t.width || s.width === t.width || t.width < 64 || t.height < 64) return;
            candidates.push({ name, detail: detail(texels(t)), t: { original: t, pbrify: p, seedvr2: s } });
        });
    }
    // the most detailed third, every third of them: detailed, but not all alike
    candidates.sort((a, b) => b.detail - a.detail);
    const picked = candidates
        .slice(0, count * 3)
        .filter((_, i) => i % 3 === 0)
        .slice(0, count);
    fs.mkdirSync(outDir, { recursive: true });
    const rows: Image[] = [];
    const written: string[] = [];
    for (const c of picked) {
        const o = c.t.original;
        const scale = c.t.pbrify.width / o.width;
        const side = Math.min(64, o.width, o.height);
        const x0 = Math.floor((o.width - side) / 2);
        const y0 = Math.floor((o.height - side) / 2);
        const panels = SETS.map((s) => {
            const t = c.t[s];
            const k = t.width / o.width;
            const full = flatten(texels(t), t.width, t.height);
            const part = crop(full, x0 * k, y0 * k, side * k, side * k);
            return k === scale ? part : zoom(part, scale / k);
        });
        const big = sideBySide(panels.map((p) => zoom(p, 2)));
        const file = path.join(outDir, `${level}-tex-${o.checksum.toString(16).padStart(8, "0")}.png`);
        fs.writeFileSync(file, encodePng(big));
        written.push(file);
        rows.push(sideBySide(panels));
    }
    if (rows.length) {
        const width = Math.max(...rows.map((r) => r.width));
        const height = rows.reduce((n, r) => n + r.height + 8, -8);
        const sheet = { width, height, rgb: new Uint8Array(width * height * 3).fill(96) };
        let y0 = 0;
        for (const r of rows) {
            for (let y = 0; y < r.height; y++)
                sheet.rgb.set(r.rgb.subarray(y * r.width * 3, (y + 1) * r.width * 3), (y0 + y) * width * 3);
            y0 += r.height + 8;
        }
        const file = path.join(outDir, `${level}-textures.png`);
        fs.writeFileSync(file, encodePng(sheet));
        written.push(file);
    }
    return written;
}

// What --shots uses of the decomp's tools/game/renderer_parity.ts.
interface PlanGroup {
    name: string;
    level?: string;
    ini?: Record<string, string>;
    spots?: { name: string; commands: string[] }[];
}
interface Parity {
    readPlan(text: string): { ini?: Record<string, string>; groups: PlanGroup[] };
    iniFor(base: string, values: readonly Record<string, string>[], renderer: string): string;
    powershell(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }>;
    runGroup(
        game: string,
        group: PlanGroup,
        renderer: string,
        run: number,
        folder: string,
        env: NodeJS.ProcessEnv,
    ): Promise<string>;
}

interface ShotOptions {
    game: string;
    root: string;
    level: string;
    out: string;
    spots: string;
    build: string | null;
    owner: string;
    haveLock: boolean;
    sets: readonly SetName[];
}

async function shots(o: ShotOptions): Promise<string[]> {
    // (the decomp's game-run tools: this pipeline runs inside the decomp's checkout for --shots)
    const parity = (await import(pathToFileURL(path.join(REPO, "tools", "game", "renderer_parity.ts")).href)) as Parity;
    const workspaceIni = (await import(pathToFileURL(path.join(REPO, "tools", "game", "workspace_ini.ts")).href)) as {
        isWorkspace(game: string): boolean;
        ensureWorkspaceMuted(game: string): void;
    };
    if (!workspaceIni.isWorkspace(o.game)) exitWith(`${o.game} isn't a workspace (C:\\Games\\THUG2-<n>)`);
    // (an unpacked game runs its TypeScript: ts_scripts=1; a packed one its .qb)
    const tsScripts = fs.existsSync(path.join(o.root, base.BACKUP, "unpacked.json")) ? "1" : "0";
    const plan = parity.readPlan(fs.readFileSync(o.spots, "utf8"));
    const groups = plan.groups.filter((g) => g.level?.toLowerCase() === o.level.toLowerCase() && g.spots?.length);
    if (!groups.length) exitWith(`${o.spots}: no group with spots in level ${o.level}`);
    // (every set made already: installing one that isn't would run the model for hours under the lock)
    levelSets(
        o.root,
        o.level,
        MODEL_NAMES.filter((m) => o.sets.includes(m)),
    );
    const before = base.readRecord(o.root)?.model ?? "none";
    const beforeMatch = base.readRecord(o.root)?.match ?? true;
    if (!o.haveLock) {
        const lock = await parity.powershell(
            "game_lock.ps1",
            ["-Action", "acquire", "-Owner", o.owner, "-Game", o.game, "-WaitMinutes", "30"],
            process.env,
        );
        print(lock.out.trim());
        if (lock.code !== 0) exitWith("the workspace's lock isn't free");
    } else if (!fs.existsSync(path.join(o.game, ".game-lock"))) exitWith(`--have-lock: ${o.game} isn't locked`);
    const written: string[] = [];
    try {
        if (o.build) {
            const deploy = await parity.powershell(
                "deploy_build.ps1",
                ["-Game", o.game, "-Arch", "x64", "-BuildDir", o.build, "-NoEditorTools"],
                process.env,
            );
            print(deploy.out.trim());
            if (deploy.code !== 0) exitWith("deploy_build.ps1 failed");
        }
        const ini = path.join(o.game, "thug2-decomp.ini");
        const baseIni = fs.readFileSync(ini, "utf8");
        for (const set of o.sets) {
            const result = base.install(o.root, set === "original" ? "none" : set, {
                scope: "levels",
                levels: [o.level],
                buildOnly: false,
                cacheRoot: base.defaultCacheRoot(),
                vramGb: 10,
                log: print,
                match,
            });
            print(`${set}: ${result.installed} files installed`);
            for (const group of groups) {
                fs.writeFileSync(
                    ini,
                    parity.iniFor(
                        baseIni,
                        [plan.ini ?? {}, group.ini ?? {}, { "features.ts_scripts": tsScripts }],
                        "vulkan",
                    ),
                    "utf8",
                );
                workspaceIni.ensureWorkspaceMuted(o.game);
                const folder = path.join(o.out, `shots-${set}`);
                fs.mkdirSync(path.join(folder, "window"), { recursive: true });
                const started = Date.now();
                const notes = await parity.runGroup(o.game, group, "vulkan", 1, folder, process.env);
                print(`${set} ${group.name}: ${notes} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
            }
        }
    } finally {
        base.install(o.root, before, {
            scope: "levels",
            levels: [o.level],
            buildOnly: false,
            cacheRoot: base.defaultCacheRoot(),
            vramGb: 10,
            match: beforeMatch,
        });
        if (!o.haveLock) {
            const release = await parity.powershell(
                "game_lock.ps1",
                ["-Action", "release", "-Owner", o.owner, "-Game", o.game],
                process.env,
            );
            print(release.out.trim());
        }
    }
    for (const group of groups)
        for (const spot of group.spots ?? []) {
            // (every set with a picture of the spot - this run's and earlier runs' into the same folder)
            const pictures = SETS.map((s) => path.join(o.out, `shots-${s}`, `${spot.name}.png`)).filter((p) =>
                fs.existsSync(p),
            );
            if (pictures.length < 2) {
                print(`${spot.name}: fewer than two sets have a picture`);
                continue;
            }
            const images = pictures.map((p) => decodePng(fs.readFileSync(p)));
            const w = images[0]!.width;
            const h = images[0]!.height;
            const middle = images.map((i) =>
                zoom(crop(i, Math.floor(w * 0.375), Math.floor(h * 0.375), Math.floor(w / 4), Math.floor(h / 4)), 2),
            );
            const file = path.join(o.out, `${o.level}-shot-${spot.name}.png`);
            fs.writeFileSync(file, encodePng(sideBySide(middle)));
            const full = path.join(o.out, `${o.level}-shot-${spot.name}-full.png`);
            fs.writeFileSync(full, encodePng(sideBySide(images)));
            written.push(file, full);
        }
    return written;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const args = [...argv];
    const take = (name: string, fallback?: string): string | undefined => {
        const at = args.indexOf(name);
        if (at < 0) return fallback;
        const value = args[at + 1];
        if (value === undefined) exitWith(`${name} needs a value`);
        args.splice(at, 2);
        return value;
    };
    const game = take("--game");
    const level = take("--level");
    if (!game || !level)
        exitWith("usage: compare_models.ts --game <folder> --level <name> [--out <folder>] [--count N] [--shots ...]");
    const out = path.resolve(take("--out", path.join(REPO, "out", "upscale"))!);
    const count = Number(take("--count", "12"));
    const spots = take("--spots", path.join(REPO, "tools", "game", "rt_shadows.json"))!;
    const build = take("--build") ?? null;
    const owner = take("--owner", "compare_models")!;
    const flag = (name: string): boolean => {
        const at = args.indexOf(name);
        if (at >= 0) args.splice(at, 1);
        return at >= 0;
    };
    const wantShots = flag("--shots");
    const haveLock = flag("--have-lock");
    const noCrops = flag("--no-crops");
    match = !flag("--no-match");
    const sets = (take("--sets", SETS.join(",")) ?? "").split(",");
    const unknownSet = sets.find((s) => !(SETS as readonly string[]).includes(s));
    if (unknownSet) exitWith(`--sets: ${unknownSet}? (${SETS.join(", ")})`);
    if (args.length) exitWith(`unknown: ${args.join(" ")}`);
    const root = base.gameRoot(game);
    if (!noCrops) for (const file of textureCrops(root, level, out, count)) print(file);
    if (wantShots) {
        if (!fs.existsSync(spots)) exitWith(`${spots} not found (--spots <plan.json>)`);
        const resolved = build && path.resolve(build);
        const chosen = sets as SetName[];
        for (const file of await shots({
            game,
            root,
            level,
            out,
            spots,
            build: resolved,
            owner,
            haveLock,
            sets: chosen,
        }))
            print(file);
    }
    print(`sets: original | ${MODEL_NAMES.map((m) => MODELS[m].title).join(" | ")}`);
    return 0;
}

if (isMain(import.meta.url)) helpFromHeader(import.meta.url);
if (isMain(import.meta.url)) await runMain(() => main());
