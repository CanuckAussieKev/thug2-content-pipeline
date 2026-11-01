# Third-party code and data

This repository (the THUG2 content pipeline, MIT - LICENSE) contains, is derived in part from, or downloads the
following. Their licences apply to those parts. The level converters and thug2-level-converter-core (its
CPython-derived helpers) have their own THIRD_PARTY_NOTICES.md.

| Component | Where | Licence |
|---|---|---|
| Anton (The Anton Project Authors), IBM Plex Mono and IBM Plex Sans (IBM Corp.) - from https://github.com/google/fonts (ofl/anton, ofl/ibmplexmono, ofl/ibmplexsans) | `fonts/*.ttf`, copied into the data overlay's frontend\fonts by `menu_level/make_menu_level.ts` (`IBMPlexSans-Regular.ttf` is the variable IBMPlexSans[wdth,wght].ttf renamed) | SIL Open Font License 1.1 - `fonts/OFL-*.txt` |
| Real-ESRGAN v0.2.5.0 (Xintao Wang et al.) - https://github.com/xinntao/Real-ESRGAN: its Windows build of realesrgan-ncnn-vulkan (`realesrgan-ncnn-vulkan-20220424-windows.zip`, SHA-256 checked) with the models realesrgan-x4plus and realesrgan-x4plus-anime | **not in this repository**: downloaded on request by `hd_textures/fetch.ts` into the decomp's `out\` (git-ignored) and run by the converters' `--hd-textures` pass and the HD UI. Only the textures it makes (from the user's own game files) end up in the output | Real-ESRGAN and its released models: BSD 3-clause - https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE; the ncnn front end (Real-ESRGAN-ncnn-vulkan, after nihui's realsr-ncnn-vulkan): MIT; Tencent ncnn: BSD 3-clause; the zip's vcomp140.dll is Microsoft's redistributable OpenMP runtime |
| Natural Earth - https://www.naturalearthdata.com/ (the 1:110m and 1:50m physical vectors "land" and "lakes") | **not in this repository**: fetched on request by `hd_textures/globe/fetch.ts` from https://github.com/nvkelso/natural-earth-vector into `out\natural_earth` (git-ignored); used to redraw the level select globe's tiles (`hd_textures/globe`), only with the HD UI option | public domain - below |
| PartyMod v1.0.4 (PARTYMANX) - https://github.com/PARTYMANX/partymod-thug2: its `patches/keyboard.bps` (the on-screen keyboard's keys on PC) | `menu_level/partymod_keyboard.bps`, applied by `menu_level/make_menu_level.ts` (`keyboard_qwerty.ts`) to the user's own keyboard script for the data overlay's | MIT - below |
| NeverScript (byxor; THUG2 fork by violetvandal) - https://github.com/violetvandal/NeverScript | **not in this repository**: the tools run the `ns.exe` the THUG2 decomp builds (its `tools\build_neverscript.ps1` downloads it) | no licence; its author's permission - the decomp's THIRD_PARTY_NOTICES.md |

Format references read as documentation only (no code copied): thps-formats (Morten1337, MIT - the decomp's
THIRD_PARTY_NOTICES.md) and io_thps_scene (denetii, no licence).

## PartyMod v1.0.4 (PARTYMANX) (MIT)

Source: https://github.com/PARTYMANX/partymod-thug2 (v1.0.4)

```
MIT License

Copyright (c) 2024 PARTYMANX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Natural Earth (public domain)

"All versions of Natural Earth raster + vector map data found on this website are in the public domain. You may use
the maps in any manner, including modifying the content and design, electronically, in printed row, or any other
format." Made with Natural Earth.
