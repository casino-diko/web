import { handler } from '@/lib/http';
import { getUsers } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getUsers);
export const POST = route;
