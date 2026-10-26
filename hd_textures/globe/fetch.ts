// NOT ORIGINAL - fetches Natural Earth's public-domain physical vectors (land, lakes; 1:110m and 1:50m) that
// tools/pipeline/hd_textures/globe/redraw.ts draws the level select's globe tiles from. One download each from the
// natural-earth-vector GitHub mirror, SHA-256 checked, into out\natural_earth\ (git-ignored: nothing is committed).
// Never runs by itself.  "Made with Natural Earth" (THIRD_PARTY_NOTICES.md).
//
//     node tools/pipeline/hd_textures/globe/fetch.ts [--force]

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO } from "../../level_port/common.ts";
import { isMain, print, pyExit, runMain } from "../../lib/py.ts";

export const BASE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/";
export const NE_DIR = path.join(REPO, "out", "natural_earth");
export const FILES: Readonly<Record<string, string>> = {
    "ne_110m_land.geojson": "9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9",
    "ne_110m_lakes.geojson": "eb02ecc86c82004fccbf979058bfabbbd6c2d07968c7844d38eb1c9152d2ffc9",
    "ne_50m_land.geojson": "e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b",
    "ne_50m_lakes.geojson": "d350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52",
};

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
    // (-h / --help or anything unknown: the usage, no download)
    if (argv.some((a) => a !== "--force")) {
        print(`usage: fetch.ts [--force]   (downloads ${Object.keys(FILES).join(", ")} into ${NE_DIR})`);
        return argv.includes("-h") || argv.includes("--help") ? 0 : 2;
    }
    const force = argv.includes("--force");
    fs.mkdirSync(NE_DIR, { recursive: true });
    for (const [name, sha] of Object.entries(FILES)) {
        const file = path.join(NE_DIR, name);
        if (fs.existsSync(file) && !force) {
            if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== sha)
                pyExit(`${file}: SHA-256 differs from the recorded one (use --force to download again)`);
            print(`already there: ${name}`);
            continue;
        }
        print(`downloading ${BASE_URL}${name}`);
        const response = await fetch(BASE_URL + name);
        if (!response.ok) pyExit(`download failed: HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        const hash = createHash("sha256").update(data).digest("hex");
        if (hash !== sha) pyExit(`${name}: SHA-256 mismatch: got ${hash}, expected ${sha} - not written`);
        fs.writeFileSync(file, data);
    }
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
