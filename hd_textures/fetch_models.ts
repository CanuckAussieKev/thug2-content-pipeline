// NOT ORIGINAL - sets up what the base game's HD textures (base.ts) run: the Python environment (out\hd_textures\py:
// CPython 3.12 and PyTorch for CUDA 12.8 through uv, the packages pinned in requirements-upscale.txt) and the model
// files (out\hd_textures\models, each checked against its SHA-256) - models.ts has the pins, the sources and the
// licences. Nothing of it is committed; an NVIDIA GPU is needed to run them.
//
//     node tools/pipeline/hd_textures/fetch_models.ts pbrify|seedvr2|all [--force]
//
// A file already there with the right SHA-256 isn't downloaded again; --force sets the environment up again. Needs uv
// (docs.astral.sh/uv) on PATH. SeedVR2's runner code is cloned at its pinned commit (git).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { exitWith, helpFromHeader, isMain, print, runMain } from "thug2-level-converter-core/lib/cli.ts";
import {
    isModelName,
    MODEL_NAMES,
    MODELS,
    MODELS_DIR,
    type ModelFile,
    type ModelName,
    PY_DIR,
    PYTHON,
    PYTHON_VERSION,
    REQUIREMENTS,
    seedvr2Code,
    TORCH_INDEX,
    TORCH_PACKAGES,
} from "./models.ts";

export async function sha256File(file: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest("hex");
}

function run(command: string, args: string[], cwd?: string): void {
    const result = spawnSync(command, args, { stdio: "inherit", cwd });
    if (result.error) exitWith(`${command}: ${result.error.message}`);
    if (result.status !== 0) exitWith(`${command} ${args.join(" ")}: exit ${result.status}`);
}

async function download(file: ModelFile): Promise<void> {
    const target = path.join(MODELS_DIR, file.name);
    if (
        fs.existsSync(target) &&
        fs.statSync(target).size === file.bytes &&
        (await sha256File(target)) === file.sha256
    ) {
        print(`  ${file.name}: there (SHA-256 ok)`);
        return;
    }
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    print(`  downloading ${file.url} (${(file.bytes / 1048576).toFixed(0)} MB)`);
    const response = await fetch(file.url);
    if (!response.ok || !response.body) exitWith(`download failed: HTTP ${response.status}`);
    const temp = `${target}.part`;
    await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        fs.createWriteStream(temp),
    );
    const hash = await sha256File(temp);
    if (hash !== file.sha256) {
        fs.rmSync(temp);
        exitWith(`${file.name}: SHA-256 mismatch: got ${hash}, expected ${file.sha256} - not kept`);
    }
    fs.renameSync(temp, target);
}

function pythonEnvironment(force: boolean): void {
    if (fs.existsSync(PYTHON) && !force) {
        print(`Python environment: there (${PY_DIR})`);
        return;
    }
    print(`Python environment: ${PY_DIR}`);
    fs.rmSync(PY_DIR, { recursive: true, force: true });
    run("uv", ["venv", "--python", PYTHON_VERSION, PY_DIR]);
    run("uv", ["pip", "install", "--python", PYTHON, "--index-url", TORCH_INDEX, ...TORCH_PACKAGES]);
    run("uv", ["pip", "install", "--python", PYTHON, "-r", REQUIREMENTS]);
}

function seedvr2Runner(): void {
    const code = MODELS.seedvr2.code!;
    const folder = seedvr2Code();
    const head = (): string =>
        spawnSync("git", ["rev-parse", "HEAD"], { cwd: folder, encoding: "utf8" }).stdout?.trim() ?? "";
    if (fs.existsSync(path.join(folder, "inference_cli.py")) && head() === code.commit) {
        print(`SeedVR2 runner: there (${folder})`);
        return;
    }
    fs.rmSync(folder, { recursive: true, force: true });
    run("git", ["clone", "--quiet", code.url, folder]);
    run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", code.commit], folder);
    if (head() !== code.commit) exitWith(`${folder}: not at ${code.commit}`);
}

export async function fetchModels(names: readonly ModelName[], force = false): Promise<void> {
    pythonEnvironment(force);
    for (const name of names) {
        const model = MODELS[name];
        print(`${model.title} - ${model.licence} (${model.page})`);
        for (const file of model.files) await download(file);
        if (name === "seedvr2") seedvr2Runner();
    }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    const force = argv.includes("--force");
    const rest = argv.filter((a) => a !== "--force");
    const which = rest[0];
    if (rest.length !== 1 || !which || (which !== "all" && !isModelName(which)))
        exitWith(`usage: fetch_models.ts ${MODEL_NAMES.join("|")}|all [--force]`);
    await fetchModels(which === "all" ? MODEL_NAMES : [which], force);
    print("ready");
    return 0;
}

if (isMain(import.meta.url)) helpFromHeader(import.meta.url);
if (isMain(import.meta.url)) await runMain(() => main());
