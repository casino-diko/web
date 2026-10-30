/*
 |--------------------------------------------------------------------------
 | lobby controller
 |--------------------------------------------------------------------------
 | Port of lobby/app/Http/Controllers/BetHistoryController.php (and the
 | getUserCredits helper of Controller.php). One function per ported PHP
 | method, `(req, params) => value | Response`, wired up in routes.ts with
 | lib/http handler(): objects/arrays answer as JSON, scalars as text, like
 | Laravel did.
 |
 | Dropped with their games: Sicbo, Pai-Gow, Pula-Puti, Big Wheel and the
 | KA Gaming / BetSoft reel games (their log / detail methods), the web 2.0
 | (/3) and "no install" (/non) pages, and the /test auto-login routes.
 |
 */

import { createHash, randomInt } from 'node:crypto';
import { requireUser, currentUser, type AuthContext } from '@/lib/auth';
import { config as appConfig } from '@/lib/config';
import { defineModel, type Db } from '@/lib/db';
import { input, isMobile } from '@/lib/http';
import { renderPage } from '@/lib/template';
import { getUserCredits } from '@/lib/vendor';
import {
	normalizeConfig, configLocale, viewConfig, applySettings, applyLastGameInfo,
	junketTable, parseJson, emptyJunketTable
} from './userConfig.ts';
import { row, sqlDate, jsonText, paginator, pageNumber, int, num, publicOrigin, domains, dealerImageSrc } from './format.ts';
import { betHistory, historyGame, queryBets, dealerNames, junketRange, HISTORY_GAMES, type HistoryGame, type BetFilter } from './history.ts';

type Params = Record<string, string>;

const auth = (req: Request) => requireUser(req);

// ------------------------------------------------------------------ pages

/** the shared data of the index3 / indexMobile3 views */
async function lobbyContext (req: Request, a: AuthContext) {
	const { user, vendor, db } = a;
	const config = normalizeConfig(user.configs, a.locale);
	const locale = configLocale(config);

	const [maintenance, group, tables, money] = await Promise.all([
		db.shared.maintenance.findOne({}).sort({ _id : 1 }).lean(),
		user.user_group_id === null || user.user_group_id === undefined ? null
			: db.shared.userGroups.findOne({ _id : user.user_group_id, vendor_id : user.vendor_id }).lean(),
		db.games.baccarat.tables.find({}, { bet_setting : 1 }).sort({ _id : 1 }).lean(),
		getUserCredits(db, user, vendor)
	]);

	// === Currency (user overrides of the vendor settings)
	const currency = user.currency || vendor.currency;
	const junket = num(user.is_junket, 0);

	// agent range: user_groups.ranges, [] when missing / empty
	const ranges = group ? parseJson((group as any).ranges, []) : [];
	const agentRange = ranges && (Array.isArray(ranges) ? ranges.length : Object.keys(ranges).length) ? ranges : [];

	const junketAuth = parseJson(vendor.junket_auth, null);
	const storedTables = vendor.junket_table;

	// json_encode($vendor) - without the wallet signing secret unless the
	// page needs it (junket agents post it to the junket admin site)
	const { secret_key, ...publicVendor } = row(vendor);
	const vendorData = { ...publicVendor, junket_auth : junketAuth, junket_table : jsonText(storedTables) };
	if (junket === 2) vendorData.secret_key = secret_key;

	const pcRedirectUrl = user.pc_redirect_url || '';

	return {
		locale,
		env : { socket : appConfig.socketUrl, ...domains(publicOrigin(req)) },
		cfg : viewConfig(config),
		user : { id : user.id, user_name : user.user_name, user_type : user.user_type, authority : user.authority },
		userAuthority : user.authority === 'a' ? 'admin' : 'user',
		money,
		integrationType    : vendor.integration_type,
		currency,
		currencyAbbrev     : currency,
		currencyMultiplier : num(user.denomination || vendor.multiplier, 1),
		mainMultiplier     : num(vendor.main_multiplier, 1),
		userMultiplier     : num(user.multiplier, 1),
		maintenance        : JSON.stringify(maintenance ? row(maintenance) : { id : null, status : '0', main_text : '', sub_text : '' }),
		gameSetting        : config.avarta.is_room ?? {},
		junket,
		agentRange,
		baccaratBetSetting : tables.map((t: any) => ({ bet_setting : jsonText(t.bet_setting), id : t._id })),
		vendor : {
			id              : vendor.id,
			vendor_name     : vendor.vendor_name,
			deployment_type : vendor.deployment_type ?? '',
			reel_yn         : num(vendor.reel_yn, 0),
			room_info_yn    : num(vendor.room_info_yn, 0),
			is_room         : num(vendor.is_room, 0),
			is_sound        : vendor.is_sound ?? '',
			junket_auth     : junketAuth,
			junket_end_date : vendor.junket_end_date instanceof Date ? sqlDate(vendor.junket_end_date) : (vendor.junket_end_date ?? '')
		},
		vendorData,
		// window.vendorTables: the raw junket_table JSON, '' when unset (main.js checks === "")
		vendorTables    : jsonText(storedTables) ?? '',
		pc_redirect_url : pcRedirectUrl,
		mountainLogo    : pcRedirectUrl.includes('mt-jk.com')
	};
}

/** GET / (index3): the 3.0 lobby; mobile user agents get the mobile 3.0 view */
export async function index3 (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	return renderPage('lobby', isMobile(req) ? 'index-mobile' : 'index', await lobbyContext(req, a));
}

/** GET /m (indexMobile3) */
export async function indexMobile3 (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	return renderPage('lobby', 'index-mobile', await lobbyContext(req, a));
}

/** GET /rejected (checkReject) - also shown to guests (the PHP crashed without a user) */
export async function checkReject (req: Request, params: Params = {}) {
	const a = await currentUser();
	const locale = a ? configLocale(normalizeConfig(a.user.configs, a.locale)) : 'en';
	return renderPage('lobby', 'rejected', { locale });
}

// ------------------------------------------------------------------ user

/** POST /getUserMoney */
export async function getUserMoney (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	return getUserCredits(a.db, a.user, a.vendor);
}

/** POST /settings (setUserConfig) - empty 200 like the PHP */
export async function setUserConfig (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const config = applySettings(a.user.configs, await input(req), a.locale);
	await a.db.shared.users.updateOne({ _id : a.user._id }, { $set : { configs : config } });
	return '';
}

/** POST /settingGame (setLastGameInfo) */
export async function setLastGameInfo (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { db, user, vendor } = a;

	const info = applyLastGameInfo(user.last_game_info, await input(req));
	await db.shared.users.updateOne({ _id : user._id }, { $set : { last_game_info : info } });

	if ((vendor.junket_table === null || vendor.junket_table === undefined) && user.is_junket) {
		await db.shared.vendors.updateOne({ _id : vendor._id, junket_table : null }, { $set : { junket_table : emptyJunketTable() } });
	}
	return '';
}

/** vendors.junket_table as a native { created_room, disable_table } object (legacy rows held JSON text) */
async function ensureJunketTable (db: Db, vendor: any) {
	const v: any = await db.shared.vendors.findById(vendor._id, { junket_table : 1 }).lean();
	const current = v && v.junket_table;
	const valid = current && typeof current === 'object' && Array.isArray(current.created_room) && Array.isArray(current.disable_table);
	if (!valid) {
		await db.shared.vendors.updateOne({ _id : vendor._id }, { $set : { junket_table : junketTable(current) } });
	}
}

/**
 * POST /setTableInfo (setJunketTableInfo): adds / removes `game` in the
 * vendor's junket_table[type] - atomically ($addToSet / $pull) instead of the
 * PHP read-modify-write that lost concurrent changes.
 */
export async function setJunketTableInfo (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { db, vendor } = a;
	const data = await input(req);
	const type = String(data.type ?? '');
	const game = data.game ?? null;
	const active = int(data.active);

	if (type !== 'created_room' && type !== 'disable_table') {
		return Response.json({ error : 'invalid type' }, { status : 422 });
	}

	await ensureJunketTable(db, vendor);
	const field = `junket_table.${type}`;
	const updated: any = await db.shared.vendors.findOneAndUpdate(
		{ _id : vendor._id },
		active ? { $addToSet : { [field] : game } } : { $pull : { [field] : game } },
		{ new : true, projection : { junket_table : 1 } }
	).lean();

	return { all_disabled : updated.junket_table[type], current_state : active, current_game : game };
}

// ------------------------------------------------------------------ dealers

const ids = (value: any): number[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value])
	.map(v => parseInt(v, 10)).filter(Number.isInteger);

async function dealerImages (db: Db, dealerIds: number[]) {
	if (!dealerIds.length) return [];
	const dealers: any[] = await db.shared.dealers.find({ _id : { $in : dealerIds } }, { dealer_image : 1, dealer_images : 1 }).lean();
	return dealers.map(d => ({ dealer_image : dealerImageSrc(d), id : d._id }));
}

/** POST /getDealerImg - dealerId[] */
export async function getDealerImg (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	return dealerImages(a.db, ids((await input(req)).dealerId));
}

/** POST /getChangeDealerImg - one dealerId (still answers with a list) */
export async function getChangeDealerImg (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	return dealerImages(a.db, ids((await input(req)).dealerId).slice(0, 1));
}

// ------------------------------------------------------------------ transfer logs

/** GET|POST /transferlogs - api_transfer_log of the user, Laravel paginate(10) JSON text */
export async function getTransferLogs (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const TransferLog = defineModel(a.db.shared.connection, 'api_transfer_log', 'api_transfer_log');
	const page = pageNumber(new URL(req.url).searchParams.get('page'));
	const filter = { user_id : a.user._id };
	const [total, docs] = await Promise.all([
		TransferLog.countDocuments(filter),
		TransferLog.find(filter).sort({ _id : -1 }).skip((page - 1) * 10).limit(10).lean()
	]);
	// ->toJson(): a JSON string answered as text/html
	return JSON.stringify(paginator(docs.map(row), total, page, 10, `${publicOrigin(req)}/transferlogs`));
}

// ------------------------------------------------------------------ per game paginated logs (web 2.0 endpoints)

/**
 * The paginated per-game logs (getBaccaratBetLogs & co.): bets of the user
 * whose round is E/W, newest round first, Laravel paginate(10) as JSON text.
 * Columns as the PHP selected them (bet_history / game_result raw JSON).
 */
async function pagedLogs (req: Request, game: HistoryGame, types: string[] | undefined, path: string) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const page = pageNumber(new URL(req.url).searchParams.get('page'));
	const { total, rows } = await queryBets(a.db, game, { userIds : [a.user._id], types }, {
		sort : { round_id : -1, _id : -1 }, skip : (page - 1) * 10, limit : 10
	});
	const dealers = await dealerNames(a.db, rows);
	const data = rows.map(({ bet, round }) => ({
		id            : bet._id,
		round_id      : bet.round_id,
		user_id       : bet.user_id,
		bet_history   : jsonText(bet.bet_history),
		type          : bet.type,
		total_bet     : bet.total_bet ?? null,
		total_winning : bet.total_winning ?? null,
		created_at    : sqlDate(bet.created_at),
		updated_at    : sqlDate(bet.updated_at),
		table_id      : round.table_id,
		name          : dealers.get(round.dealer_id) ?? null,
		game_result   : jsonText(round.game_result),
		total_win     : bet.total_win ?? null,
		total_rolling : bet.total_rolling ?? null,
		total_lost    : bet.total_lost ?? null,
		round_num     : round.round_num,
		bet_range     : bet.bet_range ?? null,
		status        : round.status
	}));
	return JSON.stringify(paginator(data, total, page, 10, `${publicOrigin(req)}/${path}`));
}

export const getBaccaratBetLogs    = (req: Request, params: Params = {}) => pagedLogs(req, 'baccarat', ['r', 'f'], 'baccaratlogs');
export const getSupersixBetLogs    = (req: Request, params: Params = {}) => pagedLogs(req, 'baccarat', ['s'], 'supersixlogs');
export const getDragonBonusBetLogs = (req: Request, params: Params = {}) => pagedLogs(req, 'baccarat', ['b'], 'dragonbonuslogs');
export const getPokerBetLogs       = (req: Request, params: Params = {}) => pagedLogs(req, 'poker', ['r'], 'pokerlogs');
export const getBonusPlusBetLogs   = (req: Request, params: Params = {}) => pagedLogs(req, 'poker', ['b'], 'bonuspluslogs');
export const getDragontigerBetLogs = (req: Request, params: Params = {}) => pagedLogs(req, 'dragontiger', undefined, 'dragontigerlogs');

/**
 * The details endpoints (getBaccaratDetails & co.): [{ bet_history,
 * game_info, game_result }] (raw JSON text) of one bet of the user,
 * identified by betId + round + table.
 */
async function details (req: Request, game: HistoryGame, types?: string[]) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await input(req);
	const betId = parseInt(data.betId, 10);
	if (!Number.isInteger(betId)) return [];

	const { rows } = await queryBets(a.db, game, {
		userIds  : [a.user._id],
		betId,
		types,
		roundNum : int(data.round),
		tableId  : int(data.table),
		exact    : true
	}, { sort : { _id : 1 }, skip : 0, limit : 1 });

	return rows.map(({ bet, round }) => ({
		bet_history : jsonText(bet.bet_history),
		game_info   : jsonText(round.game_info),
		game_result : jsonText(round.game_result)
	}));
}

export const getBaccaratDetails    = (req: Request, params: Params = {}) => details(req, 'baccarat');
export const getSupersixDetails    = (req: Request, params: Params = {}) => details(req, 'baccarat', ['s']);
export const getDragonBonusDetails = (req: Request, params: Params = {}) => details(req, 'baccarat', ['b']);
export const getPokerDetails       = (req: Request, params: Params = {}) => details(req, 'poker');
export const getBonusPlusDetails   = (req: Request, params: Params = {}) => details(req, 'poker');
export const getDragontigerDetails = (req: Request, params: Params = {}) => details(req, 'dragontiger');

// ------------------------------------------------------------------ stored procedure history

const ALL_GAMES = Object.keys(HISTORY_GAMES) as HistoryGame[];

/** games named by gameName: 'allgames' / '' -> every kept game, a dropped game -> none */
const gamesOf = (gameName: any): HistoryGame[] => {
	if (gameName === undefined || gameName === null || gameName === '' || gameName === 'allgames') return ALL_GAMES;
	const g = historyGame(gameName);
	return g ? [g] : [];
};

/**
 * USP_GET_NEW_ALL_BET_HISTORY(user, page) / USP_GET_ALL_BET_HISTORY(user, page):
 * the user's finished bets of every game, newest first, 11 per page.
 */
const allBetHistory = (db: Db, userId: number, page: any) =>
	betHistory(db, { gameType : 'L', games : ALL_GAMES, filter : { userIds : [userId] }, page : pageNumber(page) });

/**
 * USP_GET_GAME_BET_HISTORY(gameType, game, playType, user, table, round, page)
 * (and USP_GET_JUNKET_USER_BET_HISTORY(gameType, game, user, vendor, table, round, page)):
 * 'L' = page of the user's bets of one game (table / round when non zero),
 * 'D' = the user's bets of round `round` of table `table`. playType ('p')
 * has no counterpart in the MongoDB data and is ignored.
 */
const gameBetHistory = (db: Db, userId: number, d: Record<string, any>, gameName: any) =>
	betHistory(db, {
		gameType : d.gameType === 'D' ? 'D' : 'L',
		games    : gamesOf(gameName),
		filter   : { userIds : [userId], tableId : int(d.tableId), roundNum : int(d.roundNum) },
		page     : pageNumber(d.betPage)
	});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * USP_GET_JUNKET_AGENT_BET_HISTORY(gameType, game, searchId, vendor, table,
 * round, startDate, endDate, timeZone, page) - and the older
 * USP_GET_JUNKET_ALL_BET_HISTORY: bets of every player of the agent's own
 * vendor (the posted vendor_id is not trusted), searchId matching part of
 * the player id / name, created between the local start / end days, rows
 * carrying the player id. 'D' rows are limited to the posted user_id.
 */
async function agentBetHistory (db: Db, agent: any, d: Record<string, any>, gameName: any) {
	const userFilter: any = { vendor_id : agent.vendor_id };
	const search = d.searchId === undefined || d.searchId === null ? '' : String(d.searchId).trim();
	if (search) {
		const re = new RegExp(escapeRegex(search), 'i');
		userFilter.$or = [{ user_id : re }, { user_name : re }];
	}
	const detail = d.gameType === 'D';
	if (detail && d.user_id !== undefined && d.user_id !== null && d.user_id !== '') {
		userFilter.user_id = String(d.user_id);
	}

	const users: any[] = await db.shared.users.find(userFilter, { user_id : 1, user_name : 1 }).lean();
	const { from, to } = junketRange(d.startDate, d.endDate, int(d.timeZone));
	const filter: BetFilter = {
		userIds  : users.map(u => u._id),
		tableId  : int(d.tableId),
		roundNum : int(d.roundNum),
		from,
		to
	};
	return betHistory(db, {
		gameType : detail ? 'D' : 'L',
		games    : gamesOf(gameName),
		filter,
		page     : pageNumber(d.betPage ?? d.page),
		users    : new Map(users.map(u => [u._id, u]))
	});
}

/** GET|POST /alllogs (getAllLogs) */
export async function getAllLogs (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const d = await input(req);

	if (num(a.user.is_junket, 0) === 2) {
		// the PHP passed fixed 2018 dates to USP_GET_JUNKET_ALL_BET_HISTORY; no date limit here
		return agentBetHistory(a.db, a.user, { ...d, gameType : d.gameType, betPage : d.page }, '');
	}
	return allBetHistory(a.db, a.user._id, d.betPage);
}

/** GET|POST /m/alllogs (getAllLogsMobile) */
export async function getAllLogsMobile (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	return allBetHistory(a.db, a.user._id, (await input(req)).pageNum);
}

/** GET|POST /getLogs (getGameLogs) - the 3.0 lobby bet records (menuBetRecords.js) */
export async function getGameLogs (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { db, user } = a;
	const d = await input(req);
	const gameName = d.gameName;
	const junket = num(user.is_junket, 0);

	if (junket === 2) {
		return agentBetHistory(db, user, d, gameName === 'allgames' ? '' : gameName);
	}
	if (junket === 1) {
		return gameBetHistory(db, user._id, gameName === 'allgames' ? { ...d, gameType : 'L' } : d, gameName);
	}
	if (gameName === 'allgames') {
		return allBetHistory(db, user._id, d.betPage);
	}
	return gameBetHistory(db, user._id, d, gameName);
}

// ------------------------------------------------------------------ junket rooms

const sha256 = (value: any) => createHash('sha256').update(value === undefined || value === null ? '' : String(value)).digest('hex');

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** BetHistoryController::getToken */
export const roomToken = (length = 20) => Array.from({ length }, () => TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]).join('');

/**
 * GET|POST /setRoomData - USP_ROOMS_SAVE('I', game, 0, table, roomType, user,
 * '1', name, sha256(password), betRange, maxPlayers, duration): inserts a
 * shared `rooms` document and answers its token and id (`flag`, later sent
 * back as checkPass roomId); then lists "<game>-<table>" in the vendor's
 * junket_table.created_room.
 */
export async function setRoomData (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { db, user, vendor } = a;
	const d = await input(req);
	const hash = d.password ? sha256(d.password) : '';
	const token = roomToken(20);
	const id = await db.shared.nextId('rooms');

	await db.shared.rooms.create({
		_id         : id,
		game        : d.gamename ?? null,
		table_id    : int(d.tableId),
		vendor_id   : user.vendor_id,
		user_id     : user._id,
		name        : d.roomName ?? '',
		type        : d.roomType ?? null,
		password    : hash,
		bet_range   : d.betRange ?? null,
		max_players : d.maxPlayers ?? null,
		duration    : d.duration ?? null,
		avatar      : d.avatar ?? null,
		token,
		users       : [],
		status      : '1'
	});

	await ensureJunketTable(db, vendor);
	await db.shared.vendors.updateOne({ _id : vendor._id }, { $addToSet : { 'junket_table.created_room' : `${d.gamename}-${d.tableId}` } });

	return {
		tableId    : d.tableId ?? null,
		userId     : user.id,
		roomName   : d.roomName ?? null,
		roomToken  : token,
		flag       : id,
		betRange   : d.betRange ?? null,
		gamename   : d.gamename ?? null,
		maxPlayers : d.maxPlayers ?? null,
		password   : hash,
		duration   : d.duration ?? null
	};
}

/** GET|POST /checkPass - 'true' / 'false' (text) whether `password` opens room `roomId` */
export async function checkPass (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const d = await input(req);
	const roomId = parseInt(d.roomId, 10);
	if (!Number.isInteger(roomId)) return 'false';
	const room: any = await a.db.shared.rooms.findById(roomId, { password : 1 }).lean();
	return room && room.password === sha256(d.password) ? 'true' : 'false';
}

/**
 * GET|POST /canCreateRoom - USP_GET_CAN_CREATE_ROOM(vendor): [{ flag }] with
 * 'F' once the vendor's junket subscription (junket_end_date) has ended
 * (the JS then shows "out of date"), 'T' otherwise. Always the user's own
 * vendor.
 */
export async function canCreateRoom (req: Request, params: Params = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const end = a.vendor.junket_end_date;
	const endTime = end ? new Date(end).getTime() : NaN;
	return [{ flag : !Number.isNaN(endTime) && endTime < Date.now() ? 'F' : 'T' }];
}
