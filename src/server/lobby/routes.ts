/*
 |--------------------------------------------------------------------------
 | lobby routes
 |--------------------------------------------------------------------------
 | Port of lobby/routes/web.php for the kept features. Paths are as the
 | browser requests them ("/getLogs"); src/middleware.ts rewrites them to
 | /lobby/..., where src/app/lobby/[[...path]]/route.ts dispatches here.
 |
 | Not ported: /test, /test/dollar, /test/dollar2 (auto-login), /betsoft/*,
 | /kaga/*, /kagalogs, the sicbo / pulaputi / bigwheel / paigow logs and
 | details, /3 (web 2.0 page) and the /non (no-install page) group.
 | /logout is the shared src/app/logout route.
 |
 */

import { handler } from '@/lib/http';
import * as c from './controller.ts';

type Fn = (req: Request, params: Record<string, string>) => any;
type Route = { methods : string[]; fn : Fn };

const GET = ['GET'];
const POST = ['POST'];
const ANY = ['GET', 'POST'];

// routes of the "/" group that the "/m" (mobile) group repeats
const logs: Record<string, Route> = {
	'/transferlogs'                 : { methods : ANY, fn : c.getTransferLogs },
	'/supersixlogs'                 : { methods : ANY, fn : c.getSupersixBetLogs },
	'/dragonbonuslogs'              : { methods : ANY, fn : c.getDragonBonusBetLogs },
	'/bonuspluslogs'                : { methods : ANY, fn : c.getBonusPlusBetLogs },
	'/details/getBaccaratDetails'   : { methods : POST, fn : c.getBaccaratDetails },
	'/details/getSupersixDetails'   : { methods : POST, fn : c.getSupersixDetails },
	'/details/getDragonBonusDetails': { methods : POST, fn : c.getDragonBonusDetails },
	'/details/getPokerDetails'      : { methods : POST, fn : c.getPokerDetails },
	'/details/getBonusPlusDetails'  : { methods : POST, fn : c.getBonusPlusDetails },
	'/details/getDragontigerDetails': { methods : POST, fn : c.getDragontigerDetails }
};

export const ROUTES: Record<string, Route> = {
	'/rejected'           : { methods : GET, fn : c.checkReject },

	'/getUserMoney'       : { methods : POST, fn : c.getUserMoney },
	'/settings'           : { methods : POST, fn : c.setUserConfig },
	'/settingGame'        : { methods : POST, fn : c.setLastGameInfo },
	'/setTableInfo'       : { methods : POST, fn : c.setJunketTableInfo },

	'/'                   : { methods : GET, fn : c.index3 },
	'/getDealerImg'       : { methods : POST, fn : c.getDealerImg },
	'/getChangeDealerImg' : { methods : POST, fn : c.getChangeDealerImg },
	'/alllogs'            : { methods : ANY, fn : c.getAllLogs },
	...logs,
	'/getLogs'            : { methods : ANY, fn : c.getGameLogs },
	'/setRoomData'        : { methods : ANY, fn : c.setRoomData },
	'/checkPass'          : { methods : ANY, fn : c.checkPass },
	'/canCreateRoom'      : { methods : ANY, fn : c.canCreateRoom },

	// version 3 mobile
	'/m'                  : { methods : GET, fn : c.indexMobile3 },
	'/m/alllogs'          : { methods : ANY, fn : c.getAllLogsMobile },
	'/m/baccaratlogs'     : { methods : ANY, fn : c.getBaccaratBetLogs },
	'/m/pokerlogs'        : { methods : ANY, fn : c.getPokerBetLogs },
	'/m/dragontigerlogs'  : { methods : ANY, fn : c.getDragontigerBetLogs },
	...Object.fromEntries(Object.entries(logs).map(([path, route]) => [`/m${path}`, route]))
};

const handlers = new Map(Object.entries(ROUTES).map(([path, r]) => [path, { methods : r.methods, run : handler(r.fn) }]));

/** "/lobby/m/alllogs" -> "/m/alllogs" (trailing slashes ignored, like Laravel) */
export const routePath = (segments: string[] | undefined) =>
	'/' + (segments || []).filter(Boolean).join('/');

export async function dispatch (req: Request, segments: string[] | undefined): Promise<Response> {
	const route = handlers.get(routePath(segments));
	if (!route) return new Response('Not Found', { status : 404, headers : { 'content-type' : 'text/plain' } });
	if (!route.methods.includes(req.method === 'HEAD' ? 'GET' : req.method)) {
		return new Response('Method Not Allowed', { status : 405, headers : { allow : route.methods.join(', ') } });
	}
	return route.run(req, { params : Promise.resolve({}) });
}
