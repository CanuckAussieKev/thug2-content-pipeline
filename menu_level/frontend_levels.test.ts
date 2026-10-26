// NOT ORIGINAL - unit tests of frontend_levels.ts (the new front end's levels.json), on small NeverScript texts.

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { arrayEntries, field, frontendJson, frontendSections, hasFlag, loadingScreens } from "./frontend_levels.ts";
import type { Section } from "./level_select.ts";

const SELECT = `
level_select_menu_thps3_level_info = [
    {text="FOUNDRY" level_num=60 num_goals=0 flag=LEVEL_UNLOCKED_TR seen_flag=LEVEL_UNLOCKED_TR level=Load_thps3_foundry sign_texture=sign_foundry dot_pos=(1.0, 2.0) game_tag="THPS3"}
    {text="RIO" level_num=61 num_goals=0 flag=LEVEL_UNLOCKED_TR level=Load_thps3_rio sign_texture=sign_rio}
]
level_select_menu_level_info = [
    {text="TRAINING" level_num=LevelNum_TR level_prefix="TR" num_goals=0 flag=LEVEL_UNLOCKED_TR seen_flag=LEVEL_SEEN_TR level=load_TR sign_texture=sign_training dot_pos=(89.0, 82.0)}
    {text="SCHOOL" level_num=LevelNum_SC num_goals=0 flag=LEVEL_UNLOCKED_SC seen_flag=LEVEL_SEEN_SC hide_when_locked level=load_sc sign_texture=sign_school}
]
level_select_menu_empty_level_info = [
]
`;

const LEVELS = `
script Load_TR {
    load_level Level_TR
}
Level_TR = {
    structure_name=Level_TR
    load_script=Load_TR
    name="Training"
    loading_screen="loadscrn_training"
    lighting={ a=1 }
}
Level_SC = {
    load_script=Load_SC
    loading_screen="loadscrn_school"
}
Level_thps3_foundry = {
    load_script=Load_thps3_foundry
    loading_screen="loadscrn_generic"
}
`;

test("arrayEntries / field / hasFlag read a level select array", () => {
    const entries = arrayEntries(SELECT, "level_select_menu_level_info")!;
    assert.equal(entries.length, 2);
    assert.equal(field(entries[0]!, "text"), "TRAINING");
    assert.equal(field(entries[0]!, "level"), "load_TR");
    assert.equal(field(entries[0]!, "flag"), "LEVEL_UNLOCKED_TR"); // (not seen_flag)
    assert.equal(field(entries[0]!, "level_num"), "LevelNum_TR");
    assert.equal(hasFlag(entries[1]!, "hide_when_locked"), true);
    assert.equal(hasFlag(entries[0]!, "hide_when_locked"), false);
    assert.deepEqual(arrayEntries(SELECT, "level_select_menu_empty_level_info"), []);
    assert.equal(arrayEntries(SELECT, "nothing_here"), null);
});

test("loadingScreens maps each load script to its structure's loading screen", () => {
    const screens = loadingScreens(LEVELS);
    assert.equal(screens.get("load_tr"), "loadscrn_training");
    assert.equal(screens.get("load_sc"), "loadscrn_school");
    assert.equal(screens.get("load_thps3_foundry"), "loadscrn_generic");
    assert.equal(screens.size, 3);
});

test("frontendSections: the sections' levels, art, generic art in turn, empty sections dropped", () => {
    const list: Section[] = [
        ["thug2", "TONY HAWK'S UNDERGROUND 2", "level_select_menu_level_info", null],
        ["thps3", "TONY HAWK'S PRO SKATER 3", "level_select_menu_thps3_level_info", []],
        ["misc", "MISCELLANEOUS", "level_select_menu_empty_level_info", []],
    ];
    const sections = frontendSections(list, SELECT, LEVELS);
    assert.equal(sections.length, 2);
    const [thug2, thps3] = sections;
    assert.equal(thug2!.tab, "THUG2");
    assert.equal(thug2!.colour, "#A48BFF");
    assert.deepEqual(thug2!.levels[0], {
        name: "TRAINING",
        load: "load_TR",
        art: "loadscrn_training",
        level_num: "LevelNum_TR",
        flag: "LEVEL_UNLOCKED_TR",
        seen_flag: "LEVEL_SEEN_TR",
    });
    assert.equal(thug2!.levels[1]!.hide_when_locked, true);
    assert.equal(thug2!.levels[1]!.seen_flag, "LEVEL_SEEN_SC");
    assert.equal(thps3!.tab, "THPS3");
    assert.equal(thps3!.levels[0]!.art, "loadscrn_generic_1");
    assert.equal(thps3!.levels[0]!.generic_art, true);
    assert.equal(thps3!.levels[0]!.level_num, 60);
    assert.equal(thps3!.levels[0]!.game_tag, "THPS3");
    // (no structure: the generic art too, the next one)
    assert.equal(thps3!.levels[1]!.art, "loadscrn_generic_2");
    const json = JSON.parse(frontendJson(sections));
    assert.equal(json.version, 1);
    assert.equal(json.sections.length, 2);
    assert.equal(typeof json.menu_art.career, "string");
});

test("frontendSections throws on a missing array", () => {
    assert.throws(() => frontendSections([["x", "X", "missing_array", null]], SELECT, LEVELS));
});
