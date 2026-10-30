// GET, POST /poker/m/Poker/{table}/{range}/betlogs -> PokerController@getBetLogs
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(poker.getBetLogs);
export const POST = handler(poker.getBetLogs);
