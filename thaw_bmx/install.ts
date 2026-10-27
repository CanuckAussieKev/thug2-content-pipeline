// NOT ORIGINAL - puts the THAW BMX converter's staging folder (<game>\thug2-decomp-thaw-bmx, tools/pipeline/thaw_bmx/convert.ts)
// into the data overlay (tools/pipeline/menu_level/make_menu_level.ts calls this): models, anims, skeletons, sounds and images merged in (new
// files only - they are named so as not to collide with the game's), the manifest as thaw_bmx.json, and the scripts
// (scripts\thaw_bmx\thaw_bmx.ns: the animation load scripts, the special item's structure, the test scripts) appended to
// the overlay's copy of scripts\game\skater\specialitems.qb - a file the game loads at start-up, so they exist in every
// level (a separate qb would need a LoadQB from somewhere).

import * as fs from "node:fs";
import * as path from "node:path";

export const STAGING = "thug2-decomp-thaw-bmx";
export const MANIFEST = "thaw_bmx.json";
export const SCRIPTS = "scripts\\thaw_bmx\\thaw_bmx.ns";
export const SPECIAL_ITEMS = "scripts\\game\\skater\\specialitems.qb";

// What was copied ("models", ..., "thaw_bmx.json"); empty when the game has no staging folder.
export function installFiles(game: string, overlay: string): string[] {
    const staging = path.join(game, STAGING);
    if (!fs.existsSync(path.join(staging, MANIFEST))) return [];
    const done: string[] = [];
    for (const folder of ["models", "anims", "skeletons", "sounds", "images"]) {
        const from = path.join(staging, folder);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(overlay, folder), { recursive: true, preserveTimestamps: true, force: true });
        done.push(folder);
    }
    fs.copyFileSync(path.join(staging, MANIFEST), path.join(overlay, MANIFEST));
    done.push(MANIFEST);
    return done;
}

// The scripts to append to specialitems.qb (NeverScript text), or null when the game has no staging folder.
export function specialItemsAddition(game: string): string | null {
    const file = path.join(game, STAGING, SCRIPTS);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

// The pause menu's RIDE BMX / GET OFF BMX (phase 2: src/game/skater/thaw_bmx.h), after its LEVEL EDITOR item
// (make_menu_level's addLevelEditor) - when the game has the staging folder. Shown while ThawBmx_Available (the DLL's
// [features] thaw_bmx, and the scripts there); IsSkaterOnBike is only asked then (a member function the DLL registers
// only while the feature is on: an unregistered one after `skater:` would crash the script runtime).
export function addPauseItem(text: string, game: string): string {
    if (!fs.existsSync(path.join(game, STAGING, MANIFEST))) return text;
    const at = text.search(/\n( *)if LevelEditor_Available \{\n/);
    if (at < 0) throw new Error("gamemenu_pause.qb: the LEVEL EDITOR item not found");
    const indent = /\n( *)if/.exec(text.slice(at))![1]!;
    const close = text.indexOf(`\n${indent}} \n`, at + 1);
    if (close < 0) throw new Error("gamemenu_pause.qb: the end of the LEVEL EDITOR item not found");
    const end = close + `\n${indent}} \n`.length;
    const item = (label: string): string =>
        `${indent}        add_roundbar_menu_item text="${label}" id=menu_thaw_bmx pad_choose_script=thaw_bmx_pause_toggle \n`;
    const block =
        `${indent}if ThawBmx_Available {\n${indent}    if skater:IsSkaterOnBike {\n${item("GET OFF BMX")}` +
        `${indent}    } else {\n${item("RIDE BMX")}${indent}    } \n${indent}} \n`;
    return text.slice(0, end) + block + text.slice(end);
}
