/*
 |--------------------------------------------------------------------------
 | lobby response formatting
 |--------------------------------------------------------------------------
 | Shapes of the former Laravel / MySQL responses: DATETIME strings, `id`
 | instead of `_id`, JSON columns as raw strings where MySQL returned them
 | undecoded, and the Laravel 5.4 LengthAwarePaginator JSON.
 |
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** MySQL DATETIME as the PHP returned it ("Y-m-d H:i:s", UTC - setCurrentTimezone() in the JS adds the local offset) */
export function sqlDate (value: any): string | null {
	if (value === null || value === undefined || value === '') return null;
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : null;
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
		+ `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** a JSON column as MySQL returned it: the raw JSON text (null stays null) */
export const jsonText = (value: any): string | null =>
	value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);

/** Mongo document -> former SQL row: `id` first, Date fields as DATETIME strings */
export function row (doc: any): any {
	if (!doc) return doc;
	const { _id, ...rest } = doc;
	const out: any = _id === undefined ? {} : { id : _id };
	for (const [k, v] of Object.entries(rest)) out[k] = v instanceof Date ? sqlDate(v) : v;
	return out;
}

export type Paginator<T> = {
	total         : number;
	per_page      : number;
	current_page  : number;
	last_page     : number;
	next_page_url : string | null;
	prev_page_url : string | null;
	from          : number | null;
	to            : number | null;
	data          : T[];
};

/** Laravel 5.4 $query->paginate($perPage)->setPath($path)->toArray() */
export function paginator<T> (data: T[], total: number, page: number, perPage: number, path: string): Paginator<T> {
	const lastPage = Math.max(1, Math.ceil(total / perPage));
	const from = data.length ? (page - 1) * perPage + 1 : null;
	return {
		total,
		per_page      : perPage,
		current_page  : page,
		last_page     : lastPage,
		next_page_url : page < lastPage ? `${path}?page=${page + 1}` : null,
		prev_page_url : page > 1 ? `${path}?page=${page - 1}` : null,
		from,
		to            : from === null ? null : from + data.length - 1,
		data
	};
}

/** Laravel's ?page= resolution: anything but an integer >= 1 is page 1 */
export function pageNumber (value: any): number {
	const n = Number(value);
	return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** PHP (int) cast of request input */
export const int = (value: any): number => {
	const n = parseInt(value, 10);
	return Number.isNaN(n) ? 0 : n;
};

/** numeric value for a JS literal in a page (null / '' would have been a syntax error in the PHP views) */
export const num = (value: any, fallback: number): number => {
	const n = Number(value);
	return value === null || value === undefined || value === '' || Number.isNaN(n) ? fallback : n;
};

/**
 * Public origin of the request (X-Forwarded-* aware) - the single domain
 * every former *_DOMAIN variable now points into.
 */
export function publicOrigin (req: Request): string {
	const url = new URL(req.url);
	const first = (h: string | null) => (h || '').split(',')[0].trim();
	const proto = first(req.headers.get('x-forwarded-proto')) || url.protocol.replace(/:$/, '');
	const host = first(req.headers.get('x-forwarded-host')) || req.headers.get('host') || url.host;
	return `${proto}://${host}`;
}

/** window.*_domain values; trailing slash because the JS appends "<table>" / "<table>/j?token=" */
export const domains = (origin: string) => ({
	lobbyDomain       : `${origin}/`,
	baccaratDomain    : `${origin}/baccarat/`,
	dragonTigerDomain : `${origin}/dragon-tiger/`,
	pokerDomain       : `${origin}/poker/`
});

/** dealers.dealer_image as the page uses it (former CONCAT("data:image/png;base64,", TO_BASE64(dealer_images))) */
export function dealerImageSrc (dealer: any): string | null {
	const blob = dealer.dealer_images;
	if (blob && (Buffer.isBuffer(blob) || blob.buffer)) {
		const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer);
		return `data:image/png;base64,${buf.toString('base64')}`;
	}
	const img = dealer.dealer_image;
	if (typeof img !== 'string' || !img) return null;
	// a bare base64 payload (no file extension / url)
	if (!/[./:]/.test(img) && img.length > 64) return `data:image/png;base64,${img}`;
	return img;
}
