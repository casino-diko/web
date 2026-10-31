/*
 |--------------------------------------------------------------------------
 | operator-demo: an operator's page embedding the games, for testing
 |--------------------------------------------------------------------------
 |   LAUNCH_SECRET=<vendor secret> npm run operator-demo -- --vendor demo-transfer [--user demo-1]
 |     [--site http://localhost:3000] [--port 8090]
 |
 | Serves http://127.0.0.1:<port>/: a page that signs a launch link with
 | `embed: true` (as the operator's server would), shows it in an iframe and
 | logs the messages the games post (OPERATORS.md). 127.0.0.1 is a different
 | site from localhost, so the iframe is cross-site like a real operator's.
 | Add http://127.0.0.1:<port> to the vendor's embed sites (admin, Vendors).
 |
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { launchQuery } from '../src/lib/launch.ts';

const { values : a } = parseArgs({
	options : {
		vendor : { type : 'string' },
		user   : { type : 'string', default : 'demo-1' },
		site   : { type : 'string', default : 'http://localhost:3000' },
		port   : { type : 'string', default : '8090' }
	}
});
const secret = process.env.LAUNCH_SECRET || '';
if (!a.vendor || !secret) {
	console.error('usage: LAUNCH_SECRET=<secret> npm run operator-demo -- --vendor <vendor name> [--user demo-1] [--site http://localhost:3000] [--port 8090]');
	process.exit(1);
}
const site = a.site.replace(/\/+$/, '');
const origin = `http://127.0.0.1:${a.port}`;
const esc = (v: string) => v.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// the operator's server signs a fresh link for every page view
function launchUrl (game: string | null, table: number) {
	return `${site}/launch?${launchQuery(a.vendor!, {
		user_id   : a.user,
		user_name : `Demo ${a.user}`,
		ts        : Math.floor(Date.now() / 1000),
		nonce     : randomBytes(16).toString('hex'),
		embed     : true,
		lobby_url : `${origin}/`,
		...(game && { game, table })
	}, secret)}`;
}

const page = (src: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Operator demo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:14px system-ui,sans-serif;background:#f4f1ea;color:#222}header{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:#1d3b2a;color:#fff}
header a{color:#ffe08a}main{display:grid;grid-template-columns:1fr 320px;gap:12px;padding:12px}iframe{width:100%;height:min(80vh,760px);border:0;background:#000}
#log{background:#fff;border:1px solid #ccc;padding:8px;height:min(80vh,760px);overflow:auto;font:12px ui-monospace,monospace;white-space:pre-wrap}
@media (max-width:800px){main{grid-template-columns:1fr}#log{height:200px}}</style></head>
<body><header><strong>Demo casino</strong> (operator page, ${esc(origin)})
<a href="/">Lobby</a><a href="/?game=baccarat&table=1">Baccarat 1</a><a href="/?game=dragon-tiger&table=1">Dragon-Tiger 1</a><a href="/?game=poker&table=1">Poker 1</a></header>
<main><iframe id="games" src="${esc(src)}" allow="autoplay; fullscreen" allowfullscreen></iframe><div id="log">messages from the games:\\n</div></main>
<script>
// how an operator listens: check the origin and the source tag, then act on the type
var GAMES_ORIGIN = ${JSON.stringify(new URL(site).origin)};
window.addEventListener('message', function (event) {
	if (event.origin !== GAMES_ORIGIN || !event.data || event.data.source !== 'casino-diko') return;
	document.getElementById('log').textContent += new Date().toISOString().slice(11, 19) + ' ' + JSON.stringify(event.data) + '\\n';
	if (event.data.type === 'exit') document.getElementById('games').replaceWith(Object.assign(document.createElement('p'), { textContent : 'The player left the games (' + event.data.reason + '). A real operator shows its lobby here.' }));
	if (event.data.type === 'unauthenticated' || event.data.type === 'launch-refused') document.getElementById('log').textContent += '  -> a real operator signs a new launch link here\\n';
});
</script></body></html>`;

createServer((req, res) => {
	const url = new URL(req.url || '/', origin);
	if (url.pathname !== '/') { res.writeHead(404).end(); return; }
	const game = url.searchParams.get('game');
	res.writeHead(200, { 'content-type' : 'text/html; charset=utf-8' }).end(page(launchUrl(game, Number(url.searchParams.get('table') || 1))));
}).listen(Number(a.port), '127.0.0.1', () => {
	console.log(`operator demo: ${origin}/  (embedding ${site}; the vendor's embed sites must include ${origin})`);
});
