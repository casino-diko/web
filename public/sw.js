// Home-screen app service worker (src/lib/webapp.ts): when a page can't load, show the
// offline page. Everything else (game files, api calls, video, sockets) goes straight to
// the network: game files share urls between games, so caching them here would mix them up.
const CACHE = 'offline-v2';
const OFFLINE = '/shared/app/offline.html';

self.addEventListener('install', event => {
	event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
	event.waitUntil(caches.keys()
		.then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
		.then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
	if (event.request.mode !== 'navigate') return;
	event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
