#!/usr/bin/env node
/*
 |--------------------------------------------------------------------------
 | recolor
 |--------------------------------------------------------------------------
 | Recolours legacy image assets to the lobby / game palette (black, lime
 | and silver), in place. Pixels are moved by hue, so shading, anti-aliasing
 | and transparency survive:
 |
 |   gold   : warm yellows / golds         -> silver   (#d3d8df family)
 |   red    : bright reds                  -> lime     (#a3e635 family)
 |   maroon : dark reds / maroons          -> black / graphite
 |
 | Only the rules you name apply, and only to the files you name: images
 | that carry game meaning (Player blue, Banker red, Tie green, Dragon /
 | Tiger, chips, cards) must not be passed in.
 |
 |   node scripts/recolor.mjs --map gold,red,maroon public/lobby/img/x.png ...
 |   node scripts/recolor.mjs --map gold --dry public/poker/img/menu/*.png
 |
 | --dry reports how many pixels each file would change, writes nothing.
 |
 */

import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PALETTE = {
	black    : '#0c0d0f',
	graphite : '#16181c',
	lime     : '#a3e635',
	silver   : '#d3d8df',
	onLime   : '#0c0d0f'
};

const args = process.argv.slice(2);
const mapAt = args.indexOf('--map');
const rules = mapAt >= 0 ? String(args[mapAt + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : [];
const dry = args.includes('--dry');
const files = args.filter((a, i) => !a.startsWith('--') && i !== mapAt + 1);

if (!rules.length || !files.length || rules.some(r => !['gold', 'red', 'maroon'].includes(r))) {
	console.error('usage: node scripts/recolor.mjs --map gold,red,maroon [--dry] <image files>');
	process.exit(1);
}

function rgbToHsl (r, g, b) {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h;
	if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return [h * 60, s, l];
}

function hslToRgb (h, s, l) {
	h /= 360;
	if (s === 0) return [l * 255, l * 255, l * 255];
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const t = x => {
		if (x < 0) x += 1;
		if (x > 1) x -= 1;
		if (x < 1 / 6) return p + (q - p) * 6 * x;
		if (x < 1 / 2) return q;
		if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
		return p;
	};
	return [t(h + 1 / 3) * 255, t(h) * 255, t(h - 1 / 3) * 255];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isRed = h => h >= 340 || h <= 18;

/** the new [h, s, l] for one pixel, or null to leave it */
function remap (h, s, l) {
	if (rules.includes('maroon') && isRed(h) && s >= 0.3 && l < 0.3) {
		return [220, 0.08, clamp(l * 0.55, 0.02, 0.2)];
	}
	if (rules.includes('red') && isRed(h) && s >= 0.35 && l >= 0.3 && l <= 0.85) {
		return [84, 0.76, clamp(0.36 + (l - 0.3) * 0.5, 0.36, 0.72)];
	}
	if (rules.includes('gold') && h >= 28 && h <= 62 && s >= 0.22 && l >= 0.12 && l <= 0.95) {
		return [215, 0.1, clamp(l * 1.08, 0.12, 0.95)];
	}
	return null;
}

async function recolor (file) {
	const input = await readFile(file);
	const img = sharp(input);
	const meta = await img.metadata();
	const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject : true });
	let changed = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] === 0) continue;
		const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
		const to = remap(h, s, l);
		if (!to) continue;
		const [r, g, b] = hslToRgb(...to);
		data[i] = Math.round(r); data[i + 1] = Math.round(g); data[i + 2] = Math.round(b);
		changed++;
	}
	if (!dry && changed) {
		let out = sharp(data, { raw : { width : info.width, height : info.height, channels : 4 } });
		const ext = path.extname(file).toLowerCase();
		out = ext === '.jpg' || ext === '.jpeg' ? out.flatten({ background : '#000000' }).jpeg({ quality : 90 })
			: ext === '.webp' ? out.webp({ quality : 90 })
			: out.png({ compressionLevel : 9 });
		await writeFile(file, await out.toBuffer());
	}
	const share = ((changed / (info.width * info.height)) * 100).toFixed(1);
	console.log(`${dry ? 'would change' : 'changed'} ${changed} px (${share}%)  ${file}  ${meta.width}x${meta.height}`);
}

for (const file of files) {
	try {
		await recolor(file);
	} catch (e) {
		console.error(`skipped ${file}: ${e.message}`);
	}
}
