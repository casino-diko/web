/*
 |--------------------------------------------------------------------------
 | session
 |--------------------------------------------------------------------------
 | Signed (HS256 JWT) cookie holding the logged in user id. Replaces the
 | Laravel session ("nihtan" cookie, sessions table).
 |
 | A session launched for an operator's iframe (`embed`, lib/launch.ts) holds
 | the operator sites allowed to frame it (src/middleware.ts) and lives in a
 | partitioned cookie: SameSite=None is what a cross-site iframe sends,
 | Partitioned keeps it per operator site so third-party cookie blocking
 | leaves it alone. Both need Secure (https; browsers treat localhost as
 | secure).
 |
 */

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { config } from './config';

export type Session = { uid : number; locale? : string; embed? : string[] };

const key = () => {
	if (config.session.secret.length < 32) {
		throw new Error('SESSION_SECRET must be at least 32 characters');
	}
	return new TextEncoder().encode(config.session.secret);
};

export async function readSession (): Promise<Session | null> {
	const token = (await cookies()).get(config.session.cookie)?.value;
	if (!token) return null;

	try {
		const { payload } = await jwtVerify(token, key());
		const uid = Number(payload.uid);
		if (!Number.isInteger(uid)) return null;
		const embed = Array.isArray(payload.embed) ? payload.embed.filter((o): o is string => typeof o === 'string') : [];
		return { uid, locale : payload.locale as string | undefined, ...(embed.length && { embed }) };
	} catch {
		return null;
	}
}

export async function writeSession (session: Session) {
	const token = await new SignJWT({ ...session })
		.setProtectedHeader({ alg : 'HS256' })
		.setIssuedAt()
		.setExpirationTime(`${config.session.maxAge}s`)
		.sign(key());

	const embedded = !!session.embed?.length;
	(await cookies()).set(config.session.cookie, token, {
		...cookieAttributes(embedded),
		maxAge : config.session.maxAge
	});
}

/** a partitioned cookie is only removed by a cookie with the same attributes */
export async function clearSession (session: Session | null = null) {
	(await cookies()).set(config.session.cookie, '', { ...cookieAttributes(!!session?.embed?.length), maxAge : 0 });
}

/**
 * lax is also our CSRF protection: no cross-site POST carries the cookie. An
 * embedded session's cookie is partitioned to the operator's site, so only
 * requests made inside that site carry it, and only the sites in its
 * frame-ancestors list can frame our pages.
 */
const cookieAttributes = (embedded: boolean) => ({
	httpOnly    : true,
	sameSite    : (embedded ? 'none' : 'lax') as 'none' | 'lax',
	secure      : embedded || config.session.secure,
	partitioned : embedded || undefined,
	path        : '/'
});
