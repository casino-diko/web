import { handler } from '@/lib/http';
import { testCancel } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(testCancel);
export const POST = route;
