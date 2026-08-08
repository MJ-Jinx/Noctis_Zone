// Real upstream mismatch, found while fixing darkveil-widget's
// webpack build: isomorphic-ws's own browser.js (its `browser` package.json
// field target, correctly resolved for target:'web') only has
// `export default ws` — no named `WebSocket` export exists there at all
// (confirmed by reading the real published package source directly).
// @midnight-ntwrk/midnight-js-indexer-public-data-provider's compiled
// output does `import { WebSocket as ws } from 'isomorphic-ws'`, which is
// unsatisfiable against that real shape — a genuine upstream/bundler-
// interop mismatch, not something this project got wrong. Aliased in
// webpack.widgets.config.cjs (resolve.alias) to re-export the same browser
// global lookup both ways, satisfying either import style.
const ws =
	(typeof WebSocket !== "undefined" && WebSocket) ||
	(typeof MozWebSocket !== "undefined" && MozWebSocket) ||
	(typeof globalThis !== "undefined" &&
		(globalThis.WebSocket || globalThis.MozWebSocket)) ||
	null;

export default ws;
export { ws as WebSocket };
