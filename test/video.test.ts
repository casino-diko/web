import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableVideo } from '../src/lib/video.ts';

test('tableVideo: explicit env_setting.hls wins, sd falls back to hd, korea stream for KR', () => {
	process.env.HLS_URL_TEMPLATE = 'http://t/{app}-{table}.m3u8';
	assert.deepEqual(tableVideo('baccarat', 1, { hls : { hd : 'https://cdn/b1/hd.m3u8', sd : 'https://cdn/b1/sd.m3u8' } }),
		{ hd : 'https://cdn/b1/hd.m3u8', sd : 'https://cdn/b1/sd.m3u8' });
	assert.deepEqual(tableVideo('poker', 2, { hls : { hd : 'https://cdn/p2.m3u8' } }), { hd : 'https://cdn/p2.m3u8', sd : 'https://cdn/p2.m3u8' });
	assert.equal(tableVideo('poker', 2, { hls : { hd : 'https://cdn/p2.m3u8', korea : 'https://kr/p2.m3u8' } }, 'kr').hd, 'https://kr/p2.m3u8');
	delete process.env.HLS_URL_TEMPLATE;
});

test('tableVideo: url template placeholders', () => {
	process.env.HLS_URL_TEMPLATE = 'https://cdn/{game}/{app}/{table2}/{quality}.m3u8';
	assert.deepEqual(tableVideo('dragon-tiger', 3, '{"video":{"main":"rtmp://old/dt3"}}'),
		{ hd : 'https://cdn/Dragon-Tiger/dragon-tiger/03/hd.m3u8', sd : 'https://cdn/Dragon-Tiger/dragon-tiger/03/sd.m3u8' });
	delete process.env.HLS_URL_TEMPLATE;
});

test('tableVideo: legacy http fields are used, rtmp (flash only) is ignored', () => {
	delete process.env.HLS_URL_TEMPLATE;
	assert.deepEqual(tableVideo('baccarat', 1, { video : { main : 'rtmp://127.0.0.1/live/baccarat1' } }), { hd : '', sd : '' });
	assert.equal(tableVideo('baccarat', 1, { web_stream : 'http://cf/BC01/playlist.m3u8' }).hd, 'http://cf/BC01/playlist.m3u8');
	assert.equal(tableVideo('baccarat', 1, { web_stream : 'http://cf/web.m3u8', korea_stream : 'http://cf/kr.m3u8' }, 'KR').hd, 'http://cf/kr.m3u8');
	assert.deepEqual(tableVideo('poker', 1, null), { hd : '', sd : '' });
});
