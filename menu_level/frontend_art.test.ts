// NOT ORIGINAL - unit tests of frontend_art.ts (the new front end's text-free pictures): the table against the loading
// pictures' table, the crop and card photo helpers on small synthetic pictures, the names, and levels.json taking them
// while Levels.qb's loading_screen keeps the original picture. (The pictures come from the user's installs:
// `frontend_art.ts check`.)

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { FRONT, frontArtName } from "./frontend_art.ts";
import { frontendSections, loadingScreens } from "./frontend_levels.ts";
import type { Section } from "./level_select.ts";
import { cardPhoto, cropFraction, type Picture } from "./loading_art.ts";
import { ART, applyLoadingScreens, artName, GAMES } from "./loading_art_games.ts";

// A picture whose pixel (x, y) is (x, y, 7, 255).
function gradient(w: number, h: number): Picture {
    const bgra = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bgra.set([x & 255, y & 255, 7, 255], (y * w + x) * 4);
    return { width: w, height: h, bgra };
}

test("every level with a loading picture has a text-free variant, and no other level has", () => {
    for (const game of GAMES) assert.deepEqual(Object.keys(FRONT[game]).sort(), Object.keys(ART[game]).sort(), game);
});

test("every variant's crop is inside the picture and says why", () => {
    for (const game of GAMES) {
        for (const [load, variant] of Object.entries(FRONT[game])) {
            const [x, y, s] = variant.crop;
            assert.ok(s > 0 && s <= 1 && x >= 0 && y >= 0 && x + s <= 1.0001 && y + s <= 1.0001, `${game} ${load}`);
            assert.ok(variant.why.length > 10, `${game} ${load}: why`);
        }
    }
});

test("the variants' names differ from the loading pictures' and from each other", () => {
    const names = new Set<string>();
    for (const game of GAMES) {
        for (const load of Object.keys(FRONT[game])) {
            const name = frontArtName(game, load);
            assert.match(name, /^frontend_art_/);
            assert.notEqual(name, artName(game, load));
            assert.ok(!names.has(name), name);
            names.add(name);
        }
    }
    assert.equal(names.size, 80);
});

test("cropFraction takes the part asked for, scaled to the size asked for", () => {
    const picture = gradient(100, 50);
    const out = cropFraction(picture, 0.5, 0.2, 0.4, 40, 20);
    assert.equal(out.width, 40);
    assert.equal(out.height, 20);
    // (the crop is x 50..90, y 10..30: its top left pixel is the picture's (50, 10))
    assert.equal(out.bgra[0], 50);
    assert.equal(out.bgra[1], 10);
    // (a crop past the edge is moved inside)
    const edge = cropFraction(picture, 0.9, 0.9, 0.5, 50, 25);
    assert.equal(edge.bgra[0], 50);
    assert.equal(edge.bgra[1], 25);
});

test("cardPhoto leaves out the card's torn edge: only the opaque centre, in the aspect asked for", () => {
    // a 100 x 80 card: transparent outside, a ragged 3 pixel border of partly transparent pixels, then the photo (blue)
    const w = 100;
    const h = 80;
    const bgra = Buffer.alloc(w * h * 4);
    for (let y = 5; y < 75; y++)
        for (let x = 5; x < 95; x++) {
            const edge = x < 8 || x >= 92 || y < 8 || y >= 72;
            bgra.set(edge ? [0, 0, 0, 120] : [200, 10, 10, 255], (y * w + x) * 4);
        }
    const out = cardPhoto({ width: w, height: h, bgra }, 64, 48, 2);
    assert.equal(out.width, 64);
    assert.equal(out.height, 48);
    for (let i = 0; i < out.bgra.length; i += 4) {
        assert.deepEqual([...out.bgra.subarray(i, i + 4)], [200, 10, 10, 255]);
    }
    assert.throws(() => cardPhoto({ width: 4, height: 4, bgra: Buffer.alloc(64) }, 4, 3));
});

test("levels.json takes the text-free picture, Levels.qb's loading_screen keeps the original", () => {
    const levels = `
Level_Foundry = {
    name="Foundry"
    load_script=Load_foun
    loading_screen="loadscrn_generic"
}
`;
    const select = `
level_select_menu_thps3_level_info = [
    {text="FOUNDRY" level_num=60 num_goals=0 flag=LEVEL_UNLOCKED_TR level=Load_foun}
    {text="SKATE SHOP" level_num=61 num_goals=0 flag=LEVEL_UNLOCKED_TR level=Load_thps3_skateshop}
]
`;
    const sections = [
        ["thps3", "TONY HAWK'S PRO SKATER 3", "level_select_menu_thps3_level_info"],
    ] as unknown as Section[];
    const patched = applyLoadingScreens(levels, new Map([["load_foun", "loadscrn_thps3_foun"]]));
    assert.equal(loadingScreens(patched).get("load_foun"), "loadscrn_thps3_foun");
    const [section] = frontendSections(sections, select, patched, new Map([["load_foun", "frontend_art_thps3_foun"]]));
    assert.equal(section!.levels[0]!.art, "frontend_art_thps3_foun");
    assert.equal(section!.levels[0]!.generic_art, undefined);
    // (a level without a variant: as before)
    assert.equal(section!.levels[1]!.art, "loadscrn_generic_1");
});
