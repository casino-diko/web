/*
 | Multi-table betting from the baccarat page (former baccarat routes/web.php,
 | bundled DragonTigerController copy): served by the dragon-tiger port.
 */

import { handler } from '@/lib/http';
import * as dt from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

export const POST = handler(dt.testStore);
