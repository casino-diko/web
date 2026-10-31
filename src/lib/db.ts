/*
 |--------------------------------------------------------------------------
 | MongoDB
 |--------------------------------------------------------------------------
 | Same databases and collections as the game-server (see
 | backend repo: game-server/src/core/models/schemas.js): one database per game
 | plus the shared database for dealers, users, vendors, ...
 |
 | Schemas here are non-strict: the former MySQL rows carried more columns
 | than the game-server needs and the front-end reads/writes them freely.
 | Primary keys are numeric `_id`s from the `counters` collection.
 |
 |   const db = await getDb();
 |   const user = await db.shared.users.findById(1).lean();
 |   const round = await db.games.baccarat.rounds.findOne({ table_id : 1 }).sort({ _id : -1 }).lean();
 |   const id = await db.games.baccarat.nextId('bets');
 |
 */

import mongoose, { Schema, type Connection, type Model } from 'mongoose';
import { config, GAME_APPS, type GameApp } from './config';

const { Mixed } = Schema.Types;

const schema = (collection: string, fields: Record<string, any>) => new Schema(
	Object.assign({ _id : Number }, fields),
	{
		collection,
		strict     : false,
		versionKey : false,
		id         : false,
		minimize   : false,
		timestamps : { createdAt : 'created_at', updatedAt : 'updated_at' }
	}
);

const model = (conn: Connection, name: string, s: () => Schema): Model<any> =>
	conn.models[name] || conn.model(name, s());

const counter = (conn: Connection) => {
	const Counter: Model<any> = conn.models.counter || conn.model('counter',
		new Schema({ _id : String, seq : { type : Number, default : 0 } }, { collection : 'counters', versionKey : false }));

	return async (name: string, session: mongoose.ClientSession | null = null): Promise<number> => {
		const row: any = await Counter.findOneAndUpdate({ _id : name }, { $inc : { seq : 1 } }, { upsert : true, new : true, session }).lean();
		return row.seq;
	};
};

const sharedModels = (conn: Connection) => ({
	connection  : conn,
	dealers     : model(conn, 'dealer', () => schema('dealers', { name : String, real_name : String, code : String, dealer_image : String, status : String })),
	users       : model(conn, 'user', () => schema('users', { vendor_id : Number, user_id : String, user_name : String, money : Number, currency : String })),
	vendors     : model(conn, 'vendor', () => schema('vendors', { vendor_name : String, integration_type : String, secret_key : String, currency : String, multiplier : Number })),
	userGroups  : model(conn, 'user_group', () => schema('user_groups', {})),
	maintenance : model(conn, 'maintenance', () => schema('maintenance', {})),
	notice      : model(conn, 'notice', () => schema('notice', {})),
	rooms       : model(conn, 'room', () => schema('rooms', { users : { type : [Number], default : [] } })),
	videoSettings : model(conn, 'video_setting', () => schema('video_settings', { user_id : Number })),
	// settings the admin back-office writes; { _id : 'brand', name, version } (lib/brand.ts)
	settings   : model(conn, 'setting', () => new Schema({ _id : String }, { collection : 'settings', strict : false, versionKey : false })),
	// files the admin uploads: logo, icon, welcome sounds ({ _id : 'logo', content_type, data, version })
	brandFiles : model(conn, 'brand_file', () => new Schema({ _id : String, content_type : String, data : Buffer, version : Number }, { collection : 'brand_files', strict : false, versionKey : false })),
	// used launch-link nonces (`<vendor id>:<nonce>`); MongoDB drops each once its link has expired
	launchNonces : model(conn, 'launch_nonce', () => new Schema({ _id : String, expires_at : Date }, { collection : 'launch_nonces', versionKey : false })
		.index({ expires_at : 1 }, { expireAfterSeconds : 0 })),
	nextId      : counter(conn)
});

const gameModels = (conn: Connection) => ({
	connection : conn,
	tables     : model(conn, 'game_table', () => schema('game_tables', { env_setting : Mixed, bet_setting : Mixed })),
	rounds     : model(conn, 'round', () => schema('rounds', { table_id : Number, round_num : Number, status : String, game_info : Mixed, game_result : Mixed })),
	bets       : model(conn, 'bet', () => schema('bets', { round_id : Number, user_id : Number, bet_history : Mixed, total_bet : Number })),
	gameMarks  : model(conn, 'game_mark', () => schema('game_marks', { table_id : Number, mark : Mixed })),
	betLogs    : model(conn, 'bet_log', () => schema('bet_logs', { user_id : Number, round_id : Number })),
	actionLogs : model(conn, 'action_log', () => schema('action_logs', { user_id : Number })),
	nextId     : counter(conn)
});

/** extra (non-strict) collection on a connection: defineModel(db.shared.connection, 'junket_log', 'junket_logs') */
export const defineModel = (conn: Connection, name: string, collection: string, fields: Record<string, any> = {}) =>
	model(conn, name, () => schema(collection, fields));

type Shared = ReturnType<typeof sharedModels>;
type Game = ReturnType<typeof gameModels>;

export type Db = {
	shared : Shared;
	games  : Record<GameApp, Game>;
	withTransaction : <T>(fn: (session: mongoose.ClientSession) => Promise<T>) => Promise<T>;
};

// survive dev-server hot reloads
const g = globalThis as any;
g.__tgMongo = g.__tgMongo || { connecting : null as Promise<typeof mongoose> | null, db : null as Db | null };

async function withTransaction<T> (fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
	const session = await mongoose.startSession();
	try {
		let result: T;
		await session.withTransaction(async () => {
			result = await fn(session);
		});
		return result;
	} finally {
		await session.endSession();
	}
}

export async function getDb (): Promise<Db> {
	if (g.__tgMongo.db) {
		// keeps the brand name current for the page about to render (no wait: lib/brand.ts re-reads it every few seconds)
		g.__tgMongo.refreshBrand?.(g.__tgMongo.db);
		return g.__tgMongo.db;
	}

	if (!g.__tgMongo.connecting) {
		mongoose.set('strictQuery', false);
		g.__tgMongo.connecting = mongoose.connect(config.mongo.uri, { serverSelectionTimeoutMS : 15000 });
	}
	await g.__tgMongo.connecting;

	const root = mongoose.connection;
	const games = {} as Record<GameApp, Game>;
	for (const app of GAME_APPS) {
		games[app] = gameModels(root.useDb(config.mongo.games[app], { useCache : true }));
	}

	const db: Db = {
		shared : sharedModels(root.useDb(config.mongo.sharedDb, { useCache : true })),
		games,
		withTransaction
	};
	// the brand name before the first page renders, then every few seconds (lib/brand.ts)
	const { brand } = await import('./brand');
	await brand(db).catch(e => console.warn('[brand] not loaded:', (e as Error).message));
	g.__tgMongo.refreshBrand = (d: Db) => { brand(d).catch(() => {}); };
	g.__tgMongo.db = db;
	return db;
}
