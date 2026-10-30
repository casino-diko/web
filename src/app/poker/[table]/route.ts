// GET /poker/{table} -> PokerController@index
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(poker.index);
