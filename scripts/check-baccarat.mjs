/*
 |--------------------------------------------------------------------------
 | check-baccarat
 |--------------------------------------------------------------------------
 | End-to-end check of the baccarat port against a running Next server, a
 | running baccarat game-server and MongoDB:
 |
 |  1. dev login, game page (desktop + mobile UA), every page asset;
 |  2. as the dealer (socket.io to the game server) a new round; as players
 |     bets through POST /bet/store with the compiled scripts' payload:
 |     user 1 (transfer vendor, users.money) and user 3 (seamless vendor,
 |     served by a stub vendor API started here; the Next server must run
 |     with API_URL=http://127.0.0.1:<STUB_PORT>); re-post, cancel, re-bet,
 |     refusals (balance, side game, closed round);
 |  3. setroundprogress, cards, displayresults: the game server settles the
 |     stored bets (total_win, users.money);
 |  4. history / logs / settings endpoints and their response shapes.
 |
 |   MONGO_URI=... MONGO_SHARED_DB=... BACCARAT_DB=... \
 |   BASE_URL=http://localhost:3102 GAME_SERVER_URL=http://127.0.0.1:18207 \
 |   node scripts/check-baccarat.mjs
 |
 | socket.io-client is taken from the game-server checkout
 | (GAME_SERVER_DIR, default ../backend/game-server).
 |
 */

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import mongoose from 'mongoose';

const env = process.env;
const BASE = (env.BASE_URL || 'http://localhost:3102').replace(/\/$/, '');
const GAME_SERVER = env.GAME_SERVER_URL || 'http://127.0.0.1:18207';
const STUB_PORT = parseInt(env.STUB_PORT || '18298');
const TABLE = parseInt(env.TABLE || '1');
const GAME_SERVER_DIR = env.GAME_SERVER_DIR || path.resolve(process.cwd(), '../backend/game-server');
const { io } = createRequire(path.join(GAME_SERVER_DIR, 'package.json'))('socket.io-client');

const PAGE = `${BASE}/baccarat/${TABLE}`;
// referenced by the legacy views but never part of the Laravel app's public/ (404 there as well)
const KNOWN_MISSING = ['/baccarat/img/bg.png', '/baccarat/fonts/BebasNeue.eot', '/baccarat/fonts/BebasNeueRegular.eot',
	'/baccarat/img/howtoplay/dark/card_display_mb.png'];
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let failures = 0;
const step = name => console.log(`\n== ${name}`);
const ok = msg => console.log(`  ok  ${msg}`);
const warn = msg => console.log(`  !!  ${msg}`);

// ------------------------------------------------------------------ stub seamless vendor API

const stub = { balance : 5000, refuse : false, calls : [] };
const stubServer = createServer((req, res) => {
	let body = '';
	req.on('data', c => body += c);
	req.on('end', () => {
		const url = new URL(req.url, 'http://stub');
		const expected = createHmac('sha256', '').update(body).digest('hex');  // demo vendor has no secret_key
		const data = body ? JSON.parse(body) : {};
		stub.calls.push({ path : url.pathname, data, hashOk : url.searchParams.get('hash') === expected });
		res.setHeader('content-type', 'application/json');
		if (url.pathname === '/api/check') return res.end(String(stub.balance));
		const m = /^\/api\/transact\/(\w+)\/(bet|cancel)$/.exec(url.pathname);
		if (m) {
			if (stub.refuse) return res.end(JSON.stringify({ status : 'error' }));
			stub.balance += (m[2] === 'bet' ? -1 : 1) * Number(data.amount);
			return res.end(JSON.stringify({ status : 'ok' }));
		}
		res.statusCode = 404;
		res.end('{}');
	});
});

// ------------------------------------------------------------------ http helpers

async function login (uid) {
	const res = await fetch(`${BASE}/login`, {
		method   : 'POST',
		headers  : { 'content-type' : 'application/x-www-form-urlencoded' },
		body     : `uid=${uid}&locale=en`,
		redirect : 'manual'
	});
	assert.equal(res.status, 303, `login ${uid}`);
	const cookie = res.headers.get('set-cookie').split(';')[0];
	return cookie;
}

// jQuery.param(): nested objects / arrays as a[0][b]=c
function jqParam (obj, prefix = '') {
	const out = [];
	for (const [k, v] of Object.entries(obj)) {
		const key = prefix ? `${prefix}[${k}]` : k;
		if (v !== null && typeof v === 'object') out.push(jqParam(v, key));
		else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v ?? '')}`);
	}
	return out.filter(Boolean).join('&');
}

/** $.post(url, data) from the game page: root-relative url, resolved by the Referer */
async function post (cookie, url, data = {}, { raw = false } = {}) {
	const res = await fetch(`${BASE}${url}`, {
		method  : 'POST',
		headers : {
			cookie,
			referer            : PAGE,
			'content-type'     : 'application/x-www-form-urlencoded; charset=UTF-8',
			'x-requested-with' : 'XMLHttpRequest'
		},
		body : jqParam(data)
	});
	const text = await res.text();
	assert.equal(res.status, 200, `${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
	if (raw) return { text, type : res.headers.get('content-type') || '' };
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

// ------------------------------------------------------------------ db

const conn = mongoose.createConnection(env.MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true');
const sharedDb = () => conn.useDb(env.MONGO_SHARED_DB || 'nihtan_api').db;
const gameDb = () => conn.useDb(env.BACCARAT_DB || 'baccarat').db;
const money = async uid => (await sharedDb().collection('users').findOne({ _id : uid })).money;
const betOf = (roundId, uid) => gameDb().collection('bets').findOne({ round_id : roundId, user_id : uid });

// ------------------------------------------------------------------ steps

async function checkPage (cookie, ua, label) {
	const res = await fetch(PAGE, { headers : { cookie, 'user-agent' : ua } });
	const html = await res.text();
	assert.equal(res.status, 200, `${label} page HTTP ${res.status}`);
	assert.ok(!/\{\{|\{!!|@if\(|@endif/.test(html.replace(/<!--[\s\S]*?-->/g, '')), `${label}: unrendered template syntax`);

	const win = {};
	for (const m of html.matchAll(/window\.(\w+)\s*=\s*([^;\n]*)/g)) win[m[1]] ??= m[2].trim();
	assert.equal(win.socket, '\'http://localhost:8000\'', 'window.socket');
	assert.equal(win.bc_domain, `'${BASE}/baccarat/'`, 'window.bc_domain');
	assert.equal(win.dt_domain, `'${BASE}/dragon-tiger/'`, 'window.dt_domain');
	assert.equal(win.lobby_domain, `'${BASE}/'`, 'window.lobby_domain');
	assert.match(win.tableNum, new RegExp(`^${TABLE}`), 'window.tableNum');
	assert.match(win.range, /^'\d+-\d+'$/, 'window.range');
	assert.match(win.rangeDetails, /^\{"max":/, 'window.rangeDetails');
	for (const k of ['currencyMultiplier', 'mainMultiplier', 'userMultiplier', 'round_id', 'userId', 'room_yn', 'vendor_id', 'junket']) {
		if (win[k] === undefined) continue;
		assert.match(win[k], /^-?\d+(\.\d+)?$/, `window.${k} = ${win[k]}`);
	}
	for (const k of ['user_chips', 'gameInfo', 'vendorData', 'agent_range', 'allRange']) {
		if (win[k] !== undefined) JSON.parse(win[k]);
	}
	// every inline script must at least parse
	for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
		try {
			new Function(m[1]);
		} catch (e) {
			assert.fail(`${label}: inline script does not parse: ${e.message}\n${m[1].slice(0, 300)}`);
		}
	}
	ok(`${label}: page renders, window.* config sane (range ${win.range}, round ${win.round_id})`);

	const assets = new Set();
	const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
	for (const m of noComments.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#][^"']*)["']/g)) assets.add(m[1]);
	for (const m of noComments.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) assets.add(m[1]);
	const missing = [];
	for (const url of assets) {
		if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
		const r = await fetch(new URL(url, PAGE), { headers : { cookie, referer : PAGE } });
		if (r.status !== 200 && !KNOWN_MISSING.includes(url.split('?')[0])) missing.push(`${r.status} ${url}`);
		await r.arrayBuffer();
	}
	if (missing.length) {
		warn(`${label}: ${missing.length}/${assets.size} assets not served:\n      ${missing.join('\n      ')}`);
		failures++;
	} else {
		ok(`${label}: all ${assets.size} assets 200 (besides ${KNOWN_MISSING.length} files missing in the legacy app too)`);
	}
	return win;
}

async function main () {
	await new Promise(r => stubServer.listen(STUB_PORT, '127.0.0.1', r));
	await conn.asPromise();

	step('login + game page');
	const c1 = await login(1);
	const c3 = await login(3);
	const win = await checkPage(c1, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', 'desktop');
	await checkPage(c1, MOBILE_UA, 'mobile');
	const range = win.range.replace(/'/g, '');
	for (const [url, marker] of [[`/baccarat/${TABLE}/m`, 'menu-mobile'], [`/baccarat/m/${TABLE}`, 'menu-mobile'],
		[`/baccarat/non/Baccarat/${TABLE}/${range}/0`, 'window.nonInstall = 1'], [`/baccarat/${TABLE}/${range}`, 'window.agent_range']]) {
		const r = await fetch(`${BASE}${url}`, { headers : { cookie : c1 } });
		const html = await r.text();
		assert.equal(r.status, 200, url);
		assert.ok(html.includes(marker), `${url} shows ${marker}`);
	}
	const anon = await fetch(PAGE, { redirect : 'manual' });
	assert.equal(anon.status, 302, 'guest is sent to the login');
	ok('/{table}/m, /m/{table}, /non/Baccarat/..., /{table}/{range}; guests redirected');
	const rejected = await fetch(`${BASE}/rejected`, { headers : { cookie : c1, referer : PAGE } });
	assert.equal(rejected.status, 200);
	ok('/rejected renders');

	step('dealer: new round');
	const socket = io(GAME_SERVER, { transports : ['websocket'], reconnection : false });
	await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
	const push = (event, data) => socket.timeout(8000).emitWithAck('push', { event, data });
	const row = await push('init', TABLE);
	assert.ok(row && row.table === TABLE, 'dealer init');
	if (row.status === 'P' || row.status === 'S') {
		// an unfinished round from an earlier run: close it
		await push('setroundprogress');
		for (const [from, value] of [['player1', '0003'], ['banker1', '0001'], ['player2', '0016'], ['banker2', '0012']]) await push('inputitem', { from, value });
		await push('displayresults');
	}
	const round = await push('newround', { roundNum : (await push('init', TABLE)).roundNum });
	assert.equal(typeof round.id, 'number');
	ok(`round ${round.round_num} (id ${round.id}) open`);

	const store = (cookie, bets, extra = {}) => post(cookie, `/bet/store/${TABLE}/${range}`, {
		data     : bets.map(([table_id, amount]) => ({ amount, table_id, dividend : 1 })),
		round_id : round.round_num,
		logs     : [{ action : 'confirm', comment : `total, ${bets.reduce((s, b) => s + b[1], 0)}`, user_money : 0 }],
		type     : 'r',
		slave    : 'r',
		roomId   : null,
		range,
		balance_bet : 0,
		device   : 'w',
		...extra
	});
	const cancel = cookie => post(cookie, `/bet/cancel/${TABLE}/${range}`, {
		logs : [{ action : 'clear' }], slave : 'normal', data : [], range, balance_bet : 0, device : 'w'
	});

	let res;
	step('junket room + balance bet (users 1 and 2)');
	const c2 = await login(2);
	const token = `chk${Date.now()}`;
	const roomsCol = gameDb().collection('rooms');
	await roomsCol.insertOne({ _id : 900001, table_id : TABLE, token, user_id : 2, title : 'Check room', bet_range : range, password : '', players_cnt : 2, status : '1' });
	try {
		const jr = await fetch(`${BASE}/baccarat/${TABLE}/j?token=${token}`, { headers : { cookie : c1 } });
		const jhtml = await jr.text();
		assert.equal(jr.status, 200);
		const vd = JSON.parse(/window\.vendorData = (.*);/.exec(jhtml)[1]);
		assert.equal(vd.roomId, 900001);
		assert.equal(vd.bankerUsername, 'Player Two');
		assert.ok(jhtml.includes('balance-info'), 'balance bet panel');
		const bad = await fetch(`${BASE}/baccarat/${TABLE}/j?token=nope`, { headers : { cookie : c1 }, redirect : 'manual' });
		assert.equal(bad.status, 302);

		const jm1 = await money(1);
		const jbet = (cookie, area, amount, balance) => post(cookie, `/bet/store/${TABLE}/${range}`, {
			data : [{ amount, table_id : area }], round_id : round.round_num, logs : [], type : 'r', slave : 'r', roomId : 900001, range, balance_bet : balance, device : 'w'
		});
		const jcancel = (cookie, balance) => post(cookie, `/bet/cancel/${TABLE}/${range}`, { logs : [], slave : 'normal', range, balance_bet : balance, room_id : 900001 });
		res = await jbet(c1, 'player', 100, 50);
		assert.equal(res.fail, 3, 'unbalanced room refused');
		assert.equal(await money(1), jm1);
		res = await jbet(c1, 'player', 100, 500);
		assert.equal(res.fail, 0);
		res = await jbet(c2, 'banker', 100, 500);
		assert.equal(res.fail, 0);
		assert.deepEqual((await post(c1, '/getJunket/900001')).map(r => [r.user_id, r.total_bet]), [[1, 100], [2, 100]]);
		res = await jcancel(c1, 50);
		assert.equal(res.status, 0);
		assert.equal(res.balance, true, 'cancel would unbalance the room');
		res = await jcancel(c1, 500);
		assert.equal(res.status, 1);
		res = await jcancel(c2, 500);
		assert.equal(res.status, 1);
		assert.equal(await money(1), jm1);
		ok('room page (vendorData), refused unbalanced bet (fail 3) and cancel (balance), payout list');
	} finally {
		await roomsCol.deleteOne({ _id : 900001 });
	}

	step('transfer player (user 1)');
	const m0 = await money(1);
	res = await store(c1, [['player', 100], ['playerpair', 10]]);
	assert.equal(res.fail, 0, JSON.stringify(res));
	assert.equal(typeof res.data, 'string', 'success data is the bet_history JSON text');
	assert.deepEqual(JSON.parse(res.data).map(r => [r.bet, r.bet_money]), [['player', 100], ['playerpair', 10]]);
	assert.equal(await money(1), m0 - 110);
	assert.equal(Number(res.money), m0 - 110);
	let bet = await betOf(round.id, 1);
	assert.equal(bet.type, 'r');
	assert.equal(bet.total_bet, 110);
	assert.equal(bet.bet_range, range);
	assert.equal(bet.currency, 'USD');
	assert.equal(bet.user_id, 1);
	assert.equal(typeof bet._id, 'number');
	assert.match(bet.bet_id, /^[0-9a-f]{32}$/);
	assert.ok(Array.isArray(bet.bet_history) && bet.bet_history[0].win_money === 0);
	ok(`stored bet ${bet._id}, money ${m0} -> ${m0 - 110}`);

	res = await store(c1, [['player', 100], ['playerpair', 10]]);
	assert.equal(res.fail, 0);
	assert.equal(await money(1), m0 - 110, 'same bet posted again: no second debit');
	ok('re-post is not debited twice');

	res = await cancel(c1);
	assert.equal(res.status, 1, JSON.stringify(res));
	assert.equal(await money(1), m0);
	assert.equal(await betOf(round.id, 1), null);
	res = await cancel(c1);
	assert.equal(res.status, 1);
	assert.equal(await money(1), m0, 'second cancel refunds nothing');
	ok('cancel refunds and removes the bet (twice is harmless)');

	res = await store(c1, [['player', 100], ['playerpair', 10]]);
	assert.equal(res.fail, 0);
	res = await store(c1, [['player', 0], ['playerpair', 10], ['tie', 20]]);
	assert.equal(res.fail, 0);
	assert.equal((await betOf(round.id, 1)).total_bet, 130, 'amount 0 keeps the confirmed player bet');
	assert.equal(await money(1), m0 - 130);
	ok('re-bet + added tie: stake 130, debited once');

	const same = await Promise.all(Array.from({ length : 6 }, () => store(c1, [['player', 100], ['playerpair', 10], ['tie', 20]])));
	assert.ok(same.every(r => r.fail === 0));
	assert.equal(await money(1), m0 - 130, 'parallel identical posts: no extra debit');
	await Promise.all([30, 40, 50, 60].map(t => store(c1, [['player', 100], ['playerpair', 10], ['tie', t]])));
	const raced = await betOf(round.id, 1);
	assert.equal(await money(1), m0 - raced.total_bet, `parallel different posts: money matches the stored stake (${raced.total_bet})`);
	assert.equal(await gameDb().collection('bets').countDocuments({ round_id : round.id, user_id : 1 }), 1, 'one bet document');
	res = await store(c1, [['player', 100], ['playerpair', 10], ['tie', 20]]);
	assert.equal(res.fail, 0);
	assert.equal(await money(1), m0 - 130);
	ok('parallel posts serialised: stake and money stay consistent, one bet document');

	res = await store(c1, [['player', 100], ['playerpair', 10], ['tie', 1e9]]);
	assert.equal(res.fail, 1);
	assert.equal(res.data.length, 3, 'refusal returns the previous bets');
	assert.equal(await money(1), m0 - 130);
	res = await store(c1, [['supersix', 10]]);
	assert.equal(res.fail, 1);
	res = await store(c1, [['player', 10]], { slave : 'i' });
	assert.equal(res.fail, 1);
	assert.equal((await betOf(round.id, 1)).total_bet, 130);
	ok('refused: insufficient balance, area of another side game, insurance');

	step('seamless player (user 3, stub vendor API)');
	const db3 = await money(3);
	res = await store(c3, [['player', 50], ['banker', 200]]);
	assert.equal(res.fail, 0, JSON.stringify(res));
	assert.equal(stub.balance, 4750);
	assert.equal(Number(res.money), 4750);
	assert.equal(await money(3), db3, 'seamless users.money untouched');
	const bet3 = await betOf(round.id, 3);
	assert.equal(bet3.total_bet, 250);
	const tx = stub.calls.find(c => c.path === '/api/transact/baccarat/bet');
	assert.ok(tx && tx.hashOk, 'signed vendor debit');
	assert.equal(tx.data.amount, '250');
	assert.equal(tx.data.bet_id, bet3.bet_id);
	stub.refuse = true;
	res = await store(c3, [['player', 50], ['banker', 300]]);
	assert.equal(res.fail, 1);
	assert.equal((await betOf(round.id, 3)).total_bet, 250, 'vendor refused: previous bet restored');
	res = await cancel(c3);
	assert.equal(res.status, 0, 'vendor refused the refund');
	assert.equal((await betOf(round.id, 3)).total_bet, 250, 'bet kept when the vendor keeps the stake');
	stub.refuse = false;
	res = await cancel(c3);
	assert.equal(res.status, 1);
	assert.equal(stub.balance, 5000);
	assert.equal(await betOf(round.id, 3), null);
	res = await store(c3, [['player', 50], ['banker', 200]]);
	assert.equal(res.fail, 0);
	assert.equal(stub.balance, 4750);
	ok('seamless debit / refund through the vendor API, refused debit and refund rolled back');

	step('betting closed');
	assert.equal(await push('setroundprogress'), 'P');
	res = await store(c1, [['player', 100], ['playerpair', 10], ['tie', 30]]);
	assert.equal(res.fail, 1);
	res = await cancel(c1);
	assert.equal(res.status, 0);
	assert.equal((await betOf(round.id, 1)).total_bet, 130);
	assert.equal(await money(1), m0 - 130);
	ok('no store / cancel after setroundprogress');

	step('cards + displayresults: game-server settlement');
	// player 4+4 = 8 (natural, player pair) vs banker 2+K = 2
	for (const [from, value] of [['player1', '0003'], ['banker1', '0001'], ['player2', '0016'], ['banker2', '0012']]) {
		const r = await push('inputitem', { from, value });
		assert.equal(r.gameInfo[from], value);
	}
	const result = await push('displayresults');
	assert.equal(result.winner, 'player');
	bet = await betOf(round.id, 1);
	// player 100 -> 200, player pair 10 x11 -> 120, tie lost
	assert.equal(bet.total_win, 320);
	assert.equal(bet.total_winning, 210);
	assert.equal(bet.total_lost, 20);
	assert.equal(await money(1), m0 - 130 + 320);
	const settled3 = await betOf(round.id, 3);
	assert.equal(settled3.total_win, 100);
	assert.equal(await money(3), db3);
	ok(`settled: user 1 total_win 320, money ${m0} -> ${m0 + 190}; user 3 total_win 100 (vendor credits)`);

	step('result / history / settings endpoints');
	res = await post(c1, `/get/winAll/${TABLE}`, { round_id : round.id });
	assert.deepEqual({ ...res, user_money : Number(res.user_money) }, { total_win : 320, bet : 130, user_money : m0 + 190, slave : 'normal' });
	assert.deepEqual(await post(c1, '/get/totalBet', { round_id : round.id }), [130]);
	assert.deepEqual(await post(c1, '/get/totalWin', { round_id : round.id }), [210]);
	const user = await post(c1, '/get/user', {}, { raw : true });
	assert.equal(JSON.parse(user.text).money, m0 + 190);
	assert.equal(JSON.parse(user.text).id, 1);
	assert.equal(JSON.parse(user.text).password, undefined);
	ok('get/winAll, get/totalBet, get/totalWin, get/user');

	const logs = await post(c1, `/${TABLE}/${range}/0/betlogs`, { tableId : TABLE, betPage : 1, gameType : 'L', roundNum : 0, playType : 'p', userId : 3, roomId : '' });
	assert.ok(Array.isArray(logs) && logs.length >= 1);
	assert.equal(logs[0].round_num, round.round_num);
	assert.equal(logs[0].total_bet, 130);
	assert.equal(logs[0].total_win, 190, 'net win/lose');
	assert.equal(logs[0].dealer_name !== undefined, true);
	assert.ok(Number(logs[0].cnt) >= 1);
	assert.equal(JSON.parse(logs[0].game_result).winner, 'player');
	assert.ok(JSON.parse(logs[0].game_info).player1);
	assert.match(logs[0].updated_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
	const detail = await post(c1, `/${TABLE}/${range}/0/betlogs`, { roundNum : round.round_num, tableId : TABLE, page : 0, gameType : 'D', playType : 'p', userId : 1, roomId : '' });
	assert.equal(detail.length, 1);
	assert.equal(JSON.parse(detail[0].bet_history).length, 3);
	ok('betlogs (list + detail, userId of another player ignored)');

	const details = await post(c1, '/details/getDetails', { round : round.id, tableId : TABLE, slave : 'false' });
	assert.equal(details.length, 1);
	assert.equal(JSON.parse(details[0].bet_history)[0].bet, 'player');
	assert.equal(JSON.parse(details[0].game_result).winner, 'player');
	ok('details/getDetails');

	const history = await post(c1, `/${TABLE}/${range}/0/gamehistory`, { tableId : TABLE });
	assert.equal(typeof history, 'object');
	for (const k of ['total', 'per_page', 'current_page', 'last_page', 'next_page_url', 'prev_page_url', 'from', 'to', 'data']) assert.ok(k in history, `gamehistory.${k}`);
	const mobileLogs = await post(c1, `/m/Baccarat/${TABLE}/${range}/0/betlogsM`, { tableId : TABLE, slave : 'r' });
	assert.ok(mobileLogs.data.some(r => r.round_num === round.round_num && typeof r.game_info === 'string'));
	const transfer = await post(c1, `/${TABLE}/${range}/0/transferlogs`, {});
	assert.ok(Array.isArray(transfer.data));
	ok(`gamehistory (${history.total} rounds), betlogsM, transferlogs: Laravel paginator JSON`);

	await post(c1, '/settings', { volume : '0.5', chips : ['1', '10', '50', '100', 'max'] });
	await post(c1, '/settings/videoSetting', { type : 'SD' });
	await post(c1, '/setGameSettings', { range, game : `Baccarat/${TABLE}`, slave : 'bonus', multiplayer : 1 });
	const u1 = await sharedDb().collection('users').findOne({ _id : 1 });
	assert.equal(u1.configs.avarta.sound.volum, '0.5');
	assert.deepEqual(u1.configs.avarta.chips, ['1', '10', '50', '100', 'max']);
	assert.equal(u1.configs.avarta.video, 'SD');
	assert.deepEqual(u1.last_game_info, { game : `Baccarat/${TABLE}`, bet_range : range, slave : 'bonus', multi_yn : '1' });
	const page2 = await (await fetch(PAGE, { headers : { cookie : c1 } })).text();
	assert.match(page2, /window\.user_chips = \["1","10","50","100","max"\]/);
	assert.match(page2, /window\.multiplayer = '1'/);
	assert.match(page2, /window\.slave = 'bonus'/);
	await post(c1, '/setGameSettings', { range, game : `Baccarat/${TABLE}`, slave : 'classic', multiplayer : 0 });
	ok('settings, videoSetting, setGameSettings persisted and shown on the page');

	assert.equal(await post(c1, `/actionlogs/store/${TABLE}/${range}`, { logs : [{ action : 'chip', comment : 'x' }], type : 'r' }), '');
	const alog = await gameDb().collection('action_logs').findOne({ user_id : 1, table_id : TABLE, round_num : round.round_num, type : 'r' });
	assert.ok(alog.actions.some(x => x.action === 'chip') && alog.actions.some(x => x.action === 'confirm'));
	assert.equal(await post(c1, '/bet/delete'), 1);
	const img = await post(c1, '/getDealerImg', { dealerId : 1 });
	assert.deepEqual(Object.keys(img[0]).sort(), ['dealer_image', 'id']);
	const jt = await post(c1, '/checkTable', { vendorId : 1 });
	assert.deepEqual(JSON.parse(jt[0].junket_table), { disable_table : [], created_room : [] });
	assert.equal(await post(c1, '/checkPassword', { password : 'abcd' }), createHash('sha256').update('abcd').digest('hex'));
	assert.equal(await post(c1, '/get/users', { vendor_name : 'demo-transfer', users : [1, 2] }, { raw : true }).then(r => JSON.parse(r.text).length), 2);
	assert.deepEqual(await post(c1, '/getJunket/999'), []);
	ok('actionlogs, bet/delete, getDealerImg, checkTable, checkPassword, get/users, getJunket');

	for (const url of [`/baccarat/dragontiger/bet/store/${TABLE}/${range}`, `/baccarat/poker/bet/store/${TABLE}/${range}`]) {
		const r = await fetch(`${BASE}${url}`, { method : 'POST', headers : { cookie : c1, 'content-type' : 'application/x-www-form-urlencoded' }, body : 'range=' + range });
		(r.status === 200 ? ok : warn)(`${url} -> HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
	}

	socket.close();
}

main()
	.then(() => {
		if (failures) process.exitCode = 1;
		console.log(failures ? `\ncheck-baccarat: FAIL (${failures} asset problem(s))` : '\ncheck-baccarat: PASS');
	})
	.catch(e => {
		console.log('\ncheck-baccarat: FAIL\n', e);
		process.exitCode = 1;
	})
	.finally(async () => {
		stubServer.close();
		await conn.close();
		setTimeout(() => process.exit(process.exitCode || 0), 100).unref();
	});
