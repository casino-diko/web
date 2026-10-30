/*
 |--------------------------------------------------------------------------
 | baccarat helpers
 |--------------------------------------------------------------------------
 | Pure functions used by the baccarat controller (no database, no Next):
 | PHP request parsing, Laravel paginator / column formatting, user config
 | defaults, bet range display values and the bet document computations of
 | the former BaccaratController::testStore / USP_STORE_BET.
 |
 | Imported by test/baccarat.test.ts through node's type stripping, so only
 | relative `.ts` imports (none at the moment) are allowed here.
 |
 */

// ------------------------------------------------------------------ request

/**
 * PHP's parse_str() for one key/value: "data[0][amount]" -> data.0.amount,
 * "chips[]" appends. Objects whose keys are 0..n-1 become arrays afterwards
 * (see phpArrays) since jQuery serialises arrays as data[0][...], data[1][...].
 */
export function phpAssign (target: Record<string, any>, key: string, value: any) {
	const m = /^([^[\]]+)((?:\[[^\]]*\])*)$/.exec(key);
	if (!m) {
		target[key] = value;
		return;
	}
	const path = [m[1], ...(m[2].match(/\[([^\]]*)\]/g) || []).map(p => p.slice(1, -1))];
	let node: any = target;
	for (let i = 0; i < path.length; i++) {
		let k = path[i];
		const last = i === path.length - 1;
		if (k === '') k = String(Object.keys(node).length);
		if (last) {
			node[k] = value;
		} else {
			if (node[k] === null || typeof node[k] !== 'object') node[k] = {};
			node = node[k];
		}
	}
}

/** turns {"0":a,"1":b} objects (recursively) into arrays, like PHP lists */
export function phpArrays (value: any): any {
	if (Array.isArray(value)) return value.map(phpArrays);
	if (value === null || typeof value !== 'object') return value;
	const keys = Object.keys(value);
	const out: Record<string, any> = {};
	for (const k of keys) out[k] = phpArrays(value[k]);
	if (keys.length && keys.every((k, i) => k === String(i))) return keys.map(k => out[k]);
	return out;
}

/** application/x-www-form-urlencoded body or query string -> nested PHP-like input */
export function parsePhpQuery (text: string, into: Record<string, any> = {}): Record<string, any> {
	for (const [key, value] of new URLSearchParams(text)) phpAssign(into, key, value);
	return into;
}

// ------------------------------------------------------------------ formatting

const pad = (n: number) => String(n).padStart(2, '0');

/** MySQL DATETIME text (UTC) for a Date / date string; passes strings through */
export function sqlDate (value: any): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
	const d = value instanceof Date ? value : new Date(value);
	if (isNaN(d.getTime())) return null;
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
		+ `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Former JSON columns came out of MySQL as text and the legacy scripts
 * JSON.parse() them (game_info, game_result, bet_history, junket_table).
 */
export const jsonText = (value: any): string | null =>
	value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);

/** a JSON column that may still be stored as text */
export function jsonValue<T = any> (value: any, fallback: T = null): T {
	if (value === null || value === undefined || value === '') return fallback;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

/** PHP number_format($n) (0 decimals, "," thousands, half away from zero) */
export function numberFormat (n: any): string {
	const v = Number(n) || 0;
	const r = Math.sign(v) * Math.round(Math.abs(v));
	return r.toLocaleString('en-US', { maximumFractionDigits : 0 });
}

/** how PHP echoes a float (precision=14): 1.5 -> "1.5", 2.0 -> "2" */
export const phpNumber = (n: any): string => {
	const v = Number(n);
	if (!isFinite(v)) return '';
	return String(Number(v.toPrecision(14)));
};

/** Laravel 5.4 LengthAwarePaginator::toArray() */
export function paginate (rows: any[], total: number, page: number, perPage: number, path: string) {
	const lastPage = Math.max(Math.ceil(total / perPage), 1);
	const from = rows.length ? (page - 1) * perPage + 1 : null;
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

export const pageNumber = (value: any) => {
	const p = parseInt(value);
	return Number.isInteger(p) && p > 0 ? p : 1;
};

// ------------------------------------------------------------------ user config

// BaccaratController::$map
export const LANGUAGE_MAP: Record<string, string> = {
	japan   : 'jp',
	korea   : 'kr',
	english : 'en',
	chinese : 'zh',
	thai    : 'th'
};

const LOCALE_LANGUAGE: Record<string, string> = Object.fromEntries(Object.entries(LANGUAGE_MAP).map(([k, v]) => [v, k]));

/**
 * users.configs as the former lobby created it. Seeded users have none, so
 * this is the default (the legacy code crashed on a missing config).
 */
export function defaultUserConfig (locale = 'en') {
	const languages = ['english', 'korea', 'japan', 'chinese', 'thai'];
	const select = Math.max(languages.indexOf(LOCALE_LANGUAGE[locale] || 'english'), 0);
	return {
		avarta : {
			default  : { data : ['red_king', 'red_queen', 'red_jack', 'red_joker', 'black_king', 'black_queen', 'black_jack', 'black_joker'], select : 0 },
			language : { data : languages, select },
			screen   : { data : ['black', 'white'], select : 0 },
			sound    : { voice : '1', effect : '1', volum : '1', music : '0.2' },
			video    : 'HD',
			music    : '1',
			tutorial : { enabled : 'true' },
			chips    : ['1', '5', '10', '30', 'max']
		}
	};
}

const isObj = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fillDefaults (target: any, defaults: any) {
	for (const [k, v] of Object.entries(defaults)) {
		if (target[k] === undefined || target[k] === null) target[k] = structuredClone(v);
		else if (isObj(v) && isObj(target[k])) fillDefaults(target[k], v);
	}
	return target;
}

/** BaccaratController::getUserConfig (configs may be stored as text or natively) */
export function userConfig (raw: any, locale = 'en') {
	const parsed = jsonValue(raw, null);
	const config: any = isObj(parsed) ? structuredClone(parsed) : {};
	if (!isObj(config.avarta)) config.avarta = {};
	const defaults = defaultUserConfig(locale);
	// the legacy code only defaulted music; everything else crashed when missing
	fillDefaults(config.avarta, defaults.avarta);

	const lang = config.avarta.language;
	if (!Array.isArray(lang.data) || lang.data[lang.select] === undefined) lang.select = 0;
	if (!Array.isArray(lang.data) || !lang.data.length) lang.data = defaults.avarta.language.data;
	if (!Array.isArray(config.avarta.chips) || !config.avarta.chips.length) config.avarta.chips = defaults.avarta.chips;
	return config;
}

export const configLocale = (config: any) =>
	LANGUAGE_MAP[config.avarta.language.data[config.avarta.language.select]] || 'en';

const pick = (o: any) => (o && Array.isArray(o.data) ? o.data[o.select] ?? o.data[0] : undefined);

/** values used by the view's window.config / window.rawConfig blocks */
export function viewConfig (config: any) {
	const a = config.avarta;
	return {
		default      : pick(a.default),
		language     : pick(a.language),
		screen       : pick(a.screen),
		voice        : a.sound.voice,
		effect       : a.sound.effect,
		volume       : a.sound.volum,
		music        : a.sound.music,
		bgm          : a.music,
		video        : a.video,
		defaultData  : a.default.data,
		languageData : a.language.data,
		screenData   : a.screen.data
	};
}

/** BaccaratController::setUserConfig applied to a config object */
export function applyUserConfig (config: any, data: Record<string, any>) {
	const map: Record<string, string> = { volume : 'volum' };
	const a = config.avarta;
	for (const [key, value] of Object.entries(data)) {
		if (['effect', 'sound', 'volume', 'voice', 'music'].includes(key)) {
			a.sound[map[key] || key] = value;
		} else if (key === 'tutorial') {
			if (!isObj(a.tutorial)) a.tutorial = { enabled : 'true' };
			a.tutorial.enabled = value;
		} else if (key === 'chips') {
			a.chips = value;
		} else if (key === 'range') {
			a.range = value;
		} else if (key === 'bgm') {
			a.music = value;
		} else {
			if (!isObj(a[key])) a[key] = {};
			a[key].select = value;
		}
	}
	return config;
}

/** BaccaratController::setGameSettings applied to users.last_game_info */
export function applyGameSettings (info: any, input: Record<string, any>) {
	const out: any = isObj(info) ? { ...info } : {};
	if (input.game !== undefined && input.game !== null) out.game = input.game;
	if (input.data !== undefined && input.data !== null) out.multibet = input.data;
	if (input.range !== undefined && input.range !== null) out.bet_range = input.range;
	out.slave = input.slave !== undefined && input.slave !== null ? (input.slave === 'classic' ? '' : input.slave) : '';
	if (input.multiplayer !== undefined && input.multiplayer !== null) out.multi_yn = input.multiplayer;
	return out;
}

// ------------------------------------------------------------------ table / ranges

/** game_tables.bet_setting.type -> { type, slave } as BaccaratController::init */
export function tableTypes (betSetting: any, requestedSlave: any) {
	const bType = betSetting ? betSetting.type : null;
	let type: string | null = null;
	let slave: string | null = null;
	if (Array.isArray(bType)) {
		for (const value of bType) {
			if (requestedSlave !== undefined && value == requestedSlave) slave = value;
			if (value === 'normal' || value === 'flippy') type = value;
		}
	} else {
		type = bType ?? null;
	}
	return { type, slave, tType : Array.isArray(bType) ? bType[0] : (bType || 'normal') };
}

/** view's $mainMul: main_multiplier as a factor (100 -> 1); "% 10" values mean 1 */
export function mainMul (mainMultiplier: any) {
	const mm = parseInt(mainMultiplier) || 0;
	return mm % 10 ? 1 : mm * 0.01;
}

/** display numbers of the selected range (channel views) */
export function rangeDisplay (range: any, currencyMultiplier: number, userMultiplier: number, mainMultiplier: any) {
	const mul = mainMul(mainMultiplier);
	const min = (Number(range?.min) || 0) * currencyMultiplier * userMultiplier;
	const max = (Number(range?.max) || 0) * currencyMultiplier * userMultiplier * mul;
	const side = (Array.isArray(range?.side_bet) ? range.side_bet : []).map((s: any) => ({
		minFmt : numberFormat((Number(s?.min) || 0) * currencyMultiplier * userMultiplier),
		maxFmt : numberFormat((Number(s?.max) || 0) * currencyMultiplier * userMultiplier * mul)
	}));
	while (side.length < 3) side.push({ minFmt : '0', maxFmt : '0' });
	return {
		minRaw : phpNumber(min), maxRaw : phpNumber(max),
		minFmt : numberFormat(min), maxFmt : numberFormat(max),
		minK   : phpNumber(min / 1000), maxK : phpNumber(max / 1000),
		minM   : phpNumber(min / 1000000), maxM : phpNumber(max / 1000000),
		side
	};
}

/** rows of the range selector */
export function rangeRows (ranges: any[], range: string, currencyMultiplier: number, userMultiplier: number, mainMultiplier: any) {
	const mul = mainMul(mainMultiplier);
	return (ranges || []).map(r => ({
		min      : r.min,
		max      : r.max,
		minFmt   : numberFormat((Number(r.min) || 0) * currencyMultiplier * userMultiplier),
		maxFmt   : numberFormat((Number(r.max) || 0) * currencyMultiplier * userMultiplier * mul),
		selected : `${r.min}-${r.max}` == range
	}));
}

/**
 * Agent (user group) ranges override the table ranges for the matching room
 * type ("n"/"p"/"v", + "f" for flippy tables).
 */
export function agentRanges (groupRanges: any[], table: any, game = 'Baccarat'): any[] | null {
	if (!Array.isArray(groupRanges)) return null;
	const types = table?.bet_setting?.type;
	const flippy = (Array.isArray(types) ? types[0] : types) === 'flippy';
	const roomType = (table?.room_type || 'n') + (flippy ? 'f' : '');
	let found: any[] | null = null;
	for (const r of groupRanges) {
		let rtype = r.type === 'vip' ? 'v' : r.type === 'premium' ? 'p' : 'n';
		if (String(r.gameType || '').toLowerCase() === 'flippy') rtype += 'f';
		if (r.game === game && rtype === roomType) found = r.ranges;
	}
	return found;
}

// ------------------------------------------------------------------ bets

// bet areas each bet type is settled for (betsCalculator.fnEvaluate / s / b)
const MAIN = ['player', 'banker', 'tie', 'playerpair', 'bankerpair'];
export const BET_AREAS: Record<string, string[]> = {
	r : MAIN,
	f : MAIN,
	s : [...MAIN, 'supersix'],
	b : [...MAIN, 'big', 'small', 'bonus_player', 'bonus_banker']
};

/**
 * Bet type of a store request: slave ('r','s','b','i') or 'r', flippy
 * tables post type=f. Returns null for types the settlement cannot handle
 * (insurance 'i' would make betsCalculator throw for the whole round).
 */
export function betType (slave: any, type: any): string | null {
	let t = slave ? String(slave) : 'r';
	if (type === 'f' && (!slave || slave === 'r')) t = 'f';
	return BET_AREAS[t] ? t : null;
}

export type BetRow = { bet : string; bet_money : number; win_money : number; user_money : number };

/**
 * The bet_history of testStore: one row per posted area, an amount of 0
 * keeps the previously confirmed amount of that area. user_money is the
 * balance shown before each row (balance + previous stake - rows before).
 */
export function buildBetHistory (data: any[], prevBets: any[], userMoney: number) {
	const prev = Array.isArray(prevBets) ? prevBets : [];
	const prevTotal = prev.reduce((s, r) => s + (Number(r.bet_money) || 0), 0);
	const rows: BetRow[] = [];
	let total = 0;
	for (const item of data) {
		const key = String(item.table_id);
		const amount = Math.abs(Number(item.amount) || 0);
		const old = prev.find(r => r.bet === key);
		const betMoney = !Math.trunc(amount) && old && old.bet_money ? Math.abs(Number(old.bet_money)) : amount;
		rows.push({ bet : key, bet_money : betMoney, win_money : 0, user_money : (userMoney + prevTotal) - total });
		total += betMoney;
	}
	return { rows, total, prevTotal };
}

/** checks posted areas against the bet type; returns an error text or null */
export function validateBets (data: any, type: string): string | null {
	if (!Array.isArray(data) || !data.length) return 'no bets';
	const allowed = BET_AREAS[type];
	const seen = new Set<string>();
	for (const item of data) {
		if (!item || typeof item !== 'object') return 'bad bet';
		const key = String(item.table_id ?? '');
		if (!allowed.includes(key)) return `bet area "${key}" not allowed for type ${type}`;
		if (seen.has(key)) return `duplicate bet area "${key}"`;
		seen.add(key);
		const amount = Number(item.amount);
		if (item.amount !== undefined && item.amount !== '' && !isFinite(amount)) return 'bad amount';
	}
	return null;
}

/**
 * Junket balance bet (USP_STORE_BET 'F' / USP_BALANCE_CANCEL_CHECK, see
 * balanceBet.js): the room's player and banker totals of the round may not
 * differ by more than the balance.
 */
export function balanceOk (roomBets: { bet_history : any[] }[], balance: number) {
	let player = 0;
	let banker = 0;
	for (const b of roomBets) {
		for (const row of b.bet_history || []) {
			if (row.bet === 'player') player += Number(row.bet_money) || 0;
			if (row.bet === 'banker') banker += Number(row.bet_money) || 0;
		}
	}
	return Math.abs(player - banker) <= balance;
}

export const SLAVE_NAMES: Record<string, string> = { r : 'normal', s : 'supersix', f : 'flippy', b : 'bonus', i : 'insurance' };

/** a bet history row for the logs endpoints (stored procedure columns) */
export function historyRow (bet: any, round: any, dealer: any, cnt: number) {
	const settled = round && ['E', 'W'].includes(round.status);
	const totalBet = Number(bet.total_bet) || 0;
	return {
		cnt,
		id            : bet._id,
		round_id      : bet.round_id,
		round_num     : round ? round.round_num : null,
		table_id      : round ? round.table_id : null,
		dealer_name   : dealer ? dealer.name : null,
		type          : bet.type,
		bet_range     : bet.bet_range,
		currency      : bet.currency ?? null,
		total_bet     : totalBet,
		// "win/lose" column: net result of the round
		total_win     : settled ? (Number(bet.total_win) || 0) - totalBet : 0,
		total_winning : Number(bet.total_winning) || 0,
		total_lost    : Number(bet.total_lost) || 0,
		total_rolling : Number(bet.total_rolling) || 0,
		status        : round ? round.status : null,
		bet_history   : jsonText(bet.bet_history),
		game_info     : jsonText(round ? round.game_info : null),
		game_result   : jsonText(round ? round.game_result : null),
		created_at    : sqlDate(bet.created_at),
		updated_at    : sqlDate(round && round.updated_at ? round.updated_at : bet.updated_at)
	};
}
