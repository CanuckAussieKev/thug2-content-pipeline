// NOT ORIGINAL - the two AI upscalers the base game's HD textures can use (base.ts), pinned: where each model's files
// come from (their official pages), their SHA-256, their licences, and the Python environment that runs them
// (upscale.py). fetch_models.ts downloads them into out\hd_textures (git-ignored); nothing of them is committed or
// shipped - the player's machine fetches them and runs them on the player's own game files.
//
// pbrify   4x-PBRify_UpscalerV4 by Kim2091 - CC0-1.0 (OpenModelDB: openmodeldb.info/models/4x-PBRify-UpscalerV4;
//          the file from the author's GitHub release). A DAT2 network trained on game textures (2000s-era textures
//          to modern quality; removes DXT compression artefacts). RGB in, RGB out, x4.
// seedvr2  SeedVR2-3B by ByteDance Seed - Apache-2.0 (github.com/ByteDance-Seed/SeedVR; the weights at
//          huggingface.co/ByteDance-Seed/SeedVR2-3B). A one-step diffusion transformer for video / image restoration.
//          Run through numz's ComfyUI-SeedVR2_VideoUpscaler (Apache-2.0) at a pinned commit, whose command line works
//          on Windows with PyTorch's own attention: the official inference code needs flash-attn 2.5.9 and NVIDIA apex
//          built for PyTorch 2.4 / CUDA 12.1 (Linux wheels), which don't run on Windows or on Blackwell GPUs. Its
//          weights are numz's safetensors conversion of ByteDance's (the same Apache-2.0 model; Hugging Face
//          numz/SeedVR2_comfyUI at a pinned commit, the hashes its own registry lists).

import * as path from "node:path";
import { REPO } from "thug2-level-converter-core/level_port/common.ts";

export const MODEL_NAMES = ["pbrify", "seedvr2"] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

export interface ModelFile {
    name: string;
    url: string;
    sha256: string;
    bytes: number;
}

export interface ModelInfo {
    name: ModelName;
    title: string;
    licence: string;
    page: string;
    files: ModelFile[];
    // a code repository the runner needs (cloned at `commit`)
    code?: { url: string; commit: string; licence: string };
    // the cache key's model part: changes whenever the model or how it's run changes
    tag: string;
}

const SEEDVR2_HF = "https://huggingface.co/numz/SeedVR2_comfyUI/resolve/09ced71023636e9bc8cdf9cdecfb2625d1e691e8";

export const MODELS: Record<ModelName, ModelInfo> = {
    pbrify: {
        name: "pbrify",
        title: "4x-PBRify_UpscalerV4 (Kim2091, DAT2)",
        licence: "CC0-1.0",
        page: "https://openmodeldb.info/models/4x-PBRify-UpscalerV4",
        files: [
            {
                name: "4x-PBRify_UpscalerV4.pth",
                url: "https://github.com/Kim2091/Kim2091-Models/releases/download/4x-PBRify_UpscalerV4/4x-PBRify_UpscalerV4.pth",
                sha256: "82db39e31e01da6816a9814c0553a8dcdb7bd2d655353e67075c9295068cb789",
                bytes: 140345646,
            },
        ],
        tag: "pbrify-v4-spandrel0.4.2-bf16-tile192",
    },
    seedvr2: {
        name: "seedvr2",
        title: "SeedVR2-3B (ByteDance Seed, fp16)",
        licence: "Apache-2.0",
        page: "https://github.com/ByteDance-Seed/SeedVR",
        files: [
            {
                name: "seedvr2_ema_3b_fp16.safetensors",
                url: `${SEEDVR2_HF}/seedvr2_ema_3b_fp16.safetensors`,
                sha256: "2fd0e03a3dad24e07086750360727ca437de4ecd456f769856e960ae93e2b304",
                bytes: 6783018808,
            },
            {
                name: "ema_vae_fp16.safetensors",
                url: `${SEEDVR2_HF}/ema_vae_fp16.safetensors`,
                sha256: "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1",
                bytes: 501324814,
            },
        ],
        code: {
            url: "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler",
            commit: "4490bd1f482e026674543386bb2a4d176da245b9",
            licence: "Apache-2.0",
        },
        tag: "seedvr2-3b-fp16-numz4490bd1-seed42-vaetile512",
    },
};

// The Python environment: CPython (uv fetches it), PyTorch from its CUDA 12.8 wheels (Blackwell GPUs need 12.8+),
// the rest from requirements-upscale.txt.
export const PYTHON_VERSION = "3.12";
export const TORCH_INDEX = "https://download.pytorch.org/whl/cu128";
export const TORCH_PACKAGES = ["torch==2.9.1+cu128", "torchvision==0.24.1+cu128"];

export const HD_DIR = path.join(REPO, "out", "hd_textures");
export const PY_DIR = path.join(HD_DIR, "py");
export const PYTHON = path.join(PY_DIR, "Scripts", "python.exe");
export const MODELS_DIR = path.join(HD_DIR, "models");
export const seedvr2Code = (): string => path.join(HD_DIR, `seedvr2-${MODELS.seedvr2.code!.commit.slice(0, 8)}`);
export const RUNNER = path.join(import.meta.dirname, "upscale.py");
export const REQUIREMENTS = path.join(import.meta.dirname, "requirements-upscale.txt");

export function isModelName(name: string): name is ModelName {
    return (MODEL_NAMES as readonly string[]).includes(name);
}
