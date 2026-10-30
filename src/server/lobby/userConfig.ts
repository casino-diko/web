/*
 |--------------------------------------------------------------------------
 | lobby user settings
 |--------------------------------------------------------------------------
 | Port of BetHistoryController::getUserConfig / setUserConfig /
 | setLastGameInfo / setJunketTableInfo data handling, as pure functions.
 |
 | users.configs (former JSON column, `{ avarta : {...} }`), users.last_game_info
 | and vendors.junket_table are native objects in MongoDB; legacy rows may
 | still hold JSON strings, so every reader accepts both.
 |
 */

/** BetHistoryController::$map - config language names -> app locales */
export const LANGUAGE_MAP: Record<string, string> = {
	japan   : 'jp',
	korea   : 'kr',
	english : 'en',
	chinese : 'zh',
	thai    : 'th'
};

const LOCALE_LANGUAGE = Object.fromEntries(Object.entries(LANGUAGE_MAP).map(([k, v]) => [v, k]));

// keys setUserConfig stores under avarta.sound (volume is spelt "volum" in the stored config)
const SOUND_KEYS: Record<string, string> = { effect : 'effect', sound : 'sound', volume : 'volum', voice : 'voice', music : 'music' };

export const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

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

/** config of a user without one (the former vendor launch created it) */
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
		}
	};
}

const isObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * getUserConfig: the stored config with the defaults the PHP filled in
 * (avarta.music, avarta.sound.music, a valid language select). Missing
 * sections - the PHP threw on those - come from defaultConfig().
 */
export function normalizeConfig (stored: any, locale = 'en') {
	const defaults = defaultConfig(locale);
	const config = parseJson(stored, {});
	if (!isObject(config)) return defaults;
	if (!isObject(config.avarta)) config.avarta = {};
	const a = config.avarta;

	for (const key of ['default', 'language', 'screen'] as const) {
		if (!isObject(a[key]) || !Array.isArray(a[key].data) || !a[key].data.length) a[key] = defaults.avarta[key];
	}
	if (!isObject(a.sound)) a.sound = { ...defaults.avarta.sound };
	if (!('music' in a)) a.music = '1';
	if (!('music' in a.sound)) a.sound.music = '0.2';
	if (!('is_room' in a)) a.is_room = {};

	for (const key of ['default', 'language', 'screen']) {
		if (a[key].data[a[key].select] === undefined) a[key].select = 0;
	}
	return config;
}

/** index3: locale from the configured language (App::setLocale) */
export function configLocale (config: any): string {
	const a = config.avarta;
	return LANGUAGE_MAP[a.language.data[a.language.select]] || 'en';
}

/** values the views read from $config->avarta */
export function viewConfig (config: any) {
	const a = config.avarta;
	const pick = (key: string) => a[key].data[a[key].select];
	return {
		default  : pick('default'),
		language : pick('language'),
		screen   : pick('screen'),
		sound    : a.sound,
		bgm      : a.music,
		tutorial : a.tutorial && a.tutorial.enabled !== undefined ? a.tutorial.enabled : 'true',
		raw      : { default : a.default.data, language : a.language.data, screen : a.screen.data }
	};
}

/**
 * setUserConfig: applies the posted settings. Unknown keys are ignored (the
 * PHP crashed on them: `$config->avarta->{$key}->select` of a missing key).
 */
export function applySettings (stored: any, data: Record<string, any>, locale = 'en') {
	const config = normalizeConfig(stored, locale);
	const a = config.avarta;

	for (const [key, value] of Object.entries(data)) {
		if (key in SOUND_KEYS) {
			a.sound[SOUND_KEYS[key]] = value;
		} else if (key === 'tutorial') {
			if (!isObject(a.tutorial)) a.tutorial = { enabled : 'true' };
			a.tutorial.enabled = value;
		} else if (key === 'chips' || key === 'range') {
			a[key] = value;
		} else if (key === 'bgm') {
			a.music = value;
		} else if (isObject(a[key])) {
			a[key].select = value;
		}
	}
	return config;
}

/** setLastGameInfo: merges the posted game choice into users.last_game_info */
export function applyLastGameInfo (stored: any, input: Record<string, any>) {
	const info = parseJson(stored, null);
	const value = isObject(info) ? info : { game : '', slave : '', multi_yn : '', bet_range : '', multibet : [] };
	const given = (k: string) => input[k] !== undefined && input[k] !== null;

	if (given('game')) value.game = input.game;
	if (given('data')) value.multibet = input.data;
	if (given('range')) value.bet_range = input.range;
	if (given('slave')) value.slave = input.slave === 'classic' || input.slave === 'normal' ? '' : input.slave;
	if (given('multiplayer')) value.multi_yn = input.multiplayer;
	return value;
}

export const emptyJunketTable = () => ({ created_room : [] as string[], disable_table : [] as string[] });

export function junketTable (stored: any) {
	const value = parseJson(stored, null);
	const table = isObject(value) ? value : emptyJunketTable();
	for (const key of ['created_room', 'disable_table']) {
		if (!Array.isArray(table[key])) table[key] = table[key] && typeof table[key] === 'object' ? Object.values(table[key]) : [];
	}
	return table;
}

/**
 * setJunketTableInfo: adds (active) or removes `game` in junket_table[type].
 * Only the two known lists can be changed (the PHP wrote any posted key).
 */
export function applyJunketTable (stored: any, type: string, game: string, active: boolean) {
	const table = junketTable(stored);
	if (type !== 'created_room' && type !== 'disable_table') {
		return { table, list : [] as string[], changed : false };
	}
	const list = active ? [...table[type], game] : table[type].filter((g: string) => g !== game);
	table[type] = [...new Set(list)];
	return { table, list : table[type], changed : true };
}
