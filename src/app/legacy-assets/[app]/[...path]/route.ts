/*
 |--------------------------------------------------------------------------
 | legacy static files
 |--------------------------------------------------------------------------
 | Serves public/<app>/<path> for the root-relative asset urls that
 | src/middleware.ts maps to an app (/img/x.png from a /poker page ->
 | /legacy-assets/poker/img/x.png); responses vary by Referer, since the
 | same url is a different file for each game. A plain middleware rewrite onto
 | public/<app>/... is not enough: in production builds the rewritten url
 | is matched against the app's dynamic page routes first.
 |
 */

import { open, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const APPS = ['lobby', 'baccarat', 'dragon-tiger', 'poker'];
const ROOT = path.join(process.cwd(), 'public');

const TYPES: Record<string, string> = {
	'.html' : 'text/html; charset=utf-8', '.js' : 'text/javascript; charset=utf-8', '.css' : 'text/css; charset=utf-8',
	'.json' : 'application/json; charset=utf-8', '.txt' : 'text/plain; charset=utf-8', '.xml' : 'application/xml',
	'.png' : 'image/png', '.jpg' : 'image/jpeg', '.jpeg' : 'image/jpeg', '.gif' : 'image/gif', '.svg' : 'image/svg+xml',
	'.ico' : 'image/x-icon', '.webp' : 'image/webp', '.mp3' : 'audio/mpeg', '.ogg' : 'audio/ogg', '.wav' : 'audio/wav',
	'.m4a' : 'audio/mp4', '.mp4' : 'video/mp4', '.webm' : 'video/webm', '.woff' : 'font/woff', '.woff2' : 'font/woff2',
	'.ttf' : 'font/ttf', '.otf' : 'font/otf', '.eot' : 'application/vnd.ms-fontobject', '.swf' : 'application/x-shockwave-flash',
	'.map' : 'application/json'
};

const notFound = () => new Response('Not Found', { status : 404 });

/**
 * bytes start..end of a file, read as the client takes them. (Readable.toWeb of
 * a file stream keeps pushing after the client hangs up, as phones do with
 * sounds and pictures when a player leaves a page, and throws "Controller is
 * already closed".)
 */
function fileBody (file: string, start: number, end: number): ReadableStream<Uint8Array> {
	let handle: FileHandle | null = null;
	let pos = start;
	let cancelled = false;
	const close = async () => {
		const h = handle;
		handle = null;
		await h?.close();
	};
	return new ReadableStream<Uint8Array>({
		async pull (controller) {
			if (!handle) {
				handle = await open(file, 'r');
				if (cancelled) return close();
			}
			const size = Math.min(64 * 1024, end + 1 - pos);
			const { bytesRead, buffer } = size > 0 ? await handle.read(Buffer.alloc(size), 0, size, pos) : { bytesRead : 0, buffer : null };
			if (!bytesRead) {
				await close();
				controller.close();
				return;
			}
			pos += bytesRead;
			controller.enqueue(new Uint8Array(buffer!.buffer, buffer!.byteOffset, bytesRead));
		},
		cancel () {
			cancelled = true;
			return close();
		}
	}, { highWaterMark : 0 });
}

async function serve (req: Request, ctx: { params : Promise<{ app : string; path : string[] }> }, head = false) {
	const { app, path : parts } = await ctx.params;
	if (!APPS.includes(app) || !parts?.length) return notFound();

	const base = path.join(ROOT, app);
	const file = path.join(base, ...parts.map(decodeURIComponent));
	if (!file.startsWith(base + path.sep)) return notFound();

	let info;
	try {
		info = await stat(file);
	} catch {
		return notFound();
	}
	if (!info.isFile()) return notFound();

	const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
	const headers: Record<string, string> = {
		'content-type'  : TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
		'cache-control' : 'public, max-age=3600, stale-while-revalidate=604800',
		// the same url (/img/x.png) is a different file per game, chosen by the Referer
		// (src/middleware.ts): without this a browser reuses poker's copy on the baccarat page
		vary            : 'Referer',
		'accept-ranges' : 'bytes',
		'last-modified' : info.mtime.toUTCString(),
		etag
	};
	if (req.headers.get('if-none-match') === etag) return new Response(null, { status : 304, headers });

	// audio / video elements request byte ranges
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
	let start = 0;
	let end = info.size - 1;
	let status = 200;
	if (range && (range[1] || range[2])) {
		start = range[1] ? parseInt(range[1]) : Math.max(0, info.size - parseInt(range[2]));
		end = range[1] && range[2] ? Math.min(parseInt(range[2]), end) : end;
		if (start > end || start >= info.size) {
			return new Response(null, { status : 416, headers : { 'content-range' : `bytes */${info.size}` } });
		}
		status = 206;
		headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
	}
	headers['content-length'] = String(end - start + 1);

	if (head || info.size === 0) return new Response(null, { status, headers });
	return new Response(fileBody(file, start, end), { status, headers });
}

export const GET = (req: Request, ctx: any) => serve(req, ctx);
export const HEAD = (req: Request, ctx: any) => serve(req, ctx, true);
