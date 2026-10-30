import { handler } from '@/lib/http';
import { getJunketLogs } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getJunketLogs);
export const POST = route;
