// POST /poker/bet/setFoldCheck/{table} -> PokerController@setFoldCheck
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const POST = handler(poker.setFoldCheck);
