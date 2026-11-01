/*
 |--------------------------------------------------------------------------
 | table dealer (window.tgDealer)
 |--------------------------------------------------------------------------
 | Stands the table's dealer behind the betting table on the game screens:
 | a half-body pose (transparent background) laid over the live video
 | (public/shared/video/tg-video.js puts a <video class="tg-video"> where each
 | page shows its stream), under the page's own canvases, so the table, the
 | buttons and the cards stay on top. Clicks go through.
 |
 |   tgDealer.show(portraitUrl)   the games' dealer component calls it with
 |       the dealer's picture (dealers.dealer_image) on load and on every
 |       dealer change; the pose is the same file under /poses/ instead of
 |       /portraits/ (scripts/dealer-images.mjs). No pose: nothing is shown.
 |
 | The figure sits in a twin of the video's box (same size, position and
 | transform, whatever the page does to lay its video out), as shares of
 | it: centred, feet on the betting table's top line (layout(): poker's
 | bet spots sit lower than the baccarat / dragon-tiger tables).
 |
 */
(function () {
	'use strict';

	var box = null;     // a twin of the video's box (size, position, transform), the figure placed inside it
	var img = null;
	var video = null;
	var current = null;
	var observer = null;

	// share of the video box from its top to the betting table's top line, and the figure's height
	function layout () {
		var game = String(window.game || '').toLowerCase();
		return game.indexOf('poker') >= 0 ? { feet : 0.64, height : 0.43 } : { feet : 0.575, height : 0.40 };
	}

	function poseOf (portrait) {
		if (!portrait || typeof portrait !== 'string') return null;
		if (portrait.indexOf('/portraits/') < 0) return null;
		return portrait.replace('/portraits/', '/poses/');
	}

	function findVideo () {
		var v = document.querySelector('video.tg-video');
		return v && v.parentNode ? v : null;
	}

	/** the box follows the video however the page lays it out (offsets, %, transforms) */
	function place () {
		if (!box || !video) return;
		var cs = window.getComputedStyle(video);
		var st = box.style;
		st.position = cs.position === 'static' ? 'absolute' : cs.position;
		st.left = cs.left; st.top = cs.top; st.right = cs.right; st.bottom = cs.bottom;
		st.margin = cs.margin;
		st.transform = cs.transform === 'none' ? '' : cs.transform;
		st.transformOrigin = cs.transformOrigin;
		st.width = video.offsetWidth + 'px';
		st.height = video.offsetHeight + 'px';
		st.zIndex = cs.zIndex === 'auto' ? '' : cs.zIndex;
		if (cs.position === 'static') { st.left = video.offsetLeft + 'px'; st.top = video.offsetTop + 'px'; }
		var l = layout();
		img.style.height = (l.height * 100) + '%';
		img.style.bottom = ((1 - l.feet) * 100) + '%';
	}

	function mount () {
		var v = findVideo();
		if (!v) return false;
		if (box && video === v && box.parentNode === v.parentNode) return true;
		video = v;
		if (!box) {
			box = document.createElement('div');
			box.className = 'tg-dealer-box';
			box.setAttribute('aria-hidden', 'true');
			box.style.cssText = 'pointer-events:none;overflow:visible;display:none';
			img = document.createElement('img');
			img.className = 'tg-dealer';
			img.alt = '';
			img.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);width:auto;max-width:none;' +
				'user-select:none;filter:drop-shadow(0 6px 10px rgba(0,0,0,0.45))';
			img.addEventListener('load', function () { box.style.display = 'block'; place(); });
			img.addEventListener('error', function () { box.style.display = 'none'; });
			box.appendChild(img);
		}
		// right after the video: everything the page drew over the video stays over the dealer
		v.parentNode.insertBefore(box, v.nextSibling);
		if (observer) observer.disconnect();
		if (window.ResizeObserver) {
			observer = new ResizeObserver(place);
			observer.observe(v);
			observer.observe(v.parentNode);
		}
		window.addEventListener('resize', place);
		place();
		return true;
	}

	function load () {
		if (!current) {
			if (box) box.style.display = 'none';
			return;
		}
		if (!mount()) return;
		if (img.getAttribute('src') !== current) {
			box.style.display = 'none';
			img.src = current;
		} else {
			box.style.display = 'block';
			place();
		}
	}

	// the video appears once the page has started its stream
	function waitForVideo () {
		if (findVideo()) return load();
		var watcher = new MutationObserver(function () {
			if (findVideo()) {
				watcher.disconnect();
				load();
			}
		});
		watcher.observe(document.documentElement, { childList : true, subtree : true });
	}

	window.tgDealer = {
		show : function (portrait) {
			current = poseOf(portrait);
			if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForVideo);
			else waitForVideo();
		}
	};
})();
