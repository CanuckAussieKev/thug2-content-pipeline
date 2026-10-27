// NOT ORIGINAL - THAW's BMX for THUG2: riding it ("Phase 4"; the engine side is
// src/game/skater/thaw_bmx.h). The scripts convert.ts adds to thaw_bmx.ns (appended to the overlay's
// specialitems.qb by make_menu_level):
//
//   thaw_bicycle_physics          THAW's bicycle_physics (physics.qb), as THAW has it; the DLL's GetPhysicsStructure
//                                 gives it while the skater is on the bike ([features] thaw_bmx=1)
//   thaw_bmx_camera_*             THAW's Skater_Camera_Bike_Near / Medium / Far / Medium_LTG and their array - put in
//                                 place of Skater_Camera_Array (Change ... resolve) while riding, then put back
//   thaw_bmx_toggle               on / off (the DLL's key, the pause menu, the automation channel's `run`, the walk
//                                 key on the bike - THAW's BikeToWalkTricks)
//   thaw_bmx_pause_toggle         the pause menu's RIDE / GET OFF BMX: exit_pause_menu, then the toggle. (Not
//                                 handle_pause_continue: called from another script it has no device_num, so its
//                                 pause_controller check returned at once and the game stayed paused - the menu
//                                 left up under the new front end's pause, 2026-10-25.)
//   thaw_bmx_get_on / _get_off    on the skater: the assets and sounds loaded, the camera, THAW's bmx_finish_on (->
//                                 bike_start: THAW's own bike scripts, bike_scripts.ts); off: bmx_getup backwards, THAW's
//                                 bmx_finish_off (the parked bike, OnGroundAI)
//   thaw_bmx_bike_script          the bike (special item): its wheels spun as two partial animations by speed, kept
//                                 flipped with the rider (THAW's tree plays the rider's animations on it - here
//                                 bike_scripts.ts's thaw_bmx_playanim)
//
// Phase 2 rode THUG2's vehicle machinery (Vehicle_Start); phase 4 rides THAW's own scripts (bike_scripts.ts) and the
// bike is no vehicle any more.

import type { QbValue } from "../level_port/qb.ts";
import * as qb from "../level_port/qb.ts";
import { Name, Struct } from "../level_port/qb.ts";
import type { UnitLookup } from "../lib/edits.ts";
import * as thaw from "../thaw_levels/thaw.ts";
import { BIKE, bikeScripts, SOUNDS } from "./bike_scripts.ts";

export const PHYSICS = "thaw_bicycle_physics";
export const CAMERA_ARRAY = "thaw_bmx_camera_array";
export const TOGGLE = "thaw_bmx_toggle";
export const BIKE_OBJECT = BIKE; // the special item's Name (convert.ts DETAILS)
// The folder of the bike's sounds under sounds\ (convert.ts writes them there; LoadSound takes them from it).
export const SOUND_FOLDER = "thaw_bmx";
// THAW's physics.qb globals brought along, and our names for them.
export const THAW_PHYSICS = "bicycle_physics";
export const THAW_CAMERAS: readonly [string, string][] = [
    ["Skater_Camera_Bike_Near", "thaw_bmx_camera_near"],
    ["Skater_Camera_Bike_Medium", "thaw_bmx_camera_medium"],
    ["Skater_Camera_Bike_Far", "thaw_bmx_camera_far"],
    ["Skater_Camera_Bike_Medium_LTG", "thaw_bmx_camera_medium_ltg"],
];
export const PHYSICS_FILE = "scripts\\game\\skater\\physics.qb";
// THAW's physics.qb globals the bike's physics reads that THUG2 hasn't (src/game/skater/thaw_bmx_physics.cpp reads them
// under THAW's names - THUG2 has none of these; it falls back to THAW's values without them).
export const THAW_GLOBALS: readonly string[] = ["Normal_Lerp_Speed_Bike", "bike_forward_jump_boost"];
// The wheels: 11.0 units from the ground to the axles (the bike's skeleton: both wheel bones at y 11.01 in the rest
// pose), so 2 pi r = 69.2 a turn; bmx_front_tire_rotate / bmx_rear_tire_rotate turn the wheel once in 1 s.
export const WHEEL_CIRCUMFERENCE = 69.2;

// THAW's physics.qb (qb.pak.wpc) read.
export function thawPhysics(qbPak: string, names: Map<number, string>): thaw.QbItems {
    for (const [e, d] of thaw.pakFiles(qbPak)) {
        if (e.path && e.path.toLowerCase().replaceAll(".wpc", "") === PHYSICS_FILE)
            return new thaw.QbItems(d, e.path, names);
    }
    throw new Error(`${qbPak}: no ${PHYSICS_FILE}`);
}

function need(items: Pick<thaw.QbItems, "get">, name: string): QbValue {
    const value = items.get(name);
    if (value === undefined) throw new Error(`THAW's physics.qb: no ${name}`);
    return value;
}

// THAW's bicycle_physics, its bike cameras and their array, as THUG2 NeverScript globals under our names.
export function physicsText(items: Pick<thaw.QbItems, "get">, names: Map<number, string>): string {
    const physics = need(items, THAW_PHYSICS);
    if (!(physics instanceof Struct)) throw new Error(`THAW's ${THAW_PHYSICS} isn't a structure`);
    // NOT ORIGINAL: the skater's Skater_Min_Distance_To_Wall (8) instead of THAW's 32 - THUG2's push off a wall in the
    // air moves 1 + this along the face, and 33 pushed the bike out through thin ramps (Skate Heaven's second quarter
    // pipe, a ~15-unit slab). The user's call, 2026-10-26.
    const physicsNs = qb
        .toNs(physics, names)
        .replace(/(Skater_Min_Distance_To_Wall\s*=\s*)[-\d.]+/i, (_, key: string) => `${key}8.0`);
    const lines = [`${PHYSICS} = ${physicsNs}`];
    for (const [theirs, ours] of THAW_CAMERAS) {
        const camera = need(items, theirs);
        if (!(camera instanceof Struct)) throw new Error(`THAW's ${theirs} isn't a structure`);
        lines.push(`${ours} = ${qb.toNs(camera, names)}`);
    }
    // (THAW's Skater_Camera_Bike_Array: Skater_Camera_Undefined and the four - THUG2 has Skater_Camera_Undefined too)
    const array = need(items, "Skater_Camera_Bike_Array");
    if (!Array.isArray(array) || array.length !== 5 || !(array[0] instanceof Name))
        throw new Error("THAW's Skater_Camera_Bike_Array isn't [undefined, near, medium, far, ltg]");
    lines.push(
        `${CAMERA_ARRAY} = [${qb.nameText(array[0].value, names)}, ${THAW_CAMERAS.map(([, ours]) => ours).join(", ")}]`,
    );
    for (const name of THAW_GLOBALS) lines.push(`${name} = ${qb.toNs(need(items, name), names)}`);
    return `${lines.join("\n")}\n`;
}

// The parked bikes (src/game/skater/thaw_bmx_parked.h): the level's own, thaw_bmx_home (THAW's bike ped - its place
// from parked.ts's thaw_bmx_home_bikes or near the start: ThawBmx_HomeSpot), and the one left where the rider got off,
// bikespot (THAW's bike spot, create_bike_spot). Each runs thaw_bmx_spot_watch: within THAW's 12 feet (its inner
// radius) of a skater who could start a ped's speech (THUG2's ped_speech_got_trigger's conditions: on the ground, not
// in a bail or a trick, no score pot) a speech box offers the ride - THUG2's create_speech_box as that shows one, with
// THAW's text and THUG2's button; Circle (pad_circle, as THUG2's speech boxes) takes it: the toggle with bike=<id>, so
// thaw_bmx_get_on walks the skater to it first (thaw_bmx_walk_to_bike: THAW's skater_walk_to_bike). THAW's own
// machinery - setup_ped_speech on an AnyObjectInRadius proximity event - needs a node in THUG2 (its
// ped_speech_die_with_trigger ends the box when NodeExists fails), which these bikes aren't.
// dont_create_speech_boxes is THAW's global (none of THUG2's scripts have it): set while getting on / off, cleared by
// THAW's bmx_finish_on / off.
export const HOME_BIKE = "thaw_bmx_home";
export const SPOT_DIALOG = "thaw_bmx_spot_dialog";
export const SPOT_RADIUS = 12; // feet (THAW's bike_spot_setup inner_radius)
export const SPOT_TEXT = "Press \\\\m5 to ride the bike.";
export function parkedScripts(): string {
    return `dont_create_speech_boxes = 0
thaw_bmx_spot_radius = ${SPOT_RADIUS}
script thaw_bmx_offer_off {
    change dont_create_speech_boxes=1
    if ScreenElementExists id=${SPOT_DIALOG} {
        DestroyScreenElement id=${SPOT_DIALOG}
    }
}
// (THAW's switch_all_bike_peds: off - the level's bike gone -, else made if missing, where the game allows it)
script thaw_bmx_home_bike {
    if GotParam off {
        if ObjectExists id=${HOME_BIKE} {
            ${HOME_BIKE}:Die
        }
        return
    }
    if ObjectExists id=${HOME_BIKE} {
        return
    }
    if ! ThawBmx_Available {
        return
    }
    if InNetGame {
        return
    }
    if InSplitScreenGame {
        return
    }
    if LevelIs Load_MainMenu {
        return
    }
    if LevelIs load_sk5ed {
        return
    }
    if GameModeEquals is_career {
        return
    }
    if GameModeEquals is_classic {
        return
    }
    if ! ObjectExists id=skater {
        return
    }
    if skater:IsSkaterOnBike {
        return
    }
    if ! ThawBmx_HomeSpot {
        return
    }
    // (the bike's skeleton and animations: loaded once for good, as getting on does)
    if ! skater:ThawBmxLoadAssets {
        return
    }
    CreateCompositeObject Components=thaw_bmx_spot_components Params={Name=${HOME_BIKE} Pos=<pos> NeverSuspend}
    if ObjectExists id=${HOME_BIKE} {
        ${HOME_BIKE}:Obj_SetOrientation y=<heading>
        ${HOME_BIKE}:Obj_PlayAnim Anim=bmx_getup Speed=0 BlendPeriod=0
        ${HOME_BIKE}:Obj_SpawnScript thaw_bmx_spot_watch
    }
}
// (a new level: the last level's bikes gone - the DLL, once the level is up)
script thaw_bmx_level_start {
    thaw_bmx_home_bike off
    if ObjectExists id=bikespot {
        bikespot:Die
    }
    change dont_create_speech_boxes=0
}
// (on a parked bike)
script thaw_bmx_spot_watch {
    Obj_GetId
    while {
        offer = 0
        if (dont_create_speech_boxes = 0) {
            if ObjectExists id=skater {
                Obj_GetDistanceToObject skater
                if (<objectDistance> < thaw_bmx_spot_radius) {
                    if skater:OnGround {
                        if ! skater:IsSkaterOnBike {
                            if ! skater:IsInBail {
                                if ! skater:DoingTrick {
                                    if ! SkaterCurrentScorePotGreaterThan 0 {
                                        offer = 1
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (<offer> = 1) {
            if ! ScreenElementExists id=${SPOT_DIALOG} {
                create_speech_box {
                    anchor_id=${SPOT_DIALOG}
                    text="${SPOT_TEXT}"
                    no_pad_choose
                    no_pad_start
                    pad_circle_script=thaw_bmx_spot_ride
                    pad_circle_params={bike=<objId>}
                    bg_rgba=[100 100 100 128]
                    text_rgba=[128 128 128 128]
                    pos=(320.0, 400.0)
                    z_priority=5
                }
                if ScreenElementExists id=${SPOT_DIALOG} {
                    ${SPOT_DIALOG}:SetTags thaw_bmx_bike=<objId>
                    ${SPOT_DIALOG}:Obj_SpawnScript thaw_bmx_spot_dialog_watch Params={bike=<objId>}
                }
            }
        } else {
            if ScreenElementExists id=${SPOT_DIALOG} {
                ${SPOT_DIALOG}:GetTags
                if GotParam thaw_bmx_bike {
                    if (<thaw_bmx_bike> = <objId>) {
                        DestroyScreenElement id=${SPOT_DIALOG}
                    }
                }
            }
        }
        wait 3 gameframes
    }
}
// (on the speech box: gone with its bike - as THUG2's ped_speech_die_with_trigger)
script thaw_bmx_spot_dialog_watch {
    while {
        if ! ObjectExists id=<bike> {
            Die
            return
        }
        wait 1 gameframe
    }
}
// (Circle on the speech box - THAW's toggle_bike_on_off On bike_ped_id: not through a wall, its
// CollisionBetweenSkaterAndPoint)
script thaw_bmx_spot_ride {
    speech_box_exit anchor_id=${SPOT_DIALOG} no_pad_start
    if ! ObjectExists id=<bike> {
        return
    }
    if skater:IsSkaterOnBike {
        return
    }
    if ! ThawBmx_BikeReachable id=<bike> {
        return
    }
    ${TOGGLE} bike=<bike>
}
// (THAW's skater_walk_to_bike, on the skater: turned to the bike, walked there, standing as it faces)
script thaw_bmx_walk_to_bike {
    if ! ThawBmx_WalkToBike id=<id> {
        PlayAnim Anim=WWalk Cycle
        frames = 0
        while {
            wait 1 gameframe
            if ThawBmx_WalkToBike id=<id> {
                break
            }
            frames = (<frames> + 1)
            if (<frames> > 300) {
                break
            }
        }
    }
    PlayAnim Anim=WStand Cycle
}`;
}

// The toggle, getting on and off, the bike's own scripts - then THAW's bike scripts (bike_scripts.ts).
export function rideScripts(thawScripts: UnitLookup): string {
    const loads = SOUNDS.map((s) => `        LoadSound "${SOUND_FOLDER}\\\\${s}"`).join("\n");
    return `thaw_bmx_wheel_circumference = ${WHEEL_CIRCUMFERENCE}
thaw_bmx_camera_swapped = 0
thaw_bmx_saved_camera_array = 0
thaw_bmx_sounds_loaded = 0
script ${TOGGLE} {
    if ! ThawBmx_Available {
        printf "thaw_bmx: off - [features] thaw_bmx=1 in thug2-decomp.ini"
        return
    }
    if InNetGame {
        return
    }
    if skater:IsSkaterOnBike {
        if skater:BikeInManual {
            return
        }
        // (not in a bail: its thrown bike and get-up are under way - phase 5)
        if skater:IsInBail {
            return
        }
        if skater:OnGround {
            thaw_bmx_offer_off
            MakeSkaterGoto thaw_bmx_get_off
        }
        return
    }
    // (THAW's toggle_bike_on_off: no speech boxes until it's done - its bmx_finish_on / off say when; a parked bike
    // to walk to: bike=<its id>)
    if skater:Walking {
        thaw_bmx_offer_off
        MakeSkaterGoto thaw_bmx_get_on Params=<...>
        return
    }
    if skater:OnGround {
        thaw_bmx_offer_off
        MakeSkaterGoto thaw_bmx_get_on Params=<...>
    }
}
script thaw_bmx_pause_toggle {
    exit_pause_menu
    ${TOGGLE}
}
${parkedScripts()}
// THAW's bike sounds (bike_sfx.qb's and its TERRAIN_BIKE_DEFAULT_* tables'; THAW loads them at start-up with its
// global sounds) - once, permanently.
script thaw_bmx_load_sounds {
    if (thaw_bmx_sounds_loaded = 0) {
${loads}
        change thaw_bmx_sounds_loaded=1
    }
}
// (THAW's toggle_bike_on_off2, getting on: tricks and exceptions off, the physics paused and the pad off for the
// getting-up animation, the stance sprite hidden, the skater turned unflipped (orient_vehicle: the bike is made
// unflipped, and a flipped rider's bmx_getup reached for it on the wrong side); then its bmx_finish_on)
script thaw_bmx_get_on {
    if ! ThawBmxLoadAssets {
        printf "thaw_bmx: the bike's assets didn't load"
        change dont_create_speech_boxes=0
        MakeSkaterGoto OnGroundAI
        return
    }
    thaw_bmx_load_sounds
    ClearExceptions
    ClearTrickQueue
    SetQueueTricks NoTricks
    SetRollingFriction 100
    PausePhysics
    DisablePlayerInput
    thaw_bmx_camera_on
    thaw_bmx_stance_sprite scale=0
    orient_vehicle
    change bike_pedaling=0
    // (THAW: off the board first, unless it's missing - from skating BrakeToStand to half way, the board put away
    // with THPS7_BoardCatch_Stand played backwards at 1.2x to its end (convert.ts brings it from THAW's skater set),
    // the board off, the standing idle WStand; THUG2 has BrakeToStand and WStand under the same names)
    if ! IsBoardMissing {
        Obj_SetBoundingSphere 10000
        if ! Walking {
            PlayAnim Anim=BrakeToStand Speed=1.3
            WaitAnim 50 Percent
        }
        PlayAnim Anim=THPS7_BoardCatch_Stand Backwards Speed=1.2
        WaitAnimFinished
        Obj_RestoreBoundingSphere
    }
    SwitchOffBoard
    PlayAnim Anim=WStand Cycle BlendPeriod=0
    // (THAW's toggle_bike_on_off2: from a parked bike, walked to it first - skater_walk_to_bike)
    if GotParam bike {
        thaw_bmx_walk_to_bike id=<bike>
    }
    bmx_finish_on
}
// (THAW's toggle_bike_on_off2, getting off: unflipped as getting on, bmx_getup backwards, the bike gone; then its
// bmx_finish_off - the run-and-jump onto the board, the parked bike)
script thaw_bmx_get_off {
    kill_bail_bike
    ClearExceptions
    ClearTrickQueue
    SetQueueTricks NoTricks
    SetRollingFriction 100
    PausePhysics
    DisablePlayerInput
    orient_vehicle
    Skater_BarspinAnimOff
    thaw_bmx_playanim anim=bmx_getup Backwards BlendPeriod=0
    thaw_bmx_waitanim
    thaw_bmx_off
    bmx_finish_off
}
script thaw_bmx_off {
    remove_all_anim_subsets
    TurnOffSpecialItem
    SwitchOnBoard
    RestoreAutoKick
    AllowRailTricks
    SetRollingFriction \`default\`
    thaw_bmx_stance_sprite scale=(0.75, 1.3)
    thaw_bmx_camera_off
}
script thaw_bmx_stance_sprite {
    if ScreenElementExists id=the_boardstance_sprite {
        DoScreenElementMorph id=the_boardstance_sprite scale=<scale>
    }
}
script thaw_bmx_after_reset {
    change dont_create_speech_boxes=0
    thaw_bmx_stance_sprite scale=(0.75, 1.3)
    kill_bail_bike
    // (the manual meter, THAW's bike_manual_state's - a reset may come in the middle of a manual)
    destroy_bike_manual_meter
    KillSpawnedScript Name=bike_play_looping_sounds
    StopBikeLoopingSounds
    SwitchOnBoard
    RestoreAutoKick
    AllowRailTricks
    thaw_bmx_camera_off
}
script thaw_bmx_camera_on {
    if (thaw_bmx_camera_swapped = 0) {
        change globalname=thaw_bmx_saved_camera_array newValue=Skater_Camera_Array resolve
        change globalname=Skater_Camera_Array newValue=${CAMERA_ARRAY} resolve
        change thaw_bmx_camera_swapped=1
        thaw_bmx_camera_mode
    }
}
script thaw_bmx_camera_off {
    if (thaw_bmx_camera_swapped = 1) {
        change globalname=Skater_Camera_Array newValue=thaw_bmx_saved_camera_array resolve
        change thaw_bmx_camera_swapped=0
        thaw_bmx_camera_mode
    }
}
script thaw_bmx_camera_mode {
    if ObjectExists id=skatercam0 {
        skatercam0:sc_setmode mode=skater_cam_0_mode
    }
}
script thaw_bmx_bike_script {
    Obj_SpawnScript thaw_bmx_bike_wheels
    Obj_SpawnScript thaw_bmx_bike_flip
}
// (THAW's tree plays the bike flipped when the rider is: Skater_Playanim's obj_is_flipped)
script thaw_bmx_bike_flip {
    GetTags
    while {
        if <ParentId>:Obj_AnimationFlipped {
            if ! Obj_AnimationFlipped {
                Obj_Flip
            }
        } else {
            if Obj_AnimationFlipped {
                Obj_Flip
            }
        }
        wait 1 gameframe
    }
}
script thaw_bmx_bike_wheels {
    GetTags
    Obj_AddAnimSubset SubsetId=FrontWheel Stage=1
    Obj_SetAnimSubsetWeight SubsetId=FrontWheel BlendWeight=1
    Obj_AddAnimSubset SubsetId=RearWheel Stage=2
    Obj_SetAnimSubsetWeight SubsetId=RearWheel BlendWeight=1
    last_speed = -1
    while {
        <ParentId>:GetSpeed
        wheel_speed = (<speed> / thaw_bmx_wheel_circumference)
        if (<wheel_speed> > 25) {
            wheel_speed = 25
        }
        change_by = (<wheel_speed> - <last_speed>)
        if (<change_by> < 0) {
            change_by = (0 - <change_by>)
        }
        // (not from=current: a cycle played from=current loops from there to the end - played again and again as
        // the speed changes it shrank to nothing, and the timeline's wrap-around (0x004814B0, single-precision x87)
        // then never ended: the game hung - phase 6. THUG2's own vehicle_animate_wheels plays the whole cycle too.)
        if (<change_by> > 0.1) {
            PlayAnim SubsetId=FrontWheel Anim=bmx_front_tire_rotate Cycle speed=<wheel_speed>
            PlayAnim SubsetId=RearWheel Anim=bmx_rear_tire_rotate Cycle speed=<wheel_speed>
            last_speed = <wheel_speed>
        }
        wait 5 gameframes
    }
}
// (tests: the automation channel's "run thaw_bmx_test_air index=3" runs Bike_AirTricks' fourth trick as its trigger
// would - its script with its parameters - on the skater; thaw_bmx_test_manual likewise Bike_ManualTricks'; for the
// game checks)
script thaw_bmx_test_air {
    SpawnSkaterScript thaw_bmx_test_air_on_skater params={index=<index>}
}
script thaw_bmx_test_air_on_skater {
    trick = (Bike_AirTricks [<index>])
    printf "thaw_bmx test: air trick %i" i=<index>
    MakeSkaterGoto (<trick>.scr) params=(<trick>.params)
}
// (a test: the rider's speed set along his facing - the automation can't hold Ollie to pedal without the bunnyhop
// its release makes: "run thaw_bmx_test_push speed=700")
script thaw_bmx_test_push {
    skater:SetSpeed <speed>
}
// (a test: the grind's balance lost as its meter's exception would start it - "run thaw_bmx_test_skatein")
script thaw_bmx_test_skatein {
    MakeSkaterGoto bike_SkateInOrBail params={FallingRight}
}
// (a test: a ped's knock-down as a chasing ped's catch sends it - "run thaw_bmx_test_knockdown"; on the bike the DLL
// sends the rider to bike_PedKnockDown)
script thaw_bmx_test_knockdown {
    MakeSkaterGoto PedKnockDown params={SetVelSpeed=350}
}
script thaw_bmx_test_manual {
    SpawnSkaterScript thaw_bmx_test_manual_on_skater params={index=<index>}
}
script thaw_bmx_test_manual_on_skater {
    trick = (Bike_ManualTricks [<index>])
    printf "thaw_bmx test: manual trick %i" i=<index>
    MakeSkaterGoto (<trick>.scr) params=(<trick>.params)
}${bikeScripts(thawScripts)}`;
}
