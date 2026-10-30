import { handler } from '@/lib/http';
import { getGameHistory } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getGameHistory);
export const GET = route;
export const POST = route;
