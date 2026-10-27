# tools/pipeline/thaw_bmx - THAW's BMX for THUG2 (assets)

Phase 1. Reads the user's THAW (PC 1.01) and
THUG2 installs read only; nothing of either game is stored in the repo.

    node tools/pipeline/thaw_bmx/convert.ts convert --thug2 C:\Games\THUG2-3 --ns out\neverscript\ns.exe   # into <game>\thug2-decomp-thaw-bmx
    node tools/pipeline/thaw_bmx/convert.ts convert --out <scratch folder> [--ns ...]                        # anywhere else
    node tools/pipeline/thaw_bmx/convert.ts selfcheck [--thaw ..] [--thug2 ..]                               # read back / pose checks
    node tools/pipeline/menu_level/make_menu_level.ts --game C:\Games\THUG2-3 --ns ...                       # into the overlay

`--ns` is NeverScript's ns.exe (tools\build_neverscript.ps1); without it the scripts are written as text only.
`survey.ts` (the earlier scoping survey) is unchanged. `thaw_ghidra.py --project <folder> --program <exe name>` reads
a second THAW PC build (THAW.exe's code at other addresses) in its own Ghidra project; `second_build_map.py --second
<its exe>` maps THAW.exe addresses to it (`--list second_build_targets.txt --diff 400 --json second_build_map.json`;
the sites THAW.exe can't show, with the second build's instructions: `--sites 5C1F00 5EA000 --json
second_build_sites.json`).

## Files

| file | what |
|---|---|
| `convert.ts` | the converter: skeleton, skin, textures, animation sets, scripts, manifest; `selfcheck` |
| `ska.ts` | THAW and THUG2 `.ska` files as key lists (all key forms, the standard-key tables written out), THUG2's written back |
| `install.ts` | what make_menu_level copies from the staging folder into `thug2-decomp-data` |
| `thaw_bmx.test.ts` | unit tests with synthetic data (no game files) |

## What it makes (staging `thug2-decomp-thaw-bmx`, laid out as the overlay)

    models\specialitems\thaw_bmx\si_bmx.skin.xbx / .tex.xbx / .cas.xbx   the bike (1 sector, 1 mesh, 1,177 vertices, 1 texture)
    skeletons\THAW_SI_BMX.ske.xbx                                        its 8 bones
    anims\THAW_BMX\THPS7_Veh_BMX\*.ska.xbx    114 rider animations, 50 bones (THPS6_human)
    anims\THAW_BMX\SI_BMX\*.ska.xbx           120 bike animations + the 5 permanent ones (8 bones)
    scripts\thaw_bmx\thaw_bmx.ns / .qb        load scripts, the special item's structure, test scripts
    thaw_bmx.json                             the manifest

make_menu_level copies models / anims / skeletons and thaw_bmx.json into the overlay and appends `thaw_bmx.ns` to the
overlay's `scripts\game\skater\specialitems.qb` (a file the game loads at start-up). The names can't collide with
THUG2's: skeleton `THAW_SI_BMX`, files under `THAW_BMX`, the scripts `animload_thaw_bmx_*` / `thaw_bmx_*`; the rider
animations' names (`bmx_idle`...) are THAW's descChecksums, none of which THUG2 has (selfcheck compares them with
THUG2's allanims.ns).

## How the formats map (details in the file headers)

- **Skin**: THAW's `.skin` is the levels' `.geom` memory image; its skinned vertex is THUG2's own (stride 40: position,
  packed weights, four bone numbers x 3, packed normal, colour, uv), so the vertices, strips and boxes are carried over
  (thug2_scene `skinnedMesh`) with the materials mapped as the levels' are (`toThug2Material`) and the sector flags of
  THUG2's special items (0x80002097). The 0x90 bytes after the meshes - the memory image's pointer-fixup trailer - are
  the same in all 589 THAW skins and empty: see `TRAILER` in convert.ts.
- **Skeleton**: THAW's `.ske` v1 keeps per bone the local translation and the inverse bind matrix (not a rest
  quaternion); the local rest quaternion is `conj(parentWorld) * world` with `world = conj(matrixQuat(rows))` - proven on
  THAW's human against THUG2's THPS6_Human (48 of 48 bones within 1e-4).
- **Animations**: THAW's header differs (`u32 0x28`, bones at byte 0xD, key counts as u16 at 0xE and u32 at 0x10, stream
  sizes at 0x28 / 0x2C, per-bone sizes from 0x30), the key forms and flags (0x06834000 / 0x06810000 / partial 0x068B4000)
  are THUG2's. Keys that read THAW's standard-key tables (`data\anims\standardkeyQ/T.bin`, other values than THUG2's) -
  rotation tables, the one-component table of flag 0x10000, translation tables - are written out in full (as
  tools/pipeline/thug1_levels does for THUG1; THAW's flag 0x10000 forms are new). The pak (`bmx_anims.pak.wpc`) keys each file by its
  descChecksum plus its skeleton's (the load row's SetReferenceChecksum: `animKey` in convert.ts - every file of bmx_anims,
  net_anims and perm_anims, 833 of unloadable_anims' 847); the files are in the order of THAW's `animload_*` scripts
  (scripts\allanims.qb in `dbgq.pak.wpc`), which gives the names, and convert.ts checks each key. THAW's skater animations
  the bike's scripts play that THUG2 hasn't (`SKATER_ANIMS`: THPS7_BoardCatch_Stand) are found by key in
  `unloadable_anims.pak.wpc` and put on the rider with the bike's.
- **Rider** (52 -> 50 bones): see `remapRider`. 48 shared bones copy; THAW's 4 twist bones under the biceps are dropped;
  THUG2's `Bone_Shoulder_L/R` (a sibling of the bicep under the collar) are made from the biceps: the half-way
  rotation from the bicep's rest pose, `slerp(I, bicep * restBicep^-1, 0.5)` - what THUG2's own animations do
  (1,601 keys measured: best fraction 0.51 on average, mean error 8 degrees).

## Phase 2: riding it

`ride.ts` adds the ride to `thaw_bmx.ns` (convert.ts writes it; make_menu_level appends it to specialitems.qb and puts
RIDE BMX / GET OFF BMX in the pause menu - `install.ts addPauseItem`): THAW's `bicycle_physics` and bike cameras
(from THAW's physics.qb, under our names `thaw_bicycle_physics`, `thaw_bmx_camera_*`), the vehicle `thaw_bmx_params`
(THUG2's Vehicle_Start machinery with THAW's animations), `thaw_bmx_toggle` and the bike's scripts (it follows the
rider's animation by name; its wheels spin as two partial animations by speed). The engine side is
src/game/skater/thaw_bmx.h (`[features] thaw_bmx=1`, F7). `dump_scripts.ts` prints THAW's scripts and globals as text
(a reading aid: `node tools/pipeline/thaw_bmx/dump_scripts.ts --file bike --name bike_onground`).

| file | what |
|---|---|
| `ride.ts` | the phase 2 scripts and THAW's physics / camera globals |
| `ride.test.ts` | its tests and the pause item's (synthetic data) |
| `dump_scripts.ts` | THAW's qb.pak / dbgq.pak scripts and globals as text, for reading |

`thaw_bmx.json` lists the assets: the animations (`desc`, `descChecksum`, `reference`, `thawPath`, `file`, flags,
duration, key counts), the skeleton's bones (id, parent, mirror, role, translation), the model and the scripts.

## Phase 3: the bike's physics

THAW's bike branches of the skater's core physics are in src/game/skater/thaw_bmx_physics.cpp. `ride.ts` adds what they need: THAW's `Normal_Lerp_Speed_Bike` and
`bike_forward_jump_boost` (physics.qb), stand-ins under THAW's names for the scripts the physics runs (`bike_enter_manual`,
`bike_enter_nosemanual`, `bail_bike_manual`, `bail_bike_nosemanual`, `bike_exit_endo`, `force_bike_bail`,
`bike_release_partial_xup` - phase 4 replaces them with THAW's own), the manual state (`thaw_bmx_manual`: x-up on circle),
the skid (R1 and a direction) and `BikeGrindTrickList` (five grinds by the stick's pitch, on THUG2's `vehicle_grind`).
The vehicle's own manual is off (`canmanual=0`): the bike's manual pitch replaces it.

## Phase 4: THAW's bike scripts, the bike's sounds

No vehicle any more: the ride is THAW's own bike scripts.

| file | what |
|---|---|
| `bike_scripts.ts` | THAW's bike_scripts.qb / bike_grindscripts.qb / bike_sfx.qb ported (`bikeScripts`) and THAW's data read from the user's THAW at convert time (`bikeGlobals`: the trick lists as THAW has them - its right stick's BikePress, its stick names; the DLL makes THAW's stick buttons, src/game/skater/thaw_bmx_sticks.cpp -, the exception tables, BikeGrindTrickList, the grind tricks' scripts, the sound tables). The ported scripts are made at convert time from the user's THAW too: `bike_scripts.ns` holds our own scripts and a line `//@unit <name>` for each of THAW's we port, `bike_scripts.edits` our changes to each (tools/pipeline/lib/edits.ts: line operations on THAW's script). No THAW text is stored. To change one: `node tools/pipeline/thaw_bmx/bike_scripts.ts dump --out x.ns`, edit, `... extract --from x.ns` |
| `thaw_ns.ts` | THAW's script bodies (thaw_scripts.ts' THUG2 tokens) written as NeverScript in THUG2's decompiled layout - what the port's edits start from; a script's first-line defaults (`JumpHeight = 380` with no newline before it) go in its header, `script BIKE_OLLIE JumpHeight=380 {`, so they stay defaults the caller overrides |
| `sounds.ts` | THAW's global_sfx pak (its address table in `global_sfx_dat_wpc.qb`) -> THUG2 .snd (4-bit IMA ADPCM in a RIFF WAVE, a `smpl` loop for the loops) under `sounds\thaw_bmx` |
| `check.ts` | every command the compiled scripts run is THUG2's (C function, member, script) or ours - convert.ts fails otherwise |
| `meter.ts` | the bike's manual meter: THAW's panel pictures (`data\images\panelsprites\bike_tailmeter / bike_nosemeter / bike_arc.img.wpc`, DXT5) -> THUG2 32-bit `.img.xbx` under `images\thaw_bmx`. THAW's own meter scripts (create / update / destroy_bike_manual_meter, ported whole) draw it: the bike picture - mirrored (`flip_v`) for a nose manual - turned by 0.9 degrees per point of the manual angle over the arc; they load the pictures with the DLL's `ThawBmx_LoadTexture` |

The animation trees THAW's scripts drive become `thaw_bmx_playanim` (PlayAnim on the rider, Obj_PlayAnim on the bike when it
has the animation) and `thaw_bmx_playbarspin` (the anim subset Barspin on both); the manual's pose follows the manual
angle in the DLL (src/game/skater/thaw_bmx_tricks.cpp). The data overlay gets the sounds (`install.ts` copies `sounds`;
the DLL's PCWave::Load reads the overlay's copy first).

## THAW's general scripts' bike branches

THAW's skater scripts branch to the bike's own in places (`if IsSkaterOnBike`); THUG2's scripts of the same names are the
skater's only, so the port has them under its own names: `bike_SkateInOrBail` / `bike_SkateIn_Right` / `_Left` /
`bike_OnGroundExceptions` (falling off a grind's balance: back onto the bike or its bail, never THUG2's skate-in that turns
the board on), the air tricks after rolling off a ledge (THAW's `SetSkaterAirTricks` bike branch), the getting on / off
animations THAW plays from its `toggle_bike_on_off2` / `bmx_finish_off` (BrakeToStand, THAW's THPS7_BoardCatch_Stand
backwards, WStand, GetUp_S_RunJump - THUG2 has all but the board catch under the same names), and a ped's knock-down
(`bike_PedKnockDown`: THAW's PedKnockDown bike branch, the bike's bail - the DLL sends a rider there from MakeSkaterGoto
PedKnockDown; a ped in its knock-down state doesn't knock a rider over, as THAW's STATESCRIPT_knockdown). `convert.ts` checks every animation the scripts name is converted or THUG2's own
(`check.ts unknownAnimations`).

## Parked bikes: getting on by walking up to one

As THAW: each level has its own bike lying on the ground, and getting off leaves the bike where the rider got off; walk
(or skate) up to one and a speech box offers it - Circle walks the skater to the bike and gets on with THAW's get-on
(the engine side: src/game/skater/thaw_bmx_parked.h; F7 and the pause menu still get on / off from anywhere).

| file | what |
|---|---|
| `parked.ts` | THAW's bike_ped_ids (its levels' bikes: pedestrian nodes whose body is the bike) read at convert time - each node's place in the THAW level as tools/pipeline/thaw_levels ports it (its THUG2 name and default frame) -> `thaw_bmx_home_bikes`. Elsewhere the DLL puts the level's bike near where the skater started |
| `ride.ts` `parkedScripts` | the level's bike (`thaw_bmx_home`, THAW's switch_all_bike_peds), the offer on each bike (`thaw_bmx_spot_watch`: within THAW's 12 feet, THUG2's speech box), taking it (`thaw_bmx_spot_ride`) and the walk (`thaw_bmx_walk_to_bike`, THAW's skater_walk_to_bike) |

The stall (R1 held as a grind starts): THAW's `BikeStallTrick` (from BIKE_GRIND while `ShouldRunStallScript`), with
its stalltricks.qb helpers `PlayStallBalancingAnim` and `StallOllieOut` and its ExitPointRailSpin as
`bike_ExitPointRailSpin` (THUG2's own has no bike branch); THAW's `stall_slip_time` goes into the overlay with its other
physics globals. The physics' stall state is in the DLL (src/game/skater/core_rail.cpp DoBikeStallPhysics,
thaw_bmx_physics.cpp).
