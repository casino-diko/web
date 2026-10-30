import { handler } from '@/lib/http';
import { getUser } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getUser);
export const POST = route;
