import { logout } from '@/server/auth/controller';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => logout(req);
export const POST = (req: Request) => logout(req);
