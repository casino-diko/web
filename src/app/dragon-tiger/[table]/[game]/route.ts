import { handler } from '@/lib/http';
import { init } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(init);
export const GET = route;
