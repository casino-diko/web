import { handler } from '@/lib/http';
import { getDealerImg } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(getDealerImg);
export const POST = route;
