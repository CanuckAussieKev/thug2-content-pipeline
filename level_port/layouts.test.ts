// NOT ORIGINAL - tests of layouts.ts (moved from thaw_levels/thaw_levels.test.ts with the converters' split).

import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateText, quarterTurn } from "./layouts.ts";

test("migrateText moves every record by the frames' difference", () => {
    const text =
        "scene 41AFB2FF  # thaw_ma\nsector 1 1 10 20 30 x\nobject 3 1.5 2 3#c\r\n\n  # only\ncopy A B -1 -2 -3";
    assert.deepEqual(migrateText(text, 0x41afb2ff, 0x12345678, [0.5, -1.0, 2.25], "z_ma"), [
        "scene 12345678  # z_ma\nsector 1 1 8.25 20 32.75 x\nobject 3 2 1 5.25  #c\n\n  # only\ncopy A B -0.5 -3 -0.75",
        3,
    ]);
    assert.throws(() => migrateText("scene 00000001\n", 2, 3, [0, 0, 0]));
    assert.deepEqual(quarterTurn([1, 2, 3], 1), [3, 2, -1]);
    assert.deepEqual(quarterTurn([1, 2, 3], 6), [-1, 2, -3]);
});
