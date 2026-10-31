# thpg_levels - Tony Hawk's Proving Ground levels in THUG2

Converts the levels of your own Tony Hawk's Proving Ground data (the Xbox 360 game's: a folder holding
`DATA\COMPRESSED` - only the game data is read) to THUG2's formats and puts them in THUG2's level select (a "TONY HAWK'S
PROVING GROUND" section: Up / Down switches games). Nothing of either game is in the repo: the files are made from your
copies each time.

THPG is Project 8's engine a year on - the same archives, scripts, node arrays, textures and scene container - so this
is tools/pipeline/thp8_levels' converter run with THPG's profile (`thp8_levels.useGame`): what differs is here
(scene.ts, light.ts, layers.ts, thpg_levels.ts) and in the readers it shares with THP8 (geom.ts, havok.ts).

## Running it

Needs Node 24+ (`npm install` once), NeverScript (`tools\build_neverscript.ps1` -> `out\neverscript\ns.exe`) and, to
install the levels, tools/pipeline/menu_level/make_menu_level.ts.

    node tools/pipeline/thpg_levels/thpg_levels.ts convert [levels...] [--thpg <folder>] [--thug2 C:\Games\THUG2]
    node tools/pipeline/menu_level/make_menu_level.ts [--game C:\Games\THUG2]

`--thpg` is the folder holding `DATA\COMPRESSED` (default `C:\Games\Tony Hawk's Proving Grounds\ProvingGround`).
`convert` writes `<thug2>\thug2-decomp-thpg\` (not read by the game): `levels\thpg_<level>\thpg_<level>.scn.xbx / .tex.xbx /
.col.xbx / .qb`, `levels\thpg_sky` (THPG's default sky) and `levels.json`. Name levels to convert only some (`convert dc
crib`; `net_dc`, `thpg_net_dc`, `bedroom` all work); the default is all six. `--no-mips` skips the mip levels (faster).
`make_menu_level.ts` then copies them into the data overlay and adds them to Levels.qb and the level select.

    node tools/pipeline/thpg_levels/thpg_levels.ts selfcheck
    node tools/pipeline/thpg_levels/thpg_levels.ts list
    node tools/pipeline/thpg_levels/thpg_levels.ts audit {textures,zfight,black,spot} [levels...] [--thug2 C:\Games\THUG2]

`selfcheck` reads every file of every zone archive (scenes and their strips, textures' base levels untiled, collision,
qb / node arrays) and round-trips THUG2's LA / TestLevel files; `list` shows the levels (what each is made of). `audit`
is tools/pipeline/thp8_levels/render_audit.ts over THPG's levels (its README): `spot net_philly "(5440.8, 158.8,
-4604.8)"` lists the meshes at a screenshot sidecar's position with their THPG templates and textures.

## The levels

THPG's world is three cities streamed in zones that share one frame (metres, y up - as THP8's town; checked by their
collision: neighbouring zones' ground meets at their seams, 5-10 % of an 8 m grid's cells shared, nothing stacked):
qb.pak's `Area_List` has Philadelphia (z_love, z_fdr, z_bell, z_slums), Washington DC (z_monuments, z_museums,
z_museum_int), Baltimore (z_bcity, z_lansdowne, z_harbor), the bridges between them (z_pb_bridge, z_bw_bridge,
z_wp_bridge) and z_secret. Its network levels are its own list (qb.pak's `online_level_select_menu_level_info`, each a
`multiplayer_level_<x>` structure - THP8's form):

| THPG level | THUG2 level (Load_...) | Zones (the first's lights) | Barriers | Pictogram | Level select |
|---|---|---|---|---|---|
| WORLD (every zone) | thpg_net_wholeworld | love, fdr, bell, slums, monuments, museums, museum_int, bcity, lansdowne, harbor, pb_bridge, bw_bridge, wp_bridge, secret | none | foldedmap | 131 |
| DC | thpg_net_dc | museums (+ the ground of monuments, museum_int and the bridges inside the barriers) | z_online_dc | obelisk | 132 |
| BALTIMORE | thpg_net_baltimore | bcity (+ the ground inside the barriers) | z_online_baltimore | crab | 133 |
| PHILLY | thpg_net_philly | slums, love (+ the ground inside the barriers) | z_online_philly | libertybell | 134 |
| SKATE LOUNGE | thpg_net_crib | crib with its default theme (z_crib_Default) | | sofa | 135 |
| BEDROOM | thpg_bedroom | bedroom | | bed | 130 (MISCELLANEOUS) |

WORLD's spawn_in names z_love alone (where its spawns are); it is made of every zone, as THP8's BEAVER VALLEY is its
whole town. It reaches ~22,000 units from its middle: IsBigLevel (whole-unit network positions), and it needs this
project's bigger limits as BEAVER VALLEY does (1.6 million triangles, 20,665 rail nodes - see thp8_levels' README).
The barrier levels are THP8's: the spawn zones (PHILLY's area_pak_zone names a load script, load_z_slums: its zone
first), the other zones' ground the skater reaches inside the barriers drawn and collided as border zones, the city's
other zones' `_lod` stand-ins around. The skate lounge's area_pak is the lounge itself (no barriers); it is drawn with
its default theme, one of the twelve z_crib_<Theme> archives. The bedroom is a level of its own in THPG (Level_Z_Bedroom,
a menu scene: its collision file has no bodies - collision is made from its drawn opaque triangles). Not converted: the
city's zones as levels by themselves, the other lounge themes, z_mainmenu, z_navmesh, z_peds, z_vehicles, z_anim,
z_world, z_viewer, z_ambientscenes and the test levels (`z_testlevel*`).

The sign texts are THPG's (WORLD, DC... - the level select's own names where THPG's are abbreviations: WASHINGTON DC,
PHILADELPHIA); the pictograms are ours (tools/pipeline/menu_level/level_select_icons.ts, THPG_LEVELS in
level_select.ts). DC, BALTIMORE and PHILADELPHIA have stars at their cities.

## THPG's formats (what differs from THP8's)

All big-endian. Worked out from the data; no format notes for THPG's files that we found.

- **Scenes** (`.scn`, THP8's `.geom` container; the models' `.mdl` the same): material block version **0x0410** -
  records one after another, each as long as its own size word (+0xC4), the parameters inline: +0x00 the checksum,
  +0xA0 the shader template, +0xB0 / +0xB4 the float4 count / offset, +0xB8 / +0xBC the texture count / offset, +0xCC
  state bits, +0xD8 the blend mode (0 none, 1 add, 3 blend), +0xE8 the alpha test reference (top byte); 6,609 records
  over the 72 zone archives, each block walked to its end exactly (scene.ts). **Sectors** are 0x60 bytes (THP8's 0x50),
  the sphere at +0x40. **Vertices**: the uv fields keep their slot numbers with gaps between them (slots 0 and 5) and
  a field kind 3 (four 16-bit floats - the vertex-colour wibble shaders'; THP8 has kind 2 only). The meshes and sector
  nodes are THP8's.
- **Materials**: shader templates of THPG's own (FXFILES\MaterialLibrary.bin: D_3ChkBox_Pass0, D_N_S_4ChkBox_Pass1,
  EnvMask_D_N_S_2ChkBox...). The terrain families D_ / D_S_ / D_N_S_ name their passes that are on; their textures are
  laid out as THP8's layered templates' and read as layers (layers.ts); a 3ChkBox material with pass 0 off is a decal
  (shadows, dirt, graffiti), made one texture with its mask as alpha. The global stand-ins (white, black, grey, the
  default normal and cube maps) are in `PAK\global_env_tex.pak.xen`, not in the zones' `.tex`.
  - D_N_S_4ChkBox's float4s: the specular power, pass 0's colour, tiling and specular colour, then each further pass's
    colour (A its opacity) and tiling. The tiling float4 is per sampler (the library's m_psPass<k>Tiling): x the
    diffuse map's (u and v alike), y the mask's (pass 0: the normal map's) - Love Park's granite is pass 0 x 3 under
    a big colour wash, pass 1 x 0.125. A mask tiled otherwise than its diffuse map is made one texture over a period
    of the coarser of the two (thp8_levels.ts layerRepeat).
  - The Wet terrains (D_N_S_Wet_4ChkBox...: most roads, pavements and plazas) are D_N_S_4ChkBox's plus a wet layer: a
    cube map and a big wet mask before the light map, the mask's uv field before the light map's. The wet sheen isn't
    drawn: both left out, the rest read as D_N_S_4ChkBox's.
  - The glass towers (EnvMask_D_N_S_2ChkBox_Pass1...): pass 0 a black glass map with a cube map's reflection, pass 1
    the facade (brick with windows) over it by a mask black at the panes. Made pass 1's facade, solid, with a layer of
    the glass's colour (the cube map's mean x 0.6) at the panes; the other EnvMask materials (pass 0 not dark: metal,
    awnings) draw their pass 0.
  - Not read: D_NBlend_S (their float4s not worked out - pass 0 only), D_S_'s colours and tilings, the specular /
    normal maps, the reflections, Wibble / water.
- **Light maps**: one a zone (its last texture, 2048 x 2048 DXT1, the vertex's last uv field). The outdoor maps hold
  the light as it is, the sun's at 1: at the city zones' lit vertices their brightest tenth is 1.0 (the sunlit ground,
  clipped) and the middle 0.3-0.6. Baked into the vertex colours as map x 1.2 / (1 + 0.2 x map) - 1 draws the
  texture as it is, the shade lifted a little. The interiors' maps are darker (inside the air and space museum half
  the vertices under 0.15): z_museum_int, the lounge and the bedroom as map x 4.5 / (1 + 1.5 x map). Ours, from the
  data (THPG's shaders aren't read). THP8's two maps (ambient + shadow) are made from it (light.ts), so THP8's light
  refining runs.
- **Collision** (`.hkc`): Havok 4.6 packfiles ("Havok-4.6.0-r1"; THP8's are 4.0): the MOPP's child an
  `hkNxStorageExtendedMeshShape` - triangle subparts read from their `meshstorage` (float4 vertices, 16 / 32-bit
  indices, per-triangle materials {filterInfo, nodeInfo, friction}), convex shape subparts from their `shapestorage`
  (thp8_levels/havok.ts). A face's word is THP8's (terrain << 16 | face flags) but 0x800, set on nearly every face and
  not THUG2's meaning there ("under ok"): left out.
- **Scripts**: THP8's token stream plus a 0x27 elseif with two u16 jumps (THUG2's has none): made `else` + a nested
  `if`, closed by one more `endif` (thaw_levels/thaw_scripts.ts). Some node fields name globals with `$`: plain names.
- Not identified (not needed): the zone archives' entries 0x33180544 (a count, then float4s), 0x4A2E1FA0 and
  0x43904241 (8 bytes).

## What's converted

As THP8's (thp8_levels' README "What's converted"): every sector with its instances, pass 0 and the layers above,
light maps in the vertex colours, collision with terrains and face flags, restarts (network spawns also
single-player ones), rails, kill zones, gaps and the scripts they call, script objects, moving objects, THPG's
bouncy props (GO_Cafe_Chair, GO_TrafficCone... from ZONES\global.pak), the barrier walls, the `_lod` stand-ins, the
sky. THPG-only features aren't: climbing (its climb nodes and anims), Nail the Trick / Nail the Grab, the rigger
pieces, skate checks, the goal and story peds, sounds, particles, the wet sheen, reflections and the NBlend / Wibble
shaders' further passes; their script commands are left out by the script translator (THUG2 has none). The
billboards' faces are drawn as the zone lists them: a grey blank panel (Z_Slums_I_g_sl_billboard_01's 534C742A, 128 x
128) - whatever THPG shows there instead isn't in its material.

## Sizes and timings (2026-10-31, all six levels with mip levels)

| Level | Triangles | Scene | Textures | Collision | qb | Reach (units) |
|---|---|---|---|---|---|---|
| thpg_net_wholeworld | 1,631,563 | 114 MB | 106 MB | 9.5 MB | 5.4 MB | 22,236 (IsBigLevel) |
| thpg_net_philly | 609,970 | 44 MB | 60 MB | 5.3 MB | 1.0 MB | 9,675 |
| thpg_net_baltimore | 396,341 | 32 MB | 40 MB | 4.1 MB | 0.3 MB | 7,160 |
| thpg_net_dc | 344,517 | 25 MB | 21 MB | 3.0 MB | 0.4 MB | 10,167 |
| thpg_net_crib | 31,546 | 1.6 MB | 1.4 MB | 0.03 MB | 0.03 MB | 11,469 |
| thpg_bedroom | 2,777 | 0.2 MB | 0.9 MB | 0.01 MB | 0.01 MB | 539 |

The whole convert takes ~11 minutes (WORLD ~7 of them). WORLD is the largest level of any of the converters (THP8's
BEAVER VALLEY: 1.26 million triangles, an 81 MB scene).
