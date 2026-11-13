# HD textures (optional AI upscaling of converted levels, the menus and the base game)

An optional pass of the level converters (THPS3 so far: `thug2-thps3-level-converter/thps3_levels`) that upscales a level's own textures
with [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)'s standalone `realesrgan-ncnn-vulkan` (BSD-3-Clause;
Vulkan, no CUDA or PyTorch). **Off by default** - a convert without `--hd-textures` writes exactly what it wrote
before and never touches the cache. The code is `thug2-level-converter-core/level_port/hd_textures.ts` (its header has the details),
DXT decode / encode `thug2-level-converter-core/level_port/dxt.ts`, tests `thug2-level-converter-core/level_port/hd_textures.test.ts`.

## Setup (once)

    node tools/pipeline/hd_textures/fetch.ts

downloads the pinned release (realesrgan-ncnn-vulkan-20220424, SHA-256 checked) into `out\hd_textures\` (git-ignored;
nothing of it is committed). Models shipped: `realesrgan-x4plus` (the default) and `realesrgan-x4plus-anime`.

## Use

    node tools/pipeline/run.ts thps3_levels/thps3_levels.ts convert foun can --thug2 C:\Games\THUG2-n --hd-textures 2
    node tools/pipeline/menu_level/make_menu_level.ts --game C:\Games\THUG2-n

The game reads the levels from the data overlay (`thug2-decomp-data`), so **make_menu_level has to run after every
convert** - converting alone leaves the game on the textures installed before.

| option | |
|---|---|
| `--hd-textures [2\|4]` | turn the pass on, x2 or x4 (default 4) |
| `--hd-max N` | the longer side at most N (default 1024; the scale halves until it fits) |
| `--hd-min N` | textures smaller than N on their longer side left alone (default 16) |
| `--hd-model M` | `realesrgan-x4plus` / `realesrgan-x4plus-anime` |
| `--hd-cache DIR` | the cache (default `%LOCALAPPDATA%\thug2-decomp\hd-textures`) |
| `--hd-cache-clear` | empty the cache first |
| `--hd-no-match` | keep the model's own colours / contrast (default: pulled back to the original's) |
| `--hd-tool EXE`, `--hd-gpu ID` | another upscaler binary, a GPU index (its `-g`) |

What the pass does per texture: colour upscaled on its own (texels under alpha 0 filled from their neighbours first,
so no dark halo); a cut-out's alpha (only 0 / 255) scaled bilinearly and thresholded at 128 - sharp, no grey fringe;
smooth alpha through the model as a grey image; 16 texels of padding (the texture's other edge where it's wrapped,
its own edge where clamped) cut off afterwards, so tiling textures show no seams; the result back-projected so every
scale x scale block averages to the original texel (colours and contrast stay the original's); written in the format
it came in (32-bit, DXT1, DXT5) with a full mip chain.

## Cache

Persistent, outside the repo's tracked files and the game folders: one gzipped BGRA file per texture, keyed by the
SHA-256 of the source texels plus every setting that changes the pixels (pass version, tool release, model, scale used,
padding, wrap u / v, size, format). The convert reports hits and misses:

    HD textures (realesrgan-x4plus, x4, cap 1024): 416 of 416 upscaled (416 from the cache, 0 made)

## Measurements (2026-10-22, Foundry + Canada, workspace THUG2-3)

| | texture data | convert (cold / cached) | game peak working set | GPU dedicated |
|---|---|---|---|---|
| original | 16.4 MB | - | 160-163 MB | 45-52 MB |
| x2 | 65.8 MB | 54 s / - | 193-206 MB | 77-92 MB |
| x4 (cap 1024) | 263.3 MB | 62 s / 9 s | 304-372 MB | 121-194 MB |

Both levels load and play at x4 (no warnings, no errors in the log); time to the level didn't change measurably
(47-58 s from start in every case, run-to-run noise). Cache for both levels at x2 and x4: 105 MB.

Known look issues: the model invents fine detail - brushed / noisy metal can turn into a woven pattern (Canada's
quarter pipes), plain concrete gets grain; a cut-out's isolated single opaque texels (Canada's cloud billboard) show
as specks a little more than in the original.

## Comparing

- `node tools/pipeline/hd_textures/compare_tex.ts <orig.tex.xbx> <hd.tex.xbx> <out>` - texture pairs on a checkerboard.
- `node tools/pipeline/hd_textures/compare_shots.ts <out.png> <a.png> <b.png> [...] [--crop x,y,w,h] [--zoom N]` - game
  screenshots of the same views side by side.

## HD menu UI (experiment, off by default)

The menus' 2D images (`.img.xbx` sprites) and bitmap fonts (`.fnt.xbx` glyph pages) upscaled into the data overlay:
`tools/pipeline/hd_textures/ui.ts` (the same pass: cache, back-projection; `realesrgan-x4plus-anime` by default - flat
colours, outlines and text). Make the files, then switch them on in the ini:

    node tools/pipeline/menu_level/make_menu_level.ts --game C:\Games\THUG2-n --hd-ui 4    (or 2; without it: no HD files)
    thug2-decomp.ini  [features] hd_ui=1                                          (default 0: the files are never read)

The files go in the overlay's `thug2-decomp-data\hd_ui` folder (same relative names as the normal overlay; the data
overlay consults it first only while hd_ui=1), so one install carries them and the ini alone switches. The game always
has the code.

A sprite's size on screen comes from its texture's image size and a glyph's from the font's rectangles, so the
upscaled files carry a marker (`.img.xbx` header +0x14 = 0x4844000s, `.fnt.xbx` glyph page header +8 = "HDUI", +0xC
the scale) and the game reports the original's sizes (src/game/gfx/hd_ui.h).

Files: every image and font in mainmenusprites / panelsprites / Levelselect / multiplayersprites / Themes / fonts.prx
and the overlay's own level select signs; the loose loading screens at x4 with realesrgan-x4plus as DXT1 (header format
"DXT1", `--loading-model M` / make_menu_level `--hd-ui-loading-model M` to change the model). Not: Create-A-Graphic pieces, PermTex / Bits, level
textures (`.tex.xbx`, also the front end's THPS4 skate shop). `node tools/pipeline/hd_textures/ui.ts <game> <out> [--scale N]`
writes them anywhere.

## DXT compression

Upscaled textures that were 32-bit are written as DXT1 (opaque), DXT1 with 1-bit alpha (cut-out) or DXT5 (soft alpha)
with full mips - about 1/8 (DXT1) or 1/4 (DXT5) of the 32-bit size - unless `--hd-no-compress`. THPS2 at x4: 1.37 GB
-> 171 MB; THPS3 1.56 GB -> 241 MB; mean error against the 32-bit x4 about 1-4 of 255. Never applied to the HD menu UI.
`node tools/pipeline/hd_textures/compare_tex.ts a.tex.xbx b.tex.xbx <out> --per-kind 3` compares two builds per alpha kind.

## The base game: PBRify or SeedVR2 (optional, off by default)

The base game's own textures upscaled x4 on the player's machine, from the player's own files, with one of two AI
models side by side for comparison. Nothing is shipped or committed: the models, the Python that runs them and every
texture they make stay in the decomp's `out\` (git-ignored) and in the game folder.

| model | what it is | licence | source |
|---|---|---|---|
| `pbrify` | 4x-PBRify_UpscalerV4 (Kim2091), a DAT2 network trained on game textures - meant for 2000s textures, takes out DXT blocks | CC0-1.0 | [OpenModelDB](https://openmodeldb.info/models/4x-PBRify-UpscalerV4), the file from the author's GitHub release |
| `seedvr2` | SeedVR2-3B (ByteDance Seed), a one-step diffusion transformer for video / image restoration, fp16 | Apache-2.0 | [ByteDance-Seed/SeedVR](https://github.com/ByteDance-Seed/SeedVR); weights as safetensors from Hugging Face `numz/SeedVR2_comfyUI` (a conversion of ByteDance's) |

SeedVR2 runs through numz's [ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler)
command line (Apache-2.0, pinned commit): the official inference code needs flash-attn 2.5.9 and NVIDIA apex built for
PyTorch 2.4 / CUDA 12.1 (Linux wheels) and doesn't run on Windows or on Blackwell GPUs (RTX 50x0). Both run on PyTorch
2.9.1 for CUDA 12.8 (an NVIDIA GPU; the AMD one can't run them), PBRify loaded by
[spandrel](https://github.com/chaiNNer-org/spandrel) (MIT). The pins (URLs, SHA-256, commits, package versions) are
in `models.ts` and `requirements-upscale.txt`.

### Setup (once)

    node tools/pipeline/hd_textures/fetch_models.ts pbrify|seedvr2|all

makes `out\hd_textures\py` (CPython 3.12 by [uv](https://docs.astral.sh/uv/), PyTorch, the pinned packages; ~5 GB) and
downloads the models into `out\hd_textures\models` (PBRify 134 MB; SeedVR2 6.8 GB + its VAE 0.5 GB), each checked
against its SHA-256; SeedVR2's runner is cloned at its commit.

### Use

    node tools/qbjs/unpack_game.ts --game C:\Games\THUG2-n --hd-textures pbrify        (unpacking, then the textures)
    node tools/qbjs/unpack_game.ts --game C:\Games\THUG2-n --hd-textures seedvr2       (an unpacked game: switch sets)
    node tools/qbjs/unpack_game.ts --game C:\Games\THUG2-n --hd-textures none          (the originals back)
    node tools/pipeline/hd_textures/base.ts --game C:\Games\THUG2-n --model pbrify [--levels BO,AU,foun] [--build-only]
    node tools/pipeline/hd_textures/base.ts --game C:\Games\THUG2-n --restore | --status

No file the game was installed with is written: a Data dictionary's HD version goes into the data overlay
(`thug2-decomp-data\levels\bo\BO.tex.xbx` - the game reads the overlay before its archives and Data, so it works on a
packed game and on an unpacked one alike), our overlays' own dictionaries (the ported levels in
`thug2-decomp-<x>\levels`, the data overlay's levels) are replaced in place. `--levels` limits it to those levels (each
with its `_Sky`); `--hd-scope all` / `--scope all` takes every `.tex.xbx` (peds, skaters, vehicles) instead of the
levels' only. `--build-only` makes a set into its cache without installing it. unpack_game.ts `--restore` takes the
HD textures out first. make_menu_level.ts empties the data overlay when it runs: install the set again after it.

Each set is cached (`out\hd_textures\base\<model>\`: `texels` the model's output per texture, `files` each finished
dictionary by the SHA-256 of the original and the settings), so a set made once installs in seconds and switching
between them is a copy. The record `thug2-decomp-backup\hd_textures\record.json` in the game folder lists every file
written with the SHA-256 of the one it replaced (none for one added to the data overlay) and of the installed one;
replaced originals are kept beside it. Restoring removes the added files and puts the replaced ones back, unless a
file changed or went since (make_menu_level.ts or a converter remade it: theirs is kept).

### What happens to each texture

- tiling found by edge continuity: a texture wraps in u (v) when its last column (row) meets its first as smoothly as
  its neighbouring columns (rows) meet; the model then sees the other edge as padding (16 texels), so tiled surfaces
  show no seams. The materials' own addressing isn't read.
- atlases skipped (listed in the report): a hard straight seam right across, well inside the texture, between two sides
  that are different pictures, in a texture that doesn't repeat that way - several images packed side by side, which
  the padding and the model would mix. Borders and trims near an edge, rows of windows and stripes, and cut-out sheets
  (images apart on transparent texels) aren't atlases. BO: 29 of 788, AU: 38 of 639, foun: 14 of 208.
- colour through the model as RGB (neither model takes alpha); alpha on its own - opaque stays opaque, a cut-out's
  alpha scaled bilinearly and thresholded (sharp, no fringe), soft alpha through the model as grey.
- left alone: textures under 32 texels on their longer side (decals, lights, gradients: the models invent noise
  there), 1024 and larger; a 512 one is made x2 (the model's x4 averaged down). One-colour and paletted ones too.
- only texture dictionaries (`.tex.xbx`): the menus' 2D images and fonts (`.img.xbx`, `.fnt.xbx`) have their own HD
  path (`hd_ui`, above).
- the result pulled back so every 4 x 4 block averages to the original texel (colours and contrast stay the game's),
  a full mip chain made again, written as DXT1 / DXT5 as it came (a 32-bit one compressed). Not BC7: the Direct3D 9
  renderer has no BC7 and the game's texture loaders know DXT1 / 3 / 5 only - BC7 would need a second texture format
  path in both renderers and a decode fallback for Direct3D 9.

The GPU side (`upscale.py`) runs at below-normal priority and caps its share of the GPU's memory (`--vram-gb`,
default 10); one model at a time. PBRify goes over each image in 192-texel tiles (feathered overlaps); SeedVR2 keeps
both its models loaded between images, its VAE tiled at 512, seed 42 (deterministic: the same files from the same
input).

### Comparing the two

    node tools/pipeline/hd_textures/compare_models.ts --game C:\Games\THUG2-n --level BO [--count 12] [--shots]

writes `out\upscale\<level>-tex-<checksum>.png` (original x4 | PBRify | SeedVR2, the middle of a texture at twice the
size) and `<level>-textures.png` (all of them); `--shots` also installs each set in turn in a workspace and captures
the level's spots of `tools/game/rt_shadows.json` on Vulkan (`<level>-shot-<spot>.png`).
