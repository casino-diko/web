import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET () {
	try {
		const db = await getDb();
		await db.shared.connection.db.admin().ping();
		return Response.json({ status : 'ok' });
	} catch (e) {
		return Response.json({ status : 'error', message : (e as Error).message }, { status : 503 });
	}
}
