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

// embedded: launched into an operator's iframe (lib/launch.ts `embed`)
export type AuthContext = { user : any; vendor : any; db : Db; locale : string; embedded : boolean };

/**
 * A link back to the operator's site, as the pages and redirects use it. In
 * an embedded session it becomes /exit, which tells the operator's page
 * (postMessage) instead of loading their site inside the frame.
 */
export const viaExit = (auth: Pick<AuthContext, 'embedded'>, url: string | null | undefined) =>
	(auth.embedded && url ? '/exit' : url);

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

	return { user, vendor, db, locale : session.locale || 'en', embedded : !!session.embed?.length };
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
