import { manifest } from '@/lib/webapp';

export const dynamic = 'force-dynamic';

export const GET = () => new Response(JSON.stringify(manifest()), {
	headers : { 'content-type' : 'application/manifest+json', 'cache-control' : 'public, max-age=3600' }
});
