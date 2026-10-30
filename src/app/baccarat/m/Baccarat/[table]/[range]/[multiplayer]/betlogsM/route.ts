import { handler } from '@/lib/http';
import * as baccarat from '@/server/baccarat/controller';

export const dynamic = 'force-dynamic';

const route = handler(baccarat.getBetLogsMobile);

export const GET = route;
export const POST = route;
