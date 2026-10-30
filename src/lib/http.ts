/*
 |--------------------------------------------------------------------------
 | request helpers
 |--------------------------------------------------------------------------
 | The legacy scripts post either JSON, urlencoded forms or multipart
 | (jQuery / vue-resource); input() merges query + body like Laravel's
 | $request->input().
 |
 */

export async function input (req: Request): Promise<Record<string, any>> {
	const data: Record<string, any> = Object.fromEntries(new URL(req.url).searchParams);
	if (req.method === 'GET' || req.method === 'HEAD') return data;

	const type = req.headers.get('content-type') || '';
	try {
		if (type.includes('application/json')) {
			Object.assign(data, await req.json());
		} else if (type.includes('form')) {
			const form = await req.formData();
			for (const key of new Set(form.keys())) {
				const values = form.getAll(key);
				const name = key.replace(/\[\]$/, '');
				data[name] = key.endsWith('[]') || values.length > 1 ? values : values[0];
			}
		} else {
			const text = await req.text();
			if (text) {
				try {
					Object.assign(data, JSON.parse(text));
				} catch {
					Object.assign(data, Object.fromEntries(new URLSearchParams(text)));
				}
			}
		}
	} catch {
		// empty / malformed body: behave like an empty Laravel request
	}
	return data;
}

/** Laravel returned arrays/objects as JSON and scalars as text */
export function respond (value: any, status = 200): Response {
	if (value instanceof Response) return value;
	if (value !== null && typeof value === 'object') return Response.json(value, { status });
	return new Response(value === undefined || value === null ? '' : String(value), {
		status,
		headers : { 'content-type' : 'text/html; charset=utf-8' }
	});
}

export const isMobile = (req: Request) =>
	/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(req.headers.get('user-agent') || '');

export const clientIp = (req: Request) =>
	(req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || '';

type Params = Record<string, string>;

/**
 * Route handler for a ported controller method `(req, params) => Response | value`.
 * Values are returned like Laravel did (see respond); errors become a 500.
 *
 *   export const POST = handler(controller.testStore);
 */
export const handler = (fn: (req: Request, params: Params) => any) =>
	async (req: Request, ctx: { params : Promise<Params> }) => {
		try {
			return respond(await fn(req, (await ctx?.params) || {}));
		} catch (e) {
			console.error(`${req.method} ${new URL(req.url).pathname} failed:`, e);
			return Response.json({ error : 'Server Error' }, { status : 500 });
		}
	};
