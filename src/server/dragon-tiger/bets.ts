/*
 |--------------------------------------------------------------------------
 | dragon-tiger bets (former stored procedure dragontiger.USP_STORE_BET)
 |--------------------------------------------------------------------------
 | The procedure source is lost; its behaviour is reconstructed from the
 | calls in DragonTigerController (testStore / testFail / testCancel), from
 | what the legacy JS does with the responses and from what the game-server
 | settlement (games/dragontiger/betsCalculator.js) expects:
 |
 |   'I' insert / update the player's bet of the round (one document per
 |       round + user + bet_range), only while the round is 'S'; transfer
 |       vendors pay the difference to the previous bet out of users.money
 |       (settlement later credits total_win), seamless vendors are checked
 |       against the balance the vendor API reported.     -> flag 1 / 0
 |   'F' the vendor API refused the debit: put the previous bet back.
 |   'D' cancel: delete the bet (round still 'S'), refund transfer users.
 |
 | Every mode runs in one MongoDB transaction that also bumps the round
 | (`bet_seq`), so a bet can't commit after the dealer moved the round on
 | (write conflict -> retry -> status no longer 'S') and concurrent bets of
 | one round are serialized (no duplicate bet documents). The debit is the
 | difference to the bet stored *inside* the transaction, so a retried or
 | double-clicked confirm never debits twice.
 |
 */

import type { ClientSession } from 'mongoose';
import type { Db } from '@/lib/db';
import { buildBetHistory } from './helpers';

export class Refused extends Error {
	reason: string;

	constructor (reason: string) {
		super(reason);
		this.reason = reason;
	}
}

type Ctx = { db : Db; user : any; vendor : any };

export type StoreParams = {
	roundId    : number;
	tableId    : number;
	roundNum   : number;
	range      : string;
	data       : any[];
	uMoney     : number;   // seamless: balance from the vendor API (transfer: read in the transaction)
	logs       : any;
	device     : string;
	playType   : string;   // 'j' junket / 'p' player
	roomId     : any;
	betId      : string;   // md5(user id . user name . round id)
	sessionId  : string;
	currency   : string;
	multiplier : number;
	ip         : string;
};

const game = (db: Db) => db.games['dragon-tiger'];
const isTransfer = (vendor: any) => vendor.integration_type !== 'seamless';

const asList = (logs: any) => (logs === null || logs === undefined ? [] : Array.isArray(logs) ? logs : [logs]);

/** bet_logs: one document per user / table / round / type, actions appended (former JSON_MERGE) */
async function betLog (db: Db, session: ClientSession, user: any, tableId: number, roundNum: number, mode: string, actions: any, ip: string) {
	const g = game(db);
	const filter = { user_id : user._id, table_id : tableId, round_num : roundNum, type : mode };
	const res = await g.betLogs.updateOne(filter, { $push : { actions : { $each : asList(actions) } }, $set : { ip } }, { session });
	if (!res.matchedCount) {
		await g.betLogs.create([{ _id : await g.nextId('bet_logs', session), ...filter, actions : asList(actions), ip }], { session });
	}
}

/** the round must still take bets; the write makes concurrent round changes conflict with us */
async function lockRound (db: Db, session: ClientSession, roundId: number, tableId: number) {
	const r = await game(db).rounds.updateOne({ _id : roundId, table_id : tableId, status : 'S' }, { $inc : { bet_seq : 1 } }, { session });
	if (!r.matchedCount) throw new Refused('round is not taking bets');
}

/** USP_STORE_BET('I', ...) */
export async function storeBet ({ db, user, vendor }: Ctx, p: StoreParams) {
	const g = game(db);
	let prevBets: any[] = [];

	try {
		const result = await db.withTransaction(async session => {
			prevBets = [];
			await lockRound(db, session, p.roundId, p.tableId);

			const current: any = await g.bets.findOne({ round_id : p.roundId, user_id : user._id, bet_range : p.range }).session(session).lean();
			prevBets = current && Array.isArray(current.bet_history) ? current.bet_history : [];

			let uMoney = p.uMoney;
			if (isTransfer(vendor)) {
				const fresh: any = await db.shared.users.findById(user._id, { money : 1 }).session(session).lean();
				uMoney = Number(fresh && fresh.money) || 0;
			}

			let built;
			try {
				built = buildBetHistory(p.data, prevBets, uMoney);
			} catch (e) {
				throw new Refused((e as Error).message);
			}
			if (!built.bets.length || built.totalBets <= 0) throw new Refused('no bets');

			const delta = built.totalBets - built.prevTotalBets;

			if (isTransfer(vendor)) {
				if (delta > 0) {
					const r = await db.shared.users.updateOne({ _id : user._id, money : { $gte : delta } }, { $inc : { money : -delta } }, { session });
					if (!r.matchedCount) throw new Refused('insufficient balance');
				} else if (delta < 0) {
					await db.shared.users.updateOne({ _id : user._id }, { $inc : { money : -delta } }, { session });
				}
			} else if (delta > uMoney) {
				throw new Refused('insufficient balance');
			}

			if (current) {
				await g.bets.updateOne({ _id : current._id }, { $set : { bet_history : built.bets, total_bet : built.totalBets, total_rolling : built.totalBets } }, { session });
			} else {
				await g.bets.create([{
					_id           : await g.nextId('bets', session),
					round_id      : p.roundId,
					user_id       : user._id,
					type          : 'r',
					bet_history   : built.bets,
					total_bet     : built.totalBets,
					total_rolling : built.totalBets,
					total_winning : 0,
					total_win     : 0,
					total_lost    : 0,
					bet_range     : p.range,
					device        : p.device,
					bet_id        : p.betId,
					session_id    : p.sessionId,
					currency      : p.currency,
					multiplier    : p.multiplier,
					play_type     : p.playType,
					room_id       : p.roomId ?? null,
					// denormalized for the history queries (former joins on rounds)
					table_id      : p.tableId,
					round_num     : p.roundNum
				}], { session });
			}

			await betLog(db, session, user, p.tableId, p.roundNum, 'I', p.logs, p.ip);

			return { flag : 1 as const, before : current, prevBets, delta, ...built };
		});
		return result;
	} catch (e) {
		if (e instanceof Refused) {
			// testStore answers with the bets the player still has (read before the procedure in PHP)
			const current: any = await g.bets.findOne({ round_id : p.roundId, user_id : user._id, bet_range : p.range }, { bet_history : 1 }).lean();
			prevBets = current && Array.isArray(current.bet_history) ? current.bet_history : [];
			return { flag : 0 as const, reason : e.reason, prevBets };
		}
		throw e;
	}
}

/** USP_STORE_BET('F', ...): the vendor refused the debit, restore the bet as it was before storeBet */
export async function revertBet ({ db, user, vendor }: Ctx, p: StoreParams, stored: { before : any; delta : number }) {
	const g = game(db);
	await db.withTransaction(async session => {
		if (stored.before) {
			await g.bets.updateOne({ _id : stored.before._id }, { $set : {
				bet_history   : stored.before.bet_history,
				total_bet     : stored.before.total_bet,
				total_rolling : stored.before.total_rolling ?? stored.before.total_bet
			} }, { session });
		} else {
			await g.bets.deleteOne({ round_id : p.roundId, user_id : user._id, bet_range : p.range }, { session });
		}
		if (isTransfer(vendor) && stored.delta) {
			await db.shared.users.updateOne({ _id : user._id }, { $inc : { money : stored.delta } }, { session });
		}
		await betLog(db, session, user, p.tableId, p.roundNum, 'F', p.logs, p.ip);
	});
}

/** USP_STORE_BET('D', ...): resolves the deleted bet (null when there was none) or throws Refused */
export async function cancelBet ({ db, user, vendor }: Ctx, p: { roundId : number; tableId : number; roundNum : number; range : string; logs : any; ip : string }) {
	const g = game(db);
	return db.withTransaction(async session => {
		await lockRound(db, session, p.roundId, p.tableId);

		const bet: any = await g.bets.findOneAndDelete({ round_id : p.roundId, user_id : user._id, bet_range : p.range }, { session }).lean();
		if (!bet) return null;

		if (isTransfer(vendor) && Number(bet.total_bet) > 0) {
			await db.shared.users.updateOne({ _id : user._id }, { $inc : { money : Number(bet.total_bet) } }, { session });
		}
		await betLog(db, session, user, p.tableId, p.roundNum, 'D', p.logs, p.ip);
		return bet;
	});
}

/** the vendor refused the cancel refund: put the deleted bet back */
export async function restoreBet ({ db, user, vendor }: Ctx, bet: any) {
	const g = game(db);
	await db.withTransaction(async session => {
		await g.bets.create([bet], { session });
		if (isTransfer(vendor) && Number(bet.total_bet) > 0) {
			await db.shared.users.updateOne({ _id : user._id }, { $inc : { money : -Number(bet.total_bet) } }, { session });
		}
	});
}
