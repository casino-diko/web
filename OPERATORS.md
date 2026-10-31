# Operator integration guide

How a casino operator puts our live tables (baccarat, dragon-tiger, poker) in front of its players: a signed launch link, then a full page, an iframe on the operator's site, or the operator's own phone app.

| Way in | Effort | When |
|---|---|---|
| [Full page or new tab](#full-page-or-new-tab) | lowest | the games open on our domain; logout returns to your site |
| [Iframe on your site](#iframe-on-your-site) | low | the games stay inside your pages; we tell your page when the player leaves |
| [Your own phone app](#your-own-phone-app) | medium | the same link in a WebView |

All of them start with the same [launch link](#launch-link).

## What you get from us

- your **vendor name** (for example `my-casino`)
- your **secret**: 64 hex characters. It signs your launch links, and, for seamless wallets, the wallet calls. Keep it on your server; never put it in a page or an app.
- the **games url**, for example `https://games.example`
- for iframes: we add your site(s) to the allowed list, for example `https://www.my-casino.example`
- your **lobby mode**:
  - *ours*: players move between tables in our lobby; only logout returns them to you
  - *yours* (`integrated`): you list the tables; the games' lobby button returns the player to you

The secret, the allowed sites and the lobby mode are set on the admin back-office's **Vendors** page.

## Launch link

Your server builds a fresh link each time a player opens the games:

```
https://games.example/launch?vendor=<vendor name>&payload=<base64url JSON>&hash=<hex>

hash = HMAC-SHA256(payload, secret) in hex, over the payload string exactly as it is in the url
```

| Payload field | | |
|---|---|---|
| `user_id` | required | your player id, 1–64 of `A-Z a-z 0-9 _ . @ -`. The first launch creates the player on our side; later launches find it again |
| `ts` | required | the current unix time in seconds. A link is accepted for 5 minutes either side |
| `nonce` | required | 16–64 random characters of `A-Z a-z 0-9 _ -`, new for every link. A link works once |
| `user_name` | optional | the name shown at the tables, 1–64 characters, updated on every launch |
| `currency` | optional | used only when the player is created (else your vendor's currency) |
| `lang` | optional | `en`, `kr`, `jp`, `zh` or `th` |
| `game`, `table` | optional | `baccarat`, `dragon-tiger` or `poker` and a table number: straight to that table. Without them: our lobby |
| `lobby_url` | optional | your page (http or https) where logout, and in lobby mode *yours* the lobby button, send the player |
| `embed` | optional | `true` when the link opens in an [iframe on your site](#iframe-on-your-site) |

base64url is base64 with `-` and `_` instead of `+` and `/`; the `=` padding is optional.

### Signing a link

Node:

```js
import { createHmac, randomBytes } from 'node:crypto';

function launchUrl (player) {
	const payload = Buffer.from(JSON.stringify({
		user_id : player.id, user_name : player.name, ts : Math.floor(Date.now() / 1000),
		nonce : randomBytes(16).toString('hex'), lobby_url : 'https://www.my-casino.example/lobby'
	})).toString('base64url');
	const hash = createHmac('sha256', process.env.GAMES_SECRET).update(payload).digest('hex');
	return `https://games.example/launch?${new URLSearchParams({ vendor : 'my-casino', payload, hash })}`;
}
```

PHP:

```php
function launch_url(array $player): string {
    $payload = rtrim(strtr(base64_encode(json_encode([
        'user_id' => $player['id'], 'user_name' => $player['name'], 'ts' => time(),
        'nonce' => bin2hex(random_bytes(16)), 'lobby_url' => 'https://www.my-casino.example/lobby',
    ])), '+/', '-_'), '=');
    $hash = hash_hmac('sha256', $payload, getenv('GAMES_SECRET'));
    return 'https://games.example/launch?' . http_build_query(['vendor' => 'my-casino', 'payload' => $payload, 'hash' => $hash]);
}
```

Python:

```python
import base64, hashlib, hmac, json, os, secrets, time, urllib.parse

def launch_url(player):
    payload = base64.urlsafe_b64encode(json.dumps({
        "user_id": player["id"], "user_name": player["name"], "ts": int(time.time()),
        "nonce": secrets.token_hex(16), "lobby_url": "https://www.my-casino.example/lobby",
    }).encode()).decode().rstrip("=")
    digest = hmac.new(os.environ["GAMES_SECRET"].encode(), payload.encode(), hashlib.sha256).hexdigest()
    return "https://games.example/launch?" + urllib.parse.urlencode({"vendor": "my-casino", "payload": payload, "hash": digest})
```

A refused link shows the player "This link has expired". We log the reason (bad signature, expired, nonce used twice, unknown vendor, `embed` without an allowed site, …); ask us when a link is refused.

## Full page or new tab

Send the player to the launch link (a redirect, a link, or `window.open`). Our pages run on our domain. Logout (and the lobby button in lobby mode *yours*) go to `lobby_url`.

## Iframe on your site

1. Ask us to add your site to the allowed list. Only https sites can be allowed (and `http://localhost` / `http://127.0.0.1` for testing). Pages on other sites refuse to show inside a frame.
2. Sign the link with `"embed": true`.
3. Embed it:

```html
<iframe src="https://games.example/launch?vendor=…&payload=…&hash=…"
        allow="autoplay; fullscreen" allowfullscreen
        style="width: 100%; height: 100vh; border: 0"></iframe>
```

`allow="autoplay; fullscreen"` lets the live video and sound play and the full-screen button work. Don't add a `sandbox` attribute: the games need scripts, their own storage and their own cookies.

### Messages from the games

The games never navigate your page. When something happens, they post a message to it:

| `type` | When | What to do |
|---|---|---|
| `exit` | the player logged out (`reason: 'logout'`) or, in lobby mode *yours*, pressed the lobby button (`reason: 'lobby'`); `url` is your `lobby_url` | close the games, show your lobby |
| `unauthenticated` | the session ended (12 hours after the launch, or after a logout) | sign a new link and load it in the iframe |
| `launch-refused` | the link was refused (expired, used twice, bad signature) | sign a new link; tell us if it keeps happening |

```js
window.addEventListener('message', event => {
	if (event.origin !== 'https://games.example' || event.data?.source !== 'casino-diko') return;
	switch (event.data.type) {
		case 'exit': showLobby(); break;
		case 'unauthenticated':
		case 'launch-refused': reloadGames(); break; // your server signs a fresh link
	}
});
```

Always check `event.origin`. If your page ignores `exit`, the player sees a "Return to the casino" link instead.

A player can play in one place at a time: opening the same player elsewhere moves the first window to a "you are playing somewhere else" page.

### Cookies in the iframe

The player's session lives in a cookie of ours, set inside your iframe as `SameSite=None; Secure; Partitioned`. Partitioned cookies are kept separately for each site that embeds us. Browsers that block third-party cookies still keep them: Chrome, Edge, Firefox and Safari support them since December 2025 ([MDN](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies)). They need https on both sides (localhost counts as https for testing).

On older browsers that block third-party cookies, the games ask your page to relaunch (`unauthenticated`) again and again. Open the games in a new tab instead when you see that.

## Your own phone app

Load the launch link in a WebView, without `embed` (the WebView is the whole page). Set `lobby_url` to a url of yours and catch the navigation to it: that is the player leaving the games.

iOS (`WKWebView`):

```swift
let config = WKWebViewConfiguration()
config.allowsInlineMediaPlayback = true                // the live video plays in the page
config.mediaTypesRequiringUserActionForPlayback = []    // sound and video without an extra tap
let webView = WKWebView(frame: .zero, configuration: config)
webView.navigationDelegate = self
webView.load(URLRequest(url: launchURL))

func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.request.url?.absoluteString.hasPrefix("https://www.my-casino.example/lobby") == true {
        decisionHandler(.cancel); closeGames(); return
    }
    decisionHandler(.allow)
}
```

Android (`WebView`):

```kotlin
webView.settings.javaScriptEnabled = true
webView.settings.domStorageEnabled = true
webView.settings.mediaPlaybackRequiresUserGesture = false
CookieManager.getInstance().setAcceptCookie(true)
webView.webViewClient = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.url.toString().startsWith("https://www.my-casino.example/lobby")) { closeGames(); return true }
        return false
    }
}
webView.loadUrl(launchUrl)
```

Lock nothing to an orientation: the lobby and baccarat are portrait, dragon-tiger and poker draw themselves for landscape.

## Wallet

Your vendor is set up with one of two wallets:

- **Transfer**: we hold the player's balance. Bets and wins change it directly; credits are added or deducted on the admin back-office (each change is recorded with who made it).
- **Seamless**: your wallet holds the balance. Our servers call a wallet gateway (`VENDOR_API_URL`) signed with your secret (`?hash=` = HMAC-SHA256 of the JSON body, hex): `POST /api/check` (`user_id`, `user_name`, `vendor_name`, answers the balance), `POST /api/check/bulk`, and `POST /api/transact/<game>/<bet|cancel|…>` (`user_id`, `amount`, `table`, `round_no`, `bet_id`, `currency`, …, answers `{"status":"ok"}`). Payouts of seamless rounds are not wired end to end yet: talk to us before going live with a seamless wallet.

## Testing

In this repository, with the vendor's secret:

```sh
# a one-time full-page link
LAUNCH_SECRET=<secret> npm run launch-link -- --vendor my-casino --user p-1001 --game poker --table 1

# a demo operator page at http://127.0.0.1:8090 embedding the games and logging their messages
# (allow http://127.0.0.1:8090 for the vendor first, on the admin's Vendors page)
LAUNCH_SECRET=<secret> npm run operator-demo -- --vendor my-casino --user p-1001
```

`scripts/operator-demo.ts` is also a complete example of the operator side: it signs links on the server, embeds them and handles the messages.

Before going live, check:

- [ ] a new player id creates a player; the same id again finds it (balance kept)
- [ ] a link opened twice, or after 5 minutes, is refused
- [ ] "back to the casino" and logout reach your lobby (full page) or post `exit` (iframe)
- [ ] the iframe works with third-party cookies blocked (Chrome: Settings → Privacy → Third-party cookies)
- [ ] on a real iPhone and Android phone: the video plays, sound plays after one tap, bets go through
