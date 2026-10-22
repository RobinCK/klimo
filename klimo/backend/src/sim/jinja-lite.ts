/* =====================================================================================================
 * A small Jinja evaluator for the fake Home Assistant: the subset HA users actually put into trigger
 * templates and MQTT value templates.
 *
 *   {{ states('sensor.pv_power') | float(0) - states('sensor.house_load') | float(0) > 1500 }}
 *   {% if is_state('binary_sensor.grid_offline', 'on') %}off-grid{% else %}grid{% endif %}
 *   {{ {'lo': value_json.lo, 'hi': value_json.hi} | tojson }}
 *
 * Supported: literals, lists, dicts, variables, attribute/subscript access, `states(…)`, `states.domain.obj`,
 * `is_state`, `state_attr`, `is_state_attr`, `has_value`, `float`/`int`/`bool` as functions and filters,
 * arithmetic, comparisons, `in`, `is` tests, `and`/`or`/`not`, inline `x if c else y`, `{{ }}`, `{% if %}`
 * with `elif`/`else`, comments and whitespace control. Anything else is a TemplateError — the way a real
 * render error reaches Klimo, so its error handling can be exercised.
 * ===================================================================================================== */

export class TemplateError extends Error {}

export interface TemplateHost {
  /** Raw state of an entity, or undefined when it does not exist. */
  state(entityId: string): string | undefined;
  attributes(entityId: string): Record<string, unknown> | undefined;
  /** Every entity id (for `states.domain` namespaces). */
  entityIds(): string[];
}

export interface RenderInfo {
  /** Entities the template read; a change of any of them may change the result. */
  entities: Set<string>;
  /** The template listed whole domains (`states.sensor`): re-render on every change. */
  all: boolean;
}

export interface RenderResult {
  /** Native value: a single `{{ expr }}` keeps its type, other templates are parsed like HA does. */
  value: unknown;
  text: string;
  info: RenderInfo;
}

/** Renders and parses the result the way HA's `render_template` subscription reports it. */
export function evaluateTemplate(template: string, host: TemplateHost, variables: Record<string, unknown> = {}): RenderResult {
  const nodes = parseTemplate(template);
  const ctx = new Ctx(host, variables);
  const single = soleExpression(nodes);
  if (single) {
    const v = ctx.eval(single);
    return { value: nativeResult(v), text: pyStr(v), info: ctx.info };
  }
  const text = renderNodes(nodes, ctx);
  return { value: parseResult(text), text, info: ctx.info };
}

/** Rendered text (MQTT value templates compare it with payload_on/off). */
export function renderTemplate(template: string, host: TemplateHost, variables: Record<string, unknown> = {}): string {
  return evaluateTemplate(template, host, variables).text;
}

/* ── template structure ────────────────────────────────────────────────────────────────────────── */

type Node =
  | { t: 'text'; v: string }
  | { t: 'out'; e: Expr }
  | { t: 'if'; branches: { cond: Expr; body: Node[] }[]; otherwise: Node[] };

interface Segment {
  kind: 'text' | 'expr' | 'stmt';
  body: string;
}

function splitSegments(src: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let trimNext = false;
  const pushText = (s: string) => {
    if (trimNext) s = s.replace(/^\s+/, '');
    trimNext = false;
    if (s) out.push({ kind: 'text', body: s });
  };
  while (i < src.length) {
    const open = src.slice(i).search(/\{[{%#]/);
    if (open < 0) {
      pushText(src.slice(i));
      break;
    }
    const at = i + open;
    const kind = src[at + 1];
    const close = kind === '{' ? '}}' : kind === '%' ? '%}' : '#}';
    const end = src.indexOf(close, at + 2);
    if (end < 0) throw new TemplateError(`unclosed ${src.slice(at, at + 2)}`);
    let inner = src.slice(at + 2, end);
    let text = src.slice(i, at);
    if (inner.startsWith('-')) {
      inner = inner.slice(1);
      text = text.replace(/\s+$/, '');
    }
    pushText(text);
    if (inner.endsWith('-')) {
      inner = inner.slice(0, -1);
      trimNext = true;
    }
    if (kind === '{') out.push({ kind: 'expr', body: inner });
    else if (kind === '%') out.push({ kind: 'stmt', body: inner.trim() });
    i = end + 2;
  }
  return out;
}

const parsedCache = new Map<string, Node[]>();

function parseTemplate(src: string): Node[] {
  const hit = parsedCache.get(src);
  if (hit) return hit;
  const segs = splitSegments(src);
  let pos = 0;
  const block = (stop: string[]): { nodes: Node[]; end: string | null } => {
    const nodes: Node[] = [];
    while (pos < segs.length) {
      const s = segs[pos];
      if (s.kind === 'text') {
        nodes.push({ t: 'text', v: s.body });
        pos++;
      } else if (s.kind === 'expr') {
        nodes.push({ t: 'out', e: parseExpression(s.body) });
        pos++;
      } else {
        const word = /^([a-z_]+)/.exec(s.body)?.[1] ?? '';
        if (stop.includes(word)) return { nodes, end: word };
        if (word !== 'if') throw new TemplateError(`unsupported statement {% ${s.body} %}`);
        pos++;
        const branches: { cond: Expr; body: Node[] }[] = [];
        let cond = parseExpression(s.body.slice(2));
        let otherwise: Node[] = [];
        for (;;) {
          const inner = block(['elif', 'else', 'endif']);
          branches.push({ cond, body: inner.nodes });
          if (inner.end === null) throw new TemplateError('missing {% endif %}');
          const stmt = segs[pos].body;
          pos++;
          if (inner.end === 'elif') {
            cond = parseExpression(stmt.slice(4));
            continue;
          }
          if (inner.end === 'else') {
            if (stmt.trim() !== 'else') throw new TemplateError(`unexpected {% ${stmt} %}`);
            const tail = block(['endif']);
            if (tail.end !== 'endif') throw new TemplateError('missing {% endif %}');
            pos++;
            otherwise = tail.nodes;
          }
          break;
        }
        nodes.push({ t: 'if', branches, otherwise });
      }
    }
    return { nodes, end: null };
  };
  const { nodes, end } = block([]);
  if (end !== null) throw new TemplateError(`unexpected {% ${end} %}`);
  if (parsedCache.size > 500) parsedCache.clear();
  parsedCache.set(src, nodes);
  return nodes;
}

function soleExpression(nodes: Node[]): Expr | null {
  const meaningful = nodes.filter((n) => !(n.t === 'text' && !n.v.trim()));
  return meaningful.length === 1 && meaningful[0].t === 'out' ? meaningful[0].e : null;
}

function renderNodes(nodes: Node[], ctx: Ctx): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'out') out += pyStr(ctx.eval(n.e));
    else {
      const hit = n.branches.find((b) => truthy(ctx.eval(b.cond)));
      out += renderNodes(hit ? hit.body : n.otherwise, ctx);
    }
  }
  return out;
}

/* ── expressions ───────────────────────────────────────────────────────────────────────────────── */

type Expr =
  | { k: 'lit'; v: unknown }
  | { k: 'name'; n: string }
  | { k: 'list'; items: Expr[] }
  | { k: 'dict'; entries: [Expr, Expr][] }
  | { k: 'attr'; o: Expr; n: string }
  | { k: 'index'; o: Expr; i: Expr }
  | { k: 'call'; f: Expr; args: Expr[] }
  | { k: 'filter'; o: Expr; n: string; args: Expr[] }
  | { k: 'test'; o: Expr; n: string; neg: boolean }
  | { k: 'unary'; op: '-' | '+' | 'not'; o: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr | null };

interface Tok {
  t: 'num' | 'str' | 'name' | 'op' | 'end';
  v: string;
}

const OPS = ['//', '==', '!=', '<=', '>=', '**', '(', ')', '[', ']', '{', '}', ',', ':', '.', '|', '+', '-', '*', '/', '%', '<', '>', '~'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new TemplateError('unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      out.push({ t: 'name', v: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new TemplateError(`unexpected character '${c}'`);
    if (op === '**') throw new TemplateError('unsupported operator **');
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  out.push({ t: 'end', v: '' });
  return out;
}

function parseExpression(src: string): Expr {
  const toks = lex(src);
  let p = 0;
  const peek = (o = 0) => toks[Math.min(p + o, toks.length - 1)];
  const isOp = (v: string) => peek().t === 'op' && peek().v === v;
  const isWord = (v: string, o = 0) => peek(o).t === 'name' && peek(o).v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new TemplateError(`expected '${v}'`);
    p++;
  };

  const expr = (): Expr => {
    const a = orExpr();
    if (isWord('if')) {
      p++;
      const c = orExpr();
      let b: Expr | null = null;
      if (isWord('else')) {
        p++;
        b = expr();
      }
      return { k: 'cond', c, a, b };
    }
    return a;
  };
  const orExpr = (): Expr => {
    let a = andExpr();
    while (isWord('or')) {
      p++;
      a = { k: 'bin', op: 'or', a, b: andExpr() };
    }
    return a;
  };
  const andExpr = (): Expr => {
    let a = notExpr();
    while (isWord('and')) {
      p++;
      a = { k: 'bin', op: 'and', a, b: notExpr() };
    }
    return a;
  };
  const notExpr = (): Expr => {
    if (isWord('not')) {
      p++;
      return { k: 'unary', op: 'not', o: notExpr() };
    }
    return compare();
  };
  const compare = (): Expr => {
    let a = concat();
    for (;;) {
      if (peek().t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(peek().v)) {
        const op = toks[p++].v;
        a = { k: 'bin', op, a, b: concat() };
      } else if (isWord('in')) {
        p++;
        a = { k: 'bin', op: 'in', a, b: concat() };
      } else if (isWord('not') && isWord('in', 1)) {
        p += 2;
        a = { k: 'bin', op: 'not in', a, b: concat() };
      } else if (isWord('is')) {
        p++;
        let neg = false;
        if (isWord('not')) {
          p++;
          neg = true;
        }
        const n = peek();
        if (n.t !== 'name') throw new TemplateError('expected a test name after "is"');
        p++;
        a = { k: 'test', o: a, n: n.v, neg };
      } else return a;
    }
  };
  const concat = (): Expr => {
    let a = additive();
    while (isOp('~')) {
      p++;
      a = { k: 'bin', op: '~', a, b: additive() };
    }
    return a;
  };
  const additive = (): Expr => {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].v;
      a = { k: 'bin', op, a, b: mul() };
    }
    return a;
  };
  const mul = (): Expr => {
    let a = unary();
    while (isOp('*') || isOp('/') || isOp('//') || isOp('%')) {
      const op = toks[p++].v;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const unary = (): Expr => {
    if (isOp('-') || isOp('+')) {
      const op = toks[p++].v as '-' | '+';
      return { k: 'unary', op, o: unary() };
    }
    return filtered();
  };
  const args = (close: string): Expr[] => {
    const out: Expr[] = [];
    // keyword arguments (`name=value`) are outside the subset: the lexer rejects a lone '='
    while (!isOp(close)) {
      out.push(expr());
      if (!isOp(',')) break;
      p++;
    }
    expect(close);
    return out;
  };
  const filtered = (): Expr => {
    let a = postfix();
    while (isOp('|')) {
      p++;
      const n = peek();
      if (n.t !== 'name') throw new TemplateError('expected a filter name');
      p++;
      let filterArgs: Expr[] = [];
      if (isOp('(')) {
        p++;
        filterArgs = args(')');
      }
      a = { k: 'filter', o: a, n: n.v, args: filterArgs };
    }
    return a;
  };
  const postfix = (): Expr => {
    let a = primary();
    for (;;) {
      if (isOp('.')) {
        p++;
        const n = peek();
        if (n.t !== 'name' && n.t !== 'num') throw new TemplateError('expected an attribute name');
        p++;
        a = { k: 'attr', o: a, n: n.v };
      } else if (isOp('[')) {
        p++;
        const i = expr();
        expect(']');
        a = { k: 'index', o: a, i };
      } else if (isOp('(')) {
        p++;
        a = { k: 'call', f: a, args: args(')') };
      } else return a;
    }
  };
  const primary = (): Expr => {
    const tk = peek();
    if (tk.t === 'num') {
      p++;
      return { k: 'lit', v: Number(tk.v) };
    }
    if (tk.t === 'str') {
      p++;
      let s = tk.v;
      // adjacent string literals concatenate, as in Python
      while (peek().t === 'str') s += toks[p++].v;
      return { k: 'lit', v: s };
    }
    if (tk.t === 'name') {
      p++;
      if (tk.v === 'true' || tk.v === 'True') return { k: 'lit', v: true };
      if (tk.v === 'false' || tk.v === 'False') return { k: 'lit', v: false };
      if (tk.v === 'none' || tk.v === 'None') return { k: 'lit', v: null };
      return { k: 'name', n: tk.v };
    }
    if (isOp('(')) {
      p++;
      const e = expr();
      expect(')');
      return e;
    }
    if (isOp('[')) {
      p++;
      return { k: 'list', items: args(']') };
    }
    if (isOp('{')) {
      p++;
      const entries: [Expr, Expr][] = [];
      while (!isOp('}')) {
        const key = expr();
        expect(':');
        entries.push([key, expr()]);
        if (!isOp(',')) break;
        p++;
      }
      expect('}');
      return { k: 'dict', entries };
    }
    throw new TemplateError(tk.t === 'end' ? 'unexpected end of expression' : `unexpected '${tk.v}'`);
  };

  const e = expr();
  if (peek().t !== 'end') throw new TemplateError(`unexpected '${peek().v}'`);
  return e;
}

/* ── values ─────────────────────────────────────────────────────────────────────────────────────── */

/** Jinja's Undefined: renders empty, is falsy, fails arithmetic. */
const UNDEFINED: unique symbol = Symbol('undefined');
type Fn = { fn: (args: unknown[]) => unknown };
type StateObj = { entity_id: string; state: string; attributes: Record<string, unknown>; domain: string; object_id: string; name: string };
class StatesNs {
  constructor(readonly domain: string | null) {}
}

const isFn = (v: unknown): v is Fn => typeof v === 'object' && v !== null && typeof (v as Fn).fn === 'function' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof StatesNs) && !isFn(v);

function truthy(v: unknown): boolean {
  if (v === UNDEFINED || v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return true;
}

function pyRepr(v: unknown): string {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return pyStr(v);
}

function pyStr(v: unknown): string {
  if (v === UNDEFINED || v === undefined) return '';
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (isNum(v)) return Number.isFinite(v) ? String(v) : v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (v instanceof StatesNs) return '<template StateNamespace>';
  if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
  return String(v);
}

function nativeResult(v: unknown): unknown {
  if (v === UNDEFINED || v === undefined) return '';
  if (typeof v === 'string') return parseResult(v);
  return v;
}

/** HA turns rendered text back into a value: numbers, booleans, None, JSON-ish lists and dicts. */
function parseResult(text: string): unknown {
  const s = text.trim();
  if (s === 'True') return true;
  if (s === 'False') return false;
  if (s === 'None') return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    // leading zeros (codes like '007') stay strings, as in HA
    if (/^-?0\d/.test(s)) return text;
    return Number(s);
  }
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try {
      return JSON.parse(s);
    } catch {
      return text;
    }
  }
  return text;
}

function toFloat(v: unknown): number | null {
  if (isNum(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function typeName(v: unknown): string {
  if (v === UNDEFINED || v === undefined) return 'Undefined';
  if (v === null) return 'NoneType';
  if (Array.isArray(v)) return 'list';
  if (isNum(v)) return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  return 'dict';
}

class Ctx {
  readonly info: RenderInfo = { entities: new Set(), all: false };

  constructor(
    private readonly host: TemplateHost,
    private readonly vars: Record<string, unknown>,
  ) {}

  private stateOf(id: unknown): string {
    if (typeof id !== 'string') throw new TemplateError(`entity id must be a string, got ${typeName(id)}`);
    const key = id.toLowerCase();
    this.info.entities.add(key);
    return this.host.state(key) ?? 'unknown';
  }

  private attrOf(id: unknown, name: unknown): unknown {
    if (typeof id !== 'string' || typeof name !== 'string') throw new TemplateError('state_attr expects (entity_id, attribute)');
    const key = id.toLowerCase();
    this.info.entities.add(key);
    const attrs = this.host.attributes(key);
    if (!attrs || !(name in attrs)) return null;
    return attrs[name];
  }

  private stateObject(id: string): StateObj | typeof UNDEFINED {
    this.info.entities.add(id);
    const s = this.host.state(id);
    if (s === undefined) return UNDEFINED;
    const attrs = this.host.attributes(id) ?? {};
    const [domain, object] = id.split('.');
    return { entity_id: id, state: s, attributes: attrs, domain, object_id: object, name: typeof attrs.friendly_name === 'string' ? attrs.friendly_name : object };
  }

  private globals(name: string): unknown {
    switch (name) {
      case 'states':
        return new StatesNs(null);
      case 'is_state':
        return {
          fn: ([id, value]: unknown[]) => {
            const s = this.stateOf(id);
            return Array.isArray(value) ? value.map(String).includes(s) : s === pyStr(value);
          },
        };
      case 'state_attr':
        return { fn: ([id, name]: unknown[]) => this.attrOf(id, name) };
      case 'is_state_attr':
        return { fn: ([id, name, value]: unknown[]) => this.attrOf(id, name) === value };
      case 'has_value':
        return { fn: ([id]: unknown[]) => !['unknown', 'unavailable', ''].includes(this.stateOf(id)) };
      case 'float':
        return { fn: (a: unknown[]) => this.filter('float', a[0], a.slice(1)) };
      case 'int':
        return { fn: (a: unknown[]) => this.filter('int', a[0], a.slice(1)) };
      case 'bool':
        return { fn: (a: unknown[]) => this.filter('bool', a[0], a.slice(1)) };
      case 'min':
        return { fn: (a: unknown[]) => this.filter('min', a.length === 1 ? a[0] : a, []) };
      case 'max':
        return { fn: (a: unknown[]) => this.filter('max', a.length === 1 ? a[0] : a, []) };
      case 'abs':
        return { fn: (a: unknown[]) => this.filter('abs', a[0], []) };
      case 'round':
        return { fn: (a: unknown[]) => this.filter('round', a[0], a.slice(1)) };
      default:
        return UNDEFINED;
    }
  }

  eval(e: Expr): unknown {
    switch (e.k) {
      case 'lit':
        return e.v;
      case 'name':
        return e.n in this.vars ? this.vars[e.n] : this.globals(e.n);
      case 'list':
        return e.items.map((x) => this.eval(x));
      case 'dict': {
        const out: Record<string, unknown> = {};
        for (const [k, v] of e.entries) out[pyStr(this.eval(k))] = this.eval(v);
        return out;
      }
      case 'attr':
        return this.member(this.eval(e.o), e.n);
      case 'index': {
        const o = this.eval(e.o);
        const i = this.eval(e.i);
        if (Array.isArray(o)) {
          if (!isNum(i)) throw new TemplateError('list indices must be integers');
          const v = o[i < 0 ? o.length + i : i];
          return v === undefined ? UNDEFINED : v;
        }
        return this.member(o, pyStr(i));
      }
      case 'call': {
        const f = this.eval(e.f);
        // `states` is both the namespace (`states.sensor.x`) and the function (`states('sensor.x')`)
        if (f instanceof StatesNs && f.domain === null) return this.stateOf(e.args.length ? this.eval(e.args[0]) : undefined);
        if (!isFn(f)) throw new TemplateError(`'${describe(e.f)}' is not a supported function`);
        return f.fn(e.args.map((a) => this.eval(a)));
      }
      case 'filter':
        return this.filter(e.n, this.eval(e.o), e.args.map((a) => this.eval(a)));
      case 'test':
        return this.test(e.n, this.eval(e.o)) !== e.neg;
      case 'unary': {
        const v = this.eval(e.o);
        if (e.op === 'not') return !truthy(v);
        if (!isNum(v)) throw new TemplateError(`bad operand type for unary ${e.op}: '${typeName(v)}'`);
        return e.op === '-' ? -v : v;
      }
      case 'cond':
        return truthy(this.eval(e.c)) ? this.eval(e.a) : e.b ? this.eval(e.b) : UNDEFINED;
      case 'bin':
        return this.binary(e.op, e.a, e.b);
    }
  }

  private member(o: unknown, name: string): unknown {
    if (o instanceof StatesNs) {
      if (o.domain === null) {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) return UNDEFINED;
        return new StatesNs(name);
      }
      return this.stateObject(`${o.domain}.${name}`);
    }
    if (isObj(o)) return name in o ? o[name] : UNDEFINED;
    if (o === UNDEFINED) throw new TemplateError(`'${name}' of an undefined value`);
    return UNDEFINED;
  }

  private binary(op: string, ea: Expr, eb: Expr): unknown {
    if (op === 'and') {
      const a = this.eval(ea);
      return truthy(a) ? this.eval(eb) : a;
    }
    if (op === 'or') {
      const a = this.eval(ea);
      return truthy(a) ? a : this.eval(eb);
    }
    const a = this.eval(ea);
    const b = this.eval(eb);
    if (a === UNDEFINED || b === UNDEFINED) {
      if (op === '==') return a === b;
      if (op === '!=') return a !== b;
      if (op === '~') return pyStr(a) + pyStr(b);
      throw new TemplateError(`undefined value in '${op}'`);
    }
    switch (op) {
      case '==':
        return equal(a, b);
      case '!=':
        return !equal(a, b);
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const comparable = (isNum(a) || typeof a === 'boolean') && (isNum(b) || typeof b === 'boolean');
        if (!comparable && !(typeof a === 'string' && typeof b === 'string')) {
          throw new TemplateError(`'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
        }
        const x = a as number | string;
        const y = b as number | string;
        return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
      }
      case 'in':
      case 'not in': {
        let has: boolean;
        if (typeof b === 'string') has = typeof a === 'string' && b.includes(a);
        else if (Array.isArray(b)) has = b.some((x) => equal(x, a));
        else if (isObj(b)) has = pyStr(a) in b;
        else throw new TemplateError(`argument of type '${typeName(b)}' is not iterable`);
        return op === 'in' ? has : !has;
      }
      case '~':
        return pyStr(a) + pyStr(b);
      case '+':
        if (isNum(a) && isNum(b)) return a + b;
        if (typeof a === 'string' && typeof b === 'string') return a + b;
        if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
        throw new TemplateError(`unsupported operand type(s) for +: '${typeName(a)}' and '${typeName(b)}'`);
      case '-':
      case '*':
      case '/':
      case '//':
      case '%': {
        if (op === '*' && typeof a === 'string' && isNum(b)) return a.repeat(Math.max(0, Math.trunc(b)));
        if (!isNum(a) || !isNum(b)) throw new TemplateError(`unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
        if ((op === '/' || op === '//' || op === '%') && b === 0) throw new TemplateError('division by zero');
        if (op === '-') return a - b;
        if (op === '*') return a * b;
        if (op === '/') return a / b;
        if (op === '//') return Math.floor(a / b);
        return a - b * Math.floor(a / b);
      }
    }
    throw new TemplateError(`unsupported operator ${op}`);
  }

  private test(name: string, v: unknown): boolean {
    switch (name) {
      case 'defined':
        return v !== UNDEFINED;
      case 'undefined':
        return v === UNDEFINED;
      case 'none':
        return v === null;
      case 'number':
        return isNum(v);
      case 'string':
        return typeof v === 'string';
      case 'boolean':
        return typeof v === 'boolean';
      case 'mapping':
        return isObj(v);
      case 'iterable':
      case 'sequence':
        return Array.isArray(v) || typeof v === 'string';
      default:
        throw new TemplateError(`unsupported test '${name}'`);
    }
  }

  filter(name: string, v: unknown, args: unknown[]): unknown {
    const hasDefault = args.length > 0;
    switch (name) {
      case 'float': {
        const n = toFloat(v);
        if (n !== null) return n;
        if (hasDefault) return args[0];
        throw new TemplateError(`float got invalid input '${pyStr(v)}' when rendering template, but no default was specified`);
      }
      case 'int': {
        const n = toFloat(v);
        if (n !== null) return Math.trunc(n);
        if (hasDefault) return args[0];
        throw new TemplateError(`int got invalid input '${pyStr(v)}' when rendering template, but no default was specified`);
      }
      case 'bool': {
        if (typeof v === 'boolean') return v;
        const s = pyStr(v).trim().toLowerCase();
        if (['true', 'on', 'yes', 'enable', '1'].includes(s) || (isNum(v) && v !== 0)) return true;
        if (['false', 'off', 'no', 'disable', '0', 'none', ''].includes(s)) return false;
        if (hasDefault) return args[0];
        throw new TemplateError(`bool got invalid input '${pyStr(v)}'`);
      }
      case 'round': {
        const n = toFloat(v);
        if (n === null) {
          if (args.length > 2) return args[2];
          throw new TemplateError(`round got invalid input '${pyStr(v)}'`);
        }
        const digits = isNum(args[0]) ? args[0] : 0;
        const method = typeof args[1] === 'string' ? args[1] : 'common';
        const f = 10 ** digits;
        const x = n * f;
        const r = method === 'floor' ? Math.floor(x) : method === 'ceil' ? Math.ceil(x) : Math.sign(x) * Math.round(Math.abs(x));
        return r / f;
      }
      case 'abs': {
        if (!isNum(v)) throw new TemplateError(`bad operand type for abs(): '${typeName(v)}'`);
        return Math.abs(v);
      }
      case 'tojson':
      case 'to_json':
        return JSON.stringify(v === UNDEFINED ? null : v, (_k, x: unknown) => (x === UNDEFINED ? null : x));
      case 'from_json':
        if (typeof v !== 'string') throw new TemplateError('from_json expects a string');
        try {
          return JSON.parse(v) as unknown;
        } catch {
          throw new TemplateError('from_json got invalid JSON');
        }
      case 'default':
      case 'd': {
        const onFalsy = args[1] === true;
        return v === UNDEFINED || (onFalsy && !truthy(v)) ? (args[0] ?? '') : v;
      }
      case 'lower':
        return pyStr(v).toLowerCase();
      case 'upper':
        return pyStr(v).toUpperCase();
      case 'string':
        return pyStr(v);
      case 'trim':
        return pyStr(v).trim();
      case 'length':
      case 'count':
        if (typeof v === 'string' || Array.isArray(v)) return v.length;
        if (isObj(v)) return Object.keys(v).length;
        throw new TemplateError(`object of type '${typeName(v)}' has no len()`);
      case 'min':
      case 'max': {
        if (!Array.isArray(v) || !v.length) throw new TemplateError(`${name} expects a non-empty list`);
        const nums = v.map(toFloat);
        if (nums.some((x) => x === null)) throw new TemplateError(`${name} expects numbers`);
        return name === 'min' ? Math.min(...(nums as number[])) : Math.max(...(nums as number[]));
      }
      default:
        throw new TemplateError(`unsupported filter '${name}'`);
    }
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (isNum(a) && typeof b === 'boolean') return a === Number(b);
  if (typeof a === 'boolean' && isNum(b)) return Number(a) === b;
  if (Array.isArray(a) || isObj(a)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function describe(e: Expr): string {
  if (e.k === 'name') return e.n;
  if (e.k === 'attr') return `${describe(e.o)}.${e.n}`;
  return 'expression';
}
