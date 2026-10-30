/*
 |--------------------------------------------------------------------------
 | poker helpers (pure)
 |--------------------------------------------------------------------------
 | Everything of the former PokerController that does not touch the
 | database or the request: request body parsing (jQuery / PHP style nested
 | form keys), the bet_history computation of testStore, the round / street
 | rules, user configs, ranges, Laravel paginator output, date formatting.
 | Unit tested by test/poker.test.ts.
 |
 */

import { createHash } from 'node:crypto';

// ------------------------------------------------------------------ request body

const isIndex = (k: string) => /^(0|[1-9]\d*)$/.test(k);

/** turns objects whose keys are 0..n-1 into arrays (PHP arrays from `a[0][x]=` keys) */
function listify (v: any): any {
	if (v === null || typeof v !== 'object') return v;
	if (Array.isArray(v)) return v.map(listify);
	const keys = Object.keys(v);
	for (const k of keys) v[k] = listify(v[k]);
	if (keys.length && keys.every(isIndex) && keys.map(Number).sort((a, b) => a - b).every((n, i) => n === i)) {
		return keys.map(Number).sort((a, b) => a - b).map(n => v[n]);
	}
	return v;
}

/** sets `data[0][amount]` style keys (and `a[]`) like PHP's parse_str */
function assignPath (target: Record<string, any>, key: string, value: any) {
	const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
	if (!m || !m[2]) {
		target[key] = value;
		return;
	}
	const parts = [m[1], ...Array.from(m[2].matchAll(/\[([^[\]]*)\]/g), x => x[1])];
	let node: any = target;
	for (let i = 0; i < parts.length; i++) {
		let part = parts[i];
		const last = i === parts.length - 1;
		if (part === '') part = String(Object.keys(node).length); // a[] appends
		if (last) {
			node[part] = value;
		} else {
			if (node[part] === null || typeof node[part] !== 'object') node[part] = {};
			node = node[part];
		}
	}
}

/** PHP-style decoding of an urlencoded body / query (jQuery.param output) */
export function parsePhpQuery (text: string): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of new URLSearchParams(text)) assignPath(out, k, v);
	return listify(out);
}

/** entries ([key, value]) of a multipart form, decoded like parsePhpQuery */
export function parsePhpEntries (entries: Iterable<[string, any]>): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of entries) assignPath(out, k, v);
	return listify(out);
}

// ------------------------------------------------------------------ former JSON columns

export const clone = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

/** former JSON column: native object, JSON string or nothing */
export function parseJson (value: any, fallback: any = null): any {
	if (value === null || value === undefined || value === '') return fallback;
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return parsed === null ? fallback : parsed;
		} catch {
			return fallback;
		}
	}
	return clone(value);
}

/** what MySQL returned for a JSON column (the legacy JS JSON.parse()s these) */
export const jsonText = (value: any): string | null =>
	value === null || value === undefined ? null : (typeof value === 'string' ? value : JSON.stringify(value));

/** JSON for a `{!! !!}` slot inside a <script> */
export const scriptJson = (value: any) => JSON.stringify(value === undefined ? null : value)
	.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** text for a `'{!! !!}'` slot inside a <script> (a quoted JS string) */
export const scriptString = (value: any) => String(value ?? '')
	.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/"/g, '\\"')
	.replace(/</g, '\\x3c').replace(/\r?\n/g, '\\n');

/** a number for a bare `{!! !!}` slot (window.x = 1;) */
export const scriptNumber = (value: any, fallback = 0) => {
	const n = Number(value);
	return Number.isFinite(n) && value !== null && value !== '' ? n : fallback;
};

// ------------------------------------------------------------------ dates

const pad = (n: number) => String(n).padStart(2, '0');

/** MySQL DATETIME text ("YYYY-MM-DD HH:mm:ss", UTC) - the JS adds the local offset */
export function sqlDate (value: any): string | null {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : null;
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ------------------------------------------------------------------ Laravel 5.4 paginator

export const pageNumber = (value: any) => {
	const n = parseInt(value, 10);
	return Number.isInteger(n) && n > 0 ? n : 1;
};

/** LengthAwarePaginator::toArray() of Laravel 5.4 (setPath(path)) */
export function paginator (rows: any[], total: number, page: number, perPage: number, path: string) {
	const lastPage = Math.max(1, Math.ceil(total / perPage));
	const url = (p: number) => `${path}${path.includes('?') ? '&' : '?'}page=${p}`;
	const from = rows.length ? (page - 1) * perPage + 1 : null;
	return {
		total,
		per_page      : perPage,
		current_page  : page,
		last_page     : lastPage,
		next_page_url : page < lastPage ? url(page + 1) : null,
		prev_page_url : page > 1 ? url(page - 1) : null,
		from,
		to            : from === null ? null : from + rows.length - 1,
		data          : rows
	};
}

// ------------------------------------------------------------------ users / configs

/** PokerController::$map - config language names -> app locales */
export const LANGUAGE_MAP: Record<string, string> = { japan : 'jp', korea : 'kr', english : 'en', chinese : 'zh', thai : 'th' };

const LOCALE_LANGUAGE = Object.fromEntries(Object.entries(LANGUAGE_MAP).map(([k, v]) => [v, k]));

const isObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** config of a user without one (the vendor launch used to create it; same defaults as the lobby port) */
export function defaultConfig (locale = 'en') {
	const languages = ['english', 'korea', 'japan', 'chinese', 'thai'];
	const select = Math.max(0, languages.indexOf(LOCALE_LANGUAGE[locale] || 'english'));
	return {
		avarta : {
			default  : { select : 0, data : ['red_queen', 'red_king', 'red_jack', 'red_joker', 'blue_queen', 'blue_king', 'blue_jack', 'blue_joker'] },
			language : { select, data : languages },
			screen   : { select : 0, data : ['black', 'white'] },
			sound    : { voice : '1', effect : '1', volum : '1', music : '0.2' },
			music    : '1',
			tutorial : { enabled : 'true' },
			is_room  : {}
		} as Record<string, any>
	};
}

/** PokerController::getUserConfig (+ defaults for the sections the PHP assumed to exist) */
export function normalizeConfig (stored: any, locale = 'en') {
	const defaults = defaultConfig(locale);
	const config = parseJson(stored, {});
	if (!isObject(config)) return defaults;
	if (!isObject(config.avarta)) config.avarta = {};
	const a = config.avarta;

	for (const key of ['default', 'language', 'screen']) {
		if (!isObject(a[key]) || !Array.isArray(a[key].data) || !a[key].data.length) a[key] = defaults.avarta[key];
		if (a[key].data[a[key].select] === undefined) a[key].select = 0;
	}
	if (!isObject(a.sound)) a.sound = { ...defaults.avarta.sound };
	if (!('music' in a)) a.music = '1';
	if (!('music' in a.sound)) a.sound.music = '0.2';
	return config;
}

export function configLocale (config: any): string {
	const a = config.avarta;
	return LANGUAGE_MAP[a.language.data[a.language.select]] || 'en';
}

const SOUND_KEYS: Record<string, string> = { effect : 'effect', sound : 'sound', volume : 'volum', voice : 'voice', music : 'music' };

/** PokerController::setUserConfig - returns the new users.configs (unknown keys are ignored; the PHP threw on them) */
export function applySettings (stored: any, data: Record<string, any>, locale = 'en') {
	const config = normalizeConfig(stored, locale);
	const a = config.avarta;
	for (const [key, value] of Object.entries(data)) {
		if (key in SOUND_KEYS) a.sound[SOUND_KEYS[key]] = value;
		else if (key === 'tutorial') {
			if (!isObject(a.tutorial)) a.tutorial = { enabled : 'true' };
			a.tutorial.enabled = value;
		} else if (key === 'chips' || key === 'range') a[key] = value;
		else if (key === 'bgm') a.music = value;
		else if (isObject(a[key])) a[key].select = value;
	}
	return config;
}

/** PokerController::setGameSettings - returns the new users.last_game_info */
export function applyGameSettings (stored: any, input: Record<string, any>) {
	const info = parseJson(stored, null);
	const value: Record<string, any> = isObject(info) ? info : { game : '', slave : '', multi_yn : '', bet_range : '', multibet : [] };
	const given = (k: string) => input[k] !== undefined && input[k] !== null;
	if (given('game')) value.game = input.game;
	if (given('data')) value.multibet = input.data;
	if (given('range')) value.bet_range = input.range;
	value.slave = given('slave') ? (input.slave === 'classic' ? '' : input.slave) : '';
	if (given('multiplayer')) value.multi_yn = input.multiplayer;
	return value;
}

/** fields of a users row that must never reach the browser (PokerController::getUser sent the whole row) */
export const PRIVATE_USER_FIELDS = ['password', 'remember_token', 'token', 'secret_key', 'api_token'];

export function publicUser (user: any, money: number) {
	const out: Record<string, any> = { id : user._id };
	for (const [k, v] of Object.entries(user)) {
		if (k === '_id' || PRIVATE_USER_FIELDS.includes(k)) continue;
		out[k] = v instanceof Date ? sqlDate(v) : v;
	}
	out.id = user._id;
	out.money = money;
	return out;
}

// ------------------------------------------------------------------ ranges

/** casino_bet_ranges / sport_bet_ranges of the table by users.user_type (PHP: C/TC casino, S/TS sport) */
export function tableRanges (table: any, userType: any): any[] {
	const t = String(userType || '').toUpperCase();
	const ranges = parseJson(t === 'S' || t === 'TS' ? table.sport_bet_ranges : table.casino_bet_ranges, []);
	return Array.isArray(ranges) ? ranges : [];
}

/** agent (user group) ranges override the table ones for Poker tables of the same room type */
export function agentRanges (groupRanges: any, roomType: string): any[] | null {
	const list = parseJson(groupRanges, []);
	if (!Array.isArray(list)) return null;
	let found: any[] | null = null;
	for (const r of list) {
		const rtype = r.type === 'vip' ? 'v' : r.type === 'premium' ? 'p' : 'n';
		if (r.game === 'Poker' && rtype === roomType && Array.isArray(r.ranges)) found = r.ranges;
	}
	return found;
}

export const rangeKey = (r: any) => `${r.min}-${r.max}`;

export function findRange (ranges: any[], range: string | null | undefined): any | null {
	if (!range) return null;
	const [min, max] = String(range).split('-');
	return ranges.find(r => r.min == min && r.max == max) || null;
}

/** channel.blade.php: $mainMul */
export function mainMul (mainMultiplier: any): number {
	const m = Number(mainMultiplier) || 0;
	return Math.trunc(m) % 10 ? 1 : (Math.floor(m) / 10 * 10) * 0.01;
}

/** number_format($n) */
export const numberFormat = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');

/** PHP float to string (1000000 / 1000 -> "1000", 2.5 -> "2.5") */
const phpNumber = (n: number) => String(Math.round(n * 1e10) / 1e10);

/** channel.blade.php range display: 1000000+ -> "xM", 1000+ -> "xK" */
export function shortAmount (n: number): string {
	if (n > 999999) return `${phpNumber(n / 1000000)}M`;
	if (n > 999) return `${phpNumber(n / 1000)}K`;
	return phpNumber(n);
}

/** values channel.html used to compute inline */
export function channelView (rangeDetails: any, allRange: any[], range: string, currencyMultiplier: number, userMultiplier: number, mainMultiplier: any) {
	const mul = mainMul(mainMultiplier);
	const minOf = (r: any) => Number(r.min) * currencyMultiplier * userMultiplier;
	const maxOf = (r: any) => Number(r.max) * currencyMultiplier * userMultiplier * mul;
	return {
		minDisp    : shortAmount(minOf(rangeDetails)),
		maxDisp    : shortAmount(maxOf(rangeDetails)),
		anteMinFmt : numberFormat(minOf(rangeDetails)),
		anteMaxFmt : numberFormat(maxOf(rangeDetails)),
		ranges     : allRange.map(r => ({
			value    : rangeKey(r),
			selected : rangeKey(r) === range,
			minFmt   : numberFormat(minOf(r)),
			maxFmt   : numberFormat(maxOf(r))
		}))
	};
}

// ------------------------------------------------------------------ bets

export type BetType = 'r' | 'b';
export const STREETS = ['flop', 'turn', 'river'] as const;
export type Street = typeof STREETS[number];

/** keys of bet_history per bet type (testStore $insert) */
export const BET_KEYS: Record<BetType, string[]> = {
	r : ['ante', 'bonus', 'flop', 'turn', 'river'],
	b : ['ante', 'bonusplus', 'pocket', 'flop', 'turn', 'river']
};

/** bets placed during betting (round status S) */
export const BETTING_KEYS = ['ante', 'bonus', 'bonusplus', 'pocket'];

export const slaveOf = (type: string) => (type === 'b' ? 'bonusplus' : 'normal');

/** empty bet_history of a bet type (testStore $insert) */
export function emptyHistory (type: BetType): Record<string, any> {
	const h: Record<string, any> = {};
	for (const key of BET_KEYS[type]) {
		h[key] = { bet : 0, win : 0, user_money : 0 };
		if ((STREETS as readonly string[]).includes(key)) h[key].cancel = 0;
	}
	return h;
}

const num = (v: any) => {
	const n = Math.abs(Number(v));
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

/** posted `data` rows -> [{key, amount}] ('bonus' is the pocket bet on the bonusplus channel, as in testStore) */
export function normalizeBetRows (data: any, type: BetType): { key : string; amount : number }[] | null {
	const rows = Array.isArray(data) ? data : (isObject(data) ? Object.values(data) : []);
	const out: { key : string; amount : number }[] = [];
	for (const row of rows) {
		if (!isObject(row)) return null;
		let key = String(row.table_id ?? '');
		if (type === 'b' && key === 'bonus') key = 'pocket';
		const amount = num(row.amount ?? 0);
		if (!BET_KEYS[type].includes(key) || Number.isNaN(amount)) return null;
		out.push({ key, amount });
	}
	return out;
}

/** cards dealt so far (rounds.game_info, barcodes) */
export type GameInfo = { player? : any[]; dealer? : any[]; flop? : any[]; turn? : any; river? : any; burn? : any[] } | null;

const count = (v: any) => (Array.isArray(v) ? v.filter(Boolean).length : 0);

/**
 * Street decision windows, from the cards on the table (the game server
 * does not store the dealer's street timers):
 *   flop  until the turn card is dealt
 *   turn  until the river card is dealt
 *   river until the dealer's hand is complete (dealt last, then results)
 * Only while the round is in progress (P).
 */
export function streetOpen (street: Street, status: string, gameInfo: GameInfo): boolean {
	if (status !== 'P') return false;
	const g = gameInfo || {};
	if (street === 'flop') return !g.turn;
	if (street === 'turn') return !g.river;
	return count(g.dealer) < 2;
}

export type BetPlan =
	| { ok : true; history : Record<string, any>; betAmount : number; totalBet : number }
	| { ok : false; reason : string };

/**
 * testStore's bet_history / amount computation plus the rules the stored
 * procedure USP_STORE_BET enforced (reconstructed, see controller.ts):
 *  - the posted rows are the full set of bets of the round; amounts never decrease
 *  - ante / bonus / pocket / bonusplus only while betting (status S), ante required
 *  - flop = 2 x ante, turn = river = ante, only inside the street's window,
 *    not after a fold / check of that street, turn and river need a flop bet
 * `money` is the balance before this request (user_money snapshots).
 */
export function planBet (opts: {
	type : BetType;
	rows : { key : string; amount : number }[];
	current : any | null;          // existing bet doc (lean) or null
	status : string;               // round status
	gameInfo : GameInfo;
	money : number;
}): BetPlan {
	const { type, rows, current, status, gameInfo, money } = opts;

	if (current && (current.type || 'r') !== type) return { ok : false, reason : 'type' };
	if (status !== 'S' && status !== 'P') return { ok : false, reason : 'status' };

	const prev = current ? parseJson(current.bet_history, {}) : {};
	const history = emptyHistory(type);
	for (const [key, value] of Object.entries(prev)) history[key] = { ...(history[key] || {}), ...(value as any) };

	const want: Record<string, number> = {};
	for (const { key, amount } of rows) want[key] = amount; // last one wins (PHP overwrote)

	let betAmount = 0;
	for (const { key } of rows) {
		if (!(key in want)) continue;
		const amount = want[key];
		delete want[key];

		const before = Number(history[key].bet) || 0;
		const delta = Math.round((amount - before) * 100) / 100;
		if (delta < 0) return { ok : false, reason : 'decrease' };
		if (delta === 0) continue;

		if (BETTING_KEYS.includes(key)) {
			if (status !== 'S') return { ok : false, reason : 'closed' };
			history[key].user_money = before ? history[key].user_money : money;
		} else {
			const street = key as Street;
			if (before || Number(history[street].cancel) === 1) return { ok : false, reason : 'decided' };
			if (!streetOpen(street, status, gameInfo)) return { ok : false, reason : 'closed' };
			history[street].user_money = money - betAmount;
		}
		history[key].bet = amount;
		betAmount += delta;
	}

	const ante = Number(history.ante.bet) || 0;
	const hasBets = BET_KEYS[type].some(k => Number(history[k].bet) > 0);
	if (hasBets && !ante) return { ok : false, reason : 'ante' };

	// street amounts are fixed by the ante (the UI only offers these)
	const flop = Number(history.flop.bet) || 0;
	if (flop && flop !== ante * 2) return { ok : false, reason : 'amount' };
	for (const street of ['turn', 'river']) {
		const v = Number(history[street].bet) || 0;
		if (v && (v !== ante || !flop)) return { ok : false, reason : 'amount' };
	}

	const totalBet = Math.round(BET_KEYS[type].reduce((s, k) => s + (Number(history[k].bet) || 0), 0) * 100) / 100;
	return { ok : true, history, betAmount : Math.round(betAmount * 100) / 100, totalBet };
}

/**
 * setFoldCheck: marks a street as folded (flop) / checked (turn, river).
 * Returns the new bet_history, or null when nothing may change (street
 * already bet or decided, round resulted). No money moves: the settlement
 * treats a flop bet < 1 as a fold.
 */
export function planFoldCheck (history: any, street: string, status: string): Record<string, any> | null {
	if (!(STREETS as readonly string[]).includes(street)) return null;
	if (status !== 'S' && status !== 'P' && status !== 'H') return null;
	const h = parseJson(history, {});
	if (!isObject(h[street])) h[street] = { bet : 0, win : 0, user_money : 0, cancel : 0 };
	if (Number(h[street].bet) > 0 || Number(h[street].cancel) === 1) return null;
	h[street].cancel = 1;
	return h;
}

/** md5(user id . user name . round id) of the PHP (bets.bet_id, vendor transaction id) */
export const transactionId = (userId: any, userName: any, roundId: any) =>
	createHash('md5').update(`${userId}${userName ?? ''}${roundId}`).digest('hex');
