/*
 |--------------------------------------------------------------------------
 | build public/poker/dist/*.min.js from legacy-src/poker
 |--------------------------------------------------------------------------
 | The Laravel app compiled poker.js / poker-mobile.js with laravel-elixir
 | (`mix.browserify(...)` = browserify + babelify on Babel 5) into public/dist,
 | which was gitignored and so never moved into this repo. This rebuilds the
 | same bundles with the same toolchain, from the unmodified legacy sources.
 | Babel 5 matters: the sources rely on its leniency (arrow functions called
 | inside their parentheses, Flow annotations) and on its CommonJS interop
 | (`require()` of a module with only a default export returns that export).
 |
 |   node legacy-build/poker.mjs
 |
 | The build tools live in legacy-build/poker (package.json + lockfile).
 |
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = path.join(ROOT, 'legacy-src/poker/js');
const OUT  = path.join(ROOT, 'public/poker/dist');

// toolchain + runtime deps of the former poker/package.json (socket.io-client 2.x
// talks to the socket.io 4 socket-server through its allowEIO3 option)
const DEPS = ['browserify@13.3.0', 'babelify@6.4.0', 'uglify-js@3.19.3',
	'babel-polyfill@6.26.0', 'es5-shim@4.5.9', 'es6-shim@0.35.3', 'jquery@3.2.1', 'lodash@4.17.4',
	'socket.io-client@2.0.1', 'crypto-js@3.1.9-1', 'uuid@3.1.0'];

const work = process.env.POKER_BUILD_DIR || path.join(ROOT, 'legacy-build/poker');
const bin = name => path.join(work, 'node_modules/.bin', name);

mkdirSync(work, { recursive : true });
if (!DEPS.every(d => existsSync(path.join(work, 'node_modules', d.replace(/@[^@]+$/, ''))))) {
	if (!existsSync(path.join(work, 'package.json'))) writeFileSync(path.join(work, 'package.json'), '{"private":true}');
	execFileSync('npm', ['install', '--no-audit', '--no-fund', ...DEPS], { cwd : work, stdio : 'inherit' });
}

mkdirSync(OUT, { recursive : true });
const env = { ...process.env, NODE_PATH : path.join(work, 'node_modules'), NODE_NO_WARNINGS : '1' };

for (const entry of ['poker', 'poker-mobile']) {
	const raw = path.join(work, `${entry}.js`);
	const out = path.join(OUT, `${entry}.min.js`);
	execFileSync(bin('browserify'), [`${entry}.js`, '-t', '[', path.join(work, 'node_modules/babelify'), ']', '-o', raw],
		{ cwd : SRC, env, stdio : 'inherit' });
	execFileSync(bin('uglifyjs'), [raw, '--compress', '--mangle', '-o', out], { env, stdio : 'inherit' });
	console.log(`built ${path.relative(ROOT, out)}`);
}
