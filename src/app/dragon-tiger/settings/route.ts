import { handler } from '@/lib/http';
import { setUserConfig } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(setUserConfig);
export const POST = route;
