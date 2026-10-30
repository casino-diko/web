// GET /poker/non/Poker/{table}/{range} -> PokerController@indexNonMobile
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(poker.indexNonMobile);
