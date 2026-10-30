import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../src/server/dragon-tiger/helpers.ts';

test('expandBrackets turns jQuery form keys into arrays / objects', () => {
	const out = h.expandBrackets({
		'data[0][amount]'   : '100',
		'data[0][table_id]' : 'dragon',
		'data[1][amount]'   : '50',
		'data[1][table_id]' : 'dragon_big',
		'logs[0][action]'   : 'confirm',
		users               : ['1', '2'],
		range               : '10-1000',
		'cfg[a][b]'         : 'x'
	});
	assert.deepEqual(out.data, [{ amount : '100', table_id : 'dragon' }, { amount : '50', table_id : 'dragon_big' }]);
	assert.deepEqual(out.logs, [{ action : 'confirm' }]);
	assert.deepEqual(out.users, ['1', '2']);
	assert.equal(out.range, '10-1000');
	assert.deepEqual(out.cfg, { a : { b : 'x' } });
});

test('buildBetHistory: PHP user_money formula, numbers, validation', () => {
	const prev = [{ bet : 'dragon', bet_money : 100 }];
	const { bets, totalBets, prevTotalBets } = h.buildBetHistory(
		[{ table_id : 'dragon', amount : '100' }, { table_id : 'tie', amount : '-10' }, { table_id : 'dragon_big', amount : 50 }], prev, 900);
	assert.equal(prevTotalBets, 100);
	assert.equal(totalBets, 160);
	assert.deepEqual(bets, [
		{ bet : 'dragon', bet_money : 100, win_money : 0, user_money : 1000 },
		{ bet : 'tie', bet_money : 10, win_money : 0, user_money : 900 },
		{ bet : 'dragon_big', bet_money : 50, win_money : 0, user_money : 890 }
	]);
	assert.throws(() => h.buildBetHistory([{ table_id : 'banker', amount : 1 }], [], 0), /unknown bet area/);
	assert.throws(() => h.buildBetHistory([{ table_id : 'tiger', amount : 'x' }], [], 0), /bad amount/);
});

test('mainMul / scaledRange follow the PHP and legacy JS formula', () => {
	assert.equal(h.mainMul(100), 1);
	assert.equal(h.mainMul(50), 0.5);
	assert.equal(h.mainMul(105), 1);
	assert.equal(h.scaledRange('10-1000', 1, 100), '10-1000');
	assert.equal(h.scaledRange('10-1000', 1000, 50), '10000-500000');
});

test('userConfig fills defaults and fixes a bad language select', () => {
	const c = h.userConfig(JSON.stringify({ avarta : { language : { select : 9, data : ['english', 'korea'] }, sound : { voice : '0' } } }));
	assert.equal(c.avarta.language.select, 0);
	assert.equal(c.avarta.sound.voice, '0');
	assert.equal(c.avarta.sound.music, '0.2');
	assert.equal(c.avarta.music, '1');
	assert.deepEqual(c.avarta.chips, h.DEFAULT_CHIPS);
	assert.equal(h.configLocale(c), 'en');
	assert.equal(h.configLocale(h.userConfig({ avarta : { language : { select : 1, data : ['english', 'korea'] } } })), 'kr');
	assert.deepEqual(h.configView(h.userConfig(null)), { default : 'red_king', language : 'english', screen : 'black', tutorial : 'true' });
});

test('applyUserSettings maps keys like setUserConfig', () => {
	const c = h.applyUserSettings(h.userConfig(null), { volume : '0.3', bgm : '0', tutorial : 'false', language : '1', chips : ['1', 'max'], video : 'x' });
	assert.equal(c.avarta.sound.volum, '0.3');
	assert.equal(c.avarta.music, '0');
	assert.equal(c.avarta.tutorial.enabled, 'false');
	assert.equal(c.avarta.language.select, '1');
	assert.deepEqual(c.avarta.chips, ['1', 'max']);
	assert.equal(c.avarta.video, 'HD', 'scalar keys are not overwritten with ->select');
});

test('applyGameSettings like setGameSettings', () => {
	const g = h.applyGameSettings('{"game":"Baccarat/1","bet_range":"1-2","slave":"x","multi_yn":0}', { game : 'Dragon-Tiger/1', range : '10-1000', slave : 'classic', multiplayer : '1' });
	assert.deepEqual(g, { game : 'Dragon-Tiger/1', bet_range : '10-1000', slave : '', multi_yn : '1' });
	assert.equal(h.applyGameSettings(null, { slave : 'supersix' }).slave, 'supersix');
});

test('selectRange / agentRanges', () => {
	const ranges = [{ min : '10', max : '1000' }, { min : '200', max : '5000' }];
	assert.deepEqual(h.selectRange(ranges, null, 1), { range : '10-1000', details : ranges[0], multiplayer : 0 });
	assert.deepEqual(h.selectRange(ranges, { game : 'Dragon-Tiger/1', bet_range : '200-5000', multi_yn : 1 }, 1), { range : '200-5000', details : ranges[1], multiplayer : 1 });
	assert.equal(h.selectRange(ranges, { game : 'Dragon-Tiger/2', bet_range : '200-5000' }, 1).range, '10-1000');
	assert.equal(h.selectRange(ranges, { game : 'Dragon-Tiger/1', bet_range : '1-2' }, 1).range, '10-1000');
	assert.deepEqual(h.agentRanges([{ game : 'Dragon-Tiger', type : 'vip', ranges : ['v'] }, { game : 'Dragon-Tiger', type : 'normal', ranges : ['n'] }], 'n'), ['n']);
	assert.equal(h.agentRanges([{ game : 'Baccarat', type : 'normal', ranges : ['n'] }], 'n'), null);
});

test('channelContext formats like channel.blade.php', () => {
	const d = { min : '10', max : '1000', side_bet : [{ min : '10', max : '100' }] };
	const c = h.channelContext(d, [d, { min : '200', max : '50000' }], '10-1000', 1000, 1, 100);
	assert.equal(c.dispMin, '10K');
	assert.equal(c.dispMax, '1M');
	assert.equal(c.minFmt, '10,000');
	assert.equal(c.tieMaxFmt, '100,000');
	assert.deepEqual(c.ranges.map(r => [r.selected, r.maxFmt]), [[true, '1,000,000'], [false, '50,000,000']]);
});

test('paginator has the Laravel 5.4 toArray() keys', () => {
	const p = h.paginator([1, 2], 12, 2, 10, '/betlogs');
	assert.deepEqual(p, { total : 12, per_page : 10, current_page : 2, last_page : 2, next_page_url : null, prev_page_url : '/betlogs?page=1', from : 11, to : 12, data : [1, 2] });
	assert.equal(h.paginator([], 0, 1, 10, '/x').from, null);
});

test('json helpers', () => {
	assert.equal(h.jsonColumn({ a : 1 }), '{"a":1}');
	assert.equal(h.jsonColumn('{"a":1}'), '{"a":1}');
	assert.equal(h.jsonColumn(null), null);
	assert.deepEqual(h.jsonValue('{"a":1}'), { a : 1 });
	assert.equal(h.jsonValue('nope', 5), 5);
	assert.equal(h.scriptJson({ s : "</script>'" }), '{"s":"\\u003c/script>\\u0027"}');
	assert.equal(h.sqlDate(new Date('2026-10-31T01:02:03.456Z')), '2026-10-31 01:02:03');
	assert.equal(h.isEmpty({}), true);
	assert.equal(h.isEmpty({ a : 1 }), false);
});
