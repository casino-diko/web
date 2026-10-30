/*
 | Multi-table betting from the baccarat page (former baccarat routes/web.php,
 | bundled PokerController copy): served by the poker port.
 */

import { handler } from '@/lib/http';
import * as pk from '@/server/poker/controller';

export const dynamic = 'force-dynamic';

export const POST = handler(pk.setFoldCheck);
