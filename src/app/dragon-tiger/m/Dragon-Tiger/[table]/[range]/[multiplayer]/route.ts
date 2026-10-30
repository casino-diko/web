import { handler } from '@/lib/http';
import { initMobile } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(initMobile);
export const GET = route;
