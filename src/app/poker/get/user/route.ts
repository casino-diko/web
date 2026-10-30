// POST /poker/get/user -> PokerController@getUser
import * as poker from '@/server/poker/controller';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const POST = handler(poker.getUser);
