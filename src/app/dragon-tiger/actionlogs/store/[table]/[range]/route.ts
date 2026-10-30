import { handler } from '@/lib/http';
import { actionLogs } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(actionLogs);
export const POST = route;
