import { handler } from '@/lib/http';
import { getTotalWin } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getTotalWin);
export const POST = route;
