import { handler } from '@/lib/http';
import { setVideoSetting } from '@/server/dragon-tiger/controller';

export const dynamic = 'force-dynamic';

const route = handler(setVideoSetting);
export const POST = route;
