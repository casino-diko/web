/*
 |--------------------------------------------------------------------------
 | live video
 |--------------------------------------------------------------------------
 | HLS stream urls of a table, written into the game pages as
 | window.videostream_url (HD) and window.videostream_url_sd and played by
 | public/shared/video/tg-video.js.
 |
 | Per table, first match wins:
 |  1. game_tables.env_setting.hls : { hd, sd }   (sd optional, korea optional)
 |  2. HLS_URL_TEMPLATE, e.g. https://cdn.example.com/{app}/{table}/{quality}.m3u8
 |     placeholders: {app} (baccarat | dragon-tiger | poker), {game}
 |     (Baccarat | Dragon-Tiger | Poker), {table}, {table2} (zero padded),
 |     {quality} (hd | sd)
 |  3. the legacy fields web_stream / korea_stream / mobile_stream / video.main,
 |     when they are http(s) urls (rtmp:// was Flash only and is ignored)
 |
 */

import { GAME_NAMES, type GameApp } from './config.ts';

export type TableVideo = { hd : string; sd : string };

const playable = (url: unknown): string =>
	(typeof url === 'string' && /^(https?:)?\/\//i.test(url.trim())) ? url.trim() : '';

const fromTemplate = (template: string, app: GameApp, table: number, quality: 'hd' | 'sd') => template
	.replace(/\{app\}/g, app)
	.replace(/\{game\}/g, GAME_NAMES[app])
	.replace(/\{table\}/g, String(table))
	.replace(/\{table2\}/g, String(table).padStart(2, '0'))
	.replace(/\{quality\}/g, quality);

/**
 * @param envSetting game_tables.env_setting of the table (object or JSON text)
 * @param country    ISO country of the player (CF-IPCountry); KR may get its own stream
 */
export function tableVideo (app: GameApp, table: number | string, envSetting: any, country = ''): TableVideo {
	let env = envSetting;
	if (typeof env === 'string') {
		try { env = JSON.parse(env); } catch { env = {}; }
	}
	env = env || {};
	const tableNum = parseInt(String(table)) || 0;
	const korea = String(country).toUpperCase() === 'KR';

	const hls = env.hls || {};
	const explicitHd = playable(korea && hls.korea) || playable(hls.hd);
	if (explicitHd) return { hd : explicitHd, sd : playable(hls.sd) || explicitHd };

	const template = process.env.HLS_URL_TEMPLATE || '';
	if (template) {
		return { hd : fromTemplate(template, app, tableNum, 'hd'), sd : fromTemplate(template, app, tableNum, 'sd') };
	}

	const legacy = playable(korea && env.korea_stream) || playable(env.web_stream)
		|| playable(env.mobile_stream) || playable(env.video && env.video.main);
	return { hd : legacy, sd : legacy };
}
