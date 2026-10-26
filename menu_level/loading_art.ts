// NOT ORIGINAL - the ported levels' own loading pictures for the new front end's level select. Every ported game has pictures of its own that it showed while a level loaded (or, THP8, on its
// level select); this finds them in the user's (read-only) installs, maps them to our ported levels, and writes them as
// THUG2 loading screens - images\loadscrn_<game>_<level>.img.xbx in the data overlay, 640 x 448, 32-bit, the stored
// rows bottom-up - so that
//   - frontend\levels.json (frontend_levels.ts) names them in each level's `art` (the new front end draws the level's
//     art full-bleed), and
//   - the same name goes into the level's loading_screen in Levels.qb, so the game's own loading screen shows the same
//     picture;
//   - with make_menu_level.ts --hd-ui 4 the HD pass (hd_textures/ui.ts) takes them as loading screens (their names start
//     with loadscrn): x4 DXT1, cached.
//
// Where each game keeps them, and which picture is which level's (the evidence is each game's own scripts):
//   THPS3   Data\images\loadscrn_<level>.png (8-bit RGB 640 x 448). Data\Scripts\levels.qb's LevelLoadingScreens: the
//           level's flag (Foundry, Canada, Suburbia, SI, Airport, Rio, LA, Tokyo, Ship, Warehouse, Burnside, Roswell,
//           Tutorials) -> DisplayLoadingScreen "images\loadscrn_<x>.png"; SI / Rio / Tokyo have a _comp one for the
//           career: the plain one is the free skate's.
//   THPS4   Data\images\loadscrn_<x>img.dat (the .img layout, 640 x 448). Data\scripts\Levels.qb: each Level_<x>
//           structure's loading_screen (Level_Alc "loadscrn_alcatraz", Level_Sch "loadscrn_col", ...).
//   THUG1   Data\images\loadscrn_<x>.img, the same layout. Data\pre\qb.pre's scripts\game\Levels.qb: each Level_<x>
//           structure's loading_screen (Level_NJ "loadscrn_jersey", Level_SE (Hotter Than Hell) "loadscrn_secret",
//           Level_VN "loadscrn_THPS2_ven"...).
//   THAW    Data\images\loadscrn_<x>.img.wpc (28 byte header, then 640 x 448 BGRA). Data\pak\qb.pak.wpc's
//           scripts\game\levels.qb: Level_Z_<x> loading_screen_default / _classic / _multi; loading_screens.qb's
//           load_level_handle_loading_screen takes _classic only in classic mode, _multi online / split screen, and
//           _default otherwise (so in free skate).
//   THPS2   ALL.PKR's data\*.bmp (8-bit, 512 x 240, stretched to 4:3 on screen): load_con, load_fre, load_hor,
//           load_sin, load_tag, load_trk, loadingg / p / t are the *game mode's* loading screens (career, free
//           skate, horse, single session, tag, trick attack...), not one per level - and s2bgd0..12 the level select's
//           backdrops (see THPS2_ART).
//   THP8    No loading screen per level (every Level_Z_<x> says loading_screen_default="loadscrn_generic"). The level
//           select (PAK\levelselect.pak.xen: level_select_ui_<x>'s images=[...]) has a picture per area instead:
//           Xbox 360 images, DXT5, tiled (xenos.ts).

import { decodePng, encodePng } from "../game/frame_diff.ts";
import * as dxt from "../level_port/dxt.ts";

export const SCREEN_W = 640;
export const SCREEN_H = 448;

// A picture, top row first, B G R A.
export interface Picture {
    width: number;
    height: number;
    bgra: Buffer;
}

// --- readers ----------------------------------------------------------------------------------------------------

// A PNG (8-bit RGB / RGBA, no interlacing: frame_diff.ts's reader).
export function readPng(data: Buffer): Picture {
    const image = decodePng(data);
    const bgra = Buffer.alloc(image.width * image.height * 4);
    for (let i = 0, j = 0; i < image.rgb.length; i += 3, j += 4) {
        bgra[j] = image.rgb[i + 2]!;
        bgra[j + 1] = image.rgb[i + 1]!;
        bgra[j + 2] = image.rgb[i]!;
        bgra[j + 3] = 255;
    }
    return { width: image.width, height: image.height, bgra };
}

// THPS4's .img.dat and THUG1's .img (and THUG2's .img.xbx, 32-bit): u32 2, u32 ?, u32 texture width, height (THPS4's
// hold something else), u32 format 0 (A8R8G8B8), u32 0, u16 picture width, height, u32 palette size 0, then the rows
// bottom-up, B G R A.
export function readImg(data: Buffer): Picture {
    const width = data.readUInt16LE(24);
    const height = data.readUInt16LE(26);
    if (data.readUInt32LE(0) !== 2 || data.readUInt32LE(16) !== 0 || data.readUInt32LE(28) !== 0)
        throw new Error("not a 32-bit .img");
    if (data.length < 32 + width * height * 4) throw new Error(".img too short");
    const bgra = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
        data.copy(bgra, y * width * 4, 32 + (height - 1 - y) * width * 4, 32 + (height - y) * width * 4);
    return { width, height, bgra };
}

// THAW's .img.wpc: u32 0xABADD00D, u32 0x140002, u32 0, u16 width, height (twice), u32 0x2001, u16 .., then B G R A
// from byte 28, the rows bottom-up (checked by eye: THAW's pictures come out upside down otherwise).
export function readWpcImg(data: Buffer): Picture {
    if (data.readUInt32LE(0) !== 0xabadd00d) throw new Error("not a THAW image");
    const width = data.readUInt16LE(12);
    const height = data.readUInt16LE(14);
    if (data.length < 28 + width * height * 4) throw new Error(".img.wpc too short");
    const bgra = Buffer.alloc(width * height * 4);
    // (the rows bottom-up, as the other games' images)
    for (let y = 0; y < height; y++)
        data.copy(bgra, y * width * 4, 28 + (height - 1 - y) * width * 4, 28 + (height - y) * width * 4);
    return { width, height, bgra };
}

// THP8's .img (Xbox 360, big-endian; PAK\levelselect.pak.xen's pictures and IMAGES\LOADINGSCREENS\*.img.xen): a 4 KB
// header - u32 0x0A281100, 0, then the texture fetch constant's words: +12 width (low 13 bits), +16 height (bits 16-28),
// +20 the format in bits 8-15 (5: DXT5, 1: DXT1) - and the DXT blocks (16-bit byte swapped; linear, not tiled, each
// row of blocks padded to 32 blocks) from 4096.
export function readXenImg(data: Buffer): Picture {
    const width = data.readUInt32BE(12) & 0x1fff;
    const height = (data.readUInt32BE(16) >>> 16) & 0x1fff;
    const kind = (data.readUInt32BE(20) >>> 8) & 0xff;
    const dxtKind = kind === 5 ? 5 : kind === 1 ? 1 : 0;
    if (data.readUInt32BE(0) !== 0x0a281100 || !dxtKind || !width || !height) throw new Error("not a THP8 DXT image");
    const bpb = dxtKind === 5 ? 16 : 8;
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    // (rows of blocks in a pitch aligned to 32 blocks; not tiled)
    const pitch = (bw + 31) & ~31;
    const blocks = Buffer.alloc(bw * bh * bpb);
    const src = Buffer.from(data.subarray(4096));
    src.swap16();
    for (let y = 0; y < bh; y++) {
        const from = y * pitch * bpb;
        if (from + bw * bpb > src.length) throw new Error("THP8 image: data too short");
        src.copy(blocks, y * bw * bpb, from, from + bw * bpb);
    }
    return { width, height, bgra: dxt.decode(blocks, width, height, dxtKind) };
}

// An 8-bit uncompressed Windows BMP (THPS2's backdrops), rows bottom-up.
export function readBmp8(data: Buffer): Picture {
    if (data.toString("latin1", 0, 2) !== "BM") throw new Error("not a BMP");
    const offset = data.readUInt32LE(10);
    const header = data.readUInt32LE(14);
    const width = data.readInt32LE(18);
    const rawHeight = data.readInt32LE(22);
    const bits = data.readUInt16LE(28);
    if (bits !== 8 || data.readUInt32LE(30) !== 0) throw new Error("only uncompressed 8-bit BMPs");
    const height = Math.abs(rawHeight);
    const colours = data.readUInt32LE(46) || 256;
    const palette = 14 + header;
    const stride = (width + 3) & ~3;
    const bgra = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = rawHeight > 0 ? height - 1 - y : y;
        for (let x = 0; x < width; x++) {
            const index = data[offset + row * stride + x]!;
            if (index >= colours) continue;
            const p = palette + index * 4;
            const o = (y * width + x) * 4;
            bgra[o] = data[p]!;
            bgra[o + 1] = data[p + 1]!;
            bgra[o + 2] = data[p + 2]!;
            bgra[o + 3] = 255;
        }
    }
    return { width, height, bgra };
}

// --- resizing / writing -----------------------------------------------------------------------------------------

// The picture stretched to w x h (an area average going down, bilinear going up).
export function resize(picture: Picture, w: number, h: number): Picture {
    if (picture.width === w && picture.height === h) return picture;
    const out = Buffer.alloc(w * h * 4);
    const sx = picture.width / w;
    const sy = picture.height / h;
    for (let y = 0; y < h; y++) {
        const y0 = y * sy;
        const y1 = (y + 1) * sy;
        for (let x = 0; x < w; x++) {
            const x0 = x * sx;
            const x1 = (x + 1) * sx;
            const sum = [0, 0, 0, 0];
            let weight = 0;
            if (sx <= 1 && sy <= 1) {
                // (bilinear: the pixel centres)
                const fx = Math.min(Math.max(x0 + sx / 2 - 0.5, 0), picture.width - 1);
                const fy = Math.min(Math.max(y0 + sy / 2 - 0.5, 0), picture.height - 1);
                const ix = Math.floor(fx);
                const iy = Math.floor(fy);
                const jx = Math.min(ix + 1, picture.width - 1);
                const jy = Math.min(iy + 1, picture.height - 1);
                const ax = fx - ix;
                const ay = fy - iy;
                for (let c = 0; c < 4; c++) {
                    const p = (xx: number, yy: number): number => picture.bgra[(yy * picture.width + xx) * 4 + c]!;
                    const v =
                        (p(ix, iy) * (1 - ax) + p(jx, iy) * ax) * (1 - ay) +
                        (p(ix, jy) * (1 - ax) + p(jx, jy) * ax) * ay;
                    out[(y * w + x) * 4 + c] = Math.round(v);
                }
                continue;
            }
            for (let yy = Math.floor(y0); yy < Math.min(Math.ceil(y1), picture.height); yy++) {
                const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
                for (let xx = Math.floor(x0); xx < Math.min(Math.ceil(x1), picture.width); xx++) {
                    const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
                    const wgt = wx * wy;
                    const p = (yy * picture.width + xx) * 4;
                    for (let c = 0; c < 4; c++) sum[c]! += picture.bgra[p + c]! * wgt;
                    weight += wgt;
                }
            }
            for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = Math.round(sum[c]! / weight);
        }
    }
    return { width: w, height: h, bgra: out };
}

// THUG2's loading screen file (images\<name>.img.xbx): the header of its own loadscrn_*.img.xbx (u32 2, u32 8, 640,
// 448, format 0, ..., u16 640, 448), then the rows bottom-up, 32-bit, the alpha made opaque.
export function nativeImg(picture: Picture): Buffer {
    const { width, height } = picture;
    const head = Buffer.alloc(32);
    head.writeUInt32LE(2, 0);
    head.writeUInt32LE(8, 4);
    head.writeUInt32LE(width, 8);
    head.writeUInt32LE(height, 12);
    head.writeUInt16LE(width, 24);
    head.writeUInt16LE(height, 26);
    const rows = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        picture.bgra.copy(rows, (height - 1 - y) * width * 4, y * width * 4, (y + 1) * width * 4);
    }
    for (let i = 3; i < rows.length; i += 4) rows[i] = 255;
    return Buffer.concat([head, rows]);
}

// A picture as a PNG (checking pictures by eye).
export function toPng(picture: Picture): Buffer {
    const rgb = new Uint8Array(picture.width * picture.height * 3);
    for (let i = 0, j = 0; i < picture.bgra.length; i += 4, j += 3) {
        rgb[j] = picture.bgra[i + 2]!;
        rgb[j + 1] = picture.bgra[i + 1]!;
        rgb[j + 2] = picture.bgra[i]!;
    }
    return encodePng({ width: picture.width, height: picture.height, rgb });
}

// A THP8 level select card (a torn photo with an alpha edge) over its own generic loading screen: the card cropped to
// what it draws and fitted in the middle of the 640 x 448 backdrop.
export function composeCard(card: Picture, backdrop: Picture): Picture {
    let x0 = card.width;
    let y0 = card.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < card.height; y++)
        for (let x = 0; x < card.width; x++)
            if (card.bgra[(y * card.width + x) * 4 + 3]! > 40) {
                x0 = Math.min(x0, x);
                y0 = Math.min(y0, y);
                x1 = Math.max(x1, x);
                y1 = Math.max(y1, y);
            }
    if (x1 < 0) throw new Error("THP8 card: nothing drawn");
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    const crop = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
        const from = ((y0 + y) * card.width + x0) * 4;
        card.bgra.copy(crop, y * cw * 4, from, from + cw * 4);
    }
    const scale = Math.min(600 / cw, 420 / ch);
    const w = Math.round(cw * scale);
    const h = Math.round(ch * scale);
    const fitted = resize({ width: cw, height: ch, bgra: crop }, w, h);
    const out = Buffer.from(resize(backdrop, SCREEN_W, SCREEN_H).bgra);
    const ox = (SCREEN_W - w) >> 1;
    const oy = (SCREEN_H - h) >> 1;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const s = (y * w + x) * 4;
            const d = ((oy + y) * SCREEN_W + ox + x) * 4;
            const a = fitted.bgra[s + 3]! / 255;
            for (let c = 0; c < 3; c++) out[d + c] = Math.round(fitted.bgra[s + c]! * a + out[d + c]! * (1 - a));
        }
    return { width: SCREEN_W, height: SCREEN_H, bgra: out };
}

// The part of a picture a text-free front end variant shows (frontend_art.ts): the crop (x, y = its top left as
// fractions of the width / height, s = its size as a fraction of both, so it keeps the picture's aspect) stretched
// back to w x h.
export function cropFraction(picture: Picture, x: number, y: number, s: number, w: number, h: number): Picture {
    const cw = Math.max(1, Math.round(picture.width * s));
    const ch = Math.max(1, Math.round(picture.height * s));
    const x0 = Math.min(Math.max(0, Math.round(picture.width * x)), picture.width - cw);
    const y0 = Math.min(Math.max(0, Math.round(picture.height * y)), picture.height - ch);
    const bgra = Buffer.alloc(cw * ch * 4);
    for (let row = 0; row < ch; row++) {
        const from = ((y0 + row) * picture.width + x0) * 4;
        picture.bgra.copy(bgra, row * cw * 4, from, from + cw * 4);
    }
    return resize({ width: cw, height: ch, bgra }, w, h);
}

// The photo of a THP8 level select card (a torn photo with an alpha edge) without the torn edge and the backdrop: the
// largest rectangle of the drawn area's aspect w x h, centred on the drawn area, whose border is all opaque, taken in
// by `margin` pixels, stretched to w x h.
export function cardPhoto(card: Picture, w: number, h: number, margin = 6): Picture {
    let x0 = card.width;
    let y0 = card.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < card.height; y++)
        for (let x = 0; x < card.width; x++)
            if (card.bgra[(y * card.width + x) * 4 + 3]! > 40) {
                x0 = Math.min(x0, x);
                y0 = Math.min(y0, y);
                x1 = Math.max(x1, x);
                y1 = Math.max(y1, y);
            }
    if (x1 < 0) throw new Error("THP8 card: nothing drawn");
    const cx = (x0 + x1 + 1) / 2;
    const cy = (y0 + y1 + 1) / 2;
    const alphaAt = (x: number, y: number): number => card.bgra[(y * card.width + x) * 4 + 3]!;
    // (the border of the rectangle with half width hw: every pixel opaque)
    const opaque = (hw: number): boolean => {
        const hh = (hw * h) / w;
        const l = Math.round(cx - hw);
        const r = Math.round(cx + hw) - 1;
        const t = Math.round(cy - hh);
        const b = Math.round(cy + hh) - 1;
        if (l < 0 || t < 0 || r >= card.width || b >= card.height) return false;
        for (let x = l; x <= r; x++) if (alphaAt(x, t) < 255 || alphaAt(x, b) < 255) return false;
        for (let y = t; y <= b; y++) if (alphaAt(l, y) < 255 || alphaAt(r, y) < 255) return false;
        return true;
    };
    let hw = Math.min(cx - x0, x1 + 1 - cx, ((cy - y0) * w) / h, ((y1 + 1 - cy) * w) / h);
    while (hw > 8 && !opaque(hw)) hw -= 1;
    hw -= margin;
    const hh = (hw * h) / w;
    const pw = Math.round(hw * 2);
    const ph = Math.round(hh * 2);
    const px = Math.round(cx - hw);
    const py = Math.round(cy - hh);
    const bgra = Buffer.alloc(pw * ph * 4);
    for (let row = 0; row < ph; row++) {
        const from = ((py + row) * card.width + px) * 4;
        card.bgra.copy(bgra, row * pw * 4, from, from + pw * 4);
    }
    for (let i = 3; i < bgra.length; i += 4) bgra[i] = 255;
    return resize({ width: pw, height: ph, bgra }, w, h);
}
