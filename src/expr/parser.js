/**
 * Recursive-descent parser for the rule expression language.
 *
 * The parser never resolves names against JavaScript scope: identifiers are
 * either a whitelisted event field, a boolean/null literal, or a whitelisted
 * function call. Anything else is a static error. The resulting AST is then
 * interpreted by evaluator.js.
 */

import { ExprError, LIMITS, tokenize } from './tokenizer.js';
import { FUNCTIONS, FIELD_NAMES } from './functions.js';

const RESERVED_LITERALS = new Map([
  ['true', { type: 'literal', value: true }],
  ['false', { type: 'literal', value: false }],
  ['null', { type: 'literal', value: null }],
]);

class Parser {
  constructor(tokens, options) {
    this.tokens = tokens;
    this.index = 0;
    this.fields = new Set(options.fields ?? FIELD_NAMES);
    this.depth = 0;
    this.nodes = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  next() {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  match(type, value) {
    const token = this.peek();
    if (token.type === type && (value === undefined || token.value === value)) {
      this.index += 1;
      return token;
    }
    return null;
  }

  expect(type, value, what) {
    const token = this.peek();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new ExprError(
        'parse',
        `此处需要${what}，实际得到 ${describeToken(token)}`,
        token.position,
      );
    }
    this.index += 1;
    return token;
  }

  count() {
    this.nodes += 1;
    if (this.nodes > 400) {
      throw new ExprError('limit', '表达式节点过多', this.peek().position);
    }
  }

  enter() {
    this.depth += 1;
    if (this.depth > LIMITS.depth) {
      throw new ExprError('limit', '表达式嵌套过深', this.peek().position);
    }
  }

  leave() {
    this.depth -= 1;
  }

  parseProgram() {
    const expression = this.parseExpression();
    this.expect('eof', undefined, '表达式结尾');
    return expression;
  }

  parseExpression() {
    this.enter();
    const condition = this.parseOr();
    let result = condition;
    if (this.match('punct', '?')) {
      this.count();
      const whenTrue = this.parseExpression();
      this.expect('punct', ':', '三元表达式中的 “:”');
      const whenFalse = this.parseExpression();
      result = {
        type: 'ternary',
        condition,
        whenTrue,
        whenFalse,
        position: condition.position,
      };
    }
    this.leave();
    return result;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek().type === 'punct' && this.peek().value === '||') {
      const op = this.next();
      this.count();
      const right = this.parseAnd();
      left = binary('||', left, right, op.position);
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.peek().type === 'punct' && this.peek().value === '&&') {
      const op = this.next();
      this.count();
      const right = this.parseEquality();
      left = binary('&&', left, right, op.position);
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (this.peek().type === 'punct' && ['==', '!='].includes(this.peek().value)) {
      const op = this.next();
      this.count();
      const right = this.parseComparison();
      left = binary(op.value, left, right, op.position);
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    while (this.peek().type === 'punct' && ['<', '<=', '>', '>='].includes(this.peek().value)) {
      const op = this.next();
      this.count();
      const right = this.parseAdditive();
      left = binary(op.value, left, right, op.position);
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.peek().type === 'punct' && ['+', '-'].includes(this.peek().value)) {
      const op = this.next();
      this.count();
      const right = this.parseMultiplicative();
      left = binary(op.value, left, right, op.position);
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.peek().type === 'punct' && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.next();
      this.count();
      const right = this.parseUnary();
      left = binary(op.value, left, right, op.position);
    }
    return left;
  }

  parseUnary() {
    const token = this.peek();
    if (token.type === 'punct' && (token.value === '!' || token.value === '-')) {
      this.next();
      this.enter();
      this.count();
      const operand = this.parseUnary();
      this.leave();
      return { type: 'unary', op: token.value, operand, position: token.position };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.peek();

    if (token.type === 'number' || token.type === 'string') {
      this.next();
      this.count();
      return { type: 'literal', value: token.value, position: token.position };
    }

    if (token.type === 'ident') {
      this.next();

      if (RESERVED_LITERALS.has(token.value)) {
        this.count();
        return { ...RESERVED_LITERALS.get(token.value), position: token.position };
      }

      if (this.peek().type === 'punct' && this.peek().value === '(') {
        const definition = FUNCTIONS[token.value];
        if (!definition) {
          throw new ExprError('unknown-function', `不支持的函数 “${token.value}”`, token.position);
        }
        this.next(); // (
        this.enter();
        const args = [];
        if (!(this.peek().type === 'punct' && this.peek().value === ')')) {
          args.push(this.parseExpression());
          while (this.match('punct', ',')) {
            args.push(this.parseExpression());
          }
        }
        this.expect('punct', ')', `函数 ${token.value} 的 “)”`);
        this.leave();

        if (args.length < definition.minArgs || args.length > definition.maxArgs) {
          const expected =
            definition.minArgs === definition.maxArgs
              ? `${definition.minArgs}`
              : `${definition.minArgs}~${definition.maxArgs}`;
          throw new ExprError(
            'arity',
            `函数 ${token.value} 需要 ${expected} 个参数，实际 ${args.length} 个`,
            token.position,
          );
        }
        this.count();
        return { type: 'call', name: token.value, args, position: token.position };
      }

      if (!this.fields.has(token.value)) {
        throw new ExprError('unknown-field', `未知字段 “${token.value}”`, token.position);
      }
      this.count();
      return { type: 'field', name: token.value, position: token.position };
    }

    if (token.type === 'punct' && token.value === '(') {
      this.next();
      this.enter();
      const inner = this.parseExpression();
      this.leave();
      this.expect('punct', ')', '“)”');
      return { ...inner, parenthesized: true };
    }

    throw new ExprError('parse', `此处需要表达式，实际得到 ${describeToken(token)}`, token.position);
  }
}

function binary(op, left, right, position) {
  return { type: 'binary', op, left, right, position };
}

function describeToken(token) {
  if (token.type === 'eof') return '表达式结尾';
  if (token.type === 'punct') return `“${token.value}”`;
  if (token.type === 'ident') return `“${token.value}”`;
  if (token.type === 'string') return '字符串';
  return `${token.value}`;
}

export function parseExpression(source, options = {}) {
  const tokens = tokenize(source);
  const parser = new Parser(tokens, options);
  return parser.parseProgram();
}

/** Stable, position-free serialization used for rule equivalence checks. */
export function canonicalAst(node) {
  switch (node.type) {
    case 'literal':
      return { t: 'lit', v: node.value };
    case 'field':
      return { t: 'f', n: node.name };
    case 'unary':
      return { t: 'u', o: node.op, a: canonicalAst(node.operand) };
    case 'binary':
      return { t: 'b', o: node.op, l: canonicalAst(node.left), r: canonicalAst(node.right) };
    case 'ternary':
      return {
        t: '?:',
        c: canonicalAst(node.condition),
        a: canonicalAst(node.whenTrue),
        b: canonicalAst(node.whenFalse),
      };
    case 'call':
      return { t: 'c', n: node.name, a: node.args.map(canonicalAst) };
    default:
      throw new ExprError('internal', `未知语法节点 ${node.type}`);
  }
}

export function canonicalString(node) {
  return JSON.stringify(canonicalAst(node));
}

export function formatExpression(node) {
  switch (node.type) {
    case 'literal':
      if (typeof node.value === 'string') return JSON.stringify(node.value);
      return String(node.value);
    case 'field':
      return node.name;
    case 'unary':
      return `${node.op}${formatExpression(node.operand)}`;
    case 'binary': {
      const precedence = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
      const inner = `${formatExpression(node.left)} ${node.op} ${formatExpression(node.right)}`;
      return node.parenthesized ? `(${inner})` : inner;
    }
    case 'ternary':
      return `${formatExpression(node.condition)} ? ${formatExpression(node.whenTrue)} : ${formatExpression(node.whenFalse)}`;
    case 'call':
      return `${node.name}(${node.args.map(formatExpression).join(', ')})`;
    default:
      return '?';
  }
}
