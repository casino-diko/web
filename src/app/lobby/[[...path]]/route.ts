/*
 | Every lobby page and endpoint (see src/server/lobby/routes.ts). The lobby
 | is served at "/" and its unprefixed urls are rewritten to /lobby/... by
 | src/middleware.ts; static files in public/lobby take precedence.
 */

import { dispatch } from '@/server/lobby/routes';

export const dynamic = 'force-dynamic';

type Ctx = { params : Promise<{ path? : string[] }> };

const route = async (req: Request, ctx: Ctx) => dispatch(req, (await ctx.params).path);

export const GET = route;
export const POST = route;
