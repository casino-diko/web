// Rebuilds the legacy Dragon-Tiger browser bundles (replacement for laravel-elixir `mix.browserify`).
// Each legacy source file is first run through Babel 5.8.38 — the exact compiler the original build
// used (laravel-elixir 3 -> babelify 6.4.0 -> babel-core 5.8.38, per dragon-tiger/package-lock.json).
// The sources depend on Babel 5 behaviour: Flow annotations (`let x : {...}`), directly-invoked arrow
// functions `((i) => {...}(i))`, and Babel 5's CommonJS interop where a module with only
// `export default` sets `module.exports = default` (boot.js does `global.blu = require('./blu/blu')`).
// esbuild then bundles the resulting CommonJS modules plus npm deps into one minified IIFE each.
// Usage: node legacy-build/games/build.mjs <baccarat|dragon-tiger>
//        (npm --prefix legacy-build/games ci first; deps resolve from this directory's node_modules)
import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const babel = require('babel-core');

const APP = process.argv[2];
if (!['baccarat', 'dragon-tiger'].includes(APP)) {
  console.error('usage: node legacy-build/games/build.mjs <baccarat|dragon-tiger>');
  process.exit(1);
}
const ROOT = path.join(here, '..', '..');
const SRC = path.join(ROOT, 'legacy-src', APP, 'js');
// both apps' gulpfiles bundle the entries dragon-tiger.js / dragon-tiger-mobile.js
const ENTRIES = ['dragon-tiger', 'dragon-tiger-mobile'];
const OUT = path.join(ROOT, 'public', APP, 'dist');
const OUTNAMES = APP === 'baccarat'
  ? { 'dragon-tiger' : 'baccarat.min.js', 'dragon-tiger-mobile' : 'baccarat-mobile.min.js' }
  : { 'dragon-tiger' : 'dragon-tiger.min.js', 'dragon-tiger-mobile' : 'dragon-tiger-mobile.min.js' };

const babel5 = {
  name: 'babel5-legacy',
  setup(b) {
    b.onLoad({ filter: /\.js$/ }, async (args) => {
      if (!args.path.startsWith(SRC + path.sep)) return; // npm deps: leave to esbuild
      const code = await fs.readFile(args.path, 'utf8');
      const out = babel.transform(code, { filename: args.path, babelrc: false, sourceMaps: false });
      let contents = out.code;
      // Babel's file-level "use strict" in the ENTRY would be hoisted by esbuild to the top of the
      // whole bundle, making every npm dep strict too (browserify kept deps sloppy). Scope it to a
      // function instead so only the legacy modules are strict, as in the original build.
      if (ENTRIES.includes(path.basename(args.path, '.js')) && path.dirname(args.path) === SRC) contents = '(function(){' + contents + '\n})();';
      return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
    });
  },
};

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2015',
  minify: !process.env.DT_DEBUG,
  define: { global: 'window' },
  nodePaths: [path.join(here, 'node_modules')],
  absWorkingDir: here,
  plugins: [babel5],
  logLevel: 'warning',
  legalComments: 'none',
  metafile: true,
};

for (const name of ENTRIES) {
  const r = await esbuild.build({ ...common, entryPoints: [path.join(SRC, `${name}.js`)], outfile: path.join(OUT, OUTNAMES[name]) });
  const pkgs = new Set(Object.keys(r.metafile.inputs).filter((p) => p.includes('node_modules/')).map((p) => p.split('node_modules/').pop().split('/')[0]));
  console.log(`${name}.min.js  warnings=${r.warnings.length}  npm deps: ${[...pkgs].sort().join(', ')}`);
}
