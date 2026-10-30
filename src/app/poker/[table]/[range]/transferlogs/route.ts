// GET, POST /poker/{table}/{range}/transferlogs -> PokerController@getTransferLogs
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(poker.getTransferLogs);
export const POST = handler(poker.getTransferLogs);
