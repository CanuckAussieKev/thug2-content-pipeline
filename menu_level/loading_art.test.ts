// NOT ORIGINAL - unit tests of loading_art.ts / loading_art_games.ts (the ported levels' own loading pictures): the
// readers on small synthetic files, the THUG2 loading screen writer, the card composition, the table and the
// Levels.qb edit. (The pictures themselves come from the user's installs: `loading_art_games.ts check`.)

import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as dxt from "../level_port/dxt.ts";
import { frontendSections, loadingScreens } from "./frontend_levels.ts";
import type { Section } from "./level_select.ts";
import {
    composeCard,
    nativeImg,
    type Picture,
    readBmp8,
    readImg,
    readWpcImg,
    readXenImg,
    resize,
    SCREEN_H,
    SCREEN_W,
} from "./loading_art.ts";
import { ART, applyLoadingScreens, artName, GAMES } from "./loading_art_games.ts";

// A picture whose pixel (x, y) is (x, y, 7, 255).
function gradient(w: number, h: number): Picture {
    const bgra = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bgra.set([x, y, 7, 255], (y * w + x) * 4);
    return { width: w, height: h, bgra };
}

test("nativeImg writes THUG2's loading screen layout (bottom-up rows) that readImg reads back", () => {
    const picture = gradient(8, 6);
    const data = nativeImg(picture);
    assert.equal(data.length, 32 + 8 * 6 * 4);
    assert.equal(data.readUInt32LE(0), 2);
    assert.equal(data.readUInt32LE(8), 8);
    assert.equal(data.readUInt32LE(12), 6);
    assert.equal(data.readUInt32LE(16), 0); // (format 0: 32-bit)
    assert.equal(data.readUInt16LE(24), 8);
    assert.equal(data.readUInt16LE(26), 6);
    // the first stored row is the picture's last
    assert.deepEqual([...data.subarray(32, 36)], [0, 5, 7, 255]);
    const back = readImg(data);
    assert.deepEqual(back.bgra, picture.bgra);
});

test("nativeImg makes the alpha opaque", () => {
    const picture = gradient(4, 4);
    picture.bgra[3] = 0;
    assert.equal(nativeImg(picture)[32 + 3 * 4 * 4 + 3], 255);
});

test("resize keeps the size it is asked for, averages going down and keeps colours going up", () => {
    const flat = { width: 4, height: 4, bgra: Buffer.alloc(64, 100) };
    const down = resize(flat, 2, 2);
    assert.equal(down.width, 2);
    assert.deepEqual([...down.bgra], new Array(16).fill(100));
    const up = resize(flat, 9, 7);
    assert.equal(up.bgra.length, 9 * 7 * 4);
    assert.ok(up.bgra.every((v) => v === 100));
    const same = gradient(5, 5);
    assert.equal(resize(same, 5, 5), same);
    // the stretch THPS2's 512 x 240 takes to 640 x 448
    const wide = resize(gradient(512, 240), SCREEN_W, SCREEN_H);
    assert.equal(wide.bgra.length, SCREEN_W * SCREEN_H * 4);
});

test("readWpcImg reads THAW's 28 byte header and flips the rows to top-down", () => {
    const w = 3;
    const h = 2;
    const data = Buffer.alloc(28 + w * h * 4);
    data.writeUInt32LE(0xabadd00d, 0);
    data.writeUInt16LE(w, 12);
    data.writeUInt16LE(h, 14);
    // stored: row 0 = 1s, row 1 = 2s (bottom-up: the picture's last row first)
    data.fill(1, 28, 28 + w * 4);
    data.fill(2, 28 + w * 4);
    const picture = readWpcImg(data);
    assert.equal(picture.width, w);
    assert.equal(picture.bgra[0], 2);
    assert.equal(picture.bgra[w * 4], 1);
    assert.throws(() => readWpcImg(Buffer.alloc(40)), /not a THAW image/);
});

test("readBmp8 reads an uncompressed 8-bit BMP, bottom-up rows with a padded stride", () => {
    const w = 3;
    const h = 2;
    const stride = 4;
    const data = Buffer.alloc(54 + 1024 + stride * h);
    data.write("BM", 0, "latin1");
    data.writeUInt32LE(54 + 1024, 10);
    data.writeUInt32LE(40, 14);
    data.writeInt32LE(w, 18);
    data.writeInt32LE(h, 22);
    data.writeUInt16LE(8, 28);
    data.writeUInt32LE(256, 46);
    data.set([10, 20, 30, 0], 54 + 1 * 4); // palette 1 = B 10 G 20 R 30
    data.set([40, 50, 60, 0], 54 + 2 * 4);
    // bottom row first: indices 1 1 1 / top row: 2 2 2
    data.set([1, 1, 1, 0, 2, 2, 2, 0], 54 + 1024);
    const picture = readBmp8(data);
    assert.deepEqual([...picture.bgra.subarray(0, 4)], [40, 50, 60, 255]); // (the top row)
    assert.deepEqual([...picture.bgra.subarray(w * 4, w * 4 + 4)], [10, 20, 30, 255]);
});

// A THP8 .img: header words and the blocks of a width x height picture, 16-bit byte swapped, rows padded to 32 blocks.
function xenImage(width: number, height: number, bgra: Buffer, kind: 1 | 5): Buffer {
    const blocks = dxt.encode(bgra, width, height, kind === 5 ? 5 : 1);
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    const bpb = kind === 5 ? 16 : 8;
    const pitch = (bw + 31) & ~31;
    const data = Buffer.alloc(4096 + pitch * bh * bpb);
    data.writeUInt32BE(0x0a281100, 0);
    data.writeUInt32BE(0x00010000 | width, 12);
    data.writeUInt32BE((height << 16) | 1, 16);
    data.writeUInt32BE(0x01000000 | (kind << 8), 20);
    for (let y = 0; y < bh; y++) blocks.copy(data, 4096 + y * pitch * bpb, y * bw * bpb, (y + 1) * bw * bpb);
    const swapped = Buffer.from(data.subarray(4096));
    swapped.swap16();
    swapped.copy(data, 4096);
    return data;
}

test("readXenImg reads THP8's linear, 16-bit swapped DXT pictures (DXT5 and DXT1)", () => {
    const w = 20;
    const h = 12;
    const bgra = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) bgra.set([200, 40, 90, 255], i * 4);
    for (const kind of [5, 1] as const) {
        const picture = readXenImg(xenImage(w, h, bgra, kind));
        assert.equal(picture.width, w);
        assert.equal(picture.height, h);
        for (const c of [0, 1, 2])
            assert.ok(Math.abs(picture.bgra[(5 * w + 7) * 4 + c]! - bgra[c]!) < 12, `kind ${kind}`);
    }
    assert.throws(() => readXenImg(Buffer.alloc(8192)), /not a THP8 DXT image/);
});

test("composeCard fits the card's drawn part over the backdrop, its transparent edge showing the backdrop", () => {
    const card = { width: 40, height: 30, bgra: Buffer.alloc(40 * 30 * 4) };
    for (let y = 5; y < 25; y++) for (let x = 10; x < 30; x++) card.bgra.set([0, 0, 255, 255], (y * 40 + x) * 4); // red
    const backdrop = { width: 16, height: 9, bgra: Buffer.alloc(16 * 9 * 4) };
    for (let i = 0; i < 16 * 9; i++) backdrop.bgra.set([255, 0, 0, 255], i * 4); // blue
    const out = composeCard(card, backdrop);
    assert.equal(out.width, SCREEN_W);
    assert.equal(out.height, SCREEN_H);
    const at = (x: number, y: number): number[] => [
        ...out.bgra.subarray((y * SCREEN_W + x) * 4, (y * SCREEN_W + x) * 4 + 3),
    ];
    assert.deepEqual(at(0, 0), [255, 0, 0]); // the backdrop in the corner
    assert.deepEqual(at(SCREEN_W >> 1, SCREEN_H >> 1), [0, 0, 255]); // the card in the middle
    assert.throws(() => composeCard({ width: 2, height: 2, bgra: Buffer.alloc(16) }, backdrop), /nothing drawn/);
});

test("the table: lower case load scripts, no picture used under two names, art names that can't collide", () => {
    const seen = new Set<string>();
    for (const game of GAMES) {
        for (const [load, entry] of Object.entries(ART[game])) {
            assert.equal(load, load.toLowerCase());
            assert.match(load, /^load_/);
            assert.ok(entry.why.length > 10, `${load}: no evidence`);
            const name = artName(game, load);
            assert.match(name, /^loadscrn_[a-z0-9]+_[a-z0-9_]+$/);
            assert.ok(!seen.has(name), `${name} twice`);
            seen.add(name);
        }
    }
    // a load script is in one game's table only
    const loads = GAMES.flatMap((g) => Object.keys(ART[g]));
    assert.equal(new Set(loads).size, loads.length);
    // names that start with loadscrn: the HD pass (hd_textures/ui.ts) takes them as loading screens
    assert.equal(artName("thps3", "Load_foun"), "loadscrn_thps3_foun");
});

const LEVELS = `
Level_foun = {
    structure_name=Level_foun
    load_script=Load_foun
    name="Foundry"
    loading_screen="loadscrn_generic"
    loading_time=8.0
}
Level_thps3_skateshop = {
    load_script=Load_thps3_skateshop
    loading_screen="loadscrn_generic"
}
Level_TR = {
    load_script=Load_TR
    loading_screen="loadscrn_training"
}
`;

test("applyLoadingScreens sets the pictures of the levels that have one and nothing else", () => {
    const art = new Map([
        ["load_foun", "loadscrn_thps3_foun"],
        ["load_tr", "loadscrn_other"], // (THUG2's own level: its screen isn't generic, so it stays)
    ]);
    const out = applyLoadingScreens(LEVELS, art);
    const screens = loadingScreens(out);
    assert.equal(screens.get("load_foun"), "loadscrn_thps3_foun");
    assert.equal(screens.get("load_thps3_skateshop"), "loadscrn_generic");
    assert.equal(screens.get("load_tr"), "loadscrn_training");
    assert.equal(out.replace("loadscrn_thps3_foun", "loadscrn_generic"), LEVELS);
});

test("levels.json takes the pictures through Levels.qb: art names, not THUG2's generic ones", () => {
    const sections: Section[] = [
        ["thps3", "TONY HAWK'S PRO SKATER 3", "level_select_menu_thps3_level_info"],
    ] as unknown as Section[];
    const select = `
level_select_menu_thps3_level_info = [
    {text="FOUNDRY" level_num=60 num_goals=0 flag=LEVEL_UNLOCKED_TR level=Load_foun}
    {text="SKATE SHOP" level_num=61 num_goals=0 flag=LEVEL_UNLOCKED_TR level=Load_thps3_skateshop}
]
`;
    const patched = applyLoadingScreens(LEVELS, new Map([["load_foun", "loadscrn_thps3_foun"]]));
    const [section] = frontendSections(sections, select, patched);
    assert.equal(section!.levels[0]!.art, "loadscrn_thps3_foun");
    assert.equal(section!.levels[0]!.generic_art, undefined);
    // (a level without a picture of its own keeps THUG2's generic one)
    assert.equal(section!.levels[1]!.art, "loadscrn_generic_1");
    assert.equal(section!.levels[1]!.generic_art, true);
});
