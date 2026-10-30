// GET /poker/m/Poker/{table}/{range}/{type} -> PokerController@indexMobile
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(poker.indexMobile);
