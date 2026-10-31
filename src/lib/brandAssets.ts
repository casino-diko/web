/*
 |--------------------------------------------------------------------------
 | brand assets
 |--------------------------------------------------------------------------
 | Draws a brand slot (lib/brandSlots.ts) for the current brand
 | (lib/brand.ts), at the size of the file it replaces:
 |
 |   wordmark  the uploaded logo, fitted; else the name in Lato Black
 |   mark      the uploaded icon, fitted; else the name's first letter
 |   icon      the mark on the home-screen icons' dark square
 |   welcome   the uploaded sound for that language, else the one for all
 |             languages, else a moment of silence (the original says the
 |             former brand)
 |
 | Text is drawn as outlines (opentype.js), so no font has to be installed
 | where this runs. Results are cached per brand version.
 |
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as opentype from 'opentype.js';
import sharp from 'sharp';
import { brand, brandFile } from './brand';
import type { Slot } from './brandSlots';
import type { Db } from './db';

const PUBLIC = path.join(process.cwd(), 'public');
const ICON_BACKGROUND = '#111111';

let font: opentype.Font | null = null;
const lato = () => (font ??= opentype.parse(readFileSync(path.join(PUBLIC, 'lobby/fonts/Lato-Black.ttf')).buffer as ArrayBuffer));

/** svg path data of an opentype path (its own toPathData writes NaN into some curves) */
const n = (v: number) => String(Math.round(v * 100) / 100);
const pathData = (p: opentype.Path) => p.commands.map((c: any) => {
	switch (c.type) {
		case 'M': case 'L': return `${c.type}${n(c.x)} ${n(c.y)}`;
		case 'Q': return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
		case 'C': return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
		default: return 'Z';
	}
}).join('');

/** `text` as an svg path of `colour`, fitted inside w x h (centred) */
function textSvg (text: string, w: number, h: number, colour: string, fill = 0.86): string {
	const p = lato().getPath(text, 0, 0, 100);
	const b = p.getBoundingBox();
	const tw = Math.max(1, b.x2 - b.x1), th = Math.max(1, b.y2 - b.y1);
	const scale = Math.min((w * fill) / tw, (h * fill) / th);
	const dx = (w - tw * scale) / 2 - b.x1 * scale, dy = (h - th * scale) / 2 - b.y1 * scale;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
		`<path transform="translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${scale.toFixed(5)})" d="${pathData(p)}" fill="${colour}"/></svg>`;
}

const transparent = { r : 0, g : 0, b : 0, alpha : 0 };

/** an uploaded image fitted inside w x h, keeping its proportions; null when it can't be read */
async function fitted (data: Buffer, w: number, h: number): Promise<Buffer | null> {
	try {
		return await sharp(data, { density : 300 }).resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), { fit : 'contain', background : transparent }).png().toBuffer();
	} catch (e) {
		console.warn('[brand] an uploaded image could not be drawn:', (e as Error).message);
		return null;
	}
}

const firstLetter = (name: string) => Array.from(name.trim())[0]?.toUpperCase() || 'D';

async function mark (db: Db, name: string, w: number, h: number, colour: string): Promise<Buffer> {
	const icon = await brandFile(db, 'icon');
	const drawn = icon && await fitted(icon.data, w, h);
	if (drawn) return drawn;
	return sharp(Buffer.from(textSvg(firstLetter(name), w, h, colour, 0.9))).png().toBuffer();
}

const sizes = new Map<string, { w : number; h : number }>();

/** the replaced file's size; .ico files (sharp can't read them) are drawn at 64 x 64 */
async function sizeOf (publicPath: string) {
	if (!sizes.has(publicPath)) {
		if (publicPath.endsWith('.ico')) sizes.set(publicPath, { w : 64, h : 64 });
		else {
			const meta = await sharp(path.join(PUBLIC, publicPath)).metadata();
			sizes.set(publicPath, { w : meta.width || 64, h : meta.height || 64 });
		}
	}
	return sizes.get(publicPath)!;
}

export type Asset = { body : Buffer; type : string; version : number };

const cache = new Map<string, Asset>();

export async function brandAsset (db: Db, publicPath: string, slot: Slot): Promise<Asset> {
	const current = await brand(db);
	const key = `${current.version}|${current.name}|${publicPath}`;
	const hit = cache.get(key);
	if (hit) return hit;

	let asset: Asset;
	if (slot.kind === 'welcome') {
		const file = (await brandFile(db, `welcome-${slot.lang}`)) || (await brandFile(db, 'welcome'));
		asset = { body : file ? file.data : readFileSync(path.join(PUBLIC, 'shared/brand/silence.mp3')), type : 'audio/mpeg', version : current.version };
	} else {
		const { w, h } = await sizeOf(publicPath);
		let body: Buffer;
		if (slot.kind === 'wordmark') {
			const logo = await brandFile(db, 'logo');
			body = (logo && await fitted(logo.data, w, h)) || await sharp(Buffer.from(textSvg(current.name, w, h, slot.colour))).png().toBuffer();
		} else if (slot.kind === 'mark') {
			body = await mark(db, current.name, w, h, slot.colour);
		} else {
			const inner = Math.round(Math.min(w, h) * slot.scale);
			const m = await mark(db, current.name, inner, inner, '#d22e21');
			body = await sharp({ create : { width : w, height : h, channels : 4, background : slot.background ? ICON_BACKGROUND : transparent } })
				.composite([{ input : m, gravity : 'center' }]).png().toBuffer();
		}
		asset = { body, type : 'image/png', version : current.version };
	}

	if (cache.size > 500) cache.clear();
	cache.set(key, asset);
	return asset;
}
