import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCH_MAX_AGE, LaunchRefused, encodePayload, launchQuery, signPayload, verifyLaunch } from '../src/lib/launch.ts';
import { hashPassword, verifyPassword } from '../src/lib/password.ts';

const SECRET = 'k'.repeat(40);
const NOW = 1_793_470_000;
const base = { user_id : 'p-1001', ts : NOW, nonce : 'n0nce-abcdefghijklmnop' };

const signed = (data: object, secret = SECRET) => {
	const payload = encodePayload(data);
	return [payload, signPayload(payload, secret)] as const;
};
const refused = (fn: () => unknown, reason: RegExp) => assert.throws(fn, (e: unknown) => e instanceof LaunchRefused && reason.test((e as Error).message));

test('a signed link opens the lobby by default', () => {
	const [payload, hash] = signed(base);
	assert.deepEqual(verifyLaunch(payload, hash, SECRET, NOW), {
		userId : 'p-1001', userName : null, ts : NOW, nonce : base.nonce, currency : null, lang : null, path : '/', lobbyUrl : null
	});
});

test('optional fields: name, currency, language, table, lobby url', () => {
	const [payload, hash] = signed({ ...base, user_name : ' Kim ', currency : 'KRW', lang : 'kr', game : 'poker', table : 2, lobby_url : 'https://casino.example/lobby' });
	const link = verifyLaunch(payload, hash, SECRET, NOW + 10);
	assert.equal(link.userName, 'Kim');
	assert.equal(link.currency, 'KRW');
	assert.equal(link.lang, 'kr');
	assert.equal(link.path, '/poker/2');
	assert.equal(link.lobbyUrl, 'https://casino.example/lobby');
	// an unknown language falls back instead of refusing the player
	const [p2, h2] = signed({ ...base, lang : 'xx' });
	assert.equal(verifyLaunch(p2, h2, SECRET, NOW).lang, null);
});

test('the signature covers the payload exactly, with the vendor secret', () => {
	const [payload, hash] = signed(base);
	refused(() => verifyLaunch(payload, hash, 'x'.repeat(40), NOW), /bad signature/);
	const [other] = signed({ ...base, user_id : 'someone-else' });
	refused(() => verifyLaunch(other, hash, SECRET, NOW), /bad signature/);
	refused(() => verifyLaunch(payload, hash.slice(0, 63), SECRET, NOW), /hash/);
	// upper-case hex is the same signature
	assert.equal(verifyLaunch(payload, hash.toUpperCase(), SECRET, NOW).userId, 'p-1001');
});

test('vendors without a long enough secret cannot launch', () => {
	const [payload, hash] = signed(base, 'short');
	refused(() => verifyLaunch(payload, hash, 'short', NOW), /no launch secret/);
	refused(() => verifyLaunch(payload, hash, '', NOW), /no launch secret/);
});

test('links expire either side of ts', () => {
	const [payload, hash] = signed(base);
	assert.ok(verifyLaunch(payload, hash, SECRET, NOW + LAUNCH_MAX_AGE));
	assert.ok(verifyLaunch(payload, hash, SECRET, NOW - LAUNCH_MAX_AGE));
	refused(() => verifyLaunch(payload, hash, SECRET, NOW + LAUNCH_MAX_AGE + 1), /expired/);
	refused(() => verifyLaunch(payload, hash, SECRET, NOW - LAUNCH_MAX_AGE - 1), /expired/);
});

test('bad fields are refused', () => {
	const cases: [object, RegExp][] = [
		[{ ...base, ts : 'soon' }, /ts/],
		[{ ...base, nonce : 'short' }, /nonce/],
		[{ ...base, user_id : '' }, /user_id/],
		[{ ...base, user_id : 'has space' }, /user_id/],
		[{ ...base, user_name : '   ' }, /user_name/],
		[{ ...base, currency : 'XXX' }, /currency/],
		[{ ...base, game : 'slots', table : 1 }, /game/],
		[{ ...base, game : 'poker' }, /table/],
		[{ ...base, game : 'poker', table : 0 }, /table/],
		[{ ...base, lobby_url : 'javascript:alert(1)' }, /lobby_url/],
		[{ ...base, lobby_url : 'not a url' }, /lobby_url/]
	];
	for (const [data, reason] of cases) {
		const [payload, hash] = signed(data);
		refused(() => verifyLaunch(payload, hash, SECRET, NOW), reason);
	}
	const notJson = Buffer.from('{oops').toString('base64url');
	refused(() => verifyLaunch(notJson, signPayload(notJson, SECRET), SECRET, NOW), /JSON/);
	const array = encodePayload([1]);
	refused(() => verifyLaunch(array, signPayload(array, SECRET), SECRET, NOW), /object/);
	refused(() => verifyLaunch('not base64!', signPayload('not base64!', SECRET), SECRET, NOW), /base64url/);
});

test('launchQuery builds what /launch reads', () => {
	const query = new URLSearchParams(launchQuery('demo-transfer', base, SECRET));
	assert.equal(query.get('vendor'), 'demo-transfer');
	assert.equal(verifyLaunch(query.get('payload')!, query.get('hash')!, SECRET, NOW).userId, 'p-1001');
});

test('passwords: the admin format verifies, everything else fails', async () => {
	const stored = await hashPassword('correct horse');
	assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
	assert.equal(await verifyPassword('correct horse', stored), true);
	assert.equal(await verifyPassword('correct horsE', stored), false);
	for (const bad of [null, undefined, '', 'plain-text', '$2y$10$abcdefghijklmnopqrstuv', 'scrypt$zz$zz', 42]) {
		assert.equal(await verifyPassword('anything', bad), false, String(bad));
	}
});
