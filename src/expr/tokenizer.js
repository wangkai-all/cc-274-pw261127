/**
 * A deliberately small expression language for rule definitions.
 *
 * The tokenizer is the first half of the "no arbitrary code" guarantee: it only
 * understands numbers, strings, a fixed set of operators, identifiers, and
 * function-call punctuation. There is no member access, assignment, arrow
 * function, template literal, semicolon, or comment syntax.
 */

export class ExprError extends Error {
  constructor(code, message, position = 0) {
    super(message);
    this.name = 'ExprError';
    this.code = code;
    this.position = position;
  }
}

const PUNCTUATION = [
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '?',
  ':',
  '(',
  ')',
  ',',
];

export const LIMITS = Object.freeze({
  sourceLength: 1000,
  tokens: 500,
  stringLength: 240,
  numberLength: 40,
  depth: 48,
});

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

export function tokenize(source) {
  if (typeof source !== 'string') {
    throw new ExprError('type', '表达式必须是字符串');
  }
  if (source.length === 0) {
    throw new ExprError('empty', '表达式不能为空');
  }
  if (source.length > LIMITS.sourceLength) {
    throw new ExprError('limit', `表达式超过 ${LIMITS.sourceLength} 字符上限`);
  }

  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (isSpace(ch)) {
      i += 1;
      continue;
    }

    // Numbers: 12, 12.5, 12e3, 1.5e-2. A leading dot is not accepted.
    if (DIGIT.test(ch)) {
      const start = i;
      while (i < source.length && DIGIT.test(source[i])) i += 1;
      if (source[i] === '.') {
        i += 1;
        if (!DIGIT.test(source[i] ?? '')) {
          throw new ExprError('tokenize', '小数点后需要数字', i);
        }
        while (i < source.length && DIGIT.test(source[i])) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        if (!DIGIT.test(source[i] ?? '')) {
          throw new ExprError('tokenize', '指数部分需要数字', i);
        }
        while (i < source.length && DIGIT.test(source[i])) i += 1;
      }
      const raw = source.slice(start, i);
      if (raw.length > LIMITS.numberLength) {
        throw new ExprError('limit', '数字字面量过长', start);
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ExprError('tokenize', '数字字面量必须是有限数值', start);
      }
      tokens.push({ type: 'number', value, raw, position: start });
      if (tokens.length > LIMITS.tokens) {
        throw new ExprError('limit', `表达式超过 ${LIMITS.tokens} 个记号上限`, start);
      }
      continue;
    }

    // Strings use single or double quotes, with a small escape whitelist.
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i += 1;
      let value = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\n' || c === '\r') {
          throw new ExprError('tokenize', '字符串不能跨行', i);
        }
        if (c === '\\') {
          const next = source[i + 1];
          const simple = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
          if (next in simple) {
            value += simple[next];
            i += 2;
            continue;
          }
          if (next === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
              throw new ExprError('tokenize', '无效的 \\u 转义', i);
            }
            value += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          throw new ExprError('tokenize', `不支持的转义 \\${next ?? ''}`, i);
        }
        value += c;
        i += 1;
        if (value.length > LIMITS.stringLength) {
          throw new ExprError('limit', `字符串超过 ${LIMITS.stringLength} 字符上限`, start);
        }
      }
      if (!closed) throw new ExprError('tokenize', '字符串未闭合', start);
      tokens.push({ type: 'string', value, position: start });
      if (tokens.length > LIMITS.tokens) {
        throw new ExprError('limit', `表达式超过 ${LIMITS.tokens} 个记号上限`, start);
      }
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && IDENT_PART.test(source[i])) i += 1;
      const value = source.slice(start, i);
      tokens.push({ type: 'ident', value, position: start });
      if (tokens.length > LIMITS.tokens) {
        throw new ExprError('limit', `表达式超过 ${LIMITS.tokens} 个记号上限`, start);
      }
      continue;
    }

    const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
    if (punct) {
      // A lone '=' or '&' / '|' is rejected instead of being misread.
      tokens.push({ type: 'punct', value: punct, position: i });
      i += punct.length;
      if (tokens.length > LIMITS.tokens) {
        throw new ExprError('limit', `表达式超过 ${LIMITS.tokens} 个记号上限`, i);
      }
      continue;
    }

    throw new ExprError('tokenize', `无法识别的字符 “${ch}”`, i);
  }

  tokens.push({ type: 'eof', value: null, position: source.length });
  return tokens;
}
