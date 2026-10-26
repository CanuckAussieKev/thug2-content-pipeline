// NOT ORIGINAL - tests of thaw_ns.ts (THAW's script bodies as NeverScript) on made-up tokens.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checksum } from "../level_port/qb.ts";
import { Tok } from "../level_port/script_port.ts";
import { renderNs, shortFloat } from "./thaw_ns.ts";

test("shortFloat: a float32's shortest form", () => {
    assert.equal(shortFloat(0.4000000059604645), "0.4");
    assert.equal(shortFloat(20), "20.0");
    assert.equal(shortFloat(1.5), "1.5");
    assert.equal(shortFloat(-0.30000001192092896), "-0.3");
});

test("renderNs: if / else / endif as braces, statements and arguments, locals, not", () => {
    const names = new Map<number, string>();
    let i = 0;
    const name = (text: string): Tok => {
        names.set(checksum(text), text);
        const p = Buffer.alloc(4);
        p.writeUInt32LE(checksum(text));
        return new Tok(0x16, p, i++);
    };
    const t = (code: number): Tok => new Tok(code, Buffer.alloc(0), i++);
    const int = (n: number): Tok => {
        const p = Buffer.alloc(4);
        p.writeInt32LE(n);
        return new Tok(0x17, p, i++);
    };
    const toks = [
        name("speed"),
        t(0x07),
        int(0),
        t(0x01),
        t(0x25),
        t(0x39),
        name("Flipped"),
        t(0x01),
        name("PlayAnim"),
        name("anim"),
        t(0x07),
        t(0x2d),
        name("anim"),
        name("Cycle"),
        t(0x01),
        t(0x26),
        t(0x01),
        name("Flip"),
        t(0x01),
        t(0x28),
        t(0x01),
    ];
    assert.deepEqual(renderNs(toks, names), [
        "    speed = 0",
        "    if ! Flipped {",
        "        PlayAnim anim=<anim> Cycle",
        "    } else {",
        "        Flip",
        "    }",
    ]);
});
