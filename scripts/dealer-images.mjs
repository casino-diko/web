#!/usr/bin/env node
/*
 |--------------------------------------------------------------------------
 | dealer images
 |--------------------------------------------------------------------------
 | Turns dealer portraits (square PNGs on a transparent background, the
 | figure centred, head and shoulders) into the pictures the lobby and games
 | show: a square crop around the figure, on a dark round background, 120x120
 | PNG with transparent corners (the pages frame it in a ring and centre it).
 |
 |   node scripts/dealer-images.mjs <source folder> [--size 120]
 |
 | Each <name>.png in the folder becomes
 | public/lobby/image/dealers/portraits/<name>.png; dealers point at it
 | through dealers.dealer_image (/lobby/image/dealers/portraits/<name>.png).
 |
 | --poses: half-body poses for the game screens (public/shared/table-dealer
 | stands one behind the betting table). Kept on their transparent
 | background, scaled to --size (default 640) px tall, saved under the
 | portrait's name with "_pose" dropped (dealer_pose_07.png ->
 | public/lobby/image/dealers/poses/dealer_07.png), so a dealer's pose is
 | found from their portrait.
 |
 |   node scripts/dealer-images.mjs <poses folder> --poses
 |
 */

import sharp from 'sharp';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/lobby/image/dealers/portraits');
const BACKGROUND = '#1f2228';

const source = process.argv[2];
const POSES = process.argv.includes('--poses');
const sizeAt = process.argv.indexOf('--size');
const SIZE = sizeAt > 0 ? Number(process.argv[sizeAt + 1]) : POSES ? 640 : 120;
if (!source) {
	console.error('usage: node scripts/dealer-images.mjs <source folder> [--size 120]');
	process.exit(1);
}

/** the square around the figure: as wide as its tallest side, centred, flush with the bottom */
async function cropBox (file) {
	const { data, info } = await sharp(file).ensureAlpha().extractChannel('alpha').raw().toBuffer({ resolveWithObject : true });
	let left = info.width, top = info.height, right = -1, bottom = -1;
	for (let y = 0; y < info.height; y++) {
		for (let x = 0; x < info.width; x++) {
			if (data[y * info.width + x] > 16) {
				if (x < left) left = x;
				if (x > right) right = x;
				if (y < top) top = y;
				if (y > bottom) bottom = y;
			}
		}
	}
	if (right < 0) return { left : 0, top : 0, width : info.width, height : info.height };
	const pad = Math.round(info.width * 0.03);
	const side = Math.min(info.width, info.height, Math.max(right - left, bottom - top) + 2 * pad);
	const cx = (left + right) / 2;
	const x = Math.round(Math.min(Math.max(cx - side / 2, 0), info.width - side));
	const y = Math.round(Math.min(Math.max(bottom + pad - side, 0), info.height - side));
	return { left : x, top : y, width : side, height : side };
}

const files = (await readdir(source)).filter(f => f.toLowerCase().endsWith('.png')).sort();

if (POSES) {
	const out = path.join(ROOT, 'public/lobby/image/dealers/poses');
	await mkdir(out, { recursive : true });
	for (const name of files) {
		// same canvas for every pose (no trimming), so all of them stand on the same line
		const file = path.join(source, name);
		const target = path.join(out, name.toLowerCase().replace('_pose', ''));
		await writeFile(target, await sharp(file).resize({ height : SIZE }).png({ compressionLevel : 9 }).toBuffer());
		console.log(path.relative(ROOT, target));
	}
	process.exit(0);
}

await mkdir(OUT, { recursive : true });
for (const name of files) {
	const file = path.join(source, name);
	const figure = await sharp(file).extract(await cropBox(file)).resize(SIZE, SIZE).png().toBuffer();
	const r = SIZE / 2;
	const disc = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><circle cx="${r}" cy="${r}" r="${r}" fill="${BACKGROUND}"/></svg>`);
	const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`);
	const out = await sharp(disc)
		.composite([{ input : figure }, { input : mask, blend : 'dest-in' }])
		.png({ compressionLevel : 9 })
		.toBuffer();
	const target = path.join(OUT, name.toLowerCase());
	await writeFile(target, out);
	console.log(path.relative(ROOT, target));
}
