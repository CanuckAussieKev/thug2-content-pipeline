// NOT ORIGINAL - unit tests of loading_select.ts (every level's loading screen = its level select picture).

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { nativeImg, type Picture, readImg } from "./loading_art.ts";
import {
    applySelectScreens,
    buildSelectScreens,
    composeSelectPicture,
    drawLoadingScreen,
    originalScreens,
    selectName,
} from "./loading_select.ts";

const LEVELS = `
Level_BO = {
    structure_name=Level_BO
    load_script=Load_BO
    loading_screen="loadscrn_boston"
    loading_time=12.4
}
Level_nj = {
    load_script=Load_nj
    loading_screen="loadscrn_generic"
}
Level_other = {
    load_script=Load_other
    loading_screen="loadscrn_other"
}
`;

function flat(w: number, h: number, bgr: [number, number, number]): Picture {
    const bgra = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) bgra.set([...bgr, 255], i * 4);
    return { width: w, height: h, bgra };
}

test("the new name keeps the original picture after the double underscore", () => {
    assert.equal(selectName("Load_BO", "loadscrn_boston"), "loadscrn_sel_load_bo__loadscrn_boston");
    assert.equal(selectName("load_nj", "loadscrn_generic").split("__")[1], "loadscrn_generic");
});

test("a 640 x 448 level select picture is cut to 640 x 360 from the middle, a 640 x 360 one is kept", () => {
    const tall = flat(640, 448, [1, 2, 3]);
    // (rows 44..403 are kept: mark the first kept row and the one before it)
    tall.bgra.set([9, 9, 9, 255], 43 * 640 * 4);
    tall.bgra.set([7, 7, 7, 255], 44 * 640 * 4);
    const out = composeSelectPicture(tall);
    assert.equal(out.width, 640);
    assert.equal(out.height, 360);
    assert.deepEqual([...out.bgra.subarray(0, 3)], [7, 7, 7]);
    const wide = flat(640, 360, [4, 5, 6]);
    assert.equal(composeSelectPicture(wide), wide);
    assert.equal(composeSelectPicture(flat(320, 180, [1, 1, 1])).height, 360);
});

test("loading_screen is replaced in the levels asked for, and only there", () => {
    const text = applySelectScreens(
        LEVELS,
        new Map([
            ["load_bo", selectName("load_bo", "loadscrn_boston")],
            ["load_nj", selectName("load_nj", "loadscrn_generic")],
        ]),
    );
    assert.match(text, /loading_screen="loadscrn_sel_load_bo__loadscrn_boston"/);
    assert.match(text, /loading_screen="loadscrn_sel_load_nj__loadscrn_generic"/);
    assert.match(text, /loading_screen="loadscrn_other"/);
    assert.match(text, /loading_time=12.4/);
    assert.equal(applySelectScreens(LEVELS, new Map()), LEVELS);
});

test("originalScreens reads the pictures the levels had", () => {
    const found = originalScreens(LEVELS, ["Load_BO", "load_nj"]);
    assert.equal(found.get("load_bo"), "loadscrn_boston");
    assert.equal(found.get("load_nj"), "loadscrn_generic");
    assert.equal(found.size, 2);
});

test("the overlay's level select pictures become loading screens; a level without one is left out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadsel-"));
    try {
        fs.mkdirSync(path.join(dir, "images"));
        fs.writeFileSync(
            path.join(dir, "images", "frontend_art_thug2_bo.img.xbx"),
            nativeImg(flat(640, 448, [10, 20, 30])),
        );
        const built = buildSelectScreens(
            dir,
            LEVELS,
            new Map([
                ["load_bo", "frontend_art_thug2_bo"],
                ["load_nj", "frontend_art_thug1_nj"], // (no file)
            ]),
        );
        assert.deepEqual([...built.screens.keys()], ["load_bo"]);
        assert.deepEqual(built.missing, ["load_nj"]);
        const image = built.images.get("loadscrn_sel_load_bo__loadscrn_boston");
        assert.ok(image);
        const picture = readImg(image);
        assert.equal(picture.width, 640);
        assert.equal(picture.height, 360);
        assert.deepEqual([...picture.bgra.subarray(0, 3)], [10, 20, 30]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("the bar is drawn over its plate: ink around it, yellow rule on top, filled part and track", () => {
    const out = drawLoadingScreen(flat(640, 360, [200, 100, 50]), 1280, 720, 0.5);
    assert.equal(out.width, 1280);
    const at = (x: number, y: number): number[] =>
        [...out.bgra.subarray((y * 1280 + x) * 4, (y * 1280 + x) * 4 + 3)].reverse();
    assert.deepEqual(at(10, 10), [50, 100, 200]); // (the picture)
    // (y 630 = 420 * 1.5 is the frame's top; the plate reaches 14 * 1.5 above it)
    assert.deepEqual(at(640, 610), [0xf2, 0xe2, 0x05]); // (the rule)
    assert.deepEqual(at(640 - 330, 640), [0x0a, 0x0a, 0x0a]); // (plate, left of the frame)
    const filled = at(640 - 280, 640);
    const empty = at(640 + 280, 640);
    assert.deepEqual(empty, [0x3a, 0x3a, 0x38]); // (the track, not reached yet)
    assert.ok(filled[0]! >= 0xb0 && filled[2]! > 0x80, `filled: ${filled}`); // (near its start: paper)
});
