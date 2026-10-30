import { handler } from '@/lib/http';
import { getDetails } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getDetails);
export const POST = route;
