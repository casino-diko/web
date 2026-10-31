import { login, loginPage } from '@/server/auth/controller';

export const dynamic = 'force-dynamic';

export const GET = () => loginPage();
export const POST = (req: Request) => login(req);
