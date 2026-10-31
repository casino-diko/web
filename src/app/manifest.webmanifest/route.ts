import { getDb } from '@/lib/db';
import { manifest } from '@/lib/webapp';

export const dynamic = 'force-dynamic';

export async function GET () {
	await getDb(); // the brand name is current
	return new Response(JSON.stringify(manifest()), {
		headers : { 'content-type' : 'application/manifest+json', 'cache-control' : 'no-cache' }
	});
}
