/* Ported from pantsforbirds.com (PantsForBirds/wordPRess, pfb-storefront assets/js/site-traffic.js); changes for this site:
   the areas (.wp-hero, the header, the footer), the URLs from <body data-traffic-api / data-traffic-tiles>, and the credit
   filling the footer's static map credit. Everything else, LOOKS included, is the theme's.

   Live air traffic from globe.whereplane.xyz over a faint map, behind the home hero, the blog header, the site header and
   the footer. One ?all_with_pos fetch picks a random region with traffic (busy ones more often, see pickView), sized to
   hold about 30 aircraft (150-1500 km across), and is remembered for the tab (sessionStorage), so later pages only poll
   a box around the view every 20 s; positions are
   dead-reckoned between fixes. Each area gets two canvases under its content (isolation + z-index -1; the footer differs, see traffic.css): the map, drawn once
   from whereplane's vector tiles (OpenMapTiles schema: water, rivers, major roads; z4-z9 worldwide, z10 near the stations), and the traffic, redrawn at 4 fps (2 on phones, with
   half the aircraft). The site header and the dark band right below it (home hero, blog header, shop header) are one
   frame: the view is centred on the block they make together and each canvas draws its slice of it, so the map, the
   range rings and the aircraft run on across the line between them. The footer is a frame of its own, centred on the
   same point at the same scale. Traffic is never drawn behind text, and the map fades out under it (VEIL), so text keeps
   the contrast it has on the plain background while the map shows elsewhere. Starts when the page is idle, stops while the tab is hidden or an
   area is offscreen, draws one still frame for prefers-reduced-motion. Any error or empty answer: the page stays as it is. */
(function () {
	'use strict';
	var API = document.body.dataset.trafficApi || 'https://globe.whereplane.xyz/re-api/';
	var TILES = document.body.dataset.trafficTiles || 'https://globe.whereplane.xyz/pfb-tiles/v2/{z}/{x}/{y}.pbf', TILE_ZOOMS = [4, 10];
	// The zoom whose tiles come out at least this wide: 640 keeps the tile count of the header + band frame at what the
	// separate views needed (512 would need up to a quarter more), and the vector lines stay sharp at up to 2.5x.
	var TILE_PX = 640;
	// v2 has z0-z9 for the whole world and z10 inside these boxes [south, north, west, east] (the stations).
	var DETAIL = [[22, 51, -128, -64], [45.5, 56, 2.5, 18], [39, 48, 17, 31], [49, 59, -11, 2.5], [58, 64, -155, -143], [18, 23, -161, -154]];
	// 'bar': the site header and footer, forest green in header variants a and c, bright green in b (inc/brand.php)
	var AREAS = [['.wp-hero', 'dark'], ['#masthead', 'bar'], ['footer.site-footer', 'bar']];
	// The map's and the traffic's colors, per background: the one place to tune them. On the dark and forest backgrounds the
	// map lightens (a faint watermark: mint water and rivers, yellow-tinted roads); text stays AA because the map is veiled
	// under it (VEIL). On the bright green of variant b it darkens, under black text.
	var LOOKS = {
		dark: { glyph: 'rgba(255,204,0,.55)', trail: [255, 204, 0, 0.18], ring: 'rgba(217,232,222,.07)',
			fill: 'rgb(150,220,180)', fillAlpha: 0.07, edge: 'rgba(190,235,205,.24)', road: 'rgba(255,224,120,.22)', river: 'rgba(150,220,180,.22)' },
		forest: { glyph: 'rgba(255,204,0,.6)', trail: [255, 204, 0, 0.2], ring: 'rgba(217,232,222,.09)',
			fill: 'rgb(160,225,190)', fillAlpha: 0.07, edge: 'rgba(200,240,215,.26)', road: 'rgba(255,226,130,.24)', river: 'rgba(160,225,190,.24)' },
		green: { glyph: 'rgba(11,42,26,.28)', trail: [11, 42, 26, 0.1], ring: 'rgba(11,42,26,.06)',
			fill: 'rgb(0,55,28)', fillAlpha: 0.17, edge: 'rgba(0,55,28,.16)', road: 'rgba(0,40,20,.11)', river: 'rgba(0,55,28,.09)' }
	};
	// Water areas are laid on at fillAlpha (and never veiled): on the forest, .07 keeps the yellow menu text at 4.7:1
	// (5.4:1 on the plain forest). The lines are veiled under text, so they may be brighter.
	var VEIL = [[24, 0.25], [14, 0.4], [6, 0.6], [2, 1]];
	var KEY = 'pfb-traffic-view', KEEP_S = 1800, LAST = 'pfb-traffic-last';
	var TARGET = 30, MIN_VIEW = 8, SPAN_KM = [150, 1500], LINK_KM = 400, REGION_FLOOR = 3;
	var POLL_MS = 20000, MAX_DPR = 1.5, MAX_AGE = 60, KM_LAT = 110.57, KM_LON = 111.32;

	if (!window.fetch || !window.HTMLCanvasElement || !document.querySelector(AREAS.map(function (a) { return a[0]; }).join(','))) return;
	var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	var phone = window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
	var FRAME_MS = phone ? 500 : 250, TRAIL = phone ? 2 : 4;

	var lat0 = 0, lon0 = 0, cosLat = 1, spanKm = 200, box = null, planes = {}, areas = [], frames = [], range = document.createRange();
	var timer = 0, pollTimer = 0, lastPoll = 0, polling = false;

	function now() { return Date.now() / 1000; }

	function get(query) {
		return fetch(API + '?' + query, { mode: 'cors', credentials: 'omit', cache: 'no-store' }).then(function (r) {
			if (!r.ok) throw new Error(r.status);
			return r.json();
		}).then(function (d) {
			if (!d || !Array.isArray(d.aircraft)) throw new Error('no data');
			return d.aircraft.filter(function (a) { return typeof a.lat === 'number' && a.alt_baro !== 'ground'; });
		});
	}

	function remember(save) {
		try {
			if (save) { sessionStorage.setItem(KEY, JSON.stringify({ lat: lat0, lon: lon0, span: spanKm, t: now() })); return null; }
			var v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
			return v && now() - v.t < KEEP_S && typeof v.lat === 'number' ? v : null;
		} catch (e) { return null; }
	}

	function center(lat, lon, span) { lat0 = lat; lon0 = lon; spanKm = span; cosLat = Math.cos(lat0 * Math.PI / 180); }

	// Longitude difference or value folded into [-180, 180), so views and boxes work across the antimeridian.
	function wrap(lon) { return ((lon + 180) % 360 + 360) % 360 - 180; }
	function dist(la1, lo1, la2, lo2) {
		var dx = wrap(lo2 - lo1) * Math.cos((la1 + la2) * Math.PI / 360) * KM_LON, dy = (la2 - la1) * KM_LAT;
		return Math.sqrt(dx * dx + dy * dy);
	}
	function weighted(items, weight) {
		var total = 0, i;
		items.forEach(function (it) { total += weight(it); });
		var r = Math.random() * total;
		for (i = 0; i < items.length - 1; i++) { r -= weight(items[i]); if (r < 0) break; }
		return items[i];
	}

	// The last region shown in this browser, so the next session tends to show another one.
	function lastRegion(save) {
		try {
			if (save) { localStorage.setItem(LAST, JSON.stringify([+lat0.toFixed(2), +lon0.toFixed(2)])); return null; }
			var v = JSON.parse(localStorage.getItem(LAST) || 'null');
			return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? v : null;
		} catch (e) { return null; }
	}

	// 1° cells with aircraft are grouped into regions (cells within LINK_KM of each other chain together). A region is
	// picked weighted by sqrt(its aircraft), at least REGION_FLOOR, so busy places win more often but quiet stations
	// show up too, and the region shown last time counts a quarter. Inside it a cell is picked weighted by count²; the
	// view is centred on the TARGET aircraft nearest to that cell and sized to hold about that many, SPAN_KM[0] to [1] wide.
	function pickView(list) {
		var cells = {}, keys = [];
		list.forEach(function (a) {
			if (Math.abs(a.lat) > 75) return;   // no stations there, and the map would not fit the projection
			var k = Math.floor(a.lat) + ',' + Math.floor(wrap(a.lon));
			if (!cells[k]) { cells[k] = { n: 0, lat: 0, lon: 0, region: null }; keys.push(k); }
			var c = cells[k];
			c.lat += a.lat; c.lon += wrap(a.lon - Math.floor(wrap(a.lon))); c.n++;
		});
		var all = keys.map(function (k) {
			var c = cells[k], p = k.split(',');
			c.lat /= c.n; c.lon = wrap(+p[1] + c.lon / c.n);
			return c;
		}).filter(function (c) { return c.n >= 2; });   // lone aircraft en route don't make a region
		var regions = [];
		all.forEach(function (c) {
			if (c.region) return;
			var r = c.region = { cells: [c], n: 0 }, k;
			for (k = 0; k < r.cells.length; k++) {
				all.forEach(function (d) {
					if (!d.region && dist(r.cells[k].lat, r.cells[k].lon, d.lat, d.lon) < LINK_KM) { d.region = r; r.cells.push(d); }
				});
			}
			r.cells.forEach(function (d) { r.n += d.n; });
			if (r.n >= MIN_VIEW) regions.push(r);
		});
		if (!regions.length) return false;
		var last = lastRegion(false);
		var region = weighted(regions, function (r) {
			var w = Math.max(REGION_FLOOR, Math.sqrt(r.n));
			return regions.length > 1 && last && r.cells.some(function (c) { return dist(c.lat, c.lon, last[0], last[1]) < LINK_KM; }) ? w / 4 : w;
		});
		var seed = weighted(region.cells, function (c) { return c.n * c.n; });
		var near = [];
		list.forEach(function (a) {
			var d = dist(seed.lat, seed.lon, a.lat, a.lon);
			if (d < SPAN_KM[1] / 2) near.push({ a: a, d: d });
		});
		near.sort(function (x, y) { return x.d - y.d; });
		near = near.slice(0, TARGET);
		var la = 0, lo = 0;
		near.forEach(function (x) { la += x.a.lat; lo += wrap(x.a.lon - seed.lon); });
		la /= near.length; lo = wrap(seed.lon + lo / near.length);
		// the narrowest view that holds TARGET of them, for a view about twice as wide as it is tall (the hero)
		cosLat = Math.cos(la * Math.PI / 180);
		var span = SPAN_KM[0];
		function inView(sp) {
			return list.filter(function (x) {
				return Math.abs(wrap(x.lon - lo)) * cosLat * KM_LON < sp / 2 && Math.abs(x.lat - la) * KM_LAT < sp / 4;
			}).length;
		}
		while (span < SPAN_KM[1] && inView(span) < TARGET) span = Math.min(SPAN_KM[1], span * 1.15);
		center(la, lo, span);
		lastRegion(true);
		return true;
	}

	// --- aircraft --------------------------------------------------------------------------------------------------

	function ingest(list) {
		var t = now(), seen = {};
		list.forEach(function (a) {
			if ((a.seen_pos || 0) > MAX_AGE || (phone && parseInt(a.hex, 16) % 2)) return;
			var p = planes[a.hex], fix = { lat: a.lat, lon: a.lon, t: t - (a.seen_pos || 0) };
			if (!p) p = planes[a.hex] = { trail: [], born: t, ox: 0, oy: 0, os: t };
			else {
				p.trail.push(position(p, t));
				if (p.trail.length > TRAIL) p.trail.shift();
			}
			p.fix = fix; p.gs = a.gs || 0; p.track = typeof a.track === 'number' ? a.track : null;
			if (p.trail.length) {
				// Glide from where the dot was drawn to the new estimate instead of jumping.
				var was = p.trail[p.trail.length - 1], is = position(p, t, true);
				p.ox = was[0] - is[0]; p.oy = was[1] - is[1]; p.os = t;
			}
			seen[a.hex] = true;
		});
		Object.keys(planes).forEach(function (hex) { if (!seen[hex]) delete planes[hex]; });
	}

	// [lon, lat] now: the last fix moved along its track at ground speed, for at most MAX_AGE seconds.
	function position(p, t, raw) {
		var dt = Math.min(MAX_AGE, Math.max(0, t - p.fix.t)), km = p.track === null ? 0 : p.gs * 1.852 * dt / 3600;
		var rad = (p.track || 0) * Math.PI / 180;
		var lat = p.fix.lat + km * Math.cos(rad) / KM_LAT, lon = p.fix.lon + km * Math.sin(rad) / (KM_LON * cosLat);
		if (!raw) {
			var f = Math.max(0, 1 - (t - p.os) / 3);
			lat += p.oy * f; lon += p.ox * f;
		}
		return [lon, lat];
	}

	// --- areas -----------------------------------------------------------------------------------------------------

	function canvas(cls) {
		var c = document.createElement('canvas');
		c.className = 'pfb-traffic ' + cls;
		c.setAttribute('aria-hidden', 'true');
		return c;
	}

	function addArea(el, look) {
		var map = canvas('pfb-traffic-map'), live = canvas('pfb-traffic-live');
		el.insertBefore(live, el.firstChild);
		el.insertBefore(map, live);
		el.classList.add('pfb-traffic-on');
		if (look === 'bar') look = document.body.classList.contains('pfb-hv-b') ? 'green' : 'forest';
		var a = { el: el, kind: look, look: LOOKS[look], map: map, live: live, ctx: live.getContext('2d'),
			visible: true, w: 0, h: 0, ox: 0, oy: 0, dpr: 1, frame: null, mapKey: '', text: [], textKey: '' };
		areas.push(a);
		return a;
	}

	// One credit for the page, in the footer (every page has one): the traffic's and the map's.
	function credit() {
		var footer = document.querySelector('footer.site-footer');
		if (!footer) return;
		var line = footer.querySelector('.pfb-traffic-credit') || document.createElement('p');   // the static map credit, if any
		line.className = 'pfb-traffic-credit';
		line.innerHTML = '<a href="https://globe.whereplane.xyz/?lat=' + lat0.toFixed(3) + '&lon=' + lon0.toFixed(3) +
			'&zoom=' + Math.max(5, Math.min(9, Math.round(Math.log(40000 / spanKm) / Math.LN2) + 1)) + '">Live traffic: whereplane.xyz</a> · Map © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap ' +
			'contributors</a>, <a href="https://openmaptiles.org/">OpenMapTiles</a>';
		footer.classList.add('pfb-traffic-credited');
		footer.appendChild(line);
	}

	// The site header and the dark band right below it (a gap of up to 40 px, e.g. a margin, is part of the frame) share
	// a frame; every other area has its own. A frame's position on the page doesn't matter, only its areas' offsets in it.
	// The header's frame comes first and sets the scale of all: the footer, centred on its own, shows the same map at the
	// same size (and needs no tiles of its own: its slice is narrower than the header's frame).
	function group() {
		var head = null, band = null;
		areas.forEach(function (a) { if (a.el.id === 'masthead') head = a; });
		if (head) {
			var h = head.el.getBoundingClientRect();
			areas.forEach(function (a) {
				var r = a.el.getBoundingClientRect(), gap = r.top - h.bottom;
				if (!band && a.kind === 'dark' && gap > -2 && gap <= 40 && r.left < h.right && r.right > h.left) band = a;
			});
		}
		areas.forEach(function (a) {
			if (a.frame) return;
			var f = { areas: a === head && band ? [head, band] : [a], w: 0, h: 0, scale: 1 };
			f.areas.forEach(function (b) { b.frame = f; });
			if (a === head) frames.unshift(f); else frames.push(f);
		});
	}

	// Sizes the frame's canvases and places them in it. Returns whether anything moved or changed size.
	function layout(f) {
		var rs = f.areas.map(function (a) { return a.el.getBoundingClientRect(); });
		var x0 = Math.min.apply(null, rs.map(function (r) { return r.left; })), y0 = Math.min.apply(null, rs.map(function (r) { return r.top; }));
		var w = Math.round(Math.max.apply(null, rs.map(function (r) { return r.right; })) - x0);
		var h = Math.round(Math.max.apply(null, rs.map(function (r) { return r.bottom; })) - y0);
		var changed = w !== f.w || h !== f.h;
		f.w = w; f.h = h;
		f.areas.forEach(function (a, i) {
			var r = rs[i], aw = Math.round(r.width), ah = Math.round(r.height), dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
			var ox = Math.round(r.left - x0), oy = Math.round(r.top - y0);
			if (ox !== a.ox || oy !== a.oy) { a.ox = ox; a.oy = oy; changed = true; }
			if (aw !== a.w || ah !== a.h || dpr !== a.dpr) {
				a.w = aw; a.h = ah; a.dpr = dpr; changed = true;
				a.live.width = a.map.width = Math.round(aw * dpr);
				a.live.height = a.map.height = Math.round(ah * dpr);
			}
		});
		return changed;
	}

	function rescale() {
		var m = frames[0], scale = Math.max(m.w, Math.min(m.h, 1000)) / spanKm;   // px per km: the cluster spans the wider side
		frames.forEach(function (f) { f.scale = scale; });
	}

	function relayout(f) {
		if (!layout(f)) return;
		if (f === frames[0]) rescale();
		boxFor();
		(f === frames[0] ? frames : [f]).forEach(function (g) { g.areas.forEach(draw); });
	}

	function boxFor() {
		var mx = 0, my = 0;
		frames.forEach(function (f) { mx = Math.max(mx, f.w * 0.6 / f.scale); my = Math.max(my, f.h * 0.6 / f.scale); });
		box = boxAround(my, mx);
	}

	// ?box=south,north,west,east; across the antimeridian west > east, which re-api reads as the box that wraps.
	function boxAround(hh, hw) {
		var dlon = Math.min(179, hw / (KM_LON * cosLat));
		return [Math.max(-89, lat0 - hh / KM_LAT), Math.min(89, lat0 + hh / KM_LAT), wrap(lon0 - dlon), wrap(lon0 + dlon)]
			.map(function (v) { return v.toFixed(3); });
	}

	// Canvas pixels in area a: the view's centre is the centre of a's frame.
	function xy(a, lon, lat) {
		var f = a.frame;
		return [f.w / 2 - a.ox + wrap(lon - lon0) * cosLat * KM_LON * f.scale, f.h / 2 - a.oy + (lat0 - lat) * KM_LAT * f.scale];
	}
	// the text's place is part of the key: the veil follows it (fonts load, the cart count changes)
	function mapKey(a) { return [a.w, a.h, a.ox, a.oy, a.frame.w, a.frame.h, a.frame.scale, a.textKey].join(); }

	// Clear the traffic behind every line of text in the area, so text sits on what was there before; keep the lines for the veil.
	function knockout(a) {
		var o = a.el.getBoundingClientRect(), walk = document.createTreeWalker(a.el, NodeFilter.SHOW_TEXT), node, rects, i, r, text = [];
		while ((node = walk.nextNode())) {
			if (!node.nodeValue.trim() || !node.parentElement || node.parentElement.closest('svg, .screen-reader-text') ||
				(node.parentElement.checkVisibility && !node.parentElement.checkVisibility({ visibilityProperty: true, opacityProperty: true }))) continue;
			range.selectNodeContents(node);
			rects = range.getClientRects();
			for (i = 0; i < rects.length; i++) {
				r = rects[i];
				if (r.right < o.left || r.left > o.right || r.bottom < o.top || r.top > o.bottom) continue;
				a.ctx.clearRect(r.left - o.left - 4, r.top - o.top - 4, r.width + 8, r.height + 8);
				text.push([Math.round(r.left - o.left), Math.round(r.top - o.top), Math.round(r.width), Math.round(r.height)]);
			}
		}
		a.text = text;
		a.textKey = text.join(';');
	}

	// Fade the map out under the text (VEIL), feathered: each step removes part of what the steps outside it left.
	function veil(a, ctx) {
		ctx.save();
		ctx.globalCompositeOperation = 'destination-out';
		VEIL.forEach(function (step) {
			ctx.fillStyle = 'rgba(0,0,0,' + step[1] + ')';
			a.text.forEach(function (r) {
				var m = step[0];
				ctx.beginPath();
				if (ctx.roundRect) ctx.roundRect(r[0] - m, r[1] - m, r[2] + 2 * m, r[3] + 2 * m, Math.min(m, 12)); else ctx.rect(r[0] - m, r[1] - m, r[2] + 2 * m, r[3] + 2 * m);
				ctx.fill();
			});
		});
		ctx.restore();
	}

	function draw(a) {
		var ctx = a.ctx, L = a.look, t = now(), w = a.w, h = a.h, f = a.frame;
		if (!w || !h) return;
		ctx.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		// range rings around the center, every 50 km in a 300 km view and up to 250 km in the widest
		ctx.strokeStyle = L.ring; ctx.lineWidth = 1;
		var step = spanKm > 900 ? 250 : spanKm > 450 ? 100 : 50;
		for (var km = step; km * f.scale < Math.max(f.w, f.h); km += step) {
			ctx.beginPath(); ctx.arc(f.w / 2 - a.ox, f.h / 2 - a.oy, km * f.scale, 0, 2 * Math.PI); ctx.stroke();
		}
		ctx.lineCap = 'round';
		Object.keys(planes).forEach(function (hex) {
			var p = planes[hex];
			if (t - p.fix.t > 2 * MAX_AGE) return;   // polls have failed for a while
			var pos = position(p, t), q = xy(a, pos[0], pos[1]);
			if (q[0] < -20 || q[1] < -20 || q[0] > w + 20 || q[1] > h + 20) return;
			var fade = Math.min(1, (t - p.born) / 2), prev = q;
			// trail: the drawn positions at the last few fixes, fainter with age
			for (var j = p.trail.length - 1; j >= 0; j--) {
				var r = xy(a, p.trail[j][0], p.trail[j][1]);
				ctx.strokeStyle = 'rgba(' + L.trail.slice(0, 3).join(',') + ',' + (L.trail[3] * fade * (j + 1) / p.trail.length).toFixed(3) + ')';
				ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(r[0], r[1]); ctx.stroke();
				prev = r;
			}
			ctx.globalAlpha = fade;
			ctx.fillStyle = L.glyph;
			ctx.beginPath();
			if (p.track === null) ctx.arc(q[0], q[1], 1.6, 0, 2 * Math.PI);
			else {
				// small arrowhead pointing along the track
				var g = p.track * Math.PI / 180, s = Math.sin(g), c = Math.cos(g);
				ctx.moveTo(q[0] + 4 * s, q[1] - 4 * c);
				ctx.lineTo(q[0] - 3 * s + 2.4 * c, q[1] + 3 * c + 2.4 * s);
				ctx.lineTo(q[0] - 1.6 * s, q[1] + 1.6 * c);
				ctx.lineTo(q[0] - 3 * s - 2.4 * c, q[1] + 3 * c - 2.4 * s);
				ctx.closePath();
			}
			ctx.fill();
			ctx.globalAlpha = 1;
		});
		knockout(a);
		if (a.mapKey !== mapKey(a)) basemap(a);
	}

	// --- basemap: vector tiles (Mapbox Vector Tile protobuf), decoded here -------------------------------------------

	function Pbf(buf) { this.b = new Uint8Array(buf); this.v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength); this.p = 0; }
	Pbf.prototype = {
		varint: function () {
			var r = 0, m = 1, b;
			do { b = this.b[this.p++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
			return r;
		},
		zigzag: function () { var n = this.varint(); return n % 2 ? -(n + 1) / 2 : n / 2; },
		bytes: function () { var n = this.varint(), s = this.p; this.p += n; return new Pbf(this.b.subarray(s, s + n)); },
		string: function () { var n = this.varint(), s = this.p; this.p += n; return new TextDecoder().decode(this.b.subarray(s, s + n)); },
		skip: function (type) {
			if (type === 0) this.varint();
			else if (type === 1) this.p += 8;
			else if (type === 2) this.p += this.varint();
			else if (type === 5) this.p += 4;
			else throw new Error('pbf');
		},
		// calls fn(field, type) for each field; fn returns true if it read the value
		each: function (fn) {
			while (this.p < this.b.length) {
				var tag = this.varint(), field = Math.floor(tag / 8), type = tag & 7;
				if (!fn(field, type)) this.skip(type);
			}
		},
		packed: function () { var r = this.bytes(), out = []; while (r.p < r.b.length) out.push(r.varint()); return out; }
	};

	function value(r) {
		var out = null;
		r.each(function (f) {
			if (f === 1) out = r.string();
			else if (f === 2) { out = r.v.getFloat32(r.p, true); r.p += 4; }
			else if (f === 3) { out = r.v.getFloat64(r.p, true); r.p += 8; }
			else if (f === 4 || f === 5) out = r.varint();
			else if (f === 6) out = r.zigzag();
			else if (f === 7) out = !!r.varint();
			else return false;
			return true;
		});
		return out;
	}

	// {layer name: {extent, features: [{type, props, rings}]}}, only the layers asked for.
	function decode(buf, wanted) {
		var tile = {}, r = new Pbf(buf);
		r.each(function (f) {
			if (f !== 3) return false;
			var l = r.bytes(), name = '', extent = 4096, keys = [], values = [], raw = [];
			l.each(function (g) {
				if (g === 1) name = l.string();
				else if (g === 2) raw.push(l.bytes());
				else if (g === 3) keys.push(l.string());
				else if (g === 4) values.push(value(l.bytes()));
				else if (g === 5) extent = l.varint();
				else return false;
				return true;
			});
			if (!wanted[name]) return true;
			tile[name] = { extent: extent, features: raw.map(function (fr) {
				var feature = { type: 0, props: {}, rings: [] }, tags = [], geometry = [];
				fr.each(function (h) {
					if (h === 2) tags = fr.packed();
					else if (h === 3) feature.type = fr.varint();
					else if (h === 4) geometry = fr.packed();
					else return false;
					return true;
				});
				for (var i = 0; i + 1 < tags.length; i += 2) feature.props[keys[tags[i]]] = values[tags[i + 1]];
				var x = 0, y = 0, ring = null;
				for (var k = 0; k < geometry.length;) {
					var cmd = geometry[k] & 7, n = Math.floor(geometry[k++] / 8);
					if (cmd === 7) { if (ring && ring.length) ring.push(ring[0]); continue; }
					for (var m = 0; m < n; m++) {
						var dx = geometry[k++], dy = geometry[k++];
						x += dx % 2 ? -(dx + 1) / 2 : dx / 2; y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
						if (cmd === 1) feature.rings.push(ring = []);
						ring.push([x, y]);
					}
				}
				return feature;
			}) };
			return true;
		});
		return tile;
	}

	var tiles = {}, WANTED = { water: 1, waterway: 1, transportation: 1 };
	function tile(z, x, y) {
		var key = z + '/' + x + '/' + y;
		return tiles[key] || (tiles[key] = fetch(TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y),
			{ mode: 'cors', credentials: 'omit' }).then(function (r) {
			if (!r.ok) throw new Error(r.status);
			return r.status === 204 ? new ArrayBuffer(0) : r.arrayBuffer();   // 204: an empty tile or outside the coverage
		}).then(function (buf) {
			if (!buf.byteLength) return buf;
			var head = new Uint8Array(buf, 0, 2);
			if (head[0] === 0x1f && head[1] === 0x8b && window.DecompressionStream) {
				// gzip the server didn't mark with Content-Encoding
				return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
			}
			return buf;
		}).then(function (buf) { return decode(buf, WANTED); }).catch(function () { return null; }));
	}

	function tileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
	function tileY(lat, z) { var r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); }

	// The area's slice of its frame's map, drawn once (again after a resize): each tile clipped to itself so polygon edges
	// at tile borders don't show. The areas of a frame use the same zoom, so the tiles at their border are fetched once.
	function basemap(a) {
		var key = a.mapKey = mapKey(a), f = a.frame;
		var detail = DETAIL.some(function (b) { return lat0 >= b[0] && lat0 <= b[1] && wrap(lon0) >= b[2] && wrap(lon0) <= b[3]; });
		var z = Math.max(TILE_ZOOMS[0], Math.min(detail ? TILE_ZOOMS[1] : 9, Math.floor(Math.log(40075 * cosLat * f.scale / TILE_PX) / Math.LN2)));
		// the area's edges in km from the view's centre (east and north positive)
		var west = (a.ox - f.w / 2) / f.scale, east = west + a.w / f.scale, north = (f.h / 2 - a.oy) / f.scale, south = north - a.h / f.scale;
		var n = Math.pow(2, z), jobs = [];
		var x0 = Math.floor(tileX(lon0 + west / (KM_LON * cosLat), z)), x1 = Math.floor(tileX(lon0 + east / (KM_LON * cosLat), z));
		var y0 = Math.max(0, Math.floor(tileY(Math.min(85, lat0 + north / KM_LAT), z))), y1 = Math.min(n - 1, Math.floor(tileY(Math.max(-85, lat0 + south / KM_LAT), z)));
		for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) jobs.push([x, y]);
		Promise.all(jobs.map(function (j) { return tile(z, (j[0] % n + n) % n, j[1]); })).then(function (found) {
			if (a.mapKey !== key) return;
			var ctx = a.map.getContext('2d'), B = a.look, drawn = 0;
			// Water areas go on a layer of their own, opaque, laid under the lines at B.fillAlpha once: overlapping
			// polygons can't stack up past what the text's contrast allows, and the veil leaves them as they are.
			var under = document.createElement('canvas'), fctx = under.getContext('2d');
			under.width = a.map.width; under.height = a.map.height;
			[ctx, fctx].forEach(function (c) {
				c.setTransform(1, 0, 0, 1, 0, 0);
				c.clearRect(0, 0, a.map.width, a.map.height);
				c.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
				c.lineJoin = 'round';
			});
			fctx.fillStyle = B.fill;
			found.forEach(function (t, j) {
				if (!t || !Object.keys(t).length) return;
				drawn++;
				function pt(px, py, ext) {
					var gx = (jobs[j][0] + px / ext) / n, gy = (jobs[j][1] + py / ext) / n;
					return xy(a, gx * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180 / Math.PI);
				}
				function layer(name, test, paint) {
					var l = t[name];
					if (!l) return;
					l.features.forEach(function (f) {
						if (test && !test(f.props)) return;
						var path = new Path2D();
						f.rings.forEach(function (ring) {
							ring.forEach(function (p, k) { var q = pt(p[0], p[1], l.extent); if (k) path.lineTo(q[0], q[1]); else path.moveTo(q[0], q[1]); });
						});
						paint(path, f);
					});
				}
				var c0 = pt(0, 0, 1), c1 = pt(1, 1, 1), clip = new Path2D();
				clip.rect(c0[0], c0[1], c1[0] - c0[0], c1[1] - c0[1]);
				ctx.save(); fctx.save();
				ctx.clip(clip); fctx.clip(clip);
				layer('water', null, function (path) {
					fctx.fill(path, 'evenodd');
					ctx.strokeStyle = B.edge; ctx.lineWidth = 1; ctx.stroke(path);
				});
				layer('waterway', function (p) { return p['class'] === 'river'; }, function (path) {
					ctx.strokeStyle = B.river; ctx.lineWidth = 1; ctx.stroke(path);
				});
				layer('transportation', function (p) { return /^(motorway|trunk|primary)$/.test(p['class']); }, function (path, f) {
					ctx.strokeStyle = B.road; ctx.lineWidth = f.props['class'] === 'motorway' ? 1.3 : 0.8; ctx.stroke(path);
				});
				ctx.restore(); fctx.restore();
			});
			veil(a, ctx);
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = 'destination-over';
			ctx.globalAlpha = B.fillAlpha;
			ctx.drawImage(under, 0, 0);
			ctx.restore();
		});
	}

	// --- running ---------------------------------------------------------------------------------------------------

	function running() { return !reduce && !document.hidden && areas.some(function (a) { return a.visible; }); }

	function loop() {
		timer = 0;
		if (!running()) return;
		requestAnimationFrame(function () { areas.forEach(function (a) { if (a.visible) draw(a); }); });
		timer = setTimeout(loop, FRAME_MS);
	}

	function poll() {
		pollTimer = 0;
		if (!running() || polling) return;
		polling = true;
		lastPoll = Date.now();
		get('box=' + box.join(',')).then(ingest, function () { /* keep dead-reckoning; aircraft expire after MAX_AGE */ }).then(function () {
			polling = false;
			if (running()) pollTimer = setTimeout(poll, POLL_MS);
		});
	}

	function resume() {
		if (!running()) return;
		if (!timer) loop();
		if (!pollTimer && !polling) pollTimer = setTimeout(poll, Math.max(0, POLL_MS - (Date.now() - lastPoll)));
	}

	function pause() {
		clearTimeout(timer); timer = 0;
		clearTimeout(pollTimer); pollTimer = 0;
	}

	function show(list) {
		var found = [];
		AREAS.forEach(function (spec) {
			var el = document.querySelector(spec[0]);
			if (el && found.indexOf(el) < 0) {
				found.push(el);
				addArea(el, spec[1]);
			}
		});
		credit();
		group();
		frames.forEach(layout);
		rescale();
		boxFor();
		ingest(list);
		lastPoll = Date.now();
		areas.forEach(draw);
		if ('ResizeObserver' in window) {
			areas.forEach(function (a) {
				new ResizeObserver(function () { relayout(a.frame); }).observe(a.el);
			});
		}
		if ('IntersectionObserver' in window) {
			var seen = new IntersectionObserver(function (entries) {
				entries.forEach(function (e) {
					areas.forEach(function (a) { if (a.el === e.target) a.visible = e.isIntersecting; });
				});
				if (running()) resume(); else pause();
			});
			areas.forEach(function (a) { seen.observe(a.el); });
		}
		document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); else resume(); });
		resume();
	}

	function fresh() {
		get('all_with_pos').then(function (list) {
			if (!pickView(list)) return;
			remember(true);
			show(list);
		}, function () {});
	}

	function start() {
		var saved = remember(false);
		if (!saved) return fresh();
		// A view picked earlier in this tab: only its box is fetched.
		center(saved.lat, saved.lon, saved.span);
		box = boxAround(spanKm * 0.75, spanKm * 0.75);
		get('box=' + box.join(',')).then(function (list) {
			if (list.length < 3) { try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } return fresh(); }
			show(list);
		}, function () {});
	}

	function idle() {
		if (window.requestIdleCallback) requestIdleCallback(start, { timeout: 4000 });
		else setTimeout(start, 1500);
	}
	if (document.readyState === 'complete') idle();
	else window.addEventListener('load', idle);
})();
