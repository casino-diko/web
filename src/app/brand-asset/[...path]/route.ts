/*
 | A brand slot (lib/brandSlots.ts) drawn for the current brand. src/middleware.ts
 | rewrites the original file's url here: /brand-asset/<path under public/>.
 */

import { getDb } from '@/lib/db';
import { brandAsset } from '@/lib/brandAssets';
import { brandSlot } from '@/lib/brandSlots';

export const dynamic = 'force-dynamic';

export async function GET (req: Request, ctx: { params : Promise<{ path : string[] }> }) {
	const publicPath = (await ctx.params).path.map(decodeURIComponent).join('/');
	const slot = brandSlot(publicPath);
	if (!slot) return new Response('Not Found', { status : 404 });

	const asset = await brandAsset(await getDb(), publicPath, slot);
	const etag = `"brand-${asset.version}-${asset.body.length}"`;
	const headers = {
		'content-type'  : asset.type,
		// revalidated every time (a 304 when unchanged): an admin change shows at once
		'cache-control' : 'no-cache',
		// /img/x.png is a different file per game (src/middleware.ts)
		vary            : 'Referer',
		etag
	};
	if (req.headers.get('if-none-match') === etag) return new Response(null, { status : 304, headers });
	return new Response(new Uint8Array(asset.body), { headers });
}
