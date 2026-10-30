import { handler } from '@/lib/http';
import { getAllWin } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getAllWin);
export const POST = route;
