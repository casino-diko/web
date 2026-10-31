/*
 |--------------------------------------------------------------------------
 | launch-link: a signed operator launch link, for testing /launch
 |--------------------------------------------------------------------------
 |   LAUNCH_SECRET=<the vendor's secret> npm run launch-link -- --vendor demo-transfer --user p-1001 \
 |     [--name "Kim"] [--game poker --table 1] [--lang kr] [--currency KRW] [--lobby https://...] [--site http://localhost:3000]
 |
 | The secret is the one the admin back-office's Vendors page generates. The
 | link works once and for LAUNCH_MAX_AGE seconds (src/lib/launch.ts).
 |
 */

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { LAUNCH_MAX_AGE, launchQuery } from '../src/lib/launch.ts';

const { values : a } = parseArgs({
	options : {
		vendor   : { type : 'string' },
		user     : { type : 'string' },
		name     : { type : 'string' },
		game     : { type : 'string' },
		table    : { type : 'string' },
		lang     : { type : 'string' },
		currency : { type : 'string' },
		lobby    : { type : 'string' },
		site     : { type : 'string', default : 'http://localhost:3000' }
	}
});

const secret = process.env.LAUNCH_SECRET || '';
if (!a.vendor || !a.user || !secret) {
	console.error('usage: LAUNCH_SECRET=<secret> npm run launch-link -- --vendor <vendor name> --user <player id> [--game poker --table 1] [--name ...] [--lang kr] [--currency KRW] [--lobby url]');
	process.exit(1);
}

const data = {
	user_id   : a.user,
	ts        : Math.floor(Date.now() / 1000),
	nonce     : randomBytes(16).toString('hex'),
	...(a.name && { user_name : a.name }),
	...(a.game && { game : a.game, table : Number(a.table || 1) }),
	...(a.lang && { lang : a.lang }),
	...(a.currency && { currency : a.currency }),
	...(a.lobby && { lobby_url : a.lobby })
};

console.log(`${a.site.replace(/\/+$/, '')}/launch?${launchQuery(a.vendor, data, secret)}`);
console.error(`valid once, for ${LAUNCH_MAX_AGE / 60} minutes`);
