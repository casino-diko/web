import { handler } from '@/lib/http';
import * as baccarat from '@/server/baccarat/controller';

export const dynamic = 'force-dynamic';

export const GET = handler(baccarat.init);
