# THUG2 content pipeline

> **Not affiliated with or endorsed by Activision, Neversoft or any other rights holder.** A non-commercial fan project
> for preservation, interoperability and education. No game files are included: the tools work only on copies of the
> games you own. Game names are trademarks of their owners. MIT licence (LICENSE); the fonts in `fonts/` are under the
> SIL Open Font License; other third-party parts (CPython-derived helpers, downloaded tools and data) are listed in
> THIRD_PARTY_NOTICES.md. Rights holders: open an issue and it will be dealt with promptly.


The tools that turn the Tony Hawk games you have installed into content for Tony Hawk's Underground 2 (PC): every
level converter (THPS2, THPS3, THPS4, THUG, THAW, Project 8 and THUG2's own levels), the shared readers and writers
for the Neversoft formats, the data overlay and menu builder (level select, the new front end's data, HD menu art,
scenic level art), the THAW BMX asset and ride tools, the Project 8 save tool, and the scripts that run and drive the
game for tests.

Part of the THUG2 decompilation, [github.com/CanuckAussieKev/thug2-decomp](https://github.com/CanuckAussieKev/thug2-decomp),
where it is the submodule `tools/pipeline`. Run everything from that repository's root with Node 24, e.g.

    node tools/pipeline/thps3_levels/thps3_levels.ts convert --thug2 C:\Games\THUG2
    node tools/pipeline/menu_level/make_menu_level.ts --game C:\Games\THUG2 --hd-ui 4

Each folder has its own README.

## With or without the decomp around it

`lib/decomp.ts` finds the decomp checkout by walking up from this repository to the first folder with its
`CMakeLists.txt` and `src/game` (or `THUG2_DECOMP=<folder>`); nothing counts folders up. On its own (a plain clone),
`npm install`, `npm run typecheck` and `npm test` work (a test that reads the decomp's source is skipped), every tool's
`--help` works, and `out\` is this repository's own. What needs the decomp, and why:

| Needs | Tools | Why |
|---|---|---|
| NeverScript's `ns.exe` (the decomp builds it: `tools\build_neverscript.ps1` -> `out\neverscript\ns.exe`) - or `--ns <ns.exe>` | every converter's `convert` (thps2/3/4, thug1, thaw, thp8), `thaw_bmx/convert.ts` (text only without it), `menu_level/make_menu_level.ts`, `game/make_automation_tables.ts`, `game/boot_level.ts`, `thug1_campaign/script_gap.ts --dump` | QB scripts compiled / decompiled |
| `src/game/*.cpp` + `data/derived/functions.json` | `game/exe_audit.ts` | its REPLACE lines, Ghidra's function list (the decomp's tools/ghidra) |
| `src/game/net/thugpro_join.h` | `compat/thugpro/scripts_hash.ts` | the constant it checks |
| `src/game/front/automation_tables.inc` | `game/make_automation_tables.ts` (or `--out`) | what it writes |
| `notes/data/install_manifest.json` (private notes repo) | `game/install_manifest.ts` (or `--manifest` / `--out`) | the reference install's manifest |
| `src/game/skater/thaw_bmx*.cpp` | `thaw_bmx/ride.test.ts` (skipped alone) | the script names the DLL runs |
| the decomp's `dinput8.dll` in the game folder | the game scripts (`game/*.ps1`, `try_spot.ts`, `edit_level.ts`, `scenic_capture.ts`) | they run the game with our DLL (logs, automation channel, `-level`) |

The menu builder also installs the Anteara Mod when `tools/anteara` (the anteara-mod repository) is there - beside this
repository or in the decomp; without it the overlay is made without its `anteara\` folder (a message says so).
Everything else - the format readers, the audits (zfight, texture_check, script_check...), the THUGPRO compare /
inventory tools, the save tool, the scenic / loading / front end art - runs on the game folders alone.

Nothing from the games is in this repository: every converter reads your own installed copies and writes into your
game folder. `fonts/` holds the new front end's typefaces (Anton, IBM Plex Mono / Sans) under the SIL Open Font License
(`fonts/OFL-*.txt`).
