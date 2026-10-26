// NOT ORIGINAL - tests of lib/edits.ts (edits to game scripts) on made-up scripts.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    applyOps,
    applyOwnEdits,
    formatEdits,
    keyOf,
    makeOps,
    ownEdits,
    PLACEHOLDER,
    parseEdits,
    UnitIndex,
    type UnitLookup,
    unitMap,
} from "./edits.ts";

const GAME = `script game_menu {
    make_new_roundbar_menu title="THE GAME'S MENU" id=game_menu_id
    add_roundbar_menu_item text="FIRST ITEM OF THE GAME" id=first_item pad_choose_script=first_item_chosen
    add_roundbar_menu_item text="SECOND ITEM OF THE GAME" id=second_item pad_choose_script=second_item_chosen
    roundbar_menu_finish
}
game_global = 1
`;

test("edits: an adapted game unit in a file of our own is stored as edits, and comes back", () => {
    const units = unitMap(GAME);
    assert.deepEqual([...units.keys()], [keyOf("game_menu"), keyOf("game_global")]);
    const look: UnitLookup = { unit: (file, key) => (file === "game.qb" ? units.get(key) : undefined) };
    const index = new UnitIndex(
        look,
        [...units].map(([k, t]) => ["game.qb", k, t] as const),
    );
    const ours = [
        "// our own file",
        "script our_menu {",
        '    make_new_roundbar_menu title="OUR MENU" id=game_menu_id',
        '    add_roundbar_menu_item text="FIRST ITEM OF THE GAME" id=first_item pad_choose_script=first_item_chosen',
        "    our_own_line",
        '    add_roundbar_menu_item text="SECOND ITEM OF THE GAME" id=second_item pad_choose_script=second_item_chosen',
        "    roundbar_menu_finish",
        "}",
        "script all_ours {",
        "    nothing_of_the_game",
        "}",
        "",
    ].join("\n");
    const [own, edits] = ownEdits(ours, index, look, "test", "# test");
    assert.ok(edits);
    assert.equal(edits.blocks.length, 1);
    assert.ok(own.includes(`${PLACEHOLDER}our_menu`));
    assert.ok(!own.includes("FIRST ITEM OF THE GAME"));
    const stored = formatEdits(edits);
    assert.ok(!stored.includes("FIRST ITEM OF THE GAME"), stored);
    assert.equal(applyOwnEdits(own, parseEdits(stored, "test"), look, "test"), ours);
    // a changed game unit is refused (its CRC)
    const changed: UnitLookup = { unit: (f, k) => look.unit(f, k)?.replace("FIRST", "1ST") };
    assert.throws(() => applyOwnEdits(own, parseEdits(stored, "test"), changed, "test"), /isn't the one/);
});

test("edits: makeOps / applyOps round trip on a changed unit", () => {
    const src = GAME.split("\n");
    const tgt = [...src];
    tgt.splice(3, 1, "    our line");
    tgt[1] = tgt[1]!.replace("THE GAME'S", "OUR");
    assert.deepEqual(applyOps(src, makeOps(src, tgt), "test"), tgt);
});

test("edits: a fallback index makes what the first can't, and shares the lines it can't", () => {
    const other = `script other_menu {
    add_roundbar_menu_item text="AN ITEM ONLY THE OTHER GAME HAS" id=other_item pad_choose_script=other_chosen
    other_line_of_the_other_game_here
}
`;
    const first = unitMap(GAME);
    const second = unitMap(other);
    const look: UnitLookup = {
        unit: (file, key) =>
            file === "game.qb" ? first.get(key) : file === "other:x.qb" ? second.get(key) : undefined,
    };
    const fallback = new UnitIndex(
        look,
        [...second].map(([k, t]) => ["other:x.qb", k, t] as const),
    );
    const index = new UnitIndex(
        look,
        [...first].map(([k, t]) => ["game.qb", k, t] as const),
        fallback,
    );
    const ours = [
        "script ours {",
        '    add_roundbar_menu_item text="FIRST ITEM OF THE GAME" id=first_item pad_choose_script=first_item_chosen',
        "    our_own_line",
        '    add_roundbar_menu_item text="AN ITEM ONLY THE OTHER GAME HAS" id=other_item pad_choose_script=other_chosen',
        "}",
        "script from_the_other {",
        '    add_roundbar_menu_item text="AN ITEM ONLY THE OTHER GAME HAS" id=other_item pad_choose_script=other_chosen',
        "    other_line_of_the_other_game_here",
        "}",
        "",
    ].join("\n");
    const [own, edits] = ownEdits(ours, index, look, "test", "# test");
    assert.ok(edits);
    const stored = formatEdits(edits);
    assert.ok(!stored.includes("ONLY THE OTHER GAME"), stored);
    assert.ok(stored.includes(" other:x.qb other_menu"), stored);
    assert.equal(applyOwnEdits(own, parseEdits(stored, "test"), look, "test"), ours);
});
