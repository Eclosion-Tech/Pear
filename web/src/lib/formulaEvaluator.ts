/**
 * Client-side formula evaluator for Pear Formula and Rollup property types.
 *
 * Supports a Notion-compatible expression language parsed via a recursive
 * descent parser. The evaluator NEVER throws — all errors return null.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

type FormulaValue = string | number | boolean | null;

// ── Tokenizer ─────────────────────────────────────────────────────────────────

const enum TT {
  Number,
  String,
  Bool,
  Ident,
  LParen,
  RParen,
  Comma,
  Plus,
  Minus,
  Star,
  Slash,
  Percent,
  EqEq,
  BangEq,
  Gt,
  Lt,
  GtEq,
  LtEq,
  EOF,
}

interface Token {
  tt: TT;
  raw: string;
  num?: number;
  str?: string;
  bool?: boolean;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i])) { i++; continue; }

    // Numbers
    if (/[0-9]/.test(src[i]) || (src[i] === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      tokens.push({ tt: TT.Number, raw, num: parseFloat(raw) });
      i = j;
      continue;
    }

    // Strings (double-quoted only)
    if (src[i] === '"') {
      let j = i + 1;
      let str = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          str += src[j + 1];
          j += 2;
        } else {
          str += src[j++];
        }
      }
      tokens.push({ tt: TT.String, raw: src.slice(i, j + 1), str });
      i = j + 1;
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(src[i])) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      if (raw === "true")  { tokens.push({ tt: TT.Bool, raw, bool: true });  i = j; continue; }
      if (raw === "false") { tokens.push({ tt: TT.Bool, raw, bool: false }); i = j; continue; }
      tokens.push({ tt: TT.Ident, raw });
      i = j;
      continue;
    }

    // Two-char operators
    if (src[i] === "=" && src[i + 1] === "=") { tokens.push({ tt: TT.EqEq,  raw: "==" }); i += 2; continue; }
    if (src[i] === "!" && src[i + 1] === "=") { tokens.push({ tt: TT.BangEq, raw: "!=" }); i += 2; continue; }
    if (src[i] === ">" && src[i + 1] === "=") { tokens.push({ tt: TT.GtEq,  raw: ">=" }); i += 2; continue; }
    if (src[i] === "<" && src[i + 1] === "=") { tokens.push({ tt: TT.LtEq,  raw: "<=" }); i += 2; continue; }

    // Single-char operators
    switch (src[i]) {
      case "(": tokens.push({ tt: TT.LParen,  raw: "(" }); break;
      case ")": tokens.push({ tt: TT.RParen,  raw: ")" }); break;
      case ",": tokens.push({ tt: TT.Comma,   raw: "," }); break;
      case "+": tokens.push({ tt: TT.Plus,    raw: "+" }); break;
      case "-": tokens.push({ tt: TT.Minus,   raw: "-" }); break;
      case "*": tokens.push({ tt: TT.Star,    raw: "*" }); break;
      case "/": tokens.push({ tt: TT.Slash,   raw: "/" }); break;
      case "%": tokens.push({ tt: TT.Percent, raw: "%" }); break;
      case ">": tokens.push({ tt: TT.Gt,      raw: ">" }); break;
      case "<": tokens.push({ tt: TT.Lt,      raw: "<" }); break;
    }
    i++;
  }

  tokens.push({ tt: TT.EOF, raw: "" });
  return tokens;
}

// ── Parser / Evaluator ────────────────────────────────────────────────────────

class Evaluator {
  private tokens: Token[];
  private pos = 0;
  private props: Record<string, unknown>;

  constructor(tokens: Token[], props: Record<string, unknown>) {
    this.tokens = tokens;
    this.props = props;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private consume(): Token { return this.tokens[this.pos++]; }
  private expect(tt: TT): Token {
    const t = this.consume();
    if (t.tt !== tt) throw new Error(`Expected token type ${tt}, got ${t.tt} ("${t.raw}")`);
    return t;
  }

  // ── Entry ──────────────────────────────────────────────────────────────────

  eval(): FormulaValue {
    const val = this.parseExpr();
    return val;
  }

  // ── Grammar (precedence climbing) ─────────────────────────────────────────
  // expr → comparison
  // comparison → addition (( "==" | "!=" | ">" | "<" | ">=" | "<=" ) addition)*
  // addition → multiplication (( "+" | "-" ) multiplication)*
  // multiplication → unary (( "*" | "/" | "%" ) unary)*
  // unary → "-" unary | primary
  // primary → number | string | bool | ident "(" args ")" | ident | "(" expr ")"

  private parseExpr(): FormulaValue {
    return this.parseComparison();
  }

  private parseComparison(): FormulaValue {
    let left = this.parseAddition();
    while (true) {
      const tt = this.peek().tt;
      if (tt === TT.EqEq || tt === TT.BangEq || tt === TT.Gt || tt === TT.Lt || tt === TT.GtEq || tt === TT.LtEq) {
        this.consume();
        const right = this.parseAddition();
        if (tt === TT.EqEq)  { left = left == right; continue; }    // eslint-disable-line eqeqeq
        if (tt === TT.BangEq){ left = left != right; continue; }    // eslint-disable-line eqeqeq
        const l = typeof left === "number" ? left : Number(left);
        const r = typeof right === "number" ? right : Number(right);
        if (tt === TT.Gt)  { left = l > r;  continue; }
        if (tt === TT.Lt)  { left = l < r;  continue; }
        if (tt === TT.GtEq){ left = l >= r; continue; }
        if (tt === TT.LtEq){ left = l <= r; continue; }
      }
      break;
    }
    return left;
  }

  private parseAddition(): FormulaValue {
    let left = this.parseMultiplication();
    while (this.peek().tt === TT.Plus || this.peek().tt === TT.Minus) {
      const op = this.consume().tt;
      const right = this.parseMultiplication();
      if (op === TT.Plus) {
        if (typeof left === "string" || typeof right === "string") {
          left = String(left ?? "") + String(right ?? "");
        } else {
          left = (left as number) + (right as number);
        }
      } else {
        left = (toNum(left)) - (toNum(right));
      }
    }
    return left;
  }

  private parseMultiplication(): FormulaValue {
    let left = this.parseUnary();
    while (this.peek().tt === TT.Star || this.peek().tt === TT.Slash || this.peek().tt === TT.Percent) {
      const op = this.consume().tt;
      const right = this.parseUnary();
      if (op === TT.Star)    left = toNum(left) * toNum(right);
      else if (op === TT.Slash) {
        const d = toNum(right);
        left = d === 0 ? null : toNum(left) / d;
      } else {
        const d = toNum(right);
        left = d === 0 ? null : toNum(left) % d;
      }
    }
    return left;
  }

  private parseUnary(): FormulaValue {
    if (this.peek().tt === TT.Minus) {
      this.consume();
      const v = this.parseUnary();
      return -(toNum(v));
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaValue {
    const t = this.peek();

    if (t.tt === TT.Number) { this.consume(); return t.num!; }
    if (t.tt === TT.String) { this.consume(); return t.str!; }
    if (t.tt === TT.Bool)   { this.consume(); return t.bool!; }

    if (t.tt === TT.LParen) {
      this.consume();
      const v = this.parseExpr();
      this.expect(TT.RParen);
      return v;
    }

    if (t.tt === TT.Ident) {
      this.consume();
      const name = t.raw;

      // Function call
      if (this.peek().tt === TT.LParen) {
        this.consume(); // consume "("
        const args: FormulaValue[] = [];
        while (this.peek().tt !== TT.RParen && this.peek().tt !== TT.EOF) {
          args.push(this.parseExpr());
          if (this.peek().tt === TT.Comma) this.consume();
        }
        this.expect(TT.RParen);
        return this.callFn(name, args);
      }

      // Bare identifier — look up in props
      const val = this.props[name];
      if (val === undefined || val === null) return "";
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
      return String(val);
    }

    // Skip unknown tokens
    this.consume();
    return null;
  }

  // ── Built-in functions ────────────────────────────────────────────────────

  private callFn(name: string, args: FormulaValue[]): FormulaValue {
    const s = (i: number): string => String(args[i] ?? "");
    const n = (i: number): number => toNum(args[i]);

    switch (name) {
      // Property access
      case "prop": {
        const key = String(args[0] ?? "");
        const val = this.props[key];
        if (val === undefined || val === null) return "";
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
        return String(val);
      }

      // Control flow
      case "if":
        return args[0] ? args[1] ?? null : args[2] ?? null;

      // Logical
      case "and": return Boolean(args[0]) && Boolean(args[1]);
      case "or":  return Boolean(args[0]) || Boolean(args[1]);
      case "not": return !args[0];

      // Type conversion
      case "number":
      case "toNumber": return toNum(args[0]);
      case "text":
      case "toString": return String(args[0] ?? "");

      // String functions
      case "concat":
        return args.map((a) => String(a ?? "")).join("");
      case "length":
        return String(args[0] ?? "").length;
      case "contains":
        return s(0).includes(s(1));
      case "substring": {
        const str = s(0);
        const start = Math.max(0, n(1));
        const end = args[2] !== undefined ? toNum(args[2]) : str.length;
        return str.slice(start, end);
      }
      case "lower":  return s(0).toLowerCase();
      case "upper":  return s(0).toUpperCase();
      case "trim":   return s(0).trim();
      case "replace": return s(0).split(s(1)).join(s(2));
      case "empty":
        return args[0] === null || args[0] === "" || args[0] === 0 || args[0] === false;

      // Number functions
      case "abs":   return Math.abs(n(0));
      case "floor": return Math.floor(n(0));
      case "ceil":  return Math.ceil(n(0));
      case "round": return Math.round(n(0));
      case "sqrt":  return Math.sqrt(n(0));
      case "max":   return Math.max(n(0), n(1));
      case "min":   return Math.min(n(0), n(1));

      // Date functions
      case "now": return Date.now();
      case "year": {
        const d = new Date(n(0)); return isNaN(d.getTime()) ? null : d.getFullYear();
      }
      case "month": {
        const d = new Date(n(0)); return isNaN(d.getTime()) ? null : d.getMonth() + 1;
      }
      case "day": {
        const d = new Date(n(0)); return isNaN(d.getTime()) ? null : d.getDate();
      }
      case "dateAdd": {
        const date = new Date(n(0));
        if (isNaN(date.getTime())) return null;
        const amount = n(1);
        const unit = s(2);
        switch (unit) {
          case "days":    date.setDate(date.getDate() + amount); break;
          case "months":  date.setMonth(date.getMonth() + amount); break;
          case "years":   date.setFullYear(date.getFullYear() + amount); break;
          case "hours":   date.setHours(date.getHours() + amount); break;
          case "minutes": date.setMinutes(date.getMinutes() + amount); break;
        }
        return date.getTime();
      }
      case "dateBetween": {
        const a = n(0), b = n(1);
        const unit = s(2);
        const diffMs = a - b;
        switch (unit) {
          case "days":    return Math.trunc(diffMs / 86400000);
          case "hours":   return Math.trunc(diffMs / 3600000);
          case "minutes": return Math.trunc(diffMs / 60000);
          case "months":  {
            const da = new Date(a), db = new Date(b);
            return (da.getFullYear() - db.getFullYear()) * 12 + (da.getMonth() - db.getMonth());
          }
          case "years": {
            const da = new Date(a), db = new Date(b);
            return da.getFullYear() - db.getFullYear();
          }
          default: return Math.trunc(diffMs / 86400000);
        }
      }

      default:
        return null;
    }
  }
}

function toNum(v: FormulaValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluate a Pear formula expression against a map of property name → value.
 * Returns string | number | boolean, or null on any error.
 */
export function evaluateFormula(
  expression: string,
  props: Record<string, unknown>
): string | number | boolean | null {
  try {
    const tokens = tokenize(expression);
    const ev = new Evaluator(tokens, props);
    const result = ev.eval();
    return result;
  } catch {
    return null;
  }
}

// ── Rollup evaluator ──────────────────────────────────────────────────────────

/**
 * Evaluate a rollup aggregation over an array of values.
 */
export function evaluateRollup(config: {
  function: string;
  values: unknown[];
}): string | number | null {
  try {
    const { function: fn, values } = config;
    if (!Array.isArray(values)) return null;

    switch (fn) {
      case "count":
        return values.length;

      case "count_values":
        return values.filter((v) => v !== null && v !== "" && v !== undefined).length;

      case "sum": {
        const nums = values.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => !isNaN(n));
        return nums.reduce((a, b) => a + b, 0);
      }

      case "average": {
        const nums = values.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => !isNaN(n));
        if (nums.length === 0) return null;
        return nums.reduce((a, b) => a + b, 0) / nums.length;
      }

      case "min": {
        const nums = values.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => !isNaN(n));
        if (nums.length === 0) return null;
        return Math.min(...nums);
      }

      case "max": {
        const nums = values.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => !isNaN(n));
        if (nums.length === 0) return null;
        return Math.max(...nums);
      }

      case "range": {
        const nums = values.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => !isNaN(n));
        if (nums.length === 0) return null;
        return Math.max(...nums) - Math.min(...nums);
      }

      case "earliest_date": {
        const dates = values.map((v) => (typeof v === "number" ? v : typeof v === "string" ? new Date(v).getTime() : NaN)).filter((n) => !isNaN(n));
        if (dates.length === 0) return null;
        return Math.min(...dates);
      }

      case "latest_date": {
        const dates = values.map((v) => (typeof v === "number" ? v : typeof v === "string" ? new Date(v).getTime() : NaN)).filter((n) => !isNaN(n));
        if (dates.length === 0) return null;
        return Math.max(...dates);
      }

      case "checked":
        return values.filter((v) => v === true).length;

      case "unchecked":
        return values.filter((v) => v === false).length;

      case "percent_checked": {
        if (values.length === 0) return null;
        const checked = values.filter((v) => v === true).length;
        return Math.round((checked / values.length) * 100);
      }

      case "percent_not_empty": {
        if (values.length === 0) return null;
        const notEmpty = values.filter((v) => v !== null && v !== "" && v !== undefined).length;
        return Math.round((notEmpty / values.length) * 100);
      }

      case "percent_empty": {
        if (values.length === 0) return null;
        const empty = values.filter((v) => v === null || v === "" || v === undefined).length;
        return Math.round((empty / values.length) * 100);
      }

      case "unique": {
        const seen = new Set<unknown>();
        return values.filter((v) => {
          const key = JSON.stringify(v);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).length;
      }

      case "show_original":
        return values.map((v) => String(v ?? "")).join(", ");

      default:
        return null;
    }
  } catch {
    return null;
  }
}
