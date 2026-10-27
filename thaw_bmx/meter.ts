// NOT ORIGINAL - THAW's BMX for THUG2: the bike's manual meter's images. THAW draws its bike manual meter from its own
// bike scripts (bike_scripts.qb create_bike_manual_meter / update_bike_manual_meter, ported in bike_scripts.ts): a
// meter picture (bike_tailmeter, or bike_nosemeter flipped for a nose manual) turned by 0.9 degrees per point of the
// manual angle over a fixed arc (bike_arc). The pictures are loose files in THAW's data\images\panelsprites; here they
// become THUG2 images in the staging's images\thaw_bmx (make_menu_level copies images into the overlay), loaded by the
// ported meter script (LoadTexture "thaw_bmx/<name>": the texture's name is the file's).
//
// THAW's .img.wpc with DXT texels: u32 0xABADD00D, u32 0x140002, u32 0, u16 width, height (twice), u16 0x2001, u16 0x20 | the
// format (5: DXT5, 1: DXT1), u32 the texels' size, then the blocks from byte 28 - rows of blocks bottom-up like the
// 32-bit ones (loading_art.ts readWpcImg): checked by eye on bike_arc (its curve's open side up at the bottom of
// THAW's meter).
// THUG2's .img.xbx (32-bit): u32 2, u32 8, u32 width, height (the texture's), u32 0 (the format: 32-bit B G R A),
// u32 0, u16 width, height (the picture's), u32 0 (no palette), then the texels - swizzled when both sides are powers of
// two (the loader's test) and the rows bottom-up (hd_textures/ui.ts decodeImg reads them the same way).

import * as dxt from "../level_port/dxt.ts";
import { unswizzleOrder } from "../level_port/tex.ts";

// THAW's meter pictures (data\images\panelsprites\<name>.img.wpc) and the folder under images\ they go to.
export const METER_IMAGES: readonly string[] = ["bike_tailmeter", "bike_nosemeter", "bike_arc"];
export const IMAGE_FOLDER = "thaw_bmx";

export interface Picture {
    width: number;
    height: number;
    bgra: Buffer; // top-down
}

const isPow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

// A THAW DXT image (.img.wpc) as BGRA rows top-down.
export function readWpcDxtImg(data: Buffer): Picture {
    if (data.length < 28 || data.readUInt32LE(0) !== 0xabadd00d) throw new Error("not a THAW image");
    const width = data.readUInt16LE(12);
    const height = data.readUInt16LE(14);
    const format = data.readUInt16LE(22) & 0xff;
    if (format !== 5 && format !== 1) throw new Error(`THAW image format ${format}: not DXT1 / DXT5`);
    const size = dxt.levelSize(width, height, format);
    if (data.length < 28 + size) throw new Error("THAW image too short");
    // (the rows of blocks bottom-up: decoded as stored, then the texel rows turned over)
    const stored = dxt.decode(data.subarray(28, 28 + size), width, height, format);
    const bgra = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
        stored.copy(bgra, y * width * 4, (height - 1 - y) * width * 4, (height - y) * width * 4);
    return { width, height, bgra };
}

// A picture as a THUG2 32-bit .img.xbx.
export function writeImg32(picture: Picture): Buffer {
    const { width: w, height: h, bgra } = picture;
    if (bgra.length !== w * h * 4) throw new Error("picture of the wrong size");
    const head = Buffer.alloc(32);
    head.writeUInt32LE(2, 0);
    head.writeUInt32LE(8, 4);
    head.writeUInt32LE(w, 8);
    head.writeUInt32LE(h, 12);
    head.writeUInt16LE(w, 24);
    head.writeUInt16LE(h, 26);
    const texels = Buffer.alloc(w * h * 4);
    const order = isPow2(w) && isPow2(h) ? unswizzleOrder(w, h) : Array.from({ length: w * h }, (_, i) => i);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const s = (y * w + x) * 4;
            bgra.copy(texels, order[(h - 1 - y) * w + x]! * 4, s, s + 4);
        }
    return Buffer.concat([head, texels]);
}

// The staging's file for a meter picture.
export function imagePath(name: string): string {
    return `images\\${IMAGE_FOLDER}\\${name}.img.xbx`;
}
