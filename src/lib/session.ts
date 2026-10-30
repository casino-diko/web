/*
 |--------------------------------------------------------------------------
 | session
 |--------------------------------------------------------------------------
 | Signed (HS256 JWT) cookie holding the logged in user id. Replaces the
 | Laravel session ("nihtan" cookie, sessions table).
 |
 */

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { config } from './config';

export type Session = { uid : number; locale? : string };

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
		return Number.isInteger(uid) ? { uid, locale : payload.locale as string | undefined } : null;
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

	(await cookies()).set(config.session.cookie, token, {
		httpOnly : true,
		sameSite : 'lax', // also our CSRF protection: no cross-site POST carries the cookie
		secure   : config.session.secure,
		path     : '/',
		maxAge   : config.session.maxAge
	});
}

export async function clearSession () {
	(await cookies()).delete(config.session.cookie);
}
