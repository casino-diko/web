/*
 |--------------------------------------------------------------------------
 | check-dragon-tiger
 |--------------------------------------------------------------------------
 | End-to-end check of the ported Dragon-Tiger endpoints against a running
 | front (next dev) + game-server + MongoDB, with demo data from
 | `npm run seed` (users 1/2 transfer vendor, user 3 seamless vendor).
 |
 |  - a stub vendor wallet API (seamless vendor) listens on API_STUB_PORT;
 |    start the front with API_URL=http://127.0.0.1:<API_STUB_PORT>
 |  - acts as the dealer page over socket.io (protocol: backend/game-server/scripts/smoke-dragontiger.js)
 |  - players bet through POST /dragon-tiger/bet/store/{table}/{range} with the
 |    jQuery form payload of screens/dragon_tiger/dragon-tiger.js
 |  - checks debits, bet documents, cancel / re-bet, round guards, settlement
 |    by the game-server, history / settings endpoints and a direct call of the
 |    exported testStore from a /baccarat/dragontiger/... url
 |
 |   FRONT=http://localhost:3103 GAME_SERVER=http://127.0.0.1:18308 \
 |   MONGO_URI=... MONGO_SHARED_DB=... DRAGONTIGER_DB=... SESSION_SECRET=... \
 |   GAME_SERVER_DIR=../backend/game-server node scripts/check-dragon-tiger.mjs
 |
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONT = process.env.FRONT || 'http://localhost:3103';
const GAME_SERVER = process.env.GAME_SERVER || 'http://127.0.0.1:18308';
const API_STUB_PORT = parseInt(process.env.API_STUB_PORT || 18399);
const TABLE = parseInt(process.env.CHECK_TABLE || 1);
const RANGE = '10-1000';
const GS_DIR = path.resolve(ROOT, process.env.GAME_SERVER_DIR || '../backend/game-server');
const { io } = createRequire(path.join(GS_DIR, 'package.json'))('socket.io-client');

let step = 0;
const ok = msg => console.log(`  ok ${++step}. ${msg}`);

// ------------------------------------------------------------------ stub vendor API (seamless wallet)

const wallet = new Map();       // user_id -> balance
const apiCalls = [];
let apiFail = false;

const stub = http.createServer((req, res) => {
	let raw = '';
	req.on('data', c => { raw += c; });
	req.on('end', () => {
		const url = new URL(req.url, 'http://x');
		const body = JSON.parse(raw || '{}');
		// lib/vendor.ts signs the raw body with the vendor secret (seed: none)
		assert.equal(url.searchParams.get('hash'), createHmac('sha256', '').update(raw).digest('hex'), 'signed body');
		apiCalls.push({ path : url.pathname, body });
		const send = v => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };

		if (!wallet.has(body.user_id)) wallet.set(body.user_id, 5000);
		if (url.pathname === '/api/check') return send(wallet.get(body.user_id));
		const m = /^\/api\/transact\/dragon-tiger\/(bet|cancel)$/.exec(url.pathname);
		if (!m) { res.statusCode = 404; return res.end('?'); }
		if (apiFail) return send({ status : 'error' });
		const amount = Number(body.amount);
		if (m[1] === 'bet') {
			if (amount > wallet.get(body.user_id)) return send({ status : 'error', message : 'insufficient' });
			wallet.set(body.user_id, wallet.get(body.user_id) - amount);
		} else {
			wallet.set(body.user_id, wallet.get(body.user_id) + amount);
		}
		send({ status : 'ok' });
	});
});

// ------------------------------------------------------------------ http helpers

async function login (uid) {
	const res = await fetch(`${FRONT}/login`, { method : 'POST', body : new URLSearchParams({ uid, locale : 'en' }), redirect : 'manual' });
	assert.equal(res.status, 303, `login ${uid}`);
	return res.headers.get('set-cookie').split(';')[0];
}

/** jQuery.param() of nested objects / arrays (what $.post sends) */
function jqParam (obj) {
	const out = [];
	const add = (key, v) => {
		if (Array.isArray(v)) v.forEach((x, i) => add(`${key}[${typeof x === 'object' && x !== null ? i : ''}]`, x));
		else if (v !== null && typeof v === 'object') Object.entries(v).forEach(([k, x]) => add(`${key}[${k}]`, x));
		else out.push([key, v === null || v === undefined ? '' : String(v)]);
	};
	Object.entries(obj).forEach(([k, v]) => add(k, v));
	return new URLSearchParams(out).toString();
}

const page = `${FRONT}/dragon-tiger/${TABLE}`;

async function post (cookie, url, data = {}, { raw = false, method = 'POST' } = {}) {
	// legacy pages call root-relative urls; middleware.ts maps them into the page's app by the Referer
	const res = await fetch(`${FRONT}${url}${method === 'GET' && Object.keys(data).length ? '?' + jqParam(data) : ''}`, {
		method,
		headers : {
			cookie,
			referer            : page,
			'x-requested-with' : 'XMLHttpRequest',
			...(method === 'POST' ? { 'content-type' : 'application/x-www-form-urlencoded; charset=UTF-8' } : {})
		},
		body : method === 'POST' ? jqParam(data) : undefined
	});
	const text = await res.text();
	assert.equal(res.status, 200, `${url}: ${res.status} ${text.slice(0, 300)}`);
	if (raw) return text;
	try { return JSON.parse(text); } catch { return text; }
}

// ------------------------------------------------------------------ dealer

let socket;
const push = payload => socket.timeout(8000).emitWithAck('push', payload);

// ------------------------------------------------------------------ db

const shared = () => mongoose.connection.useDb(process.env.MONGO_SHARED_DB || 'nihtan_api', { useCache : true }).db;
const dt = () => mongoose.connection.useDb(process.env.DRAGONTIGER_DB || 'dragontiger', { useCache : true }).db;
const money = async id => (await shared().collection('users').findOne({ _id : id })).money;
const betsOf = (roundId, userId) => dt().collection('bets').find({ round_id : roundId, user_id : userId }).toArray();

// the confirm payload of screens/dragon_tiger/dragon-tiger.js actionCallback('confirm')
const confirmPayload = (roundNum, yourBets, extra = {}) => ({
	data     : yourBets.map(([table_id, amount]) => ({ amount, table_id, dividend : 1 })),
	round_id : roundNum,
	device   : 'w',
	logs     : [{ action : 'confirm', comment : `total, ${yourBets.reduce((s, b) => s + b[1], 0)}`, timeDate : '10/31/2026 10:00:00' }],
	type     : 'r',
	roomId   : null,
	range    : RANGE,
	...extra
});
const cancelPayload = yourBets => ({
	logs   : [{ action : 'clear', comment : 'clear' }],
	data   : yourBets.map(([table_id, amount]) => ({ amount, table_id, dividend : 1 })),
	range  : RANGE,
	device : 'w'
});
const store = (cookie, roundNum, bets, extra) => post(cookie, `/bet/store/${TABLE}/${RANGE}`, confirmPayload(roundNum, bets, extra));
const cancel = (cookie, bets) => post(cookie, `/bet/cancel/${TABLE}/${RANGE}`, cancelPayload(bets));

// ------------------------------------------------------------------ main

async function main () {
	await new Promise(resolve => stub.listen(API_STUB_PORT, '127.0.0.1', resolve));
	await mongoose.connect(process.env.MONGO_URI);
	ok(`stub vendor API on :${API_STUB_PORT}, mongo connected`);

	const [c1, c2, c3] = [await login(1), await login(2), await login(3)];
	ok('dev login users 1 (transfer), 2 (transfer), 3 (seamless)');

	// ---------------------------------------------------------- dealer starts a round
	socket = io(GAME_SERVER, { transports : ['websocket'] });
	await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
	const init = await push({ event : 'init', data : TABLE });
	assert.ok(init && init.roundId, 'dealer init');
	assert.equal(init.status, 'E', 'table must be idle (latest round resulted)');
	const roundNum = await push({ event : 'newround', roundNum : init.roundNum });
	assert.equal(roundNum, init.roundNum + 1);
	const round = await dt().collection('rounds').find({ table_id : TABLE }).sort({ _id : -1 }).limit(1).next();
	assert.equal(round.status, 'S');
	ok(`dealer: newround #${roundNum} (_id ${round._id}) on table ${TABLE}`);

	// ---------------------------------------------------------- user 1 (transfer) bets
	const m1 = await money(1);
	let r = await store(c1, roundNum, [['dragon', 100], ['dragon_big', 50]]);
	assert.equal(r.fail, 0, JSON.stringify(r));
	assert.equal(typeof r.data, 'string', 'success data is the json_encoded bet_history');
	assert.deepEqual(JSON.parse(r.data).map(b => [b.bet, b.bet_money, b.win_money]), [['dragon', 100, 0], ['dragon_big', 50, 0]]);
	assert.equal(r.money, m1 - 150);
	assert.equal(await money(1), m1 - 150);
	let docs = await betsOf(round._id, 1);
	assert.equal(docs.length, 1);
	let b = docs[0];
	assert.ok(Number.isInteger(b._id), 'numeric _id');
	assert.equal(b.total_bet, 150);
	assert.equal(b.type, 'r');
	assert.equal(b.bet_range, RANGE);
	assert.equal(b.currency, 'USD');
	assert.equal(b.device, 'w');
	assert.match(b.bet_id, /^[0-9a-f]{32}$/);
	assert.deepEqual(b.bet_history, [
		{ bet : 'dragon', bet_money : 100, win_money : 0, user_money : m1 },
		{ bet : 'dragon_big', bet_money : 50, win_money : 0, user_money : m1 - 100 }
	]);
	ok(`user 1 bet 150 -> fail 0, money ${m1} -> ${r.money}, bet doc #${b._id} (bet_history native, numbers)`);

	r = await store(c1, roundNum, [['dragon', 100], ['dragon_big', 50]]);
	assert.equal(r.fail, 0);
	assert.equal(await money(1), m1 - 150, 'retry does not debit again');
	assert.equal((await betsOf(round._id, 1)).length, 1);
	ok('same confirm retried: no second debit, still one bet doc');

	// double click: two confirms at once
	const both = await Promise.all([
		store(c1, roundNum, [['dragon', 100], ['dragon_big', 50], ['tie', 10]]),
		store(c1, roundNum, [['dragon', 100], ['dragon_big', 50], ['tie', 10]])
	]);
	assert.ok(both.every(x => x.fail === 0));
	assert.equal(await money(1), m1 - 160);
	assert.equal((await betsOf(round._id, 1)).length, 1);
	ok('concurrent identical confirms adding tie 10: debited 10 once, one bet doc');

	r = await cancel(c1, [['dragon', 100], ['dragon_big', 50], ['tie', 10]]);
	assert.equal(r.status, 1);
	assert.equal(r.money, m1);
	assert.equal(await money(1), m1);
	assert.equal((await betsOf(round._id, 1)).length, 0);
	r = await cancel(c1, []);
	assert.equal(r.status, 1, 'cancel without a bet');
	assert.equal(await money(1), m1);
	ok('cancel: status 1, 160 refunded, bet doc deleted; second cancel is a no-op');

	r = await store(c1, roundNum, [['dragon', 100], ['dragon_big', 50], ['tie', 10]]);
	assert.equal(r.fail, 0);
	assert.equal(await money(1), m1 - 160);
	ok('re-bet 160 after cancel');

	// ---------------------------------------------------------- refusals
	const m2 = await money(2);
	r = await store(c2, roundNum, [['tiger', m2 + 1]]);
	assert.equal(r.fail, 1);
	assert.deepEqual(r.data, []);
	assert.equal(await money(2), m2);
	assert.equal((await betsOf(round._id, 2)).length, 0);
	r = await store(c2, roundNum, [['banker', 10]]);
	assert.equal(r.fail, 1, 'unknown bet area (would break settlement)');
	r = await store(c2, roundNum, [['tiger', 10]]);
	assert.equal(r.fail, 0);
	r = await store(c2, roundNum, [['tiger', 10], ['tiger_odd', m2]]);
	assert.equal(r.fail, 1);
	assert.deepEqual(r.data.map(x => [x.bet, x.bet_money]), [['tiger', 10]], 'fail returns the previous bets');
	assert.equal(await money(2), m2 - 10);
	ok('user 2: over-balance / unknown area refused (fail 1, no debit), failed raise keeps previous bet');

	// ---------------------------------------------------------- user 3 (seamless)
	const m3 = await money(3);
	r = await store(c3, roundNum, [['tiger', 100], ['tiger_hearts', 20]]);
	assert.equal(r.fail, 0, JSON.stringify(r));
	assert.equal(r.money, 5000 - 120, 'money from the vendor API');
	assert.equal(wallet.get('player3'), 4880);
	const betCall = apiCalls.filter(c => c.path === '/api/transact/dragon-tiger/bet').pop();
	assert.equal(betCall.body.amount, 120);
	assert.equal(betCall.body.game, 'Dragon-Tiger');
	assert.equal(betCall.body.id, 3);
	assert.equal(await money(3), m3, 'seamless users.money untouched');

	apiFail = true;
	r = await store(c3, roundNum, [['tiger', 100], ['tiger_hearts', 20], ['tie', 10]]);
	assert.equal(r.fail, 1);
	assert.deepEqual(r.data.map(x => x.bet), ['tiger', 'tiger_hearts']);
	docs = await betsOf(round._id, 3);
	assert.equal(docs[0].total_bet, 120, 'vendor refused: previous bet restored');
	r = await cancel(c3, []);
	assert.equal(r.status, undefined, 'vendor refused the refund: money only (PHP shape)');
	assert.equal((await betsOf(round._id, 3)).length, 1, 'bet restored');
	apiFail = false;
	r = await cancel(c3, []);
	assert.equal(r.status, 1);
	assert.equal(wallet.get('player3'), 5000);
	r = await store(c3, roundNum, [['tiger', 100], ['tiger_hearts', 20]]);
	assert.equal(r.fail, 0);
	assert.equal(wallet.get('player3'), 4880);
	ok('user 3 seamless: debit via vendor API, refused debit reverts, refused refund restores the bet, cancel + re-bet');

	// ---------------------------------------------------------- exported testStore from a /baccarat/... url
	const direct = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', LOADER, '--input-type=module', '-e', DIRECT], {
		cwd : ROOT, env : { ...process.env, CHECK_COOKIE : c2, CHECK_TABLE : String(TABLE) }, encoding : 'utf8'
	});
	assert.equal(direct.status, 0, direct.stderr + direct.stdout);
	const directRes = JSON.parse(direct.stdout.trim().split('\n').pop());
	assert.equal(directRes.store.fail, 0, JSON.stringify(directRes));
	assert.deepEqual(JSON.parse(directRes.store.data).map(x => [x.bet, x.bet_money]), [['tiger', 10], ['tiger_small', 20]]);
	assert.equal(directRes.cancelMulti.status, 1);
	assert.equal(directRes.store2.fail, 0);
	assert.equal(await money(2), m2 - 30);
	ok('exported testStore / cancelMulti / testCancel called directly with /baccarat/dragontiger/... urls (multibet payload, device s)');

	// ---------------------------------------------------------- round guard
	assert.equal(await push({ event : 'inputitem', from : 'burn', value : '0004' }) !== false, true);
	assert.equal(await push({ event : 'setroundprogress' }), 'P');
	r = await store(c1, roundNum, [['dragon', 100], ['dragon_big', 50], ['tie', 20]]);
	assert.equal(r.fail, 1, 'betting closed');
	assert.equal(r.data.length, 3);
	r = await cancel(c1, []);
	assert.equal(r.status, 0, 'cannot cancel after betting closed');
	assert.equal(await money(1), m1 - 160);
	ok('round P: store refused (prev bets returned), cancel refused (status 0), money unchanged');

	// ---------------------------------------------------------- deal + settle
	assert.deepEqual(await push({ event : 'inputitem', from : 'dragon', value : '0025' }), { from : 'dragon', value : '0025' }); // K hearts
	assert.deepEqual(await push({ event : 'inputitem', from : 'tiger', value : '0016' }), { from : 'tiger', value : '0016' });  // 4 hearts
	const result = await push({ event : 'displayresults' });
	assert.equal(result.winner, 'dragon');
	const ended = await dt().collection('rounds').findOne({ _id : round._id });
	assert.equal(ended.status, 'E');

	const [s1] = await betsOf(round._id, 1);
	assert.deepEqual([s1.total_bet, s1.total_winning, s1.total_win, s1.total_lost], [160, 150, 300, 10]);
	assert.deepEqual(s1.bet_history.map(x => x.win_money), [200, 100, 0]);
	assert.equal(await money(1), m1 - 160 + 300, 'transfer user credited total_win');
	const [s3] = await betsOf(round._id, 3);
	assert.deepEqual([s3.total_bet, s3.total_win, s3.total_lost], [120, 80, 100]);
	assert.equal(await money(3), m3, 'seamless user not credited in users.money');
	const s2 = await betsOf(round._id, 2);
	assert.deepEqual(s2.map(x => [x.total_bet, x.total_win]), [[30, 40]], 'user 2 (bet through the exported testStore): tiger lost, tiger_small 20 paid 40');
	assert.equal(await money(2), m2 - 30 + 40);
	ok(`dealer dealt K♥ / 4♥, displayresults: dragon; user 1 total_win 300, money ${m1} -> ${await money(1)}; user 3 total_win 80 (vendor side)`);

	// ---------------------------------------------------------- records / misc endpoints
	const win = await post(c1, `/get/winAll/${TABLE}`, { round_id : round._id });
	assert.deepEqual(win, { total_win : 300, bet : 160 });
	assert.deepEqual(await post(c1, '/get/totalBet', { round_id : round._id }), [160]);
	assert.deepEqual(await post(c1, '/get/totalWin', { round_id : round._id }), [150]);

	const user = JSON.parse(await post(c1, '/get/user', { userid : 1 }, { raw : true }));
	assert.equal(user.id, 1);
	assert.equal(user.money, m1 + 140);
	assert.equal(user.password, undefined);

	const logsL = await post(c1, `/${TABLE}/${RANGE}/0/betlogs`, { tableId : TABLE, betPage : 1, gameType : 'L', roundNum : 0, playType : 'p', userId : 1, roomId : '' });
	assert.ok(Array.isArray(logsL) && logsL.length >= 1);
	const row = logsL[0];
	assert.equal(row.round_num, roundNum);
	assert.equal(row.table_id, TABLE);
	assert.equal(row.total_bet, 160);
	assert.equal(row.total_win, 140, 'win / lose');
	assert.equal(row.status, 'E');
	assert.equal(JSON.parse(row.game_info).dragon, '0025');
	assert.equal(JSON.parse(row.game_result).winner, 'dragon');
	assert.equal(row.cnt, logsL.length);
	assert.match(row.updated_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
	assert.ok(row.dealer_name);
	const logsD = await post(c1, `/${TABLE}/${RANGE}/0/betlogs`, { roundNum, tableId : TABLE, page : 0, gameType : 'D', playType : 'p', userId : 1, roomId : '' });
	assert.equal(logsD.length, 1);
	assert.equal(JSON.parse(logsD[0].bet_history).length, 3);

	const mob = JSON.parse(await post(c1, `/m/Dragon-Tiger/${TABLE}/${RANGE}/0/betlogs`, { tableId : TABLE, mobile : true }, { raw : true }));
	assert.deepEqual(Object.keys(mob).sort(), ['current_page', 'data', 'from', 'last_page', 'next_page_url', 'per_page', 'prev_page_url', 'to', 'total']);
	assert.equal(mob.data[0].round_num, roundNum);
	assert.equal(typeof mob.data[0].bet_history, 'string');
	const mob2 = JSON.parse(await post(c1, `/${TABLE}/${RANGE}/0/betlogs`, { tableId : TABLE, mobile : true, page : 1 }, { raw : true, method : 'GET' }));
	assert.equal(mob2.current_page, 1);

	const hist = JSON.parse(await post(c1, `/${TABLE}/${RANGE}/0/gamehistory`, { tableId : TABLE }, { raw : true }));
	assert.ok(hist.data.length >= 1, 'previous rounds');
	assert.ok(hist.data.every(x => x.round_num < roundNum + 1 && typeof x.name === 'string'));
	assert.equal(typeof hist.data[0].game_info, 'string');
	const transfer = JSON.parse(await post(c1, `/${TABLE}/${RANGE}/0/transferlogs`, { tableId : TABLE }, { raw : true }));
	assert.equal(transfer.total, 0);
	assert.deepEqual(transfer.data, []);

	const details = await post(c1, '/details/getDetails', { tableId : TABLE, round : round._id });
	assert.equal(details.length, 1);
	assert.equal(JSON.parse(details[0].game_result).winner, 'dragon');
	ok('get/winAll, totalBet, totalWin, get/user, betlogs L + D, mobile betlogs (paginator), gamehistory, transferlogs, getDetails');

	// actionlogs (both root-relative from the page and as the baccarat page would call them)
	assert.equal(await post(c1, `/actionlogs/store/${TABLE}/${RANGE}`, { logs : [{ action : 'a1' }], type : 'r' }, { raw : true }), '');
	assert.equal(await post(c1, `/actionlogs/store/${TABLE}/${RANGE}`, { logs : [{ action : 'a2' }], type : 'r' }, { raw : true }), '');
	const alog = await dt().collection('action_logs').findOne({ user_id : 1, table_id : TABLE, round_num : roundNum, type : 'r' });
	assert.deepEqual(alog.actions.map(x => x.action), ['a1', 'a2']);
	assert.ok(Number.isInteger(alog._id));
	const blog = await dt().collection('bet_logs').findOne({ user_id : 1, table_id : TABLE, round_num : roundNum, type : 'I' });
	assert.ok(blog.actions.length >= 1);
	ok('actionlogs appended (JSON_MERGE), bet_logs written by store');

	// settings
	await post(c1, '/settings', { voice : '0.5', language : 2, chips : ['5', '10', '50', '100', 'max'], tutorial : 'false' }, { raw : true });
	await post(c1, '/setGameSettings', { range : '200-5000', game : `Dragon-Tiger/${TABLE}`, multiplayer : 1 }, { raw : true });
	await post(c1, '/settings/videoSetting', { type : 'SD' }, { raw : true });
	const u1 = await shared().collection('users').findOne({ _id : 1 });
	assert.equal(u1.configs.avarta.sound.voice, '0.5');
	assert.equal(u1.configs.avarta.language.select, '2');
	assert.deepEqual(u1.configs.avarta.chips, ['5', '10', '50', '100', 'max']);
	assert.equal(u1.configs.avarta.tutorial.enabled, 'false');
	assert.deepEqual([u1.last_game_info.game, u1.last_game_info.bet_range, u1.last_game_info.slave], [`Dragon-Tiger/${TABLE}`, '200-5000', '']);
	assert.equal((await shared().collection('video_settings').findOne({ user_id : 1 })).type, 'SD');
	const html = await (await fetch(page, { headers : { cookie : c1 } })).text();
	assert.match(html, /window\.range = '200-5000';/, 'page uses last_game_info range');
	assert.match(html, /window\.user_chips = \["5","10","50","100","max"\];/);
	assert.match(html, /voice: '0\.5'/);
	assert.match(html, /lang-zh/, 'language select 2 = chinese');
	assert.match(html, /window\.multiplayer = '1';/);
	ok('settings / setGameSettings / videoSetting stored natively and reflected in the page');

	// misc
	assert.deepEqual(await post(c1, '/checkTable', { vendorId : 1 }), [{ junket_table : null }]);
	const img = await post(c1, '/getDealerImg', { dealerId : 1 });
	assert.deepEqual(img.map(x => x.id), [1]);
	assert.equal(await post(c1, '/checkPassword', { password : 'abc' }, { raw : true }), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	assert.equal(await post(c1, '/get/users', {}, { raw : true }), 'no users');
	assert.deepEqual(JSON.parse(await post(c1, '/get/users', { vendor_name : 'demo-transfer', users : [1, 2] }, { raw : true })).map(x => x.user_id), ['player1', 'player2']);
	assert.deepEqual(await post(c1, '/getJunketLogs', { tableId : TABLE, betPage : 1, gameType : 'L', roundNum : 0, userId : 1, roomId : 999 }), []);
	assert.deepEqual(await post(c1, '/getJunket/999'), []);
	const unauth = await fetch(`${FRONT}/bet/store/${TABLE}/${RANGE}`, { method : 'POST', headers : { referer : page } });
	assert.equal(unauth.status, 401);
	ok('checkTable, getDealerImg, checkPassword, get/users, getJunketLogs, getJunket; unauthenticated store -> 401');

	// restore user 1 settings for the next run
	await shared().collection('users').updateOne({ _id : 1 }, { $unset : { configs : '', last_game_info : '' } });
	console.log(`\ncheck-dragon-tiger: all ${step} checks passed`);
}

// ------------------------------------------------------------------ direct call (child process)

// resolves "@/..." and extensionless imports to the .ts sources and stubs next/headers
// (the session cookie comes from CHECK_COOKIE), so the controller runs outside Next
const LOADER = 'data:text/javascript,' + encodeURIComponent(`
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(\`
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const SRC = path.join(process.cwd(), 'src');
export async function resolve (spec, ctx, next) {
	if (spec === 'next/headers') return { url : 'data:text/javascript,' + encodeURIComponent('export async function cookies () { const [k, v] = (process.env.CHECK_COOKIE || \\\\'\\\\').split(\\\\'=\\\\'); return { get : n => (n === k ? { value : decodeURIComponent(v) } : undefined), set () {}, delete () {} }; }'), shortCircuit : true };
	let file = null;
	if (spec.startsWith('@/')) file = path.join(SRC, spec.slice(2));
	else if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL && ctx.parentURL.startsWith('file:')) file = path.resolve(path.dirname(fileURLToPath(ctx.parentURL)), spec);
	if (file && !path.extname(file)) {
		for (const c of [file + '.ts', path.join(file, 'index.ts')]) if (existsSync(c)) return { url : pathToFileURL(c).href, shortCircuit : true };
	}
	if (file && existsSync(file)) return { url : pathToFileURL(file).href, shortCircuit : true };
	return next(spec, ctx);
}
\`));
`);

const DIRECT = `
import * as dt from './src/server/dragon-tiger/controller.ts';
import mongoose from 'mongoose';
const t = process.env.CHECK_TABLE;
const call = async (fn, url, params, form) => {
	const req = new Request('http://localhost:3103' + url, { method : 'POST', headers : { 'content-type' : 'application/x-www-form-urlencoded' }, body : new URLSearchParams(form) });
	const res = await fn(req, params);
	return res instanceof Response ? { status : res.status } : res;
};
// payload of components/multibet/multibet-betting2.js (range = the multiplied range, device 's')
const bet = { 'data[0][amount]' : '10', 'data[0][table_id]' : 'tiger', 'data[1][amount]' : '20', 'data[1][table_id]' : 'tiger_small', round_id : '1', 'logs[0][action]' : 'confirm', type : 'm', slave : '', is_multibet : 'true', range : '10-1000', device : 's' };
const out = {};
out.store = await call(dt.testStore, '/baccarat/dragontiger/bet/store/' + t + '/10-1000', { table : t, range : '10-1000' }, bet);
out.cancelMulti = await call(dt.cancelMulti, '/baccarat/dragontiger/bet/cancelMulti/' + t + '/10-1000', { table : t, range : '10-1000' }, { type : 'm', slave : 'normal', device : 's' });
out.store2 = await call(dt.testStore, '/baccarat/dragontiger/bet/store/' + t + '/10-1000', { table : t, range : '10-1000' }, bet);
out.cancel = await call(dt.testCancel, '/baccarat/dragontiger/bet/cancelMulti/' + t + '/10-1000', { table : t, range : '10-1000' }, { range : 'none', type : 'm' });
out.logs = await call(dt.actionLogs, '/baccarat/dragontiger/actionlogs/store/' + t + '/10-1000', { table : t, range : '10-1000' }, { 'logs[0][action]' : 'multi', type : 'm' });
console.log(JSON.stringify(out));
await mongoose.disconnect();
`;

main()
	.then(() => 0, e => {
		console.error('check-dragon-tiger FAILED:', e);
		return 1;
	})
	.then(async code => {
		if (socket) socket.close();
		stub.close();
		await mongoose.disconnect();
		process.exit(code);
	});
