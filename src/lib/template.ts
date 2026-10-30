/*
 |--------------------------------------------------------------------------
 | template
 |--------------------------------------------------------------------------
 | A small Blade-compatible subset used for the former .blade.php views,
 | stored as templates/<app>/<name>.html and rendered into full HTML pages
 | by route handlers (the legacy pages are not React apps).
 |
 |   {{ expr }}            escaped output         {!! expr !!}   raw output
 |   @{{ x }}              literal "{{ x }}" (Vue / Angular bindings)
 |   {{-- comment --}}     removed
 |   @if(expr) @elseif(expr) @else @endif
 |   @foreach(expr as name) ... @endforeach     (name, loop.index, loop.first, loop.last)
 |   @include('name')      another template of the same app, same context
 |
 | Expressions: paths (user.money, tables.0.id), 'strings', numbers,
 | true/false/null, ! && || == != > < >= <=, parentheses, `a ?? b`, and the
 | helpers t('file.key'), json(value), upper(value), lower(value).
 | No PHP: compute everything else in the route handler and pass it in.
 |
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { translator } from './i18n';
import type { App } from './config';

type Ctx = Record<string, any>;
type Node =
	| { type : 'text'; value : string }
	| { type : 'echo'; expr : string; raw : boolean }
	| { type : 'if'; branches : { cond : string | null; body : Node[] }[] }
	| { type : 'foreach'; expr : string; name : string; body : Node[] }
	| { type : 'include'; name : string };

const ROOT = path.join(process.cwd(), 'templates');
const cache = new Map<string, Node[]>();
const DEV = process.env.NODE_ENV !== 'production';

// ------------------------------------------------------------------ parsing

const TOKEN = /@\{\{|\{\{--[\s\S]*?--\}\}|\{!!([\s\S]*?)!!\}|\{\{([\s\S]*?)\}\}|@(if|elseif|foreach|include)\s*\(|@(else|endif|endforeach)\b/g;

// returns the index just after the parenthesis matching the one before `start`
function closeParen (src: string, start: number): number {
	let depth = 1;
	let quote: string | null = null;
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = null;
		} else if (c === '\'' || c === '"') quote = c;
		else if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return i + 1;
	}
	throw new Error('unclosed directive parenthesis');
}

function parse (src: string, file: string): Node[] {
	const root: Node[] = [];
	const stack: { node : Node | null; body : Node[] }[] = [{ node : null, body : root }];
	const body = () => stack[stack.length - 1].body;
	let last = 0;
	let m: RegExpExecArray | null;

	TOKEN.lastIndex = 0;
	while ((m = TOKEN.exec(src))) {
		if (m.index > last) body().push({ type : 'text', value : src.slice(last, m.index) });
		last = TOKEN.lastIndex;
		const tok = m[0];

		if (tok === '@{{') {
			body().push({ type : 'text', value : '{{' });
		} else if (tok.startsWith('{{--')) {
			// comment
		} else if (m[1] !== undefined) {
			body().push({ type : 'echo', expr : m[1].trim(), raw : true });
		} else if (m[2] !== undefined) {
			body().push({ type : 'echo', expr : m[2].trim(), raw : false });
		} else if (m[3]) {
			const end = closeParen(src, TOKEN.lastIndex);
			const arg = src.slice(TOKEN.lastIndex, end - 1).trim();
			last = TOKEN.lastIndex = end;

			if (m[3] === 'if') {
				const node: Node = { type : 'if', branches : [{ cond : arg, body : [] }] };
				body().push(node);
				stack.push({ node, body : node.branches[0].body });
			} else if (m[3] === 'elseif') {
				const top = stack[stack.length - 1].node;
				if (!top || top.type !== 'if') throw new Error(`${file}: @elseif without @if`);
				const branch = { cond : arg, body : [] as Node[] };
				top.branches.push(branch);
				stack[stack.length - 1].body = branch.body;
			} else if (m[3] === 'foreach') {
				const fm = /^(.*)\s+as\s+\$?([A-Za-z_]\w*)$/.exec(arg);
				if (!fm) throw new Error(`${file}: bad @foreach(${arg})`);
				const node: Node = { type : 'foreach', expr : fm[1].trim(), name : fm[2], body : [] };
				body().push(node);
				stack.push({ node, body : node.body });
			} else {
				body().push({ type : 'include', name : arg.replace(/^['"]|['"]$/g, '') });
			}
		} else if (m[4] === 'else') {
			const top = stack[stack.length - 1].node;
			if (!top || top.type !== 'if') throw new Error(`${file}: @else without @if`);
			const branch = { cond : null, body : [] as Node[] };
			top.branches.push(branch);
			stack[stack.length - 1].body = branch.body;
		} else {
			const expected = m[4] === 'endif' ? 'if' : 'foreach';
			const top = stack.pop();
			if (!top || !top.node || top.node.type !== expected) throw new Error(`${file}: unexpected @${m[4]}`);
		}
	}
	if (last < src.length) root.push({ type : 'text', value : src.slice(last) });
	if (stack.length !== 1) throw new Error(`${file}: unclosed @${(stack[stack.length - 1].node as any).type}`);
	return root;
}

// ------------------------------------------------------------------ expressions

const EXPR_TOKEN = /\s*(?:('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|(\d+(?:\.\d+)?)|(\?\?|&&|\|\||==|!=|>=|<=|[!()<>,])|([A-Za-z_$][\w$]*(?:\.[\w$]+)*))/y;

function tokenize (src: string) {
	const tokens: { t : string; v : any }[] = [];
	EXPR_TOKEN.lastIndex = 0;
	let pos = 0;
	while (pos < src.length) {
		if (/^\s*$/.test(src.slice(pos))) break;
		EXPR_TOKEN.lastIndex = pos;
		const m = EXPR_TOKEN.exec(src);
		if (!m) throw new Error(`bad expression: ${src}`);
		pos = EXPR_TOKEN.lastIndex;
		if (m[1]) tokens.push({ t : 'lit', v : m[1].slice(1, -1).replace(/\\(.)/g, '$1') });
		else if (m[2]) tokens.push({ t : 'lit', v : Number(m[2]) });
		else if (m[3]) tokens.push({ t : m[3], v : m[3] });
		else tokens.push({ t : 'id', v : m[4] });
	}
	return tokens;
}

const lookup = (ctx: Ctx, p: string) => p.replace(/^\$/, '').split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);

function evaluate (src: string, ctx: Ctx, helpers: Record<string, (...a: any[]) => any>): any {
	const tokens = tokenize(src);
	let i = 0;
	const peek = () => tokens[i] && tokens[i].t;
	const take = (t?: string) => {
		const tok = tokens[i++];
		if (!tok || (t && tok.t !== t)) throw new Error(`bad expression: ${src}`);
		return tok;
	};

	const primary = (): any => {
		const tok = take();
		if (tok.t === 'lit') return tok.v;
		if (tok.t === '(') {
			const v = or();
			take(')');
			return v;
		}
		if (tok.t === '!') return !primary();
		if (tok.t === 'id') {
			if (tok.v === 'true') return true;
			if (tok.v === 'false') return false;
			if (tok.v === 'null') return null;
			if (peek() === '(') {
				take('(');
				const args: any[] = [];
				while (peek() !== ')') {
					args.push(or());
					if (peek() === ',') take(',');
				}
				take(')');
				const fn = helpers[tok.v];
				if (!fn) throw new Error(`unknown template helper ${tok.v}()`);
				return fn(...args);
			}
			return lookup(ctx, tok.v);
		}
		throw new Error(`bad expression: ${src}`);
	};
	const compare = (): any => {
		let v = primary();
		while (['==', '!=', '>', '<', '>=', '<='].includes(peek())) {
			const op = take().t;
			const r = primary();
			// loose like PHP / Blade
			v = op === '==' ? v == r : op === '!=' ? v != r : op === '>' ? v > r : op === '<' ? v < r : op === '>=' ? v >= r : v <= r;
		}
		return v;
	};
	const and = (): any => {
		let v = compare();
		while (peek() === '&&') { take(); const r = compare(); v = v && r; }
		return v;
	};
	const or = (): any => {
		let v = and();
		while (peek() === '||' || peek() === '??') {
			const op = take().t;
			const r = and();
			v = op === '||' ? v || r : (v ?? r);
		}
		return v;
	};

	const value = or();
	if (i < tokens.length) throw new Error(`bad expression: ${src}`);
	return value;
}

// ------------------------------------------------------------------ rendering

const escapeHtml = (v: any) => String(v ?? '').replace(/[&<>"']/g, c =>
	({ '&' : '&amp;', '<' : '&lt;', '>' : '&gt;', '"' : '&quot;', '\'' : '&#039;' }[c] as string));

const output = (v: any) => (v === null || v === undefined || v === false) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));

function load (app: App, name: string): Node[] {
	const key = `${app}/${name}`;
	if (!DEV && cache.has(key)) return cache.get(key);
	const file = path.join(ROOT, app, `${name}.html`);
	const nodes = parse(readFileSync(file, 'utf8'), key);
	cache.set(key, nodes);
	return nodes;
}

function renderNodes (nodes: Node[], ctx: Ctx, app: App, helpers: Record<string, any>, out: string[]) {
	for (const node of nodes) {
		if (node.type === 'text') out.push(node.value);
		else if (node.type === 'echo') {
			const v = output(evaluate(node.expr, ctx, helpers));
			out.push(node.raw ? v : escapeHtml(v));
		} else if (node.type === 'if') {
			const branch = node.branches.find(b => b.cond === null || evaluate(b.cond, ctx, helpers));
			if (branch) renderNodes(branch.body, ctx, app, helpers, out);
		} else if (node.type === 'foreach') {
			const list = evaluate(node.expr, ctx, helpers) || [];
			const items = Array.isArray(list) ? list : Object.values(list);
			items.forEach((item, index) => {
				const loop = { index, iteration : index + 1, first : index === 0, last : index === items.length - 1, count : items.length };
				renderNodes(node.body, { ...ctx, [node.name] : item, loop }, app, helpers, out);
			});
		} else {
			renderNodes(load(app, node.name), ctx, app, helpers, out);
		}
	}
}

/** Renders templates/<app>/<name>.html; ctx.locale selects the translations used by t() */
export function render (app: App, name: string, ctx: Ctx = {}): string {
	const t = translator(app, ctx.locale || 'en');
	const helpers = {
		t,
		trans : t,
		json  : (v: any) => JSON.stringify(v ?? null).replace(/</g, '\\u003c'),
		upper : (v: any) => String(v ?? '').toUpperCase(),
		lower : (v: any) => String(v ?? '').toLowerCase()
	};
	const out: string[] = [];
	renderNodes(load(app, name), ctx, app, helpers, out);
	return out.join('');
}

/** Route handler response for a rendered legacy page */
export function htmlResponse (html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers : { 'content-type' : 'text/html; charset=utf-8', 'cache-control' : 'no-store' }
	});
}

export const renderPage = (app: App, name: string, ctx: Ctx = {}) => htmlResponse(render(app, name, ctx));
