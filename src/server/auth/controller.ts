/*
 |--------------------------------------------------------------------------
 | player sign-in
 |--------------------------------------------------------------------------
 | Three ways in, all ending in the same session cookie (lib/session.ts):
 |
 |   GET  /launch      an operator's signed link (lib/launch.ts): the player
 |                     is created on the first visit, then sent to the lobby
 |                     or a table
 |   POST /login       login id + password, for players the admin
 |                     back-office created with a password; 5 wrong
 |                     passwords lock the account for 15 minutes
 |   POST /login/dev   any player, only with DEV_LOGIN=true
 |
 | Logout sends the player back to the operator's site when the launch gave
 | one (users.pc_redirect_url / mo_redirect_url), else to /login.
 |
 */

import { config } from '@/lib/config';
import { getDb } from '@/lib/db';
import { clientIp, input, isMobile } from '@/lib/http';
import { LAUNCH_MAX_AGE, LaunchRefused, verifyLaunch } from '@/lib/launch';
import { verifyPassword } from '@/lib/password';
import { clearSession, readSession, writeSession } from '@/lib/session';
import { htmlResponse } from '@/lib/template';

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const redirect = (location: string) => new Response(null, { status : 303, headers : { location } });

const page = (title: string, body: string, status = 200) => htmlResponse(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px system-ui,sans-serif;margin:0;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{width:min(340px,100% - 32px)}h1{font-size:22px;margin:0 0 20px}label{display:block;margin:0 0 14px}
input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px;font:inherit;color:inherit;background:#1d1d1d;border:1px solid #444;border-radius:6px}
button{width:100%;padding:11px;font:inherit;font-weight:600;color:#111;background:#e6c96a;border:0;border-radius:6px;cursor:pointer}
.error{color:#ff8a7a;margin:0 0 14px}.muted{color:#999;font-size:13px;margin-top:18px}a{color:#e6c96a}</style></head>
<body><main>${body}</main></body></html>`, status);

function loginForm (error = '', userId = '') {
	return page('Sign in', `<h1>Sign in</h1>
<form method="post" action="/login">
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<label>Login id<input name="user_id" value="${esc(userId)}" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>
${config.devLogin ? '<p class="muted">Development: <a href="/login/dev">pick any player</a></p>' : ''}`, error ? 401 : 200);
}

/** GET /login */
export async function loginPage () {
	if (await readSession()) return redirect('/');
	return loginForm();
}

/** POST /login: login id + password */
export async function login (req: Request) {
	const data = await input(req);
	const userId = String(data.user_id ?? '').trim().slice(0, 64);
	const password = String(data.password ?? '');
	const wrong = () => loginForm('Wrong login id or password.', userId);
	if (!userId || !password) return wrong();

	const db = await getDb();
	const { users, vendors } = db.shared;
	const now = new Date();

	// a login id is unique per vendor only: try every player that has it and a password
	const candidates: any[] = await users.find({ user_id : userId, deleted_at : null, password : { $type : 'string' } }).limit(10).lean();
	if (!candidates.length) {
		await verifyPassword(password, null); // same time as a wrong password
		return wrong();
	}

	let matched: any = null;
	let locked: Date | null = null;
	for (const user of candidates) {
		if (user.locked_until && new Date(user.locked_until) > now) {
			locked = new Date(user.locked_until);
			continue;
		}
		if (await verifyPassword(password, user.password)) {
			matched = user;
			break;
		}
		const after: any = await users.findOneAndUpdate({ _id : user._id }, { $inc : { login_failures : 1 } }, { new : true, projection : { login_failures : 1 } }).lean();
		if (after && after.login_failures >= MAX_FAILURES) {
			locked = new Date(now.getTime() + LOCK_MINUTES * 60_000);
			await users.updateOne({ _id : user._id }, { $set : { locked_until : locked, login_failures : 0 } });
			console.warn(`[login] user ${user._id} locked after ${MAX_FAILURES} wrong passwords`);
		}
	}

	if (!matched) {
		if (locked) {
			const minutes = Math.max(1, Math.ceil((locked.getTime() - now.getTime()) / 60_000));
			return loginForm(`Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, userId);
		}
		return wrong();
	}

	const vendor: any = await vendors.findById(matched.vendor_id, { is_active : 1 }).lean();
	if (matched.is_active === '0' || !vendor || vendor.is_active === '0') {
		return loginForm('This account is disabled. Please contact support.', userId);
	}

	await users.updateOne({ _id : matched._id }, {
		$set   : { login_failures : 0, last_login_at : now, connect_ip : clientIp(req) },
		$unset : { locked_until : 1 }
	});
	await writeSession({ uid : matched._id, locale : 'en' });
	return redirect('/');
}

const refused = () => page('Link expired', `<h1>This link has expired</h1>
<p>Please open the game again from your casino's site.</p>`, 403);

/** GET /launch?vendor=&payload=&hash= : an operator's signed link (lib/launch.ts) */
export async function launch (req: Request) {
	const query = new URL(req.url).searchParams;
	const vendorName = query.get('vendor') || '';
	const ip = clientIp(req);
	const refuse = (reason: string) => {
		console.warn(`[launch] refused vendor=${JSON.stringify(vendorName.slice(0, 64))} ip=${ip}: ${reason}`);
		return refused();
	};

	const db = await getDb();
	const { users, vendors, launchNonces } = db.shared;

	const vendor: any = vendorName ? await vendors.findOne({ vendor_name : vendorName }).lean() : null;
	if (!vendor) return refuse('unknown vendor');
	if (vendor.is_active === '0') return refuse('vendor inactive');

	let link;
	try {
		link = verifyLaunch(query.get('payload') || '', query.get('hash') || '', vendor.secret_key || '', Math.floor(Date.now() / 1000));
	} catch (e) {
		if (e instanceof LaunchRefused) return refuse(e.message);
		throw e;
	}

	// each nonce once; the record outlives the link's age window, then MongoDB drops it
	try {
		await launchNonces.create({ _id : `${vendor._id}:${link.nonce}`, expires_at : new Date((link.ts + LAUNCH_MAX_AGE + 60) * 1000) });
	} catch (e: any) {
		if (e && e.code === 11000) return refuse('nonce already used');
		throw e;
	}

	const now = new Date();
	const set: Record<string, unknown> = { connect_ip : ip, last_login_at : now };
	if (link.userName) set.user_name = link.userName;
	if (link.lobbyUrl) set.pc_redirect_url = set.mo_redirect_url = link.lobbyUrl;

	let user: any = await users.findOneAndUpdate({ vendor_id : vendor._id, user_id : link.userId, deleted_at : null }, { $set : set }, { new : true }).lean();
	if (!user) {
		const id = await db.shared.nextId('users');
		user = await users.findOneAndUpdate(
			{ vendor_id : vendor._id, user_id : link.userId, deleted_at : null },
			{
				$set         : set,
				$setOnInsert : {
					_id          : id,
					// a field in both $set and $setOnInsert is a conflict: the name is in `set` when given
					...(link.userName ? {} : { user_name : link.userId }),
					money        : 0,
					currency     : link.currency || vendor.currency || null,
					user_type    : 'C',
					denomination : 1,
					is_active    : '1',
					is_online    : '0',
					created_ip   : ip,
					created_by   : 'launch'
				}
			},
			{ new : true, upsert : true }
		).lean();
		if (user._id === id) console.log(`[launch] created player ${id} for vendor ${vendor._id} (${link.userId})`);
	}
	if (user.is_active === '0') return refuse(`player ${user._id} is disabled`);

	await writeSession({ uid : user._id, locale : link.lang || 'en' });
	return redirect(link.path);
}

/** GET|POST /logout: back to the operator's site when there is one */
export async function logout (req: Request) {
	const session = await readSession();
	let back = config.devLogin ? '/login/dev' : '/login';
	if (session) {
		const db = await getDb();
		const user: any = await db.shared.users.findById(session.uid, { pc_redirect_url : 1, mo_redirect_url : 1 }).lean();
		const url = user && (isMobile(req) ? user.mo_redirect_url || user.pc_redirect_url : user.pc_redirect_url);
		if (url && /^https?:\/\//.test(url)) back = url;
	}
	await clearSession();
	return redirect(back);
}
