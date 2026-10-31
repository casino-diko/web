/*
 |--------------------------------------------------------------------------
 | BaccaratController
 |--------------------------------------------------------------------------
 | Port of baccarat/app/Http/Controllers/BaccaratController.php (plus the
 | used parts of Controller.php, see lib/vendor.ts). One exported function
 | per routed PHP method, `(req, params) => Response | value`, wired with
 | lib/http handler(). Former stored procedures are reconstructed on
 | MongoDB, see the comment above each function.
 |
 | Money: transfer vendors keep the balance in users.money. The stake is
 | debited when a bet is stored and refunded when it is cancelled, in the
 | same transaction as the bet document; the game-server credits total_win
 | at settlement. Seamless vendors are debited / refunded through the vendor
 | API (lib/vendor transact).
 |
 */

import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { requireUser, currentUser, viaExit, type AuthContext } from '@/lib/auth';
import { config } from '@/lib/config';
import { defineModel, type Db } from '@/lib/db';
import { clientIp, isMobile } from '@/lib/http';
import { tableVideo } from '@/lib/video';
import { readSession } from '@/lib/session';
import { renderPage } from '@/lib/template';
import { getJunketCredits, getUserCredits, transact } from '@/lib/vendor';
import {
	agentRanges, applyGameSettings, applyUserConfig, balanceOk, betType, buildBetHistory, configLocale,
	historyRow, jsonText, jsonValue, pageNumber, paginate, rangeDisplay, rangeRows, SLAVE_NAMES, sqlDate,
	tableTypes, userConfig, validateBets, viewConfig
} from './helpers';
import { phpInput } from './request';

const GAME = 'Baccarat';          // env('CUR_GAME')
const API_GAME = 'baccarat';      // /api/transact/baccarat/{type}

type Params = Record<string, string>;

const toInt = (v: any) => {
	const n = parseInt(v);
	return Number.isInteger(n) ? n : null;
};

const notFound = () => new Response('Not Found', { status : 404 });

async function auth (req: Request): Promise<AuthContext | Response> {
	return requireUser(req);
}

const games = (db: Db) => db.games.baccarat;

// baccarat.rooms (junket rooms created from the lobby, USP_ROOMS_SAVE 'I')
const rooms = (db: Db) => defineModel(games(db).connection, 'room', 'rooms');
// nihtan_api.api_transfer_log
const transferLogs = (db: Db) => defineModel(db.shared.connection, 'api_transfer_log', 'api_transfer_log');

const latestRound = (db: Db, table: number) =>
	games(db).rounds.findOne({ table_id : table }, { _id : 1, status : 1, round_num : 1 }).sort({ _id : -1 }).lean() as Promise<any>;

/** Controller::getCurrencyData + the user overrides used everywhere */
function currencyOf (user: any, vendor: any) {
	return {
		currency           : user.currency || vendor.currency || null,
		multiplier         : Number(user.denomination) || Number(vendor.multiplier) || 1,
		vendorMultiplier   : Number(vendor.multiplier) || 1,
		// percentage of the max bet; the views treat 100 as "as configured"
		mainMultiplier     : vendor.main_multiplier ?? 100
	};
}

/** md5(user id . user name . round id) */
const transactionId = (user: any, roundId: number) =>
	createHash('md5').update(`${user._id}${user.user_name ?? ''}${roundId}`).digest('hex');

/** scheme + host the player used (behind a proxy: X-Forwarded-*) */
export function originOf (req: Request) {
	const url = new URL(req.url);
	const first = (h: string | null) => (h || '').split(',')[0].trim();
	const proto = first(req.headers.get('x-forwarded-proto')) || url.protocol.replace(':', '');
	const host = first(req.headers.get('x-forwarded-host')) || req.headers.get('host') || url.host;
	return `${proto}://${host}`;
}

/** the former env('*_DOMAIN') values; they end with "/" because the scripts append paths */
function domains (req: Request) {
	const o = originOf(req);
	return {
		APP_SOCKET   : config.socketUrl,
		BC_DOMAIN    : `${o}/baccarat/`,
		DT_DOMAIN    : `${o}/dragon-tiger/`,
		P_DOMAIN     : `${o}/poker/`,
		LOBBY_DOMAIN : `${o}/`,
		// sicbo and pai-gow are gone
		SB_DOMAIN    : '',
		PG_DOMAIN    : '',
		CUR_GAME     : GAME
	};
}

const redirect = (url: string) => new Response(null, { status : 302, headers : { location : url } });

const lobbyRedirect = (req: Request, a: AuthContext, mobile = false) => {
	const { user, vendor } = a;
	if (vendor.lobby_type === 'integrated') {
		const url = viaExit(a, (mobile && user.mo_redirect_url) || user.pc_redirect_url);
		if (url) return redirect(url);
	}
	return redirect(domains(req).LOBBY_DOMAIN);
};

// JSON for a <script> block / a single quoted JS string
const scriptJson = (v: any) => JSON.stringify(v ?? null).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
const jsString = (v: any) => String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/</g, '\\x3c').replace(/\r?\n/g, '\\n');
const jsNumber = (v: any, fallback = 0) => (isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);

async function loadConfig (db: Db, user: any, locale: string) {
	const fresh: any = await db.shared.users.findById(user._id, { configs : 1 }).lean();
	return userConfig(fresh ? fresh.configs : null, locale);
}

/** keeps the column's storage type (text when it was text) */
const store = (previous: any, value: any) => (typeof previous === 'string' ? JSON.stringify(value) : value);

// ------------------------------------------------------------------ action / bet logs

/**
 * INSERT INTO action_logs ... ON DUPLICATE KEY UPDATE actions = JSON_MERGE(actions, ?)
 * (unique key user + table + round + type).
 */
async function writeActionLog (db: Db, data: { userId : number; table : number; roundNum : number | null; type : any; logs : any; ip : string },
	session: ClientSession | null = null) {
	const g = games(db);
	const actions = (Array.isArray(data.logs) ? data.logs : [data.logs]).filter(l => l !== null && l !== undefined && l !== '');
	await g.actionLogs.updateOne(
		{ user_id : data.userId, table_id : data.table, round_num : data.roundNum, type : data.type ?? null },
		{ $push : { actions : { $each : actions } }, $setOnInsert : { _id : await g.nextId('action_logs', session), ip : data.ip } },
		{ upsert : true, session }
	);
}

/** what USP_STORE_BET kept of every call ('I' store, 'D' cancel, 'F' failed vendor debit) */
async function writeBetLog (db: Db, data: { userId : number; table : number; round : any; range : string; mode : string; logs : any; bets : any; total : number },
	session: ClientSession | null = null) {
	const g = games(db);
	await g.betLogs.updateOne(
		{ user_id : data.userId, round_id : data.round._id, bet_range : data.range },
		{
			$push        : { actions : { mode : data.mode, total_bet : data.total, bets : data.bets, logs : data.logs ?? null, at : new Date() } },
			$setOnInsert : { _id : await g.nextId('bet_logs', session), table_id : data.table, round_num : data.round.round_num }
		},
		{ upsert : true, session }
	);
}

class BetFail extends Error {
	constructor (public fail: number, public prevBets: any[] = []) {
		super(`bet failed (${fail})`);
	}
}

// ------------------------------------------------------------------ pages

/**
 * getVendor: the junket room of a ?token= link (baccarat.rooms) and its banker.
 */
async function roomData (db: Db, user: any, token: string, table: number, range: string | null) {
	const filter: any = { table_id : table, token };
	if (range !== null) filter.bet_range = range;
	const room: any = await rooms(db).findOne(filter).lean();
	if (!room) return null;

	const banker: any = await db.shared.users.findById(room.user_id, { user_name : 1, vendor_id : 1, multiplier : 1 }).lean();
	const bankerVendor: any = banker ? await db.shared.vendors.findById(banker.vendor_id, { vendor_name : 1 }).lean() : null;

	return {
		bankerId         : room.user_id,
		roomId           : room._id,
		userCnt          : room.players_cnt ?? null,
		title            : room.title ?? null,
		betRange         : room.bet_range ?? null,
		roomPass         : room.password ?? null,
		bankerUsername   : banker ? banker.user_name : null,
		vendorId         : banker ? banker.vendor_id : null,
		bankerMultiplier : banker ? banker.multiplier ?? null : null,
		vendorName       : bankerVendor ? bankerVendor.vendor_name : null,
		token,
		isJunket         : user.is_junket ?? null
	};
}

/** user group (agent) ranges override the table's ranges */
async function agentRange (db: Db, user: any, table: any) {
	if (user.user_group_id === null || user.user_group_id === undefined) return { ranges : null, agent : [] as any[] };
	const group: any = await db.shared.userGroups.findOne({ vendor_id : user.vendor_id, _id : user.user_group_id }).lean();
	if (!group) return { ranges : null, agent : [] as any[] };
	const agent = jsonValue(group.ranges, []);
	return { ranges : agentRanges(agent, table, GAME), agent : Array.isArray(agent) ? agent : [] };
}

function junketTables (vendor: any) {
	const v = jsonValue(vendor.junket_table, null);
	return {
		disable_table : Array.isArray(v?.disable_table) ? v.disable_table : [],
		created_room  : Array.isArray(v?.created_room) ? v.created_room : []
	};
}

/** values every game page shows (index, index-mobile, index-mobile-non) */
async function commonView (req: Request, a: AuthContext, table: number, tableDoc: any) {
	const { user, vendor, db } = a;
	const cur = currencyOf(user, vendor);
	const userMultiplier = jsNumber(user.multiplier, 1) || 1;
	const config = await loadConfig(db, user, a.locale);
	const locale = configLocale(config);
	const round: any = await games(db).rounds.findOne({ table_id : table }, { round_num : 1 }).sort({ _id : -1 }).lean();
	const env = tableDoc.env_setting || {};

	return {
		cur, userMultiplier, config, locale,
		ctx : {
			locale,
			env                : domains(req),
			cfg                : viewConfig(config),
			tutorialEnabled    : config.avarta.tutorial && config.avarta.tutorial.enabled !== undefined ? String(config.avarta.tutorial.enabled) : 'true',
			currencyAbbrev     : jsString(cur.currency),
			currency           : cur.currency,
			currencyMultiplier : cur.multiplier,
			mainMultiplier     : jsNumber(cur.mainMultiplier, 100),
			userMultiplier,
			userChips          : scriptJson(config.avarta.chips),
			userId             : user._id,
			userType           : user.user_type ?? '',
			userAuthority      : user.authority === 'a' ? 'admin' : 'user',
			user_name          : user.user_name ?? '',
			money              : await getUserCredits(db, user, vendor),
			round_id           : round ? round.round_num : 0,
			table,
			tableNum           : table,
			integrationType    : jsString(vendor.integration_type),
			reel_yn            : jsNumber(vendor.reel_yn, 0),
			room_yn            : jsNumber(vendor.room_info_yn, 0),
			vendor_id          : vendor._id,
			lobby_type         : jsString(vendor.lobby_type),
			vendorSound        : jsString(vendor.is_sound ?? 1),
			video              : tableVideo('baccarat', table, env, req.headers.get('cf-ipcountry') || req.headers.get('x-country-code') || ''),
			tType              : tableTypes(tableDoc.bet_setting, null).tType
		}
	};
}

const activeTable = (db: Db, table: number) =>
	games(db).tables.findOne({ _id : table, status : '1' }).lean() as Promise<any>;

/**
 * GET /{table}, /{table}/{game}: the game page. {game} "m" is the mobile
 * page of the installed app, "j" (with ?token=) a junket room; other values
 * (old range links) show the desktop page. Without {game} a mobile user
 * agent gets the browser version of the mobile page (the PHP app always
 * rendered the desktop one there).
 */
type PageOptions = {
	// mobile page for browsers without the installed app (video, fullscreen / sound prompts)
	nonInstall?  : boolean;
	// range and multiplayer taken from the url instead of the last game settings
	range?       : string;
	multiplayer? : string;
};

export async function init (req: Request, params: Params, opts: PageOptions = {}) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { user, vendor, db } = a;
	const table = toInt(params.table);
	const gameType = params.game ?? null;
	const query = new URL(req.url).searchParams;
	// a phone browser opening /{table} gets the browser version of the mobile page; /{table}/m and
	// /m/{table} stay the installed app's page (it talks to the app shell, plays no video itself)
	const nonInstall = !!opts.nonInstall || (gameType === null && isMobile(req));
	const mobile = nonInstall || gameType === 'm';

	const tableDoc = table === null ? null : await activeTable(db, table);
	if (!tableDoc) return notFound();

	// junket room links (?token=)
	const token = query.get('token');
	let vendorData: any = null;
	if (token) {
		vendorData = await roomData(db, user, token, table, null);
		if (!vendorData) return redirect(`${domains(req).LOBBY_DOMAIN}?game=true`);
		// the PHP code called an undefined checkRoom() for /{table}?token=; rooms are always opened as /{table}/j
	}

	let currentRange: any[] = jsonValue(vendorData ? tableDoc.sport_bet_ranges : tableDoc.casino_bet_ranges, []) || [];
	const { agent, ranges } = await agentRange(db, user, tableDoc);
	if (ranges) currentRange = ranges;
	if (!currentRange.length) return notFound();

	let { type, slave } = tableTypes(tableDoc.bet_setting, query.get('slave') ?? undefined);

	// previous bet of the running round decides the side game
	const g = games(db);
	const [lastBet, lastRound]: any[] = await Promise.all([
		g.bets.findOne({ user_id : user._id }, { round_id : 1, type : 1 }).sort({ _id : -1 }).lean(),
		g.rounds.findOne({ table_id : table }, { _id : 1 }).sort({ _id : -1 }).lean()
	]);
	if (lastBet && lastRound && lastRound._id === lastBet.round_id) {
		if (lastBet.type === 'b') slave = 'bonus';
		else if (lastBet.type === 's') slave = 'supersix';
	}

	// last game settings (setGameSettings) select the range
	const fresh: any = await db.shared.users.findById(user._id, { last_game_info : 1 }).lean();
	const gameSettings: any = jsonValue(fresh?.last_game_info, null) || {};
	let rangeDetails = currentRange[0];
	let range = `${rangeDetails.min}-${rangeDetails.max}`;
	let multiplayer: any = 0;
	let isMatch = false;
	if (opts.range !== undefined) {
		const [min, max] = opts.range.split('-');
		const found = currentRange.find(r => r.min == min && r.max == max);
		if (!found) return redirect(`${domains(req).LOBBY_DOMAIN}?game=true`);
		rangeDetails = found;
		range = opts.range;
		multiplayer = opts.multiplayer ?? 0;
		isMatch = true;
	} else if (gameSettings.game === `${GAME}/${table}` && typeof gameSettings.bet_range === 'string') {
		const [min, max] = gameSettings.bet_range.split('-');
		const found = currentRange.find(r => r.min == min && r.max == max);
		slave = gameSettings.slave ?? slave;
		if (found) {
			rangeDetails = found;
			range = gameSettings.bet_range;
			multiplayer = gameSettings.multi_yn ?? 0;
			isMatch = true;
		}
	}
	if (!isMatch) {
		rangeDetails = currentRange[0];
		range = `${rangeDetails.min}-${rangeDetails.max}`;
		multiplayer = 0;
	}

	if (vendorData && range != vendorData.betRange) return lobbyRedirect(req, a, mobile);

	// junket vendors: disabled tables and rooms
	const junket = Number(user.is_junket) || 0;
	if (junket > 0) {
		const jt = junketTables(vendor);
		const current = `${GAME}-${table}`.toLowerCase();
		if (jt.disable_table.some((t: string) => String(t).toLowerCase() === current)) return lobbyRedirect(req, a, mobile);
		if (junket === 1 && !vendorData && jt.created_room.some((t: string) => String(t).toLowerCase() === current)) {
			return lobbyRedirect(req, a, mobile);
		}
	}

	const view = await commonView(req, a, table, tableDoc);
	const rd = rangeDisplay(rangeDetails, view.cur.multiplier, view.userMultiplier, view.cur.mainMultiplier);

	return renderPage('baccarat', mobile ? 'index-mobile' : 'index', {
		...view.ctx,
		type,
		slave                 : slave ?? '',
		range,
		multiplayer,
		rangeDetailsJson      : scriptJson(rangeDetails),
		rd,
		allRange              : currentRange,
		allRangeRows          : rangeRows(currentRange, range, view.cur.multiplier, view.userMultiplier, view.cur.mainMultiplier),
		lobby_redirect_url    : jsString(viaExit(a, mobile ? (user.mo_redirect_url || user.pc_redirect_url) : user.pc_redirect_url)),
		vendorData            : scriptJson(vendorData || []),
		vendorDataObj         : vendorData || {},
		hasToken              : !!token,
		isClassic             : !vendorData,
		junketModeClass       : vendorData ? 'junketMode' : '',
		gameInfo              : scriptJson(gameSettings),
		agentRange            : scriptJson(agent),
		junket,
		vendorTables          : jsString(jsonText(vendor.junket_table) ?? ''),
		vendorEndDate         : jsString(junket > 0 ? sqlDate(vendor.junket_end_date) ?? vendor.junket_end_date ?? '' : ''),
		nonInstall            : nonInstall ? 1 : 0,
		// geoplugin.net lookup dropped: country from the proxy / CDN header when there is one
		countryCheck          : req.headers.get('cf-ipcountry') || req.headers.get('x-country-code') || ''
	});
}

/** GET /m/{table}: the PHP route never worked (initMobile wanted 3 arguments); shows the mobile page */
export async function initMobile (req: Request, params: Params) {
	return init(req, { table : params.table, game : 'm' });
}

/**
 * GET /non/Baccarat/{table}/{range}/{multiplayer}: the mobile page for
 * browsers without the installed app. The former index-mobile-non view no
 * longer matched the mobile bundle (it crashed on start), so this renders
 * the current mobile page with the browser parts enabled (HLS video,
 * fullscreen / sound prompts).
 */
export async function initNonMobile (req: Request, params: Params) {
	return init(req, { table : params.table, game : 'm' }, {
		nonInstall  : true,
		range       : params.range || '',
		multiplayer : params.multiplayer
	});
}

/** GET /rejected (outside the auth group) */
export async function checkReject (req: Request) {
	const a = await currentUser();
	let locale = 'en';
	if (a) locale = configLocale(await loadConfig(a.db, a.user, a.locale));
	else locale = (await readSession())?.locale || 'en';
	return renderPage('baccarat', 'rejected', { locale });
}

// ------------------------------------------------------------------ settings

/** POST /settings */
export async function setUserConfig (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await phpInput(req);
	const fresh: any = await a.db.shared.users.findById(a.user._id, { configs : 1 }).lean();
	const configObj = applyUserConfig(userConfig(fresh?.configs, a.locale), data);
	await a.db.shared.users.updateOne({ _id : a.user._id }, { $set : { configs : store(fresh?.configs, configObj) } });
	return '';
}

/** POST /setGameSettings: users.last_game_info */
export async function setGameSettings (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const fresh: any = await a.db.shared.users.findById(a.user._id, { last_game_info : 1 }).lean();
	const info = applyGameSettings(jsonValue(fresh?.last_game_info, {}), input);
	await a.db.shared.users.updateOne({ _id : a.user._id }, { $set : { last_game_info : store(fresh?.last_game_info, info) } });
	return '';
}

/**
 * POST /settings/videoSetting, former nihtan_api.USP_VIDEO_SETTING(user, type):
 * the quality is what the page reads back as configs.avarta.video; also
 * kept per user in video_settings.
 */
export async function setVideoSetting (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { type } = await phpInput(req);
	if (type !== 'HD' && type !== 'SD') return '';
	const fresh: any = await a.db.shared.users.findById(a.user._id, { configs : 1 }).lean();
	const configObj = userConfig(fresh?.configs, a.locale);
	configObj.avarta.video = type;
	await a.db.shared.users.updateOne({ _id : a.user._id }, { $set : { configs : store(fresh?.configs, configObj) } });
	await a.db.shared.videoSettings.updateOne(
		{ user_id : a.user._id },
		{ $set : { type }, $setOnInsert : { _id : await a.db.shared.nextId('video_settings') } },
		{ upsert : true }
	);
	return '';
}

// ------------------------------------------------------------------ junket rooms

/** POST /checkTable: vendors.junket_table (as JSON text, the script JSON.parse()s it) */
export async function checkTable (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const vendor: any = await a.db.shared.vendors.findById(a.user.vendor_id, { junket_table : 1 }).lean();
	return [{ junket_table : JSON.stringify(junketTables(vendor || {})) }];
}

/** POST /checkPassword: sha256 of the password (compared with the room's password client side) */
export async function checkPassword (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { password } = await phpInput(req);
	return password ? createHash('sha256').update(String(password)).digest('hex') : '';
}

/**
 * POST /updateRoom, former nihtan_api.USP_ROOMS_SAVE(flag, 'baccarat', roomId,
 * tableId, roomType, userId, status, '', password, '', 0, 0). The page only
 * sends flag 'P' (password change); only the room's banker may change it.
 */
export async function setRoomInfo (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const password = input.password ? createHash('sha256').update(String(input.password)).digest('hex') : '';
	const roomId = toInt(input.roomId);
	if (roomId === null) return password;

	const set: any = {};
	if (input.flag === 'P') set.password = password;
	if (input.status !== undefined) set.status = String(input.status);
	if (Object.keys(set).length) {
		await rooms(a.db).updateOne({ _id : roomId, user_id : a.user._id, table_id : toInt(input.tableId) ?? { $exists : true } }, { $set : set });
	}
	return password;
}

/**
 * POST /getJunket/{roomId}, former baccarat.USP_JUNKET_PAYOUT(roomId): per
 * room member the total stake and net win/lose of their room bets.
 */
export async function getJunketUsers (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const roomId = toInt(params.roomId);
	if (roomId === null) return [];
	const g = games(a.db);
	const bets: any[] = await g.bets.find({ room_id : { $in : [roomId, String(roomId)] } }, { user_id : 1, round_id : 1, total_bet : 1, total_win : 1 }).lean();
	const settled = new Set((await g.rounds.find({ _id : { $in : [...new Set(bets.map(b => b.round_id))] }, status : 'E' }, { _id : 1 }).lean()).map((r: any) => r._id));
	const byUser = new Map<number, { user_id : number; total_bet : number; total_win : number }>();
	for (const b of bets) {
		const row = byUser.get(b.user_id) || { user_id : b.user_id, total_bet : 0, total_win : 0 };
		row.total_bet += Number(b.total_bet) || 0;
		// win/lose only counts resulted rounds
		if (settled.has(b.round_id)) row.total_win += (Number(b.total_win) || 0) - (Number(b.total_bet) || 0);
		byUser.set(b.user_id, row);
	}
	return [...byUser.values()].sort((x, y) => x.user_id - y.user_id);
}

/** POST /get/users: balances of junket room members */
export async function getUsers (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const ids = (Array.isArray(input.users) ? input.users : input.users ? [input.users] : []).map(toInt).filter((v: any) => v !== null);
	if (!ids.length) return 'no users';

	const users: any[] = await a.db.shared.users.find({ _id : { $in : ids } }, { user_id : 1, user_name : 1, money : 1 }).lean();
	const format = users.map(u => ({ user_id : u.user_id, user_name : u.user_name, credits : u.money }));
	const response = await getJunketCredits(a.vendor, input.vendor_name, format);
	return response !== 'transfer' ? response : JSON.stringify(format);
}

// ------------------------------------------------------------------ logs / history

/** GET|POST /{table}/{range}/{multiplayer}/transferlogs */
export async function getTransferLogs (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const page = pageNumber(input.page);
	const Logs = transferLogs(a.db);
	const filter = { user_id : a.user._id };
	const [total, rows] = await Promise.all([
		Logs.countDocuments(filter),
		Logs.find(filter).sort({ _id : -1 }).skip((page - 1) * 10).limit(10).lean()
	]);
	const data = rows.map(({ _id, ...r }: any) => ({ id : _id, ...r, created_at : sqlDate(r.created_at), updated_at : sqlDate(r.updated_at) }));
	return JSON.stringify(paginate(data, total, page, 10, '/transferlogs'));
}

/** bets of a user joined with their rounds (rounds live in the same db) */
async function userRoundBets (db: Db, betMatch: any, roundMatch: any, page: number, perPage: number) {
	const [res]: any[] = await games(db).bets.aggregate([
		{ $match : betMatch },
		{ $lookup : { from : 'rounds', localField : 'round_id', foreignField : '_id', as : 'round' } },
		{ $unwind : '$round' },
		{ $match : Object.fromEntries(Object.entries(roundMatch).map(([k, v]) => [`round.${k}`, v])) },
		{ $sort : { round_id : -1, _id : -1 } },
		{ $facet : {
			total : [{ $count : 'n' }],
			rows  : [{ $skip : Math.max(page - 1, 0) * perPage }, { $limit : perPage }]
		} }
	]);
	return { total : res?.total?.[0]?.n || 0, rows : res?.rows || [] };
}

const dealersById = async (db: Db, ids: any[]) => {
	const list: any[] = await db.shared.dealers.find({ _id : { $in : [...new Set(ids.filter(v => v !== null && v !== undefined))] } }, { name : 1 }).lean();
	return new Map(list.map(d => [d._id, d]));
};

/** GET|POST .../betlogsM */
export async function getBetLogsMobile (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const table = toInt(input.tableId);
	// $request->input('slave')[0]: first letter of the side game name
	const slave = input.slave ? String(Array.isArray(input.slave) ? input.slave[0] : input.slave)[0] : 'r';
	const page = pageNumber(input.page);
	const { total, rows } = await userRoundBets(a.db, { user_id : a.user._id, type : { $in : [slave] } },
		{ table_id : table, status : { $in : ['E', 'W'] } }, page, 10);

	const data = rows.map((b: any) => ({
		round_id      : b.round_id,
		user_id       : b.user_id,
		bet_history   : jsonText(b.bet_history),
		total_bet     : b.total_bet,
		total_winning : b.total_winning,
		created_at    : sqlDate(b.created_at),
		updated_at    : sqlDate(b.updated_at),
		game_result   : jsonText(b.round.game_result),
		game_info     : jsonText(b.round.game_info),
		total_rolling : b.total_rolling,
		total_win     : b.total_win,
		table_id      : b.round.table_id,
		total_lost    : b.total_lost,
		round_num     : b.round.round_num,
		status        : b.round.status
	}));
	return JSON.stringify(paginate(data, total, page, 10, '/betlogs'));
}

/**
 * Former USP_NEW_GET_BET_HISTORY(gameType, userId, tableId, roundNum, count, page)
 * and USP_GET_JUNKET_BET_HISTORY(gameType, roomId, ...):
 *   'L' a page of the user's resulted (E) / voided (W) bets on the table, every
 *       row carries `cnt`, the total number of rows;
 *   'D' the user's bet(s) of round number roundNum.
 */
async function betHistory (db: Db, o: { gameType : string; userId : number; tableId : number; roundNum : number; count : number; page : number; roomId? : number | null }) {
	const betMatch: any = { user_id : o.userId };
	if (o.roomId !== undefined && o.roomId !== null) betMatch.room_id = { $in : [o.roomId, String(o.roomId)] };
	const roundMatch: any = { table_id : o.tableId, status : { $in : ['E', 'W'] } };
	const detail = o.gameType === 'D';
	if (detail) roundMatch.round_num = o.roundNum;

	const count = Math.min(Math.max(o.count || 11, 1), 100);
	const { total, rows } = await userRoundBets(db, betMatch, roundMatch, detail ? 1 : Math.max(o.page, 1), detail ? 100 : count);
	const dealers = await dealersById(db, rows.map((r: any) => r.round.dealer_id));
	return rows.map((b: any) => historyRow(b, b.round, dealers.get(b.round.dealer_id), total));
}

/** GET|POST .../betlogs (the player's own history; the posted userId is ignored) */
export async function getBetLogs (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	return betHistory(a.db, {
		gameType : input.gameType === 'D' ? 'D' : 'L',
		userId   : a.user._id,
		tableId  : toInt(input.tableId),
		roundNum : toInt(input.roundNum) ?? 0,
		count    : toInt(input.count) ?? 11,
		page     : toInt(input.betPage) ?? 1
	});
}

/** POST /getJunketLogs: a room member's history, for the room's banker (or the member) */
export async function getJunketLogs (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const roomId = toInt(input.roomId);
	const userId = toInt(input.userId) ?? a.user._id;
	if (roomId === null) return [];
	if (userId !== a.user._id && !(await rooms(a.db).exists({ _id : roomId, user_id : a.user._id }))) return [];
	return betHistory(a.db, {
		gameType : input.gameType === 'D' ? 'D' : 'L',
		roomId,
		userId,
		tableId  : toInt(input.tableId),
		roundNum : toInt(input.roundNum) ?? 0,
		count    : 11,
		page     : toInt(input.betPage) ?? 1
	});
}

/** POST /details/getDetails: bet + cards + result of one round (round = rounds id) */
export async function getDetails (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const roundId = toInt(input.round);
	if (roundId === null) return [];
	const g = games(a.db);
	const [bets, round]: any[] = await Promise.all([
		g.bets.find({ round_id : roundId, user_id : a.user._id }, { bet_history : 1 }).sort({ _id : 1 }).lean(),
		g.rounds.findById(roundId, { game_info : 1, game_result : 1 }).lean()
	]);
	return bets.map(b => ({
		bet_history : jsonText(b.bet_history),
		game_info   : jsonText(round ? round.game_info : null),
		game_result : jsonText(round ? round.game_result : null)
	}));
}

/** GET|POST .../gamehistory: resulted rounds of the table (not the current one) with their dealer */
export async function getGameHistory (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const table = toInt(input.tableId);
	const page = pageNumber(input.page);
	const g = games(a.db);
	const current: any = await g.rounds.findOne({ table_id : table }, { round_num : 1 }).sort({ round_num : -1 }).lean();
	// inner join on dealers
	const dealers: any[] = await a.db.shared.dealers.find({}, { name : 1 }).lean();
	const byId = new Map(dealers.map(d => [d._id, d]));
	const filter = { table_id : table, round_num : { $lt : current ? current.round_num : 0 }, dealer_id : { $in : [...byId.keys()] } };
	const [total, rows] = await Promise.all([
		g.rounds.countDocuments(filter),
		g.rounds.find(filter).sort({ round_num : -1 }).skip((page - 1) * 10).limit(10).lean()
	]);
	const data = rows.map((r: any) => ({
		created_at  : sqlDate(r.created_at),
		round_num   : r.round_num,
		name        : byId.get(r.dealer_id)?.name ?? null,
		game_info   : jsonText(r.game_info),
		game_result : jsonText(r.game_result),
		status      : r.status
	}));
	return JSON.stringify(paginate(data, total, page, 10, '/gamehistory'));
}

// ------------------------------------------------------------------ betting

/**
 * POST /bet/store/{table}/{range} (former testStore + USP_STORE_BET 'I'/'F').
 *
 * Body (screens/baccarat/baccarat.js): data[] = {amount, table_id, dividend}
 * (every confirmed area, i.e. the complete bet of the round), round_id,
 * logs, type ('r' | 'f' flippy), slave ('r' | 's' | 'b'), roomId, range
 * (raw "min-max", stored as bet_range), balance_bet, device.
 *
 * One transaction: the round must still be 'S' (the round document is
 * written, so a concurrent setroundprogress either waits for the bet or
 * makes it retry and fail), the bet (user + round + range) is upserted and
 * the difference to the previously stored stake is debited from users.money
 * (transfer vendors, guarded by money >= stake). Posting the same bets again
 * debits nothing. Seamless vendors are debited through the vendor API after
 * the commit; when that fails the bet is put back ('F').
 *
 * Response: {data: <bet_history JSON text>, fail: 0, money} or
 * {data: <previous bet_history>, fail: 1 (refused) | 2 | 3 (balance bet), money}.
 */
export async function testStore (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { user, vendor, db } = a;
	const g = games(db);
	const input = await phpInput(req);
	const table = toInt(params.table);
	const range = String(input.range || params.range || '');
	const type = betType(input.slave, input.type);
	const balance = Number(input.balance_bet) || 0;
	const roomId = input.roomId === undefined || input.roomId === null || input.roomId === '' ? null : (toInt(input.roomId) ?? input.roomId);
	const seamless = vendor.integration_type === 'seamless';
	const cur = currencyOf(user, vendor);

	const failed = async (fail: number, prev: any[] = []) => ({
		data  : prev && prev.length ? prev : [],
		fail,
		money : await getUserCredits(db, user, vendor)
	});

	const round = table === null ? null : await latestRound(db, table);
	if (!round) return failed(1);
	const existing: any = await g.bets.findOne({ round_id : round._id, user_id : user._id, bet_range : range }, { bet_history : 1 }).lean();
	const data = Array.isArray(input.data) ? input.data : [];
	if (!type || validateBets(data, type)) return failed(1, existing?.bet_history);

	const uMoney = await getUserCredits(db, user, vendor);
	const betId = transactionId(user, round._id);
	const ip = clientIp(req);

	let outcome: { current : any; prevBets : any[]; prevTotal : number; rows : any[]; total : number; delta : number; id : number };
	try {
		outcome = await db.withTransaction(async session => {
			const open = await g.rounds.updateOne({ _id : round._id, status : 'S' }, { $set : { last_bet_at : new Date() } }, { session, timestamps : false });
			if (!open.matchedCount) throw new BetFail(1, existing?.bet_history);

			const current: any = await g.bets.findOne({ round_id : round._id, user_id : user._id, bet_range : range }).session(session).lean();
			const prevBets: any[] = current && Array.isArray(current.bet_history) ? current.bet_history : [];
			// one side game per round and range
			if (current && current.type !== type) throw new BetFail(1, prevBets);

			const { rows, total } = buildBetHistory(data, prevBets, uMoney);
			const prevTotal = current ? Number(current.total_bet) || 0 : 0;
			const delta = total - prevTotal;

			if (balance > 0 && roomId !== null) {
				const others: any[] = await g.bets.find({ round_id : round._id, room_id : roomId, _id : { $ne : current ? current._id : -1 } }, { bet_history : 1 }).session(session).lean();
				if (!balanceOk([...others, { bet_history : rows }], balance)) throw new BetFail(3, prevBets);
			}

			if (seamless) {
				if (delta > uMoney) throw new BetFail(1, prevBets);
			} else if (delta > 0) {
				const paid = await db.shared.users.updateOne({ _id : user._id, money : { $gte : delta } }, { $inc : { money : -delta } }, { session });
				if (!paid.matchedCount) throw new BetFail(1, prevBets);
			} else if (delta < 0) {
				await db.shared.users.updateOne({ _id : user._id }, { $inc : { money : -delta } }, { session });
			}

			let id: number;
			if (current) {
				id = current._id;
				await g.bets.updateOne({ _id : id }, { $set : { bet_history : rows, total_bet : total, total_rolling : total, device : input.device ?? current.device ?? null } }, { session });
			} else {
				id = await g.nextId('bets', session);
				await g.bets.create([{
					_id           : id,
					round_id      : round._id,
					user_id       : user._id,
					type,
					bet_history   : rows,
					total_bet     : total,
					total_rolling : total,
					total_winning : 0,
					total_win     : 0,
					total_lost    : 0,
					bet_range     : range,
					room_id       : roomId,
					play_type     : Number(user.is_junket) > 0 ? 'j' : 'p',
					device        : input.device ?? null,
					bet_id        : betId,
					session_id    : user.token ?? null,
					currency      : cur.currency,
					multiplier    : cur.multiplier,
					// convenience copies for history queries
					table_id      : table,
					round_num     : round.round_num
				}], { session });
			}

			await writeBetLog(db, { userId : user._id, table, round, range, mode : 'I', logs : input.logs, bets : rows, total }, session);
			await writeActionLog(db, { userId : user._id, table, roundNum : round.round_num, type : input.type, logs : input.logs, ip }, session);

			return { current, prevBets, prevTotal, rows, total, delta, id };
		});
	} catch (e) {
		if (e instanceof BetFail) return failed(e.fail, e.prevBets);
		throw e;
	}

	if (seamless && outcome.delta !== 0) {
		const ok = await transact(API_GAME, 'bet', vendor, user._id, {
			type        : 'bet',
			game        : GAME,
			table       : String(table),
			range,
			round_no    : String(round.round_num),
			amount      : String(outcome.delta),
			data        : JSON.stringify(outcome.rows),
			user_id     : user.user_id,
			user_name   : user.user_name,
			currency    : cur.currency,
			multiplier  : cur.multiplier,
			session_id  : user.token ?? null,
			bet_id      : betId,
			vendor_name : vendor.vendor_name,
			created_at  : sqlDate(new Date())
		});

		if (!ok) {
			// USP_STORE_BET 'F': back to the previous bet
			await db.withTransaction(async session => {
				if (outcome.current) {
					await g.bets.updateOne({ _id : outcome.id, total_bet : outcome.total },
						{ $set : { bet_history : outcome.prevBets, total_bet : outcome.prevTotal, total_rolling : outcome.prevTotal } }, { session });
				} else {
					await g.bets.deleteOne({ _id : outcome.id, total_bet : outcome.total }, { session });
				}
				await writeBetLog(db, { userId : user._id, table, round, range, mode : 'F', logs : input.logs, bets : outcome.prevBets, total : outcome.prevTotal }, session);
				await writeActionLog(db, { userId : user._id, table, roundNum : round.round_num, type : input.type, logs : { comment : 'fail' }, ip }, session);
			});
			return failed(1, outcome.prevBets);
		}
	}

	return { data : JSON.stringify(outcome.rows), fail : 0, money : await getUserCredits(db, user, vendor) };
}

/**
 * POST /bet/cancel/{table}/{range} and /bet/cancelMulti/{table}/{range}
 * (former testCancel + USP_BALANCE_CANCEL_CHECK + USP_STORE_BET 'D').
 *
 * Removes the user's bet of the current round for the posted range while
 * the round is still 'S' and refunds its stake (transfer: users.money in
 * the same transaction; seamless: vendor API "cancel", the bet is restored
 * when the vendor refuses). Junket balance bets may only be cancelled when
 * the room stays balanced. Response {money, status: 1 | 0[, balance: true]};
 * status 1 also when there was nothing to cancel.
 */
export async function testCancel (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { user, vendor, db } = a;
	const g = games(db);
	const input = await phpInput(req);
	const table = toInt(params.table);
	const range = String(input.range || params.range || '');
	const balance = Number(input.balance_bet) || 0;
	const seamless = vendor.integration_type === 'seamless';
	const cur = currencyOf(user, vendor);
	const ip = clientIp(req);

	const response = async (status: number, extra: object = {}) => ({ money : await getUserCredits(db, user, vendor), status, ...extra });

	const round = table === null ? null : await latestRound(db, table);
	if (!round) return response(1);
	const bet: any = await g.bets.findOne({ round_id : round._id, user_id : user._id, bet_range : range }).lean();
	if (!bet) return response(1);

	const balanced = async (session: ClientSession | null) => {
		if (!(balance > 0) || bet.room_id === null || bet.room_id === undefined) return true;
		const others: any[] = await g.bets.find({ round_id : round._id, room_id : bet.room_id, _id : { $ne : bet._id } }, { bet_history : 1 }).session(session).lean();
		return balanceOk(others, balance);
	};
	if (!(await balanced(null))) return response(0, { balance : true });

	let result: number;
	try {
		result = await db.withTransaction(async session => {
			const open = await g.rounds.updateOne({ _id : round._id, status : 'S' }, { $set : { last_bet_at : new Date() } }, { session, timestamps : false });
			if (!open.matchedCount) throw new BetFail(0);
			if (!(await balanced(session))) throw new BetFail(-1);

			const removed = await g.bets.deleteOne({ _id : bet._id, total_bet : bet.total_bet }, { session });
			// cancelled meanwhile (or changed by a newer store): nothing to refund here
			if (!removed.deletedCount) return 1;

			if (!seamless && Number(bet.total_bet) > 0) {
				await db.shared.users.updateOne({ _id : user._id }, { $inc : { money : Number(bet.total_bet) } }, { session });
			}
			await writeBetLog(db, { userId : user._id, table, round, range, mode : 'D', logs : input.logs, bets : bet.bet_history, total : bet.total_bet }, session);
			await writeActionLog(db, { userId : user._id, table, roundNum : round.round_num, type : input.type ?? bet.type, logs : input.logs, ip }, session);
			return 2;
		});
	} catch (e) {
		if (e instanceof BetFail) return e.fail === -1 ? response(0, { balance : true }) : response(0);
		throw e;
	}

	if (result === 2 && seamless) {
		const ok = await transact(API_GAME, 'cancel', vendor, user._id, {
			type        : 'cancel',
			game        : GAME,
			amount      : Math.trunc(Number(bet.total_bet) || 0),
			id          : user._id,
			user_id     : user.user_id,
			user_name   : user.user_name,
			range,
			table,
			round_no    : round.round_num,
			currency    : cur.currency,
			multiplier  : cur.multiplier,
			session_id  : user.token ?? null,
			bet_id      : transactionId(user, round._id),
			vendor_id   : vendor._id,
			vendor_name : vendor.vendor_name
		});
		if (!ok) {
			// the vendor kept the stake: the bet stays
			await g.bets.collection.insertOne(bet).catch(() => undefined);
			await writeActionLog(db, { userId : user._id, table, roundNum : round.round_num, type : input.type ?? bet.type, logs : { comment : 'cancel api fail' }, ip });
			return response(0);
		}
	}

	return response(1);
}

/** POST /actionlogs/store/{table}/{range} */
export async function actionLogs (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const input = await phpInput(req);
	const table = toInt(params.table);
	const round = table === null ? null : await latestRound(a.db, table);
	if (!round) return '';
	await writeActionLog(a.db, { userId : a.user._id, table, roundNum : round.round_num, type : input.type, logs : input.logs, ip : clientIp(req) });
	return '';
}

/** POST /bet/delete (a stub in the PHP app) */
export async function betDelete () {
	return 1;
}

// ------------------------------------------------------------------ balances / results

const pluck = async (db: Db, roundId: number | null, userId: number, field: string) => {
	if (roundId === null) return [];
	const rows: any[] = await games(db).bets.find({ round_id : roundId, user_id : userId }, { [field] : 1 }).sort({ _id : 1 }).lean();
	return rows.map(r => r[field] ?? null);
};

/** POST /get/totalBet {round_id} */
export async function getTotalBet (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { round_id } = await phpInput(req);
	return pluck(a.db, toInt(round_id), a.user._id, 'total_bet');
}

/** POST /get/totalWin {round_id} */
export async function getTotalWin (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { round_id } = await phpInput(req);
	return pluck(a.db, toInt(round_id), a.user._id, 'total_winning');
}

/** POST /get/winAll/{table}: the user's result of the latest round, 0 without bet */
export async function getAllWin (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const table = toInt(params.table);
	const round = table === null ? null : await latestRound(a.db, table);
	const rows: any[] = round ? await games(a.db).bets.find({ round_id : round._id, user_id : a.user._id }, { total_win : 1, total_bet : 1, type : 1 }).sort({ _id : 1 }).lean() : [];
	if (!rows.length) return 0;
	return {
		total_win  : rows[0].total_win ?? null,
		bet        : rows[0].total_bet ?? null,
		user_money : await getUserCredits(a.db, a.user, a.vendor),
		slave      : SLAVE_NAMES[rows[0].type] ?? null
	};
}

/** POST /get/user: the user row (without secrets) with the current balance, as JSON text */
export async function getUser (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const row: any = await a.db.shared.users.findById(a.user._id, { password : 0, remember_token : 0, token : 0 }).lean();
	const { _id, ...rest } = row || {};
	return JSON.stringify({ id : _id, ...rest, money : await getUserCredits(a.db, a.user, a.vendor) });
}

/** POST /getDealerImg {dealerId}: [{dealer_image (data uri / url), id}] */
export async function getDealerImg (req: Request) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const id = toInt((await phpInput(req)).dealerId);
	if (id === null) return [];
	const d: any = await a.db.shared.dealers.findById(id, { dealer_image : 1, dealer_images : 1 }).lean();
	if (!d) return [];
	let image = d.dealer_image ?? null;
	// former blob column dealer_images -> CONCAT("data:image/png;base64,", TO_BASE64(dealer_images))
	if (d.dealer_images) {
		const raw = d.dealer_images;
		const b64 = typeof raw === 'string' ? raw : Buffer.from(raw.buffer ?? raw).toString('base64');
		image = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
	}
	return [{ dealer_image : image, id : d._id }];
}

