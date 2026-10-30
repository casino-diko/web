import { handler } from '@/lib/http';
import { checkReject } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(checkReject);
export const GET = route;
