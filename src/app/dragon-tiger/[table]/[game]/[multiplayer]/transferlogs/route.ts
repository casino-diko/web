import { handler } from '@/lib/http';
import { getTransferLogs } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

// [game] is the {range} segment (Next needs one slug name per level, [table]/[game] is init)
const route = handler(getTransferLogs);
export const GET = route;
export const POST = route;
