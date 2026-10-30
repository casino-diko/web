/*
 |--------------------------------------------------------------------------
 | dev login
 |--------------------------------------------------------------------------
 | Pick any user from the shared users collection. Only available with
 | DEV_LOGIN=true; the real vendor launch flow is not implemented yet.
 |
 */

import { config } from '@/lib/config';
import { getDb } from '@/lib/db';
import { input } from '@/lib/http';
import { LOCALES } from '@/lib/i18n';
import { writeSession } from '@/lib/session';
import { htmlResponse } from '@/lib/template';

export const dynamic = 'force-dynamic';

const notFound = () => new Response('Not Found', { status : 404 });

const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export async function GET () {
	if (!config.devLogin) return notFound();

	const db = await getDb();
	const users: any[] = await db.shared.users.find({ deleted_at : null }).sort({ _id : 1 }).limit(200).lean();
	const vendors = new Map((await db.shared.vendors.find({}).lean()).map((v: any) => [v._id, v]));

	const rows = users.map(u => {
		const v: any = vendors.get(u.vendor_id) || {};
		return `<tr><td>${u._id}</td><td>${esc(u.user_name)}</td><td>${esc(v.vendor_name)} (${esc(v.integration_type)})</td>`
			+ `<td>${esc(u.money)} ${esc(u.currency || v.currency)}</td>`
			+ `<td><button name="uid" value="${u._id}">Log in</button></td></tr>`;
	}).join('');

	return htmlResponse(`<!doctype html><html><head><meta charset="utf-8"><title>Dev login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#111;color:#eee}table{border-collapse:collapse}
td,th{padding:6px 12px;border-bottom:1px solid #333;text-align:left}button{cursor:pointer}</style></head>
<body><h1>Dev login</h1><p>Development only (DEV_LOGIN=true). Seed users with <code>docker compose run --rm seed</code>.</p>
<form method="post"><p>Language <select name="locale">${LOCALES.map(l => `<option>${l}</option>`).join('')}</select></p>
<table><tr><th>id</th><th>user</th><th>vendor</th><th>money</th><th></th></tr>${rows || '<tr><td colspan="5">no users</td></tr>'}</table>
</form></body></html>`);
}

export async function POST (req: Request) {
	if (!config.devLogin) return notFound();

	const data = await input(req);
	const uid = parseInt(data.uid);
	const db = await getDb();
	if (!Number.isInteger(uid) || !(await db.shared.users.exists({ _id : uid }))) {
		return new Response('unknown user', { status : 422 });
	}

	await writeSession({ uid, locale : LOCALES.includes(data.locale) ? data.locale : 'en' });
	return new Response(null, { status : 303, headers : { location : '/' } });
}
