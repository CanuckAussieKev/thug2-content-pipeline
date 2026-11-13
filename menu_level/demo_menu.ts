// NOT ORIGINAL - the pause menu's DEMOS (the game's src/devtools/demo.h): RECORD DEMO, PLAY DEMO and SAVE AS VIDEO,
// and STOP RECORDING while a demo records. The game's script commands Demo_Item, Demo_GetEntry, Demo_Record,
// Demo_Stop and Demo_Play answer and act; these scripts are the menus (the game's own roundbar menus, which the new
// front end restyles like the rest).
//
// A demo playing is stopped by the player: any button or stick hands the controls back (Start pauses as ever) - no
// menu item for it.

import { exitWith } from "thug2-level-converter-core/lib/cli.ts";

export const DEMO_MENU_SCRIPTS = `script demo_menu_create {
    make_new_roundbar_menu {
        title="DEMOS"
        pos=(130.0, 100.0)
        spacing=6
        pad_back_script=generic_menu_pad_back
        pad_back_params={callback=create_pause_menu}
    }
    pause_menu_gradient
    if Demo_Item item=record {
        add_roundbar_menu_item text="RECORD DEMO" id=menu_demo_record pad_choose_script=demo_menu_record
    } else {
        add_roundbar_menu_item text="RECORD DEMO" id=menu_demo_record not_focusable
    }
    add_roundbar_menu_item text="PLAY DEMO" id=menu_demo_play pad_choose_script=demo_list_create pad_choose_params={mode=play}
    add_roundbar_menu_item text="SAVE AS VIDEO" id=menu_demo_video pad_choose_script=demo_list_create pad_choose_params={mode=video}
    roundbar_menu_finish
}
script demo_list_create {
    if (<mode> = video) {
        title = "SAVE AS VIDEO"
    } else {
        title = "PLAY DEMO"
    }
    make_new_roundbar_menu {
        title=<title>
        pos=(130.0, 100.0)
        spacing=6
        pad_back_script=generic_menu_pad_back
        pad_back_params={callback=demo_menu_create}
    }
    pause_menu_gradient
    index = 0
    while {
        if ! Demo_GetEntry index=<index> {
            break
        }
        FormatText ChecksumName=item_id "menu_demo_entry_%i" i=<index>
        add_roundbar_menu_item text=<demo_text> id=<item_id> tip_text=<demo_name> pad_choose_script=demo_list_choose pad_choose_params={index=<index> mode=<mode>}
        index = (<index> + 1)
    }
    if (<index> = 0) {
        add_roundbar_menu_item text="NO DEMOS" id=menu_demo_none not_focusable
    }
    roundbar_menu_finish
}
script demo_list_choose {
    if (<mode> = video) {
        Demo_Play index=<index> video
    } else {
        Demo_Play index=<index>
    }
}
script demo_menu_record {
    Demo_Record
}
script demo_menu_stop {
    Demo_Stop
    create_pause_menu
}
`;

// The pause menu's DEMOS item (or STOP RECORDING) after YOUR OPTIONS - before the DEBUG OPTIONS block addLevelEditor
// put there (and RIDE BMX, which thaw_bmx's addPauseItem puts before that) - and the scripts above. Single player only:
// the item is inside the menu's `if ! InNetGame` with YOUR OPTIONS, and Demo_Item answers false in a network game.
export function addDemoMenu(text: string): string {
    const at = text.search(/\n( *)if ! CD \{\n( *)add_roundbar_menu_item text="DEBUG OPTIONS"/);
    if (at < 0) exitWith("gamemenu_pause.qb: the DEBUG OPTIONS item not found (addLevelEditor first)");
    const indent = /\n( *)if/.exec(text.slice(at))![1]!;
    const item = (label: string, script: string, id: string): string =>
        `${indent}    add_roundbar_menu_item text="${label}" id=${id} pad_choose_script=${script} \n`;
    const block =
        `${indent}if Demo_Item item=recording {\n${item("STOP RECORDING", "demo_menu_stop", "menu_demo_stop")}` +
        `${indent}} else {\n${indent}    if Demo_Item item=menu {\n` +
        `    ${item("DEMOS", "demo_menu_create", "menu_demos")}${indent}    } \n${indent}} \n`;
    text = text.slice(0, at + 1) + block + text.slice(at + 1);
    const register = text.indexOf("\n__register_checksums__");
    const end = register >= 0 ? register + 1 : text.length;
    return text.slice(0, end) + DEMO_MENU_SCRIPTS + text.slice(end);
}
