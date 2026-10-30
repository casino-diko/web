/*
 |--------------------------------------------------------------------------
 | PHP-style request input
 |--------------------------------------------------------------------------
 | The legacy scripts post nested objects with jQuery ($.post(url, {data :
 | [{amount, table_id}], logs : [...]})), which arrive as
 | "data[0][amount]=10&data[0][table_id]=player". Laravel decoded that into
 | nested arrays; lib/http input() only knows "key[]", so the baccarat
 | handlers use this parser (query + JSON / urlencoded / multipart body).
 |
 */

import { parsePhpQuery, phpAssign, phpArrays } from './helpers';

export async function phpInput (req: Request): Promise<Record<string, any>> {
	const data: Record<string, any> = parsePhpQuery(new URL(req.url).search.slice(1));
	if (req.method === 'GET' || req.method === 'HEAD') return phpArrays(data);

	const type = req.headers.get('content-type') || '';
	try {
		if (type.includes('multipart/form-data')) {
			const form = await req.formData();
			for (const [key, value] of form.entries()) phpAssign(data, key, typeof value === 'string' ? value : value.name);
		} else {
			const text = await req.text();
			if (text) {
				if (type.includes('application/json') || /^\s*[{[]/.test(text)) {
					try {
						const json = JSON.parse(text);
						if (json && typeof json === 'object' && !Array.isArray(json)) Object.assign(data, json);
					} catch {
						parsePhpQuery(text, data);
					}
				} else {
					parsePhpQuery(text, data);
				}
			}
		}
	} catch {
		// empty / malformed body: behave like an empty Laravel request
	}
	return phpArrays(data);
}
