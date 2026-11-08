import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { detect, GAMES, importedLevels, levelLine, parseListLine, titleCase } from "./import_levels.ts";

function folderWith(files: readonly string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-levels-"));
    for (const file of files) {
        const full = path.join(root, ...file.split("/").filter((p) => p));
        if (file.endsWith("/")) {
            fs.mkdirSync(full, { recursive: true });
            continue;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "");
    }
    return root;
}

test("detect tells the games apart by their files", () => {
    const thps3 = folderWith(["Data/Levels/Foun/"]);
    const thps4 = folderWith(["Game/data/levels/Alc/", "Game/data/skeletons/"]);
    const thp8 = folderWith([
        "game/DATA/COMPRESSED/compress.toc.xen",
        "game/DATA/COMPRESSED/PAK/qb.pak.xen",
        "game/DATA/COMPRESSED/ZONES/z_houses.pak.xen",
    ]);
    const thpg = folderWith([
        "PG/DATA/COMPRESSED/compress.toc.xen",
        "PG/DATA/COMPRESSED/PAK/qb.pak.xen",
        "PG/DATA/COMPRESSED/ZONES/z_love.pak.xen",
    ]);
    const thug2 = folderWith(["Game/THUG2.exe", "Game/data/levels/", "Game/data/skeletons/"]);
    const none = folderWith(["readme.txt"]);
    try {
        assert.deepEqual(detect(thps3), { game: "thps3", folder: thps3 });
        assert.equal((detect(thps4) as { game: string }).game, "thps4");
        assert.equal((detect(thp8) as { game: string }).game, "thp8");
        // (one folder down)
        assert.deepEqual(detect(thpg), { game: "thpg", folder: path.join(thpg, "PG") });
        assert.equal(detect(thug2), "thug2");
        assert.equal(detect(none), null);
    } finally {
        for (const f of [thps3, thps4, thp8, thpg, thug2, none]) fs.rmSync(f, { recursive: true, force: true });
    }
});

test("a THP8 / THPG list line", () => {
    assert.deepEqual(
        parseListLine("thp8_net_skatepark         114  SKATE PARK           z_cretepark + z_online_skatepark"),
        {
            id: "thp8_net_skatepark",
            title: "Skate Park",
            place: "z_cretepark + z_online_skatepark",
            byDefault: true,
            missing: false,
        },
    );
    assert.equal(parseListLine(""), null);
    assert.equal(titleCase("SKATE & FUN PARKS"), "Skate & Fun Parks");
    assert.equal(titleCase("THPS3'S SHOP"), "Thps3's Shop");
    assert.equal(titleCase("SCHOOL II"), "School II");
    assert.equal(titleCase("NY CITY"), "NY City");
});

test("list lines and the imported levels", () => {
    const thug2 = folderWith([]);
    try {
        fs.mkdirSync(path.join(thug2, GAMES.thps3.staging));
        fs.writeFileSync(
            path.join(thug2, GAMES.thps3.staging, "levels.json"),
            JSON.stringify({
                levels: [
                    { folder: "Foun", level: "foun" },
                    { folder: "Ap", level: "thps3_ap" },
                ],
            }),
        );
        const imported = importedLevels(thug2, "thps3");
        assert.equal(imported.get("foun"), "Load_foun");
        assert.equal(imported.get("ap"), "Load_thps3_ap");
        assert.equal(importedLevels(thug2, "thps4").size, 0);
        const level = { id: "Ap", title: "Airport", place: "", byDefault: true, missing: false };
        assert.equal(levelLine(level, imported.get("ap")), "level\tAp\tAirport\t-\tdefault,imported\tLoad_thps3_ap\t-");
        assert.equal(levelLine({ ...level, byDefault: false }, undefined), "level\tAp\tAirport\t-\t-\t-\t-");
    } finally {
        fs.rmSync(thug2, { recursive: true, force: true });
    }
});
