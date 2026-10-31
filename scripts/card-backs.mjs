/*
 |--------------------------------------------------------------------------
 | card-backs: the card backs without the former brand
 |--------------------------------------------------------------------------
 | The card backs (single images and the backs inside the card sprite sheets)
 | had "Nihtan" on their centre panel; the loading-screen cards were built
 | around its "N". This redraws them, brand-free:
 |
 |   backs    the centre panel (a solid red #d22e21 or blue #2a3990 area with
 |            gold lettering) gets a gold diamond lattice, an inner frame and
 |            an eight-point star medallion in the panel's colour
 |   loading  a white card with a red and gold double frame and the medallion
 |
 |   node scripts/card-backs.mjs --out <dir>    write the results to <dir> (review)
 |   node scripts/card-backs.mjs --write        replace the files in public/
 |
 | Panels are found, not hard-coded: connected areas of the panel colour that
 | fill most of their box and hold gold lettering. Red suit symbols on card
 | faces match the colour but hold no lettering, so they stay as they are. A
 | panel that is most of the image (seasonal cards: lettering among dragons
 | or lanterns) gets the whole card redrawn. The original's outline is kept.
 |
 */

import { mkdirSync, globSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const { values : args } = parseArgs({ options : { out : { type : 'string' }, write : { type : 'boolean' } } });
if (!args.out && !args.write) {
	console.error('usage: node scripts/card-backs.mjs --out <dir> | --write');
	process.exit(1);
}

const ROOT = path.join(import.meta.dirname, '..', 'public');
const GOLD = '#e8c872';
const PANELS = [{ name : 'red', rgb : [0xd2, 0x2e, 0x21] }, { name : 'blue', rgb : [0x2a, 0x39, 0x90] }];

const BACKS = [
	'*/img/cards/**/*.png', '*/img/new_cards/**/*.png', '*/img/multibet/cards.png', 'lobby/img/cards/**/*.png',
	'baccarat/img/tutorials/blue_backcard.png', '*/img/seasonal_theme/*/full-card.png'
];
const LOADING = ['*/img/loading/card.png', '*/img/loading/full-card.png', '*/img/loading/full-card2.png',
	'baccarat/img/v2_1/loading/card.png', 'baccarat/img/v2_1/loading/full-card.png', 'baccarat/img/v2_1/loading/full-card2.png'];

const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------------ drawing

/** an eight-point star (two squares) centred on cx, cy */
const star = (cx, cy, r) => {
	const pts = [];
	for (let i = 0; i < 16; i++) {
		const a = (Math.PI / 8) * i - Math.PI / 2;
		const rr = i % 2 ? r * 0.55 : r;
		pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
	}
	return `<polygon points="${pts.join(' ')}"/>`;
};

/** the medallion: a ring, the star, a dot */
const medallion = (cx, cy, r, fill, ink, stroke) =>
	`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${ink}" stroke-width="${stroke}"/>` +
	`<circle cx="${cx}" cy="${cy}" r="${r * 0.82}" fill="none" stroke="${ink}" stroke-width="${stroke * 0.6}" opacity="0.7"/>` +
	`<g fill="${ink}">${star(cx, cy, r * 0.66)}</g>` +
	`<circle cx="${cx}" cy="${cy}" r="${r * 0.12}" fill="${fill}"/>`;

/** the centre panel of a card back, w x h, in the panel colour */
function panelSvg (w, h, colour) {
	const s = Math.min(w, h);
	if (s < 14) {
		// a few pixels wide: a frame and a diamond read better than detail
		const d = Math.max(1.5, s * 0.28);
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${colour}"/>` +
			`<rect x="${s * 0.12}" y="${s * 0.12}" width="${w - s * 0.24}" height="${h - s * 0.24}" fill="none" stroke="${GOLD}" stroke-width="${Math.max(0.6, s * 0.07)}" opacity="0.8"/>` +
			`<polygon points="${w / 2},${h / 2 - d} ${w / 2 + d * 0.7},${h / 2} ${w / 2},${h / 2 + d} ${w / 2 - d * 0.7},${h / 2}" fill="${GOLD}"/></svg>`;
	}
	const inset = s * 0.08;
	const line = Math.max(0.5, s * 0.012);
	const step = s / 5;
	const lattice = [];
	for (let x = -h; x < w + h; x += step) {
		lattice.push(`<line x1="${x}" y1="0" x2="${x + h}" y2="${h}"/>`, `<line x1="${x}" y1="${h}" x2="${x + h}" y2="0"/>`);
	}
	const dots = [];
	for (let y = step / 2; y < h; y += step) for (let x = (Math.round(y / step) % 2 ? step : step / 2); x < w; x += step) dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(line * 1.1).toFixed(2)}"/>`);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
		`<defs><clipPath id="c"><rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}"/></clipPath></defs>` +
		`<rect width="${w}" height="${h}" fill="${colour}"/>` +
		`<g clip-path="url(#c)" stroke="${GOLD}" stroke-width="${line}" opacity="0.38">${lattice.join('')}</g>` +
		`<g clip-path="url(#c)" fill="${GOLD}" opacity="0.55">${dots.join('')}</g>` +
		`<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" fill="none" stroke="${GOLD}" stroke-width="${line * 1.6}"/>` +
		`<rect x="${inset + line * 3}" y="${inset + line * 3}" width="${w - 2 * inset - line * 6}" height="${h - 2 * inset - line * 6}" fill="none" stroke="${GOLD}" stroke-width="${line * 0.7}" opacity="0.7"/>` +
		medallion(w / 2, h / 2, s * 0.3, colour, GOLD, line * 1.6) +
		`</svg>`;
}

/** a loading-screen card, w x h, inside the original card's shape */
function loadingSvg (w, h) {
	const s = Math.min(w, h);
	const red = '#c8202a';
	const m = s * 0.06;
	const line = s * 0.008;
	const corner = (x, y, sx, sy) => `<path d="M${x} ${y + sy * s * 0.14}V${y}H${x + sx * s * 0.14}" fill="none" stroke="${red}" stroke-width="${line * 2.2}"/>` +
		`<circle cx="${x + sx * s * 0.05}" cy="${y + sy * s * 0.05}" r="${s * 0.012}" fill="${GOLD}"/>`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
		`<rect width="${w}" height="${h}" fill="#ffffff"/>` +
		`<rect x="${m}" y="${m}" width="${w - 2 * m}" height="${h - 2 * m}" fill="none" stroke="${red}" stroke-width="${line * 1.6}" stroke-dasharray="${s * 0.025} ${s * 0.012}"/>` +
		`<rect x="${m + s * 0.025}" y="${m + s * 0.025}" width="${w - 2 * m - s * 0.05}" height="${h - 2 * m - s * 0.05}" fill="none" stroke="${GOLD}" stroke-width="${line}"/>` +
		corner(m + s * 0.05, m + s * 0.05, 1, 1) + corner(w - m - s * 0.05, h - m - s * 0.05, -1, -1) +
		corner(w - m - s * 0.05, m + s * 0.05, -1, 1) + corner(m + s * 0.05, h - m - s * 0.05, 1, -1) +
		medallion(w / 2, h / 2, s * 0.2, '#ffffff', red, line * 2) +
		`</svg>`;
}

// ------------------------------------------------------------------ finding panels

function findPanels (data, W, H) {
	const found = [];
	for (const { rgb } of PANELS) {
		const isPanel = new Uint8Array(W * H);
		for (let p = 0, i = 0; p < W * H; p++, i += 4) {
			if (data[i + 3] > 200 && Math.abs(data[i] - rgb[0]) < 24 && Math.abs(data[i + 1] - rgb[1]) < 24 && Math.abs(data[i + 2] - rgb[2]) < 24) isPanel[p] = 1;
		}
		const seen = new Uint8Array(W * H);
		const stack = [];
		for (let start = 0; start < W * H; start++) {
			if (!isPanel[start] || seen[start]) continue;
			let x0 = W, y0 = H, x1 = -1, y1 = -1, area = 0;
			stack.push(start); seen[start] = 1;
			while (stack.length) {
				const p = stack.pop(), x = p % W, y = (p - x) / W;
				area++;
				if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
				for (const q of [p - 1, p + 1, p - W, p + W]) {
					if (q < 0 || q >= W * H || seen[q] || !isPanel[q]) continue;
					if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
					seen[q] = 1; stack.push(q);
				}
			}
			const w = x1 - x0 + 1, h = y1 - y0 + 1;
			if (w < 5 || h < 8 || area / (w * h) < 0.5) continue;
			// the lettering: gold-ish pixels inside the box
			let gold = 0;
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
				const i = (y * W + x) * 4;
				if (data[i] > 170 && data[i + 1] > 120 && data[i + 2] < 150 && data[i] - data[i + 2] > 60) gold++;
			}
			if (gold / (w * h) < 0.02) continue;
			found.push({ x : x0, y : y0, w, h, colour : hex(rgb) });
		}
	}
	return found;
}

// ------------------------------------------------------------------ run

const outFile = rel => (args.write ? path.join(ROOT, rel) : path.join(args.out, rel));
const files = pattern => [...new Set(pattern.flatMap(g => globSync(g, { cwd : ROOT })))].sort();
let changed = 0;

for (const rel of files(BACKS)) {
	const src = path.join(ROOT, rel);
	const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject : true });
	let panels = findPanels(data, info.width, info.height);
	if (!panels.length) continue;
	// a seasonal card is one big panel with art around the lettering: redraw the whole card
	const big = panels.find(p => p.w * p.h >= 0.5 * info.width * info.height);
	if (big) panels = [{ x : 0, y : 0, w : info.width, h : info.height, colour : big.colour }];
	const alpha = await sharp(src).ensureAlpha().extractChannel('alpha').toBuffer();
	const layers = await Promise.all(panels.map(async p => ({
		// painted only where the original was opaque: rounded corners stay rounded
		input : await sharp(Buffer.from(panelSvg(p.w, p.h, p.colour))).removeAlpha()
			.joinChannel(await sharp(alpha).extract({ left : p.x, top : p.y, width : p.w, height : p.h }).toBuffer()).png().toBuffer(),
		left  : p.x,
		top   : p.y
	})));
	mkdirSync(path.dirname(outFile(rel)), { recursive : true });
	await sharp(src).composite(layers).png().toFile(outFile(rel) + '.tmp.png');
	await sharp(outFile(rel) + '.tmp.png').toFile(outFile(rel));
	(await import('node:fs')).rmSync(outFile(rel) + '.tmp.png');
	changed++;
	console.log(`back     ${rel}  ${panels.length} panel${panels.length === 1 ? '' : 's'}`);
}

for (const rel of files(LOADING)) {
	const src = path.join(ROOT, rel);
	const meta = await sharp(src).metadata();
	// keep the original card's outline (rounded corners, shadow) as the shape
	const alpha = await sharp(src).ensureAlpha().extractChannel('alpha').toBuffer();
	const card = await sharp(Buffer.from(loadingSvg(meta.width, meta.height))).resize(meta.width, meta.height).removeAlpha().joinChannel(alpha).png().toBuffer();
	mkdirSync(path.dirname(outFile(rel)), { recursive : true });
	await sharp(card).toFile(outFile(rel));
	changed++;
	console.log(`loading  ${rel}`);
}

console.log(`${changed} files ${args.write ? 'replaced in public/' : `written to ${args.out}`}`);
