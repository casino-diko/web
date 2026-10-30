/*
 |--------------------------------------------------------------------------
 | dragon-tiger helpers
 |--------------------------------------------------------------------------
 | Pure functions used by the controller (no imports, so node:test can load
 | this file directly: test/dragon-tiger.test.ts).
 |
 */

export const GAME = 'Dragon-Tiger';          // former env('CUR_GAME'), game-server gameName
export const GAME_KEY = 'dragontiger';       // rooms.game / USP_* game argument

// bet names the game-server settles (backend repo: game-server/src/games/dragontiger/betsCalculator.js BET_TYPES);
// an unknown name makes the whole round's settlement throw, so they are refused at bet time
export const BET_TYPES = [
	'tie', 'suited_tie',
	'dragon', 'dragon_odd', 'dragon_even', 'dragon_big', 'dragon_small',
	'dragon_clubs', 'dragon_hearts', 'dragon_diamonds', 'dragon_spades',
	'tiger', 'tiger_odd', 'tiger_even', 'tiger_big', 'tiger_small',
	'tiger_clubs', 'tiger_hearts', 'tiger_diamonds', 'tiger_spades'
];

// DragonTigerController::$map
export const LANGUAGE_MAP: Record<string, string> = {
	japan   : 'jp',
	korea   : 'kr',
	english : 'en',
	chinese : 'zh',
	thai    : 'th'
};

const isObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** former JSON columns may still arrive as strings (older data / other writers) */
export function jsonValue<T = any> (value: any, fallback: T = null): T {
	if (value === null || value === undefined || value === '') return fallback;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

/** what MySQL returned for a JSON column: a JSON string (the legacy JS JSON.parse()s it) */
export const jsonColumn = (value: any): string | null =>
	value === null || value === undefined ? null : (typeof value === 'string' ? value : JSON.stringify(value));

/** JSON for a <script> block (also safe inside a single-quoted JS string) */
export const scriptJson = (value: any) =>
	JSON.stringify(value ?? null).replace(/</g, '\\u003c').replace(/'/g, '\\u0027').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** MySQL DATETIME as Laravel returned it (UTC) */
export function sqlDate (value: any): string | null {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(value);
	if (isNaN(d.getTime())) return String(value);
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * PHP-style request keys: jQuery posts nested data as data[0][amount]=10,
 * which Laravel turns into arrays. lib/http input() only handles "x[]".
 */
export function expandBrackets (flat: Record<string, any>): Record<string, any> {
	const root: Record<string, any> = {};

	for (const [rawKey, value] of Object.entries(flat || {})) {
		const m = /^([^[\]]+)((?:\[[^\]]*\])*)$/.exec(rawKey);
		if (!m || !m[2]) {
			root[rawKey] = value;
			continue;
		}
		const path = [m[1], ...Array.from(m[2].matchAll(/\[([^\]]*)\]/g), x => x[1])];
		let node: any = root;
		for (let i = 0; i < path.length; i++) {
			let key = path[i];
			const last = i === path.length - 1;
			if (key === '') {
				// "a[]" - append
				key = String(Object.keys(node).length);
			}
			if (last) {
				if (Array.isArray(value) && path[i] === '') {
					value.forEach((v, j) => { node[String(Object.keys(node).length + j)] = v; });
				} else {
					node[key] = value;
				}
			} else {
				if (!isObject(node[key])) node[key] = {};
				node = node[key];
			}
		}
	}

	// objects keyed 0..n-1 become arrays (like PHP json_encode of a list)
	const listify = (v: any): any => {
		if (!isObject(v)) return v;
		for (const k of Object.keys(v)) v[k] = listify(v[k]);
		const keys = Object.keys(v);
		if (keys.length && keys.every((k, i) => k === String(i))) return keys.map(k => v[k]);
		return v;
	};
	return listify(root);
}

/** Laravel's $request->input('a', default) after ConvertEmptyStringsToNull */
export const inputValue = (data: Record<string, any>, key: string, fallback: any = null) => {
	const v = data[key];
	return v === undefined || v === null || v === '' ? fallback : v;
};

/** PHP empty() for arrays / objects */
export const isEmpty = (v: any) => !v || (Array.isArray(v) ? !v.length : typeof v === 'object' ? !Object.keys(v).length : false);

export const toList = (v: any): any[] => {
	if (Array.isArray(v)) return v;
	if (isObject(v)) return Object.values(v);
	return [];
};

// ------------------------------------------------------------------ bets

export type BetLine = { bet : string; bet_money : number; win_money : number; user_money : number };

/**
 * testStore's bet_history: one entry per posted bet area ({table_id, amount}).
 * user_money is the balance the player had before each line (PHP formula).
 * Throws on an unknown bet area or a bad amount.
 */
export function buildBetHistory (data: any[], prevBets: any[], uMoney: number) {
	const prevTotalBets = (prevBets || []).reduce((s, b) => s + (Number(b && b.bet_money) || 0), 0);
	const bets: BetLine[] = [];
	let totalBets = 0;

	toList(data).forEach((row, x) => {
		const key = String(row && row.table_id || '').trim();
		if (!BET_TYPES.includes(key)) throw new Error(`unknown bet area "${key}"`);

		const amount = Number(row.amount);
		if (!Number.isFinite(amount)) throw new Error(`bad amount for ${key}`);

		// PHP: !((int)amount) && array_key_exists($key, $prevBets) && ... - $prevBets is a list, so the
		// lookup by bet name never matched and the posted amount was always used
		const betMoney = Math.abs(amount);

		bets.push({
			bet        : key,
			bet_money  : betMoney,
			win_money  : 0,
			user_money : x === 0 ? uMoney + prevTotalBets : (uMoney + prevTotalBets) - totalBets
		});
		totalBets += betMoney;
	});

	return { bets, totalBets, prevTotalBets };
}

/** vendors.main_multiplier -> factor on the max bet (PHP + legacy JS formula) */
export function mainMul (mainMultiplier: any): number {
	const m = Number(mainMultiplier) || 0;
	if (m % 10) return 1;
	return (Math.floor(m / 10) * 10) * 0.01;
}

/** storeBet / cancel / cancelMulti: url range "min-max" scaled by vendor multiplier and main multiplier */
export function scaledRange (range: string, vendorMultiplier: any, mainMultiplier: any): string {
	const [min, max] = String(range || '').split('-').map(Number);
	const mul = Math.trunc(Number(vendorMultiplier) || 0);
	return `${(min || 0) * mul}-${(max || 0) * mul * mainMul(mainMultiplier)}`;
}

// ------------------------------------------------------------------ user configs

export const DEFAULT_CHIPS = ['1', '5', '10', '30', 'max'];

/** shape of users.configs as the views / JS expect it (former JSON column, defaults for new users) */
export const defaultConfig = () => ({
	avarta : {
		default  : { select : 0, data : ['red_king', 'red_queen', 'red_jack', 'red_joker', 'blue_king', 'blue_queen', 'blue_jack', 'blue_joker'] },
		language : { select : 0, data : ['english', 'korea', 'chinese', 'japan', 'thai'] },
		screen   : { select : 0, data : ['black', 'white'] },
		sound    : { voice : '1', effect : '1', volum : '1', music : '0.2' },
		tutorial : { enabled : 'true' },
		chips    : DEFAULT_CHIPS.slice(),
		music    : '1',
		video    : 'HD',
		is_room  : false
	}
});

const deepMerge = (base: any, over: any): any => {
	if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
	const out: any = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
	return out;
};

/** DragonTigerController::getUserConfig (stored configs over the defaults) */
export function userConfig (stored: any) {
	const config = deepMerge(defaultConfig(), jsonValue(stored, {}) || {});
	const a = config.avarta;
	if (!isObject(a.sound)) a.sound = defaultConfig().avarta.sound;
	if (a.music === undefined) a.music = '1';
	if (a.sound.music === undefined) a.sound.music = '0.2';
	for (const k of ['default', 'language', 'screen']) {
		if (!isObject(a[k]) || !Array.isArray(a[k].data)) a[k] = (defaultConfig().avarta as any)[k];
		if (a[k].data[a[k].select] === undefined) a[k].select = 0;
	}
	if (!a.chips || (Array.isArray(a.chips) && !a.chips.length)) a.chips = DEFAULT_CHIPS.slice();
	return config;
}

export const configLocale = (config: any) =>
	LANGUAGE_MAP[config.avarta.language.data[config.avarta.language.select]] || 'en';

/** values the views read with dynamic indexes / isset() */
export function configView (config: any) {
	const a = config.avarta;
	return {
		default  : a.default.data[a.default.select],
		language : a.language.data[a.language.select],
		screen   : a.screen.data[a.screen.select],
		tutorial : a.tutorial && a.tutorial.enabled !== undefined ? String(a.tutorial.enabled) : 'true'
	};
}

/** DragonTigerController::setUserConfig - returns the new configs */
export function applyUserSettings (config: any, data: Record<string, any>) {
	const map: Record<string, string> = { volume : 'volum' };
	const a = config.avarta;

	for (const [key, value] of Object.entries(data)) {
		if (['effect', 'sound', 'volume', 'voice', 'music'].includes(key)) {
			a.sound[map[key] || key] = value;
		} else if (key === 'tutorial') {
			if (!isObject(a.tutorial)) a.tutorial = { enabled : 'true' };
			a.tutorial.enabled = value;
		} else if (key === 'chips') {
			a.chips = value;
		} else if (key === 'range') {
			a.range = value;
		} else if (key === 'bgm') {
			a.music = value;
		} else if (isObject(a[key])) {
			// default / language / screen ... (PHP set ->select on any other key and errored on scalars)
			a[key].select = value;
		}
	}
	return config;
}

export const defaultGameInfo = () => ({ game : '', bet_range : '', slave : '', multi_yn : 0 });

/** DragonTigerController::setGameSettings - returns the new users.last_game_info */
export function applyGameSettings (current: any, data: Record<string, any>) {
	const info: any = { ...defaultGameInfo(), ...(jsonValue(current, {}) || {}) };
	const has = (k: string) => data[k] !== undefined && data[k] !== null;

	if (has('game')) info.game = data.game;
	if (has('data')) info.multibet = data.data;
	if (has('range')) info.bet_range = data.range;
	info.slave = has('slave') ? (data.slave === 'classic' ? '' : data.slave) : '';
	if (has('multiplayer')) info.multi_yn = data.multiplayer;
	return info;
}

// ------------------------------------------------------------------ ranges / view

/** agent (user group) ranges override the table ranges for the table's room type */
export function agentRanges (groupRanges: any[], roomType: string, game = GAME): any[] | null {
	let found: any[] | null = null;
	for (const r of toList(groupRanges)) {
		const rtype = r.type === 'vip' ? 'v' : r.type === 'premium' ? 'p' : 'n';
		if (r.game === game && rtype === roomType) found = r.ranges;
	}
	return found;
}

export const rangeKey = (r: any) => `${r.min}-${r.max}`;

/** picks the range from users.last_game_info when it belongs to this table, else the first one */
export function selectRange (ranges: any[], gameInfo: any, table: string | number, game = GAME) {
	let range = ranges.length ? rangeKey(ranges[0]) : '';
	let details = ranges[0] || null;
	let multiplayer: any = 0;

	if (gameInfo && gameInfo.game === `${game}/${table}`) {
		multiplayer = gameInfo.multi_yn ?? 0;
		const [min, max] = String(gameInfo.bet_range || '').split('-');
		const match = ranges.find(r => min == r.min && max == r.max); // loose like PHP
		if (match) {
			details = match;
			range = rangeKey(match);
		}
	}
	return { range, details, multiplayer };
}

/** PHP number_format($n) */
export const numberFormat = (n: any) => {
	const v = Math.round(Number(n) || 0);
	return v.toLocaleString('en-US');
};

const short = (n: number) => {
	if (n > 999999) return `${n / 1000000}M`;
	if (n > 999) return `${n / 1000}K`;
	return String(n);
};

/** the computed parts of channel.blade.php */
export function channelContext (details: any, allRange: any[], range: string, currencyMultiplier: any, userMultiplier: any, mainMultiplier: any) {
	const cm = Number(currencyMultiplier) || 0;
	const um = Number(userMultiplier) || 0;
	const mm = mainMul(mainMultiplier);
	const d = details || { min : 0, max : 0, side_bet : [] };
	const tie = (d.side_bet && d.side_bet[0]) || { min : 0, max : 0 };
	const lo = (v: any) => Number(v) * cm * um;
	const hi = (v: any) => Number(v) * cm * um * mm;

	return {
		dispMin   : short(lo(d.min)),
		dispMax   : short(hi(d.max)),
		minFmt    : numberFormat(lo(d.min)),
		maxFmt    : numberFormat(hi(d.max)),
		tieMinFmt : numberFormat(lo(tie.min)),
		tieMaxFmt : numberFormat(hi(tie.max)),
		ranges    : toList(allRange).map(r => ({
			min      : r.min,
			max      : r.max,
			selected : rangeKey(r) == range,
			minFmt   : numberFormat(lo(r.min)),
			maxFmt   : numberFormat(hi(r.max))
		}))
	};
}

// ------------------------------------------------------------------ pagination

/** Laravel 5.4 LengthAwarePaginator::toArray() (->paginate(n)->setPath(path)) */
export function paginator (rows: any[], total: number, page: number, perPage: number, path: string) {
	const lastPage = Math.max(1, Math.ceil(total / perPage));
	const from = total && rows.length ? (page - 1) * perPage + 1 : null;
	return {
		total,
		per_page      : perPage,
		current_page  : page,
		last_page     : lastPage,
		next_page_url : page < lastPage ? `${path}?page=${page + 1}` : null,
		prev_page_url : page > 1 ? `${path}?page=${page - 1}` : null,
		from,
		to            : from === null ? null : from + rows.length - 1,
		data          : rows
	};
}

export const pageNumber = (v: any) => {
	const n = parseInt(v);
	return Number.isInteger(n) && n > 0 ? n : 1;
};
