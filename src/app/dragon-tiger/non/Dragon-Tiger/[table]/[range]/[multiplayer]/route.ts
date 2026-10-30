import { handler } from '@/lib/http';
import { initNonMobile } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(initNonMobile);
export const GET = route;
