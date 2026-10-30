import { handler } from '@/lib/http';
import { getTotalBet } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getTotalBet);
export const POST = route;
