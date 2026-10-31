/*
 |--------------------------------------------------------------------------
 | brand slots
 |--------------------------------------------------------------------------
 | The files under public/ that show the brand. src/middleware.ts sends
 | requests for them to src/app/brand-asset, which draws them from the
 | admin's settings (lib/brandAssets.ts) at the original file's size:
 |
 |   wordmark  the logo, or the brand name in Lato Black
 |   mark      the icon, or the brand name's first letter
 |   icon      a home-screen icon: the mark on a dark square
 |   welcome   the lobby's "welcome to ..." voice: the admin's upload
 |
 | Paths are relative to public/ (`<app>/img/...`). No imports: the
 | middleware imports this.
 |
 */

export type Slot =
	| { kind : 'wordmark'; colour : string }
	| { kind : 'mark'; colour : string }
	| { kind : 'icon'; scale : number; background : boolean }
	| { kind : 'welcome'; lang : string };

const RED = '#d22e21';
const GOLD = '#e2b531';
const LIGHT_GOLD = '#efd28e';

const RULES : [RegExp, (m : RegExpMatchArray) => Slot][] = [
	[/^(baccarat|dragon-tiger|poker)\/img\/nihtan-logo\.png$/, () => ({ kind : 'wordmark', colour : RED })],
	[/^lobby\/img\/(nihtan_logo|logo|header\/logo)\.png$/, () => ({ kind : 'wordmark', colour : RED })],
	[/^[a-z-]+\/img\/tutorials\/nihtan-red_logo\.png$/, () => ({ kind : 'wordmark', colour : RED })],
	[/^[a-z-]+\/img\/maintenance\/logo\.png$/, () => ({ kind : 'wordmark', colour : LIGHT_GOLD })],
	[/^[a-z-]+\/img\/confirmation\/nihtan-yellow_logo\.png$/, () => ({ kind : 'wordmark', colour : GOLD })],
	[/^lobby\/img\/banner\/nihtan-banner_ico\.png$/, () => ({ kind : 'wordmark', colour : GOLD })],
	[/^lobby\/img\/(icons\/)?nihtan_logo_mobile\.png$/, () => ({ kind : 'mark', colour : RED })],
	[/^lobby\/img\/howtoplay\/redwhite\/nihtan_symbol\.png$/, () => ({ kind : 'mark', colour : RED })],
	// a faint watermark behind the lobby's how-to-play pages
	[/^lobby\/img\/howtoplay\/lobby\/nihtan-logo\.png$/, () => ({ kind : 'mark', colour : '#555555' })],
	// the seasonal lobby logos that are a single picture (the wide ones are animation strips nothing loads)
	[/^lobby\/img\/seasonal_theme\/(lantern_theme|chinese_newyear_theme)\/logo_mobile\.png$/, () => ({ kind : 'mark', colour : RED })],
	[/^[a-z-]+\/favicon\.ico$/, () => ({ kind : 'mark', colour : RED })],
	[/^shared\/app\/(icon-192|icon-512|apple-touch-icon)\.png$/, () => ({ kind : 'icon', scale : 0.62, background : true })],
	[/^shared\/app\/icon-maskable-512\.png$/, () => ({ kind : 'icon', scale : 0.46, background : true })],
	[/^lobby\/sound\/(en|kr|jp|zh|th)\/mode-\d\/welcome-nihtan[^/]*\.mp3$/, m => ({ kind : 'welcome', lang : m[1] })]
];

/** the slot of a public/ path, or null */
export function brandSlot (publicPath: string): Slot | null {
	for (const [re, slot] of RULES) {
		const m = publicPath.match(re);
		if (m) return slot(m);
	}
	return null;
}

export const WELCOME_LANGS = ['en', 'kr', 'jp', 'zh', 'th'];
