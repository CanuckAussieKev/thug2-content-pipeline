// NOT ORIGINAL - unit tests of tools/pipeline/menu_level's and tools/anteara's pure functions (no game data): the values are
// what their Python twins gave.

import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Manifest } from "thug2-level-converter-core/level_port/ported_levels.ts";
import { unswizzleOrder } from "thug2-level-converter-core/level_port/tex.ts";
import * as compat from "thug2-thugpro-compat/profile.ts";
import { nsString } from "./career_complete.ts";
import { addDemoMenu } from "./demo_menu.ts";
import {
    type Level,
    mapPosition,
    otherGame,
    sections,
    signEntry,
    THAW_LEVELS,
    THP8_LEVELS,
    THPG_LEVELS,
    THPS3_LEVELS,
    THPS4_LEVELS,
    THUG1_LEVELS,
    THUG2_EXTRA,
    thawPositionScaleFlags,
} from "./level_select.ts";
import { coverage, PICTOGRAMS, readImg, strayInk, writeImg } from "./level_select_icons.ts";
import { parseArguments, skipStatement } from "./qb_walk.ts";

test("mapPosition puts places where THUG2's stars are", () => {
    assert.deepEqual(mapPosition(-118.24, 34.05), [77.8, 101.8]);
    assert.deepEqual(mapPosition(-0.128, 51.507), [223.0, 69.3]);
    assert.deepEqual(mapPosition(144.96, -37.8), [426.0, 194.0]);
});

const compatNone = compat.load("none");

test("THUGPRO's big level (TP-R6) is flagged in its level select entry", () => {
    const manifest = {
        levels: [
            {
                folder: "Z_MA",
                level: "z_ma",
                display: "THAW The Mall",
                name: "z_ma",
                level_num: 1,
            },
            {
                folder: "Z_CH",
                level: "skatepark",
                display: "THAW Chicago",
                name: "skatepark",
                level_num: 2,
            },
        ],
    } as unknown as Manifest;
    const level = (load: string): Level => ({
        text: load,
        levelNum: 1,
        load,
        icon: "cart",
        sign: "sign_x",
        place: "",
        location: null,
    });
    const flagged = thawPositionScaleFlags(manifest, [level("Load_z_ma"), level("Load_skatepark")]);
    assert.deepEqual(flagged[0]!.flags, ["IsBigLevel"]);
    assert.equal(flagged[1]!.flags, undefined);
    assert.match(signEntry(flagged[0]!), / IsBigLevel\} \n$/);
    assert.equal(thawPositionScaleFlags(manifest, [level("Load_z_ma")], compatNone)[0]!.flags, undefined);
});

test("qb_walk reads a call's arguments to the end of the line", () => {
    // name=5 then an end of line
    const d = Buffer.from([0x16, 1, 0, 0, 0, 0x07, 0x17, 5, 0, 0, 0, 0x01]);
    const [params, end] = parseArguments(d, 0, null);
    assert.equal(end, 11);
    assert.deepEqual([...params], [[1, 5]]);
    assert.equal(skipStatement(d, 0), 12);
});

test("gap names pass only as plain ASCII", () => {
    assert.equal(nsString("a\\b"), "a\\\\b");
    assert.throws(() => nsString('say "hi"'));
    assert.throws(() => nsString("café"));
});

test("every level we add has a pictogram of its own, and every pictogram stays inside the sign's diamond", () => {
    const icons = [
        ...[...THUG2_EXTRA.values()].map((e) => e.icon),
        ...[THUG1_LEVELS, THPS4_LEVELS, THPS3_LEVELS, THAW_LEVELS, THP8_LEVELS, THPG_LEVELS].flatMap((table) =>
            [...table.values()].map((e) => e.icon!),
        ),
    ];
    for (const icon of icons) assert.ok(PICTOGRAMS.has(icon), `${icon}: no such pictogram`);
    const seen = new Set<string>();
    for (const icon of icons) {
        assert.ok(!seen.has(icon), `${icon}: on two levels' signs`);
        seen.add(icon);
    }
    for (const [name, draw] of PICTOGRAMS) {
        const layers = draw();
        assert.deepEqual(strayInk(layers).length, 0, `${name}: ink outside the diamond's inside`);
        const ink = coverage(layers).reduce((a, b) => a + b, 0);
        assert.ok(ink > 120, `${name}: hardly any ink (${ink})`);
    }
});

test("a sign written upright is stored the way the game draws THUG2's own: bottom-up in unswizzleOrder", () => {
    // (found in the game: the level select showed our signs upside down while THUG2's own were upright)
    const w = 8;
    const h = 8;
    const palette: [number, number, number, number][] = [[0, 0, 0, 255]];
    const indices = new Array<number>(w * h).fill(0);
    indices[1 * w + 2] = 1; // a mark near the top left (x 2, y 1)
    indices[6 * w + 5] = 2; // another near the bottom right
    const data = writeImg(w, h, palette, indices);
    const stored = data.subarray(data.length - w * h);
    const order = unswizzleOrder(w, h);
    // the game's read order: row 0 of unswizzleOrder is the BOTTOM row of the picture
    assert.equal(stored[order[(h - 1 - 1) * w + 2]!], 1);
    assert.equal(stored[order[(h - 1 - 6) * w + 5]!], 2);
    assert.notEqual(stored[order[1 * w + 2]!], 1);
    // and reading gives the upright picture back
    assert.deepEqual(readImg(data).indices, indices);
});

test("the skate shops, tutorials and test levels are in a last MISCELLANEOUS section, THP8 right after THAW", () => {
    const level = (folder: string, display: string, level_num: number) => ({
        folder,
        level: folder.toLowerCase(),
        display,
        name: folder.toLowerCase(),
        level_num,
    });
    const manifest = (...levels: ReturnType<typeof level>[]) => ({ levels }) as unknown as Manifest;
    const list = sections({
        thps3: manifest(
            level("Foun", "THPS3 Foundry", 70),
            level("SkateShop", "THPS3 Skate Shop", 73),
            level("Tut", "THPS3 Tutorials", 72),
        ),
        thps4: manifest(level("SkateShop", "THPS4 Skateshop", 29), level("Motox", "THPS4 Motox", 31)),
        thug1: manifest(level("NJ_Skateshop", "THUG1 Skateshop", 55)),
        thaw: manifest(level("Z_CH", "THAW Chicago", 90)),
        thp8: manifest(level("z_bedroom", "THP8 Bedroom", 100), level("net_skatepark", "THP8 Skate Park", 101)),
    });
    // (THUG1 and THPS4 had only misc levels: their sections are gone)
    assert.deepEqual(
        list.map((s) => s[0]),
        ["thug2", "thps3", "thaw", "thp8", "misc"],
    );
    assert.deepEqual(
        list[1]![3]!.map((lv) => lv.text),
        ["FOUNDRY"],
    );
    const misc = list[4]![3]!;
    assert.deepEqual(
        misc.map((lv) => lv.text),
        [
            "THUG2 SKATE SHOP",
            "THUG2 TEST LEVEL",
            "P8 BEDROOM",
            "THPS3 SKATE SHOP",
            "THPS3 TUTORIALS",
            "THPS4 MOTOX",
            "THPS4 SKATE SHOP",
            "THUG SKATE SHOP",
        ],
    );
    assert.equal(new Set(misc.map((lv) => lv.levelNum)).size, 8);
    assert.match(signEntry(misc[3]!), / game_tag="THPS3"\} \n$/);
    assert.deepEqual(
        sections({}).map((s) => s[0]),
        ["thug2", "misc"],
    );
});

test("another converter's levels get a section of their own, after this project's games, titled by its levels.json", () => {
    const manifest = {
        levels: [
            {
                folder: "Ware",
                level: "thps1_ware",
                display: "THPS1 Warehouse",
                name: "ware",
                game: "THPS1",
                level_num: 900,
            },
        ],
    } as unknown as Manifest;
    const other = otherGame("thug2-decomp-thps1", manifest, "Tony Hawk's Pro Skater");
    assert.deepEqual([other.key, other.title, other.prefix], ["x_thps1", "TONY HAWK'S PRO SKATER", "THPS1"]);
    assert.equal(otherGame("thug2-decomp-my-game", manifest).title, "MY-GAME LEVELS");
    assert.equal(otherGame("thug2-decomp-my-game", manifest).key, "x_my_game");
    const list = sections({}, [other]);
    assert.deepEqual(
        list.map((s) => s[0]),
        ["thug2", "x_thps1", "misc"],
    );
    assert.equal(list[1]![2], "level_select_menu_x_thps1_level_info");
    assert.deepEqual(
        list[1]![3]!.map((lv) => [lv.text, lv.levelNum, lv.load]),
        [["Warehouse", 900, "Load_thps1_ware"]],
    );
});

test("addDemoMenu: DEMOS / STOP RECORDING before DEBUG OPTIONS, the menus' scripts before the checksums", () => {
    const pause =
        "script create_pause_menu {\n    if ! InNetGame {\n" +
        '        add_roundbar_menu_item text="YOUR OPTIONS" id=menu_your_options pad_choose_script=create_your_options_menu \n' +
        "        if ! CD {\n" +
        '            add_roundbar_menu_item text="DEBUG OPTIONS" id=menu_debug_options pad_choose_script=create_debug_options_menu \n' +
        "        } \n    } \n} \n__register_checksums__ a b\n";
    const out = addDemoMenu(pause);
    const demos = out.indexOf('text="DEMOS"');
    const stop = out.indexOf('text="STOP RECORDING"');
    const debug = out.indexOf('text="DEBUG OPTIONS"');
    assert.ok(out.indexOf('text="YOUR OPTIONS"') < stop && stop < demos && demos < debug);
    assert.match(out, /if Demo_Item item=recording \{/);
    assert.ok(out.indexOf("script demo_list_create {") > out.indexOf("script create_pause_menu {"));
    assert.ok(out.indexOf("script demo_menu_create {") < out.indexOf("__register_checksums__"));
});
