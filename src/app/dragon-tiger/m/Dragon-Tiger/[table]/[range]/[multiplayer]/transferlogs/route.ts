import { handler } from '@/lib/http';
import { getTransferLogs } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getTransferLogs);
export const GET = route;
export const POST = route;
