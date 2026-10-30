/*
 |--------------------------------------------------------------------------
 | tg-video: HLS live video for the legacy game pages
 |--------------------------------------------------------------------------
 | Replaces the Flash player (swfobject + GrindPlayer.swf/flashls) and the
 | JSMpeg socket player. Load after /shared/video/hls.min.js and before the
 | game scripts.
 |
 |  - window.swfobject.embedSWF(swf, id, w, h, v, x, flashvars, params, attrs)
 |    plays flashvars.src (HLS) in a <video> that takes the element's place,
 |    like Flash did. The element gets the old player API (setVolume,
 |    setMuted, load, play2, "mediaError" events) and flashvars'
 |    javascriptCallbackFunction gets the OSMF bridge events.
 |    A src ending in "_800x450" (the old SD stream) uses window.videostream_url_sd.
 |  - window.tgVideo.attach(element, src) for the mobile pages: returns
 |    { volume, element, destroy() } where JSMpeg's player used to be (a
 |    no-op player when the page has no video element).
 |
 | hls.js plays the stream where Media Source Extensions exist; Safari / iOS
 | play HLS natively. Browsers block unmuted autoplay, so playback may start
 | muted and is unmuted on the first tap / click / key press.
 |
 */

(function () {
	'use strict';

	var SD_SUFFIX = '_800x450';
	var RETRY_MS = 3000;

	var style = document.createElement('style');
	style.textContent = '.get-flash{display:none!important}'
		+ 'video.tg-video{background:#000;object-fit:cover;pointer-events:none}';
	(document.head || document.documentElement).appendChild(style);

	var waitingForGesture = [];
	function onFirstGesture () {
		var players = waitingForGesture.splice(0);
		players.forEach(function (p) { p.applyAudio(); p.element.play().catch(function () {}); });
	}
	['pointerdown', 'touchend', 'keydown', 'click'].forEach(function (type) {
		document.addEventListener(type, onFirstGesture, true);
	});

	// The mobile pages style their canvases with element rules (`canvas { position: absolute; ... }`)
	// that a <video> taking the canvas' place would not match: mirror them onto video.tg-video-canvas
	// (less specific than the pages' #vidCanvas rules, which keep winning as they did for the canvas).
	var canvasRulesMirrored = false;
	function mirrorCanvasRules () {
		if (canvasRulesMirrored) return;
		canvasRulesMirrored = true;
		var css = [];
		var isCanvasSelector = function (selector) {
			return selector.split(',').some(function (part) { return part.trim() === 'canvas'; });
		};
		var collect = function (rules, wrap) {
			for (var i = 0; i < rules.length; i++) {
				var rule = rules[i];
				if (rule.selectorText && isCanvasSelector(rule.selectorText)) {
					css.push(wrap('video.tg-video-canvas{' + rule.style.cssText + '}'));
				} else if (rule.media && rule.cssRules) {
					var media = rule.media.mediaText;
					collect(rule.cssRules, function (text) { return '@media ' + media + '{' + text + '}'; });
				}
			}
		};
		for (var i = 0; i < document.styleSheets.length; i++) {
			try {
				collect(document.styleSheets[i].cssRules, function (text) { return text; });
			} catch (e) {
				// cross-origin stylesheet
			}
		}
		if (!css.length) return;
		var mirror = document.createElement('style');
		mirror.textContent = css.join('\n');
		// before the page's own styles so that their #id rules still win on equal terms
		var head = document.head || document.documentElement;
		head.insertBefore(mirror, head.firstChild);
	}

	function sdUrl (src) {
		if (typeof src !== 'string' || src.slice(-SD_SUFFIX.length) !== SD_SUFFIX) return src;
		return window.videostream_url_sd || src.slice(0, -SD_SUFFIX.length);
	}

	/**
	 * @param className when given, the video gets only these classes (like swfobject's attrs.class);
	 *                  otherwise it inherits the replaced element's classes and inline style
	 */
	function Player (target, src, className) {
		var video = target && target.tagName === 'VIDEO' ? target : document.createElement('video');
		if (video !== target) {
			// take the place of the flash container / jsmpeg canvas (same id, so css + scripts still apply)
			video.id = target.id;
			if (className !== undefined) {
				video.className = className;
			} else {
				video.className = target.className;
				if (target.getAttribute('style')) video.setAttribute('style', target.getAttribute('style'));
			}
			if (target.width) video.width = target.width;
			if (target.height) video.height = target.height;
			if (target.tagName === 'CANVAS') {
				mirrorCanvasRules();
				video.classList.add('tg-video-canvas');
			}
			target.parentNode.replaceChild(video, target);
		}
		video.classList.add('tg-video');
		video.autoplay = true;
		video.playsInline = true;
		video.setAttribute('playsinline', '');
		video.setAttribute('webkit-playsinline', '');
		video.disablePictureInPicture = true;

		this.element = video;
		this.hls = null;
		this.src = null;
		this.retry = null;
		this.teardown = false; // hls.js calls media.load() itself while detaching
		this.desiredVolume = 1;
		this.desiredMuted = false;
		video.tgPlayer = this;
		this.installFlashApi();
		this.load(src);
	}

	Player.prototype.load = function (src) {
		var self = this;
		var video = this.element;
		src = sdUrl(src);
		clearTimeout(this.retry);
		this.detach();
		this.src = src || null;

		if (!src) {
			console.warn('[tg-video] no HLS stream configured for this table');
			video.removeAttribute('src');
			return;
		}

		if (window.Hls && window.Hls.isSupported()) {
			var hls = new window.Hls({ liveSyncDurationCount : 3, enableWorker : true, backBufferLength : 30 });
			this.hls = hls;
			hls.on(window.Hls.Events.ERROR, function (event, data) {
				if (!data.fatal) return;
				video.dispatchEvent(new Event('mediaError'));
				if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
					hls.recoverMediaError();
				} else {
					// stream not up yet / network gone: try again
					self.retry = setTimeout(function () { self.load(self.src); }, RETRY_MS);
				}
			});
			hls.loadSource(src);
			hls.attachMedia(video);
		} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
			video.src = src;
		} else {
			console.warn('[tg-video] this browser cannot play HLS');
			return;
		}
		this.play();
	};

	Player.prototype.applyAudio = function () {
		this.element.volume = Math.min(1, Math.max(0, this.desiredVolume));
		this.element.muted = this.desiredMuted || this.desiredVolume === 0;
	};

	Player.prototype.play = function () {
		var self = this;
		var video = this.element;
		this.applyAudio();
		var attempt = video.play();
		if (!attempt || !attempt.catch) return;
		attempt.catch(function () {
			// autoplay with sound refused: play muted until the first user gesture
			video.muted = true;
			video.play().catch(function () {});
			if (waitingForGesture.indexOf(self) < 0) waitingForGesture.push(self);
		});
	};

	Player.prototype.setVolume = function (value) {
		var v = parseFloat(value);
		this.desiredVolume = isNaN(v) ? 1 : v;
		if (waitingForGesture.indexOf(this) < 0) this.applyAudio();
	};

	Player.prototype.setMuted = function (muted) {
		this.desiredMuted = !!muted;
		if (waitingForGesture.indexOf(this) < 0) this.applyAudio();
	};

	Player.prototype.detach = function () {
		this.teardown = true;
		try {
			if (this.hls) this.hls.destroy();
		} finally {
			this.hls = null;
			this.teardown = false;
		}
	};

	Player.prototype.destroy = function () {
		clearTimeout(this.retry);
		this.detach();
		this.src = null;
		this.element.pause();
		this.element.removeAttribute('src');
		HTMLMediaElement.prototype.load.call(this.element);
	};

	// the Flash player's javascript API, used by the game scripts and templates via window.videoStream
	Player.prototype.installFlashApi = function () {
		var self = this;
		var video = this.element;
		video.setVolume = function (v) { self.setVolume(v); };
		video.getVolume = function () { return self.desiredVolume; };
		video.setMuted = function (m) { self.setMuted(m); };
		video.getMuted = function () { return self.desiredMuted; };
		video.play2 = function () { self.load(self.src); };
		video.load2 = video.play2;
		// legacy code calls videoStream.load() to restart the stream
		video.load = function () {
			if (!self.teardown && self.src) return self.load(self.src);
			return HTMLMediaElement.prototype.load.call(video);
		};
	};

	// JSMpeg replacement: player.volume = x is used by the mobile settings menus
	Object.defineProperty(Player.prototype, 'volume', {
		get : function () { return this.desiredMuted ? 0 : this.desiredVolume; },
		set : function (v) {
			this.desiredMuted = false;
			this.setVolume(v);
		}
	});

	// stands in when a page has no video container (the app variants of the mobile pages)
	var nullPlayer = {
		element : null, volume : 0, src : null,
		load : function () {}, play : function () {}, destroy : function () {},
		setVolume : function () {}, setMuted : function () {}
	};

	function attach (target, src, className) {
		if (typeof target === 'string') target = document.getElementById(target.replace(/^#/, ''));
		if (!target) return nullPlayer;
		if (target.tgPlayer) {
			target.tgPlayer.load(src);
			return target.tgPlayer;
		}
		return new Player(target, src, className);
	}

	var bridgeEvents = { playing : 'playing', pause : 'paused', waiting : 'buffering', loadstart : 'loading', volumechange : 'volumeChange' };

	window.tgVideo = { attach : attach };

	window.swfobject = {
		embedSWF : function (swfUrl, id, width, height, version, express, flashvars, params, attrs) {
			flashvars = flashvars || {};
			var target = document.getElementById(id);
			if (!target) return;
			var fresh = !target.tgPlayer;
			// like flash: the player gets attrs.class only, not the container's classes (the pages scale
			// .dom-resizable elements themselves, the video must just fill .container)
			var player = attach(target, flashvars.src, (attrs && attrs['class']) ? String(attrs['class']) : '');
			if (!player.element) return;
			if (params && params.volume !== undefined) player.setVolume(params.volume / 100);

			var callback = flashvars.javascriptCallbackFunction;
			if (typeof callback === 'string') callback = window[callback];
			if (typeof callback === 'function' && fresh) {
				Object.keys(bridgeEvents).forEach(function (type) {
					player.element.addEventListener(type, function () { callback(id, bridgeEvents[type]); });
				});
				setTimeout(function () { callback(id, 'onJavaScriptBridgeCreated'); }, 0);
			}
		},
		removeSWF : function (id) {
			var el = document.getElementById(id);
			if (el && el.tgPlayer) el.tgPlayer.destroy();
		},
		hasFlashPlayerVersion : function () { return true; },
		getFlashPlayerVersion : function () { return { major : 32, minor : 0, release : 0 }; },
		registerObject : function () {},
		addDomLoadEvent : function (fn) { document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn(); },
		addLoadEvent : function (fn) { window.addEventListener('load', fn); }
	};
})();
