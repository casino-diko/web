import { config } from '@/lib/config';
import { clearSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function logout () {
	await clearSession();
	return new Response(null, { status : 303, headers : { location : config.devLogin ? '/login' : '/rejected' } });
}

export const GET = logout;
export const POST = logout;
