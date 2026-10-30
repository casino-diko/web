/*
 |--------------------------------------------------------------------------
 | vendor wallet
 |--------------------------------------------------------------------------
 | Port of the shared Laravel Controller helpers: balance lookups and money
 | movements for transfer vendors (money held in users.money) and seamless
 | vendors (money held by the vendor, reached through API_URL with an
 | HMAC-SHA256 of the JSON body signed with the vendor secret_key).
 |
 */

import { createHmac, createCipheriv, randomBytes } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { config } from './config';
import type { Db } from './db';

export const hash = (parameters: string, secret: string) =>
	createHmac('sha256', secret || '').update(parameters).digest('hex');

async function postSigned (path: string, data: object, secret: string): Promise<any> {
	if (!config.apiUrl) throw new Error('API_URL is not configured');

	const body = JSON.stringify(data);
	const res = await fetch(`${config.apiUrl}${path}?hash=${hash(body, secret)}`, {
		method  : 'POST',
		headers : { 'Content-Type' : 'application/json' },
		body,
		signal  : AbortSignal.timeout(10000)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${path} failed: ${res.status} ${text.slice(0, 200)}`);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Controller::getUserCredits */
export async function getUserCredits (db: Db, user: any, vendor: any): Promise<number> {
	if (vendor.integration_type === 'seamless') {
		try {
			const response = await postSigned('/api/check', {
				user_id     : user.user_id,
				user_name   : user.user_name,
				vendor_name : vendor.vendor_name
			}, vendor.secret_key);
			return Number(response) || 0;
		} catch (e) {
			console.log('seamless balance check failed:', (e as Error).message);
			return 0;
		}
	}

	const fresh: any = await db.shared.users.findById(user._id, { money : 1 }).lean();
	return fresh ? Number(fresh.money) || 0 : 0;
}

/** Controller::getJunketCredits */
export async function getJunketCredits (vendor: any, vendorName: string, users: any[] = []): Promise<any> {
	if (vendor.integration_type !== 'seamless') return vendor.integration_type;
	try {
		return await postSigned('/api/check/bulk', { vendor_name : vendorName, users }, vendor.secret_key);
	} catch (e) {
		console.log('seamless bulk check failed:', (e as Error).message);
		return 0;
	}
}

/** Controller::transact - seamless debit/credit through the vendor API (`game` was hard-coded per app) */
export async function transact (game: string, type: string, vendor: any, userId: number, data: Record<string, any>): Promise<boolean> {
	if (vendor.integration_type !== 'seamless') return true;
	try {
		const response = await postSigned(`/api/transact/${game}/${type}`, { ...data, id : userId }, vendor.secret_key);
		return response && response.status === 'ok';
	} catch (e) {
		console.log('seamless transact failed:', (e as Error).message);
		return false;
	}
}

/**
 * Controller::setMoney - transfer vendors only; 'bet' debits (refused when the
 * balance is too low, atomically), anything else credits.
 */
export async function setMoney (db: Db, type: string, user: any, vendor: any, amount: number, session: ClientSession | null = null): Promise<boolean> {
	if (vendor.integration_type === 'seamless') return true;

	const value = Math.abs(Number(amount) || 0);
	if (type === 'bet') {
		const res = await db.shared.users.updateOne({ _id : user._id, money : { $gte : value } }, { $inc : { money : -value } }, { session });
		return res.matchedCount === 1;
	}
	await db.shared.users.updateOne({ _id : user._id }, { $inc : { money : value } }, { session });
	return true;
}

/** Cryptor::encrypt (AES-128-CBC, iv + hmac + ciphertext, base64) used by Controller::parameterWithHash */
export function cryptorEncrypt (data: string, key: string): string {
	// openssl_encrypt pads/truncates the key to the cipher key length
	const k = Buffer.alloc(16);
	Buffer.from(key || '').copy(k);
	const iv = randomBytes(16);
	const cipher = createCipheriv('aes-128-cbc', k, iv);
	const raw = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
	const hmac = createHmac('sha256', key || '').update(raw).digest();
	return Buffer.concat([iv, hmac, raw]).toString('base64');
}

export const parameterWithHash = (data: Record<string, any>, secret: string) =>
	({ ...data, hash : cryptorEncrypt(JSON.stringify(data), secret) });
