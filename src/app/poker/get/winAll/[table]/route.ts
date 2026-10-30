// POST /poker/get/winAll/{table} -> PokerController@getAllWin
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const POST = handler(poker.getAllWin);
