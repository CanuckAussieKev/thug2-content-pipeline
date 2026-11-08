# THUG2 content pipeline

> **Not affiliated with or endorsed by Activision, Neversoft or any other rights holder.** A non-commercial fan project
> for preservation, interoperability and education. No game files are included: the tools work only on copies of the
> games you own. Game names are trademarks of their owners. See LICENSE (MIT for the project's own work; no licence for material
> from the games); the fonts in `fonts/` are under the
> SIL Open Font License; other third-party parts (downloaded tools and data, PartyMod's keyboard patch) are listed in
> THIRD_PARTY_NOTICES.md. Rights holders: open an issue and it will be dealt with promptly.


What turns the Tony Hawk games you have installed into content for Tony Hawk's Underground 2 (PC) and installs it: the
data overlay and menu builder (level select, the new front end's data, HD menu art, scenic level art), THUGPRO's changes
to THUG2's own levels, and the THAW BMX asset and ride tools. The level converters are repositories of their own, and
this one depends on all of them and on THUGPRO's compatibility profile (package.json, pinned to commits):

| Repository | |
|---|---|
| [thug2-level-converter-core](https://github.com/CanuckAussieKev/thug2-level-converter-core) | THUG2's formats, the shared level port code, the compatibility profiles' mechanism |
| [thug2-thugpro-compat](https://github.com/CanuckAussieKev/thug2-thugpro-compat) | The THUGPRO compatibility register and its data (`--compat`); here: the level select's THAW position flags (TP-R6), THUGPRO's changes to THUG2's own levels (`thug2_levels`, TP-42), the scenic spots' node arrays |
| [thug2-thps2-level-converter](https://github.com/CanuckAussieKev/thug2-thps2-level-converter) | Tony Hawk's Pro Skater 2 |
| [thug2-thps3-level-converter](https://github.com/CanuckAussieKev/thug2-thps3-level-converter) | Tony Hawk's Pro Skater 3 |
| [thug2-thps4-level-converter](https://github.com/CanuckAussieKev/thug2-thps4-level-converter) | Tony Hawk's Pro Skater 4 |
| [thug2-thug1-level-converter](https://github.com/CanuckAussieKev/thug2-thug1-level-converter) | Tony Hawk's Underground (and the THUG1 campaign survey) |
| [thug2-thaw-level-converter](https://github.com/CanuckAussieKev/thug2-thaw-level-converter) | Tony Hawk's American Wasteland (and THAW's formats: Project 8's and the THAW BMX tools use them) |
| [thug2-thp8-level-converter](https://github.com/CanuckAussieKev/thug2-thp8-level-converter) | Tony Hawk's Project 8 (and its save tool) - on THAW's formats |
| [thug2-thpg-level-converter](https://github.com/CanuckAussieKev/thug2-thpg-level-converter) | Tony Hawk's Proving Ground - on Project 8's engine |

Part of the THUG2 decompilation, [github.com/CanuckAussieKev/thug2-decomp](https://github.com/CanuckAussieKev/thug2-decomp),
where it is the submodule `tools/pipeline` (and an npm workspace: the decomp's `npm install` installs the
converters). Run everything from that repository's root with Node 24, e.g.

    node tools/pipeline/run.ts thps3_levels/thps3_levels.ts convert --thug2 C:\Games\THUG2
    node tools/pipeline/menu_level/make_menu_level.ts --game C:\Games\THUG2 --hd-ui 4

`run.ts` runs a converter's (or the core's) tool by its path in that repository - `thps3_levels/collfix.ts`,
`level_port/zfight.ts`, `thp8_save/thp8_save.ts`: one of the `commands` in its package.json (`node
tools/pipeline/run.ts` lists them) - with the rest of the command line as its own. Each folder and each
converter has its own README.

- `menu_level/` - the data overlay `<game>\thug2-decomp-data`: every converted game's levels, Levels.qb and the level
  select, the new front end's data, scenic and loading art (`make_menu_level.ts`).
- `hd_textures/` - the HD menu art (Real-ESRGAN, fetched on request) and the level select globe's redrawn tiles.
- `thug2_levels/` - THUGPRO's changes to THUG2's own levels (TP-42), applied to the overlay's copies.
- `thaw_bmx/` - THAW's BMX: its assets converted, its ride scripts.
- `editor_import/` - the level editor's Import Level window's side: which game a folder holds, its levels, converting
  some and making the overlay again (`import_levels.ts`; the editor runs it with the Node runtime it ships).
- `fonts/` - the new front end's typefaces.

## With or without the decomp around it

The core's `lib/decomp.ts` finds the decomp checkout from the project using it (this repository, or the decomp whose
workspace it is): that folder or the first one above it with the decomp's `CMakeLists.txt` and `src/game` (or
`THUG2_DECOMP=<folder>`). On its own (a plain clone), `npm install`, `npm run typecheck`, `npm run lint` and `npm test`
work (a test that reads the decomp's source is skipped), every tool's `--help` works, and `out\` is this repository's
own. What needs the decomp, and why:

| Needs | Tools | Why |
|---|---|---|
| NeverScript's `ns` (`npx thug2-neverscript fetch` downloads it - thug2-level-converter-core's `lib/neverscript.ts`; inside the decomp its own build, `tools\build_neverscript.ps1`) - or `--ns <ns>` | every converter's `convert`, `thaw_bmx/convert.ts` (text only without it), `menu_level/make_menu_level.ts` | QB scripts compiled / decompiled |
| `src/game/skater/thaw_bmx*.cpp` | `thaw_bmx/ride.test.ts` (skipped alone) | the script names the game runs |
| the decomp's `tools/game` scripts and its `thug2-decomp.exe` in the game folder | `menu_level/scenic_capture.ts` | it starts the game |

The menu builder also installs Anteara Mod when `tools/anteara` (the anteara-mod repository) is there - beside this
repository or in the decomp; without it the overlay is made without its `anteara\` folder (a message says so).
Everything else - the format readers, the audits, the THUGPRO compare / inventory tools, the save tool, the scenic /
loading / front end art - runs on the game folders alone. The scripts that start and drive the game for tests are the
decomp's `tools/game`.

## Dependencies

Each dependency is pinned to a tagged commit by https (`git+https://git@github.com/CanuckAussieKev/<repository>.git#<commit>`:
no SSH key needed, `npm ci` from the committed package-lock.json). The converters depend on each other only along
their games' engines - specific to general, thug2-level-converter-core at the bottom, no cycles - and the ones that
use THUGPRO's data on its profile:

    thug2-thpg-level-converter -> thug2-thp8-level-converter -> thug2-thaw-level-converter -> core
    thug2-thaw- / -thps3- / -thps4- / -thug1-level-converter -> thug2-thugpro-compat -> core
    thug2-thps2-level-converter -> core

(Proving Ground's converter also uses THAW's directly, Project 8's core.) This repository uses some of their public
modules too (each repository's package.json `exports`, listed in its README): THPS2's archive and Project 8's for the
loading pictures, THUG1's driving scripts for Anteara Mod, THAW's formats and converter steps for the THAW BMX tools.
`deps.test.ts` checks on what npm installed that only those edges exist, that every package.json - this one, each
converter's and the decomp's - pins the same commit of each repository (npm installs one copy), and that every import
names an export of a declared dependency. Node strips no types under `node_modules`, so npm builds each dependency's
`.js` when it installs it (the core's README, "Using it"); TypeScript reads their `.ts`.

GitHub Actions runs `npm ci`, typecheck, lint and test on every push (`.github/workflows/ci.yml`).

Nothing from the games is in this repository: every converter reads your own installed copies and writes into your
game folder. `fonts/` holds the new front end's typefaces (Anton, IBM Plex Mono / Sans) under the SIL Open Font License
(`fonts/OFL-*.txt`).
