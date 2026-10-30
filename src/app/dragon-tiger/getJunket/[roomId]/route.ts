import { handler } from '@/lib/http';
import { getJunketUsers } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getJunketUsers);
export const POST = route;
