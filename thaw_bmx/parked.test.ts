// NOT ORIGINAL - tests of the parked bikes' converter part (tools/pipeline/thaw_bmx/parked.ts) and scripts (ride.ts
// parkedScripts), with synthetic data (no game files).

import assert from "node:assert/strict";
import { test } from "node:test";
import { checksum, Name, Struct, Vector } from "../level_port/qb.ts";
import { OUR_CFUNCS } from "./check.ts";
import { bikePedIds, homeBikesText, placeOf } from "./parked.ts";
import * as ride from "./ride.ts";

const n = (text: string): Name => new Name(checksum(text));

test("bike_ped_ids read as [zone, node]", () => {
    const names = new Map([
        [checksum("Z_HO"), "Z_HO"],
        [checksum("Z_HO_TRG_Ped_BikeGuy"), "Z_HO_TRG_Ped_BikeGuy"],
    ]);
    const value = [
        new Struct([
            [n("level"), n("Z_HO")],
            [n("id"), n("Z_HO_TRG_Ped_BikeGuy")],
        ]),
    ];
    assert.deepEqual(bikePedIds(value, names), [["Z_HO", "Z_HO_TRG_Ped_BikeGuy"]]);
    assert.throws(() => bikePedIds(undefined, names));
    assert.throws(() => bikePedIds([new Struct([[n("level"), n("Z_HO")]])], names));
});

test("a node's place: moved by the level's shift, Angles y in degrees", () => {
    const node = new Struct([
        [n("Pos"), new Vector("vector", [10.0, 20.0, 30.0])],
        [n("Angles"), new Vector("vector", [0.0, Math.PI / 2, 0.0])],
    ]);
    const place = placeOf(node, [1.0, -2.0, 0.5]);
    assert.deepEqual(place.pos, [11.0, 18.0, 30.5]);
    assert.ok(Math.abs(place.heading - 90.0) < 1e-9);
    // (no Angles: heading 0; no Pos: an error)
    assert.equal(placeOf(new Struct([[n("Pos"), new Vector("vector", [0, 0, 0])]]), [0, 0, 0]).heading, 0.0);
    assert.throws(() => placeOf(new Struct([]), [0, 0, 0]));
});

test("the home bikes' global", () => {
    const text = homeBikesText([
        { zone: "Z_HO", level: "z_ho", node: "Z_HO_TRG_Ped_BikeGuy", pos: [-1617.66, 96.37, -0.0001], heading: -9.47 },
    ]);
    assert.match(
        text,
        /^thaw_bmx_home_bikes = \[\n {4}\{level=z_ho pos=\(-1617\.660, 96\.370, 0\.000\) heading=-9\.470\}\n\]\n/m,
    );
    // (none: no global - the DLL then uses the start spot everywhere)
    assert.doesNotMatch(homeBikesText([]), /thaw_bmx_home_bikes =/);
});

test("the parked bikes' scripts", () => {
    const text = ride.parkedScripts();
    for (const s of [
        "thaw_bmx_offer_off",
        "thaw_bmx_home_bike",
        "thaw_bmx_level_start",
        "thaw_bmx_spot_watch",
        "thaw_bmx_spot_dialog_watch",
        "thaw_bmx_spot_ride",
        "thaw_bmx_walk_to_bike",
    ])
        assert.match(text, new RegExp(`\\nscript ${s} \\{\\n`), s);
    // THAW's text (its "\ms" glyph as THUG2's Circle, \m5 - the button THUG2's speech boxes take)
    assert.match(text, /text="Press \\\\m5 to ride the bike\."/);
    assert.match(text, /pad_circle_script=thaw_bmx_spot_ride/);
    // THAW's 12 feet; THAW's global the toggle sets and bmx_finish_on / off clear
    assert.match(text, /^thaw_bmx_spot_radius = 12$/m);
    assert.match(text, /^dont_create_speech_boxes = 0$/m);
    // the DLL's commands the scripts use are known to check.ts
    for (const c of text.match(/\bThawBmx_\w+/g) ?? []) assert.ok(OUR_CFUNCS.includes(c), c);
    // the level's bike: its assets loaded before it's made, THAW's pose, the offer
    assert.match(
        text,
        /skater:ThawBmxLoadAssets[\s\S]*CreateCompositeObject Components=thaw_bmx_spot_components Params=\{Name=thaw_bmx_home Pos=<pos> NeverSuspend\}[\s\S]*Obj_SetOrientation y=<heading>[\s\S]*Obj_PlayAnim Anim=bmx_getup Speed=0[\s\S]*Obj_SpawnScript thaw_bmx_spot_watch/,
    );
});
