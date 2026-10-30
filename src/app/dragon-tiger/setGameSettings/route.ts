import { handler } from '@/lib/http';
import { setGameSettings } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(setGameSettings);
export const POST = route;
