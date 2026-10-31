/*
 |--------------------------------------------------------------------------
 | config
 |--------------------------------------------------------------------------
 | Server-side settings, all from the environment.
 |
 */

const env = process.env;

const bool = (value: string | undefined, fallback = false) =>
	value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

export const config = {
	// socket-server url as seen by the player's browser; always ends with "/"
	// because the legacy scripts append namespaces (window.socket + 'Baccarat/1')
	socketUrl : (env.APP_SOCKET || 'http://localhost:8000').replace(/\/*$/, '/'),

	mongo : {
		uri      : env.MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true',
		sharedDb : env.MONGO_SHARED_DB || 'nihtan_api',
		games    : {
			baccarat      : env.BACCARAT_DB || 'baccarat',
			'dragon-tiger': env.DRAGONTIGER_DB || 'dragontiger',
			poker         : env.POKER_DB || 'poker'
		} as Record<GameApp, string>
	},

	session : {
		secret : env.SESSION_SECRET || '',
		cookie : env.SESSION_COOKIE || 'nihtan',
		secure : bool(env.SESSION_SECURE),
		maxAge : 60 * 60 * 12
	},

	// vendor API for seamless wallets (former env('API_URL'))
	apiUrl : (env.API_URL || '').replace(/\/$/, ''),

	devLogin : bool(env.DEV_LOGIN),

	// name of the home-screen app (web app manifest, iOS title)
	appName : env.APP_NAME || 'Nihtan'
};

export type GameApp = 'baccarat' | 'dragon-tiger' | 'poker';
export type App = 'lobby' | GameApp;

export const GAME_APPS: GameApp[] = ['baccarat', 'dragon-tiger', 'poker'];

// game names as used by the game-server / socket-server namespaces
export const GAME_NAMES: Record<GameApp, string> = {
	baccarat       : 'Baccarat',
	'dragon-tiger' : 'Dragon-Tiger',
	poker          : 'Poker'
};
