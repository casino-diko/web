/*
 |--------------------------------------------------------------------------
 | brand settings
 |--------------------------------------------------------------------------
 | What the admin back-office's Branding page sets, in the shared database:
 |
 |   settings    { _id : 'brand', name, version }
 |   brand_files { _id : 'logo' | 'icon' | 'welcome' | 'welcome-<lang>',
 |                 content_type, data, version }
 |
 | `version` goes up with every change; it keys the drawn files
 | (lib/brandAssets.ts). The state is cached and re-read every few seconds,
 | so a change in the admin shows within that time; lib/db.ts loads it once
 | before the first request, so pages render with the right name.
 |
 */

import { config } from './config';
import { setBrandName } from './brandText';
import type { Db } from './db';

export type BrandState = { name : string; version : number; files : Set<string> };

const TTL = 5000;

let state: BrandState = { name : config.appName, version : 0, files : new Set() };
let loadedAt = 0;
let loading: Promise<BrandState> | null = null;

async function load (db: Db): Promise<BrandState> {
	const [doc, files]: [any, any[]] = await Promise.all([
		db.shared.settings.findById('brand').lean(),
		db.shared.brandFiles.find({}, { _id : 1 }).lean()
	]);
	state = {
		name    : (doc?.name || '').trim() || config.appName,
		version : Number(doc?.version) || 0,
		files   : new Set(files.map(f => String(f._id)))
	};
	setBrandName(state.name);
	loadedAt = Date.now();
	return state;
}

/** the current brand; re-read when older than a few seconds */
export function brand (db: Db): Promise<BrandState> {
	if (Date.now() - loadedAt < TTL) return Promise.resolve(state);
	if (!loading) loading = load(db).finally(() => { loading = null; });
	return loading;
}

/** an uploaded file (cached per version), or null */
const fileCache = new Map<string, { version : number; data : Buffer; type : string } | null>();

export async function brandFile (db: Db, id: string): Promise<{ data : Buffer; type : string } | null> {
	const current = await brand(db);
	if (!current.files.has(id)) return null;
	const hit = fileCache.get(id);
	if (hit && hit.version === current.version) return hit;
	const doc: any = await db.shared.brandFiles.findById(id).lean();
	const file = doc ? { version : current.version, data : Buffer.from(doc.data.buffer ?? doc.data), type : String(doc.content_type || '') } : null;
	fileCache.set(id, file);
	return file;
}
