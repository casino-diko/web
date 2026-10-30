import { handler } from '@/lib/http';
import { checkTable } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(checkTable);
export const POST = route;
