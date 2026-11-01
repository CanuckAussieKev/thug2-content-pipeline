// NOT ORIGINAL - this repository's root (the content pipeline: menu_level, hd_textures, fonts, thug2_levels,
// thaw_bmx), for its own data (fonts/, menu_level/scenic_art/...). Where the project and the decomp are:
// thug2-level-converter-core's lib/decomp.ts.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PIPELINE = path.dirname(fileURLToPath(import.meta.url));
