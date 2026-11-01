/*
 |--------------------------------------------------------------------------
 | asset versions
 |--------------------------------------------------------------------------
 | Game files are cached by browsers (src/app/legacy-assets: an hour, then
 | refreshed in the background), so after an update a player would keep
 | running the old bundle. Every rendered page links its own scripts and
 | stylesheets with ?v=<the file's modification time>: a changed file gets
 | a new URL and is fetched at once. The asset routes ignore the query.
 |
 | Links are root-relative, with the app prefix (/poker/dist/poker.min.js)
 | or without it (/dist/main-3.0.js: the page's app, see src/middleware.ts).
 |
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import type { App } from './config';

const PUBLIC = path.join(process.cwd(), 'public');
const APPS = ['lobby', 'baccarat', 'dragon-tiger', 'poker'];

const LINK = /\b(src|href)(\s*=\s*)"(\/[^"?#]+\.(?:js|css))"/g;

function version (file: string): string | null {
	try {
		return Math.floor(statSync(file).mtimeMs).toString(36);
	} catch {
		return null;
	}
}

/** the page's own .js / .css links with ?v=<modification time>; links to missing files stay as they are */
export function withAssetVersions (html: string, app: App): string {
	return html.replace(LINK, (whole, attr, eq, url) => {
		const first = url.split('/')[1];
		const file = APPS.includes(first) || first === 'shared'
			? path.join(PUBLIC, url)
			: path.join(PUBLIC, app, url);
		if (!file.startsWith(PUBLIC + path.sep)) return whole;
		const v = version(file);
		return v ? `${attr}${eq}"${url}?v=${v}"` : whole;
	});
}
