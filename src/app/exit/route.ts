import { exit } from '@/server/auth/controller';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => exit(req);
