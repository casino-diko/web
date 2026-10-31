/*
 |--------------------------------------------------------------------------
 | player passwords
 |--------------------------------------------------------------------------
 | users.password as the admin back-office writes it (backend repo:
 | admin/src/lib/players.ts): `scrypt$<salt hex>$<hash hex>`, scrypt with
 | Node's defaults (N 16384, r 8, p 1) and a 64 byte key. Anything else in
 | the field (an empty value, a hash from the old system) never matches.
 |
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

const scrypt = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) =>
	scryptCb(password, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword (password: string): Promise<string> {
	const salt = randomBytes(16);
	return `scrypt$${salt.toString('hex')}$${(await scrypt(password, salt)).toString('hex')}`;
}

// checked when the login id is unknown, so a wrong id takes as long as a wrong password
const DUMMY = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(KEYLEN * 2);

/** true when `password` matches the stored value; `stored` null or malformed is checked against a dummy and fails */
export async function verifyPassword (password: string, stored: unknown): Promise<boolean> {
	const parts = typeof stored === 'string' ? stored.split('$') : [];
	const usable = parts.length === 3 && parts[0] === 'scrypt' && /^[0-9a-f]{32}$/.test(parts[1]) && /^[0-9a-f]{128}$/.test(parts[2]);
	const [, salt, hash] = (usable ? parts : DUMMY.split('$'));
	const key = await scrypt(String(password ?? ''), Buffer.from(salt, 'hex'));
	return timingSafeEqual(key, Buffer.from(hash, 'hex')) && usable;
}
