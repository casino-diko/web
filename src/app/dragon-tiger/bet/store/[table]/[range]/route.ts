import { handler } from '@/lib/http';
import { testStore } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(testStore);
export const POST = route;
