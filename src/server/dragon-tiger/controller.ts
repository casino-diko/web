/*
 |--------------------------------------------------------------------------
 | DragonTigerController
 |--------------------------------------------------------------------------
 | Port of dragon-tiger/app/Http/Controllers/DragonTigerController.php. One
 | export per ported PHP method, (req, params) => value | Response, wired to
 | routes in src/app/dragon-tiger with lib/http handler().
 |
 | testStore / testCancel / cancelMulti / actionLogs are also imported by
 | the baccarat page's multi-table betting (/baccarat/dragontiger/...): they
 | only use params.table / params.range and the request body, never the url.
 |
 | Responses keep the Laravel shapes: arrays / objects as JSON, json_encode()d
 | strings and ->paginate()->toJson() as text, former MySQL JSON columns of
 | history rows as JSON strings (the legacy JS JSON.parse()s them).
 |
 */

import { createHash } from 'node:crypto';
import { requireUser, currentUser, type AuthContext } from '@/lib/auth';
import { config } from '@/lib/config';
import { defineModel, type Db } from '@/lib/db';
import { input, isMobile, clientIp } from '@/lib/http';
import { tableVideo } from '@/lib/video';
import { render, htmlResponse } from '@/lib/template';
import { getUserCredits, getJunketCredits, transact } from '@/lib/vendor';
import * as h from './helpers';
import { storeBet, revertBet, cancelBet, restoreBet, Refused, type StoreParams } from './bets';

type Params = Record<string, string>;

const APP = 'dragon-tiger';
const API_GAME = 'dragon-tiger'; // /api/transact/dragon-tiger/<type>

const game = (db: Db) => db.games[APP];

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

async function auth (req: Request): Promise<AuthContext | Response> {
	return requireUser(req);
}

/** request input with PHP-style nested keys expanded (data[0][amount]) */
const body = async (req: Request) => h.expandBrackets(await input(req));

/** public origin of this deployment (proxy aware) */
export function origin (req: Request): string {
	const url = new URL(req.url);
	const proto = (req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
	const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host).split(',')[0].trim();
	return `${proto}://${host}`;
}

/** former env('*_DOMAIN') values; the legacy JS appends paths without a slash, so they end in "/" */
export function domains (req: Request) {
	const o = origin(req);
	return {
		socket       : config.socketUrl,
		bc_domain    : `${o}/baccarat/`,
		dt_domain    : `${o}/dragon-tiger/`,
		p_domain     : `${o}/poker/`,
		sb_domain    : '', // sicbo / paigow are gone
		pg_domain    : '',
		lobby_domain : `${o}/`,
		game         : h.GAME
	};
}

const redirect = (to: string) => new Response(null, { status : 302, headers : { location : to } });

/** Controller::getCurrencyData + the user overrides every method applied */
function currencyOf (user: any, vendor: any) {
	return {
		currency           : user.currency || vendor.currency || null,
		vendorCurrency     : vendor.currency || null,
		multiplier         : Number(user.denomination || vendor.multiplier || 1),
		vendorMultiplier   : Number(vendor.multiplier || 1),
		mainMultiplier     : vendor.main_multiplier ?? 100 // missing in the seed data: 100 == x1.0
	};
}

async function latestRound (db: Db, table: any) {
	const r: any = await game(db).rounds.findOne({ table_id : Number(table) }, { _id : 1, round_num : 1, status : 1 }).sort({ _id : -1 }).lean();
	return r ? { id : r._id, round_num : r.round_num, status : r.status } : null;
}

/** DragonTigerController::getUserConfig */
const getUserConfig = (user: any) => h.userConfig(user.configs);

// ------------------------------------------------------------------ pages

/** shared part of init / initMobile / initNonMobile */
async function pageContext (req: Request, a: AuthContext, table: string, opts: { gameType? : string; range? : string; multiplayer? : any; mobile : boolean }) {
	const { db, user, vendor } = a;
	const g = game(db);
	const url = new URL(req.url);
	const token = url.searchParams.get('token');
	const env = domains(req);

	const tableRow: any = await g.tables.findOne({ _id : Number(table), status : '1' }).lean();
	if (!tableRow) return { redirect : env.lobby_domain + (opts.mobile ? 'm' : '') + '?game=true' };

	const cur = currencyOf(user, vendor);
	const currency = user.currency || vendor.currency;

	// junket / created rooms (?token=)
	let vendorData: any = {};
	let isRoom = 0;
	let isBanker = 0;
	if (token && !opts.mobile) {
		const v = await getVendor(db, user, token, table, null);
		if (!v) return { redirect : env.lobby_domain + '?game=true' };
		vendorData = v;
		if (!opts.gameType) {
			// former $this->checkRoom() (undefined in the PHP controller): the room exists -> flag 'true', banker when the creator
			isRoom = 1;
			isBanker = v.bankerId === user._id ? 1 : 0;
		}
	}

	const userType = String(user.user_type || 'C').toUpperCase();
	let currentRange: any[] = h.toList(h.jsonValue(
		opts.mobile ? ((userType === 'S' || userType === 'TS') ? tableRow.sport_bet_ranges : tableRow.casino_bet_ranges)
			: (h.isEmpty(vendorData) ? tableRow.casino_bet_ranges : tableRow.sport_bet_ranges), []));

	// agent (user group) ranges
	let agentRange: any = [];
	if (user.user_group_id !== null && user.user_group_id !== undefined) {
		const group: any = await db.shared.userGroups.findOne({ _id : user.user_group_id, vendor_id : user.vendor_id }).lean();
		if (group) {
			agentRange = h.jsonValue(group.ranges, []);
			const override = h.agentRanges(agentRange, tableRow.room_type || 'n');
			if (override) currentRange = h.toList(override);
		}
	}

	const gameInfo = { ...h.defaultGameInfo(), ...(h.jsonValue(user.last_game_info, {}) || {}) };
	let { range, details, multiplayer } = h.selectRange(currentRange, gameInfo, table);

	if (opts.range !== undefined) {
		// initMobile / initNonMobile: range from the url, must be one of the table's
		const [min, max] = opts.range.split('-');
		const match = currentRange.find(r => r.min == min && r.max == max);
		if (!match) return { redirect : env.lobby_domain + 'm' };
		details = match;
		range = opts.range;
		multiplayer = opts.multiplayer;
	}

	// junket vendors: disabled tables / tables reserved for created rooms
	if (Number(user.is_junket) > 0) {
		const junketTable: any = h.jsonValue(vendor.junket_table, {}) || {};
		const back = () => ({ redirect : vendor.lobby_type === 'integrated' ? user.pc_redirect_url : env.lobby_domain });
		const current = `${h.GAME}-${table}`.toLowerCase();
		if (h.toList(junketTable.disable_table).some((t: any) => String(t).toLowerCase() === current)) return back();
		const room = `dragontiger-${table}`;
		if (Number(user.is_junket) === 1 && h.isEmpty(vendorData)
			&& h.toList(junketTable.created_room).some((t: any) => String(t).toLowerCase() === room)) return back();
	}

	const round = await latestRound(db, table);
	const cfgObj = getUserConfig(user);
	const locale = cfgObj ? h.configLocale(cfgObj) : a.locale;
	const userMultiplier = Number(user.multiplier ?? 1);
	const money = await getUserCredits(db, user, vendor);
	const stream = h.jsonValue(tableRow.env_setting, {}) || {};

	return {
		ctx : {
			locale,
			env,
			config            : cfgObj,
			cfg               : h.configView(cfgObj),
			tutorial_enabled  : h.configView(cfgObj).tutorial,
			video             : tableVideo('dragon-tiger', table, stream, req.headers.get('cf-ipcountry') || req.headers.get('x-country-code') || ''),
			currency,
			money             : Number(money) || 0,
			user_name         : user.user_name,
			userId            : user._id,
			user_type         : user.user_type || '',
			userAuthority     : user.authority === 'a' ? 'admin' : 'user',
			round_id          : round ? round.round_num : 0,
			tableNum          : Number(table),
			table             : Number(table),
			range,
			rangeDetails      : h.scriptJson(details),
			allRange          : currentRange,
			multiplayer       : Number(multiplayer) || 0,
			currencyMultiplier: cur.multiplier,
			currencyAbbrev    : currency || '',
			userMultiplier,
			userChips         : h.scriptJson(cfgObj.avarta.chips),
			mainMultiplier    : Number(cur.mainMultiplier) || 0,
			integrationType   : vendor.integration_type || 'transfer',
			reel_yn           : Number(vendor.reel_yn) || 0,
			room_yn           : Number(vendor.room_info_yn) || 0,
			lobby_redirect_url: (opts.mobile ? user.mo_redirect_url : user.pc_redirect_url) || '',
			lobby_type        : vendor.lobby_type || '',
			gameInfo          : h.scriptJson(gameInfo),
			agentRange        : h.scriptJson(agentRange),
			junket            : Number(user.is_junket) || 0,
			vendorTables      : vendor.junket_table ? h.scriptJson(h.jsonValue(vendor.junket_table)).replace(/\\/g, '\\\\') : '',
			vendor_id         : vendor._id,
			vendorData        : h.scriptJson(vendorData),
			vendorObj         : vendorData,
			isClassic         : h.isEmpty(vendorData),
			isRoom,
			isBanker,
			hasToken          : !!token,
			vendorEndDate     : Number(user.is_junket) > 0 ? (vendor.junket_end_date || '') : '',
			vendorSound       : vendor.is_sound ?? '',
			// former geoplugin.net lookup per page view: taken from a CDN/proxy header instead
			countryCheck      : req.headers.get('cf-ipcountry') || req.headers.get('x-country-code') || '',
			nonInstall        : 'true',
			channel           : h.channelContext(details, currentRange, range, cur.multiplier, userMultiplier, cur.mainMultiplier)
		}
	};
}

async function page (req: Request, view: string, table: string, opts: { gameType? : string; range? : string; multiplayer? : any; mobile : boolean }) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	if (!/^\d+$/.test(String(table))) return new Response('Not Found', { status : 404 });

	const r: any = await pageContext(req, a, table, opts);
	if (r.redirect) return redirect(r.redirect);
	return htmlResponse(render(APP, view, r.ctx));
}

/**
 * GET /{table}, /{table}/{game}. Phone browsers get the browser version of the mobile page
 * (index-mobile-non: plays the HLS video itself); index-mobile belongs to the installed app
 * (/m/Dragon-Tiger/...), it talks to the app shell and shows no video.
 */
export async function init (req: Request, params: Params) {
	const mobile = isMobile(req);
	return page(req, mobile ? 'index-mobile-non' : 'index', params.table, { gameType : params.game, mobile });
}

/** GET /m/Dragon-Tiger/{table}/{range}/{multiplayer} */
export async function initMobile (req: Request, params: Params) {
	return page(req, 'index-mobile', params.table, { range : params.range, multiplayer : params.multiplayer, mobile : true });
}

/** GET /non/Dragon-Tiger/{table}/{range}/{multiplayer} */
export async function initNonMobile (req: Request, params: Params) {
	return page(req, 'index-mobile-non', params.table, { range : params.range, multiplayer : params.multiplayer, mobile : true });
}

/** GET /rejected (outside the auth group: falls back to the session-less default config) */
export async function checkReject (req: Request, _params: Params) {
	const a = await currentUser();
	const cfg = h.userConfig(a ? a.user.configs : null);
	return htmlResponse(render(APP, 'rejected', { locale : a ? h.configLocale(cfg) : 'en' }));
}

/** former DragonTigerController::getVendor - the room of ?token= (rooms in the shared db, see game-server roomDisconnect) */
async function getVendor (db: Db, user: any, token: string, table: any, range: string | null) {
	const filter: any = { game : h.GAME_KEY, table_id : Number(table), token };
	if (range !== null) filter.bet_range = range;
	const room: any = await db.shared.rooms.findOne(filter).lean();
	if (!room) return false;

	const banker: any = await db.shared.users.findById(room.user_id, { user_name : 1, vendor_id : 1, multiplier : 1 }).lean();
	const bankerVendor: any = banker ? await db.shared.vendors.findById(banker.vendor_id, { vendor_name : 1 }).lean() : null;

	return {
		bankerId         : room.user_id,
		roomId           : room._id,
		userCnt          : room.players_cnt ?? (room.users || []).length,
		title            : room.title ?? room.name,
		betRange         : room.bet_range,
		roomPass         : room.password,
		bankerUsername   : banker ? banker.user_name : null,
		vendorId         : banker ? banker.vendor_id : null,
		bankerMultiplier : banker ? banker.multiplier : null,
		vendorName       : bankerVendor ? bankerVendor.vendor_name : null,
		token,
		isJunket         : user.is_junket
	};
}

// ------------------------------------------------------------------ settings

/** POST /settings */
export async function setUserConfig (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	const cfg = h.applyUserSettings(getUserConfig(a.user), data);
	await a.db.shared.users.updateOne({ _id : a.user._id }, { $set : { configs : cfg } });
	return '';
}

/** POST /setGameSettings */
export async function setGameSettings (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const info = h.applyGameSettings(a.user.last_game_info, await body(req));
	await a.db.shared.users.updateOne({ _id : a.user._id }, { $set : { last_game_info : info } });
	return '';
}

/** POST /settings/videoSetting - former nihtan_api.USP_VIDEO_SETTING(user, type): one row per user */
export async function setVideoSetting (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { type } = await body(req);
	const s = a.db.shared;
	const res = await s.videoSettings.updateOne({ user_id : a.user._id }, { $set : { type : type ?? null } });
	if (!res.matchedCount) await s.videoSettings.create({ _id : await s.nextId('video_settings'), user_id : a.user._id, type : type ?? null });
	return '';
}

// ------------------------------------------------------------------ user / money

/** POST /get/user - json_encode($user) with money from the wallet */
export async function getUser (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { password, remember_token, ...user } = a.user;
	user.id = user._id;
	user.money = await getUserCredits(a.db, a.user, a.vendor);
	return JSON.stringify(user);
}

/** POST /get/users - junket room members' credits */
export async function getUsers (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	const ids = h.toList(data.users).map(Number).filter(Number.isFinite);
	if (!ids.length) return 'no users';

	const users: any[] = await a.db.shared.users.find({ _id : { $in : ids } }, { user_id : 1, user_name : 1, money : 1 }).lean();
	const format = users.map(u => ({ user_id : u.user_id, user_name : u.user_name, credits : u.money }));

	const api = await getJunketCredits(a.vendor, data.vendor_name, format);
	return api !== 'transfer' ? (typeof api === 'string' ? api : JSON.stringify(api)) : JSON.stringify(format);
}

/** POST /checkTable */
export async function checkTable (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const v: any = await a.db.shared.vendors.findById(a.user.vendor_id, { junket_table : 1 }).lean();
	return [{ junket_table : h.jsonColumn(v ? v.junket_table ?? null : null) }];
}

/** POST /getDealerImg - former CONCAT('data:image/png;base64,', TO_BASE64(dealer_images)) */
export async function getDealerImg (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { dealerId } = await body(req);
	const rows: any[] = await a.db.shared.dealers.find({ _id : Number(dealerId) }, { dealer_image : 1, dealer_images : 1 }).lean();
	return rows.map(d => {
		let img = d.dealer_images ?? d.dealer_image ?? null;
		if (img && Buffer.isBuffer(img.buffer || img)) img = Buffer.from(img.buffer || img).toString('base64');
		if (typeof img === 'string' && !/^(data:|https?:|\/)/.test(img) && /^[A-Za-z0-9+/=\s]{64,}$/.test(img)) img = `data:image/png;base64,${img.replace(/\s/g, '')}`;
		return { dealer_image : img, id : d._id };
	});
}

// ------------------------------------------------------------------ rooms

/** POST /checkPassword */
export async function checkPassword (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { password } = await body(req);
	return createHash('sha256').update(String(password ?? '')).digest('hex');
}

/**
 * POST /updateRoom - former nihtan_api.USP_ROOMS_SAVE(flag, 'dragontiger', roomId, tableId, roomType, userId, status, '', password, '', 0, 0).
 * Only flag 'P' (password change, sent by junketEvents.js) is used by the page; other flags update the status.
 */
export async function setRoomInfo (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	const password = data.password ? createHash('sha256').update(String(data.password)).digest('hex') : '';

	const filter = { _id : Number(data.roomId), game : h.GAME_KEY, user_id : a.user._id };
	const set: any = { status : data.status ?? '1' };
	if (data.flag === 'P') set.password = password;
	if (data.roomType) set.type = data.roomType;
	await a.db.shared.rooms.updateOne(filter, { $set : set });
	return password;
}

/** POST /getJunket/{roomId} - former USP_JUNKET_PAYOUT(roomId): per player totals of the room's bets */
export async function getJunketUsers (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const rows = await game(a.db).bets.aggregate([
		{ $match : { room_id : { $in : [Number(params.roomId), String(params.roomId)] } } },
		{ $group : { _id : '$user_id', total_bet : { $sum : '$total_bet' }, total_win : { $sum : { $subtract : [{ $ifNull : ['$total_win', 0] }, { $ifNull : ['$total_bet', 0] }] } } } },
		{ $sort : { _id : 1 } }
	]);
	return rows.map(r => ({ user_id : r._id, total_bet : r.total_bet, total_win : r.total_win }));
}

// ------------------------------------------------------------------ bets

/** POST /bet/store/{table}/{range} (also /baccarat/dragontiger/bet/store/...) - former USP_STORE_BET 'I' / 'F' */
export async function testStore (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { db, user, vendor } = a;
	const data = await body(req);

	const table = params.table;
	const range = String(h.inputValue(data, 'range', params.range));    // raw range as the page shows it
	const device = data.is_multibet ? 's' : (data.device ?? null);
	const failure = async (prevBets: any[]) => ({
		data  : prevBets.length ? prevBets : [],
		fail  : 1,
		user  : user._id,
		money : await getUserCredits(db, user, vendor)
	});

	const round = await latestRound(db, h.inputValue(data, 'table', table));
	if (!round) return failure([]);

	const uMoney = await getUserCredits(db, user, vendor);
	const cur = currencyOf(user, vendor);
	const p: StoreParams = {
		roundId    : round.id,
		tableId    : Number(table),
		roundNum   : round.round_num,
		range,
		data       : h.toList(data.data),
		uMoney     : Number(uMoney) || 0,
		logs       : data.logs ?? null,
		device,
		playType   : user.is_junket ? 'j' : 'p',
		roomId     : h.inputValue(data, 'roomId', null),
		betId      : md5(`${user._id}${user.user_name}${round.id}`),
		sessionId  : user.token ?? null,
		currency   : cur.currency,           // PHP read the misspelled $user->curreny, so the user's currency never applied
		multiplier : cur.multiplier,
		ip         : clientIp(req)
	};

	const stored = await storeBet({ db, user, vendor }, p);
	if (!stored.flag) return failure(stored.prevBets);

	const betsJson = JSON.stringify(stored.bets);

	// seamless: debit through the vendor API (transfer vendors were debited in the transaction)
	if (vendor.integration_type === 'seamless' && stored.delta !== 0) {
		const ok = await transact(API_GAME, 'bet', vendor, user._id, {
			type        : 'bet',
			game        : h.GAME,
			table,
			range,
			round_no    : round.round_num,
			amount      : stored.delta,
			data        : betsJson,
			user_id     : user.user_id,
			user_name   : user.user_name,
			currency    : p.currency,
			multiplier  : p.multiplier,
			session_id  : p.sessionId,
			bet_id      : p.betId,
			vendor_name : vendor.vendor_name,
			created_at  : h.sqlDate(new Date())
		});
		if (!ok) {
			// testFail()
			await revertBet({ db, user, vendor }, p, { before : stored.before, delta : 0 });
			return {
				data  : stored.prevBets.length ? stored.prevBets : [],
				fail  : 1,
				money : await getUserCredits(db, user, vendor)
			};
		}
	}

	return {
		data  : betsJson,
		fail  : 0,
		money : await getUserCredits(db, user, vendor)
	};
}

async function cancelCore (req: Request, a: AuthContext, table: string, range: string, logs: any, refuseStatus: boolean) {
	const { db, user, vendor } = a;
	const round = await latestRound(db, table);
	const response: any = { money : await getUserCredits(db, user, vendor) };
	if (!round) {
		response.status = 1;
		return response;
	}
	const cur = currencyOf(user, vendor);

	let bet: any;
	try {
		bet = await cancelBet({ db, user, vendor }, { roundId : round.id, tableId : Number(table), roundNum : round.round_num, range, logs, ip : clientIp(req) });
	} catch (e) {
		if (!(e instanceof Refused)) throw e;
		// round no longer in betting: the procedure's flag 0
		response.status = 0;
		return response;
	}

	if (!bet) {
		response.status = 1;
		return response;
	}

	if (vendor.integration_type === 'seamless') {
		const ok = await transact(API_GAME, 'cancel', vendor, user._id, {
			type        : 'cancel',
			game        : h.GAME,
			amount      : Math.trunc(Number(bet.total_bet) || 0),
			user_id     : user.user_id,
			user_name   : user.user_name,
			range,
			table,
			round_no    : round.round_num,
			currency    : cur.currency,
			multiplier  : cur.multiplier,
			session_id  : user.token ?? null,
			bet_id      : md5(`${user._id}${user.user_name}${round.id}`),
			vendor_id   : vendor._id,
			vendor_name : vendor.vendor_name
		});
		if (!ok) {
			await restoreBet({ db, user, vendor }, bet);
			await writeActionLog(req, a, table, null, { comment : 'cancel api fail' });
			// PHP answered with the money only (no status)
			if (refuseStatus) delete response.status;
			return response;
		}
	}

	response.status = 1;
	response.money = await getUserCredits(db, user, vendor);
	return response;
}

/** POST /bet/cancel/{table}/{range}, /bet/cancelMulti/{table}/{range} - former USP_STORE_BET 'D' */
export async function testCancel (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	return cancelCore(req, a, params.table, String(h.inputValue(data, 'range', params.range)), data.logs ?? null, true);
}

/** DragonTigerController::cancelMulti - bet_range from the url range scaled by the vendor multipliers */
export async function cancelMulti (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	const cur = currencyOf(a.user, a.vendor);
	const range = h.scaledRange(params.range, cur.multiplier, cur.mainMultiplier);
	const res = await cancelCore(req, a, params.table, range, data.logs ?? null, false);
	return { status : res.status ?? 0, money : res.money };
}

async function writeActionLog (req: Request, a: AuthContext, table: string, data: Record<string, any> | null, failLog: any = null) {
	const g = game(a.db);
	const d = data || {};
	const logs = failLog && failLog.comment !== undefined ? [failLog] : (Array.isArray(d.logs) ? d.logs : d.logs ? [d.logs] : []);
	const round = await latestRound(a.db, h.inputValue(d, 'table', table));
	const filter = { user_id : a.user._id, table_id : Number(table), round_num : round ? round.round_num : null, type : d.type ?? null };

	const res = await g.actionLogs.updateOne(filter, { $push : { actions : { $each : logs } } });
	if (!res.matchedCount) {
		await g.actionLogs.create({ _id : await g.nextId('action_logs'), ...filter, actions : logs, ip : clientIp(req) });
	}
}

/** POST /actionlogs/store/{table}/{range} - INSERT INTO action_logs ... ON DUPLICATE KEY UPDATE actions = JSON_MERGE(actions, ?) */
export async function actionLogs (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	await writeActionLog(req, a, params.table, await body(req));
	return '';
}

/** POST /get/totalBet */
export async function getTotalBet (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { round_id } = await body(req);
	const rows: any[] = await game(a.db).bets.find({ round_id : Number(round_id), user_id : a.user._id }, { total_bet : 1 }).sort({ _id : 1 }).lean();
	return rows.map(r => r.total_bet ?? null);
}

/** POST /get/totalWin */
export async function getTotalWin (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const { round_id } = await body(req);
	const rows: any[] = await game(a.db).bets.find({ round_id : Number(round_id), user_id : a.user._id }, { total_winning : 1 }).sort({ _id : 1 }).lean();
	return rows.map(r => r.total_winning ?? null);
}

/** POST /get/winAll/{table} */
export async function getAllWin (req: Request, params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const round = await latestRound(a.db, params.table);
	if (!round) return 0;
	const rows: any[] = await game(a.db).bets.find({ round_id : round.id, user_id : a.user._id }, { total_win : 1, total_bet : 1 }).sort({ _id : 1 }).lean();
	if (!rows.length) return 0;
	return { total_win : rows[0].total_win ?? null, bet : rows[0].total_bet ?? null };
}

// ------------------------------------------------------------------ records

const BET_LOG_PAGE = 11; // menuBetRecords.js: totalPage = ceil(cnt / 11)

/** rounds + dealer names for a list of bets (former joins) */
async function withRounds (db: Db, bets: any[]) {
	const g = game(db);
	const rounds: any[] = await g.rounds.find({ _id : { $in : [...new Set(bets.map(b => b.round_id))] } }).lean();
	const byId = new Map(rounds.map(r => [r._id, r]));
	const dealers: any[] = await db.shared.dealers.find({ _id : { $in : [...new Set(rounds.map(r => r.dealer_id))] } }, { name : 1 }).lean();
	const dealerName = new Map(dealers.map(d => [d._id, d.name]));
	return bets.map(b => {
		const r: any = byId.get(b.round_id) || {};
		return { bet : b, round : r, dealer_name : dealerName.get(r.dealer_id) ?? null };
	});
}

const historyRow = ({ bet, round, dealer_name }: any, cnt: number) => ({
	id            : bet._id,
	round_id      : bet.round_id,
	round_num     : round.round_num ?? bet.round_num ?? null,
	table_id      : round.table_id ?? bet.table_id ?? null,
	dealer_name,
	currency      : bet.currency ?? null,
	bet_range     : bet.bet_range ?? null,
	bet_history   : h.jsonColumn(bet.bet_history),
	total_bet     : Number(bet.total_bet) || 0,
	// win / lose of the round (payout minus stake)
	total_win     : (Number(bet.total_win) || 0) - (Number(bet.total_bet) || 0),
	total_winning : bet.total_winning ?? null,
	game_info     : h.jsonColumn(round.game_info),
	game_result   : h.jsonColumn(round.game_result),
	status        : round.status ?? null,
	created_at    : h.sqlDate(bet.created_at),
	updated_at    : h.sqlDate(bet.updated_at),
	cnt
});

/**
 * former USP_NEW_GET_BET_HISTORY(gameType, userId, tableId, roundNum, page) / USP_GET_JUNKET_BET_HISTORY(+ roomId):
 * 'L' a page (11 rows) of the user's resulted bets on the table, newest first, with the total in `cnt`;
 * 'D' the user's bets of one round.
 */
async function betHistory (db: Db, o: { gameType : string; userId : number; tableId : number; roundNum : number; page : number; roomId? : any }) {
	const g = game(db);
	const roundFilter: any = { table_id : o.tableId, status : { $in : ['E', 'W'] } };
	if (o.gameType === 'D') roundFilter.round_num = o.roundNum;

	const roundIds = (await g.rounds.find(roundFilter, { _id : 1 }).lean()).map((r: any) => r._id);
	const betFilter: any = { user_id : o.userId, round_id : { $in : roundIds } };
	if (o.roomId !== undefined && o.roomId !== null && o.roomId !== '') betFilter.room_id = { $in : [Number(o.roomId), String(o.roomId)] };

	const cnt = await g.bets.countDocuments(betFilter);
	let q = g.bets.find(betFilter).sort({ round_id : -1, _id : -1 });
	if (o.gameType !== 'D') q = q.skip((Math.max(1, o.page) - 1) * BET_LOG_PAGE).limit(BET_LOG_PAGE);
	const bets = await q.lean();
	return (await withRounds(db, bets)).map(r => historyRow(r, cnt));
}

/** GET|POST /{table}/{range}/{multiplayer}/betlogs (+ /m/Dragon-Tiger/...) */
export async function getBetLogs (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);

	if (data.mobile && data.mobile !== 'false') {
		// paginate(10)->setPath('/betlogs')->toJson()
		const g = game(a.db);
		const page = h.pageNumber(data.page);
		const roundIds = (await g.rounds.find({ table_id : Number(data.tableId), status : { $in : ['E', 'W'] } }, { _id : 1 }).lean()).map((r: any) => r._id);
		const filter = { user_id : a.user._id, round_id : { $in : roundIds } };
		const total = await g.bets.countDocuments(filter);
		const bets = await g.bets.find(filter).sort({ round_id : -1 }).skip((page - 1) * 10).limit(10).lean();
		const rows = (await withRounds(a.db, bets)).map(({ bet, round }) => ({
			round_id      : bet.round_id,
			user_id       : bet.user_id,
			bet_history   : h.jsonColumn(bet.bet_history),
			total_bet     : bet.total_bet ?? null,
			total_winning : bet.total_winning ?? null,
			created_at    : h.sqlDate(bet.created_at),
			updated_at    : h.sqlDate(bet.updated_at),
			game_result   : h.jsonColumn(round.game_result),
			game_info     : h.jsonColumn(round.game_info),
			total_rolling : bet.total_rolling ?? null,
			total_win     : bet.total_win ?? null,
			table_id      : round.table_id ?? null,
			total_lost    : bet.total_lost ?? null,
			round_num     : round.round_num ?? null,
			status        : round.status ?? null
		}));
		return JSON.stringify(h.paginator(rows, total, page, 10, '/betlogs'));
	}

	return betHistory(a.db, {
		gameType : String(data.gameType || 'L'),
		userId   : a.user._id,
		tableId  : Number(data.tableId),
		roundNum : Number(data.roundNum) || 0,
		page     : h.pageNumber(data.betPage)
	});
}

/** POST /getJunketLogs - a junket banker looks at a player's bets in the room */
export async function getJunketLogs (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	return betHistory(a.db, {
		gameType : String(data.gameType || 'L'),
		userId   : Number(data.userId),
		tableId  : Number(data.tableId),
		roundNum : Number(data.roundNum) || 0,
		page     : h.pageNumber(data.betPage),
		roomId   : Number(data.roomId) || 0
	});
}

/** GET|POST /{table}/{range}/{multiplayer}/transferlogs - api_transfer_log of the shared db */
export async function getTransferLogs (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	const page = h.pageNumber(data.page);
	const logs = defineModel(a.db.shared.connection, 'api_transfer_log', 'api_transfer_log');
	const filter = { user_id : a.user._id };
	const total = await logs.countDocuments(filter);
	const rows: any[] = await logs.find(filter).sort({ _id : -1 }).skip((page - 1) * 10).limit(10).lean();
	const out = rows.map(({ _id, ...r }) => ({
		id : _id,
		...r,
		created_at : h.sqlDate(r.created_at),
		updated_at : h.sqlDate(r.updated_at)
	}));
	return JSON.stringify(h.paginator(out, total, page, 10, '/transferlogs'));
}

/** GET|POST /{table}/{range}/{multiplayer}/gamehistory - the table's rounds before the current one */
export async function getGameHistory (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	const g = game(a.db);
	const table = Number(data.tableId);
	const page = h.pageNumber(data.page);

	const last: any = await g.rounds.findOne({ table_id : table }, { round_num : 1 }).sort({ round_num : -1 }).lean();
	// inner join on dealers: rounds without a known dealer are left out
	const dealers: any[] = await a.db.shared.dealers.find({}, { name : 1 }).lean();
	const dealerName = new Map(dealers.map(d => [d._id, d.name]));
	const filter = { table_id : table, round_num : { $lt : last ? last.round_num : 0 }, dealer_id : { $in : [...dealerName.keys()] } };

	const total = await g.rounds.countDocuments(filter);
	const rounds: any[] = await g.rounds.find(filter).sort({ round_num : -1 }).skip((page - 1) * 10).limit(10).lean();
	const rows = rounds.map(r => ({
		round_num   : r.round_num,
		created_at  : h.sqlDate(r.created_at),
		name        : dealerName.get(r.dealer_id) ?? null,
		game_info   : h.jsonColumn(r.game_info),
		game_result : h.jsonColumn(r.game_result),
		status      : r.status
	}));
	return JSON.stringify(h.paginator(rows, total, page, 10, '/gamehistory'));
}

/** POST /details/getDetails - input `round` is the round id */
export async function getDetails (req: Request, _params: Params) {
	const a = await auth(req);
	if (a instanceof Response) return a;
	const data = await body(req);
	const bets: any[] = await game(a.db).bets.find({ round_id : Number(data.round), user_id : a.user._id }).sort({ _id : 1 }).lean();
	return (await withRounds(a.db, bets)).map(({ bet, round }) => ({
		bet_history : h.jsonColumn(bet.bet_history),
		game_info   : h.jsonColumn(round.game_info ?? null),
		game_result : h.jsonColumn(round.game_result ?? null)
	}));
}
