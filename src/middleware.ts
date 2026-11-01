/*
 |--------------------------------------------------------------------------
 | app scoping
 |--------------------------------------------------------------------------
 | The four former Laravel apps (lobby, baccarat, dragon-tiger, poker) each
 | lived on their own domain and their compiled game scripts request assets
 | and API endpoints with root-relative urls ("/img/cards/1.png",
 | "/bet/store/1/2"). On one domain every app lives under its own prefix:
 |
 |   public/<app>/...          static files      -> /<app>/...
 |   src/app/<app>/...         pages + api routes -> /<app>/...
 |
 | An unprefixed request is rewritten into the app of the page that made it
 | (taken from the Referer, see Referrer-Policy in next.config.mjs); without
 | a game page as referer it belongs to the lobby, which is served at "/".
 | Unprefixed static files (any path with an extension) go through
 | src/app/legacy-assets/[app]/[...path].
 |
 */

import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { brandSlot } from '@/lib/brandSlots';
import { frameAncestors } from '@/lib/frame';

const GAME_APPS = ['baccarat', 'dragon-tiger', 'poker'];
const APPS = ['lobby', ...GAME_APPS];

// routes shared by every app
const GLOBAL = ['/login', '/logout', '/launch', '/exit', '/health', '/legacy-assets', '/manifest.webmanifest', '/sw.js',
	// public/shared: files used by every app (HLS video player)
	'/shared'];

// the games' lobby button ("/non?game=true" in a phone browser, "/m?game=true" in the app): always
// the lobby's, whichever game links there. isPageLoad() alone misses it: the home-screen app's
// service worker (public/sw.js) re-sends page loads with fetch(), which drops Sec-Fetch-Dest: document.
// No game has a page at exactly these paths (theirs are /non/<Game>/..., /m/<Game>/...).
const LOBBY_ENTRIES = ['/non', '/m'];

// static files are served by src/app/legacy-assets (see there why)
const isAsset = (pathname: string) => /\.[A-Za-z0-9]{1,8}$/.test(pathname);

const firstSegment = (pathname: string) => pathname.split('/')[1] || '';

// the games' files (several hundred per table): phones reuse their copy at once and
// fetch a changed one in the background, instead of asking about every file on every visit
const ASSET_CACHE = 'public, max-age=600, stale-while-revalidate=604800';

/*
 | Opening a page (a game's lobby button: "/non?game=true", "/m?game=true") is the lobby's,
 | whichever page linked to it. Browsers send Sec-Fetch-Dest only to https and localhost; on a
 | plain http address a page load is the request that asks for html first, and isn't jQuery's.
 */
const isPageLoad = (req: NextRequest): boolean => {
	const dest = req.headers.get('sec-fetch-dest');
	if (dest) return dest === 'document';
	return (req.headers.get('accept') || '').startsWith('text/html') && !req.headers.get('x-requested-with');
};

const appFromReferer = (req: NextRequest): string => {
	const referer = req.headers.get('referer');
	if (!referer) return 'lobby';

	try {
		const url = new URL(referer);
		// the host the browser used: req.nextUrl.host is the server's bind address in production
		const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || req.nextUrl.host;
		if (url.host !== host) return 'lobby';
		const segment = firstSegment(url.pathname);
		return APPS.includes(segment) ? segment : 'lobby';
	} catch {
		return 'lobby';
	}
};

/*
 | Who may frame the response (lib/frame.ts): our own pages, plus the operator
 | sites of a session launched with `embed`. /launch and /login answer before
 | there is a session and set their own.
 */
const OWN_FRAME_POLICY = ['/launch', '/login'];
const SESSION_COOKIE = process.env.SESSION_COOKIE || 'nihtan';

async function framers (req: NextRequest): Promise<string[]> {
	const token = req.cookies.get(SESSION_COOKIE)?.value;
	const secret = process.env.SESSION_SECRET || '';
	if (!token || secret.length < 32) return [];
	try {
		const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
		return Array.isArray(payload.embed) ? payload.embed.map(String) : [];
	} catch {
		return [];
	}
}

export async function middleware (req: NextRequest) {
	const res = route(req);
	if (!OWN_FRAME_POLICY.includes(req.nextUrl.pathname)) {
		res.headers.set('content-security-policy', frameAncestors(await framers(req)));
	}
	return res;
}

/** files that show the brand are drawn from the admin's settings (lib/brandSlots.ts) */
function brandRewrite (req: NextRequest, publicPath: string) {
	if (!brandSlot(publicPath)) return null;
	const url = req.nextUrl.clone();
	url.pathname = `/brand-asset/${publicPath}`;
	return NextResponse.rewrite(url);
}

function route (req: NextRequest) {
	const { pathname } = req.nextUrl;

	// a brand file, asked for with its app prefix (/lobby/img/x.png, /shared/app/icon-192.png)
	// or root-relative by a game page (/img/x.png, /favicon.ico: the Referer's app)
	if (isAsset(pathname)) {
		const prefixed = APPS.includes(firstSegment(pathname)) || firstSegment(pathname) === 'shared';
		const rewrite = brandRewrite(req, prefixed ? pathname.slice(1) : `${appFromReferer(req)}${pathname}`);
		if (rewrite) return rewrite;
		if (prefixed && req.method === 'GET') {
			const res = NextResponse.next();
			res.headers.set('Cache-Control', ASSET_CACHE);
			return res;
		}
	}

	if (GLOBAL.some(p => pathname === p || pathname.startsWith(p + '/'))) {
		return NextResponse.next();
	}

	// the lobby is the site root; /lobby/... urls are internal
	if (pathname === '/lobby' || pathname.startsWith('/lobby/')) {
		if (req.method === 'GET' && (pathname === '/lobby' || pathname === '/lobby/')) {
			return NextResponse.redirect(new URL('/', req.url));
		}
		return NextResponse.next();
	}

	if (GAME_APPS.includes(firstSegment(pathname))) {
		return NextResponse.next();
	}

	const app = pathname === '/' || LOBBY_ENTRIES.includes(pathname) || isPageLoad(req) ? 'lobby' : appFromReferer(req);
	const url = req.nextUrl.clone();
	url.pathname = isAsset(pathname)
		? `/legacy-assets/${app}${pathname}`
		: `/${app}${pathname === '/' ? '' : pathname}`;
	return NextResponse.rewrite(url);
}

export const config = {
	matcher: ['/((?!_next/).*)']
};
