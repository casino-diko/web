#!/usr/bin/env node
/*
 |--------------------------------------------------------------------------
 | check-lobby
 |--------------------------------------------------------------------------
 | Exercises the ported lobby over HTTP against a running front-end and
 | asserts the response shapes the compiled lobby JS reads.
 |
 |   BASE=http://localhost:3101 \
 |   MONGO_URI=... MONGO_SHARED_DB=nihtan_api_lobby BACCARAT_DB=baccarat_lobby \
 |   DRAGONTIGER_DB=dragontiger_lobby POKER_DB=poker_lobby \
 |   node scripts/check-lobby.mjs
 |
 | Needs the game-server seed (users 1-5, vendors 1-3). Settled bets are
 | inserted as fixtures (ids >= 9000, shaped like the game-server writes
 | them) into the configured databases, so point it at test databases only.
 |
 */

import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const BASE = (process.env.BASE || 'http://localhost:3101').replace(/\/$/, '');
const env = process.env;
const DBS = {
	shared      : env.MONGO_SHARED_DB || 'nihtan_api',
	baccarat    : env.BACCARAT_DB || 'baccarat',
	dragontiger : env.DRAGONTIGER_DB || 'dragontiger',
	poker       : env.POKER_DB || 'poker'
};
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

let passed = 0;
const failures = [];
async function check (name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (e) {
		failures.push(name);
		console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`);
	}
}

// ------------------------------------------------------------------ http

class Client {
	constructor (ua) { this.cookie = ''; this.ua = ua; }

	async req (method, path, { form, headers = {}, redirect = 'manual' } = {}) {
		const h = { referer : `${BASE}/`, ...headers };
		if (this.cookie) h.cookie = this.cookie;
		if (this.ua) h['user-agent'] = this.ua;
		let body;
		if (form) {
			body = new URLSearchParams();
			for (const [k, v] of Object.entries(form)) {
				if (Array.isArray(v)) v.forEach(x => body.append(`${k}[]`, x));
				else body.append(k, v);
			}
			h['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
			h['x-requested-with'] = 'XMLHttpRequest';
		}
		const res = await fetch(BASE + path, { method, headers : h, body, redirect });
		const set = res.headers.getSetCookie?.() || [];
		for (const c of set) {
			const [pair] = c.split(';');
			if (pair.startsWith('nihtan=')) this.cookie = pair;
		}
		const text = await res.text();
		return { status : res.status, type : res.headers.get('content-type') || '', location : res.headers.get('location'), text, json : () => JSON.parse(text) };
	}

	async login (uid, locale = 'en') {
		const r = await this.req('POST', '/login', { form : { uid : String(uid), locale } });
		assert.equal(r.status, 303, `login ${uid}`);
		return this;
	}

	post (path, form = {}) { return this.req('POST', path, { form }); }
	get (path) { return this.req('GET', path); }
}

const jsonOf = async (p, status = 200) => {
	const r = await p;
	assert.equal(r.status, status, `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
	return r.json();
};

// ------------------------------------------------------------------ fixtures

const T0 = Date.UTC(2026, 0, 1);
const at = mins => new Date(T0 + mins * 60e3);

async function fixtures () {
	await mongoose.connect(env.MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true');
	const db = name => mongoose.connection.useDb(DBS[name], { useCache : true }).db;
	const put = (d, col, docs) => Promise.all(docs.map(doc => db(d).collection(col).replaceOne({ _id : doc._id }, doc, { upsert : true })));

	const bacRound = (id, num, status, extra = {}) => ({
		_id : id, table_id : 1, dealer_id : 1, shoe_id : 1, round_num : num, status,
		game_info : { banker1 : '0003', banker2 : '0001', banker3 : null, player1 : '0008', player2 : '0048', player3 : null },
		game_result : status === 'E' ? { winner : 'banker', pairs : [], supersix : false, size : 'small', bonus : { type : null, diff : 'bonus_1' } } : null,
		created_at : at(num), updated_at : at(num), ...extra
	});
	const bacBet = (id, roundId, userId, type, mins, money = 100) => ({
		_id : id, round_id : roundId, user_id : userId, type,
		bet_history : [{ bet : 'banker', bet_money : money, win_money : money * 1.95 }, { bet : 'tie', bet_money : 10 }],
		total_bet : money + 10, total_win : money * 1.95, total_winning : money * 0.95, total_lost : 10, total_rolling : money + 10,
		bet_range : '10-1000', currency : 'USD', created_at : at(mins), updated_at : at(mins)
	});

	await put('baccarat', 'rounds', [
		bacRound(9001, 9001, 'E'),
		bacRound(9002, 9002, 'W'),
		bacRound(9003, 9003, 'S'), // still open: never in the history
		...Array.from({ length : 13 }, (_, i) => bacRound(9010 + i, 9010 + i, 'E'))
	]);
	await put('baccarat', 'bets', [
		bacBet(9001, 9001, 1, 'r', 10),
		bacBet(9002, 9002, 1, 's', 20),
		bacBet(9003, 9003, 1, 'r', 30),
		bacBet(9004, 9001, 4, 'r', 40),
		...Array.from({ length : 13 }, (_, i) => bacBet(9010 + i, 9010 + i, 2, 'r', 100 + i))
	]);

	await put('poker', 'rounds', [{
		_id : 9001, table_id : 1, dealer_id : 2, round_num : 9001, status : 'E',
		game_info : { burn : ['0040', '0042', '0043'], player : ['0013', '0025'], dealer : ['0001', '0032'], flop : ['0024', '0023', '0041'], turn : '0022', river : '0045' },
		game_result : { cards : ['0013', '0025', '0024', '0023', '0022'], winner : 'player', handtype : 'Royal Flush' },
		created_at : at(50), updated_at : at(50)
	}]);
	await put('poker', 'bets', [{
		_id : 9001, round_id : 9001, user_id : 1, type : 'r',
		bet_history : { ante : { bet : 10, win : 20, user_money : 0 }, flop : { bet : 20, win : 40 }, turn : { bet : 10, win : 20 }, river : { bet : 10, win : 20 }, bonus : { bet : 0, win : 0 } },
		total_bet : 50, total_win : 100, total_winning : 50, total_lost : 0, total_rolling : 50, bet_range : '10-1000',
		created_at : at(50), updated_at : at(50)
	}]);

	await put('dragontiger', 'rounds', [{
		_id : 9001, table_id : 1, dealer_id : 3, round_num : 9001, status : 'E',
		game_info : { dragon : '0001', tiger : '0012', burn : null }, game_result : { winner : 'tiger' },
		created_at : at(60), updated_at : at(60)
	}]);
	await put('dragontiger', 'bets', [{
		_id : 9001, round_id : 9001, user_id : 1, type : 'r',
		bet_history : [{ bet : 'dragon', bet_money : 50 }],
		total_bet : 50, total_win : 0, total_winning : 0, total_lost : 50, total_rolling : 50, bet_range : '10-1000',
		created_at : at(60), updated_at : at(60)
	}]);

	await put('shared', 'api_transfer_log', [{ _id : 9001, user_id : 1, type : 'IN', amount : 1000, created_at : at(1), updated_at : at(1) }]);
	// reset what the checks change
	await db('shared').collection('users').updateMany({ _id : { $in : [1, 4, 5] } }, { $unset : { configs : '', last_game_info : '' } });
	await db('shared').collection('vendors').updateOne({ _id : 3 }, { $set : { junket_table : { created_room : [], disable_table : [] }, secret_key : 'demo-junket-secret' } });
	await db('shared').collection('vendors').updateOne({ _id : 1 }, { $set : { secret_key : 'demo-transfer-secret' } });
	return { db };
}

// ------------------------------------------------------------------ checks

const ROW_KEYS = ['id', 'cnt', 'round_num', 'table_id', 'game_type', 'user_id', 'dealer_name', 'total_bet', 'total_win', 'status', 'game_info', 'game_result', 'bet_history', 'updated_at'];

const assertRow = r => {
	for (const k of ROW_KEYS) assert.ok(k in r, `row has ${k}: ${JSON.stringify(r).slice(0, 300)}`);
	assert.equal(typeof r.total_bet, 'number');
	assert.equal(typeof r.total_win, 'number');
	assert.equal(typeof r.bet_history, 'string', 'bet_history is JSON text');
	assert.match(r.updated_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
	assert.ok(['E', 'W'].includes(r.status));
};

const assetUrls = html => {
	const urls = new Set();
	const clean = html.replace(/<!--[\s\S]*?-->/g, '');
	for (const m of clean.matchAll(/<(?:script|img|link)\b[^>]*?\b(?:src|href)\s*=\s*"([^"]+)"/g)) {
		if (!m[1].startsWith('#') && !/^(https?:)?\/\//.test(m[1])) urls.add(m[1]);
	}
	return [...urls];
};

async function main () {
	console.log(`lobby checks against ${BASE}`);
	const { db } = await fixtures();

	const guest = new Client();
	await check('guest: GET / redirects to /login, XHR gets 401 JSON', async () => {
		const r = await guest.get('/');
		assert.equal(r.status, 302);
		assert.match(r.location, /\/login$/);
		const x = await guest.post('/getLogs', { gameName : 'allgames' });
		assert.equal(x.status, 401);
		assert.deepEqual(x.json(), { error : 'Unauthenticated.' });
	});

	await check('removed routes are gone (404)', async () => {
		const p1 = await new Client().login(1);
		for (const path of ['/test', '/test/dollar', '/kaga/list', '/betsoft/reel', '/kagalogs', '/sicbologs', '/m/sicbologs', '/details/getSicboDetails', '/paigowlogs', '/m/paigowlogs', '/details/getPaigowDetails', '/pulaputilogs', '/bigwheellogs', '/3', '/non']) {
			const r = await p1.get(path);
			assert.equal(r.status, 404, `${path} -> ${r.status}`);
		}
		assert.equal((await p1.get('/getUserMoney')).status, 405, 'GET on a POST route');
	});

	const p1 = await new Client().login(1);
	const m1 = await new Client(MOBILE_UA).login(1);

	let desktop, mobile;
	await check('GET / renders the desktop 3.0 lobby', async () => {
		const r = await p1.get('/');
		assert.equal(r.status, 200);
		desktop = r.text;
		assert.match(desktop, /<script type="text\/javascript" src ="\/dist\/main-3\.0\.js"><\/script>/);
		assert.match(desktop, /window\.bc_domain = "http:\/\/[^"]+\/baccarat\/";/);
		assert.match(desktop, /window\.dt_domain = "http:\/\/[^"]+\/dragon-tiger\/";/);
		assert.match(desktop, /window\.poker_domain = "http:\/\/[^"]+\/poker\/";/);
		assert.match(desktop, /window\.lobby_domain = "http:\/\/[^"]+\/";/);
		assert.match(desktop, /window\.userId = {2}1;/);
		assert.match(desktop, /window\.money = {2}[\d.]+;/);
		assert.match(desktop, /window\.isJunket = {3}0;/);
		assert.match(desktop, /window\.vendorTables = "";/);
		assert.match(desktop, /window\.maintenance = "\{.*\\"status\\":\\"0\\"/);
		assert.match(desktop, /window\.bcSetting = {2}\[\{"bet_setting":"\{/, 'bet_setting as JSON text like the MySQL column');
		assert.doesNotMatch(desktop, /secret_key/, 'vendor secret not exposed to players');
		assert.doesNotMatch(desktop, /data="sicbologs"|data="paigowlogs"|id="reelgames"|data="sicbo-toggle"/, 'dropped games removed');
		const vendorData = JSON.parse(/window\.vendorData = (\{.*\});/.exec(desktop)[1]);
		assert.equal(vendorData.id, 1);
		assert.equal(vendorData.lobby_type, 'normal');
		new Function(/<script type="text\/javascript">\s*var ka_games[\s\S]*?<\/script>/.exec(desktop)[0].replace(/<\/?script[^>]*>/g, '')); // valid JS
	});

	await check('GET / with a mobile user agent and GET /m render the mobile 3.0 lobby', async () => {
		const r = await m1.get('/');
		assert.equal(r.status, 200);
		mobile = r.text;
		assert.match(mobile, /src ="\/dist\/main-mobile-3\.0\.js"/);
		assert.doesNotMatch(mobile, /id="reelgames-mb"|data="sicbologs"/);
		const m = await p1.get('/m');
		assert.equal(m.status, 200);
		assert.match(m.text, /main-mobile-3\.0\.js/);
	});

	await check('every local script / stylesheet / image of both pages loads (Referer: lobby)', async () => {
		const bad = [];
		for (const url of new Set([...assetUrls(desktop), ...assetUrls(mobile)])) {
			const r = await fetch(BASE + encodeURI(url), { headers : { referer : `${BASE}/` } });
			await r.arrayBuffer();
			if (r.status !== 200) bad.push(`${r.status} ${url}`);
		}
		assert.deepEqual(bad, []);
	});

	await check('asset json / sounds the lobby scripts load', async () => {
		for (const url of ['/lobby.json', '/lobby-mobile.json', '/sound/click.mp3', '/fonts/font-awesome.min.css', '/img/avatar/red_queen.png']) {
			const r = await fetch(BASE + url, { headers : { referer : `${BASE}/` } });
			await r.arrayBuffer();
			assert.equal(r.status, 200, url);
		}
	});

	await check('GET /rejected renders (guest too)', async () => {
		for (const c of [p1, guest]) {
			const r = await c.get('/rejected');
			assert.equal(r.status, 200);
			assert.match(r.text, /<title>rejected<\/title>/);
		}
	});

	await check('POST /getUserMoney answers the balance as text', async () => {
		const r = await p1.post('/getUserMoney');
		assert.equal(r.status, 200);
		assert.match(r.text, /^\d+(\.\d+)?$/);
	});

	await check('POST /getDealerImg and /getChangeDealerImg', async () => {
		const list = await jsonOf(p1.post('/getDealerImg', { dealerId : ['1', '2'] }));
		assert.equal(list.length, 2);
		for (const d of list) {
			assert.equal(typeof d.id, 'number');
			assert.ok('dealer_image' in d);
		}
		assert.deepEqual(await jsonOf(p1.post('/getDealerImg')), []);
		const one = await jsonOf(p1.post('/getChangeDealerImg', { dealerId : '3' }));
		assert.deepEqual(one.map(d => d.id), [3]);
	});

	await check('POST /settings stores the config and switches the page language', async () => {
		const r = await p1.post('/settings', { language : '1', volume : '0.4', screen : '1', tutorial : 'false' });
		assert.equal(r.status, 200);
		assert.equal(r.text, '');
		const user = await db('shared').collection('users').findOne({ _id : 1 });
		assert.equal(typeof user.configs, 'object', 'native object');
		assert.equal(user.configs.avarta.sound.volum, '0.4');
		const page = (await p1.get('/')).text;
		assert.match(page, /locale: 'kr'/);
		assert.match(page, /language: 'korea'/);
		assert.match(page, /tutorial: 'false'/);
		await p1.post('/settings', { language : '0', screen : '0' });
	});

	await check('POST /settingGame stores last_game_info', async () => {
		const r = await p1.post('/settingGame', { game : 'Baccarat/1', range : '10-1000', slave : 'supersix', multiplayer : '0' });
		assert.equal(r.status, 200);
		const user = await db('shared').collection('users').findOne({ _id : 1 });
		assert.deepEqual(user.last_game_info, { game : 'Baccarat/1', slave : 'supersix', multi_yn : '0', bet_range : '10-1000', multibet : [] });
	});

	await check('POST /getLogs allgames: every kept game, newest first, finished rounds only', async () => {
		const rows = await jsonOf(p1.post('/getLogs', { gameType : 'L', gameName : 'allgames', tableId : '0', roundNum : '0', betPage : '1', playType : 'p' }));
		rows.forEach(assertRow);
		assert.deepEqual(rows.map(r => r.game_type), ['Dragon Tiger', 'Poker', 'Super 6', 'Baccarat']);
		assert.equal(rows[0].cnt, 4);
		assert.ok(!rows.some(r => r.round_num === 9003), 'open round excluded');
		assert.equal(rows.find(r => r.game_type === 'Baccarat').total_win, 85, 'net: 195 - 110');
		assert.equal(rows.find(r => r.game_type === 'Super 6').status, 'W');
		assert.equal(rows.find(r => r.game_type === 'Poker').dealer_name, 'Bella');
	});

	await check('POST /getLogs one game (list) and detail of one round', async () => {
		const list = await jsonOf(p1.post('/getLogs', { gameType : 'L', gameName : 'baccarat', tableId : '0', roundNum : '0', betPage : '1' }));
		assert.deepEqual(list.map(r => r.round_num), [9002, 9001]);
		assert.ok(list.every(r => !('type' in r)));

		const [detail, ...more] = await jsonOf(p1.post('/getLogs', { gameType : 'D', gameName : 'poker', tableId : '1', roundNum : '9001', betPage : '0' }));
		assert.equal(more.length, 0);
		assertRow(detail);
		assert.equal(detail.type, 'r');
		assert.equal(JSON.parse(detail.bet_history).ante.bet, 10);
		assert.deepEqual(JSON.parse(detail.game_info).flop, ['0024', '0023', '0041']);

		const dt = await jsonOf(p1.post('/getLogs', { gameType : 'D', gameName : 'dragontiger', tableId : '1', roundNum : '9001', betPage : '0' }));
		assert.equal(JSON.parse(dt[0].game_info).dragon, '0001');
		assert.equal(dt[0].total_win, -50);

		assert.deepEqual(await jsonOf(p1.post('/getLogs', { gameType : 'L', gameName : 'sicbo', betPage : '1' })), [], 'dropped game');
	});

	await check('POST /getLogs pages by 11 with the total in cnt', async () => {
		const p2 = await new Client().login(2);
		const page1 = await jsonOf(p2.post('/getLogs', { gameType : 'L', gameName : 'baccarat', betPage : '1' }));
		const page2 = await jsonOf(p2.post('/getLogs', { gameType : 'L', gameName : 'baccarat', betPage : '2' }));
		assert.equal(page1.length, 11);
		assert.equal(page2.length, 2);
		assert.equal(page1[0].cnt, 13);
		assert.equal(page1[0].round_num, 9022);
		assert.deepEqual(page2.map(r => r.round_num), [9011, 9010]);
		const all2 = await jsonOf(p2.post('/getLogs', { gameName : 'allgames', betPage : '2' }));
		assert.deepEqual(all2.map(r => r.round_num), [9011, 9010]);
	});

	await check('/alllogs and /m/alllogs', async () => {
		const a = await jsonOf(p1.post('/alllogs', { betPage : '1' }));
		assert.equal(a.length, 4);
		const m = await jsonOf(p1.req('GET', '/m/alllogs?pageNum=1'));
		assert.equal(m.length, 4);
		a.forEach(assertRow);
	});

	await check('paginated per-game logs answer Laravel paginate(10) JSON text', async () => {
		for (const [path, n] of [['/supersixlogs', 1], ['/m/baccaratlogs', 1], ['/m/pokerlogs', 1], ['/m/dragontigerlogs', 1], ['/dragonbonuslogs', 0], ['/m/bonuspluslogs', 0]]) {
			const r = await p1.get(path);
			assert.equal(r.status, 200, path);
			assert.match(r.type, /text\/html/, `${path}: toJson() string`);
			const p = r.json();
			assert.deepEqual(Object.keys(p), ['total', 'per_page', 'current_page', 'last_page', 'next_page_url', 'prev_page_url', 'from', 'to', 'data'], path);
			assert.equal(p.per_page, 10);
			assert.equal(p.data.length, n, path);
			if (n) {
				for (const k of ['id', 'round_id', 'user_id', 'bet_history', 'total_bet', 'total_winning', 'created_at', 'updated_at', 'table_id', 'name', 'game_result', 'total_win', 'total_rolling', 'total_lost', 'round_num', 'bet_range', 'status']) {
					assert.ok(k in p.data[0], `${path} row has ${k}`);
				}
				assert.equal(typeof p.data[0].bet_history, 'string');
			}
		}
		const p2 = await new Client().login(2);
		const second = JSON.parse((await p2.get('/m/baccaratlogs?page=2')).text);
		assert.equal(second.current_page, 2);
		assert.equal(second.data.length, 3);
		assert.equal(second.from, 11);
		assert.match(second.prev_page_url, /\/baccaratlogs\?page=1$/);
	});

	await check('/transferlogs', async () => {
		const p = JSON.parse((await p1.get('/transferlogs')).text);
		assert.equal(p.total, 1);
		assert.equal(p.data[0].id, 9001);
		assert.equal(p.data[0].created_at, '2026-01-01 00:01:00');
	});

	await check('details endpoints', async () => {
		const [d] = await jsonOf(p1.post('/details/getBaccaratDetails', { betId : '9001', round : '9001', table : '1' }));
		assert.deepEqual(Object.keys(d), ['bet_history', 'game_info', 'game_result']);
		assert.equal(JSON.parse(d.game_result).winner, 'banker');
		assert.deepEqual(await jsonOf(p1.post('/details/getSupersixDetails', { betId : '9001', round : '9001', table : '1' })), [], 'type filter');
		assert.equal((await jsonOf(p1.post('/m/details/getSupersixDetails', { betId : '9002', round : '9002', table : '1' }))).length, 1);
		assert.equal((await jsonOf(p1.post('/details/getPokerDetails', { betId : '9001', round : '9001', table : '1' }))).length, 1);
		assert.equal((await jsonOf(p1.post('/details/getDragontigerDetails', { betId : '9001', round : '9001', table : '1' }))).length, 1);
		assert.deepEqual(await jsonOf(p1.post('/details/getBaccaratDetails', { betId : '9004', round : '9001', table : '1' })), [], 'other user');
	});

	// ------------------------------------------------ junket
	const j1 = await new Client().login(4);
	const agent = await new Client().login(5);

	await check('junket page variables', async () => {
		const page = (await j1.get('/')).text;
		assert.match(page, /window\.isJunket = {3}1;/);
		assert.match(page, /window\.junketAuth = \{"baccarat":\{"auth":1\}/);
		assert.match(page, /window\.vendorTables = "\{\\"created_room\\":\[\],\\"disable_table\\":\[\]\}";/);
		assert.match(page, /window\.agent_range = {2}\[\{"game":"Baccarat"/);
		assert.match(page, /window\.vendorEndDate = '2099-12-31 00:00:00';/);
		assert.doesNotMatch(page, /secret_key/);
		const agentPage = (await agent.get('/')).text;
		assert.match(agentPage, /window\.isJunket = {3}2;/);
		assert.match(agentPage, /id="date_timepicker_start"/);
		assert.match(agentPage, /"secret_key"/, 'agents keep the key main.js posts to the junket admin');
	});

	await check('canCreateRoom / setRoomData / checkPass', async () => {
		assert.deepEqual(await jsonOf(j1.post('/canCreateRoom', { vendor_id : '3' })), [{ flag : 'T' }]);
		const room = await jsonOf(j1.post('/setRoomData', { tableId : '1', roomName : 'vip', password : 'pw1', betRange : '10-1000', maxPlayers : '7', avatar : 'red_queen', gamename : 'Baccarat', roomType : 'p', duration : '30' }));
		assert.deepEqual(Object.keys(room), ['tableId', 'userId', 'roomName', 'roomToken', 'flag', 'betRange', 'gamename', 'maxPlayers', 'password', 'duration']);
		assert.match(room.roomToken, /^[A-Za-z0-9]{20}$/);
		assert.equal(typeof room.flag, 'number');
		assert.equal(room.userId, 4);
		const vendor = await db('shared').collection('vendors').findOne({ _id : 3 });
		assert.ok(vendor.junket_table.created_room.includes('Baccarat-1'));
		assert.equal((await j1.post('/checkPass', { roomId : String(room.flag), password : 'pw1', game : 'Baccarat' })).text, 'true');
		assert.equal((await j1.post('/checkPass', { roomId : String(room.flag), password : 'nope', game : 'Baccarat' })).text, 'false');
		assert.equal((await j1.post('/checkPass', { roomId : '999999', password : 'pw1' })).text, 'false');
		await db('shared').collection('vendors').updateOne({ _id : 3 }, { $set : { junket_end_date : new Date('2001-01-01') } });
		assert.deepEqual(await jsonOf(j1.post('/canCreateRoom')), [{ flag : 'F' }]);
		await db('shared').collection('vendors').updateOne({ _id : 3 }, { $set : { junket_end_date : new Date('2099-12-31T00:00:00Z') } });
	});

	await check('setTableInfo toggles junket_table.disable_table', async () => {
		let r = await jsonOf(j1.post('/setTableInfo', { game : 'baccarat-1', active : '1', type : 'disable_table' }));
		assert.deepEqual(r, { all_disabled : ['baccarat-1'], current_state : 1, current_game : 'baccarat-1' });
		r = await jsonOf(j1.post('/setTableInfo', { game : 'baccarat-1', active : '1', type : 'disable_table' }));
		assert.deepEqual(r.all_disabled, ['baccarat-1']);
		r = await jsonOf(j1.post('/setTableInfo', { game : 'baccarat-1', active : '0', type : 'disable_table' }));
		assert.deepEqual(r.all_disabled, []);
		assert.equal((await j1.post('/setTableInfo', { game : 'x', active : '1', type : 'secret_key' })).status, 422);
	});

	await check('junket user and agent bet history', async () => {
		const own = await jsonOf(j1.post('/getLogs', { gameType : 'L', gameName : 'allgames', betPage : '1', vendor_id : '1' }));
		assert.deepEqual(own.map(r => r.id), [9004]);
		assert.equal(own[0].user_id, 4);

		const all = await jsonOf(agent.post('/getLogs', { gameType : 'L', gameName : 'allgames', betPage : '1', vendor_id : '1', startDate : '', endDate : '', searchId : '', timeZone : '0' }));
		assert.deepEqual(all.map(r => r.user_id), ['junket1'], 'only the agent vendor players, by player id');
		const none = await jsonOf(agent.post('/getLogs', { gameType : 'L', gameName : 'baccarat', betPage : '1', searchId : 'nobody' }));
		assert.deepEqual(none, []);
		const dated = await jsonOf(agent.post('/getLogs', { gameType : 'L', gameName : 'baccarat', betPage : '1', startDate : '2026-01-02', endDate : '2026-01-03', timeZone : '0' }));
		assert.deepEqual(dated, [], 'outside the date range');
		const inRange = await jsonOf(agent.post('/getLogs', { gameType : 'L', gameName : 'baccarat', betPage : '1', startDate : '2026-01-01', endDate : '2026-01-01', timeZone : '-9' }));
		assert.deepEqual(inRange.map(r => r.id), [9004], '00:40 UTC is 09:40 JST on Jan 1st');
		const detail = await jsonOf(agent.post('/getLogs', { gameType : 'D', gameName : 'baccarat', tableId : '1', roundNum : '9001', betPage : '0', user_id : 'junket1' }));
		assert.equal(detail.length, 1);
		assert.equal(detail[0].type, 'r');
		const agentAll = await jsonOf(agent.post('/alllogs', { betPage : '1' }));
		assert.deepEqual(agentAll.map(r => r.id), [9004]);
	});

	await mongoose.disconnect();
	console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
	process.exit(failures.length ? 1 : 0);
}

main().catch(async e => {
	console.error(e);
	await mongoose.disconnect().catch(() => {});
	process.exit(1);
});
