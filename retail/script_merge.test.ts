// NOT ORIGINAL - tests of the retail export's script merge (script_merge.ts, retail_levels.ts): our lines go in as
// insertions only, come out again from a file the user changed since (their changes kept), and anything that can't be
// told apart is refused.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LevelEntry } from "thug2-level-converter-core/level_port/ported_levels.ts";
import { body, withoutNames } from "./retail_export.ts";
import { isEmptyScript, levelSelectInsertions, levelsInsertion, signText } from "./retail_levels.ts";
import {
    applyInsertions,
    type Insertion,
    insertionsFrom,
    MergeError,
    recordInsertions,
    stripInsertions,
} from "./script_merge.ts";

const BASE = [
    "script a {",
    "    if (<n> = 1) {",
    "        return ",
    "    } ",
    "    x ",
    "} ",
    "script b {",
    "    if (<n> = 1) {",
    "        return ",
    "    } ",
    "    y ",
    "} ",
    "list = [",
    '    {text="ONE"} ',
    "] ",
    "__register_checksums__ a b list",
].join("\n");

// after `script a {` and `script b {` the same lines (as the level select's two info panel scripts), and two signs
function ours(text: string): Insertion[] {
    const skip = "    if (<n> = 100) {\n        return \n    } \n";
    return [
        { at: text.indexOf("    if (<n> = 1)"), text: skip },
        { at: text.indexOf("    if (<n> = 1)", text.indexOf("script b")), text: skip },
        { at: text.indexOf("] "), text: '    {text="OURS 1"} \n    {text="OURS 2"} \n' },
    ];
}

test("insertions come out again, leaving the text as it was", () => {
    const insertions = ours(BASE);
    const changed = applyInsertions(BASE, insertions);
    assert.ok(changed.includes('{text="OURS 2"}'));
    const records = recordInsertions(BASE, insertions);
    assert.equal(stripInsertions(changed, records), BASE);
});

test("the user's changes made since stay; ours go", () => {
    const insertions = ours(BASE);
    const records = recordInsertions(BASE, insertions);
    let changed = applyInsertions(BASE, insertions);
    // the user edits a line next to ours, adds a sign after ours and a script at the end
    changed = changed
        .replace("    x ", "    x_modded ")
        .replace('    {text="OURS 2"} \n', '    {text="OURS 2"} \n    {text="MINE"} \n');
    changed = changed.replace("__register", "script c {\n} \n__register");
    const stripped = stripInsertions(changed, records);
    assert.ok(!stripped.includes("OURS"));
    assert.ok(!stripped.includes("= 100"));
    assert.ok(stripped.includes("x_modded") && stripped.includes('{text="MINE"}') && stripped.includes("script c {"));
});

test("our lines changed or gone: refused", () => {
    const insertions = ours(BASE);
    const records = recordInsertions(BASE, insertions);
    const changed = applyInsertions(BASE, insertions).replace('{text="OURS 1"}', '{text="OURS 1 EDITED"}');
    assert.throws(() => stripInsertions(changed, records), MergeError);
});

test("our lines copied elsewhere by the user: still ours found by the lines around them", () => {
    const insertions = ours(BASE);
    const records = recordInsertions(BASE, insertions);
    const changed = applyInsertions(BASE, insertions).replace(
        "__register",
        '    {text="OURS 1"} \n    {text="OURS 2"} \n__register',
    );
    const stripped = stripInsertions(changed, records);
    assert.equal((stripped.match(/OURS 1/g) ?? []).length, 1);
});

test("the checksum list and the end of the file aren't part of a change", () => {
    assert.equal(body("a \n\n__register_checksums__ a b\n"), "a \n");
    assert.equal(
        withoutNames("x \n__register_checksums__ a Level_ours b", ["level_OURS"]),
        "x \n__register_checksums__ a b",
    );
});

const ENTRY: LevelEntry = {
    level: "thps2_hangar",
    display: 'THPS2 "HANGAR"',
    name: "Hangar",
    level_num: 100,
    default_stats: 6,
    lighting: {},
    icon: "sign_airport",
    staging: "thug2-decomp-thps2",
};

test("Levels.qb: the level structure with its archives and picture, before Load_TestLevel", () => {
    const levels = "script Load_TR {\n} \nscript Load_TestLevel {\n} \n__register_checksums__ x";
    const ins = levelsInsertion(levels, [ENTRY], new Map([["load_thps2_hangar", "loadscrn_x"]]), true);
    assert.equal(ins.at, levels.indexOf("script Load_TestLevel"));
    for (const line of [
        "script Load_thps2_hangar {",
        "Level_thps2_hangar = {",
        '    pre="thps2_hangar_scripts.pre" ',
        '    scnpre="thps2_hangarscn.pre" ',
        '    colpre="thps2_hangarcol.pre" ',
        '    loading_screen="loadscrn_x" ',
    ]) {
        assert.ok(ins.text.includes(`${line}\n`), line);
    }
    // (another level of that name already: refused)
    assert.throws(
        () => levelsInsertion(`${levels}\nLevel_thps2_hangar = {\n} \n`, [ENTRY], new Map(), true),
        MergeError,
    );
});

test("the level select: a sign in THUG2's level list, the info panel's returns", () => {
    const select = [
        "script level_select_info_add_gaps {",
        "    GetLevelGapTotals level=<level_num> ",
        "} ",
        "script level_select_info_add_highscore {",
        "} ",
        "level_select_menu_level_info = [",
        '    {text="TRAINING" level_num=LevelNum_TR} ',
        "] ",
        "",
    ].join("\n");
    const out = applyInsertions(select, levelSelectInsertions(select, [ENTRY]));
    assert.equal(
        signText(ENTRY),
        '    {text="THPS2 HANGAR" level_num=100 num_goals=0 flag=LEVEL_UNLOCKED_TR level=Load_thps2_hangar sign_texture=sign_airport dot_pos=(89.0, 82.0)} \n',
    );
    assert.ok(out.includes(`${signText(ENTRY)}] `));
    assert.equal((out.match(/if \(<level_num> = 100\)/g) ?? []).length, 2);
    assert.ok(out.indexOf("if (<level_num> = 100)") < out.indexOf("GetLevelGapTotals"));
    // (a sign picture THUG2 hasn't: training's)
    assert.ok(signText({ ...ENTRY, icon: "sign_mine" }).includes("sign_texture=sign_training"));
    assert.throws(() => levelSelectInsertions(out, [ENTRY]), MergeError); // (already there)
});

test("only THUG2's empty driving scripts are replaced", () => {
    assert.equal(isEmptyScript(Buffer.from([1, 0])), true);
    assert.equal(isEmptyScript(Buffer.from([1, 0x16, 1, 2, 3, 4, 0])), false);
});

test("another tool's edit that only adds lines becomes insertions; one that changes a line is refused", () => {
    const base = "list = [\n    {a} \n] \nx = 1 \n__register_checksums__ a\n";
    const added = "list = [\n    {a} \n    {b} \n] \nx = 1 \ny = 2 \n__register_checksums__ a\n";
    const insertions = insertionsFrom(base, added);
    assert.equal(insertions.length, 2);
    assert.equal(applyInsertions(base, insertions), added);
    assert.throws(() => insertionsFrom(base, base.replace("x = 1", "x = 3")), MergeError);
});
