// NOT ORIGINAL - tests of the BMX ride scripts (tools/pipeline/thaw_bmx/ride.ts) and the pause menu item (install.ts), with
// synthetic data (no game files) - but rideScripts' text holds THAW's bike scripts, made from the user's THAW
// (bike_scripts.ts): those tests run only where THAW is installed (C:\Games\THAW, or THAW_DIR), skipped otherwise.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { checksum, Local, Name, type QbValue, Struct, Vector } from "../level_port/qb.ts";
import { DECOMP } from "../lib/decomp.ts";
import { findInstall } from "../lib/install.ts";
import {
    bailBikeComponents,
    localStrings,
    SOUNDS,
    soundPaths,
    ThawScripts,
    trickList,
    triggers,
} from "./bike_scripts.ts";
import { namedAnimations, OUR_MEMBERS, unknownAnimations } from "./check.ts";
import { addPauseItem, MANIFEST, STAGING } from "./install.ts";
import * as ride from "./ride.ts";
import * as sounds from "./sounds.ts";

function names(...texts: string[]): Map<number, string> {
    return new Map(texts.map((t) => [checksum(t), t]));
}

function globals(entries: Record<string, QbValue>): { get(name: string): QbValue | undefined } {
    return { get: (name: string) => entries[name] };
}

const cameraStruct = (behind: number): Struct =>
    new Struct([
        [new Name(checksum("behind")), behind],
        [new Name(checksum("above")), 3.5],
    ]);

test("physicsText: THAW's bicycle_physics and bike cameras under our names, the array in THAW's order", () => {
    const physics = new Struct([
        [new Name(checksum("Physics_Rolling_Friction")), 0.5],
        [
            new Name(checksum("Skater_Max_Speed_Stat")),
            new Struct([
                [null, new Vector("pair", [625, 800])],
                [null, new Name(checksum("STATS_SPEED"))],
                [new Name(checksum("switch")), new Name(checksum("no_switch"))],
            ]),
        ],
    ]);
    const thaw = globals({
        bicycle_physics: physics,
        Skater_Camera_Bike_Near: cameraStruct(7),
        Skater_Camera_Bike_Medium: cameraStruct(10),
        Skater_Camera_Bike_Far: cameraStruct(14),
        Skater_Camera_Bike_Medium_LTG: cameraStruct(12),
        Skater_Camera_Bike_Array: [
            new Name(checksum("Skater_Camera_Undefined")),
            new Name(checksum("Skater_Camera_Bike_Near")),
            new Name(checksum("Skater_Camera_Bike_Medium")),
            new Name(checksum("Skater_Camera_Bike_Far")),
            new Name(checksum("Skater_Camera_Bike_Medium_LTG")),
        ],
        Normal_Lerp_Speed_Bike: 0.5,
        bike_forward_jump_boost: 100,
    });
    const text = ride.physicsText(
        thaw,
        names(
            "Physics_Rolling_Friction",
            "Skater_Max_Speed_Stat",
            "STATS_SPEED",
            "no_switch",
            "behind",
            "above",
            "Skater_Camera_Undefined",
        ),
    );
    assert.match(text, /^thaw_bicycle_physics = \{\n {4}Physics_Rolling_Friction=0\.5\n/);
    // (`switch` is a NeverScript keyword: written as its checksum's bytes)
    assert.match(text, /#E7B41690=no_switch/);
    assert.match(text, /\nthaw_bmx_camera_medium = \{\n {4}behind=10\n/);
    assert.match(
        text,
        /\nthaw_bmx_camera_array = \[Skater_Camera_Undefined, thaw_bmx_camera_near, thaw_bmx_camera_medium, thaw_bmx_camera_far, thaw_bmx_camera_medium_ltg\]\n/,
    );
    // (phase 3: THAW's globals the bike's physics reads, under THAW's names)
    assert.match(text, /\nNormal_Lerp_Speed_Bike = 0\.5\nbike_forward_jump_boost = 100\n$/);
    assert.throws(() => ride.physicsText(globals({}), names()), /no bicycle_physics/);
});

// The user's THAW, when there is one (the ride scripts' THAW part is made from it).
const THAW = findInstall(process.env["THAW_DIR"] ?? "C:\\Games\\THAW", "thaw");
const NO_THAW = !THAW && "needs the user's THAW (C:\\Games\\THAW or THAW_DIR): THAW's bike scripts are made from it";
let rideText: string | null = null;
function rideScripts(): string {
    rideText ??= ride.rideScripts(new ThawScripts(path.join(THAW!, "data", "pak", "qb.pak.wpc"), THAW!));
    return rideText;
}

const scriptNames = (text: string): Set<string> => new Set([...text.matchAll(/\nscript (\w+) \{/g)].map((m) => m[1]!));

test("rideScripts (phase 4): no vehicle - THAW's own bike scripts; the toggle, getting on and off", {
    skip: NO_THAW,
}, () => {
    const text = rideScripts();
    assert.doesNotMatch(text, /Vehicle_Start|SkaterVehicleOn|SkaterVehicleOff|racemode|thaw_bmx_params/);
    assert.match(text, /script thaw_bmx_toggle \{\n {4}if ! ThawBmx_Available \{/);
    assert.match(text, /script thaw_bmx_get_on \{[\s\S]*?\n {4}thaw_bmx_load_sounds\n[\s\S]*?\n {4}bmx_finish_on\n\}/);
    assert.match(text, /script thaw_bmx_get_off \{[\s\S]*?\n {4}thaw_bmx_off\n {4}bmx_finish_off\n\}/);
    assert.match(text, /script bmx_finish_on \{[\s\S]*?\n {4}SkaterOnBike\n[\s\S]*?\n {4}bike_start\n\}/);
    assert.match(text, /script bmx_finish_off \{\n {4}SkaterOffBike\n[\s\S]*?\n {4}create_bike_spot\n/);
    // every bike sound loaded, from the folder convert.ts writes them to
    for (const sound of SOUNDS) assert.match(text, new RegExp(`LoadSound "thaw_bmx\\\\\\\\${sound}"`), sound);
    // the parked bike is THAW's bike_spot: its model and skeleton the special item's
    assert.match(text, /component=skeleton skeletonName=THAW_SI_BMX/);
    // braces balance (a cheap syntax check; ns.exe compiles it in convert.ts)
    assert.equal((text.match(/\{/g) ?? []).length, (text.match(/\}/g) ?? []).length);
});

// (the DLL's script names: the decomp's src/game/skater - skipped when this repository is on its own)
test("rideScripts: every script the DLL runs is there; THAW's under THAW's names", {
    skip: (!DECOMP && "needs the decomp checkout (src/game/skater)") || NO_THAW,
}, () => {
    const text = rideScripts();
    const scripts = scriptNames(text);
    // (src/game/skater/thaw_bmx_physics.cpp's and thaw_bmx.cpp's script names)
    const cpp = ["thaw_bmx_physics.cpp", "thaw_bmx.cpp"]
        .map((f) => fs.readFileSync(path.join(DECOMP!, "src", "game", "skater", f), "utf8"))
        .join("\n");
    const run = [...cpp.matchAll(/constexpr const char\* k\w+Script = "(\w+)";/g)].map((m) => m[1]!);
    assert.ok(run.includes("bike_enter_manual") && run.includes("thaw_bmx_after_reset"), run.join(" "));
    for (const name of run.filter((n) => !n.startsWith("animload_") && n !== "thaw_bmx_load_skeleton"))
        assert.ok(scripts.has(name), `${name} (the DLL runs it) isn't in the scripts`);
    // THAW's bike scripts are there under their own names
    for (const name of [
        "bike_start",
        "bike_onground",
        "BIKE_OLLIE",
        "bike_air_state",
        "BIKE_LAND",
        "bike_land2",
        "bike_manual",
        "bike_grab_trick",
        "bike_grab_trick2",
        "bike_partial_barspin",
        "bike_wallride",
        "bike_wallplant",
        "bike_skitch",
        "bike_bail",
        "BIKE_GRIND",
        "bike_OffRail",
        "Skater_PlayBikeAnim",
        "bike_play_looping_sounds",
    ])
        assert.ok(scripts.has(name), name);
    // no THAW-only animation-tree command is left (the shims play them)
    const code = text.replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(
        code,
        /Anim_Command|Skater_Playanim|Skater_waitanimfinished|Skater_AnimComplete|iscreated|SI_Bike/,
    );
    // the bike's members in the C++ (thaw_bmx.cpp kMembers) are the ones check.ts allows
    const block = /const char\* const kMembers\[\] = \{([\s\S]*?)\};/.exec(cpp);
    assert.ok(block, "kMembers");
    const members = [...block[1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
    assert.deepEqual([...members].sort(), [...OUR_MEMBERS].sort());
});

test("rideScripts (phase 5): THUG2's manual and revert inputs on the bike, the bike thrown on a bail", {
    skip: NO_THAW,
}, () => {
    const text = rideScripts();
    const body = (name: string): string => {
        const m = new RegExp(`\\nscript ${name} \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(text);
        assert.ok(m, name);
        return m[1]!;
    };
    // up-down / down-up: the manual / nose manual, THUG2's timings; the air's kept for the landing
    assert.match(
        text,
        /thaw_bmx_GroundManualTricks = \[\n {4}\{Trigger=\{InOrder, Up, Down, 220\} Scr=thaw_bmx_manual\}/,
    );
    assert.match(text, /\{Trigger=\{InOrder, Down, Up, 400\} Duration=700 Scr=thaw_bmx_manual Params=\{nose\}\}/);
    assert.match(body("thaw_bmx_manual"), /EnterWheelieFromAir nose\n\s+Goto bike_manual params=\{nose\}/);
    assert.match(body("bike_onground"), /SetManualTricks thaw_bmx_GroundManualTricks/);
    assert.match(body("bike_onground_loop"), /DoNextManualTrick\n/);
    assert.match(body("bike_Airborne"), /SetManualTricks thaw_bmx_AirManualTricks/);
    const land = body("bike_land2");
    // the manual window comes before the combo lands
    assert.ok(land.indexOf("DoNextManualTrick FromAir") < land.indexOf("\n    LandSkaterTricks"));
    // no revert on the bike (THAW has none: no SetExtraTricks_Reverts in its bike_land2); THAW's own backwards
    // revert stays
    assert.doesNotMatch(text, /thaw_bmx_Reverts|script bike_revert /);
    assert.doesNotMatch(land, /SetExtraTricks/);
    assert.match(land, /if ! LandedFromVert \{\n\s+while \{\n\s+DoNextManualTrick FromAir/);
    assert.match(body("bike_backwards_revert"), /Rotate\n[\s\S]*anim=bmx_pivot_frombackwards/);
    // the bail: the ridden bike hidden, a rigid body one thrown; taken away at the get-up, a reset, getting on
    assert.match(
        body("bike_bail"),
        /Obj_SpawnScript thaw_bmx_bail_bike_control\n {4}thaw_bmx_waitanim\n {4}kill_bail_bike/,
    );
    const control = body("thaw_bmx_bail_bike_control");
    assert.match(control, /ThawBmx:Hide[\s\S]*CreateCompositeObject Components=thaw_bmx_bail_bike_components/);
    assert.match(control, /RigidBody_Wake/);
    assert.match(body("kill_bail_bike"), /<mangled_id>:Die[\s\S]*ThawBmx:Unhide/);
    assert.match(body("bike_start"), /kill_bail_bike/);
    assert.match(body("thaw_bmx_after_reset"), /kill_bail_bike/);
    assert.equal((text.match(/\{/g) ?? []).length, (text.match(/\}/g) ?? []).length);
});

test("rideScripts (phase 6): the wheels' cycles played whole - never from=current (the shrunk cycle hung the game)", {
    skip: NO_THAW,
}, () => {
    const text = rideScripts();
    const m = /\nscript thaw_bmx_bike_wheels \{\n([\s\S]*?)\n\}\n/.exec(text);
    assert.ok(m);
    const plays = m[1]!.split("\n").filter((line) => /^\s*PlayAnim /.test(line));
    assert.equal(plays.length, 2);
    for (const line of plays) {
        assert.match(line, /\bCycle\b/);
        assert.doesNotMatch(line, /from=/i);
    }
    // no cycle anywhere played from=current (the same trap; bike_playturnanim had one)
    const code = text.replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /\bCycle\b[^\n]*from=current/i);
    assert.doesNotMatch(code, /from=current[^\n]*\bCycle\b/i);
});

test("rideScripts (tricks): the getting on / off animations, the grind's fall-off and the air on the bike's own", {
    skip: NO_THAW,
}, () => {
    const text = rideScripts();
    const body = (name: string): string => {
        const m = new RegExp(`\\nscript ${name} \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(text);
        assert.ok(m, name);
        return m[1]!;
    };
    const code = (name: string): string => body(name).replace(/\/\/[^\n]*/g, "");
    // getting on: off the board (BrakeToStand from skating, the board put away with THAW's board catch backwards,
    // WStand) before bmx_getup; off: GetUp_S_RunJump onto it
    const on = code("thaw_bmx_get_on");
    assert.match(on, /if ! Walking \{\n\s+PlayAnim Anim=BrakeToStand Speed=1.3\n\s+WaitAnim 50 Percent\n\s+\}/);
    assert.match(on, /PlayAnim Anim=THPS7_BoardCatch_Stand Backwards Speed=1.2\n\s+WaitAnimFinished/);
    assert.ok(
        on.indexOf("if ! IsBoardMissing") < on.indexOf("Anim=BrakeToStand") &&
            on.indexOf("Anim=BrakeToStand") < on.indexOf("Anim=THPS7_BoardCatch_Stand") &&
            on.indexOf("Anim=THPS7_BoardCatch_Stand") < on.indexOf("SwitchOffBoard") &&
            on.indexOf("SwitchOffBoard") < on.indexOf("Anim=WStand") &&
            on.indexOf("Anim=WStand") < on.indexOf("bmx_finish_on"),
    );
    const off = code("bmx_finish_off");
    assert.match(off, /PlayAnim Anim=GetUp_S_RunJump[^\n]*\n[\s\S]*WaitAnim 50 Percent\n\s+UnpausePhysics/);
    // the grind's balance lost: the bike's skate-in (THAW's SkateInOrBail's bike branches), never THUG2's skater one
    const grind = code("BIKE_GRIND");
    assert.match(grind, /Ex=OffMeterTop Scr=bike_SkateInOrBail params=\{<\.\.\.> FallingLeft\}/);
    assert.match(grind, /Ex=OffMeterBottom Scr=bike_SkateInOrBail params=\{<\.\.\.> FallingRight\}/);
    assert.doesNotMatch(text.replace(/\/\/[^\n]*/g, ""), /Scr=SkateInOrBail\b|Goto SkateIn_(Right|Left)\b/);
    for (const side of ["Right", "Left"]) {
        const skateIn = code(`bike_SkateIn_${side}`);
        assert.match(skateIn, /Goto bike_rail_exit params=\{callback=BIKE_LAND\}/);
        assert.match(skateIn, /Goto bike_rail_exit params=\{callback=bike_bail\}/);
        assert.doesNotMatch(skateIn, /SkateInLand|SkateIn_Bail|OnGroundExceptions_NoOllie|SetExtraTricks_Reverts/);
    }
    const ground = code("bike_OnGroundExceptions");
    assert.match(ground, /ResetEventHandlersFromTable Bike_OnGroundExceptionTable/);
    assert.doesNotMatch(ground, /SwitchOnBoard|SetSkaterGroundTricks/);
    // off a ledge: the bike's air tricks (THAW's SetSkaterAirTricks' bike branch), no skater's extra grind tricks
    assert.doesNotMatch(code("bike_GroundGone"), /SetSkaterAirTricks/);
    assert.match(code("bike_GroundGone"), /SetQueueTricks Bike_AirTricks/);
    assert.match(code("bike_start"), /SetExtraGrindTricks NoTricks/);
    // a ped's knock-down on the bike: the bike's bail (THAW's PedKnockDown bike branch), not the skater's manual bails
    const knock = code("bike_PedKnockDown");
    assert.match(knock, /Obj_SpawnScript BloodSmall/);
    assert.match(knock, /if Skating \{[\s\S]*Goto bike_bail\n\s+\} else \{\n\s+Goto WalkBailState/);
    assert.doesNotMatch(knock, /ManualBail|vehicle_bail|FiftyFiftyFall|IsSkaterOnBike|OnStall/);
    assert.equal((text.match(/\{/g) ?? []).length, (text.match(/\}/g) ?? []).length);
});

test("namedAnimations / unknownAnimations: every key naming an animation; load scripts and flags left out", () => {
    const text = [
        "script a {",
        "    thaw_bmx_playanim anim=bmx_idle Cycle",
        "    PlayAnim Anim=GetUp_S_RunJump BlendPeriod=0.0",
        "    bike_grab_trick init_anim=bmx_tailwhip_init Idle_Anim=bmx_tailwhip_idle Out_Anim=bmx_tailwhip_out flip_anim=flip_anim",
        "    BIKE_GRIND InitAnim=bmx_grind_init anim_backwards=1",
        "    bike_playturnanim TurnIdle=bmx_turnl_pedaling TurnAnim=bmx_turnl_coasting_idle",
        "    {component=animblender AnimName=animload_thaw_bmx_bike}",
        '    LoadAnim name="anims\\\\x.ska" descChecksum=bmx_idle',
        "}",
    ].join("\n");
    assert.deepEqual([...namedAnimations(text).keys()].sort(), [
        "bmx_grind_init",
        "bmx_idle",
        "bmx_tailwhip_idle",
        "bmx_tailwhip_init",
        "bmx_tailwhip_out",
        "bmx_turnl_coasting_idle",
        "bmx_turnl_pedaling",
        "getup_s_runjump",
    ]);
    const have = new Set(
        [
            "bmx_idle",
            "GetUp_S_RunJump",
            "bmx_tailwhip_init",
            "bmx_tailwhip_idle",
            "bmx_grind_init",
            "bmx_turnl_pedaling",
            "bmx_turnl_coasting_idle",
        ].map(checksum),
    );
    assert.deepEqual(unknownAnimations(text, have), ["Out_Anim=bmx_tailwhip_out"]);
});

test("bailBikeComponents: THAW's rigid body on our bike's skeleton, model and animations - no SoundType", () => {
    const n = names("component", "rigidbody", "motion", "coeff_friction", "SoundType", "SkaterBikeWhenBail", "shadow");
    const thawComponents: QbValue = [
        new Struct([[new Name(checksum("component")), new Name(checksum("motion"))]]),
        new Struct([
            [new Name(checksum("component")), new Name(checksum("rigidbody"))],
            [new Name(checksum("coeff_friction")), 0.7],
            [new Name(checksum("SoundType")), new Name(checksum("SkaterBikeWhenBail"))],
        ]),
        new Struct([[new Name(checksum("component")), new Name(checksum("shadow"))]]),
    ];
    const text = bailBikeComponents(thawComponents, n);
    assert.match(text, /component=rigidbody\n\s+coeff_friction=0\.69/);
    assert.doesNotMatch(text, /SoundType|SkaterBikeWhenBail|shadow/);
    assert.match(text, /\{component=skeleton skeletonName=THAW_SI_BMX\}/);
    assert.match(text, /\{component=model UseModelLights model="specialitems\/thaw_bmx\/si_bmx\.skin"\}/);
    assert.match(text, /AnimName=animload_thaw_bmx_bike/);
    assert.throws(() => bailBikeComponents([thawComponents[0]!], n), /no rigidbody/);
});

test("triggers: THAW's right-stick tricks on Flip + a direction, its grabs on Grab + a direction", () => {
    const n = names("BikePress", "rightright", "rightdown", "InOrder", "leftdown", "square", "Press", "circle", "R2");
    const trig = (...parts: (string | number)[]): Struct =>
        new Struct(parts.map((p) => [null, typeof p === "number" ? p : new Name(checksum(p))] as [null, QbValue]));
    assert.deepEqual(triggers(trig("BikePress", "rightright", 50), n), [
        { trigger: "{AirTrickLogic, Square, Right, 500}", button: "Square" },
    ]);
    assert.deepEqual(triggers(trig("BikePress", "rightdown", 50), n), [
        { trigger: "{AirTrickLogic, Square, Down, 500}", button: "Square" },
    ]);
    assert.deepEqual(triggers(trig("InOrder", "leftdown", "square", 500), n), [
        { trigger: "{AirTrickLogic, Circle, Down, 500}", button: "Circle" },
    ]);
    assert.deepEqual(
        triggers(trig("Press", "square", 500), n).map((t) => t.trigger),
        [
            "{AirTrickLogic, Circle, Left, 500}",
            "{AirTrickLogic, Circle, Right, 500}",
            "{AirTrickLogic, Circle, Up, 500}",
        ],
    );
    // the x-up (circle) and the pivot (R2) as THAW has them
    assert.equal(triggers(trig("Press", "circle", 50), n)[0]!.button, undefined);
    assert.match(triggers(trig("Press", "R2", 50), n)[0]!.trigger, /Press\n\s+R2\n\s+50/);
    assert.throws(() => triggers(trig("BikePress", "leftleft", 50), n), /not a right-stick direction/);
});

test("trickList: THAW's names, scores and scripts kept, `buttons` as the one button THUG2's Held asks", () => {
    const n = names(
        "BikePress",
        "rightright",
        "Press",
        "square",
        "scr",
        "params",
        "Name",
        "score",
        "buttons",
        "bike_grab_trick",
        "Trigger",
        "RightUpRight",
        "update_side",
    );
    const trick = (trigger: QbValue, params: [string, QbValue][]): Struct =>
        new Struct([
            [new Name(checksum("Trigger")), trigger],
            [new Name(checksum("scr")), new Name(checksum("bike_grab_trick"))],
            [new Name(checksum("params")), new Struct(params.map(([k, v]) => [k ? new Name(checksum(k)) : null, v]))],
        ]);
    const t = (...parts: string[]): Struct =>
        new Struct(parts.map((p) => [null, /^\d+$/.test(p) ? Number(p) : new Name(checksum(p))] as [null, QbValue]));
    const text = trickList(
        [
            trick(t("BikePress", "rightright", "50"), [
                ["Name", new Local("Tailwhip")],
                ["score", 100],
                ["buttons", [new Name(checksum("rightright")), new Name(checksum("RightUpRight"))]],
            ]),
            trick(t("Press", "square", "500"), [
                ["Name", new Local("Tabletop")],
                ["", new Name(checksum("update_side"))],
            ]),
        ],
        n,
    );
    assert.equal((text.match(/Trigger=/g) ?? []).length, 4, text);
    assert.match(text, /Trigger=\{AirTrickLogic, Square, Right, 500\}\n {8}scr=bike_grab_trick\n/);
    assert.match(text, /Name='Tailwhip'\n {12}score=100\n {12}button=Square\n/i);
    assert.doesNotMatch(text, /buttons=/);
    assert.match(localStrings(text), /Name=%"Tabletop"\n {12}update_side\n {12}button=Circle\n/i);
    assert.equal(localStrings("Name = 'Double Peg Grind' x = \"don't\""), 'Name = %"Double Peg Grind" x = "don\'t"');
});

test("soundPaths: THAW's sound names as THUG2's terrain files - ours under thaw_bmx, THUG2's own in Terrains", () => {
    const n = names("sound", "Bmx_land_default", "GrindMetalOn02", "maxPitch", "NotABikeSound");
    const entry = (sound: string): Struct =>
        new Struct([
            [new Name(checksum("sound")), new Name(checksum(sound))],
            [new Name(checksum("maxPitch")), 120],
        ]);
    const out = soundPaths([entry("Bmx_land_default"), entry("GrindMetalOn02")], n);
    assert.ok(Array.isArray(out));
    assert.equal((out[0] as Struct).get("sound"), "thaw_bmx\\Bmx_land_default");
    assert.equal((out[1] as Struct).get("sound"), "Terrains\\GrindMetalOn02");
    assert.equal((out[0] as Struct).get("maxPitch"), 120);
    assert.throws(() => soundPaths([entry("NotABikeSound")], n), /isn't converted/);
});

test("sounds: THUG2's ADPCM - what's encoded decodes to the nearest; the .snd as PCWave::Load reads it", () => {
    const samples = new Int16Array(4000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8000 * Math.sin(i / 7) + 3000 * Math.sin(i / 2.3));
    const data = sounds.encode(samples);
    assert.equal(data.length, 2000);
    const back = sounds.decode(data, samples.length);
    let worst = 0;
    for (let i = 100; i < samples.length; i++) worst = Math.max(worst, Math.abs(back[i]! - samples[i]!));
    assert.ok(worst < 1200, `worst ${worst}`);
    const snd = sounds.writeSnd(samples, 22050, true);
    const read = sounds.readSnd(snd);
    assert.equal(read.rate, 22050);
    assert.equal(read.decodedBytes, samples.length * 2);
    assert.ok(read.looping);
    assert.deepEqual(read.data, data);
    assert.ok(!sounds.readSnd(sounds.writeSnd(samples, 44100, false)).looping);
    assert.equal(snd.readUInt32LE(4), snd.length - 8);
});

test("addPauseItem: RIDE BMX after LEVEL EDITOR, IsSkaterOnBike only asked behind ThawBmx_Available", () => {
    const pause =
        '        add_roundbar_menu_item text="YOUR OPTIONS" id=menu_your_options pad_choose_script=create_your_options_menu \n' +
        "        if LevelEditor_Available {\n" +
        '            add_roundbar_menu_item text="LEVEL EDITOR" id=menu_level_editor pad_choose_script=level_editor_enter \n' +
        "        } \n" +
        "        if ! CD {\n" +
        '            add_roundbar_menu_item text="DEBUG OPTIONS" id=menu_debug_options pad_choose_script=create_debug_options_menu \n' +
        "        } \n";
    const game = fs.mkdtempSync(path.join(os.tmpdir(), "bmx-"));
    try {
        assert.equal(addPauseItem(pause, game), pause, "no staging folder: unchanged");
        fs.mkdirSync(path.join(game, STAGING));
        fs.writeFileSync(path.join(game, STAGING, MANIFEST), "{}");
        const out = addPauseItem(pause, game);
        const editor = out.indexOf('"LEVEL EDITOR"');
        const available = out.indexOf("if ThawBmx_Available {");
        const onBike = out.indexOf("if skater:IsSkaterOnBike {");
        const debug = out.indexOf('"DEBUG OPTIONS"');
        assert.ok(editor < available && available < onBike && onBike < debug, out);
        assert.match(out, /text="GET OFF BMX" id=menu_thaw_bmx pad_choose_script=thaw_bmx_pause_toggle/);
        assert.match(out, /text="RIDE BMX" id=menu_thaw_bmx pad_choose_script=thaw_bmx_pause_toggle/);
        assert.equal((out.match(/\{/g) ?? []).length, (out.match(/\}/g) ?? []).length);
        assert.throws(() => addPauseItem("nothing here\n", game), /LEVEL EDITOR item not found/);
    } finally {
        fs.rmSync(game, { recursive: true, force: true });
    }
});
