/*
 |--------------------------------------------------------------------------
 | PokerController
 |--------------------------------------------------------------------------
 | Port of poker/app/Http/Controllers/PokerController.php (Laravel 5.4) on
 | MongoDB. One exported function per ported PHP method, same name, wired
 | to the routes with handler():
 |
 |   export const POST = handler(poker.store);
 |
 | Every method authenticates itself (requireUser) and reads its own request
 | body, so the multi-table betting of the baccarat page can call store /
 | setFoldCheck / cancelMulti / actionLogs from /baccarat/... urls with
 | params { table, range } / { table }.
 |
 | Stored procedures (sources lost) are reconstructed from their call
 | arguments, from how the PHP / legacy JS use their results and from what
 | the game-server settlement (game-server/src/games/poker/services.js
 | processBets) expects of a bet:
 |
 |   USP_STORE_BET('I', ...)   store():  upsert of the user's bet of the
 |       latest round + debit, in one transaction. bet_history keys:
 |       r: ante bonus flop turn river, b: ante bonusplus pocket flop turn river,
 |       each { bet, win, user_money } (+ cancel for the streets); total_bet =
 |       sum of the bets; bet_range = the posted (raw) range; type 'r' / 'b'.
 |       Transfer vendors: users.money debited by the added amount (the
 |       settlement credits total_win, stakes included). Seamless vendors:
 |       the vendor API debits (transact 'bet') after the bet is stored;
 |       a refused debit reverts the bet (= USP_STORE_BET('F', ...)).
 |   USP_STORE_BET('D', ...)   testCancel() / cancelMulti(): deletes the
 |       bet and refunds total_bet, only while betting (status S).
 |   INSERT INTO action_logs ... ON DUPLICATE KEY UPDATE actions =
 |       JSON_MERGE(actions, ?)   one doc per (user_id, table_id, round_num,
 |       type), `actions` array appended to.
 |   USP_NEW_GET_BET_HISTORY(gameType, user, table, roundNum, page)
 |       getBetLogs(): 'L' = page of resulted (E / W) rounds of the table the
 |       user bet on (11 per page, `cnt` = total, as menuBetRecords.js pages
 |       by 11), 'D' = the bet of round_num `roundNum`.
 |   USP_VIDEO_SETTING(user, type)   users.configs.avarta.video = type (the
 |       views read window.config.video from there) + video_settings doc.
 |   USP_GET_BANKER_CHECK      only used by the commented out checkBanker(): not ported.
 |
 */

import type { ClientSession } from 'mongoose';
import { requireUser, currentUser, type AuthContext } from '@/lib/auth';
import { config } from '@/lib/config';
import { defineModel, type Db } from '@/lib/db';
import { clientIp, isMobile } from '@/lib/http';
import { tableVideo } from '@/lib/video';
import { renderPage } from '@/lib/template';
import { getUserCredits, transact, setMoney } from '@/lib/vendor';
import {
	parsePhpQuery, parsePhpEntries, parseJson, jsonText, scriptJson, scriptString, scriptNumber, sqlDate,
	paginator, pageNumber, normalizeConfig, configLocale, applySettings, applyGameSettings, publicUser,
	tableRanges, agentRanges, findRange, rangeKey, channelView, normalizeBetRows, planBet, planFoldCheck,
	slaveOf, transactionId, type BetType
} from './helpers';

type Params = Record<string, string>;

const GAME = 'Poker';          // former env('CUR_GAME')
const API_GAME = 'poker';      // /api/transact/poker/{bet|cancel}
const PENDING_MS = 30000;      // a seamless debit in flight blocks other changes of the bet

// ------------------------------------------------------------------ request

const bodies = new WeakMap<Request, Promise<Record<string, any>>>();

/**
 * $request->input(): query + body with PHP-style nested keys
 * (`data[0][amount]=10`, what jQuery.post sends). Cached per request and
 * read from a clone, so a caller may still read the body itself.
 */
export function readInput (req: Request): Promise<Record<string, any>> {
	if (!bodies.has(req)) bodies.set(req, (async () => {
		const url = new URL(req.url);
		const data: Record<string, any> = parsePhpQuery(url.search.slice(1));
		if (req.method === 'GET' || req.method === 'HEAD' || req.bodyUsed) return data;

		const type = req.headers.get('content-type') || '';
		try {
			const r = req.clone();
			if (type.includes('application/json')) Object.assign(data, await r.json());
			else if (type.includes('multipart/form-data')) Object.assign(data, parsePhpEntries((await r.formData()).entries()));
			else {
				const text = await r.text();
				if (text) {
					try {
						Object.assign(data, JSON.parse(text));
					} catch {
						Object.assign(data, parsePhpQuery(text));
					}
				}
			}
		} catch {
			// empty / malformed body: an empty Laravel request
		}
		return data;
	})());
	return bodies.get(req) as Promise<Record<string, any>>;
}

const toInt = (v: any) => {
	const n = parseInt(v, 10);
	return Number.isInteger(n) ? n : NaN;
};

/** origin as the browser sees it (behind a proxy: X-Forwarded-*) */
export function requestOrigin (req: Request): string {
	const url = new URL(req.url);
	const proto = (req.headers.get('x-forwarded-proto') || '').split(',')[0].trim() || url.protocol.replace(':', '');
	const host = (req.headers.get('x-forwarded-host') || '').split(',')[0].trim() || req.headers.get('host') || url.host;
	return `${proto}://${host}`;
}

const redirect = (to: string) => new Response(null, { status : 302, headers : { location : to } });

class Fail extends Error {
	constructor (public reason: string, public current: any = null) {
		super(reason);
	}
}

// ------------------------------------------------------------------ data access

const poker = (db: Db) => db.games.poker;

/** PokerController::getLatestRound */
const getLatestRound = (db: Db, table: number, session: ClientSession | null = null) =>
	poker(db).rounds.findOne({ table_id : table }).sort({ _id : -1 }).session(session).lean() as Promise<any>;

const transferLogs = (db: Db) => defineModel(db.shared.connection, 'api_transfer_log', 'api_transfer_log', { user_id : Number });

const logArray = (logs: any): any[] => {
	if (logs === undefined || logs === null || logs === '') return [];
	if (Array.isArray(logs)) return logs;
	if (typeof logs === 'object') return [logs];
	const parsed = parseJson(logs, null);
	return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [String(logs)]);
};

/** INSERT INTO action_logs ... ON DUPLICATE KEY UPDATE actions = JSON_MERGE(actions, ?) */
async function writeActionLog (db: Db, row: { user_id : number; table_id : number; round_num : any; type : any; ip : string }, actions: any[], session: ClientSession | null = null) {
	const model = poker(db).actionLogs;
	const filter = { user_id : row.user_id, table_id : row.table_id, round_num : row.round_num ?? null, type : row.type ?? null };
	const res = await model.updateOne(filter, { $push : { actions : { $each : actions } }, $set : { ip : row.ip } }, { session });
	if (!res.matchedCount) {
		await model.create([{ _id : await poker(db).nextId('action_logs', session), ...filter, actions, ip : row.ip }], { session });
	}
}

const currencyOf = (user: any, vendor: any) => user.currency || vendor.currency || null;
const multiplierOf = (user: any, vendor: any) => user.denomination || vendor.multiplier || 1;

// ------------------------------------------------------------------ bets

/**
 * testStore (route /bet/store/{table}/{range}; the PHP store() was its
 * unused predecessor, both export the same implementation).
 *
 * Posted (screens/poker/poker.js, betButtonsExtra2.js, multibet-betting2.js):
 *   data[i][table_id|amount], logs, type 'r'|'b', device 'w'|'m'|'s',
 *   range '<min>-<max>', is_multibet
 * Answers { data : JSON text of bet_history, fail : 0, money } or
 * { data : previous bet_history | [], fail : 1, (user,) money }.
 */
export async function testStore (req: Request, params: Params) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, vendor, db } = auth;
	const input = await readInput(req);
	const pk = poker(db);
	const seamless = vendor.integration_type === 'seamless';

	const table = toInt(params.table);
	const type: BetType = input.type === 'b' ? 'b' : 'r';
	const range = String(input.range ?? params.range ?? '');
	const device = input.is_multibet && input.is_multibet !== 'false' ? 's' : String(input.device || (input.is_mobile ? 'm' : 'w'));
	const logs = logArray(input.logs);
	const ip = clientIp(req);

	const money = async () => getUserCredits(db, user, vendor);
	const uMoney = await money();
	const failed = async (current: any, withUser = true) => {
		const prev = current ? parseJson(current.bet_history, null) : null;
		return Object.assign({ data : prev || [], fail : 1 }, withUser ? { user : user._id } : {}, { money : await money() });
	};

	const rows = normalizeBetRows(input.data, type);
	const round = Number.isNaN(table) ? null : await getLatestRound(db, table);
	if (!rows || !round) return failed(null);

	const roundId = round._id;
	const betId = transactionId(user._id, user.user_name, roundId);
	let result: { history : any; betAmount : number; current : any; changed : boolean; id : number; rev : number };

	try {
		result = await db.withTransaction(async session => {
			const r: any = await pk.rounds.findById(roundId).session(session).lean();
			const current: any = await pk.bets.findOne({ round_id : roundId, user_id : user._id }).session(session).lean();
			if (current && current.pending_at && Date.now() - new Date(current.pending_at).getTime() < PENDING_MS) throw new Fail('busy', current);

			const plan = planBet({ type, rows, current, status : r.status, gameInfo : r.game_info, money : uMoney });
			if (plan.ok === false) throw new Fail((plan as { reason : string }).reason, current);
			if (!plan.betAmount) return { history : plan.history, betAmount : 0, current, changed : false, id : current ? current._id : 0, rev : current ? current.rev || 0 : 0 };

			// transfer wallet: debit now, guarded on the balance; seamless: the vendor has the money
			if (seamless) {
				if (uMoney < plan.betAmount) throw new Fail('balance', current);
			} else if (!(await setMoney(db, 'bet', user, vendor, plan.betAmount, session))) {
				throw new Fail('balance', current);
			}

			const pending = seamless ? { pending_at : new Date() } : {};
			let id: number;
			let rev: number;
			if (current) {
				id = current._id;
				rev = (current.rev || 0) + 1;
				await pk.bets.updateOne({ _id : id }, { $set : { bet_history : plan.history, total_bet : plan.totalBet, total_rolling : plan.totalBet, rev, ...pending } }, { session });
			} else {
				id = await pk.nextId('bets', session);
				rev = 1;
				await pk.bets.create([{
					_id           : id,
					round_id      : roundId,
					user_id       : user._id,
					type,
					bet_history   : plan.history,
					total_bet     : plan.totalBet,
					total_rolling : plan.totalBet,
					total_win     : 0,
					total_lost    : 0,
					total_winning : null,
					bet_range     : range,
					device,
					bet_id        : betId,
					session_id    : user.token ?? null,
					currency      : currencyOf(user, vendor),
					play_type     : user.is_junket ? 'j' : 'p',
					rev,
					...pending
				}], { session });
			}

			await writeActionLog(db, { user_id : user._id, table_id : table, round_num : r.round_num, type : input.type, ip }, logs, session);
			return { history : plan.history, betAmount : plan.betAmount, current, changed : true, id, rev };
		});
	} catch (e) {
		if (e instanceof Fail) {
			if (e.reason === 'type') return { data : [], fail : 1, money : await money() };
			return failed(e.current);
		}
		throw e;
	}

	if (seamless && result.changed) {
		const ok = await transact(API_GAME, 'bet', vendor, user._id, {
			type        : 'bet',
			game        : GAME,
			table,
			range,
			round_no    : round.round_num,
			amount      : result.betAmount,
			data        : JSON.stringify(result.history),
			user_id     : user.user_id,
			user_name   : user.user_name,
			currency    : currencyOf(user, vendor),
			multiplier  : multiplierOf(user, vendor),
			session_id  : user.token ?? null,
			bet_id      : betId,
			vendor_name : vendor.vendor_name,
			created_at  : sqlDate(new Date())
		});

		if (!ok) {
			// USP_STORE_BET('F', ...): back to the previous bet
			const prev = result.current;
			await db.withTransaction(async session => {
				if (prev) {
					await pk.bets.updateOne({ _id : result.id, rev : result.rev }, {
						$set   : { bet_history : prev.bet_history, total_bet : prev.total_bet, total_rolling : prev.total_rolling ?? prev.total_bet, rev : result.rev + 1 },
						$unset : { pending_at : 1 }
					}, { session });
				} else {
					await pk.bets.deleteOne({ _id : result.id, rev : result.rev }, { session });
				}
				await writeActionLog(db, { user_id : user._id, table_id : table, round_num : round.round_num, type : input.type, ip }, [{ comment : 'fail' }], session);
			});
			return { data : prev ? parseJson(prev.bet_history, []) : [], fail : 1, money : await money() };
		}
		await pk.bets.updateOne({ _id : result.id, rev : result.rev }, { $unset : { pending_at : 1 } });
	}

	return { data : JSON.stringify(result.history), fail : 0, money : await money() };
}

/** PokerController::store - superseded by testStore in the PHP routes; same implementation */
export const store = testStore;

/** shared part of testCancel / cancelMulti / cancel */
async function cancelBet (req: Request, params: Params, checkSlave: boolean) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, vendor, db } = auth;
	const input = await readInput(req);
	const pk = poker(db);
	const seamless = vendor.integration_type === 'seamless';
	const table = toInt(params.table);
	const ip = clientIp(req);
	const money = async () => getUserCredits(db, user, vendor);
	const answer = async (status: number) => ({ money : await money(), status });

	const round = Number.isNaN(table) ? null : await getLatestRound(db, table);
	if (!round) return answer(1);
	const bet: any = await pk.bets.findOne({ round_id : round._id, user_id : user._id }).lean();
	if (!bet) return answer(1);

	// cancelMulti: a cancel of the other channel (normal / bonusplus) is a no-op
	if (checkSlave && input.slave && ['normal', 'bonusplus'].includes(input.slave) && input.slave !== slaveOf(bet.type)) return answer(1);

	const range = String(input.range ?? params.range ?? bet.bet_range ?? '');
	const log = (comment: string, session: ClientSession | null = null) =>
		writeActionLog(db, { user_id : user._id, table_id : table, round_num : round.round_num, type : input.type, ip }, comment ? [{ comment }] : logArray(input.logs), session);

	let removed: any;
	try {
		removed = await db.withTransaction(async session => {
			const r: any = await pk.rounds.findById(round._id).session(session).lean();
			const current: any = await pk.bets.findOne({ _id : bet._id }).session(session).lean();
			if (!current) throw new Fail('gone');
			if (r.status !== 'S') throw new Fail('closed');
			if (current.pending_at && Date.now() - new Date(current.pending_at).getTime() < PENDING_MS) throw new Fail('busy');

			await pk.bets.deleteOne({ _id : current._id }, { session });
			if (!seamless) await setMoney(db, 'cancel', user, vendor, Number(current.total_bet) || 0, session);
			await log('', session);
			return current;
		});
	} catch (e) {
		if (!(e instanceof Fail)) throw e;
		if (e.reason === 'gone') return answer(1);
		await log('fail');
		return answer(0);
	}

	if (seamless) {
		const ok = await transact(API_GAME, 'cancel', vendor, user._id, {
			type        : 'cancel',
			game        : GAME,
			amount      : Number(removed.total_bet) || 0,
			id          : user._id,
			user_id     : user.user_id,
			user_name   : user.user_name,
			range,
			table,
			round_no    : round.round_num,
			currency    : currencyOf(user, vendor),
			multiplier  : multiplierOf(user, vendor),
			session_id  : user.token ?? null,
			bet_id      : removed.bet_id || transactionId(user._id, user.user_name, round._id),
			vendor_id   : vendor._id,
			vendor_name : vendor.vendor_name
		});
		if (!ok) {
			// the vendor kept the stake: the bet stands
			await pk.bets.create([removed]).catch(e => console.error('poker cancel: restoring bet failed', removed._id, e));
			await log('cancel api fail');
			return answer(0);
		}
	}
	return answer(1);
}

/**
 * testCancel (routes /bet/cancel/{table}/{range} and /bet/cancelMulti/...):
 * removes the user's bet of the latest round and refunds it.
 * Answers { money, status : 1 | 0 } (1 also when there is no bet).
 */
export const testCancel = (req: Request, params: Params) => cancelBet(req, params, false);

/** PokerController::cancel - superseded by testCancel */
export const cancel = testCancel;

/**
 * cancelMulti (multi-table betting; posts type 'm', slave, range): like
 * testCancel, but a slave (normal / bonusplus) other than the bet's is a no-op.
 */
export const cancelMulti = (req: Request, params: Params) => cancelBet(req, params, true);

/**
 * setFoldCheck (/bet/setFoldCheck/{table}, posts type = flop | turn | river):
 * sets bet_history.<street>.cancel = 1 (fold on the flop, check on turn /
 * river) and answers the bet_history; nothing (empty body) without a bet.
 */
export async function setFoldCheck (req: Request, params: Params) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, db } = auth;
	const input = await readInput(req);
	const pk = poker(db);
	const table = toInt(params.table);
	const street = String(input.type || '');

	const round = Number.isNaN(table) ? null : await getLatestRound(db, table);
	if (!round) return '';
	const bet: any = await pk.bets.findOne({ round_id : round._id, user_id : user._id }).lean();
	if (!bet) return '';

	const next = planFoldCheck(bet.bet_history, street, round.status);
	if (!next) return parseJson(bet.bet_history, {});

	// atomic: only while that street has no bet (a concurrent raise wins)
	const res = await pk.bets.updateOne(
		{ _id : bet._id, [`bet_history.${street}.bet`] : { $in : [0, null] }, [`bet_history.${street}.cancel`] : { $ne : 1 } },
		{ $set : { [`bet_history.${street}`] : next[street] } }
	);
	if (!res.matchedCount) {
		const fresh: any = await pk.bets.findById(bet._id).lean();
		return fresh ? parseJson(fresh.bet_history, {}) : '';
	}
	const fresh: any = await pk.bets.findById(bet._id).lean();
	return parseJson(fresh.bet_history, next);
}

/**
 * actionLogs (/actionlogs/store/{table}/{range}, posts logs + type): appends
 * the posted logs to the user's action log of the latest round. Empty answer.
 */
export async function actionLogs (req: Request, params: Params) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, db } = auth;
	const input = await readInput(req);
	const table = toInt(params.table);
	if (Number.isNaN(table)) return '';
	const round = await getLatestRound(db, toInt(input.table) || table);
	await writeActionLog(db, { user_id : user._id, table_id : table, round_num : round ? round.round_num : null, type : input.type, ip : clientIp(req) }, logArray(input.logs));
	return '';
}

/** getAllWin (/get/winAll/{table}): result of the user's bet of the latest round, or 0 */
export async function getAllWin (req: Request, params: Params) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, vendor, db } = auth;
	const table = toInt(params.table);
	const round = Number.isNaN(table) ? null : await getLatestRound(db, table);
	const bet: any = round ? await poker(db).bets.findOne({ round_id : round._id, user_id : user._id }).lean() : null;
	if (!bet) return 0;
	return { total_win : bet.total_win ?? null, bet : bet.total_bet ?? null, slave : slaveOf(bet.type), user_money : await getUserCredits(db, user, vendor) };
}

// ------------------------------------------------------------------ user

/** getUser (POST /get/user, GET /m/Poker/get/user): the user row as JSON text, money = current balance */
export async function getUser (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, vendor, db } = auth;
	return JSON.stringify(publicUser(user, await getUserCredits(db, user, vendor)));
}

/** getUserConfig: users.configs with defaults (not a route) */
export const getUserConfig = (auth: AuthContext) => normalizeConfig(auth.user.configs, auth.locale);

/** setUserConfig (POST /settings) */
export async function setUserConfig (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const configs = applySettings(auth.user.configs, await readInput(req), auth.locale);
	await auth.db.shared.users.updateOne({ _id : auth.user._id }, { $set : { configs } });
	return '';
}

/** setGameSettings (POST /setGameSettings): users.last_game_info */
export async function setGameSettings (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const info = applyGameSettings(auth.user.last_game_info, await readInput(req));
	await auth.db.shared.users.updateOne({ _id : auth.user._id }, { $set : { last_game_info : info } });
	return '';
}

/** setVideoSetting (POST /settings/videoSetting, type) - USP_VIDEO_SETTING, see header */
export async function setVideoSetting (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, db, locale } = auth;
	const type = (await readInput(req)).type ?? null;
	const configs = normalizeConfig(user.configs, locale);
	configs.avarta.video = type;
	await db.shared.users.updateOne({ _id : user._id }, { $set : { configs } });
	const vs = db.shared.videoSettings;
	const res = await vs.updateOne({ user_id : user._id }, { $set : { type } });
	if (!res.matchedCount) await vs.create({ _id : await db.shared.nextId('video_settings'), user_id : user._id, type });
	return '';
}

/** checkTable (POST /checkTable): [{ junket_table }] of the user's vendor */
export async function checkTable (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	return [{ junket_table : jsonText(auth.vendor.junket_table ?? null) }];
}

/** getDealerImg (POST /getDealerImg, dealerId): [{ dealer_image, id }] */
export async function getDealerImg (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const id = toInt((await readInput(req)).dealerId);
	if (Number.isNaN(id)) return [];
	const dealers: any[] = await auth.db.shared.dealers.find({ _id : id }).lean();
	return dealers.map(d => {
		// former CONCAT("data:image/png;base64,", TO_BASE64(dealer_images)); seeded dealers only have a file name
		const blob = d.dealer_images;
		let image = d.dealer_image ?? null;
		if (blob) image = `data:image/png;base64,${Buffer.isBuffer(blob) ? blob.toString('base64') : (blob.buffer ? Buffer.from(blob.buffer).toString('base64') : String(blob))}`;
		return { dealer_image : image, id : d._id };
	});
}

// ------------------------------------------------------------------ records

/** getTransferLogs (/{table}/{range}/transferlogs): Laravel paginator JSON text (path /transferlogs) */
export async function getTransferLogs (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const input = await readInput(req);
	const page = pageNumber(input.page);
	const model = transferLogs(auth.db);
	const filter = { user_id : auth.user._id };
	const [total, rows] = await Promise.all([
		model.countDocuments(filter),
		model.find(filter).sort({ _id : -1 }).skip((page - 1) * 10).limit(10).lean()
	]);
	const data = rows.map((r: any) => {
		const out: Record<string, any> = { id : r._id };
		for (const [k, v] of Object.entries(r)) if (k !== '_id') out[k] = v instanceof Date ? sqlDate(v) : v;
		return out;
	});
	return JSON.stringify(paginator(data, total, page, 10, '/transferlogs'));
}

const dealerNames = async (db: Db, ids: any[]) => {
	const list: any[] = await db.shared.dealers.find({ _id : { $in : [...new Set(ids.filter(x => x != null))] } }, { name : 1 }).lean();
	return new Map(list.map(d => [d._id, d.name]));
};

const markText = (mark: any) => jsonText(Array.isArray(mark) ? mark[0] ?? null : mark);

/**
 * getBetLogs (/{table}/{range}/betlogs)
 *   mobile=1: paginator JSON text (10 per page, path /betlogs) of the user's
 *     bets of channel bet_type on the table, resulted rounds (E / W) with a mark
 *   else:     USP_NEW_GET_BET_HISTORY(gameType, user, tableId, roundNum, betPage), see header
 */
export async function getBetLogs (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, db } = auth;
	const pk = poker(db);
	const input = await readInput(req);
	const table = toInt(input.tableId);
	const roundsColl = pk.rounds.collection.collectionName;
	const marksColl = pk.gameMarks.collection.collectionName;

	if (input.mobile && input.mobile !== 'false') {
		const page = pageNumber(input.page);
		const type = input.bet_type || 'r';
		const [res]: any[] = await pk.bets.aggregate([
			{ $match : { user_id : user._id, type } },
			{ $lookup : { from : roundsColl, localField : 'round_id', foreignField : '_id', as : 'round' } },
			{ $unwind : '$round' },
			{ $match : { 'round.table_id' : table, 'round.status' : { $in : ['E', 'W'] } } },
			{ $lookup : { from : marksColl, localField : 'round_id', foreignField : 'round_id', as : 'gm' } },
			{ $unwind : '$gm' },
			{ $sort : { round_id : -1, _id : -1 } },
			{ $facet : { total : [{ $count : 'n' }], rows : [{ $skip : (page - 1) * 10 }, { $limit : 10 }] } }
		]);
		const data = res.rows.map((b: any) => ({
			round_id      : b.round_id,
			user_id       : b.user_id,
			bet_history   : jsonText(b.bet_history),
			total_bet     : b.total_bet,
			total_winning : b.total_winning,
			created_at    : sqlDate(b.created_at),
			updated_at    : sqlDate(b.updated_at),
			mark          : markText(b.gm.mark),
			total_rolling : b.total_rolling,
			total_win     : b.total_win,
			table_id      : b.round.table_id,
			total_lost    : b.total_lost,
			round_num     : b.round.round_num,
			status        : b.round.status
		}));
		return JSON.stringify(paginator(data, res.total[0]?.n || 0, page, 10, '/betlogs'));
	}

	// USP_NEW_GET_BET_HISTORY
	const detail = String(input.gameType || 'L').toUpperCase() === 'D';
	const perPage = 11;
	const page = pageNumber(input.betPage);
	const roundMatch: Record<string, any> = { 'round.status' : { $in : ['E', 'W'] } };
	if (!Number.isNaN(table)) roundMatch['round.table_id'] = table;
	if (detail) roundMatch['round.round_num'] = toInt(input.roundNum);

	const [res]: any[] = await pk.bets.aggregate([
		{ $match : { user_id : user._id } },
		{ $lookup : { from : roundsColl, localField : 'round_id', foreignField : '_id', as : 'round' } },
		{ $unwind : '$round' },
		{ $match : roundMatch },
		{ $sort : { round_id : -1, _id : -1 } },
		{ $facet : { total : [{ $count : 'n' }], rows : detail ? [{ $limit : 1 }] : [{ $skip : (page - 1) * perPage }, { $limit : perPage }] } }
	]);
	const names = await dealerNames(db, res.rows.map((b: any) => b.round.dealer_id));
	const cnt = res.total[0]?.n || 0;
	return res.rows.map((b: any) => ({
		cnt,
		id            : b._id,
		round_id      : b.round_id,
		round_num     : b.round.round_num,
		table_id      : b.round.table_id,
		type          : b.type,
		status        : b.round.status,
		dealer_name   : names.get(b.round.dealer_id) ?? null,
		bet_history   : jsonText(b.bet_history),
		game_info     : jsonText(b.round.game_info),
		game_result   : jsonText(b.round.game_result),
		total_bet     : Number(b.total_bet) || 0,
		total_win     : Number(b.total_win) || 0,
		total_winning : Number(b.total_winning) || 0,
		total_lost    : Number(b.total_lost) || 0,
		bet_range     : b.bet_range ?? null,
		created_at    : sqlDate(b.created_at),
		updated_at    : sqlDate(b.updated_at)
	}));
}

/** getDetails (POST /details/getDetails, round = rounds id, type): [{ bet_history, game_info, game_result }] (JSON texts) */
export async function getDetails (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { user, db } = auth;
	const input = await readInput(req);
	const pk = poker(db);
	const bets: any[] = await pk.bets.find({ round_id : toInt(input.round), type : input.type || 'r', user_id : user._id }).lean();
	const rounds = new Map(((await pk.rounds.find({ _id : { $in : bets.map(b => b.round_id) } }).lean()) as any[]).map(r => [r._id, r]));
	return bets.map(b => {
		const r: any = rounds.get(b.round_id) || {};
		return { bet_history : jsonText(b.bet_history), game_info : jsonText(r.game_info ?? null), game_result : jsonText(r.game_result ?? null) };
	});
}

/** getGameHistory (/{table}/{range}/gamehistory): paginator JSON text (path /gamehistory) of the table's past rounds */
export async function getGameHistory (req: Request, _params: Params = {}) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const { db } = auth;
	const pk = poker(db);
	const input = await readInput(req);
	const table = toInt(input.tableId);
	const page = pageNumber(input.page);

	const last: any = await pk.rounds.findOne({ table_id : table }, { round_num : 1 }).sort({ round_num : -1 }).lean();
	// inner joins of the PHP: game_tables, dealers, game_marks (round_id + table_id)
	const tableExists = await pk.tables.exists({ _id : table });
	if (!last || !tableExists) return JSON.stringify(paginator([], 0, page, 10, '/gamehistory'));
	const dealerIds = ((await db.shared.dealers.find({}, { _id : 1 }).lean()) as any[]).map(d => d._id);

	const [res]: any[] = await pk.rounds.aggregate([
		{ $match : { table_id : table, round_num : { $lt : last.round_num }, dealer_id : { $in : dealerIds } } },
		{ $lookup : { from : pk.gameMarks.collection.collectionName, let : { rid : '$_id', tid : '$table_id' }, as : 'gm',
			pipeline : [{ $match : { $expr : { $and : [{ $eq : ['$round_id', '$$rid'] }, { $eq : ['$table_id', '$$tid'] }] } } }] } },
		{ $unwind : '$gm' },
		{ $sort : { round_num : -1, _id : -1 } },
		{ $facet : { total : [{ $count : 'n' }], rows : [{ $skip : (page - 1) * 10 }, { $limit : 10 }] } }
	]);
	const names = await dealerNames(db, res.rows.map((r: any) => r.dealer_id));
	const data = res.rows.map((r: any) => ({
		round_num  : r.round_num,
		created_at : sqlDate(r.created_at),
		name       : names.get(r.dealer_id) ?? null,
		game_info  : jsonText(r.game_info),
		mark       : markText(r.gm.mark),
		status     : r.status
	}));
	return JSON.stringify(paginator(data, res.total[0]?.n || 0, page, 10, '/gamehistory'));
}

// ------------------------------------------------------------------ pages

/** a document as the former MySQL row: `id`, DATETIME texts, JSON columns as text */
function sqlRow (doc: any, jsonFields: string[] = []) {
	const out: Record<string, any> = { id : doc._id };
	for (const [k, v] of Object.entries(doc)) {
		if (k === '_id' || k === 'rev' || k === 'pending_at') continue;
		out[k] = jsonFields.includes(k) ? jsonText(v) : (v instanceof Date ? sqlDate(v) : v);
	}
	return out;
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

const tableTypes = (betSetting: any): string[] => {
	const t = parseJson(betSetting, {})?.type;
	return Array.isArray(t) ? t : (t ? [t] : ['normal']);
};

/** template variables shared by the three game pages */
async function pageContext (req: Request, auth: AuthContext, table: number, opts: { mobile : boolean; range? : string; slave? : string | null }) {
	const { user, vendor, db } = auth;
	const pk = poker(db);
	const origin = requestOrigin(req);
	const lobby = `${origin}/`;

	const tableDoc: any = await pk.tables.findOne({ _id : table, status : '1' }).lean();
	if (!tableDoc) return { redirect : lobby };

	let currentRange = tableRanges(tableDoc, user.user_type);

	// agent range (user group of the vendor)
	let agentRange: any = [];
	if (user.user_group_id !== undefined && user.user_group_id !== null) {
		const group: any = await db.shared.userGroups.findOne({ _id : user.user_group_id, vendor_id : user.vendor_id }).lean();
		if (group) {
			agentRange = parseJson(group.ranges, []);
			const override = agentRanges(group.ranges, tableDoc.room_type || 'n');
			if (override) currentRange = override;
		}
	}
	if (!currentRange.length) return { redirect : lobby };

	const types = tableTypes(tableDoc.bet_setting);
	const userConfig = normalizeConfig(user.configs, auth.locale);
	const locale = configLocale(userConfig);
	const gameInfo = parseJson(user.last_game_info, null);

	// channel + range: posted / url values (mobile), else users.last_game_info of this table, else the first range
	let range: string;
	let slave: string | null = null;
	let type = 'normal';
	if (opts.mobile && opts.range !== undefined) {
		type = opts.slave || 'normal';
		const details = findRange(currentRange, opts.range);
		if (!details || !types.includes(type) || !['normal', 'bonusplus'].includes(type)) return { redirect : lobby };
		range = opts.range;
		slave = type;
	} else {
		range = rangeKey(currentRange[0]);
		if (gameInfo && gameInfo.game === `${GAME}/${table}`) {
			if (findRange(currentRange, gameInfo.bet_range)) range = gameInfo.bet_range;
			slave = gameInfo.slave ?? null;
			type = slave === 'bonusplus' || slave === 'bonus' ? 'bonusplus' : 'normal';
		}
	}
	// a bonusplus channel only on tables that have one
	if (type === 'bonusplus' && !types.includes('bonusplus')) type = 'normal';

	const latest: any = await pk.rounds.findOne({ table_id : table }).sort({ _id : -1 }).lean();
	const lastBet: any = await pk.bets.findOne({ user_id : user._id }).sort({ _id : -1 }).lean();
	const lastBetRound: any = lastBet ? await pk.rounds.findById(lastBet.round_id).lean() : null;

	// a bet already placed in the current round decides the channel (the PHP could disagree and then refuse every bet)
	if (lastBet && latest && lastBet.round_id === latest._id) type = slaveOf(lastBet.type);
	if (type === 'bonusplus') slave = 'bonusplus';
	else if (slave === 'bonusplus' || slave === 'bonus') slave = '';
	const betType = type === 'bonusplus' ? 'b' : 'r';

	const rangeDetails = findRange(currentRange, range) || currentRange[0];
	range = rangeKey(rangeDetails);

	// former `bets JOIN rounds` row: round columns override bet columns (also `id`), JSON columns as text
	const bets = lastBet && lastBetRound ? { ...sqlRow(lastBet, ['bet_history']), ...sqlRow(lastBetRound, ['game_info', 'game_result']) } : null;

	const currencyMultiplier = scriptNumber(user.denomination || vendor.multiplier, 1);
	const userMultiplier = scriptNumber(user.multiplier, 1);
	const mainMultiplier = scriptNumber(vendor.main_multiplier, 100); // seeded vendors have none: 100 = x1
	const currency = user.currency || vendor.currency || '';
	const chips = Array.isArray(userConfig.avarta.chips) && userConfig.avarta.chips.length ? userConfig.avarta.chips : ['1', '5', '10', '30', 'max'];
	const a = userConfig.avarta;
	const env = parseJson(tableDoc.env_setting, {}) || {};
	const credits = await getUserCredits(db, user, vendor);

	return {
		ctx : {
			locale,
			env : {
				APP_SOCKET   : withSlash(config.socketUrl),
				P_DOMAIN     : `${origin}/poker/`,
				BC_DOMAIN    : `${origin}/baccarat/`,
				DT_DOMAIN    : `${origin}/dragon-tiger/`,
				SB_DOMAIN    : lobby, // sicbo / paigow are gone
				PG_DOMAIN    : lobby,
				LOBBY_DOMAIN : lobby,
				CUR_GAME     : GAME
			},
			config             : userConfig,
			cfg : {
				default  : a.default.data[a.default.select],
				language : a.language.data[a.language.select],
				screen   : a.screen.data[a.screen.select]
			},
			tutorial_enabled   : a.tutorial && a.tutorial.enabled !== undefined ? String(a.tutorial.enabled) : 'true',
			user               : { id : user._id, user_type : user.user_type ?? '' },
			userAuthority      : user.authority === 'a' ? 'admin' : 'user',
			video              : tableVideo('poker', table, env, req.headers.get('cf-ipcountry') || req.headers.get('x-country-code') || ''),
			betConfig          : tableDoc.bet_setting,
			type,
			slave              : slave ?? '',
			money              : scriptNumber(credits, 0),
			currency,
			user_name          : user.user_name ?? '',
			round_id           : scriptNumber(latest ? latest.round_num : 0, 0),
			bets               : scriptJson(bets),
			bet_type           : betType,
			tableNum           : table,
			table,
			range,
			rangeDetails       : scriptJson(rangeDetails),
			currencyMultiplier,
			currencyAbbrev     : scriptString(currency),
			userMultiplier,
			userChips          : scriptJson(chips),
			mainMultiplier,
			integrationType    : scriptString(vendor.integration_type),
			reel_yn            : scriptNumber(vendor.reel_yn, 0),
			lobby_redirect_url : scriptString(opts.mobile ? user.mo_redirect_url : user.pc_redirect_url),
			lobby_type         : scriptString(vendor.lobby_type),
			allRange           : currentRange,
			gameInfo           : scriptJson(gameInfo),
			agentRange         : scriptJson(agentRange),
			junket             : scriptNumber(user.is_junket, 0),
			vendorTables       : scriptString(jsonText(vendor.junket_table ?? null) ?? ''),
			vendor_id          : scriptNumber(vendor._id, 0),
			vendorEndDate      : scriptString(Number(user.is_junket) > 0 ? sqlDate(vendor.junket_end_date) ?? '' : ''),
			isClassic          : true, // $vendorData was never set in the PHP
			vendorSound        : scriptString(vendor.is_sound ?? ''),
			countryCheck       : req.headers.get('cf-ipcountry') || req.headers.get('x-country-code') || '',
			nonInstall         : true,
			isPlayer           : 'T',
			channel            : channelView(rangeDetails, currentRange, range, currencyMultiplier, userMultiplier, mainMultiplier)
		}
	};
}

/** junket users: disabled tables / tables with a junket room go back to the lobby */
function junketRedirect (req: Request, user: any, vendor: any, table: number): string | null {
	if (!(Number(user.is_junket) > 0)) return null;
	const junket = parseJson(vendor.junket_table, {}) || {};
	const current = `${GAME}-${table}`.toLowerCase();
	const back = vendor.lobby_type === 'integrated' && user.pc_redirect_url ? user.pc_redirect_url : `${requestOrigin(req)}/`;
	if ((junket.disable_table || []).some((t: string) => String(t).toLowerCase() === current)) return back;
	if (Number(user.is_junket) === 1 && (junket.created_room || []).some((t: string) => String(t).toLowerCase() === current)) return back;
	return null;
}

/**
 * index (GET /{table}): desktop game page. Phone browsers get the browser
 * version of the mobile page (index-mobile-non: plays the HLS video itself);
 * index-mobile belongs to the installed app (/m/Poker/...), it talks to the
 * app shell and shows no video.
 * Not ported: the geoplugin.net country lookup (CF-IPCountry / X-Country-Code
 * headers are used instead).
 */
export async function index (req: Request, params: Params) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const table = toInt(params.table);
	if (Number.isNaN(table)) return new Response('Not Found', { status : 404 });

	const mobile = isMobile(req);
	const page = await pageContext(req, auth, table, mobile ? { mobile, slave : 'normal' } : { mobile });
	if ('redirect' in page) return redirect(page.redirect as string);
	const back = junketRedirect(req, auth.user, auth.vendor, table);
	if (back) return redirect(back);

	return renderPage('poker', mobile ? 'index-mobile-non' : 'index', page.ctx);
}

/** indexMobile (GET /m/Poker/{table}/{range}[/{type}], ?slave=normal|bonusplus) */
export async function indexMobile (req: Request, params: Params) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const table = toInt(params.table);
	if (Number.isNaN(table)) return new Response('Not Found', { status : 404 });
	const input = await readInput(req);
	const page = await pageContext(req, auth, table, { mobile : true, range : params.range, slave : input.slave ?? 'normal' });
	if ('redirect' in page) return redirect(page.redirect as string);
	return renderPage('poker', 'index-mobile', page.ctx);
}

/** indexNonMobile (GET /non/Poker/{table}/{range}[/{type}]) */
export async function indexNonMobile (req: Request, params: Params) {
	const auth = await requireUser(req);
	if (auth instanceof Response) return auth;
	const table = toInt(params.table);
	if (Number.isNaN(table)) return new Response('Not Found', { status : 404 });
	const input = await readInput(req);
	const page = await pageContext(req, auth, table, { mobile : true, range : params.range, slave : input.slave ?? 'normal' });
	if ('redirect' in page) return redirect(page.redirect as string);
	return renderPage('poker', 'index-mobile-non', page.ctx);
}

/** checkReject (GET /rejected) */
export async function checkReject (_req: Request, _params: Params = {}) {
	const auth = await currentUser();
	const locale = auth ? configLocale(normalizeConfig(auth.user.configs, auth.locale)) : 'en';
	return renderPage('poker', 'rejected', { locale });
}
