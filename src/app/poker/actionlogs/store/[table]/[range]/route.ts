// POST /poker/actionlogs/store/{table}/{range} -> PokerController@actionLogs
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const POST = handler(poker.actionLogs);
