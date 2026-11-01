/*
 |--------------------------------------------------------------------------
 | table notices (window.tgNotice)
 |--------------------------------------------------------------------------
 | What the game pages show about a round that ends without a normal result
 | and about a table that is about to close (game-server core/tableControl).
 | Drawn as HTML above the game canvas, the same on every game and layout.
 |
 |   tgNotice.roundCancelled(data, self)  'roundcancelled': toast, the round's
 |       chips / cards / timer cleared, the balance refreshed
 |   tgNotice.roundVoided(data, self)     'displayRollback': toast, balance
 |   tgNotice.lastRounds(n)               'lastrounds' / newround.lastround:
 |       badge "3 rounds left" / "Last round", hidden at 0
 |
 | `self` is the game screen object of the legacy listeners. Texts come from
 | window.tgNoticeText (src/lib/tableNotices.ts), English otherwise. Events
 | of other tables are ignored, so a listener can pass every event on.
 |
 */
(function () {
	'use strict';

	var EN = {
		cancelled      : 'Round cancelled',
		cancelledBody  : 'All bets in this round have been refunded.',
		refundedYou    : '{amount} has been returned to your balance.',
		voided         : 'Round {round} voided',
		voidedBody     : 'Bets and winnings of this round have been reversed.',
		roundsLeft     : '{n} rounds left',
		lastRound      : 'Last round'
	};

	var text = function (key, vars) {
		var all = window.tgNoticeText || {};
		var s = all[key] || EN[key] || key;
		Object.keys(vars || {}).forEach(function (k) { s = s.split('{' + k + '}').join(vars[k]); });
		return s;
	};

	var CSS = [
		'.tgn-toast{position:fixed;left:50%;top:max(14px,env(safe-area-inset-top,0px));transform:translate(-50%,-140%);z-index:2147483000;',
		'min-width:240px;max-width:min(92vw,440px);padding:12px 18px 13px;border-radius:8px;background:rgba(18,14,10,.94);color:#f4eee2;',
		'border:1px solid #8a6a2c;box-shadow:0 8px 28px rgba(0,0,0,.55);font:500 15px/1.35 Lato,"Helvetica Neue",Arial,sans-serif;text-align:center;',
		'transition:transform .35s cubic-bezier(.2,.8,.2,1),opacity .35s;opacity:0;pointer-events:none}',
		'.tgn-toast.tgn-show{transform:translate(-50%,0);opacity:1}',
		'.tgn-toast b{display:block;font:700 17px/1.2 "BebasNeue","Bebas Neue",Lato,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#f3d48a;margin-bottom:4px}',
		'.tgn-toast.tgn-void b{color:#ffb4a6}',
		'.tgn-toast span{display:block}',
		'.tgn-toast .tgn-you{margin-top:6px;color:#bfe3c6;font-weight:700}',
		'.tgn-badge{position:fixed;left:50%;transform:translateX(-50%);top:max(10px,env(safe-area-inset-top,0px));z-index:2147482000;white-space:nowrap;',
		'padding:7px 12px 6px;border-radius:6px;background:rgba(29,20,16,.9);border:1px solid #6b4f1d;color:#f3d48a;',
		'font:700 15px/1 "BebasNeue","Bebas Neue",Lato,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;pointer-events:none}',
		'.tgn-badge.tgn-last{background:rgba(58,15,15,.92);border-color:#a33b2b;color:#ffd7cf;animation:tgn-pulse 1.6s ease-in-out infinite}',
		'@keyframes tgn-pulse{50%{box-shadow:0 0 0 4px rgba(163,59,43,.35)}}',
		'@media (prefers-reduced-motion:reduce){.tgn-toast{transition:none}.tgn-badge.tgn-last{animation:none}}'
	].join('');

	var ready = function (fn) {
		if (document.body) fn();
		else document.addEventListener('DOMContentLoaded', fn);
	};

	ready(function () {
		var style = document.createElement('style');
		style.textContent = CSS;
		document.head.appendChild(style);
	});

	/** events of this page's table only (the lobby socket carries every table) */
	var forThisTable = function (data) {
		if (!data) return false;
		if (data.gameName && window.game && data.gameName !== window.game) return false;
		return data.tableId === undefined || String(data.tableId) === String(window.tableNum);
	};

	var money = function (n) {
		var v = Number(n) || 0;
		return window.casino === 'SS'
			? v.toLocaleString('en-US', { minimumFractionDigits : 2, maximumFractionDigits : 2 })
			: Math.trunc(v).toLocaleString('en-US');
	};

	var toastEl = null;
	var toastTimer = null;
	var toast = function (title, lines, cls) {
		ready(function () {
			if (!toastEl) {
				toastEl = document.createElement('div');
				toastEl.className = 'tgn-toast';
				toastEl.setAttribute('role', 'status');
				toastEl.setAttribute('aria-live', 'polite');
				document.body.appendChild(toastEl);
			}
			toastEl.className = 'tgn-toast' + (cls ? ' ' + cls : '');
			toastEl.innerHTML = '';
			var b = document.createElement('b');
			b.textContent = title;
			toastEl.appendChild(b);
			lines.forEach(function (l) {
				if (!l) return;
				var s = document.createElement('span');
				s.textContent = l.text;
				if (l.cls) s.className = l.cls;
				toastEl.appendChild(s);
			});
			// reflow, then slide in
			void toastEl.offsetWidth;
			toastEl.classList.add('tgn-show');
			clearTimeout(toastTimer);
			toastTimer = setTimeout(function () { toastEl.classList.remove('tgn-show'); }, 6000);
		});
	};

	/** each step on its own: one missing component of a game layout must not stop the rest */
	var attempt = function (fn) {
		try { fn(); } catch (e) { if (window.console) console.warn('[tgNotice]', e); }
	};

	var refreshBalance = function (self) {
		if (!self || !window.$ || !$.post) return;
		$.post('/get/user', { userid : window.userId }, function (response) {
			attempt(function () {
				var r = typeof response === 'string' ? JSON.parse(response) : response;
				if (!r || r.money === undefined) return;
				self.context.user_money = r.money;
				if (self.component_betDetails && self.component_betDetails.reinit) self.component_betDetails.reinit(false);
				if (self.component_menuPlayerInfo && self.component_menuPlayerInfo.balance) {
					self.component_menuPlayerInfo.balance.text = money(r.money);
				}
			});
		});
	};

	var myRefund = function (data) {
		var mine = (data.refunds || []).filter(function (r) { return String(r.id) === String(window.userId); })[0];
		return mine && mine.amount > 0 ? mine.amount : 0;
	};

	var tgNotice = {
		roundCancelled : function (data, self) {
			if (!forThisTable(data)) return;

			var amount = myRefund(data);
			toast(text('cancelled'), [
				{ text : text('cancelledBody') },
				amount ? { text : text('refundedYou', { amount : money(amount) }), cls : 'tgn-you' } : null
			]);

			if (!self) return;
			attempt(function () { self.component_timer.clearTimer(); });
			attempt(function () { self.component_timer.betting_start = false; });
			attempt(function () { self.component_betBoard.clearTableChipBets(); });
			attempt(function () {
				self.component_gameButtons.yourBets = [];
				self.component_gameButtons.is_confirmed_bet = false;
			});
			attempt(function () { self.initRound(); });
			attempt(function () { if (self.hideResult) self.hideResult(); });
			refreshBalance(self);
		},

		roundVoided : function (data, self) {
			if (!forThisTable(data)) return;
			toast(text('voided', { round : data.roundNum || '' }), [{ text : text('voidedBody') }], 'tgn-void');
			refreshBalance(self);
		},

		lastRounds : function (n, data) {
			if (data && !forThisTable(data)) return;
			n = parseInt(n, 10) || 0;
			ready(function () {
				var el = document.querySelector('.tgn-badge');
				if (n <= 0) {
					if (el) el.remove();
					return;
				}
				if (!el) {
					el = document.createElement('div');
					el.className = 'tgn-badge';
					el.setAttribute('role', 'status');
					document.body.appendChild(el);
				}
				el.classList.toggle('tgn-last', n === 1);
				el.textContent = n === 1 ? text('lastRound') : text('roundsLeft', { n : n });
			});
		}
	};

	window.tgNotice = tgNotice;
})();
