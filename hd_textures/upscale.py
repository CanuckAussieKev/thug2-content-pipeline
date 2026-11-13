# NOT ORIGINAL - the GPU side of the base game's HD textures (hd_textures/base.ts): upscales every PNG of a folder by
# exactly 4 with one of two models, in the Python environment hd_textures/fetch_models.ts sets up in
# out\hd_textures\py (pinned packages, nothing committed):
#
#   pbrify   Kim2091's 4x-PBRify_UpscalerV4 (CC0-1.0; a DAT2 network, game textures) loaded by spandrel, run by PyTorch
#            in overlapping tiles (--tile input texels, feathered where they overlap) so VRAM stays bounded;
#   seedvr2  ByteDance Seed's SeedVR2-3B (Apache-2.0; a one-step diffusion transformer) through numz's
#            ComfyUI-SeedVR2_VideoUpscaler command line (Apache-2.0, pinned commit - the official repository's
#            inference needs flash-attn / apex on Linux and doesn't run on Windows or Blackwell GPUs), images grouped
#            by their shorter side (its --resolution), the VAE tiled, a fixed seed.
#
#   python -I upscale.py --model pbrify|seedvr2 --in <folder> --out <folder> --models <folder>
#                        [--seedvr2-code <folder>] [--tile 192] [--vram-gb 10] [--seed 42] [--times <json>]
#
# Deterministic: fixed seeds, cuDNN deterministic, no autotuning. The process runs at below-normal priority and caps
# its share of the GPU's memory (--vram-gb) so games and other work on the machine keep theirs. --times writes the
# seconds and peak VRAM per image.
import argparse
import json
import os
import runpy
import sys
import time

import numpy as np

# PyTorch's own CUDA allocator, fixed before torch is loaded: SeedVR2's command line asks for cudaMallocAsync as it
# loads (os.environ.setdefault), after this process has allocated with the native one - memory then freed by the
# other allocator crashed the process (an access violation after the first image's diffusion step, now and then).
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "backend:native"
import torch  # noqa: E402
from PIL import Image  # noqa: E402

PBRIFY_FILE = "4x-PBRify_UpscalerV4.pth"
SEEDVR2_DIT = "seedvr2_ema_3b_fp16.safetensors"
SCALE = 4


def lower_priority():
    try:
        import psutil

        p = psutil.Process()
        p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 10)
    except Exception:
        pass


def cap_vram(gb):
    if not torch.cuda.is_available():
        raise SystemExit("no CUDA device: the HD texture models need an NVIDIA GPU")
    total = torch.cuda.get_device_properties(0).total_memory
    torch.cuda.set_per_process_memory_fraction(min(1.0, gb * 1024**3 / total), 0)


def deterministic(seed):
    torch.manual_seed(seed)
    np.random.seed(seed)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True


def images(folder):
    return sorted(n for n in os.listdir(folder) if n.lower().endswith(".png"))


# The images still to do (a run stopped part-way - a crash in the GPU driver - is run again by the caller and goes on
# from where it was) and the times so far.
def pending(args):
    return [n for n in images(args.inp) if not os.path.isfile(os.path.join(args.out, n))]


def load_times(args):
    if args.times and os.path.isfile(args.times):
        with open(args.times, encoding="utf-8") as f:
            return json.load(f)
    return {}


# One image done: written whole or not at all, its time recorded at once.
def finish(args, times, name, image, start):
    target = os.path.join(args.out, name)
    image.save(target + ".tmp.png")
    os.replace(target + ".tmp.png", target)
    times[name] = {
        "seconds": round(time.perf_counter() - start, 3),
        "peakVramMB": round(torch.cuda.max_memory_allocated() / 1048576),
    }
    if args.times:
        with open(args.times + ".tmp", "w", encoding="utf-8") as f:
            json.dump(times, f, indent=1)
        os.replace(args.times + ".tmp", args.times)


# ---- PBRify (spandrel) ----


def feather(n, overlap):
    # weights along one side of a tile: rising over the overlap, flat in the middle
    w = np.ones(n, dtype=np.float32)
    if overlap > 0:
        ramp = (np.arange(overlap, dtype=np.float32) + 0.5) / overlap
        w[:overlap] = np.minimum(w[:overlap], ramp)
        w[-overlap:] = np.minimum(w[-overlap:], ramp[::-1])
    return w


def tile_starts(size, tile, overlap):
    if size <= tile:
        return [0]
    step = tile - overlap
    starts = list(range(0, size - tile, step))
    starts.append(size - tile)
    return starts


def run_pbrify(args):
    import spandrel

    model = spandrel.ModelLoader().load_from_file(os.path.join(args.models, PBRIFY_FILE))
    if model.scale != SCALE:
        raise SystemExit(f"{PBRIFY_FILE}: scale {model.scale}, expected {SCALE}")
    model.cuda().eval()
    dtype = torch.bfloat16 if model.supports_bfloat16 else torch.float32
    model.to(dtype)
    times = load_times(args)
    for name in pending(args):
        start = time.perf_counter()
        torch.cuda.reset_peak_memory_stats()
        rgb = np.asarray(Image.open(os.path.join(args.inp, name)).convert("RGB"), dtype=np.float32) / 255.0
        h, w, _ = rgb.shape
        out = np.zeros((h * SCALE, w * SCALE, 3), dtype=np.float32)
        weight = np.zeros((h * SCALE, w * SCALE, 1), dtype=np.float32)
        tile, overlap = args.tile, args.tile // 8
        for y in tile_starts(h, tile, overlap):
            for x in tile_starts(w, tile, overlap):
                th, tw = min(tile, h), min(tile, w)
                piece = torch.from_numpy(rgb[y : y + th, x : x + tw].transpose(2, 0, 1).copy())
                with torch.inference_mode():
                    result = model(piece.unsqueeze(0).cuda().to(dtype)).float().clamp(0, 1)[0]
                result = result.cpu().numpy().transpose(1, 2, 0)
                ov = overlap * SCALE if (th < h or tw < w) else 0
                fy = feather(th * SCALE, ov if th < h else 0)
                fx = feather(tw * SCALE, ov if tw < w else 0)
                f = (fy[:, None] * fx[None, :])[:, :, None]
                ys, xs = y * SCALE, x * SCALE
                out[ys : ys + th * SCALE, xs : xs + tw * SCALE] += result * f
                weight[ys : ys + th * SCALE, xs : xs + tw * SCALE] += f
        out = np.clip(out / np.maximum(weight, 1e-6) * 255.0 + 0.5, 0, 255).astype(np.uint8)
        finish(args, times, name, Image.fromarray(out, "RGB"), start)
    return times


# ---- SeedVR2 (numz's command line, in this process: the VRAM cap and the priority apply to it) ----


def run_seedvr2(args):
    code = os.path.abspath(args.seedvr2_code)
    cli = os.path.join(code, "inference_cli.py")
    if not os.path.isfile(cli):
        raise SystemExit(f"{cli} not found: node tools/pipeline/hd_textures/fetch_models.ts seedvr2")
    saved_argv, saved_cwd = sys.argv, os.getcwd()
    # its own options, parsed by its parser; --resolution (the shorter side wanted) is set per image below
    work = os.path.join(args.out, "_seedvr2")
    os.makedirs(work, exist_ok=True)
    sys.argv = [cli, args.inp, "--output", work, "--output_format", "png", "--model_dir", args.models]
    sys.argv += ["--dit_model", SEEDVR2_DIT, "--batch_size", "1", "--seed", str(args.seed), "--cache_dit"]
    sys.argv += ["--cache_vae", "--vae_encode_tiled", "--vae_decode_tiled"]
    sys.argv += ["--vae_encode_tile_size", "512", "--vae_encode_tile_overlap", "64"]
    sys.argv += ["--vae_decode_tile_size", "512", "--vae_decode_tile_overlap", "64"]
    sys.path.insert(0, code)
    os.chdir(code)
    try:
        seedvr2 = runpy.run_path(cli, run_name="seedvr2_cli")  # (its module: main() not run)
        options = seedvr2["parse_arguments"]()
        if not seedvr2["download_weight"](
            dit_model=options.dit_model, vae_model=seedvr2["DEFAULT_VAE"], model_dir=options.model_dir,
            debug=seedvr2["debug"],
        ):
            raise SystemExit("SeedVR2's model files are missing or don't match their SHA-256")
        cache = {}  # (the runner and both models kept between images)
        times = load_times(args)
        for name in pending(args):
            source = os.path.join(args.inp, name)
            with Image.open(source) as im:
                want = (im.size[0] * SCALE, im.size[1] * SCALE)
            options.resolution = min(want)
            made = os.path.join(work, name)
            torch.cuda.reset_peak_memory_stats()
            start = time.perf_counter()
            seedvr2["process_single_file"](source, options, ["0"], made, format_auto_detected=False, runner_cache=cache)
            if not os.path.isfile(made):
                raise SystemExit(f"SeedVR2 made no {name}")
            with Image.open(made) as im:
                result = im.convert("RGB")
            if result.size != want:  # (its sizes are rounded to its own grid: brought to exactly 4x)
                result = result.resize(want, Image.Resampling.LANCZOS)
            finish(args, times, name, result, start)
            os.remove(made)
        return times
    finally:
        sys.argv = saved_argv
        os.chdir(saved_cwd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["pbrify", "seedvr2"], required=True)
    parser.add_argument("--in", dest="inp", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--models", required=True)
    parser.add_argument("--seedvr2-code", default=None)
    parser.add_argument("--tile", type=int, default=192)
    parser.add_argument("--vram-gb", type=float, default=10)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--times", default=None)
    args = parser.parse_args()
    args.inp, args.out, args.models = (os.path.abspath(p) for p in (args.inp, args.out, args.models))
    args.times = args.times and os.path.abspath(args.times)
    # (SeedVR2's log prints emoji: a cp1252 console can't encode them)
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    lower_priority()
    cap_vram(args.vram_gb)
    deterministic(args.seed)
    os.makedirs(args.out, exist_ok=True)
    times = run_pbrify(args) if args.model == "pbrify" else run_seedvr2(args)
    print(f"upscaled {len(times)} images with {args.model}")


if __name__ == "__main__":
    main()
