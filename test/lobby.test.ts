/*
 | Pure helpers of the lobby port (no services needed):
 |   node --test --experimental-strip-types test/lobby.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeConfig, configLocale, viewConfig, applySettings, applyLastGameInfo, applyJunketTable, junketTable, parseJson, defaultConfig
} from '../src/server/lobby/userConfig.ts';
import { sqlDate, jsonText, row, paginator, pageNumber, int, num, publicOrigin, domains, dealerImageSrc } from '../src/server/lobby/format.ts';
import { gameTypeName, historyGame, historyRow, junketRange, SP_PAGE_SIZE } from '../src/server/lobby/history.ts';

test('parseJson accepts native objects, JSON text and nothing', () => {
	assert.deepEqual(parseJson({ a : 1 }), { a : 1 });
	assert.deepEqual(parseJson('{"a":1}'), { a : 1 });
	assert.equal(parseJson('not json', 'x'), 'x');
	assert.equal(parseJson(null, 'x'), 'x');
	assert.equal(parseJson('null', 'x'), 'x');
});

test('normalizeConfig fills what getUserConfig filled and survives missing configs', () => {
	const stored = JSON.stringify({ avarta : {
		default : { select : 1, data : ['red_queen', 'blue_king'] },
		language : { select : 9, data : ['english', 'korea'] },
		screen : { select : 0, data : ['black'] },
		sound : { voice : '0.5', effect : '1', volum : '1' }
	} });
	const c = normalizeConfig(stored);
	assert.equal(c.avarta.music, '1');
	assert.equal(c.avarta.sound.music, '0.2');
	assert.equal(c.avarta.language.select, 0, 'invalid select falls back to 0');
	assert.equal(configLocale(c), 'en');

	const fresh = normalizeConfig(undefined, 'kr');
	assert.equal(configLocale(fresh), 'kr', 'no config: the session locale');
	const garbage = normalizeConfig('garbage');
	assert.deepEqual(garbage.avarta.language, defaultConfig().avarta.language);
	assert.equal(viewConfig(garbage).tutorial, 'true');
});

test('viewConfig exposes the values the views printed', () => {
	const v = viewConfig(normalizeConfig({ avarta : { ...defaultConfig().avarta, tutorial : { enabled : 'false' }, music : '0' } }));
	assert.equal(v.default, 'red_queen');
	assert.equal(v.language, 'english');
	assert.equal(v.screen, 'black');
	assert.equal(v.tutorial, 'false');
	assert.equal(v.bgm, '0');
	assert.equal(v.sound.volum, '1');
	assert.ok(Array.isArray(v.raw.language));
	assert.equal(viewConfig(normalizeConfig({ avarta : { ...defaultConfig().avarta, tutorial : undefined } })).tutorial, 'true');
});

test('applySettings mirrors setUserConfig', () => {
	const c = applySettings(defaultConfig(), {
		volume : '0.3', voice : '0', music : '0.7', bgm : '0', tutorial : 'false', language : '2', screen : '1', range : '1-100', chips : ['1', '5'], bogus : 'x'
	});
	const a = c.avarta;
	assert.equal(a.sound.volum, '0.3');
	assert.equal(a.sound.voice, '0');
	assert.equal(a.sound.music, '0.7');
	assert.equal(a.music, '0');
	assert.equal(a.tutorial.enabled, 'false');
	assert.equal(a.language.select, '2');
	assert.equal(a.screen.select, '1');
	assert.equal(a.range, '1-100');
	assert.deepEqual(a.chips, ['1', '5']);
	assert.equal(a.bogus, undefined, 'unknown keys are ignored');
	assert.equal(configLocale(normalizeConfig(c)), 'jp');
});

test('applyLastGameInfo mirrors setLastGameInfo', () => {
	const v = applyLastGameInfo(null, { game : 'baccarat/1', range : '10-1000', slave : 'normal', multiplayer : '1' });
	assert.deepEqual(v, { game : 'baccarat/1', slave : '', multi_yn : '1', bet_range : '10-1000', multibet : [] });
	const w = applyLastGameInfo(JSON.stringify(v), { slave : 'supersix', data : [{ table : 1 }] });
	assert.equal(w.slave, 'supersix');
	assert.equal(w.game, 'baccarat/1');
	assert.deepEqual(w.multibet, [{ table : 1 }]);
});

test('junket tables: legacy JSON text / PHP objects become lists, unique on add', () => {
	assert.deepEqual(junketTable(null), { created_room : [], disable_table : [] });
	assert.deepEqual(junketTable('{"created_room":{"0":"a","2":"b"},"disable_table":[]}').created_room, ['a', 'b']);
	let r = applyJunketTable(null, 'disable_table', 'baccarat-1', true);
	r = applyJunketTable(r.table, 'disable_table', 'baccarat-1', true);
	assert.deepEqual(r.list, ['baccarat-1']);
	r = applyJunketTable(r.table, 'disable_table', 'baccarat-1', false);
	assert.deepEqual(r.list, []);
	assert.equal(applyJunketTable(null, 'evil', 'x', true).changed, false);
});

test('format helpers', () => {
	assert.equal(sqlDate(new Date(Date.UTC(2024, 0, 2, 3, 4, 5))), '2024-01-02 03:04:05');
	assert.equal(sqlDate(null), null);
	assert.equal(jsonText({ a : 1 }), '{"a":1}');
	assert.equal(jsonText('{"a":1}'), '{"a":1}');
	assert.equal(jsonText(undefined), null);
	assert.deepEqual(row({ _id : 3, created_at : new Date(Date.UTC(2024, 0, 1)), x : 1 }), { id : 3, created_at : '2024-01-01 00:00:00', x : 1 });
	assert.equal(pageNumber('2'), 2);
	assert.equal(pageNumber('0'), 1);
	assert.equal(pageNumber('x'), 1);
	assert.equal(int('12abc'), 12);
	assert.equal(int(undefined), 0);
	assert.equal(num(null, 7), 7);
	assert.equal(num('3', 7), 3);
});

test('paginator has the Laravel 5.4 shape', () => {
	const p = paginator([{ a : 1 }, { a : 2 }], 12, 2, 10, 'http://x/supersixlogs');
	assert.deepEqual(Object.keys(p), ['total', 'per_page', 'current_page', 'last_page', 'next_page_url', 'prev_page_url', 'from', 'to', 'data']);
	assert.equal(p.last_page, 2);
	assert.equal(p.next_page_url, null);
	assert.equal(p.prev_page_url, 'http://x/supersixlogs?page=1');
	assert.equal(p.from, 11);
	assert.equal(p.to, 12);
	const empty = paginator([], 0, 1, 10, '/x');
	assert.equal(empty.from, null);
	assert.equal(empty.last_page, 1);
});

test('origin and domains follow the proxy headers', () => {
	const req = new Request('http://localhost:3000/lobby', { headers : { 'x-forwarded-proto' : 'https', 'x-forwarded-host' : 'play.example.com' } });
	assert.equal(publicOrigin(req), 'https://play.example.com');
	assert.equal(publicOrigin(new Request('http://localhost:3101/lobby', { headers : { host : 'localhost:3101' } })), 'http://localhost:3101');
	assert.deepEqual(domains('https://a.b'), {
		lobbyDomain : 'https://a.b/', baccaratDomain : 'https://a.b/baccarat/', dragonTigerDomain : 'https://a.b/dragon-tiger/', pokerDomain : 'https://a.b/poker/'
	});
});

test('dealer images', () => {
	assert.equal(dealerImageSrc({ dealer_images : Buffer.from('abc') }), 'data:image/png;base64,YWJj');
	assert.equal(dealerImageSrc({ dealer_image : 'dealer1.png' }), 'dealer1.png');
	assert.equal(dealerImageSrc({ dealer_image : 'data:image/png;base64,xx' }), 'data:image/png;base64,xx');
	assert.equal(dealerImageSrc({ dealer_image : 'A'.repeat(100) }), `data:image/png;base64,${'A'.repeat(100)}`);
	assert.equal(dealerImageSrc({}), null);
});

test('history game names and labels', () => {
	assert.equal(historyGame('baccarat'), 'baccarat');
	assert.equal(historyGame('Dragon Tiger'), 'dragontiger');
	assert.equal(historyGame('dragon-tiger'), 'dragontiger');
	assert.equal(historyGame('Texas Hold\'em'), 'poker');
	assert.equal(historyGame('Super 6'), 'baccarat');
	assert.equal(historyGame('sicbo'), null);
	assert.equal(historyGame('paigow'), null);
	assert.equal(gameTypeName('baccarat', 's'), 'Super 6');
	assert.equal(gameTypeName('baccarat', 'f'), 'Flippy');
	assert.equal(gameTypeName('baccarat', 'b'), 'Baccarat');
	assert.equal(gameTypeName('poker', 'b'), 'Bonus Plus');
	assert.equal(gameTypeName('dragontiger', 'r'), 'Dragon Tiger');
	assert.equal(SP_PAGE_SIZE, 11);
});

test('historyRow has the procedure row shape the lobby JS reads', () => {
	const joined = {
		bet   : { _id : 7, round_id : 3, user_id : 1, type : 'r', total_bet : 100, total_win : 195, total_winning : 95, bet_history : [{ bet : 'banker', bet_money : 100, win_money : 195 }], created_at : new Date(Date.UTC(2024, 4, 1)), updated_at : new Date(Date.UTC(2024, 4, 1, 0, 1)) },
		round : { _id : 3, table_id : 1, round_num : 12, status : 'E', game_info : { banker1 : '0001' }, game_result : { winner : 'banker' } }
	};
	const list = historyRow('baccarat', joined, { cnt : 5, dealer : 'Anna' });
	assert.equal(list.cnt, 5);
	assert.equal(list.total_bet, 100);
	assert.equal(list.total_win, 95, 'net win / lose');
	assert.equal(list.game_type, 'Baccarat');
	assert.equal(list.dealer_name, 'Anna');
	assert.equal(list.updated_at, '2024-05-01 00:01:00');
	assert.equal(typeof list.bet_history, 'string');
	assert.equal(typeof list.game_info, 'string');
	assert.equal('type' in list, false, 'list rows label the channel with game_type');

	const detail = historyRow('baccarat', joined, { cnt : 1, detail : true, user : { user_id : 'p1', user_name : 'P' } });
	assert.equal(detail.type, 'r');
	assert.equal(detail.user_id, 'p1');

	const voided = historyRow('baccarat', { ...joined, round : { ...joined.round, status : 'W' } }, { cnt : 1 });
	assert.equal(voided.total_win, 0);
	assert.equal(voided.status, 'W');
});

test('junketRange converts local days to UTC', () => {
	// JST client: getTimezoneOffset() / 60 = -9
	const { from, to } = junketRange('2024-05-01', '2024-05-02', -9);
	assert.equal(from.toISOString(), '2024-04-30T15:00:00.000Z');
	assert.equal(to.toISOString(), '2024-05-02T15:00:00.000Z');
	assert.deepEqual(junketRange('0000-00-00 00', '0000-00-00 00', 0), { from : null, to : null });
	assert.deepEqual(junketRange(undefined, '', 0), { from : null, to : null });
});
