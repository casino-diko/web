/*
 |--------------------------------------------------------------------------
 | poker end-to-end check
 |--------------------------------------------------------------------------
 | Drives the poker front (this Next app) together with the game server:
 |
 |   - pages: /poker/1 (desktop + mobile UA) and the mobile urls render, every
 |     script / stylesheet / image they reference answers 200, window.* sane
 |   - a dealer (socket.io, protocol of game-server/scripts/smoke-poker.js)
 |     runs one round on table 1 (normal) and one on table 2 (bonusplus)
 |   - players place ante / bonus / pocket / bonusplus, flop / turn / river,
 |     folds, checks and cancels through the front's endpoints with the
 |     payloads the compiled JS posts (jQuery urlencoded, data[i][table_id])
 |   - the game server settles; total_win / users.money / vendor balance
 |     are checked against the payout rules
 |   - records / settings endpoints answer the shapes the legacy JS reads
 |
 | User 1 is a transfer wallet (users.money). User 3 is seamless: its vendor
 | API is a stub started here (front must run with API_URL=http://127.0.0.1:$VENDOR_PORT).
 |
 |   FRONT=http://localhost:3104 GAME_PORT=18409 VENDOR_PORT=18419 \
 |   MONGO_URI=... MONGO_SHARED_DB=... POKER_DB=... node scripts/check-poker.mjs
 |
 | GAME_SERVER_DIR (default ../backend/game-server) provides socket.io-client.
 |
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONT = (process.env.FRONT || 'http://localhost:3104').replace(/\/$/, '');
const GAME_PORT = Number(process.env.GAME_PORT || process.env.POKER_PORT || 18409);
const VENDOR_PORT = Number(process.env.VENDOR_PORT || 18419);
const GAME_SERVER_DIR = process.env.GAME_SERVER_DIR || path.join(HERE, '../../backend/game-server');
const { io } = createRequire(path.join(GAME_SERVER_DIR, 'package.json'))('socket.io-client');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';
const SHARED_DB = process.env.MONGO_SHARED_DB || 'nihtan_api';
const POKER_DB = process.env.POKER_DB || 'poker';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const step = msg => console.log(`  \u2713 ${msg}`);

// ------------------------------------------------------------------ vendor API stub (seamless wallet)
const wallet = new Map([['player3', 100000]]);
const ledger = [];
const vendorStub = createServer((req, res) => {
	let body = '';
	req.on('data', c => { body += c; });
	req.on('end', () => {
		const url = new URL(req.url, 'http://stub');
		const hash = createHmac('sha256', '').update(body).digest('hex'); // seeded vendors have no secret_key
		if (url.searchParams.get('hash') !== hash) {
			res.writeHead(403).end('bad hash');
			return;
		}
		const data = JSON.parse(body || '{}');
		res.setHeader('content-type', 'application/json');
		if (url.pathname === '/api/check') {
			res.end(JSON.stringify(wallet.get(data.user_id) ?? 0));
			return;
		}
		const m = /^\/api\/transact\/(\w+)\/(bet|cancel)$/.exec(url.pathname);
		if (!m) return res.writeHead(404).end('{}');
		ledger.push({ ...data, api_game : m[1], api_type : m[2] });
		const balance = wallet.get(data.user_id) ?? 0;
		if (m[2] === 'bet') {
			if (balance < data.amount) return res.end(JSON.stringify({ status : 'fail' }));
			wallet.set(data.user_id, balance - data.amount);
		} else {
			wallet.set(data.user_id, balance + data.amount);
		}
		res.end(JSON.stringify({ status : 'ok' }));
	});
});

// ------------------------------------------------------------------ http client (one cookie jar per player)

/** jQuery.param (traditional = false), what $.post sends */
function param (obj, prefix = '') {
	const parts = [];
	for (const [k, v] of Object.entries(obj)) {
		const key = prefix ? `${prefix}[${Array.isArray(obj) && (v === null || typeof v !== 'object') ? '' : k}]` : k;
		if (v !== null && typeof v === 'object') parts.push(param(v, prefix ? `${prefix}[${k}]` : k));
		else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v ?? '')}`);
	}
	return parts.filter(Boolean).join('&');
}

class Player {
	constructor (uid) {
		this.uid = uid;
		this.cookie = '';
		this.referer = `${FRONT}/poker/1`;
	}

	async login () {
		const res = await fetch(`${FRONT}/login`, {
			method   : 'POST',
			redirect : 'manual',
			headers  : { 'content-type' : 'application/x-www-form-urlencoded' },
			body     : `uid=${this.uid}&locale=en`
		});
		assert.equal(res.status, 303, `login ${this.uid}`);
		this.cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
		assert.ok(this.cookie, 'session cookie');
	}

	async request (method, url, { body, ua = DESKTOP_UA, referer = this.referer, xhr = true } = {}) {
		const headers = { cookie : this.cookie, 'user-agent' : ua, referer };
		if (xhr) headers['x-requested-with'] = 'XMLHttpRequest';
		if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
		const res = await fetch(url.startsWith('http') ? url : `${FRONT}${url}`, { method, headers, body : body === undefined ? undefined : param(body), redirect : 'manual' });
		const text = await res.text();
		let json;
		try { json = JSON.parse(text); } catch { json = undefined; }
		return { status : res.status, type : res.headers.get('content-type') || '', text, json, headers : res.headers };
	}

	post (url, body = {}) {
		return this.request('POST', url, { body });
	}
}

// ------------------------------------------------------------------ dealer (game server socket)

function dealer (table) {
	const socket = io(`http://127.0.0.1:${GAME_PORT}`, { transports : ['websocket'], reconnection : false });
	const push = (payload, timeout = 10000) => socket.timeout(timeout).emitWithAck('push', payload);
	const ready = new Promise((resolve, reject) => {
		socket.on('connect', resolve);
		socket.on('connect_error', reject);
	});
	return {
		socket,
		async start () {
			await ready;
			const init = await push({ event : 'init', data : table });
			assert.ok(!init.error, `dealer init ${table}: ${JSON.stringify(init)}`);
			const roundNum = await push({ event : 'newround', roundNum : init.roundNum });
			assert.equal(roundNum, init.roundNum + 1, `newround ${JSON.stringify(roundNum)}`);
			return roundNum;
		},
		progress : () => push({ event : 'setroundprogress' }),
		async deal (cards) {
			for (const [from, code] of cards) {
				const ack = await push({ event : 'inputitem', from, data : code });
				assert.ok(!ack.error, `inputitem ${from} ${code}: ${JSON.stringify(ack)}`);
			}
		},
		results : () => push({ event : 'displayresults' }, 20000),
		close : () => socket.close()
	};
}

// player AH AD | flop AC 7S 2D | turn KC | river 9H | dealer 5C 6C -> player, three of a kind, hole pair AA (bonus / pocket 30x)
const HOLE = [['burn', '0040'], ['player', '0013'], ['player', '0026']];
const FLOP = [['burn', '0041'], ['flop', '0000'], ['flop', '0045'], ['flop', '0027']];
const TURN = [['burn', '0042'], ['turn', '0012']];
const RIVER = [['river', '0021']];
const DEALER = [['dealer', '0004'], ['dealer', '0005']];

// ------------------------------------------------------------------ page checks

const assetUrls = html => {
	const urls = new Set();
	for (const m of html.matchAll(/<(?:script|img|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
		const url = m[1];
		if (!url || url.startsWith('#') || url.startsWith('data:') || /^https?:\/\//.test(url) && !url.startsWith(FRONT)) continue;
		urls.add(url);
	}
	// drop the ones inside HTML comments
	const comments = Array.from(html.matchAll(/<!--[\s\S]*?-->/g), m => m[0]).join('\n');
	return [...urls].filter(u => !comments.includes(u) || html.split(u).length - 1 > comments.split(u).length - 1);
};

/** evaluates the page's first inline <script> (the window.* config) in a sandbox */
function windowConfig (html) {
	const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html);
	assert.ok(script, 'inline config script');
	const window = {};
	vm.runInNewContext(script[1], { window });
	return JSON.parse(JSON.stringify(window)); // plain objects of this realm
}

async function checkPage (player, url, ua, expectScript) {
	const page = await player.request('GET', url, { ua, xhr : false, referer : `${FRONT}/` });
	assert.equal(page.status, 200, `${url} (${ua === MOBILE_UA ? 'mobile' : 'desktop'}): ${page.status} ${page.text.slice(0, 300)}`);
	assert.ok(page.type.startsWith('text/html'));
	assert.ok(page.text.includes(expectScript), `${url} loads ${expectScript}`);

	const urls = assetUrls(page.text);
	const bad = [];
	await Promise.all(urls.map(async u => {
		const res = await fetch(new URL(u, `${FRONT}${url}`), { headers : { referer : `${FRONT}${url}`, cookie : player.cookie } });
		await res.arrayBuffer();
		if (res.status !== 200) bad.push(`${res.status} ${u}`);
	}));
	assert.deepEqual(bad, [], `assets of ${url}`);

	const w = windowConfig(page.text);
	return { w, html : page.text, count : urls.length };
}

// ------------------------------------------------------------------ main

let db;
let conn;
const money = async uid => (await db.shared.collection('users').findOne({ _id : uid })).money;
const betOf = async (roundId, uid) => db.poker.collection('bets').findOne({ round_id : roundId, user_id : uid });
const latestRound = async table => db.poker.collection('rounds').find({ table_id : table }).sort({ _id : -1 }).limit(1).next();

async function main () {
	await new Promise(resolve => vendorStub.listen(VENDOR_PORT, '127.0.0.1', resolve));
	conn = await mongoose.createConnection(MONGO_URI).asPromise();
	db = { shared : conn.useDb(SHARED_DB).db, poker : conn.useDb(POKER_DB).db };

	// start from users without stored settings (a previous run leaves some)
	await db.shared.collection('users').updateMany({ _id : { $in : [1, 3] } }, { $unset : { configs : 1, last_game_info : 1 } });

	const p1 = new Player(1); // transfer
	const p3 = new Player(3); // seamless
	await p1.login();
	await p3.login();
	step('dev login users 1 (transfer) and 3 (seamless)');

	// -------------------------------------------------------------- pages
	const desk = await checkPage(p1, '/poker/1', DESKTOP_UA, '/poker/dist/poker.min.js');
	assert.equal(desk.w.p_domain, `${FRONT}/poker/`);
	assert.equal(desk.w.bc_domain, `${FRONT}/baccarat/`);
	assert.equal(desk.w.dt_domain, `${FRONT}/dragon-tiger/`);
	assert.equal(desk.w.lobby_domain, `${FRONT}/`);
	assert.ok(/^https?:\/\/.+\/$/.test(desk.w.socket), `window.socket ${desk.w.socket}`);
	assert.equal(desk.w.userId, 1);
	assert.equal(typeof desk.w.user_money, 'number');
	assert.equal(desk.w.range, '20-1000');
	assert.equal(desk.w.tableNum, '1');
	assert.equal(desk.w.rangeDetails.min, '20');
	assert.ok(Array.isArray(desk.w.allRange) && desk.w.allRange.length > 1);
	assert.equal(desk.w.integrationType, 'transfer');
	assert.equal(desk.w.casino, 'SS');
	assert.equal(typeof desk.w.mainMultiplier, 'number');
	assert.equal(desk.w.config.language, 'english');
	assert.deepEqual(desk.w.user_chips, ['1', '5', '10', '30', 'max']);
	assert.equal(desk.w.game, 'Poker');
	assert.ok(desk.w.videostream_url.includes('poker1'));
	assert.ok(desk.html.includes('class="range-select selected" data=\'20-1000\''), 'channel range list');
	step(`GET /poker/1 desktop: ${desk.count} assets 200, window.* config ok`);

	const mob = await checkPage(p1, '/poker/1', MOBILE_UA, '/poker/dist/poker-mobile.min.js');
	assert.equal(mob.w.poker_domain, `${FRONT}/poker/`);
	assert.equal(mob.w.tableNum, 1);
	assert.equal(mob.w.bet_type, 'r');
	step(`GET /poker/1 mobile UA -> mobile page: ${mob.count} assets 200`);

	const m2 = await checkPage(p3, '/poker/m/Poker/2/20-1000?slave=bonusplus', MOBILE_UA, '/poker/dist/poker-mobile.min.js');
	assert.equal(m2.w.bet_type, 'b');
	assert.equal(m2.w.integrationType, 'seamless');
	assert.match(m2.html, /window\.user_money = 100000;/, 'seamless balance from the vendor stub');
	const non = await checkPage(p1, '/poker/non/Poker/1/20-1000', MOBILE_UA, '/poker/dist/poker-mobile.min.js');
	assert.equal(non.w.range, '20-1000');
	const badRange = await p1.request('GET', '/poker/m/Poker/1/1-2', { xhr : false });
	assert.equal(badRange.status, 302);
	const rejected = await p1.request('GET', '/poker/rejected', { xhr : false });
	assert.equal(rejected.status, 200);
	assert.ok(rejected.text.includes('content dom-resizable'));
	const anon = await fetch(`${FRONT}/poker/1`, { redirect : 'manual' });
	assert.equal(anon.status, 302, 'guest redirected to login');
	// root-relative urls of the compiled JS resolve through the referer (middleware)
	const assets = await fetch(`${FRONT}/assets.json`, { headers : { referer : `${FRONT}/poker/1` } });
	assert.equal(assets.status, 200, '/assets.json via referer');
	step('mobile /m/Poker + /non/Poker pages, bad range redirect, /rejected, guest redirect, referer-scoped /assets.json');

	// -------------------------------------------------------------- rounds
	const d1 = dealer(1);
	const d2 = dealer(2);
	const [rn1, rn2] = await Promise.all([d1.start(), d2.start()]);
	const r1 = await latestRound(1);
	const r2 = await latestRound(2);
	assert.equal(r1.round_num, rn1);
	assert.equal(r1.status, 'S');
	step(`dealer: new rounds table 1 #${rn1} (id ${r1._id}), table 2 #${rn2} (id ${r2._id})`);

	const m1start = await money(1);
	const m3start = await money(3);
	const w3start = wallet.get('player3');
	const logs = [{ action : 'confirm startround', comment : 'total, 30', user_money : 100000 }];

	// ---- table 1, user 1 (transfer, normal): ante 20 + bonus 10
	const store1 = '/poker/bet/store/1/20-1000';
	let res = await p1.post(store1, { data : [{ amount : 20, table_id : 'ante' }, { amount : 10, table_id : 'bonus' }], logs, type : 'r', device : 'w', range : '20-1000' });
	assert.equal(res.status, 200, res.text);
	assert.equal(res.json.fail, 0, res.text);
	assert.equal(typeof res.json.data, 'string', 'data is JSON text (the JS JSON.parse()s it)');
	assert.deepEqual(Object.keys(JSON.parse(res.json.data)), ['ante', 'bonus', 'flop', 'turn', 'river']);
	assert.equal(res.json.money, m1start - 30);
	assert.equal(await money(1), m1start - 30);
	let b1 = await betOf(r1._id, 1);
	assert.equal(b1.type, 'r');
	assert.equal(b1.total_bet, 30);
	assert.equal(b1.bet_range, '20-1000');
	assert.equal(b1.currency, 'USD');
	assert.equal(typeof b1._id, 'number');
	assert.equal(b1.bet_id.length, 32);
	assert.deepEqual(b1.bet_history.ante, { bet : 20, win : 0, user_money : m1start });
	assert.deepEqual(b1.bet_history.flop, { bet : 0, win : 0, user_money : 0, cancel : 0 });
	step('store: user 1 ante 20 + bonus 10 -> debited 30, bet doc { type r, bet_history, total_bet 30, bet_range, currency, bet_id }');

	// retry + concurrent duplicates: no double debit
	const same = { data : [{ amount : 20, table_id : 'ante' }, { amount : 10, table_id : 'bonus' }], logs, type : 'r', device : 'w', range : '20-1000' };
	const dup = await Promise.all([p1.post(store1, same), p1.post(store1, same), p1.post(store1, same)]);
	assert.ok(dup.every(r => r.json.fail === 0));
	assert.equal(await money(1), m1start - 30);
	// concurrent increases: each applied once, serialized by the transaction
	const more = { ...same, data : [{ amount : 40, table_id : 'ante' }, { amount : 10, table_id : 'bonus' }] };
	await Promise.all([p1.post(store1, more), p1.post(store1, more)]);
	assert.equal(await money(1), m1start - 50);
	assert.equal((await betOf(r1._id, 1)).total_bet, 50);
	assert.equal(await db.poker.collection('bets').countDocuments({ round_id : r1._id, user_id : 1 }), 1);
	step('retries / concurrent duplicates debit once; concurrent raise to ante 40 debits +20 once, single bet doc');

	// transfer cancel (testCancel route) then bet again
	res = await p1.post('/poker/bet/cancel/1/20-1000', { logs, slave : 'normal', device : 'w', type : 'r', data : [], range : '20-1000' });
	assert.equal(res.json.status, 1, res.text);
	assert.equal(res.json.money, m1start);
	assert.equal(await betOf(r1._id, 1), null);
	res = await p1.post(store1, same);
	assert.equal(res.json.fail, 0);
	assert.equal(await money(1), m1start - 30);
	step('cancel: refund 50, bet removed; re-bet ante 20 + bonus 10');

	// refusals
	res = await p1.post(store1, { ...same, type : 'b' });
	assert.deepEqual([res.json.fail, res.json.data], [1, []], 'other channel than the bet');
	res = await p1.post(store1, { ...same, data : [{ amount : 10, table_id : 'ante' }] });
	assert.equal(res.json.fail, 1, 'decrease refused');
	assert.equal(res.json.data.ante.bet, 20, 'fail answers the previous bets');
	res = await p1.post(store1, { ...same, data : [{ amount : 20, table_id : 'ante' }, { amount : 40, table_id : 'flop' }] });
	assert.equal(res.json.fail, 1, 'flop while betting refused');
	res = await p1.post(store1, { ...same, data : [{ amount : 999999999, table_id : 'ante' }] });
	assert.equal(res.json.fail, 1, 'insufficient balance');
	assert.equal(await money(1), m1start - 30);
	step('refused: other channel, lowering a bet, flop while betting, insufficient balance (money unchanged)');

	// ---- table 1, user 3 (seamless, normal): ante 20 + bonus 10, cancel, ante 20
	res = await p3.post(store1, same);
	assert.equal(res.json.fail, 0, res.text);
	assert.equal(wallet.get('player3'), w3start - 30);
	assert.equal(res.json.money, w3start - 30);
	const bet3 = ledger.filter(l => l.api_type === 'bet').at(-1);
	assert.equal(bet3.api_game, 'poker');
	assert.equal(bet3.game, 'Poker');
	assert.equal(bet3.amount, 30);
	assert.equal(bet3.round_no, rn1);
	assert.equal(bet3.user_id, 'player3');
	res = await p3.post('/poker/bet/cancel/1/20-1000', { slave : 'normal', device : 'w', type : 'r', range : '20-1000' });
	assert.equal(res.json.status, 1);
	assert.equal(wallet.get('player3'), w3start);
	assert.equal(ledger.at(-1).api_type, 'cancel');
	assert.equal(ledger.at(-1).game, 'Poker');
	assert.equal(ledger.at(-1).amount, 30);
	res = await p3.post(store1, { ...same, data : [{ amount : 20, table_id : 'ante' }] });
	assert.equal(res.json.fail, 0);
	assert.equal(wallet.get('player3'), w3start - 20);
	assert.equal(await money(3), m3start, 'seamless users.money untouched');
	step('seamless user 3: bet 30 debited by the vendor API, cancel refunded via API, ante 20; users.money untouched');

	// a refused vendor debit reverts the bet
	wallet.set('player3', 5);
	res = await p3.post(store1, { ...same, data : [{ amount : 20, table_id : 'ante' }, { amount : 10, table_id : 'bonus' }] });
	assert.equal(res.json.fail, 1);
	assert.equal((await betOf(r1._id, 3)).total_bet, 20);
	wallet.set('player3', w3start - 20);
	step('seamless: balance too low -> refused, bet unchanged');

	// ---- table 2, user 1 (transfer, bonusplus): ante 20 + pocket ("bonus") 10 + bonusplus 10
	const store2 = '/poker/bet/store/2/20-1000';
	const bp = { data : [{ amount : 20, table_id : 'ante' }, { amount : 10, table_id : 'bonus' }, { amount : 10, table_id : 'bonusplus' }], logs, type : 'b', device : 'w', range : '20-1000' };
	res = await p1.post(store2, bp);
	assert.equal(res.json.fail, 0, res.text);
	assert.deepEqual(Object.keys(JSON.parse(res.json.data)), ['ante', 'bonusplus', 'pocket', 'flop', 'turn', 'river']);
	assert.equal(await money(1), m1start - 70);
	// multi-table cancel of the other channel is a no-op, of this channel refunds
	res = await p1.post('/poker/bet/cancelMulti/2/20-1000', { type : 'm', slave : 'normal', range : '20-1000', device : 's' });
	assert.equal(res.json.status, 1);
	res = await p1.post(store2, bp);
	assert.equal(res.json.fail, 0);
	assert.equal(await money(1), m1start - 70);
	assert.equal((await betOf(r2._id, 1)).type, 'b');
	step('table 2 bonusplus: ante 20 + pocket 10 + bonusplus 10 (type b)');

	// -------------------------------------------------------------- dealing
	assert.equal(await d1.progress(), 'P');
	assert.equal(await d2.progress(), 'P');
	res = await p1.post(store1, { ...same, data : [{ amount : 30, table_id : 'ante' }] });
	assert.equal(res.json.fail, 1, 'ante after betting closed');
	res = await p1.post('/poker/bet/cancel/1/20-1000', { slave : 'normal', type : 'r', range : '20-1000' });
	assert.equal(res.json.status, 0, 'no cancel once dealing');
	await Promise.all([d1.deal([...HOLE, ...FLOP]), d2.deal([...HOLE, ...FLOP])]);

	// flop decisions: user 1 raises (2x ante) on both tables, user 3 folds
	const flopRows = [{ amount : 20, table_id : 'ante' }, { amount : 10, table_id : 'bonus' }, { amount : 40, table_id : 'flop' }];
	res = await p1.post(store1, { data : [{ amount : 20, table_id : 'ante' }, { amount : 10, table_id : 'bonus' }, { amount : 30, table_id : 'flop' }], logs, type : 'r', range : '20-1000' });
	assert.equal(res.json.fail, 1, 'flop must be 2x ante');
	res = await p1.post(store1, { data : flopRows, logs, type : 'r', range : '20-1000' });
	assert.equal(res.json.fail, 0, res.text);
	assert.equal(JSON.parse(res.json.data).flop.bet, 40);
	res = await p1.post(store2, { data : [...bp.data, { amount : 40, table_id : 'flop' }], logs, type : 'b', range : '20-1000' });
	assert.equal(res.json.fail, 0, res.text);
	assert.equal(await money(1), m1start - 150);

	res = await p3.post('/poker/bet/setFoldCheck/1', { type : 'flop' });
	assert.equal(res.json.flop.cancel, 1, res.text);
	assert.equal(res.json.flop.bet, 0);
	res = await p3.post(store1, { data : [{ amount : 20, table_id : 'ante' }, { amount : 40, table_id : 'flop' }], type : 'r', range : '20-1000' });
	assert.equal(res.json.fail, 1, 'no flop bet after folding');
	res = await p1.post('/poker/bet/setFoldCheck/1', { type : 'flop' });
	assert.equal(res.json.flop.cancel, 0, 'no fold over a placed flop bet');
	assert.equal(res.json.flop.bet, 40);
	step('dealing: ante/cancel refused, flop 2x ante raised (tables 1+2, -80), user 3 folded, no raise after fold');

	// turn: user 1 checks on table 1, bets on table 2
	await Promise.all([d1.deal(TURN), d2.deal(TURN)]);
	res = await p1.post(store1, { data : [...flopRows, { amount : 40, table_id : 'flop' }], type : 'r', range : '20-1000' });
	assert.equal(res.json.fail, 0, 'flop re-sent unchanged is fine');
	res = await p1.post('/poker/bet/setFoldCheck/1', { type : 'turn' });
	assert.equal(res.json.turn.cancel, 1);
	res = await p1.post(store2, { data : [...bp.data, { amount : 40, table_id : 'flop' }, { amount : 20, table_id : 'turn' }], type : 'b', range : '20-1000' });
	assert.equal(res.json.fail, 0, res.text);
	res = await p1.post(store2, { data : [...bp.data, { amount : 40, table_id : 'flop' }, { amount : 20, table_id : 'turn' }], type : 'b', range : '20-1000' });
	assert.equal(res.json.fail, 0);
	assert.equal(await money(1), m1start - 170);

	// river: both tables bet; the turn check row comes along (amount 0, cancel 1)
	await Promise.all([d1.deal(RIVER), d2.deal(RIVER)]);
	res = await p1.post(store1, { data : [...flopRows, { amount : 0, table_id : 'turn', cancel : 1 }, { amount : 20, table_id : 'river' }], type : 'r', range : '20-1000' });
	assert.equal(res.json.fail, 0, res.text);
	const h1 = JSON.parse(res.json.data);
	assert.equal(h1.turn.cancel, 1, 'turn check kept');
	assert.equal(h1.river.bet, 20);
	res = await p1.post(store2, { data : [...bp.data, { amount : 40, table_id : 'flop' }, { amount : 20, table_id : 'turn' }, { amount : 20, table_id : 'river' }], type : 'b', range : '20-1000' });
	assert.equal(res.json.fail, 0, res.text);
	assert.equal(await money(1), m1start - 210);
	step('turn: check (table 1) / bet 20 (table 2, retried once); river 20 on both; money -210 in total');

	await Promise.all([d1.deal(DEALER), d2.deal(DEALER)]);
	res = await p1.post(store1, { data : [...flopRows, { amount : 20, table_id : 'river' }, { amount : 20, table_id : 'turn' }], type : 'r', range : '20-1000' });
	assert.equal(res.json.fail, 1, 'turn after the river card');

	// -------------------------------------------------------------- settlement
	const [res1, res2] = await Promise.all([d1.results(), d2.results()]);
	assert.ok(!res1.error && !res2.error, `displayresults ${JSON.stringify(res1).slice(0, 200)} ${JSON.stringify(res2).slice(0, 200)}`);
	assert.equal(res1.winSide, 'player');
	assert.equal(res1.gameResult.handtype, 'Three of a Kind');

	// payout rules (services.payoutHandler.player): ante push (three of a kind), flop/turn/river 1:1, bonus / pocket AA 30x
	b1 = await betOf(r1._id, 1);
	// table 1 user 1: bets ante 20 bonus 10 flop 40 turn 0 river 20 = 90; winning 40+20 + 300 -> total_win 450
	assert.equal(b1.total_bet, 90);
	assert.equal(b1.total_win, 450);
	assert.equal(b1.bet_history.bonus.win, 310);
	assert.equal(b1.bet_history.ante.win, 20);
	const b12 = await betOf(r2._id, 1);
	// table 2 user 1: ante 20 flop 40 turn 20 river 20 pocket 10 bonusplus 10 = 120; winning 80 + 300, bonusplus lost 10 -> 490
	assert.equal(b12.total_bet, 120);
	assert.equal(b12.total_win, 490);
	assert.equal(b12.total_lost, 10);
	assert.equal(b12.bet_history.pocket.win, 310);
	const b3 = await betOf(r1._id, 3);
	// user 3 folded: everything lost
	assert.equal(b3.total_win, 0);
	assert.equal(b3.total_lost, 20);
	assert.equal(await money(1), m1start - 210 + 450 + 490, 'transfer user credited total_win of both bets');
	assert.equal(await money(3), m3start, 'seamless users.money untouched by the settlement');
	assert.equal(wallet.get('player3'), w3start - 20, 'seamless vendor balance: the folded ante');
	const again = await d1.results();
	assert.equal(again.error, true);
	assert.equal(await money(1), m1start - 210 + 940, 'no double payout');
	step(`settled: table 1 user 1 total_win 450, table 2 user 1 490 (bonusplus lost), user 3 folded 0; money ${m1start} -> ${await money(1)}`);

	res = await p1.post(store1, same);
	assert.equal(res.json.fail, 1, 'no bets on a resulted round');
	res = await p1.post('/poker/bet/cancel/1/20-1000', { slave : 'normal', range : '20-1000' });
	assert.equal(res.json.status, 0, 'no cancel after results');
	assert.equal(await money(1), m1start - 210 + 940);

	// -------------------------------------------------------------- records / settings
	res = await p1.post('/poker/get/winAll/1');
	assert.deepEqual(res.json, { total_win : 450, bet : 90, slave : 'normal', user_money : m1start - 210 + 940 });

	res = await p1.post('/poker/get/user');
	assert.ok(res.type.startsWith('text/html'), 'getUser answered JSON text');
	assert.equal(JSON.parse(res.text).money, m1start - 210 + 940);
	assert.equal(JSON.parse(res.text).id, 1);
	assert.equal(JSON.parse(res.text).password, undefined);
	res = await p1.request('GET', '/poker/m/Poker/get/user');
	assert.equal(JSON.parse(res.text).id, 1);

	res = await p1.post('/poker/1/20-1000/betlogs', { tableId : 1, betPage : 1, gameType : 'L', roundNum : 0, playType : 'p' });
	assert.ok(Array.isArray(res.json), res.text);
	const row = res.json[0];
	assert.equal(row.round_num, rn1);
	assert.ok(row.cnt >= 1);
	assert.equal(row.dealer_name, 'Anna', 'seeded dealer of table 1');
	assert.equal(typeof row.game_info, 'string');
	assert.equal(JSON.parse(row.game_result).winner, 'player');
	assert.equal(row.total_win, 450);
	assert.equal(row.status, 'E');
	assert.match(row.updated_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
	res = await p1.post('/poker/1/20-1000/betlogs', { roundNum : rn1, tableId : 1, page : 0, gameType : 'D', playType : 'p' });
	assert.equal(res.json.length, 1);
	assert.equal(JSON.parse(res.json[0].bet_history).river.bet, 20);

	res = await p1.post('/poker/1/20-1000/betlogs', { tableId : 1, bet_type : 'r', mobile : true });
	let pg = JSON.parse(res.text);
	assert.deepEqual(Object.keys(pg), ['total', 'per_page', 'current_page', 'last_page', 'next_page_url', 'prev_page_url', 'from', 'to', 'data']);
	assert.ok(pg.total >= 1);
	assert.deepEqual(JSON.parse(pg.data[0].mark), { mark : 'P' });
	assert.equal(pg.data[0].round_id, r1._id);
	res = await p1.request('GET', '/poker/2/20-1000/betlogs?page=1&tableId=2&bet_type=b&mobile=true');
	pg = JSON.parse(res.text);
	assert.equal(pg.data[0].round_id, r2._id);
	assert.equal(JSON.parse(pg.data[0].bet_history).bonusplus.bet, 10);
	res = await p1.request('GET', `/poker/2/20-1000/betlogs?page=${pg.last_page + 1}&tableId=2&bet_type=b&mobile=true`);
	pg = JSON.parse(res.text);
	assert.equal(pg.current_page, pg.last_page + 1);
	assert.equal(pg.data.length, 0);

	res = await p1.post('/poker/1/20-1000/gamehistory', { tableId : 1 });
	pg = JSON.parse(res.text);
	assert.ok(pg.total >= 1, 'seeded round');
	assert.ok(pg.data.every(r => r.round_num < rn1));
	assert.equal(typeof pg.data[0].game_info, 'string');
	assert.deepEqual(JSON.parse(pg.data[0].mark), { mark : 'P' });
	assert.ok(pg.data[0].name);
	res = await p1.post('/poker/m/Poker/1/20-1000/transferlogs', { tableId : 1 });
	pg = JSON.parse(res.text);
	assert.equal(pg.total, 0);
	assert.equal(pg.current_page, 1);

	res = await p1.post('/poker/details/getDetails', { round : r2._id, tableId : 2, type : 'b' });
	assert.equal(res.json.length, 1);
	assert.equal(JSON.parse(res.json[0].bet_history).pocket.win, 310);
	assert.equal(JSON.parse(res.json[0].game_result).handtype, 'Three of a Kind');
	assert.equal(typeof res.json[0].game_info, 'string');
	step('records: winAll, get/user (no password), betlogs L/D + mobile paginator, gamehistory, transferlogs, getDetails');

	res = await p1.post('/poker/settings', { volume : '0.3', tutorial : 'false', chips : ['1', '10'] });
	assert.equal(res.status, 200);
	let u1 = await db.shared.collection('users').findOne({ _id : 1 });
	assert.equal(u1.configs.avarta.sound.volum, '0.3');
	assert.deepEqual(u1.configs.avarta.chips, ['1', '10']);
	res = await p1.post('/poker/setGameSettings', { game : 'Poker/1', range : '50-2500', slave : 'classic' });
	u1 = await db.shared.collection('users').findOne({ _id : 1 });
	assert.deepEqual([u1.last_game_info.game, u1.last_game_info.bet_range, u1.last_game_info.slave], ['Poker/1', '50-2500', '']);
	res = await p1.post('/poker/settings/videoSetting', { type : 'SD' });
	u1 = await db.shared.collection('users').findOne({ _id : 1 });
	assert.equal(u1.configs.avarta.video, 'SD');
	assert.equal((await db.shared.collection('video_settings').findOne({ user_id : 1 })).type, 'SD');
	const again1 = await checkPage(p1, '/poker/1', DESKTOP_UA, '/poker/dist/poker.min.js');
	assert.equal(again1.w.range, '50-2500', 'last_game_info range used');
	assert.equal(again1.w.config.volume, '0.3');
	assert.equal(again1.w.config.video, 'SD');
	assert.deepEqual(again1.w.user_chips, ['1', '10']);
	const bets = /window\.bets = (\{.*\});/.exec(again1.html);
	assert.ok(bets, 'window.bets of the last bet');
	const lastBet = JSON.parse(bets[1]);
	assert.equal(typeof lastBet.bet_history, 'string');
	assert.equal(lastBet.id, r2._id, 'bets JOIN rounds: round columns win');
	assert.equal(lastBet.round_num, rn2);
	res = await p1.post('/poker/checkTable', { vendorId : 1 });
	assert.deepEqual(res.json, [{ junket_table : null }]);
	res = await p1.post('/poker/getDealerImg', { dealerId : 3 });
	assert.deepEqual(res.json, [{ dealer_image : 'dealer3.png', id : 3 }]);
	res = await p1.post('/poker/actionlogs/store/1/20-1000', { logs : [{ action : 'clear' }], type : 'm' });
	assert.equal(res.status, 200);
	const al = await db.poker.collection('action_logs').findOne({ user_id : 1, table_id : 1, round_num : rn1, type : 'm' });
	assert.deepEqual(al.actions, [{ action : 'clear' }]);
	const alr = await db.poker.collection('action_logs').findOne({ user_id : 1, table_id : 1, round_num : rn1, type : 'r' });
	assert.ok(alr.actions.length >= 3, 'store appended its logs');
	res = await p1.post('/poker/bet/setFoldCheck/9');
	assert.equal(res.text, '', 'no round / bet: empty answer');
	step('settings, setGameSettings, videoSetting (page reflects them), checkTable, getDealerImg, actionlogs, empty setFoldCheck');

	d1.close();
	d2.close();
	console.log('\nPOKER FRONT CHECK PASSED');
}

main()
	.then(() => 0, e => {
		console.log('\nPOKER FRONT CHECK FAILED');
		console.log(e);
		return 1;
	})
	.then(async code => {
		vendorStub.close();
		if (conn) await conn.close().catch(() => {});
		process.exit(code);
	});
