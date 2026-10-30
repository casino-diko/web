// GET, POST /poker/m/Poker/{table}/{range}/gamehistory -> PokerController@getGameHistory
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(poker.getGameHistory);
export const POST = handler(poker.getGameHistory);
