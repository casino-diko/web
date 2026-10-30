import { handler } from '@/lib/http';
import { getBetLogs } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getBetLogs);
export const GET = route;
export const POST = route;
