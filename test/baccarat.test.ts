import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGameSettings, applyUserConfig, agentRanges, balanceOk, betType, buildBetHistory, configLocale, historyRow,
	jsonText, mainMul, numberFormat, paginate, parsePhpQuery, phpArrays, phpNumber, rangeDisplay, rangeRows, sqlDate,
	tableTypes, userConfig, validateBets, viewConfig
} from '../src/server/baccarat/helpers.ts';

test('jQuery nested form bodies decode like PHP', () => {
	const body = 'data%5B0%5D%5Bamount%5D=100&data%5B0%5D%5Btable_id%5D=player&data%5B1%5D%5Bamount%5D=10'
		+ '&data%5B1%5D%5Btable_id%5D=playerpair&logs%5B0%5D%5Baction%5D=confirm&chips%5B%5D=1&chips%5B%5D=max&slave=r&roomId=';
	const input = phpArrays(parsePhpQuery(body));
	assert.deepEqual(input.data, [{ amount : '100', table_id : 'player' }, { amount : '10', table_id : 'playerpair' }]);
	assert.deepEqual(input.logs, [{ action : 'confirm' }]);
	assert.deepEqual(input.chips, ['1', 'max']);
	assert.equal(input.slave, 'r');
	assert.equal(input.roomId, '');
	// non-sequential keys stay an object
	assert.deepEqual(phpArrays(parsePhpQuery('a%5Bx%5D=1&a%5B2%5D=2')).a, { x : '1', 2 : '2' });
});

test('bet type from slave / type', () => {
	assert.equal(betType(undefined, 'r'), 'r');
	assert.equal(betType('r', 'f'), 'f');
	assert.equal(betType(undefined, 'f'), 'f');
	assert.equal(betType('s', 'f'), 's');
	assert.equal(betType('b', 'r'), 'b');
	assert.equal(betType('i', 'r'), null, 'insurance cannot be settled');
	assert.equal(betType('x', 'r'), null);
});

test('bet validation per side game', () => {
	assert.equal(validateBets([{ table_id : 'player', amount : '10' }], 'r'), null);
	assert.match(validateBets([{ table_id : 'supersix', amount : '10' }], 'r'), /not allowed/);
	assert.equal(validateBets([{ table_id : 'supersix', amount : '10' }], 's'), null);
	assert.equal(validateBets([{ table_id : 'bonus_player', amount : '10' }, { table_id : 'big', amount : 5 }], 'b'), null);
	assert.match(validateBets([{ table_id : 'player', amount : 1 }, { table_id : 'player', amount : 2 }], 'r'), /duplicate/);
	assert.match(validateBets([], 'r'), /no bets/);
	assert.match(validateBets([{ table_id : 'player', amount : 'abc' }], 'r'), /bad amount/);
});

test('bet history rows, totals and kept amounts', () => {
	const first = buildBetHistory([{ table_id : 'player', amount : '100' }, { table_id : 'playerpair', amount : '-10' }], [], 1000);
	assert.equal(first.total, 110);
	assert.equal(first.prevTotal, 0);
	assert.deepEqual(first.rows, [
		{ bet : 'player', bet_money : 100, win_money : 0, user_money : 1000 },
		{ bet : 'playerpair', bet_money : 10, win_money : 0, user_money : 900 }
	]);
	// money already debited (890), previous stake 110: amount 0 keeps the confirmed player bet
	const again = buildBetHistory([{ table_id : 'player', amount : 0 }, { table_id : 'tie', amount : 20 }], first.rows, 890);
	assert.equal(again.prevTotal, 110);
	assert.equal(again.total, 120);
	assert.equal(again.rows[0].bet_money, 100);
	assert.equal(again.rows[0].user_money, 1000);
	assert.equal(again.rows[1].user_money, 900);
});

test('balance bet: room player/banker difference within the balance', () => {
	const bets = [{ bet_history : [{ bet : 'player', bet_money : 500 }] }, { bet_history : [{ bet : 'banker', bet_money : 300 }, { bet : 'tie', bet_money : 900 }] }];
	assert.equal(balanceOk(bets, 200), true);
	assert.equal(balanceOk(bets, 199), false);
	assert.equal(balanceOk([], 0), true);
});

test('user config defaults, locale and settings', () => {
	const cfg = userConfig(null, 'kr');
	assert.equal(configLocale(cfg), 'kr');
	assert.deepEqual(cfg.avarta.chips, ['1', '5', '10', '30', 'max']);
	assert.equal(viewConfig(cfg).volume, '1');

	const stored = JSON.stringify({ avarta : { language : { data : ['english', 'japan'], select : 7 }, sound : { voice : '0' } } });
	const parsed = userConfig(stored);
	assert.equal(parsed.avarta.language.select, 0, 'invalid language falls back to the first');
	assert.equal(parsed.avarta.sound.voice, '0');
	assert.equal(parsed.avarta.sound.music, '0.2');

	applyUserConfig(parsed, { volume : '0.5', tutorial : 'false', chips : ['1', 'max'], bgm : '0', language : '1', screen : '1' });
	assert.equal(parsed.avarta.sound.volum, '0.5');
	assert.equal(parsed.avarta.tutorial.enabled, 'false');
	assert.deepEqual(parsed.avarta.chips, ['1', 'max']);
	assert.equal(parsed.avarta.music, '0');
	assert.equal(parsed.avarta.language.select, '1');
	assert.equal(configLocale(parsed), 'jp');
	assert.equal(viewConfig(parsed).screen, 'white');
});

test('game settings (last_game_info)', () => {
	const info = applyGameSettings({ game : 'Baccarat/1', bet_range : '10-1000', slave : 'bonus', multi_yn : 1 }, { range : '100-5000', game : 'Baccarat/2' });
	assert.deepEqual(info, { game : 'Baccarat/2', bet_range : '100-5000', slave : '', multi_yn : 1 });
	assert.equal(applyGameSettings(null, { slave : 'classic' }).slave, '');
	assert.equal(applyGameSettings(null, { slave : 'supersix' }).slave, 'supersix');
});

test('table types and ranges', () => {
	assert.deepEqual(tableTypes({ type : ['normal', 'supersix', 'bonus'] }, 'bonus'), { type : 'normal', slave : 'bonus', tType : 'normal' });
	assert.deepEqual(tableTypes({ type : ['flippy', 'bonus'] }, undefined), { type : 'flippy', slave : null, tType : 'flippy' });
	assert.deepEqual(tableTypes({ type : 'normal' }, 'x'), { type : 'normal', slave : null, tType : 'normal' });

	assert.equal(mainMul(100), 1);
	assert.equal(mainMul(150), 1.5);
	assert.equal(mainMul(155), 1);
	assert.equal(mainMul(80), 0.8);
	assert.equal(numberFormat(1234567.5), '1,234,568');
	assert.equal(phpNumber(1500 / 1000), '1.5');
	assert.equal(phpNumber(0.1 * 3), '0.3');

	const rd = rangeDisplay({ min : '500', max : '50000', side_bet : [{ min : '5', max : '4250' }] }, 10, 1, 100);
	assert.equal(rd.minFmt, '5,000');
	assert.equal(rd.maxFmt, '500,000');
	assert.equal(rd.minK, '5');
	assert.equal(rd.maxRaw, '500000');
	assert.equal(rd.side[0].maxFmt, '42,500');
	assert.equal(rd.side.length, 3);

	const rows = rangeRows([{ min : '10', max : '1000' }, { min : '100', max : '5000' }], '100-5000', 1, 1, 100);
	assert.deepEqual(rows.map(r => r.selected), [false, true]);
	assert.equal(rows[1].maxFmt, '5,000');
});

test('agent ranges override by room type', () => {
	const groups = [
		{ game : 'Baccarat', type : 'normal', gameType : 'Normal', ranges : [{ min : 1, max : 2 }] },
		{ game : 'Baccarat', type : 'vip', gameType : 'Flippy', ranges : [{ min : 3, max : 4 }] },
		{ game : 'Poker', type : 'normal', gameType : 'Normal', ranges : [{ min : 5, max : 6 }] }
	];
	assert.deepEqual(agentRanges(groups, { room_type : 'n', bet_setting : { type : ['normal'] } }), [{ min : 1, max : 2 }]);
	assert.deepEqual(agentRanges(groups, { room_type : 'v', bet_setting : { type : ['flippy'] } }), [{ min : 3, max : 4 }]);
	assert.equal(agentRanges(groups, { room_type : 'p', bet_setting : { type : ['normal'] } }), null);
	assert.equal(agentRanges(null, {}), null);
});

test('laravel paginator shape', () => {
	const p = paginate([{ a : 1 }, { a : 2 }], 12, 2, 10, '/gamehistory');
	assert.deepEqual(p, {
		total : 12, per_page : 10, current_page : 2, last_page : 2,
		next_page_url : null, prev_page_url : '/gamehistory?page=1', from : 11, to : 12, data : [{ a : 1 }, { a : 2 }]
	});
	assert.equal(paginate([], 0, 1, 10, '/x').from, null);
	assert.equal(paginate([], 0, 1, 10, '/x').last_page, 1);
});

test('column formatting: JSON text and MySQL dates', () => {
	assert.equal(jsonText({ a : 1 }), '{"a":1}');
	assert.equal(jsonText('{"a":1}'), '{"a":1}');
	assert.equal(jsonText(null), null);
	assert.equal(sqlDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '2026-01-02 03:04:05');
	assert.equal(sqlDate(null), null);

	const row = historyRow(
		{ _id : 9, round_id : 3, total_bet : 110, total_win : 320, bet_history : [{ bet : 'player' }], created_at : new Date(0) },
		{ round_num : 7, table_id : 1, status : 'E', dealer_id : 2, game_info : { player1 : '0003' }, game_result : { winner : 'player' }, updated_at : new Date(0) },
		{ name : 'Bella' }, 4);
	assert.equal(row.cnt, 4);
	assert.equal(row.total_win, 210, 'net win/lose');
	assert.equal(row.dealer_name, 'Bella');
	assert.equal(typeof row.game_info, 'string');
	assert.equal(JSON.parse(row.game_result).winner, 'player');
	assert.equal(row.updated_at, '1970-01-01 00:00:00');
});
