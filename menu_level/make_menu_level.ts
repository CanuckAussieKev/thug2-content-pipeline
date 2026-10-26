// Note: the front-end scripts written out below (create_main_menu, main_menu_* ...) are modified versions of THUG2's own
// scripts, adapted here; the original scripts belong to their rights holders (see the notice in README.md), not to this project.
// NOT ORIGINAL - the data overlay (see src/game/front/data_overlay.h): generates, from the game's own files, a
// folder the DLL reads before the game's archives and data folder:
//   - always used: the skate shop as a playable level (Level_SkateShopLevel, in the level select as "SKATE SHOP"),
//     TestLevel in the level select, the pause menu's LEVEL EDITOR, the THPS4 levels;
//   - front_end\, used first while the skate-shop front end is on (thug2-decomp.ini [features] menu_backdrop, any
//     value but 0 - src/game/front/menu_backdrop.h): the standard main menu.
//
//   node tools/pipeline/menu_level/make_menu_level.ts [--game C:\Games\THUG2] [--out <folder>] [--ns <ns.exe>] [--hd-ui 2|4]
//
// The overlay (default: <game>\thug2-decomp-data; emptied and made again each run) gets:
//   scripts\game\Levels.qb     the game's + Load_SkateShopLevel / Level_SkateShopLevel (the shop's scene, collision and its own
//                              node array; level number LevelNum_Default, as the game's test levels).
//   levels\skateshop\skateshop.qb  the shop's node array (skateshop_NodeArray) without the front end's parts: the
//                              shadow skater's trigger script and the menus' 3D backgrounds.
//   levels\TestLevel\TestLevel.qb  the developers' test level's nodes (path followers kept out of net games).
//   scripts\game\menu\gamemenu_levelselect.qb  the level select with SKATE SHOP and TEST LEVEL signs, in sections per
//                              game (THUG2, THUG1, THPS4) with stars and signs for our levels (level_select.ts);
//                              scripts\game\menu\sprites.qb and images\LevelSelectSprites\sign_*.img.xbx for those signs.
//   scripts\game\menu\gamemenu_pause.qb  the pause menu with LEVEL EDITOR (src/game/front/level_editor.h) and its
//                              scripts level_editor_enter / level_editor_exit.
//   levels\thps4_*\, thug1_*\  the THPS4 / THUG1 levels converted by tools/pipeline/thps4_levels / tools/pipeline/thug1_levels, when
//                              they have made <game>\thug2-decomp-thps4 / -thug1: copied in, their level structures
//                              added to both Levels.qb and their signs to the level select's THUG1 / THPS4 sections
//                              (tools/pipeline/level_port/ported_levels.ts).
//   front_end\levels\mainmenu\mainmenu_scripts.qb  (when the THPS4 skate shop is among them: the front end's backdrop)
//                              the front end's scripts with create_main_menu building a standard vertical menu (a
//                              roundbar menu, as Game Options and Create-A-Modes) instead of the spinning wheel - the
//                              same items doing the same things, after SKATE NOW (the menu slides away and the skater
//                              drops in on the outside halfpipe, as THPS4's practice; Esc brings the menu back); the shop's collision loaded at the
//                              start; the skater standing idle.
//   front_end\levels\mainmenu\mainmenu.qb  the front end's nodes with the skater's restarts moved into THPS4's shop.
//   hd_ui\                    with --hd-ui 2|4 (off by default): the menus' images and fonts upscaled
//                              (tools/pipeline/hd_textures/ui.ts), same relative names; read first only while [features]
//                              hd_ui=1 (src/game/gfx/hd_ui.h). --hd-ui-model picks the model.
//   images\loadscrn_<game>_<level>.img.xbx  the ported levels' own games' loading pictures (loading_art.ts; read from
//                              the installs C:\Games\THPS2 ... THP8 or --thps2 ... --thp8 <folder>), 640 x 448: named in
//                              the levels' loading_screen (Levels.qb) and levels.json's art; --hd-ui upscales them x4.
//   images\frontend_art_<game>_<level>.img.xbx  the same pictures cut down to the part without text, for the new level
//                              select only (frontend_art.ts): named in levels.json's art, not in Levels.qb; --hd-ui x4 too.
//                              For the games with scenic art (scenic_art.ts: THPS3 so far) the levels with a chosen capture
//                              in the cache get a filtered picture of the level itself instead (640 x 360; its HD version
//                              2560 x 1440 from the capture, not upscaled); --scenic-style a|b|c picks the filter, off the crops.
//   anteara\                  Anteara Mod's script set (tools/anteara/README.md; the DLL reads it first while
//                              [features] anteara_mod=1), with the edits above re-applied to the files it changes.
//   frontend\levels.json      the DLL's new front end's level select data (frontend_levels.ts; read while [features]
//                              new_frontend=1 - src/game/front/new_frontend.h); frontend\fonts\*.ttf its fonts, copied
//                              from --frontend-fonts <folder> when given (the design's OFL fonts; else the DLL uses
//                              Windows' own at run time).
// Nothing of the game is stored in the repo: the files are made from the game folder each time.
// Needs NeverScript (tools/build_neverscript.ps1 -> out/neverscript/ns.exe).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import * as hdUi from "../hd_textures/ui.ts"; // (--hd-ui: the menus' images and fonts upscaled)
import { textOutput } from "../level_port/common.ts";
import * as levelPortNodes from "../level_port/nodes.ts"; // (the terrain sounds a level loads)
import * as pedModels from "../level_port/ped_models.ts"; // (the ported levels' own people: their profiles and CAS parts)
import * as portedLevels from "../level_port/ported_levels.ts"; // (the converted levels: added when <game>\thug2-decomp-<game> exist)
import * as thug2Col from "../level_port/thug2_col.ts"; // (the front end's collision without THUG2's shop)
import { parseCli } from "../lib/cli.ts";
import { DECOMP, NS_DEFAULT, nsMissing, PIPELINE } from "../lib/decomp.ts";
import type { UnitLookup } from "../lib/edits.ts";
import { resolveInstall } from "../lib/install.ts";
import {
    decodeAsciiReplace,
    formatFixed,
    isMain,
    print,
    pyExit,
    pyJoin,
    pyParseFloat,
    pyParseInt,
    pyStrip,
    readTextPy,
    runMain,
    writeTextPy,
} from "../lib/py.ts";
import { findall, finditer, type Match, search, sub } from "../lib/re.ts";
import { unpackNumbers } from "../lib/struct.ts";
import * as thawBmxInstall from "../thaw_bmx/install.ts"; // (THAW's BMX: bike, skeleton, animations - phase 1)
import { applyTextEdits, CAR_SCRIPTS, DRIVING_EDITS } from "../thug1_levels/driving.ts"; // (PC-THUG1-22, Anteara Mod's copy)
import * as thug2Levels from "../thug2_levels/thugpro_apply.ts"; // (THUGPRO's changes to THUG2's levels: TP-42)
import * as careerComplete from "./career_complete.ts"; // (GAME OPTIONS' CREATE 100% CAS)
import { reEscape } from "./career_complete.ts";
import * as frontendArt from "./frontend_art.ts"; // (the new front end's text-free versions of them)
import * as frontendLevels from "./frontend_levels.ts"; // (the DLL's new front end: frontend\levels.json)
import * as levelMap from "./level_map.ts"; // (maps of the levels with no place, in place of the globe)
import * as levelSelect from "./level_select.ts"; // (the level select's sections, stars and signs)
import { countOf, replaceFirst } from "./level_select.ts";
import * as loadingArtGames from "./loading_art_games.ts"; // (the ported levels' own loading pictures)
import { mainMenuScripts, PrxScripts } from "./main_menu.ts"; // (the standard main menu's scripts, made from the game's)
import * as scenicArt from "./scenic_art.ts"; // (pictures of the levels themselves, filtered, in place of the crops)

const USAGE =
    "usage: make_menu_level.ts [--game GAME] [--out OUT] [--ns NS] [--hd-ui 2|4] [--hd-ui-model M] [--frontend-fonts DIR] [--scenic-style a|b|c|off]";

// Anteara Mod (the anteara-mod repository, the decomp's submodule tools/anteara) is optional: without it the
// overlay is made without its anteara\ folder. (AntearaMod: the part of its anteara.ts this uses.)
type AntearaEdit = (text: string) => string;
interface AntearaMod {
    install(
        game: string,
        out: string,
        tool: string,
        edits?: ReadonlyMap<string, AntearaEdit>,
        frontEndEdits?: ReadonlyMap<string, AntearaEdit>,
        thug1?: string,
    ): string | null;
}
export const ANTEARA_CANDIDATES: readonly string[] = [
    ...(DECOMP ? [path.join(DECOMP, "tools", "anteara", "anteara.ts")] : []),
    path.join(path.dirname(PIPELINE), "anteara", "anteara.ts"), // (beside this repository: tools/pipeline, tools/anteara)
];
export async function loadAnteara(): Promise<AntearaMod | null> {
    const file = ANTEARA_CANDIDATES.find((f) => fs.existsSync(f));
    return file ? ((await import(pathToFileURL(file).href)) as AntearaMod) : null;
}

export function checksum(name: string): number {
    return (zlib.crc32(Buffer.from(name.toLowerCase(), "utf-8")) ^ 0xffffffff) >>> 0;
}

// src/game/util/lzss.cpp Decode: a 4096-byte window filled with spaces, writing from 4096 - 18.
export function lzssDecode(data: Uint8Array, size: number): Buffer {
    const window = Buffer.alloc(4096, 0x20);
    let r = 4096 - 18;
    const out: number[] = [];
    let i = 0;
    let flags = 0;
    while (out.length < size && i < data.length) {
        flags >>= 1;
        if (!(flags & 0x100)) {
            flags = data[i]! | 0xff00;
            i += 1;
        }
        if (flags & 1) {
            if (i >= data.length) break;
            const c = data[i]!;
            i += 1;
            out.push(c);
            window[r] = c;
            r = (r + 1) & 4095;
        } else {
            if (i + 1 >= data.length) break;
            const position = data[i]! | ((data[i + 1]! & 0xf0) << 4);
            const last = (data[i + 1]! & 0x0f) + 2;
            i += 2;
            for (let k = 0; k < last + 1; k++) {
                const c = window[(position + k) & 4095]!;
                out.push(c);
                window[r] = c;
                r = (r + 1) & 4095;
            }
        }
    }
    return Buffer.from(out.slice(0, Math.max(0, size)));
}

function entryName(data: Buffer, offset: number, body: number): string {
    const raw = data.subarray(offset + 16, body);
    const nul = raw.indexOf(0);
    return decodeAsciiReplace(nul >= 0 ? raw.subarray(0, nul) : raw);
}

// An archive as stored: {total size, version, file count}, then per file {size, compressed size, name size
// (int16), use count, checksum}, its name, and its data padded to 4 bytes (src/game/file/pip.cpp NextRawEntry).
export function prxFile(file: string, name: string): Buffer {
    const data = fs.readFileSync(file);
    const count = unpackNumbers("<iii", data, 0)[2]!;
    let offset = 12;
    const wanted = checksum(name);
    for (let k = 0; k < count; k++) {
        const [size, compressed, nameSize, , fileChecksum] = unpackNumbers("<iihHI", data, offset) as number[];
        const stored = compressed! || size!;
        const body = offset + 16 + nameSize!;
        const entry = entryName(data, offset, body);
        if (fileChecksum === wanted || entry.toLowerCase().replaceAll("/", "\\") === name.toLowerCase()) {
            const raw = data.subarray(body, body + stored);
            return compressed ? lzssDecode(raw, size!) : Buffer.from(raw);
        }
        offset = body + ((stored + 3) & ~3);
    }
    pyExit(`${file}: ${name} not found`);
}

// {name as stored: data} of an archive's files with `extension` (as prxFile reads one).
export function prxFiles(file: string, extension = ".qb"): Map<string, Buffer> {
    const data = fs.readFileSync(file);
    const count = unpackNumbers("<iii", data, 0)[2]!;
    let offset = 12;
    const out = new Map<string, Buffer>();
    for (let k = 0; k < count; k++) {
        const [size, compressed, nameSize] = unpackNumbers("<iihHI", data, offset) as number[];
        const stored = compressed! || size!;
        const body = offset + 16 + nameSize!;
        const entry = entryName(data, offset, body);
        if (entry.toLowerCase().endsWith(extension)) {
            const raw = data.subarray(body, body + stored);
            out.set(entry, compressed ? lzssDecode(raw, size!) : Buffer.from(raw));
        }
        offset = body + ((stored + 3) & ~3);
    }
    return out;
}

export const MARKER = "made-by-make_menu_level.txt";
// The level numbers of the SKATE SHOP and TEST LEVEL signs (unused / the test level's slot: their records, unlock and
// dot lookups take them; each sign needs its own - the level select tells signs apart by it).
export const SKATESHOP_SIGN_LEVEL = 18;
export const TESTLEVEL_SIGN_LEVEL = 21;

// --- the playable skate shop ------------------------------------------------------------------------------------

function indexOrThrow(text: string, sub: string, from = 0): number {
    const at = text.indexOf(sub, from);
    if (at < 0) throw new Error("substring not found");
    return at;
}

function lastIndexOrThrow(text: string, sub: string): number {
    const at = text.lastIndexOf(sub);
    if (at < 0) throw new Error("substring not found");
    return at;
}

// The text of a top-level `name = { ... }` structure.
export function block(text: string, name: string): string {
    const start = indexOrThrow(text, `\n${name} = {`) + 1;
    return text.slice(start, indexOrThrow(text, "\n}", start) + 2);
}

export function addSkateshopLevel(text: string): string {
    // (Not Load_SkateShop: CheckForInvalidLevels turns the obsolete load_skateshop into the main menu.)
    // A gameplay level made of the front end's skate shop: its scene, collision and archives, its own node array
    // (skateshop.qb), the front end's lighting; LevelNum_Default as the game's test levels (not a career level).
    const mainmenu = block(text, "level_Mainmenu");
    const lighting = mainmenu.slice(indexOrThrow(mainmenu, "    ambient_red="), lastIndexOrThrow(mainmenu, "}"));
    const level =
        "script Load_SkateShopLevel {\n    load_level Level_SkateShopLevel \n} \n" +
        "Level_SkateShopLevel = {\n" +
        "    structure_name=Level_SkateShopLevel \n" +
        "    load_script=Load_SkateShopLevel \n" +
        '    name="Skate Shop" \n' +
        '    loading_screen="loadscrn_generic" \n' +
        "    loading_time=6.75 \n" +
        "    COIM_size=614400 \n" +
        '    level_name="skateshop" \n' +
        '    pre="mainmenu_scripts.pre" \n' +
        '    scnpre="mainmenuscn.pre" \n' +
        '    level="mainmenu" \n' +
        '    qb="levels\\\\skateshop\\\\skateshop.qb" \n' +
        '    colpre="mainmenucol.pre" \n' +
        "    default_stats=5 \n" +
        "    default_stats_classic=7 \n" +
        "    level_number=LevelNum_Default \n" +
        "    skip_teammate_pro \n" +
        lighting +
        "} \n";
    const anchor = "\nscript Load_TestLevel {";
    if (countOf(text, anchor) !== 1) pyExit("Levels.qb: Load_TestLevel not found once");
    return replaceFirst(text, anchor, `\n${level}${anchor.slice(1)}`);
}

// Front-end-only parts of the shop's nodes: the shadow skater's trigger (its script runs the options menu's skater)
// and the menus' 3D backgrounds.
export const SHOP_FRONT_END_TRIGGERS = ["TriggerScript=TRGP_shadowtriggerScript"];
export const SHOP_FRONT_END_OBJECTS = ["options_clousd_trigger", "ui_bg_trigger"];

// The shop's node array as skateshop.qb's (its array is named after the file).
export function skateshopNodes(text: string): string {
    text = replaceFirst(text, "mainmenu_NodeArray =", "skateshop_NodeArray =");
    for (const trigger of SHOP_FRONT_END_TRIGGERS) {
        const n = countOf(text, trigger);
        if (n !== 1) pyExit(`mainmenu.qb: ${trigger} found ${n} times`);
        text = replaceFirst(text, trigger, "");
    }
    let [elements] = arrayElements(text, "skateshop_NodeArray");
    for (const element of elements) {
        const name = search(/\bName=(\w+)/, element);
        if (name && SHOP_FRONT_END_OBJECTS.includes(name.str(1)) && element.includes("CreatedAtStart")) {
            text = replaceFirst(text, element, replaceFirst(element, "CreatedAtStart", ""));
        }
    }
    // The skater starts at the first player restart: the shop's SS_player_restart (y -375, below the shop - the front
    // end always moves the skater to TRG_Playerrestart by script) comes first. The two swap places (nothing links to
    // nodes by index).
    [elements] = arrayElements(text, "skateshop_NodeArray");
    const named = new Map<string, string>();
    for (const e of elements) {
        const m = search(/\bName=(\w+)/, e);
        if (m) named.set(m.str(1), e);
    }
    const first = named.get("SS_player_restart");
    const wanted = named.get("TRG_Playerrestart");
    if (!first || !wanted || indexOrThrow(text, first) > indexOrThrow(text, wanted)) {
        pyExit("mainmenu.qb: the shop's restarts not as expected");
    }
    return replaceFirst(replaceFirst(replaceFirst(text, wanted, "\0"), first, wanted), "\0", first);
}

export function addSkateshopSign(text: string, thps4: portedLevels.Manifest | null = null): string {
    // The level select's SKATE SHOP sign, after TRAINING (its unlock flag and sign; level 21's records, the test
    // level's slot - LevelNum_Default is shared); the converted THPS4 levels' signs after it (tools/pipeline/thps4_levels).
    const training = search(/\n( *)\{text="TRAINING" level_num=LevelNum_TR level_prefix="TR"[^\n]*\n/, text);
    if (!training) pyExit("gamemenu_levelselect.qb: the TRAINING entry not found");
    let sign =
        `${training.str(1)}{text="SKATE SHOP" level_num=${SKATESHOP_SIGN_LEVEL} num_goals=0 flag=LEVEL_UNLOCKED_TR level=Load_SkateShopLevel ` +
        "sign_texture=sign_training dot_pos=(89.0, 82.0)} \n";
    let extraNumbers: number[] = [];
    if (thps4) {
        sign += portedLevels.signsText(thps4, training.str(1));
        extraNumbers = portedLevels.signNumbers(thps4);
    }
    text = text.slice(0, training.end()) + sign + text.slice(training.end());
    // The developers' TestLevel (all its data ships: scene, collision, peds, scripts) in the list too: its entry was
    // DEVKIT_ONLY (dropped: CD is always true) and had no sign.
    const test = search(/\{text="TestLevel" level_num=21 [^\n]*DEVKIT_ONLY[^\n]*\}/, text);
    if (!test) pyExit("gamemenu_levelselect.qb: the TestLevel entry not found");
    text = replaceFirst(
        text,
        test.str(0),
        '{text="TEST LEVEL" level_num=21 num_goals=0 flag=LEVEL_UNLOCKED_TR ' +
            "level=load_TestLevel sign_texture=sign_training dot_pos=(89.0, 82.0)}",
    );
    // The info panel's gaps and high score: levels 18 and 21 have no records (GetLevelGapTotals reads through a null
    // for them): skipped, as the created park's are.
    for (const script of ["level_select_info_add_gaps", "level_select_info_add_highscore"]) {
        const head = `script ${script} {\n    if (<level_num> = <created_park_number>) {\n        return \n    } \n`;
        if (countOf(text, head) !== 1) pyExit(`gamemenu_levelselect.qb: ${script}'s start not as expected`);
        const skips = [SKATESHOP_SIGN_LEVEL, TESTLEVEL_SIGN_LEVEL, ...extraNumbers]
            .map((n) => `    if (<level_num> = ${n}) {\n        return \n    } \n`)
            .join("");
        text = replaceFirst(text, head, head + skips);
    }
    return text;
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

export function dropUninstalledDefault(text: string, game: string): string {
    // The developers' level Default (level_num=30, DEVKIT_ONLY: shown when CD is false - thug2-decomp.ini
    // [features] debug_mode=1): the PC release ships only its scripts and sky (Data\levels\default\default_Scripts.qb,
    // default_sky\) - not its scene or node array (levels\Default\Default.scn.xbx / Default.qb, no pre has them).
    // Choosing it crashed: LoadScene's load returns no scene and the game writes through it (0x0048C5AA). Its entry
    // is dropped unless the scene is installed.
    const entry = search(/\n *\{text="Default" level_num=30 [^\n]*level=load_Default[^\n]*\} *(?=\n)/, text);
    if (!entry) pyExit("gamemenu_levelselect.qb: the Default entry not found");
    const level = path.join(game, "Data", "levels", "Default");
    if (fs.existsSync(path.join(level, "Default.scn.xbx")) && fs.existsSync(path.join(level, "Default.qb"))) {
        return text;
    }
    print("level select: Default dropped (its scene isn't installed)");
    return text.slice(0, entry.start()) + text.slice(entry.end());
}

export function testlevelNodes(text: string): string {
    // TestLevel in network games: load_level makes no path memory there (AllocatePathManMemory only outside them), and
    // an object following a path crashes (0x00469620 reads through the missing path manager). The shipped levels keep
    // such objects out of network games (AbsentInNetGames); the developers' test level didn't for Obj_BeachBall07
    // (Obj_FollowPathLinked). Every node whose trigger script follows a path gets AbsentInNetGames.
    const followers = new Set(findall(/\nscript (\w+) \{[^}]*Obj_FollowPath/, text));
    const [elements] = arrayElements(text, "TestLevel_NodeArray");
    let marked = 0;
    for (const element of elements) {
        const script = search(/\bTriggerScript=(\w+)/, element);
        if (script && followers.has(script.str(1)) && !element.includes("AbsentInNetGames")) {
            text = replaceFirst(
                text,
                element,
                replaceFirst(element, "CreatedAtStart", "CreatedAtStart AbsentInNetGames"),
            );
            marked += 1;
        }
    }
    print(`TestLevel: ${marked} path-following node(s) kept out of network games`);
    return text;
}

// --- the level editor (src/game/front/level_editor.h) -------------------------------------------------------------

export const LEVEL_EDITOR_SCRIPTS = `script level_editor_enter {
    if ! LevelEditor_Start {
        return
    }
    if ObjectExists id=current_menu_anchor {
        DestroyScreenElement id=current_menu_anchor
    }
    if ObjectExists id=helper_text_anchor {
        DestroyScreenElement id=helper_text_anchor
    }
    pause_menu_gradient off
    menu3d_hide
    PauseSkaters
    HideSkaterAndMiscSkaterEffects
    SetScreenElementProps {
        id=root_window
        replace_handlers
        event_handlers=[{pad_start level_editor_exit}]
    }
    SetScreenElementProps {
        id=root_window
        replace_handlers
        event_handlers=[{pad_select null_script}]
    }
    level_editor_hud_create
}
script level_editor_exit {
    level_editor_hud_destroy
    LevelEditor_Stop
    Skater:AddSkaterToWorld
    create_pause_menu
}
script level_editor_hud_create {
    level_editor_hud_destroy
    SetScreenElementLock id=root_window off
    CreateScreenElement {
        type=ContainerElement
        parent=root_window
        id=level_editor_hud
        pos=(320.0, 218.0)
        dims=(640.0, 480.0)
    }
    CreateScreenElement {
        type=SpriteElement
        parent=level_editor_hud
        texture=white2
        pos=(6.0, 6.0)
        just=[left top]
        rgba=[2 0 1 90]
        scale=(118.0, 6.9)
        z_priority=990
    }
    CreateScreenElement {
        type=SpriteElement
        parent=level_editor_hud
        texture=white3
        scale=(11.8, 0.03)
        rgba=[128 110 0 90]
        pos=(6.0, 20.0)
        just=[left top]
        z_priority=991
    }
    CreateScreenElement {
        type=SpriteElement
        parent=level_editor_hud
        texture=white2
        pos=(320.0, 480.0)
        just=[center bottom]
        rgba=[2 0 1 90]
        scale=(200.5, 3.8)
        z_priority=990
    }
    CreateScreenElement {
        type=SpriteElement
        parent=level_editor_hud
        texture=white3
        scale=(40.0, 0.03)
        rgba=[13 56 82 80]
        pos=(320.0, 450.0)
        z_priority=991
    }
    <index> = 1
    while {
        FormatText ChecksumName=line_id "level_editor_hud_%i" i=<index>
        CreateScreenElement {
            type=TextElement
            parent=level_editor_hud
            id=<line_id>
            font=small
            text=""
            pos=((14.0, 0.0) + (0.0, 11.0) * <index>)
            just=[left top]
            scale=0.56
            rgba=[118 118 118 128]
            z_priority=1000
        }
        <index> = (<index> + 1)
    } 4
    SetScreenElementProps id=level_editor_hud_1 rgba=[128 110 0 128] scale=0.62 pos=(14.0, 9.0)
    SetScreenElementProps id=level_editor_hud_3 rgba=[96 100 104 128]
    SetScreenElementProps id=level_editor_hud_4 rgba=[80 90 100 128]
    CreateScreenElement {
        type=TextElement
        parent=level_editor_hud
        id=level_editor_hud_5
        font=small
        text=""
        pos=(14.0, 455.0)
        just=[left top]
        scale=0.55
        rgba=[104 104 104 128]
        z_priority=1000
    }
    CreateScreenElement {
        type=TextElement
        parent=level_editor_hud
        id=level_editor_hud_6
        font=small
        text=""
        pos=(14.0, 466.0)
        just=[left top]
        scale=0.55
        rgba=[104 104 104 128]
        z_priority=1000
    }
    CreateScreenElement {
        type=TextElement
        parent=level_editor_hud
        id=level_editor_hud_7
        font=small
        text=""
        pos=(320.0, 92.0)
        just=[center top]
        scale=0.8
        rgba=[128 120 64 128]
        z_priority=1000
    }
}
script level_editor_hud_set {
    if ObjectExists id=<id> {
        SetScreenElementProps id=<id> text=<text>
    }
}
script level_editor_hud_destroy {
    level_editor_panel_hide
    if ObjectExists id=level_editor_hud {
        DestroyScreenElement id=level_editor_hud
    }
}
script level_editor_panel_show {
    level_editor_panel_hide
    if ! ObjectExists id=level_editor_hud {
        return
    }
    CreateScreenElement {
        type=ContainerElement
        parent=level_editor_hud
        id=level_editor_panel
        pos=(320.0, 240.0)
        dims=(640.0, 480.0)
    }
    CreateScreenElement {
        type=SpriteElement
        parent=level_editor_panel
        texture=white2
        pos=<pos>
        just=[left top]
        rgba=[2 0 1 104]
        scale=<scale>
        z_priority=992
    }
    <index> = 0
    while {
        FormatText ChecksumName=line_id "level_editor_panel_%i" i=<index>
        CreateScreenElement {
            type=TextElement
            parent=level_editor_panel
            id=<line_id>
            font=small
            text=""
            pos=(<pos> + (8.0, 6.0) + (0.0, 12.5) * <index>)
            just=[left top]
            scale=0.56
            rgba=[118 118 118 128]
            z_priority=1001
        }
        <index> = (<index> + 1)
    } <lines>
    SetScreenElementProps id=level_editor_panel_0 rgba=[128 110 0 128]
}
script level_editor_panel_hide {
    if ObjectExists id=level_editor_panel {
        DestroyScreenElement id=level_editor_panel
    }
}
`;

export function addLevelEditor(text: string): string {
    // The pause menu's LEVEL EDITOR item (after YOUR OPTIONS: single player only - net games don't get that item, the
    // park editor's own pause menu returns earlier) while LevelEditor_Available (the [features] level_editor setting,
    // in a level), and the two scripts. level_editor_enter takes the pause menu down as the goal editor's
    // my_exit_pause_menu does (the game stays paused: no UnpauseGame), the skater out of the world as its edit_goal
    // does (PauseSkaters, HideSkaterAndMiscSkaterEffects), and Start / Select over to the editor (Start leaves it).
    // level_editor_exit brings the skater back and the pause menu again (its CONTINUE unpauses as ever).
    // (Id= in Anteara Mod's pause menu: tools/anteara)
    const options = search(
        /\n( *)add_roundbar_menu_item text="YOUR OPTIONS" [Ii]d=menu_your_options pad_choose_script=create_your_options_menu \n/,
        text,
    );
    if (!options || countOf(text, 'text="YOUR OPTIONS"') !== 1)
        pyExit("gamemenu_pause.qb: the YOUR OPTIONS item not found once");
    const indent = options.str(1);
    let item =
        `${indent}if LevelEditor_Available {\n${indent}    add_roundbar_menu_item text="LEVEL EDITOR" id=menu_level_editor ` +
        `pad_choose_script=level_editor_enter \n${indent}} \n`;
    // DEBUG OPTIONS: Neversoft's own hub of debug menus (gamemenu.qb create_debug_options_menu), which the retail
    // pause menu never offers; shown while CD is false - the DLL's [features] debug_mode (src/game/sys/debug_mode.h).
    item +=
        `${indent}if ! CD {\n${indent}    add_roundbar_menu_item text="DEBUG OPTIONS" id=menu_debug_options ` +
        `pad_choose_script=create_debug_options_menu \n${indent}} \n`;
    text = text.slice(0, options.end()) + item + text.slice(options.end());
    const register = text.indexOf("\n__register_checksums__");
    const at = register >= 0 ? register + 1 : text.length;
    return text.slice(0, at) + LEVEL_EDITOR_SCRIPTS + text.slice(at);
}

// --- the new front end's pause menu items (the DLL's src/game/front/new_frontend.h) ----------------------------------

const NEW_FRONTEND_PAUSE_SCRIPTS = `script newfe_open {
    NewFrontend_Open <...>
}
script newfe_pause_restart {
    handle_pause_continue <...>
    SpawnScript newfe_pause_restart_after
}
script newfe_pause_restart_after {
    wait 1 gameframe
    ResetSkaters
}
`;

export function addNewFrontendPause(text: string): string {
    // With [features] new_frontend=1 the pause menu is the game's, restyled by the DLL - so the new front end's own
    // items are made here, each only while NewFrontend_Item says so (false with the new front end off: the menu as
    // it was): RESTART after CONTINUE (free skate: CONTINUE, then ResetSkaters), CHANGE LEVEL opening our level select
    // (NewFrontend_Open screen=levels) in place of the game's, and OPTIONS (ours; its Game options row opens the game's)
    // in place of GAME OPTIONS. A part not found (Anteara Mod's pause menu) is left as it is.
    const continueItem = /\n( *)add_roundbar_menu_item \{text="CONTINUE" \n[\s\S]*?\n\1\} \n/g;
    text = text.replace(
        continueItem,
        (block: string, indent: string) =>
            `${block}${indent}if NewFrontend_Item item=restart {\n${indent}    add_roundbar_menu_item text="RESTART" ` +
            `id=menu_newfe_restart pad_choose_script=newfe_pause_restart \n${indent}} \n`,
    );
    const changeLevel = search(/\n( *)(add_roundbar_menu_item \{text="CHANGE LEVEL" \n[\s\S]*?\n\1\} \n)/, text);
    if (changeLevel) {
        const indent = changeLevel.str(1);
        const wrapped =
            `\n${indent}if NewFrontend_Item item=levels {\n${indent}    add_roundbar_menu_item text="CHANGE LEVEL" ` +
            `id=menu_level_select pad_choose_script=newfe_open pad_choose_params={screen=levels} \n` +
            `${indent}} else {\n${indent}${changeLevel.str(2)}${indent}} \n`;
        text = text.slice(0, changeLevel.start()) + wrapped + text.slice(changeLevel.end());
    }
    const gameOptions = search(
        /\n( *)(add_roundbar_menu_item text="GAME OPTIONS" id=menu_game_options pad_choose_script=create_options_menu \n)/,
        text,
    );
    if (gameOptions) {
        const indent = gameOptions.str(1);
        const wrapped =
            `\n${indent}if NewFrontend_Item item=options {\n${indent}    add_roundbar_menu_item text="OPTIONS" ` +
            `id=menu_newfe_options pad_choose_script=newfe_open pad_choose_params={screen=options} \n` +
            `${indent}} else {\n${indent}    ${gameOptions.str(2)}${indent}} \n`;
        text = text.slice(0, gameOptions.start()) + wrapped + text.slice(gameOptions.end());
    }
    const register = text.indexOf("\n__register_checksums__");
    const at = register >= 0 ? register + 1 : text.length;
    return text.slice(0, at) + NEW_FRONTEND_PAUSE_SCRIPTS + text.slice(at);
}

// The new front end's main menu (with [features] new_frontend=1 the DLL restyles the game's menus - these say what
// they hold): Career (our menu of THUG2 Story, Classic and THUG Story - not yet), Free Skate, Online, Create, Options
// (ours) and Quit; back from STORY / CLASSIC MODE OPTIONS to Career.
const NEW_FRONTEND_MAIN_SCRIPTS = `script newfe_main_menu_items {
    main_menu_list_item {
        text="CAREER"
        id=menu_newfe_career
        pad_choose_params={new_menu_script=newfe_career_menu hold_camera}
        mark_first_input
        icon=mainicon_story
    }
    main_menu_list_item {
        text="FREE SKATE"
        id=menu_singlesess
        pad_choose_params={new_menu_script=launch_select_skater_menu change_gamemode=change_gamemode_singlesession hold_camera do_loading_logo}
        mark_first_input
        icon=mainicon_score
    }
    main_menu_list_item {
        text="ONLINE"
        id=menu_net
        pad_choose_params={new_menu_script=select_network_play_multi change_gamemode=change_gamemode_net hold_camera do_loading_logo}
        mark_first_input
        icon=mainicon_online
    }
    main_menu_list_item {
        text="CREATE"
        id=menu_createamodes
        pad_choose_params={new_menu_script=create_createamodes_menu change_gamemode=change_gamemode_singlesession hold_camera}
        mark_first_input
        icon=mainicon_mode
    }
    main_menu_list_item {
        text="OPTIONS"
        id=menu_newfe_options
        pad_choose_script=newfe_open
        pad_choose_params={screen=options}
        mark_first_input
        icon=mainicon_options
    }
    main_menu_list_item {
        text="QUIT"
        id=menu_quit
        pad_choose_params={new_menu_script=main_menu_exit_game hold_camera}
        icon=mainicon_mode
    }
}
script newfe_career_menu {
    make_new_roundbar_menu title="CAREER" pos=(130.0, 100.0) spacing=6 pad_back_script=generic_menu_pad_back pad_back_params={callback=create_main_menu} vmenu_id=newfe_career_vmenu
    add_roundbar_menu_item {
        text="STORY MODE"
        id=menu_career
        pad_choose_script=gamemode_options_menu_exit
        pad_choose_params={new_menu_script=create_gamemode_options_menu change_gamemode=change_gamemode_career}
    }
    add_roundbar_menu_item {
        text="CLASSIC MODE"
        id=menu_classic
        pad_choose_script=gamemode_options_menu_exit
        pad_choose_params={new_menu_script=create_gamemode_options_menu change_gamemode=change_gamemode_classic}
    }
    add_roundbar_menu_item text="THUG STORY" id=menu_newfe_thugstory not_focusable
    roundbar_menu_finish build_pause_parts=0
}
script newfe_back_to_career {
    if NewFrontend_Item item=on {
        newfe_career_menu
    } else {
        create_main_menu
    }
}
`;

export function addNewFrontendMain(text: string): string {
    // The front end's scripts (the standard main menu's): while NewFrontend_Item item=on, add_main_menu_list_items makes
    // our items (newfe_main_menu_items) instead of the game's; STORY / CLASSIC MODE OPTIONS go back to our Career
    // menu; CREATE-A-MODES gets LEVEL EDITOR (NewFrontend_Open screen=editlevels) while NewFrontend_Item item=editor.
    const items = "script add_main_menu_list_items {\n";
    if (countOf(text, items) !== 1) pyExit("mainmenu_scripts.qb: add_main_menu_list_items not found once");
    text = replaceFirst(
        text,
        items,
        `${items}    if NewFrontend_Item item=on {\n        newfe_main_menu_items \n        return \n    } \n`,
    );
    const back = "pad_back_params={callback=create_main_menu} vmenu_id=career_options_vmenu";
    if (countOf(text, back) !== 1) pyExit("mainmenu_scripts.qb: create_gamemode_options_menu's back not found once");
    text = replaceFirst(text, back, "pad_back_params={callback=newfe_back_to_career} vmenu_id=career_options_vmenu");
    const create = search(
        /script create_createamodes_menu \{\n[\s\S]*?\n( *)draw_menu_background create_mode \n/,
        text,
    );
    if (!create) pyExit("mainmenu_scripts.qb: create_createamodes_menu's draw_menu_background not found");
    const indent = create.str(1);
    const at = create.end() - `${indent}draw_menu_background create_mode \n`.length;
    const editor =
        `${indent}if NewFrontend_Item item=editor {\n${indent}    add_roundbar_menu_item text="LEVEL EDITOR" ` +
        `id=menu_newfe_editor pad_choose_script=newfe_open pad_choose_params={screen=editlevels} icon=mainicon_cap \n` +
        `${indent}} \n`;
    text = text.slice(0, at) + editor + text.slice(at);
    const register = text.indexOf("\n__register_checksums__");
    const end = register >= 0 ? register + 1 : text.length;
    return text.slice(0, end) + NEW_FRONTEND_MAIN_SCRIPTS + text.slice(end);
}

export function addNewFrontendSkateshop(text: string): string {
    // The skate shop's menu (after the skater select): in free skate its Play Level opens our level select while
    // NewFrontend_Item item=levels (Back from it makes the shop's menu again: create_ss_menu). A part not found
    // (Anteara Mod's) is left as it is.
    const play = search(/\n( *)(add_roundbar_menu_item \{text=%"Play Level" \n[\s\S]*?\n\1\} \n)/, text);
    if (!play) return text;
    const indent = play.str(1);
    const wrapped =
        `\n${indent}if NewFrontend_Item item=levels {\n${indent}    add_roundbar_menu_item {text=%"Play Level" ` +
        `id=ss_play_level pad_choose_script=ss_menu_exit pad_choose_params={new_menu_script=newfe_open screen=levels ` +
        `back=create_ss_menu}} \n${indent}} else {\n${indent}${play.str(2)}${indent}} \n`;
    return text.slice(0, play.start()) + wrapped + text.slice(play.end());
}

// --- GAME OPTIONS' CREATE 100% CAS (career_complete.ts; the DLL's src/game/front/career_complete.h) --------------

export const OPTIONS_MENU_QB = "levels\\mainmenu\\mainmenu_options.qb";

type Decompile = (data: Buffer, name: string) => string;
type Write = (text: string, name: string) => void;

// ntpath.basename / splitext's root
function ntBasename(p: string): string {
    const at = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return at < 0 ? p : p.slice(at + 1);
}

function splitextRoot(p: string): string {
    const sep = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    const dot = p.lastIndexOf(".");
    if (dot <= sep) return p;
    // (leading dots of the file name don't start an extension)
    let first = sep + 1;
    while (first < dot && p[first] === ".") first++;
    return first === dot ? p : p.slice(0, dot);
}

export function addCreate100Cas(decompile: Decompile, write: Write, pre: string, levels: string): void {
    // The front end's GAME OPTIONS scripts with CREATE 100% CAS: the story's chapters, goals and rewards, the classic
    // goals and every level's gaps read from the game's scripts (Levels.qb's text `levels`, chapter_info,
    // goal_utilities, stats, the level select, and the levels' compiled scripts and node arrays).
    const qbScripts = pyJoin(pre, "qb_scripts.prx");
    const scriptFile = (name: string): string => decompile(prxFile(qbScripts, name), ntBasename(name));
    const levelScripts = (prefix: string, qb: string, preName: string): string =>
        decompile(prxFile(pyJoin(pre, `${splitextRoot(preName)}.prx`), qb), `${prefix}_scripts.qb`);
    const levelQbs = (preName: string): Map<string, Buffer> => prxFiles(pyJoin(pre, `${splitextRoot(preName)}.prx`));
    const data = careerComplete.careerData(
        levels,
        scriptFile("scripts\\game\\menu\\chapter_info.qb"),
        scriptFile("scripts\\game\\goal_utilities.qb"),
        scriptFile("scripts\\game\\menu\\stats.qb"),
        levelScripts,
        scriptFile("scripts\\game\\menu\\gamemenu_levelselect.qb"),
        prxFiles(qbScripts),
        levelQbs,
    );
    const options = decompile(prxFile(pyJoin(pre, "mainmenu_scripts.prx"), OPTIONS_MENU_QB), "mainmenu_options.qb");
    write(careerComplete.optionsMenu(options, data), OPTIONS_MENU_QB);
    print(`CREATE 100% CAS (GAME OPTIONS):\n${careerComplete.describe(data)}`);
}

// --- the standard main menu (src/game/front/menu_backdrop.h) ------------------------------------------------------

// The front end's backdrop: the THPS4 skate shop (tools/pipeline/thps4_levels), shown behind the menus by the DLL.
export const BACKDROP_LEVEL = "thps4_skateshop";

// create_main_menu as the game's (mainmenu_scripts.qb), but a roundbar menu (make_new_roundbar_menu /
// add_roundbar_menu_item, as Game Options and Create-A-Modes) where it made the spinning wheel (make_spin_menu: a
// turned VMenu with filler items, a copy of the items, the highlight bar and icon, the wheel's level objects turned
// with it). The menu's ids stay main_menu / main_vmenu (scripts find main_vmenu); its place on screen is
// main_menu_list_pos, the 640 x 480 layout's top left of the items, on a dark backing (main_menu_backing: the shop's
// wall of decks behind made the items hard to read): centred, above the THPS4 shop's counter in the
// held view (its glass counter's top - the wheels and decks on it, ~y 20 - projects to screen y ~300; worked out
// from the node positions, not yet seen in the game). The skater, its camera (mainmenu_camera02 - the
// DLL holds the view while it plays), the wheel's objects (left as the game shows them: in THUG2's shop, out of
// sight), the attract mode timer, the second controller check and the rest are as the game's.
// The items are add_main_menu_items' (the same conditions, ids, scripts and parameters), each chosen through
// main_menu_choose: main_menu_exit without the wheel's spin (the skater's spin animation, the click, the turns) -
// a short fade instead, then the item's script. The item chosen is focused when the menu comes back (as the game's
// spin_menu_selected_index). Items the game makes inactive (active=0) are shown but not focusable; the 2 player
// item's tag `active` is switched by the game's enable / disable_two_player_option as before, and main_menu_choose
// doesn't run an inactive item.
// SKATE NOW (main_menu_skate_now): the menu slides out, the skater gets skating physics (main_menu_skater_skate: the
// front end's skater is in walking physics mode), then THPS4's practice start: the restart TRG_SS_SkaterDropIn
// (frontEndNodes) and DropIn. The restart is KillSkater node= - the skater's real restart (ResetSkaters skips the
// front end's skater; Obj_MoveToNode left the physics behind: the drop-in ended with a snap); it restarts the skater's
// script, so DropIn is started after it. Esc (root_window's pad_start) brings the menu back (main_menu_skate_stop)
// behind a short fade to black: built as it is, the menu came back in pieces over a few frames (the items sliding in
// over the skating view, then the camera, the skater still on his board, then the title).
// (the scripts: main_menu.ts - made each run from the user's game scripts, our changes stored as edits)

// The front end's skater stands in THPS4's shop (the DLL draws only that shop in the front end): its restarts
// (TRG_Playerrestart - the main menu, Create-A-Skater and the other menus' skater; SS_player_restart - the skate
// shop menu's) moved to the floor on the left of the held view, a few steps in front of the counter, facing the
// camera (yaw:
// the skater faces (sin yaw, 0, cos yaw); the held view's camera is at (565, 74, -1114)).
export const FRONT_END_SKATER_POS: readonly [number, number, number] = [467.0, 0.0, -1304.0];
export const FRONT_END_SKATER_ANGLES: readonly [number, number, number] = [0.0, 0.474, 0.0];

// THPS4's practice start (its start_practice_run_skater: ResetSkaters node_name=TRG_SS_SkaterDropIn, MakeSkaterGoto
// Dropin): the restart on the outside halfpipe's coping that SKATE NOW drops in from.
export const DROP_IN_NODE = "TRG_SS_SkaterDropIn";

const fx = (x: number, digits: number): string => formatFixed(x, digits);

// Python's float(v) for each of "x, y, z".
function floats(text: string): number[] {
    return text.split(",").map((v) => pyParseFloat(v));
}

export function frontEndNodes(text: string, backdropNodes: string): string {
    // The front end's node array (levels\mainmenu\mainmenu.qb) with its restarts moved into THPS4's shop, and THPS4's
    // drop-in restart added at the end (from the converted shop's node array `backdropNodes`, as NeverScript text;
    // added last, the front end's node indices and links are unchanged).
    // The front end loaded only TERRAIN_DEFAULT's sounds (its LoadTerrain): THPS4's shop is wood, metal... - silent
    // rolling after SKATE NOW. Every terrain's, as the ported levels (level_port nodes.loadTerrainNs).
    const terrain = search(/script LoadTerrain \{\n.*?\n\} \n/s, text);
    if (!terrain) pyExit("mainmenu.qb: LoadTerrain not found");
    text = `${text.slice(0, terrain.start())}${levelPortNodes.loadTerrainNs()} \n${text.slice(terrain.end())}`;
    for (const name of ["TRG_Playerrestart", "SS_player_restart"]) {
        const node = search(
            new RegExp(`\\n( *)Pos=\\([^)]*\\) *\\n *Angles=\\([^)]*\\) *\\n *Name=${name} *\\n`),
            text,
        );
        if (!node) pyExit(`mainmenu.qb: the restart ${name} not found`);
        const indent = node.str(1);
        const [px, py, pz] = FRONT_END_SKATER_POS;
        const [ax, ay, az] = FRONT_END_SKATER_ANGLES;
        const moved =
            `\n${indent}Pos=(${fx(px, 1)}, ${fx(py, 1)}, ${fx(pz, 1)}) \n` +
            `${indent}Angles=(${fx(ax, 6)}, ${fx(ay, 6)}, ${fx(az, 6)}) \n${indent}Name=${name} \n`;
        text = text.slice(0, node.start()) + moved + text.slice(node.end());
    }
    const node = search(
        new RegExp(`\\n *Position=\\(([^)]*)\\) *\\n *Angles=\\(([^)]*)\\) *\\n *Name=${DROP_IN_NODE} *\\n`),
        backdropNodes,
    );
    const end = text.indexOf("\n] \n");
    if (!node || end < 0 || text.indexOf("\n] \n", end + 1) >= 0) {
        pyExit(`the front end's node array / ${BACKDROP_LEVEL}'s ${DROP_IN_NODE} not as expected`);
    }
    // Written as THUG2's own nodes are: Pos = the legacy Position with z negated (as the engine reads it), THPS4's
    // angles kept (the skater pitched 90 degrees against the vert at the coping: DropIn's animation - THPS4's, never
    // used by THUG2 itself - is made for that). Copied verbatim instead (Position= with CreatedAtStart), the game quit
    // at start-up.
    const [x, y, z] = floats(node.str(1)) as [number, number, number];
    const [pitch, yaw, roll] = floats(node.str(2)) as [number, number, number];
    const dropIn =
        `    {\n        Pos=(${fx(x, 3)}, ${fx(y, 5)}, ${fx(-z, 3)}) \n        Angles=(${fx(pitch, 6)}, ${fx(yaw, 6)}, ${fx(roll, 6)}) \n        Name=${DROP_IN_NODE} \n` +
        '        Class=Restart \n        Type=Generic \n        CreatedAtStart \n        RestartName="DropIn" \n' +
        "        restart_types=[Generic] \n    } \n";
    return text.slice(0, end + 1) + dropIn + text.slice(end + 1);
}

// The converted shop's peds, cars and their waypoints (tools/pipeline/level_port/peds_cars.ts: the last nodes of its array).
export const MOVING_CLASSES: ReadonlySet<string> = new Set(["pedestrian", "vehicle", "waypoint"]);

// re.split(r"[,\s]+", text.strip())
function splitLinks(text: string): string[] {
    return pyStrip(text).split(/[,\s]+/);
}

// "Pos=(%.4f, %.4f, %.4f)" of a legacy Position=(...) with z negated
function legacyPos(m: Match): string {
    const [x, y, z] = floats(m.str(1)) as [number, number, number];
    return `Pos=(${fx(x, 4)}, ${fx(y, 4)}, ${fx(-z, 4)})`;
}

export function frontEndRails(text: string, backdropNodes: string): string {
    // The front end's node array with the converted shop's rails (RailNode: THPS4's coping rails on the halfpipes, the
    // ledges...) added at its end - grindable after SKATE NOW. Their Links (to other rails) renumbered; the legacy
    // Position written as Pos (z negated, as the engine reads Position: copied as Position, a node made the front end
    // quit at start-up).
    const [elements] = arrayElements(backdropNodes, `${BACKDROP_LEVEL}_NodeArray`);
    const rails: number[] = [];
    elements.forEach((e, i) => {
        if (/\bClass=RailNode\b/.test(e)) rails.push(i);
    });
    const [own, , close] = arrayElements(text, "mainmenu_NodeArray");
    const index = new Map(rails.map((old, n) => [old, own.length + n]));
    const renumber = (match: Match): string => {
        const links = splitLinks(match.str(1))
            .filter((v) => v)
            .map(pyParseInt);
        if (links.some((v) => !index.has(v))) pyExit(`${BACKDROP_LEVEL}: a rail linked to a node that isn't a rail`);
        return `Links=[${links.map((v) => String(index.get(v))).join(", ")}]`;
    };
    let added = "";
    for (const i of rails) {
        let node = sub(/Links=\[([^\]]*)\]/, renumber, elements[i]!);
        // (the shop's gap scripts are in its own .qb, not the front end's)
        node = sub(/\n[ \t]*TriggerScript=\w+[ \t]*(?=\n)/, "", node);
        added += `    ${sub(/\bPosition=\(([^)]*)\)/, legacyPos, node)} \n`;
    }
    print(`front end: ${rails.length} rail nodes from ${BACKDROP_LEVEL}`);
    return text.slice(0, close) + added + text.slice(close);
}

export function frontEndPedsCars(text: string, backdropNodes: string): string {
    // The front end's node array with the converted shop's peds and cars (the pros on the outside halfpipe, the people
    // walking by, the cars on the road: seen after SKATE NOW) added at its end - their Links renumbered, their trigger
    // scripts copied.
    const [elements] = arrayElements(backdropNodes, `${BACKDROP_LEVEL}_NodeArray`);
    const kinds = elements.map((e) => {
        const m = search(/\bClass=(\w+)/, e);
        return m ? m.str(1).toLowerCase() : "";
    });
    // (the last run of them: the converted shop's own waypoints - its scripts' objects' paths - come earlier)
    let first = kinds.length;
    while (first > 0 && MOVING_CLASSES.has(kinds[first - 1]!)) first -= 1;
    const linksBefore = (start: number): boolean =>
        elements
            .slice(start)
            .some((e) =>
                [...finditer(/Links=\[([^\]]*)\]/, e)].some((m) =>
                    splitLinks(m.str(1)).some((v) => v && pyParseInt(v) < start),
                ),
            );
    while (first < kinds.length && linksBefore(first)) first += 1;
    if (first >= kinds.length) {
        print(`${BACKDROP_LEVEL} has no peds or cars: none in the front end`);
        return text;
    }
    if (kinds.slice(first).some((kind) => !MOVING_CLASSES.has(kind))) {
        pyExit(`${BACKDROP_LEVEL}: its peds and cars aren't the last nodes of its array`);
    }
    const [own, , close] = arrayElements(text, "mainmenu_NodeArray");
    const base = own.length;
    const start = first;
    const renumber = (match: Match): string =>
        `Links=[${splitLinks(match.str(1))
            .map((v) => String(pyParseInt(v) - start + base))
            .join(", ")}]`;
    const added = elements
        .slice(first)
        .map((e) => `    ${sub(/Links=\[([^\]]*)\]/, renumber, e)} \n`)
        .join("");
    text = text.slice(0, close) + added + text.slice(close);
    const scripts: string[] = [];
    for (const name of new Set(findall(/\bTriggerScript=(\w+)/, elements.slice(first).join("")))) {
        const found = search(new RegExp(`(?:^|\\n)(script ${reEscape(name)} \\{\\n.*?\\n\\} \\n)`, "s"), backdropNodes);
        if (!found) pyExit(`${BACKDROP_LEVEL}: the trigger script ${name} not found`);
        scripts.push(found.str(1));
    }
    const register = text.indexOf("\n__register_checksums__");
    const at = register >= 0 ? register + 1 : text.length;
    print(`front end: ${elements.length - first} peds / cars / waypoints from ${BACKDROP_LEVEL}`);
    return text.slice(0, at) + scripts.join("") + text.slice(at);
}

// Python's re \b[A-Za-z_]\w*\b (\w Unicode-aware)
const WORD = /(?<![\p{L}\p{N}_])[A-Za-z_][\p{L}\p{N}_]*/gu;

export function frontEndTriggers(text: string, backdropNodes: string): string {
    // The front end's node array with the converted shop's trigger geometry added at its end: the LevelGeometry nodes
    // with a TriggerScript (the outside halfpipe's vert sections SSO_Vert_Section01-03 - their gaps), and the scripts
    // their triggers run (the trigger scripts and the level's scripts they call, as the backdrop has them). The front
    // end has the shop's collision (loaded at its start, frontEndScripts), whose trigger faces name these nodes: a
    // trigger face is looked up by its object's name and the node's TriggerScript read without a check (0x00434A60) -
    // without the nodes, landing on the vert sections after SKATE NOW crashed (the user, 2026-10-19). Position written
    // as Pos (z negated); TrickObject / Cluster left out (the front end registers no trick objects).
    const [elements] = arrayElements(backdropNodes, `${BACKDROP_LEVEL}_NodeArray`);
    const triggers = elements.filter((e) => /\bClass=LevelGeometry\b/.test(e) && /\bTriggerScript=\w+/.test(e));
    if (!triggers.length) return text;
    let added = "";
    for (let node of triggers) {
        node = sub(/\n[ \t]*(TrickObject|Cluster=\S+)[ \t]*(?=\n)/, "", node);
        added += `    ${sub(/\bPosition=\(([^)]*)\)/, legacyPos, node)} \n`;
    }
    const [, , close] = arrayElements(text, "mainmenu_NodeArray");
    text = text.slice(0, close) + added + text.slice(close);
    // The scripts: the trigger scripts, then every script of the backdrop's they name (not the front end's own).
    const defined = new Map<string, string>();
    for (const m of finditer(/^script (\w+) \{\n.*?\n\} \n/ms, backdropNodes)) defined.set(m.str(1), m.str(0));
    const wanted = [...new Set(findall(/\bTriggerScript=(\w+)/, added))];
    for (let n = 0; n < wanted.length; n++) {
        const name = wanted[n]!;
        const body = defined.get(name);
        if (body === undefined) pyExit(`${BACKDROP_LEVEL}: the trigger script ${name} not found`);
        const brace = body.indexOf("{");
        if (brace < 0) throw new Error("list index out of range");
        for (const m of body.slice(brace + 1).matchAll(WORD)) {
            const word = m[0];
            if (defined.has(word) && !wanted.includes(word) && !text.includes(`\nscript ${word} {`)) wanted.push(word);
        }
    }
    const register = text.indexOf("\n__register_checksums__");
    const at = register >= 0 ? register + 1 : text.length;
    print(`front end: ${triggers.length} trigger geometry nodes and ${wanted.length} scripts from ${BACKDROP_LEVEL}`);
    return text.slice(0, at) + wanted.map((name) => defined.get(name)!).join("") + text.slice(at);
}

// The dark backing the front end's roundbar menus get (Game Options, Create-A-Modes, the network menus...): over
// THPS4's lit skate shop their items were hard to read (the main menu has its own, main_menu_backing). Sized from the
// menu's own dims and width, as main_menu_backing (white2 is 8 units).
export const ROUNDBAR_BACKING = `    if LevelIs Load_MainMenu {
        if ! ObjectExists id=main_menu {
            if ObjectExists id=current_menu {
                GetScreenElementDims id=current_menu
                current_menu:GetSingleTag menu_pos
                current_menu:GetSingleTag width
                if ScreenElementExists id=front_end_menu_backing {
                    DestroyScreenElement id=front_end_menu_backing
                }
                CreateScreenElement {
                    type=SpriteElement
                    parent=current_menu_anchor
                    id=front_end_menu_backing
                    texture=white2
                    pos=(<menu_pos> - (36.0, 9.0))
                    just=[left top]
                    rgba=[0 0 0 112]
                    scale=(((<width> + 72.0) / 8.0) * (1.0, 0.0) + ((<height> + 18.0) / 8.0) * (0.0, 1.0))
                    z_priority=-1
                }
            }
        }
    }
`;

export function frontEndRoundbar(text: string): string {
    // The game's roundbar menu scripts (scripts\game\menu\roundbarmenu.qb) with roundbar_menu_finish giving the menu a
    // dark backing in the front end (ROUNDBAR_BACKING; the overlay's front_end folder is read in levels too: the
    // LevelIs check keeps the pause menu as it is).
    const start = text.indexOf("script roundbar_menu_finish {");
    const end = text.indexOf("\n} \n", start);
    if (start < 0 || end < 0) pyExit("roundbarmenu.qb: roundbar_menu_finish not found");
    return text.slice(0, end + 1) + ROUNDBAR_BACKING + text.slice(end + 1);
}

export function frontEndScripts(text: string, look: UnitLookup): string {
    // The front end's scripts for THPS4's shop: the standard main menu; at the start, the shop's collision (the DLL
    // loads its scene; the skater skates there after SKATE NOW) and the skater's gameplay animations
    // (do_load_unloadable: load_level skips them for the front end - without them the skater skates in its bind
    // pose; once loaded they stay, as after any level); the skater standing idle instead of reaching for the wheel
    // (the main menu's skater animation: WStand, standing on foot, the board in his hand).
    text = addNewFrontendMain(standardMainMenu(text, look));
    const start = "script mainmenu_startup {\n";
    if (countOf(text, start) !== 1) pyExit("mainmenu_scripts.qb: mainmenu_startup not found");
    text = replaceFirst(text, start, `${start}    LoadCollision scene="${BACKDROP_LEVEL}" \n    do_load_unloadable \n`);
    const anim = search(/script SpinMenuGetSkaterAnim \{\n.*?\n\} \n/s, text);
    if (!anim) pyExit("mainmenu_scripts.qb: SpinMenuGetSkaterAnim not found");
    return `${text.slice(0, anim.start())}script SpinMenuGetSkaterAnim {\n    return anim=WStand \n} \n${text.slice(anim.end())}`;
}

export function standardMainMenu(text: string, look: UnitLookup): string {
    // The front end's scripts with create_main_menu replaced by the standard main menu's (main_menu.ts; the wheel's
    // scripts stay: other scripts call them).
    const start = indexOrThrow(text, "script create_main_menu {");
    const end = indexOrThrow(text, "script spin_menu_init {", start);
    return text.slice(0, start) + mainMenuScripts(look) + text.slice(end);
}

// The top-level { ... } elements of the array `name = [ ... ]` and where the array's [ ... ] is in `text`:
// [elements, offset of '[', offset of ']'].
export function arrayElements(text: string, name: string): [string[], number, number] {
    const found = search(new RegExp(`${reEscape(name)} =`, "i"), text); // (names are checksums: any case)
    if (!found) throw new Error(`${name} not found`);
    const openAt = indexOrThrow(text, "[", found.start());
    const elements: string[] = [];
    let depth = 0;
    let elementStart = 0;
    let i = openAt + 1;
    for (;;) {
        const c = text[i];
        if (c === undefined) throw new RangeError("string index out of range");
        if (c === '"') {
            i = indexOrThrow(text, '"', i + 1);
        } else if (c === "{" || c === "[" || c === "(") {
            if (depth === 0 && c === "{") elementStart = i;
            depth += 1;
        } else if (c === "}" || c === "]" || c === ")") {
            if (depth === 0) return [elements, openAt, i];
            depth -= 1;
            if (depth === 0 && c === "}") elements.push(text.slice(elementStart, i + 1));
        }
        i += 1;
    }
}

export function ns(tool: string, ...args: string[]): void {
    const result = spawnSync(tool, args, { maxBuffer: 1 << 30 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        pyExit(`ns ${args.join(" ")} failed:\n${textOutput(result.stdout)}${textOutput(result.stderr)}`);
    }
}

async function main(): Promise<number> {
    const { values } = parseCli(USAGE, {
        options: {
            game: { type: "string", default: "C:\\Games\\THUG2\\Game" },
            out: { type: "string" }, // the overlay folder (default: <game>\thug2-decomp-data)
            ns: {
                type: "string",
                default: NS_DEFAULT,
            },
            "hd-ui": { type: "string" }, // 2 or 4: the menus' images and fonts upscaled (tools/pipeline/hd_textures/ui.ts)
            "hd-ui-model": { type: "string" },
            "hd-ui-globe-ai": { type: "boolean" }, // the level select globe's tiles upscaled, not redrawn from map data
            "hd-ui-loading-model": { type: "string" }, // the loading screens only (default: the same)
            "scenic-style": { type: "string", default: "a" }, // the scenic art's filter (scenic_art.ts STYLES), off: the crops
            "frontend-fonts": { type: "string" }, // a folder of .ttf files for the new front end (frontend\fonts)
            // where the ported games are, for their loading pictures (default C:\Games\<GAME>; loading_art.ts)
            thps2: { type: "string" },
            thps3: { type: "string" },
            thps4: { type: "string" },
            thug1: { type: "string" },
            thaw: { type: "string" },
            thp8: { type: "string" },
        },
    });
    const loadingArtOverrides: Partial<Record<loadingArtGames.Game, string>> = {};
    for (const g of loadingArtGames.GAMES) if (values[g]) loadingArtOverrides[g] = values[g];
    const hdScale = values["hd-ui"] === undefined ? 0 : Number(values["hd-ui"]);
    const scenicStyle = values["scenic-style"];
    if (!["a", "b", "c", "off"].includes(scenicStyle)) pyExit("--scenic-style is a, b, c or off");
    if (hdScale !== 0 && hdScale !== 2 && hdScale !== 4) pyExit("--hd-ui is 2 or 4");
    let game = values.game;
    const tool = values.ns;
    // (the install root or the game folder itself: C:\Games\THUG2 -> C:\Games\THUG2\Game - tools/pipeline/lib/install.ts)
    game = resolveInstall(game, "thug2");
    const out = values.out || pyJoin(game, "thug2-decomp-data");
    if (!fs.existsSync(tool)) pyExit(nsMissing(tool));

    const pre = pyJoin(game, "Data", "pre");
    const qbScripts = pyJoin(pre, "qb_scripts.prx");
    const menuScripts = pyJoin(pre, "mainmenu_scripts.prx");

    // The folder is ours: emptied first (a file left from an earlier layout would still be read).
    const marker = path.join(out, MARKER);
    if (isDir(out)) {
        const ours = new Set([
            "scripts",
            "levels",
            "front_end",
            "models",
            "anims",
            "skeletons",
            "images",
            "fonts",
            "hd_ui",
            "frontend",
        ]);
        if (!fs.existsSync(marker) && !fs.readdirSync(out).every((name) => ours.has(name))) {
            pyExit(`${out} has files this tool didn't make: not emptying it`);
        }
        fs.rmSync(out, { recursive: true, force: true });
    }
    fs.mkdirSync(out, { recursive: true });
    writeTextPy(
        marker,
        "Made by tools/pipeline/menu_level/make_menu_level.ts from the game's files; emptied and made again on each run.\n",
    );

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"));
    try {
        const decompile: Decompile = (data, name) => {
            const file = path.join(work, name);
            fs.writeFileSync(file, data);
            ns(tool, "-d", file, "-o", `${file}.ns`);
            return readTextPy(`${file}.ns`);
        };
        const write: Write = (text, name) => {
            const file = path.join(work, `new_${name.replaceAll("\\", "_")}.ns`);
            writeTextPy(file, text);
            const target = pyJoin(out, name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            ns(tool, "-c", file, "-o", target, "-targetGame", "thug2");
            print("wrote", target);
        };

        const levels = decompile(prxFile(qbScripts, "scripts\\game\\levels.qb"), "Levels.qb");
        const shop = decompile(prxFile(menuScripts, "levels\\mainmenu\\mainmenu.qb"), "mainmenu.qb");
        const frontEnd = decompile(
            prxFile(menuScripts, "levels\\mainmenu\\mainmenu_scripts.qb"),
            "mainmenu_scripts.qb",
        );
        const select = decompile(prxFile(qbScripts, "scripts\\game\\menu\\gamemenu_levelselect.qb"), "levelselect.qb");
        const pause = decompile(prxFile(qbScripts, "scripts\\game\\menu\\gamemenu_pause.qb"), "pause.qb");

        // Always: the playable skate shop; and the converted levels when the converters have made them.
        const ported = portedLevels.loadManifest(game);

        // The ported levels' own games' loading pictures (loading_art.ts): images\loadscrn_<game>_<level>.img.xbx, named
        // in their loading_screen (so also in levels.json's art, and picked up by the --hd-ui loading screens).
        const loadingArt = ported
            ? loadingArtGames.buildArt(
                  loadingArtGames.findInstalls(loadingArtOverrides),
                  new Set(ported.levels.map((e) => `load_${portedLevels.loadOf(e)}`.toLowerCase())),
              )
            : null;
        if (loadingArt) {
            loadingArtGames.writeArt(out, loadingArt);
            for (const line of loadingArt.lines) print(`loading screens: ${line}`);
        }
        // The same pictures without their text for the new level select (frontend_art.ts): images\frontend_art_<game>_<level>
        // .img.xbx, named in levels.json's art only - Levels.qb's loading_screen keeps the original picture.
        const frontArt = ported
            ? frontendArt.buildFrontArt(
                  loadingArtGames.findInstalls(loadingArtOverrides),
                  new Set(ported.levels.map((e) => `load_${portedLevels.loadOf(e)}`.toLowerCase())),
              )
            : null;
        if (frontArt) {
            frontendArt.writeFrontArt(out, frontArt);
            for (const line of frontArt.lines) print(`front end art: ${line}`);
        }
        // The scenic art (scenic_art.ts): a filtered picture of the level itself, in place of the crop, for the levels
        // with a chosen capture in the cache; its HD version is made from the capture (kept out of the hd_ui upscaling).
        const frontArtMap = new Map(frontArt?.art ?? []);
        const scenicHd = new Map<string, Buffer>();
        if (ported && scenicStyle !== "off") {
            const loads = new Set(ported.levels.map((e) => `load_${portedLevels.loadOf(e)}`.toLowerCase()));
            for (const g of loadingArtGames.GAMES) {
                if (!fs.existsSync(scenicArt.spotsFile(g))) continue;
                const scenic = scenicArt.buildScenicArt(g, loads, scenicStyle as scenicArt.Style, (load) =>
                    frontendArt.frontArtName(g, load),
                );
                fs.mkdirSync(path.join(out, "images"), { recursive: true });
                for (const [name, data] of scenic.images)
                    fs.writeFileSync(path.join(out, "images", `${name}.img.xbx`), data);
                for (const [load, name] of scenic.art) frontArtMap.set(load, name);
                for (const [name, data] of scenic.hd) scenicHd.set(name, data);
                for (const line of scenic.lines) print(`scenic art: ${line}`);
            }
            // THUG2's own levels too (the front end's art only; the real loading screens stay THUG2's)
            if (fs.existsSync(scenicArt.spotsFile("thug2"))) {
                const scenic = scenicArt.buildScenicArt(
                    "thug2",
                    null,
                    scenicStyle as scenicArt.Style,
                    (load) => `frontend_art_thug2_${load.replace(/^load_/, "")}`,
                );
                fs.mkdirSync(path.join(out, "images"), { recursive: true });
                for (const [name, data] of scenic.images)
                    fs.writeFileSync(path.join(out, "images", `${name}.img.xbx`), data);
                for (const [load, name] of scenic.art) frontArtMap.set(load, name);
                for (const [name, data] of scenic.hd) scenicHd.set(name, data);
                for (const line of scenic.lines) print(`scenic art: ${line}`);
            }
        }
        const overlayLevels = (text: string): string => {
            text = addSkateshopLevel(text);
            text = ported ? portedLevels.addToLevels(text, ported) : text;
            return loadingArt ? loadingArtGames.applyLoadingScreens(text, loadingArt.art) : text;
        };
        const levelsWithShop = overlayLevels(levels);
        if (ported) {
            const installed = portedLevels.installFiles(game, out);
            print(
                `Converted levels (THPS4 / THUG1): ${ported.levels.length} added to the level select; copied ${installed.join(", ")}`,
            );
        }
        write(levelsWithShop, "scripts\\game\\Levels.qb");
        write(skateshopNodes(shop), "levels\\skateshop\\skateshop.qb");
        // The level select in sections, one per game, with stars and signs for our levels (level_select.ts).
        const byGame = new Map<string, portedLevels.Manifest>();
        for (const entry of ported?.levels ?? []) {
            const staging = String(entry.staging);
            let manifest = byGame.get(staging);
            if (manifest === undefined) {
                manifest = { levels: [] };
                byGame.set(staging, manifest);
            }
            manifest.levels.push(entry);
        }
        const sectionList = levelSelect.sections({
            thps4: byGame.get("thug2-decomp-thps4"),
            thug1: byGame.get("thug2-decomp-thug1"),
            thps3: byGame.get("thug2-decomp-thps3"),
            thps2: byGame.get("thug2-decomp-thps2"),
            thaw: byGame.get("thug2-decomp-thaw"),
            thp8: byGame.get("thug2-decomp-thp8"),
        });
        // Levels with no place get a map of themselves in place of the globe (a level not converted keeps the globe).
        const maps = levelMap.attachMaps(game, sectionList, print);
        const mapNames = levelMap.mapTextures(sectionList);

        const overlaySelect = (text: string): string =>
            levelSelect.editLevelSelect(dropUninstalledDefault(addSkateshopSign(text), game), sectionList);
        const overlaySprites = (text: string): string => levelSelect.editSprites(text, sectionList);
        const selectText = overlaySelect(select);
        write(selectText, "scripts\\game\\menu\\gamemenu_levelselect.qb");
        // The DLL's new front end ([features] new_frontend - src/game/front/new_frontend.h): the same sections as data.
        const feSections = frontendLevels.frontendSections(sectionList, selectText, levelsWithShop, frontArtMap);
        const feFile = pyJoin(out, frontendLevels.FRONTEND_LEVELS);
        fs.mkdirSync(path.dirname(feFile), { recursive: true });
        fs.writeFileSync(feFile, frontendLevels.frontendJson(feSections));
        print(`new front end: ${feFile} (${feSections.map((sec) => `${sec.tab} ${sec.levels.length}`).join(", ")})`);
        // (default: the design's OFL fonts in fonts/ - Anton, IBM Plex Mono / Sans; THIRD_PARTY_NOTICES.md)
        const defaultFonts = path.join(PIPELINE, "fonts");
        const fontSource = values["frontend-fonts"] ?? (fs.existsSync(defaultFonts) ? defaultFonts : undefined);
        if (fontSource) {
            const fontDir = pyJoin(out, "frontend", "fonts");
            fs.mkdirSync(fontDir, { recursive: true });
            const fonts = fs.readdirSync(fontSource).filter((name) => name.toLowerCase().endsWith(".ttf"));
            for (const name of fonts) fs.copyFileSync(path.join(fontSource, name), path.join(fontDir, name));
            print(`new front end fonts: ${fonts.join(", ") || "none"} into ${fontDir}`);
        }
        const sprites = decompile(prxFile(qbScripts, "scripts\\game\\menu\\sprites.qb"), "sprites.qb");
        write(overlaySprites(sprites), "scripts\\game\\menu\\sprites.qb");
        const frame = prxFile(pyJoin(pre, "Levelselect.prx"), levelSelect.levelSelectIcons.FRAME_SOURCE);
        print(`level select signs: ${levelSelect.writeSigns(frame, sectionList, out).join(", ")}`);
        print(`level select maps: ${levelMap.writeMaps(out, maps, mapNames).join(", ")}`);
        print(levelSelect.describe(sectionList));
        const testlevel = decompile(
            prxFile(pyJoin(pre, "TestLevel_scripts.prx"), "levels\\testlevel\\testlevel.qb"),
            "TestLevel.qb",
        );
        write(testlevelNodes(testlevel), "levels\\TestLevel\\TestLevel.qb");
        // Always: the pause menu's LEVEL EDITOR (the DLL's [features] level_editor decides whether it shows) and the
        // new front end's items (its [features] new_frontend).
        // (and THAW's BMX's RIDE BMX when its staging folder is there - tools/pipeline/thaw_bmx/install.ts)
        write(
            thawBmxInstall.addPauseItem(addNewFrontendPause(addLevelEditor(pause)), game),
            "scripts\\game\\menu\\gamemenu_pause.qb",
        );
        // Always: the skate shop's menu with the new front end's Play Level (its [features] new_frontend).
        write(
            addNewFrontendSkateshop(decompile(prxFile(qbScripts, "scripts\\game\\menu\\skateshop.qb"), "skateshop.qb")),
            "scripts\\game\\menu\\skateshop.qb",
        );
        // Always: GAME OPTIONS' CREATE 100% CAS (the DLL's [features] create_100_cas decides whether it shows).
        addCreate100Cas(decompile, write, pre, levels);
        // The ports' own people (tools/pipeline/level_port/ped_models.ts): their CAS parts and profiles added to THUG2's lists.
        const peds = pedModels.readAdditions(game);
        const pedEdits = new Map<string, (text: string) => string>();
        if (!pedModels.empty(peds)) {
            pedEdits.set("scripts\\cas_ped_m.qb", pedModels.casEdit(peds, "cas_ped_m"));
            pedEdits.set("scripts\\cas_ped_f.qb", pedModels.casEdit(peds, "cas_ped_f"));
            pedEdits.set("scripts\\profile_ped.qb", pedModels.profileEdit(peds));
            for (const [file, edit] of pedEdits) {
                write(edit(decompile(prxFile(qbScripts, file), path.win32.basename(file))), file);
            }
            const parts = Object.values(peds.cas).reduce((n, e) => n + e.length, 0);
            print(`ported levels' own people: ${peds.profiles.length} profiles, ${parts} CAS parts added`);
        }

        // THAW's BMX (tools/pipeline/thaw_bmx/convert.ts): its bike, skeleton, animations and scripts, when the game has the
        // converter's staging folder.
        const bmx = thawBmxInstall.installFiles(game, out);
        if (bmx.length) {
            print(`THAW's BMX: copied ${bmx.join(", ")}`);
            // (its scripts after the game's special items: the details structure, the animation load scripts)
            const added = thawBmxInstall.specialItemsAddition(game) ?? "";
            const items = decompile(prxFile(qbScripts, thawBmxInstall.SPECIAL_ITEMS), "specialitems.qb");
            write(`${items}\n${added}`, thawBmxInstall.SPECIAL_ITEMS);
        }

        // The standard main menu, for the front end in THPS4's skate shop (the DLL uses front_end\ while
        // menu_backdrop is on and the shop is installed).
        const backdrop = !!ported && ported.levels.some((level) => level.level === BACKDROP_LEVEL);
        if (backdrop) {
            const archived = new PrxScripts([prxFiles(qbScripts), prxFiles(menuScripts)], tool, work);
            write(frontEndScripts(frontEnd, archived), "front_end\\levels\\mainmenu\\mainmenu_scripts.qb");
            const roundbar = decompile(prxFile(qbScripts, "scripts\\game\\menu\\roundbarmenu.qb"), "roundbarmenu.qb");
            write(frontEndRoundbar(roundbar), "front_end\\scripts\\game\\menu\\roundbarmenu.qb");
            // (the nodes' shared fields put back in each node: the front end takes the shop's nodes by their Class -
            // tools/pipeline/thps4_levels' PC-THPS4-14 shares them, nodes.shareNodeFields)
            const backdropNodes = decompile(
                levelPortNodes.unshareNodeFields(
                    fs.readFileSync(path.join(out, "levels", BACKDROP_LEVEL, `${BACKDROP_LEVEL}.qb`)),
                    `${BACKDROP_LEVEL}_NodeArray`,
                    `${BACKDROP_LEVEL}.qb`,
                ),
                "backdrop.qb",
            );
            write(
                frontEndTriggers(
                    frontEndPedsCars(frontEndRails(frontEndNodes(shop, backdropNodes), backdropNodes), backdropNodes),
                    backdropNodes,
                ),
                "front_end\\levels\\mainmenu\\mainmenu.qb",
            );
            // THUG2's own shop's collision without its objects: the DLL hides THUG2's shop, but its collision stayed -
            // x -1372..764, z -1377..471 overlaps THPS4's outside halfpipe (x 465..1155): invisible walls after SKATE
            // NOW. The front end's skater stands in THPS4's shop (its collision: mainmenu_startup's LoadCollision).
            const target = pyJoin(out, "front_end", "levels", "mainmenu", "mainmenu.col.xbx");
            fs.writeFileSync(target, thug2Col.writeCol({ objects: [], pad: 0 }));
            print("wrote", target);
        } else {
            print(
                `${BACKDROP_LEVEL} not converted (tools/pipeline/thps4_levels): no front end backdrop, the game's main menu kept`,
            );
        }

        // Anteara Mod (tools/anteara; the DLL reads anteara\ first while [features] anteara_mod=1): its script
        // set, with the edits above re-applied to the files it also changes or this overlay changes. (With THUG1's
        // drivable cars installed - PC-THUG1-22, tools/pipeline/thug1_levels/driving.ts - the mod's car_scripts.qb, THUG1's
        // unchanged, gets their THUG2 edits too: unchanged it hangs THUG1 Vancouver loading. Its own
        // player_controlled_vehicle.qb already has the Motion component.)
        const thug1Driving = fs.existsSync(path.join(game, "thug2-decomp-thug1", ...CAR_SCRIPTS.split("\\")));
        const anteara = await loadAnteara();
        if (!anteara) {
            fs.rmSync(pyJoin(out, "anteara"), { recursive: true, force: true });
            print(`Anteara Mod: not found (${ANTEARA_CANDIDATES.join(" / ")}) - skipped, no anteara\\ in the overlay`);
        } else
            print(
                anteara.install(
                    game,
                    out,
                    tool,
                    new Map([
                        ["scripts\\game\\levels.qb", overlayLevels],
                        ["scripts\\game\\menu\\gamemenu_levelselect.qb", overlaySelect],
                        ["scripts\\game\\menu\\sprites.qb", overlaySprites],
                        [
                            "scripts\\game\\menu\\gamemenu_pause.qb",
                            (text: string) => addNewFrontendPause(addLevelEditor(text)),
                        ],
                        ["scripts\\game\\menu\\skateshop.qb", addNewFrontendSkateshop],
                        ...pedEdits,
                        ...(thug1Driving
                            ? [
                                  [
                                      CAR_SCRIPTS,
                                      (text: string) => applyTextEdits(text, DRIVING_EDITS[CAR_SCRIPTS]!, CAR_SCRIPTS),
                                  ] as const,
                              ]
                            : []),
                    ]),
                    backdrop ? new Map([["scripts\\game\\menu\\roundbarmenu.qb", frontEndRoundbar]]) : new Map(),
                    values.thug1, // (the mod's vehicle scripts are made from THUG1's; default C:\Games\THUG1)
                ) ?? "Anteara Mod: the game has no Data\\scripts\\qdir.txt - not installed",
            );

        // THUGPRO's changes to THUG2's own levels that the user switched on (tools/pipeline/thug2_levels, register TP-42 -
        // tools/pipeline/compat/thugpro/thug2_levels.json; none by default): their changed level files into this overlay.
        for (const line of thug2Levels.installEnabled(game, out)) print(line);

        // Last (the level select's signs written above are upscaled too): the menus' images and fonts, with --hd-ui.
        if (hdScale) {
            const options = hdUi.uiOptions(hdScale);
            if (values["hd-ui-model"]) options.model = values["hd-ui-model"];
            for (const line of hdUi.install(
                game,
                out,
                options,
                undefined,
                values["hd-ui-loading-model"],
                values["hd-ui-globe-ai"] ? "ai" : "redraw",
                // (and the scenic art's own HD pictures; at --hd-ui 2 they are still the x4 ones: the front end takes any size)
                new Map([...levelMap.hdMapFiles(maps, mapNames, hdScale), ...scenicHd]),
            ))
                print(line);
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
