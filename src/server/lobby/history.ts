/*
 |--------------------------------------------------------------------------
 | lobby bet history
 |--------------------------------------------------------------------------
 | MongoDB replacements for the bet history queries of BetHistoryController
 | and the stored procedures it called (their sources are lost; see the
 | reconstruction notes on each function).
 |
 | Data written by the game-server / game apps, per game database:
 |   bets   { _id, round_id, user_id, type, bet_history, total_bet,
 |            total_winning, total_win, total_lost, total_rolling, bet_range,
 |            currency, created_at, updated_at }
 |   rounds { _id, table_id, dealer_id, round_num, status, game_info, game_result }
 | dealers live in the shared database, so they are looked up separately
 | ($lookup cannot cross databases).
 |
 | total_win is the money paid back including the stakes, total_winning the
 | raw winnings (see game-server betsCalculator / poker services).
 |
 */

import type { Db } from '@/lib/db';
import type { GameApp } from '@/lib/config';
import { jsonText, sqlDate } from './format.ts';

/** the game names the lobby JS sends (gameName / game_type) -> game database */
export const HISTORY_GAMES: Record<string, GameApp> = {
	baccarat    : 'baccarat',
	poker       : 'poker',
	dragontiger : 'dragon-tiger'
};

export type HistoryGame = keyof typeof HISTORY_GAMES;

// rounds that count as finished: resulted (E) or voided (W, former MySQL status)
const DONE = ['E', 'W'];

// the lobby / in-game bet record lists page with 11 rows (Math.ceil(cnt / 11) in every menuBetRecords.js)
export const SP_PAGE_SIZE = 11;
// gameType 'D' (one round) is not paged
const DETAIL_LIMIT = 50;

/**
 * game_type label of a bet, as the lobby JS switches on it
 * (menuBetRecords.displayBetLogs / showBetlogData):
 *   baccarat r/b -> 'Baccarat', f -> 'Flippy', s -> 'Super 6'
 *   poker r -> 'Poker', b -> 'Bonus Plus'; dragon-tiger -> 'Dragon Tiger'
 * Dragon bonus bets are labelled 'Baccarat' so their details open with the
 * baccarat result view (the JS has no 'dragon bonus' branch).
 */
export function gameTypeName (game: string, type: string): string {
	if (game === 'baccarat') return type === 'f' ? 'Flippy' : type === 's' ? 'Super 6' : 'Baccarat';
	if (game === 'poker') return type === 'b' ? 'Bonus Plus' : 'Poker';
	return 'Dragon Tiger';
}

/** lobby gameName (also "dragon-tiger", "Texas Hold'em", ...) -> history game key, or null for dropped / unknown games */
export function historyGame (name: any): HistoryGame | null {
	const key = String(name || '').toLowerCase().replace(/[-\s]/g, '');
	if (key === 'texashold\'em' || key === 'bonusplus') return 'poker';
	if (key === 'flippy' || key === 'super6') return 'baccarat';
	return key in HISTORY_GAMES ? key as HistoryGame : null;
}

export type BetFilter = {
	userIds   : number[];
	types?    : string[];
	tableId?  : number;
	roundNum? : number;
	betId?    : number;
	exact?    : boolean;      // apply tableId / roundNum even when 0 (details endpoints)
	from?     : Date | null;
	to?       : Date | null;
};

type Joined = { bet : any; round : any };

const betMatch = (f: BetFilter) => {
	const m: any = { user_id : f.userIds.length === 1 ? f.userIds[0] : { $in : f.userIds } };
	if (f.types) m.type = { $in : f.types };
	if (f.betId !== undefined) m._id = f.betId;
	if (f.from || f.to) {
		m.created_at = {};
		if (f.from) m.created_at.$gte = f.from;
		if (f.to) m.created_at.$lt = f.to;
	}
	return m;
};

const roundMatch = (f: BetFilter) => {
	const m: any = { 'round.status' : { $in : DONE } };
	if (f.tableId || (f.exact && f.tableId !== undefined)) m['round.table_id'] = f.tableId;
	if (f.roundNum || (f.exact && f.roundNum !== undefined)) m['round.round_num'] = f.roundNum;
	return m;
};

/** bets joined with their (finished) round, sorted and paged; total = all matches */
export async function queryBets (db: Db, game: HistoryGame, f: BetFilter, opts : { sort : Record<string, 1 | -1>; skip : number; limit : number })
	: Promise<{ total : number; rows : Joined[] }> {
	if (!f.userIds.length) return { total : 0, rows : [] };

	const [res]: any[] = await db.games[HISTORY_GAMES[game]].bets.aggregate([
		{ $match : betMatch(f) },
		{ $lookup : { from : 'rounds', localField : 'round_id', foreignField : '_id', as : 'round' } },
		{ $unwind : '$round' },
		{ $match : roundMatch(f) },
		{ $sort : opts.sort },
		{ $facet : {
			total : [{ $count : 'n' }],
			rows  : [{ $skip : opts.skip }, { $limit : opts.limit }]
		} }
	]);

	const rows: Joined[] = (res?.rows || []).map(({ round, ...bet }: any) => ({ bet, round }));
	return { total : res?.total?.[0]?.n || 0, rows };
}

/** dealers.name by id for the rounds of `rows` */
export async function dealerNames (db: Db, rows: Joined[]): Promise<Map<number, string>> {
	const ids = [...new Set(rows.map(r => r.round.dealer_id).filter(id => id !== null && id !== undefined))];
	if (!ids.length) return new Map();
	const dealers: any[] = await db.shared.dealers.find({ _id : { $in : ids } }, { name : 1 }).lean();
	return new Map(dealers.map(d => [d._id, d.name]));
}

const number = (v: any) => Number(v) || 0;

/**
 * One row of the history procedures (USP_GET_GAME_BET_HISTORY & co.) as
 * consumed by legacy-src/lobby/js/3.0/menuBetRecords.js:
 *  - cnt: total number of matching rows (paging: Math.ceil(cnt / 11))
 *  - total_bet / total_win numbers (the JS calls toFixed on them);
 *    total_win is the net win / lose of the bet
 *  - status: round status ('W' renders as void)
 *  - game_info / game_result / bet_history as JSON text, like the MySQL
 *    procedure returned them (showBetlogData only reads bet_history
 *    correctly when it is a string)
 *  - type (raw bet type) only on detail rows (gameType 'D'): the poker
 *    detail view checks `type == 'r'`, while list rows fall back to
 *    game_type for the "<table>/<game>" channel label.
 */
export function historyRow (game: HistoryGame, { bet, round }: Joined, extra: { cnt : number; dealer? : string | null; detail? : boolean; user? : any }) {
	const totalBet = number(bet.total_bet);
	const out: any = {
		id            : bet._id,
		cnt           : extra.cnt,
		round_id      : bet.round_id,
		round_num     : round.round_num,
		table_id      : round.table_id,
		game_type     : gameTypeName(game, bet.type),
		user_id       : bet.user_id,
		dealer_name   : extra.dealer ?? null,
		total_bet     : totalBet,
		total_win     : round.status === 'W' ? 0 : Math.round((number(bet.total_win) - totalBet) * 100) / 100,
		total_winning : number(bet.total_winning),
		total_lost    : number(bet.total_lost),
		bet_range     : bet.bet_range ?? null,
		currency      : bet.currency ?? null,
		status        : round.status,
		game_info     : jsonText(round.game_info),
		game_result   : jsonText(round.game_result),
		bet_history   : jsonText(bet.bet_history),
		created_at    : sqlDate(bet.created_at),
		updated_at    : sqlDate(bet.updated_at || bet.created_at)
	};
	if (extra.detail) out.type = bet.type;
	if (extra.user) {
		// junket agent lists: the vendor's player id, not the internal id
		out.user_id = extra.user.user_id;
		out.user_name = extra.user.user_name;
	}
	return out;
}

export type HistoryQuery = {
	gameType  : string;       // 'L' list (paged) | 'D' detail of one round
	games     : HistoryGame[];
	filter    : BetFilter;
	page      : number;       // 1-based
	users?    : Map<number, any>;
};

const SORT = { updated_at : -1, _id : -1 } as const;

const time = (row: Joined) => new Date(row.bet.updated_at || row.bet.created_at || 0).getTime();

/**
 * Shared implementation of the history procedures: bets of `games` matching
 * the filter, newest first, page `page` of 11 (or every bet of one round for
 * gameType 'D'). Several games are merged by date (former UNION).
 */
export async function betHistory (db: Db, q: HistoryQuery): Promise<any[]> {
	const detail = q.gameType === 'D';
	const size = detail ? DETAIL_LIMIT : SP_PAGE_SIZE;
	const page = detail ? 1 : Math.max(1, q.page);

	// each game's first page*size rows are enough to build the merged page
	const single = q.games.length === 1;
	const results = await Promise.all(q.games.map(async game => {
		const { total, rows } = await queryBets(db, game, q.filter, {
			sort  : SORT,
			skip  : single ? (page - 1) * size : 0,
			limit : single ? size : page * size
		});
		return { game, total, rows };
	}));

	const cnt = results.reduce((sum, r) => sum + r.total, 0);
	let merged = results.flatMap(r => r.rows.map(row => ({ game : r.game, row })));
	if (!single) {
		merged = merged.sort((a, b) => time(b.row) - time(a.row) || b.row.bet._id - a.row.bet._id)
			.slice((page - 1) * size, page * size);
	}

	const dealers = await dealerNames(db, merged.map(m => m.row));
	return merged.map(({ game, row }) => historyRow(game, row, {
		cnt,
		detail,
		dealer : dealers.get(row.round.dealer_id) ?? null,
		user   : q.users ? q.users.get(row.bet.user_id) : undefined
	}));
}

/**
 * Junket agent date range: startDate / endDate are local "Y-m-d" (or
 * "Y-m-d H") days of a client whose getTimezoneOffset() / 60 is `timeZone`;
 * '0000-00-00 00' (the PHP default) means no limit. The end day is inclusive.
 */
export function junketRange (startDate: any, endDate: any, timeZone: number): { from : Date | null; to : Date | null } {
	const parse = (v: any, endOfDay: boolean): Date | null => {
		const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}))?/.exec(String(v || ''));
		if (!m || m[1] === '0000') return null;
		const [y, mo, d, h] = [+m[1], +m[2], +m[3], m[4] === undefined ? null : +m[4]];
		let t = Date.UTC(y, mo - 1, d, h ?? 0);
		if (endOfDay) t += h === null ? 24 * 3600e3 : 3600e3;
		return new Date(t + (timeZone || 0) * 3600e3);
	};
	return { from : parse(startDate, false), to : parse(endDate, true) };
}
