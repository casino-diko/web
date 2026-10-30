import { handler } from '@/lib/http';
import { setRoomInfo } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(setRoomInfo);
export const POST = route;
