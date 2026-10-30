#!/usr/bin/env node
/*
 |--------------------------------------------------------------------------
 | build-lobby-assets
 |--------------------------------------------------------------------------
 | Rebuilds the lobby's compiled browser assets, which the Laravel app never
 | committed (/public/dist and /public/css were gitignored build outputs of
 | lobby/gulpfile.js: browserify + babel and compass):
 |
 |   legacy-src/lobby/js/3.0/main.js               -> public/lobby/dist/main-3.0.js
 |   legacy-src/lobby/js/3.0/mobile/main-mobile.js -> public/lobby/dist/main-mobile-3.0.js
 |   legacy-src/lobby/sass/app.scss                -> public/lobby/css/app.css
 |
 | The sources are not modified; two legacy quirks are bridged at build time:
 |  - Babel 6 accepted `export default () => {...}();` (js/blu) and let
 |    `import { a } from './x'` read a property of `export default { a }`;
 |  - Ruby Sass accepted line breaks inside quoted strings.
 |
 | Build tools / bundled libraries (not app dependencies):
 |   npm i --no-save esbuild@0.25 sass@1.77 compass-mixins@0.12 jquery@3.2.1 lodash@4 moment@2 \
 |     socket.io-client@2.0.1 sweetalert@2 babel-polyfill@6 es5-shim@4 es6-shim@0.35 crypto-js@3.1.9-1 uuid@3
 | (or point LOBBY_BUILD_MODULES at a node_modules directory holding them)
 |
 |   node legacy-build/lobby.mjs
 |
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = path.resolve(process.env.LOBBY_BUILD_MODULES || path.join(ROOT, 'node_modules'));
const require = createRequire(path.join(MODULES, 'noop.js'));
const esbuild = require('esbuild');
const sass = require('sass');

const SRC = path.join(ROOT, 'legacy-src/lobby');
const OUT = path.join(ROOT, 'public/lobby');

// ------------------------------------------------------------------ js

const legacyInterop = {
	name : 'legacy-interop',
	setup (build) {
		build.onLoad({ filter : /legacy-src[\\/].*\.js$/ }, async args => {
			let code = await readFile(args.path, 'utf8');
			if (/blu[\\/]blu(-mobile)?\.js$/.test(args.path)) {
				code = code.replace(/export default \(\) => \{/, 'export default (() => {').replace(/\}\(\);\s*$/, '})();\n');
			}
			const m = /export\s+default\s*\{([\w\s,$]+)\}\s*;?\s*$/.exec(code);
			if (m) {
				const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
				const exported = new Set([...code.matchAll(/export\s+(?:const|let|var|function|class)\s+([\w$]+)/g)].map(x => x[1]));
				const declared = n => new RegExp(`(?:\\b(?:const|let|var|function|class)\\s+|import\\s*\\{[^}]*\\b|import\\s+)${n.replace('$', '\\$')}\\b`).test(code);
				for (const n of names.filter(x => !exported.has(x))) {
					// implicit globals (`toggle = {...}`, declared by the page) go through a const alias
					code += declared(n) ? `\nexport { ${n} };` : `\nconst __legacy_${n} = ${n};\nexport { __legacy_${n} as ${n} };`;
				}
			}
			return { contents : code, loader : 'js' };
		});
	}
};

async function js (entry, out) {
	await esbuild.build({
		entryPoints : [path.join(SRC, 'js', entry)],
		outfile     : path.join(OUT, out),
		bundle      : true,
		format      : 'iife',
		target      : 'es2017',
		minify      : true,
		define      : { global : 'window' },
		nodePaths   : [MODULES],
		logLevel    : 'error',
		plugins     : [legacyInterop]
	});
	console.log(`built public/lobby/${out}`);
}

// ------------------------------------------------------------------ css

// line breaks inside quoted strings -> spaces (comments are left alone)
function joinMultilineStrings (src) {
	let out = '';
	let q = null;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (q) {
			if (c === '\\') { out += c + src[++i]; continue; }
			if (c === q) q = null;
			out += c === '\n' ? ' ' : c;
		} else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
			const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2;
			const j = end <= 1 || end < i ? src.length : end;
			out += src.slice(i, j);
			i = j - 1;
		} else {
			if (c === '"' || c === '\'') q = c;
			out += c;
		}
	}
	return out;
}

function css (entry, out) {
	const loadPaths = [path.join(MODULES, 'compass-mixins/lib')];
	const candidates = p => {
		const dir = path.dirname(p), base = path.basename(p);
		if (/\.s?css$/.test(base)) return [p, path.join(dir, `_${base}`)];
		return [`${base}.scss`, `_${base}.scss`, `${base}.css`, `${base}/_index.scss`, `${base}/index.scss`].map(n => path.join(dir, n));
	};
	const importer = {
		canonicalize (url, ctx) {
			if (/^(https?:)?\/\//.test(url)) return null;
			const bases = [ctx.containingUrl ? path.dirname(fileURLToPath(ctx.containingUrl)) : path.join(SRC, 'sass'), ...loadPaths];
			for (const b of bases) {
				for (const c of candidates(path.resolve(b, url.replace(/^file:\/\//, '')))) if (existsSync(c)) return pathToFileURL(c);
			}
			return null;
		},
		load (url) {
			const file = fileURLToPath(url);
			const text = readFileSync(file, 'utf8');
			return { contents : file.startsWith(SRC) ? joinMultilineStrings(text) : text, syntax : file.endsWith('.css') ? 'css' : 'scss' };
		}
	};
	const file = path.join(SRC, 'sass', entry);
	const res = sass.compileString(joinMultilineStrings(readFileSync(file, 'utf8')), {
		url : pathToFileURL(file), importer, importers : [importer], style : 'compressed', logger : sass.Logger.silent
	});
	mkdirSync(path.dirname(path.join(OUT, out)), { recursive : true });
	writeFileSync(path.join(OUT, out), res.css);
	console.log(`built public/lobby/${out}`);
}

await js('3.0/main.js', 'dist/main-3.0.js');
await js('3.0/mobile/main-mobile.js', 'dist/main-mobile-3.0.js');
css('app.scss', 'css/app.css');
