/*
 |--------------------------------------------------------------------------
 | framing by operators
 |--------------------------------------------------------------------------
 | Who may show our pages in an iframe: our own pages, plus, for a session
 | launched with `embed` (lib/launch.ts), the operator sites in its vendor's
 | embed_origins. Sent as Content-Security-Policy frame-ancestors by
 | src/middleware.ts for every response, and by /launch and /login
 | themselves (they answer before a session exists).
 |
 | Pages inside an operator's frame talk to it with postMessage, always
 | { source : 'casino-diko', type, ... } (OPERATORS.md):
 |   exit             the player left (lobby button, logout); `url` = lobby_url
 |   unauthenticated  the session is gone (expired, signed out): launch again
 |   launch-refused   the launch link was refused (expired, reused, bad hash)
 |
 | No Node imports here: the middleware imports it.
 |
 */

export const MESSAGE_SOURCE = 'casino-diko';

/**
 * An operator site allowed to frame the games, as `scheme://host[:port]`,
 * or null. https only; http just for localhost, for testing.
 */
export function embedOrigin (value: unknown): string | null {
	try {
		const url = new URL(String(value ?? '').trim());
		const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
		if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
		return url.origin;
	} catch {
		return null;
	}
}

/** the valid, distinct origins of a stored list */
export const embedOrigins = (list: unknown): string[] =>
	[...new Set((Array.isArray(list) ? list : []).map(embedOrigin).filter((o): o is string => !!o))];

/** the Content-Security-Policy value: our pages, plus these operator sites */
export const frameAncestors = (origins: string[] = []) =>
	["frame-ancestors 'self'", ...embedOrigins(origins)].join(' ');

/** a script posting { source, type } to the operator's page when this page is in a frame */
export const postToOperator = (type: string, extra: Record<string, unknown> = {}) =>
	`<script>if(window.parent!==window)window.parent.postMessage(${JSON.stringify({ source : MESSAGE_SOURCE, type, ...extra }).replace(/</g, '\\u003c')},'*')</script>`;
