/*
 |--------------------------------------------------------------------------
 | operator launch links
 |--------------------------------------------------------------------------
 | An operator (vendor) sends its player to
 |
 |   /launch?vendor=<vendor_name>&payload=<base64url JSON>&hash=<hex>
 |
 |   hash    = HMAC-SHA256(payload, vendors.secret_key), hex: the payload
 |             string exactly as it is in the url, not the decoded JSON
 |   payload = {
 |     "user_id"   : "p-1001",          their player id, 1-64 of A-Z a-z 0-9 _ . @ -
 |     "user_name" : "Kim",             optional, shown in the games, 1-64 characters
 |     "ts"        : 1793470000,        unix seconds; links live LAUNCH_MAX_AGE (5 min)
 |     "nonce"     : "8c1e...",         16-64 characters, each one works once
 |     "currency"  : "KRW",             optional, only used when the player is created
 |     "lang"      : "kr",              optional: en kr jp zh th
 |     "game"      : "poker",           optional: baccarat | dragon-tiger | poker,
 |     "table"     : 1,                 with table: straight to that table, else the lobby
 |     "lobby_url" : "https://..."      optional: where logout and "back to lobby" go
 |   }
 |
 | The same secret signs the seamless wallet calls to the operator
 | (vendor.ts), so an operator already holds it. Pure functions here (covered
 | by test/launch.test.ts); src/server/auth/controller.ts does the database
 | part: the nonce, the player, the session.
 |
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const LAUNCH_MAX_AGE = 300;          // seconds a link is valid, either side of `ts`
export const MIN_SECRET = 32;               // shorter vendor secrets can't launch

export const LAUNCH_GAMES = ['baccarat', 'dragon-tiger', 'poker'] as const;
const LANGS = ['en', 'kr', 'jp', 'zh', 'th'];
const CURRENCIES = ['CNY', 'USD', 'JPY', 'KRW', 'THB', 'MYR', 'IDR', 'RUB', 'UAH', 'GEL', 'EUR', 'GBP',
	'TRY', 'IRR', 'DGN', 'CZK', 'HUF', 'SEK', 'VND', 'HKD', 'BYN', 'INR', 'PTS'];

export type Launch = {
	userId   : string;
	userName : string | null;
	ts       : number;
	nonce    : string;
	currency : string | null;
	lang     : string | null;
	path     : string;                       // where to send the player: '/' or '/<game>/<table>'
	lobbyUrl : string | null;
};

export class LaunchRefused extends Error {}

export const signPayload = (payload: string, secret: string) =>
	createHmac('sha256', secret).update(payload).digest('hex');

export const encodePayload = (data: object) => Buffer.from(JSON.stringify(data)).toString('base64url');

/** a signed launch query for `data` (operators' side; tests, docs and the dev tools use it) */
export function launchQuery (vendorName: string, data: object, secret: string): string {
	const payload = encodePayload(data);
	return new URLSearchParams({ vendor : vendorName, payload, hash : signPayload(payload, secret) }).toString();
}

/**
 * Checks the signature, age and fields of a launch. `secret` is the vendor's
 * secret_key; `now` in unix seconds. Throws LaunchRefused with the reason
 * (logged, never shown to the player).
 */
export function verifyLaunch (payload: string, hash: string, secret: string, now: number): Launch {
	if (!secret || secret.length < MIN_SECRET) throw new LaunchRefused('vendor has no launch secret');
	if (!/^[A-Za-z0-9_-]{1,4096}$/.test(payload)) throw new LaunchRefused('payload is not base64url');
	if (!/^[0-9a-f]{64}$/i.test(hash)) throw new LaunchRefused('hash is not hex sha256');

	const expected = Buffer.from(signPayload(payload, secret), 'hex');
	if (!timingSafeEqual(expected, Buffer.from(hash.toLowerCase(), 'hex'))) throw new LaunchRefused('bad signature');

	let data: any;
	try {
		data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		throw new LaunchRefused('payload is not JSON');
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LaunchRefused('payload is not an object');

	const ts = Number(data.ts);
	if (!Number.isInteger(ts)) throw new LaunchRefused('ts missing');
	if (Math.abs(now - ts) > LAUNCH_MAX_AGE) throw new LaunchRefused('link expired');

	const nonce = String(data.nonce ?? '');
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new LaunchRefused('nonce must be 16-64 of A-Z a-z 0-9 _ -');

	const userId = String(data.user_id ?? '');
	if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(userId)) throw new LaunchRefused('bad user_id');

	const userName = data.user_name === undefined || data.user_name === null ? null : String(data.user_name).trim();
	if (userName !== null && (!userName || userName.length > 64)) throw new LaunchRefused('bad user_name');

	const currency = data.currency ? String(data.currency) : null;
	if (currency && !CURRENCIES.includes(currency)) throw new LaunchRefused('unknown currency');

	const lang = data.lang && LANGS.includes(String(data.lang)) ? String(data.lang) : null;

	let path = '/';
	if (data.game !== undefined && data.game !== null && data.game !== '') {
		const game = String(data.game);
		const table = Number(data.table);
		if (!(LAUNCH_GAMES as readonly string[]).includes(game)) throw new LaunchRefused('unknown game');
		if (!Number.isInteger(table) || table < 1 || table > 9999) throw new LaunchRefused('bad table');
		path = `/${game}/${table}`;
	}

	let lobbyUrl: string | null = null;
	if (data.lobby_url) {
		try {
			const url = new URL(String(data.lobby_url));
			if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
			lobbyUrl = url.toString();
		} catch {
			throw new LaunchRefused('bad lobby_url');
		}
	}

	return { userId, userName, ts, nonce, currency, lang, path, lobbyUrl };
}
