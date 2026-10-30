import { handler } from '@/lib/http';
import { checkPassword } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(checkPassword);
export const POST = route;
