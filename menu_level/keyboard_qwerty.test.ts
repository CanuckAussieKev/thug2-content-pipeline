// NOT ORIGINAL - unit test of keyboard_qwerty.ts on a made-up script shaped like the keyboard's (no game text).

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { partyModKeyboard, partyModScripts, qwertyKeyboard } from "./keyboard_qwerty.ts";

function set(name: string, rows: string[][]): string {
    return `${name} = [${rows.map((row) => `[${row.map((key) => `"${key}"`).join(" ")}]`).join(" \n    ")} \n] \n`;
}

const alphabet = [..."abcdefghijklmnopqrstuvwxyz"];
const digits = [..."1234567890"];
const sample =
    "script keyboard_create_key_sprites {\n" +
    "    keyboard_add_generic_buttons_to_hmenu hmenu_id=keyboard_row_3 number_of_buttons=10 heap=<heap> \n" +
    "    keyboard_add_generic_buttons_to_hmenu hmenu_id=keyboard_row_4 number_of_buttons=6 heap=<heap> \n" +
    '    keyboard_add_special_button {\n        hmenu_id=keyboard_row_4 \n        text="Backspace" \n        width=128 \n        grid_x=6 \n    } \n' +
    "} \n" +
    set("alphanumeric_charset_lower", [digits, alphabet.slice(0, 10), alphabet.slice(10, 20), alphabet.slice(20)]) +
    set(
        "alphanumeric_charset_upper",
        [digits, alphabet.slice(0, 10), alphabet.slice(10, 20), alphabet.slice(20)].map((r) =>
            r.map((k) => k.toUpperCase()),
        ),
    ) +
    set(
        "punctuation_charset",
        [digits, [..."abcdefghij"], [..."klmnopqrst"], [..."uvwxyz"]].map((r) => r.map((k) => (k === "a" ? "." : k))),
    ) +
    set("foreign_charset", [[..."ABCDEFGHIJ"], [..."KLMNOPQRST"], [..."UVWXYZabcd"], [..."efghij"]]) +
    "standard_charset = {\n    alphanumeric_charset \n} \n";

function rowsOf(text: string, name: string): string[][] {
    const block = new RegExp(`^${name} = \\[[\\s\\S]*?^\\] *$`, "m").exec(text)![0];
    return block
        .split("\n")
        .map((line) => line.match(/"[^"]*"/g)?.map((k) => k.slice(1, -1)) ?? [])
        .filter((row) => row.length > 0);
}

test("the keyboard's letter sets are QWERTY in rows of 10, 10, 9 and 7", () => {
    const text = qwertyKeyboard(sample);
    assert.deepEqual(
        rowsOf(text, "alphanumeric_charset_lower").map((row) => row.join("")),
        ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"],
    );
    assert.deepEqual(
        rowsOf(text, "alphanumeric_charset_upper").map((row) => row.join("")),
        ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"],
    );
    assert.match(text, /hmenu_id=keyboard_row_3 number_of_buttons=9/);
    assert.match(text, /hmenu_id=keyboard_row_4 number_of_buttons=7/);
    assert.match(text, /text="Backspace" \n\s+width=128 \n\s+grid_x=7/);
    assert.match(text, /standard_charset = \{/);
});

test("the symbols and foreign sets keep every character, in rows of 10, 10, 9 and 7", () => {
    const text = qwertyKeyboard(sample);
    for (const name of ["punctuation_charset", "foreign_charset"]) {
        const rows = rowsOf(text, name);
        assert.deepEqual(
            rows.map((row) => row.length),
            [10, 10, 9, 7],
        );
        const before = rowsOf(sample, name).flat().sort();
        assert.deepEqual(rows.flat().sort(), before);
    }
});

test("a script that isn't the keyboard's is refused", () => {
    assert.throws(() => qwertyKeyboard("script x {\n} \n"), /not found|found 0 times/);
});

test("PartyMod's changed scripts go into a copy made from the loose script, its own changes kept", () => {
    const game = "script a {\n    one \n    \n} \nscript b {\n    two \n} \nscript c {\n    three \n} \n";
    const patched = "script a {\n    one \n    keys \n} \nscript b {\n    two \n} \nscript c {\n    three \n} \n";
    // (the loose script: with its printf; the mod changed c, which the patch doesn't)
    const mod = 'script a {\n    one \n    printf "x" \n} \nscript b {\n    two \n} \nscript c {\n    mine \n} \n';
    assert.equal(
        partyModScripts(mod, game, patched),
        "script a {\n    one \n    keys \n} \nscript b {\n    two \n} \nscript c {\n    mine \n} \n",
    );
    // (the mod changed a, which the patch changes too: refused)
    assert.equal(partyModScripts(mod.replace("one", "own"), game, patched), null);
});

test("PartyMod's keyboard patch is refused for a script it wasn't made for", () => {
    assert.equal(partyModKeyboard(Buffer.from("not the keyboard script")), null);
});
