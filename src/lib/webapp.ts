/*
 |--------------------------------------------------------------------------
 | home-screen app
 |--------------------------------------------------------------------------
 | What makes the site installable on phones: the web app manifest
 | (/manifest.webmanifest), icons in public/shared/app, and a service worker
 | (public/sw.js) that only shows public/shared/app/offline.html when a page
 | can't load; it caches nothing else, so it can't serve stale game files.
 |
 | APP_HEAD goes into the <head> of every rendered page (template.ts).
 |
 */

import { config } from './config';

const esc = (v: string) => v.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export const THEME_COLOR = '#111111';

export const APP_HEAD = [
	'<link rel="manifest" href="/manifest.webmanifest">',
	`<meta name="theme-color" content="${THEME_COLOR}">`,
	'<link rel="apple-touch-icon" href="/shared/app/apple-touch-icon.png">',
	'<meta name="mobile-web-app-capable" content="yes">',
	'<meta name="apple-mobile-web-app-capable" content="yes">',
	'<meta name="apple-mobile-web-app-status-bar-style" content="black">',
	`<meta name="apple-mobile-web-app-title" content="${esc(config.appName)}">`,
	'<script>if("serviceWorker" in navigator)addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){})})</script>'
].join('\n');

/** adds APP_HEAD right after the first <head>; fragments without one stay as they are */
export const withAppHead = (html: string) => html.replace(/<head(\s[^>]*)?>/i, m => `${m}\n${APP_HEAD}`);

export function manifest () {
	return {
		name             : config.appName,
		short_name       : config.appName,
		id               : '/',
		start_url        : '/',
		scope            : '/',
		display          : 'fullscreen',
		display_override : ['fullscreen', 'standalone'],
		background_color : THEME_COLOR,
		theme_color      : THEME_COLOR,
		icons            : [
			{ src : '/shared/app/icon-192.png', sizes : '192x192', type : 'image/png' },
			{ src : '/shared/app/icon-512.png', sizes : '512x512', type : 'image/png' },
			{ src : '/shared/app/icon-maskable-512.png', sizes : '512x512', type : 'image/png', purpose : 'maskable' }
		]
	};
}
