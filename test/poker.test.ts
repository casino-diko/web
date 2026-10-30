// node --test --experimental-strip-types test/poker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parsePhpQuery, parseJson, jsonText, scriptJson, scriptString, sqlDate, paginator, pageNumber,
	normalizeConfig, configLocale, applySettings, applyGameSettings, publicUser, tableRanges, agentRanges,
	findRange, mainMul, shortAmount, channelView, emptyHistory, normalizeBetRows, planBet, planFoldCheck,
	streetOpen, transactionId
} from '../src/server/poker/helpers.ts';

const info = (o: Record<string, any> = {}) => ({ player : ['0013', '0026'], dealer : [], flop : [], turn : null, river : null, burn : [], ...o });

test('parsePhpQuery decodes jQuery.param nested keys like PHP', () => {
	const q = 'data%5B0%5D%5Bamount%5D=10&data%5B0%5D%5Btable_id%5D=ante&data%5B1%5D%5Bamount%5D=5&data%5B1%5D%5Btable_id%5D=bonus'
		+ '&logs%5B0%5D%5Baction%5D=confirm&type=r&a%5B%5D=x&a%5B%5D=y&range=20-1000';
	assert.deepEqual(parsePhpQuery(q), {
		data  : [{ amount : '10', table_id : 'ante' }, { amount : '5', table_id : 'bonus' }],
		logs  : [{ action : 'confirm' }],
		type  : 'r',
		a     : ['x', 'y'],
		range : '20-1000'
	});
	assert.deepEqual(parsePhpQuery('x%5B2%5D=a'), { x : { 2 : 'a' } });
});

test('JSON column helpers', () => {
	assert.deepEqual(parseJson('{"a":1}'), { a : 1 });
	assert.deepEqual(parseJson({ a : 1 }), { a : 1 });
	assert.equal(parseJson('nope', 'fb'), 'fb');
	assert.equal(jsonText({ mark : 'P' }), '{"mark":"P"}');
	assert.equal(jsonText('{"x":1}'), '{"x":1}');
	assert.equal(jsonText(undefined), null);
	assert.equal(scriptJson({ s : '</script>' }), '{"s":"\\u003c/script>"}');
	assert.equal(scriptString('a\'b"<'), 'a\\\'b\\"\\x3c');
	assert.equal(sqlDate(new Date(Date.UTC(2024, 0, 2, 3, 4, 5))), '2024-01-02 03:04:05');
	assert.equal(sqlDate(null), null);
});

test('paginator matches Laravel 5.4 toArray()', () => {
	const p = paginator([1, 2], 12, 2, 10, '/betlogs');
	assert.deepEqual(Object.keys(p), ['total', 'per_page', 'current_page', 'last_page', 'next_page_url', 'prev_page_url', 'from', 'to', 'data']);
	assert.equal(p.last_page, 2);
	assert.equal(p.next_page_url, null);
	assert.equal(p.prev_page_url, '/betlogs?page=1');
	assert.equal(p.from, 11);
	assert.equal(p.to, 12);
	const empty = paginator([], 0, 1, 10, '/gamehistory');
	assert.equal(empty.last_page, 1);
	assert.equal(empty.from, null);
	assert.equal(pageNumber('3'), 3);
	assert.equal(pageNumber('x'), 1);
});

test('user configs: defaults, settings, locale', () => {
	const c = normalizeConfig(null, 'kr');
	assert.equal(configLocale(c), 'kr');
	assert.equal(c.avarta.sound.volum, '1');
	const next = applySettings(JSON.stringify(c), { volume : '0.5', tutorial : 'false', chips : ['1', '5'], bgm : '2', screen : '1', bogus : 'x' });
	assert.equal(next.avarta.sound.volum, '0.5');
	assert.equal(next.avarta.tutorial.enabled, 'false');
	assert.deepEqual(next.avarta.chips, ['1', '5']);
	assert.equal(next.avarta.music, '2');
	assert.equal(next.avarta.screen.select, '1');
	assert.equal(next.avarta.bogus, undefined);
	// invalid language select falls back to 0
	assert.equal(normalizeConfig({ avarta : { language : { select : 9, data : ['english'] } } }).avarta.language.select, 0);

	const g = applyGameSettings(null, { game : 'Poker/1', range : '20-1000', slave : 'classic' });
	assert.equal(g.game, 'Poker/1');
	assert.equal(g.bet_range, '20-1000');
	assert.equal(g.slave, '');

	const u = publicUser({ _id : 3, user_name : 'x', password : 'secret', token : 't', money : 1 }, 50);
	assert.deepEqual(u, { id : 3, user_name : 'x', money : 50 });
});

test('ranges and channel display', () => {
	const table = { casino_bet_ranges : [{ min : '20', max : '1000' }, { min : '50', max : '2500' }], sport_bet_ranges : [{ min : '1', max : '2' }] };
	assert.equal(tableRanges(table, 'C').length, 2);
	assert.equal(tableRanges(table, 'TS').length, 1);
	assert.equal(findRange(tableRanges(table, 'C'), '50-2500').max, '2500');
	assert.equal(findRange(tableRanges(table, 'C'), '1-2'), null);
	assert.deepEqual(agentRanges([{ game : 'Poker', type : 'vip', ranges : [{ min : 1, max : 2 }] }], 'v'), [{ min : 1, max : 2 }]);
	assert.equal(agentRanges([{ game : 'Baccarat', type : 'normal', ranges : [] }], 'n'), null);
	assert.equal(mainMul(100), 1);
	assert.equal(mainMul(105), 1);
	assert.equal(mainMul(50), 0.5);
	assert.equal(shortAmount(2500000), '2.5M');
	assert.equal(shortAmount(2500), '2.5K');
	assert.equal(shortAmount(20), '20');
	const ch = channelView({ min : '20', max : '1000' }, tableRanges(table, 'C'), '20-1000', 1, 1, 100);
	assert.equal(ch.minDisp, '20');
	assert.equal(ch.maxDisp, '1K');
	assert.equal(ch.anteMaxFmt, '1,000');
	assert.deepEqual(ch.ranges.map(r => r.selected), [true, false]);
});

test('bet rows: bonus is the pocket bet on the bonusplus channel, unknown keys refused', () => {
	assert.deepEqual(normalizeBetRows([{ table_id : 'ante', amount : '20' }, { table_id : 'bonus', amount : '-10' }], 'b'),
		[{ key : 'ante', amount : 20 }, { key : 'pocket', amount : 10 }]);
	assert.equal(normalizeBetRows([{ table_id : 'tie', amount : 1 }], 'r'), null);
	assert.equal(normalizeBetRows([{ table_id : 'ante', amount : 'x' }], 'r'), null);
	assert.deepEqual(Object.keys(emptyHistory('r')), ['ante', 'bonus', 'flop', 'turn', 'river']);
	assert.deepEqual(Object.keys(emptyHistory('b')), ['ante', 'bonusplus', 'pocket', 'flop', 'turn', 'river']);
});

test('planBet: ante + bonus while betting', () => {
	const p: any = planBet({ type : 'r', rows : [{ key : 'ante', amount : 20 }, { key : 'bonus', amount : 10 }], current : null, status : 'S', gameInfo : info(), money : 1000 });
	assert.equal(p.ok, true);
	assert.equal(p.betAmount, 30);
	assert.equal(p.totalBet, 30);
	assert.deepEqual(p.history.ante, { bet : 20, win : 0, user_money : 1000 });
	assert.equal(p.history.flop.cancel, 0);

	// re-sent unchanged (retry): nothing to debit
	const again: any = planBet({ type : 'r', rows : [{ key : 'ante', amount : 20 }, { key : 'bonus', amount : 10 }], current : { type : 'r', bet_history : p.history }, status : 'S', gameInfo : info(), money : 970 });
	assert.equal(again.ok, true);
	assert.equal(again.betAmount, 0);

	// adding chips: only the difference is debited, user_money of the first bet kept
	const more: any = planBet({ type : 'r', rows : [{ key : 'ante', amount : 40 }], current : { type : 'r', bet_history : p.history }, status : 'S', gameInfo : info(), money : 970 });
	assert.equal(more.betAmount, 20);
	assert.equal(more.totalBet, 50);
	assert.equal(more.history.ante.user_money, 1000);
});

test('planBet: refusals', () => {
	const cur = { type : 'r', bet_history : { ...emptyHistory('r'), ante : { bet : 20, win : 0, user_money : 1000 } } };
	const reason = (o: any) => (planBet(o) as any).reason;
	assert.equal(reason({ type : 'b', rows : [{ key : 'ante', amount : 20 }], current : cur, status : 'S', gameInfo : info(), money : 1 }), 'type');
	assert.equal(reason({ type : 'r', rows : [{ key : 'ante', amount : 10 }], current : cur, status : 'S', gameInfo : info(), money : 1 }), 'decrease');
	assert.equal(reason({ type : 'r', rows : [{ key : 'ante', amount : 30 }], current : cur, status : 'P', gameInfo : info(), money : 1 }), 'closed');
	assert.equal(reason({ type : 'r', rows : [{ key : 'ante', amount : 30 }], current : cur, status : 'E', gameInfo : info(), money : 1 }), 'status');
	assert.equal(reason({ type : 'r', rows : [{ key : 'bonus', amount : 5 }], current : null, status : 'S', gameInfo : info(), money : 1 }), 'ante');
	assert.equal(reason({ type : 'r', rows : [{ key : 'flop', amount : 40 }], current : cur, status : 'S', gameInfo : info(), money : 1 }), 'closed');
	assert.equal(reason({ type : 'r', rows : [{ key : 'flop', amount : 30 }], current : cur, status : 'P', gameInfo : info({ flop : ['1', '2', '3'] }), money : 1 }), 'amount');
	// flop after the turn card is out
	assert.equal(reason({ type : 'r', rows : [{ key : 'flop', amount : 40 }], current : cur, status : 'P', gameInfo : info({ flop : ['1', '2', '3'], turn : '4' }), money : 1 }), 'closed');
	// turn without a flop bet
	assert.equal(reason({ type : 'r', rows : [{ key : 'turn', amount : 20 }], current : cur, status : 'P', gameInfo : info({ turn : '4' }), money : 1 }), 'amount');
	// folded flop
	const folded = { type : 'r', bet_history : { ...cur.bet_history, flop : { bet : 0, win : 0, user_money : 0, cancel : 1 } } };
	assert.equal(reason({ type : 'r', rows : [{ key : 'flop', amount : 40 }], current : folded, status : 'P', gameInfo : info({ flop : ['1', '2', '3'] }), money : 1 }), 'decided');
});

test('planBet: streets', () => {
	const cur: any = { type : 'r', bet_history : { ...emptyHistory('r'), ante : { bet : 20, win : 0, user_money : 1000 }, bonus : { bet : 5, win : 0, user_money : 1000 } } };
	const flop: any = planBet({ type : 'r', rows : [{ key : 'ante', amount : 20 }, { key : 'bonus', amount : 5 }, { key : 'flop', amount : 40 }], current : cur, status : 'P', gameInfo : info({ flop : ['1', '2', '3'] }), money : 975 });
	assert.equal(flop.ok, true);
	assert.equal(flop.betAmount, 40);
	assert.equal(flop.totalBet, 65);
	assert.equal(flop.history.flop.user_money, 975);

	// turn checked (cancel 1 / amount 0 row), river raised
	const afterFlop = { type : 'r', bet_history : { ...flop.history, turn : { bet : 0, win : 0, user_money : 0, cancel : 1 } } };
	const river: any = planBet({ type : 'r', rows : [{ key : 'ante', amount : 20 }, { key : 'flop', amount : 40 }, { key : 'turn', amount : 0 }, { key : 'river', amount : 20 }], current : afterFlop, status : 'P', gameInfo : info({ flop : ['1', '2', '3'], turn : '4', river : '5' }), money : 935 });
	assert.equal(river.ok, true);
	assert.equal(river.betAmount, 20);
	assert.equal(river.history.turn.cancel, 1);
	assert.equal(river.history.river.bet, 20);
	// river after the dealer's hand is complete
	assert.equal((planBet({ type : 'r', rows : [{ key : 'river', amount : 20 }], current : afterFlop, status : 'P', gameInfo : info({ turn : '4', river : '5', dealer : ['6', '7'] }), money : 1 }) as any).reason, 'closed');

	assert.equal(streetOpen('flop', 'S', info()), false);
	assert.equal(streetOpen('turn', 'P', info({ turn : '4' })), true);
	assert.equal(streetOpen('turn', 'P', info({ turn : '4', river : '5' })), false);
});

test('planFoldCheck', () => {
	const h = { ...emptyHistory('r'), ante : { bet : 20, win : 0, user_money : 0 } };
	assert.equal(planFoldCheck(h, 'flop', 'P').flop.cancel, 1);
	assert.equal(planFoldCheck(JSON.stringify(h), 'turn', 'P').turn.cancel, 1);
	assert.equal(planFoldCheck(h, 'ante', 'P'), null);
	assert.equal(planFoldCheck(h, 'flop', 'E'), null);
	assert.equal(planFoldCheck({ ...h, flop : { bet : 40, win : 0, user_money : 0, cancel : 0 } }, 'flop', 'P'), null);
	assert.equal(transactionId(1, 'Player One', 5), transactionId(1, 'Player One', 5));
	assert.equal(transactionId(1, 'Player One', 5).length, 32);
});
