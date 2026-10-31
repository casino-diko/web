/*
 |--------------------------------------------------------------------------
 | i18n
 |--------------------------------------------------------------------------
 | Laravel translations converted to lang/<app>/<locale>.json
 | ({ "<file>": { "<key>": "text" } }). t('ingame.bet') behaves like
 | trans(): missing keys fall back to English, then to the key itself.
 | The former brand name in the texts becomes the current one (brandText.ts).
 |
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { App } from './config';
import { brandText } from './brandText';

export const LOCALES = ['en', 'kr', 'jp', 'zh', 'th'];
const FALLBACK = 'en';
const ROOT = path.join(process.cwd(), 'lang');
const cache = new Map<string, any>();

export function messages (app: App, locale: string): Record<string, any> {
	const loc = LOCALES.includes(locale) ? locale : FALLBACK;
	const key = `${app}/${loc}`;
	if (!cache.has(key)) {
		const file = path.join(ROOT, app, `${loc}.json`);
		cache.set(key, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
	}
	return cache.get(key);
}

const get = (obj: any, key: string) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function translator (app: App, locale: string) {
	const primary = messages(app, locale);
	const fallback = messages(app, FALLBACK);
	return (key: string, replace: Record<string, any> = {}) => {
		let text = get(primary, key) ?? get(fallback, key) ?? key;
		if (typeof text === 'string') {
			for (const [k, v] of Object.entries(replace)) text = text.replace(new RegExp(`:${k}\\b`, 'g'), String(v));
			text = brandText(text);
		}
		return text;
	};
}
