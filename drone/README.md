# drone: drones on the globe

tar1090 has no small-drone icon, and globe re-downloads tar1090 every week (`UPDATE_TAR1090`), so
nothing here edits tar1090's files.

- `08-pfb-drone` (s6 startup, after `07-nginx-configure`) adds `/etc/nginx/pfb-drone.conf` to tar1090's
  nginx site: it serves `drone.js` as `/pfb-drone.js` and, with `sub_filter`, adds it to `index.html`
  as nginx serves it, after tar1090's `<!-- JS_ANCHOR3 -->` comment (right after `markers.js`). Updates
  rewrite `index.html`; the comment stays, so the script does too. If `nginx -t` fails, the site goes
  back as it was.
- `drone.js`, in the browser:
  - Adds a quadcopter shape (4 rotor rings on an X frame) and uses it where tar1090 would draw its
    `uav` icon for category B6 with type `other` (readsbee's Remote ID drones).
  - WebGL (tar1090's default) draws icons from a sprite sheet: it copies tar1090's sheet, draws the
    drone into the next cell and rebuilds the WebGL layer with tar1090's own `webglAddLayer()`.
  - Polls `/data/remoteid.json` (readsbee `--readsbee-rid-operator`): a REMOTE ID section in the
    details panel (UAS ID, Self-ID, operator ID, operator location and distance, link) and an
    operator marker with a dashed line to its drone. A click on it selects the drone. Drones
    hidden by filters or `?feed=` get no marker.

Fails safe: every tar1090 name it uses is checked first and each part is in `try`. Missing anchor,
renamed functions, a failed WebGL rebuild: drones keep tar1090's icon, the rest of the globe is
unchanged.
