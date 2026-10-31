/*
 |--------------------------------------------------------------------------
 | auth
 |--------------------------------------------------------------------------
 | Former Laravel `auth` middleware + Auth::user().
 |
 |   export async function POST (req) {
 |     const auth = await requireUser(req);
 |     if (auth instanceof Response) return auth;
 |     const { user, vendor, db } = auth;
 |     ...
 |   }
 |
 */

import { getDb, type Db } from './db';
import { readSession } from './session';

export type AuthContext = { user : any; vendor : any; db : Db; locale : string };

export async function currentUser (): Promise<AuthContext | null> {
	const session = await readSession();
	if (!session) return null;

	const db = await getDb();
	const user: any = await db.shared.users.findById(session.uid).lean();
	if (!user || user.deleted_at) return null;

	const vendor: any = await db.shared.vendors.findById(user.vendor_id).lean();
	if (!vendor) return null;

	// Laravel rows exposed `id`; keep that for ported code and payloads
	user.id = user._id;
	vendor.id = vendor._id;

	return { user, vendor, db, locale : session.locale || 'en' };
}

const wantsJson = (req: Request) =>
	req.method !== 'GET'
	|| (req.headers.get('accept') || '').includes('application/json')
	|| req.headers.get('x-requested-with') === 'XMLHttpRequest';

/** the user, or the response Laravel's auth middleware would have sent */
export async function requireUser (req: Request): Promise<AuthContext | Response> {
	const auth = await currentUser();
	if (auth) return auth;

	if (wantsJson(req)) {
		return Response.json({ error : 'Unauthenticated.' }, { status : 401 });
	}
	// relative: req.url carries the server's bind address (0.0.0.0:3000), not the host the player used
	return new Response(null, { status : 302, headers : { location : '/login' } });
}
