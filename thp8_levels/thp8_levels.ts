// NOT ORIGINAL - Tony Hawk's Project 8's levels (the Xbox 360 game's data) converted to THUG2's formats: the command
// line (README.md). The converter itself is thp8/thp8_levels.ts in thug2-level-converter-core: Proving Ground's
// converter runs it too, with its own game profile.
//
//   node thp8_levels/thp8_levels.ts convert [levels...] [--thp8 C:\Games\THP8] [--thug2 C:\Games\THUG2]
//   node thp8_levels/thp8_levels.ts selfcheck | list

import { isMain, runMain } from "../lib/py.ts";
import { main } from "../thp8/thp8_levels.ts";

if (isMain(import.meta.url)) await runMain(() => main());
