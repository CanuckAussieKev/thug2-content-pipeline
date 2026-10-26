# Third-party code and data

This repository (the THUG2 content pipeline, MIT - LICENSE) contains, is derived in part from, or downloads the
following. Their licences apply to those parts.

| Component | Where | Licence |
|---|---|---|
| Python's `difflib` (SequenceMatcher, its ratios, get_close_matches, unified_diff) - CPython, https://github.com/python/cpython (`Lib/difflib.py`) | `lib/difflib.ts`: a TypeScript translation of those parts, the same algorithm step by step so the results are Python's | PSF License Agreement - below |
| CPython's `vector_norm` (`math.hypot` / `math.dist`, `Modules/mathmodule.c`) | `lib/py.ts` (`vectorNorm`, used by `pyHypot` / `pyDist`): a TypeScript translation | PSF License Agreement - below |
| Anton (The Anton Project Authors), IBM Plex Mono and IBM Plex Sans (IBM Corp.) - from https://github.com/google/fonts (ofl/anton, ofl/ibmplexmono, ofl/ibmplexsans) | `fonts/*.ttf`, copied into the data overlay's frontend\fonts by `menu_level/make_menu_level.ts` (`IBMPlexSans-Regular.ttf` is the variable IBMPlexSans[wdth,wght].ttf renamed) | SIL Open Font License 1.1 - `fonts/OFL-*.txt` |
| Real-ESRGAN v0.2.5.0 (Xintao Wang et al.) - https://github.com/xinntao/Real-ESRGAN: its Windows build of realesrgan-ncnn-vulkan (`realesrgan-ncnn-vulkan-20220424-windows.zip`, SHA-256 checked) with the models realesrgan-x4plus and realesrgan-x4plus-anime | **not in this repository**: downloaded on request by `hd_textures/fetch.ts` into the decomp's `out\` (git-ignored) and run by the converters' `--hd-textures` pass and the HD UI. Only the textures it makes (from the user's own game files) end up in the output | Real-ESRGAN and its released models: BSD 3-clause - https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE; the ncnn front end (Real-ESRGAN-ncnn-vulkan, after nihui's realsr-ncnn-vulkan): MIT; Tencent ncnn: BSD 3-clause; the zip's vcomp140.dll is Microsoft's redistributable OpenMP runtime |
| Natural Earth - https://www.naturalearthdata.com/ (the 1:110m and 1:50m physical vectors "land" and "lakes") | **not in this repository**: fetched on request by `hd_textures/globe/fetch.ts` from https://github.com/nvkelso/natural-earth-vector into `out\natural_earth` (git-ignored); used to redraw the level select globe's tiles (`hd_textures/globe`), only with the HD UI option | public domain - below |
| NeverScript (byxor; THUG2 fork by violetvandal) - https://github.com/violetvandal/NeverScript | **not in this repository**: the tools run the `ns.exe` the THUG2 decomp builds (its `tools\build_neverscript.ps1` downloads it) | no licence; its author's permission - the decomp's THIRD_PARTY_NOTICES.md |

Format references read as documentation only (no code copied): thps-formats (Morten1337, MIT - the decomp's
THIRD_PARTY_NOTICES.md) and io_thps_scene (denetii, no licence).

## Python Software Foundation License (difflib.ts, py.ts's vectorNorm)

Changes made (clause 3 below): the parts of `difflib.py` named above and `vector_norm` from `mathmodule.c` translated
into TypeScript - sequences as arrays, no junk function (SequenceMatcher's "popular element" autojunk kept), only what
the tools call; the behaviour and results kept the same as Python's.

```
PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2
--------------------------------------------

1. This LICENSE AGREEMENT is between the Python Software Foundation
("PSF"), and the Individual or Organization ("Licensee") accessing and
otherwise using this software ("Python") in source or binary form and
its associated documentation.

2. Subject to the terms and conditions of this License Agreement, PSF hereby
grants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,
analyze, test, perform and/or display publicly, prepare derivative works,
distribute, and otherwise use Python alone or in any derivative version,
provided, however, that PSF's License Agreement and PSF's notice of copyright,
i.e., "Copyright (c) 2001 Python Software Foundation; All Rights Reserved"
are retained in Python alone or in any derivative version prepared by Licensee.

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python.

4. PSF is making Python available to Licensee on an "AS IS"
basis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between PSF and
Licensee.  This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using Python, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.
```

Copyright (c) 2001 Python Software Foundation; All Rights Reserved.

## Natural Earth (public domain)

"All versions of Natural Earth raster + vector map data found on this website are in the public domain. You may use
the maps in any manner, including modifying the content and design, electronically, in printed row, or any other
format." Made with Natural Earth.
