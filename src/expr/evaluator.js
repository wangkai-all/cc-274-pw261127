/**
 * Tree-walking evaluator over the parsed AST.
 *
 * There is no `new Function`, no `eval`, no property access by name, and no
 * dynamic dispatch: field names resolve through a frozen lookup table and
 * function names through a frozen function library.
 */

import { ExprError } from './tokenizer.js';
import { FUNCTIONS } from './functions.js';

const NULL = null;

function isNull(value) {
  return value === null || value === undefined;
}

function truthy(value) {
  return value === true;
}

export function evaluate(node, row) {
  switch (node.type) {
    case 'literal':
      return node.value;

    case 'field': {
      const value = row[node.name];
      return value === undefined ? NULL : value;
    }

    case 'unary': {
      const operand = evaluate(node.operand, row);
      if (node.op === '!') {
        if (isNull(operand)) return NULL;
        return !truthy(operand);
      }
      if (isNull(operand)) return NULL;
      return -operand;
    }

    case 'binary':
      return evaluateBinary(node, row);

    case 'ternary': {
      const condition = evaluate(node.condition, row);
      if (isNull(condition)) return NULL;
      return truthy(condition) ? evaluate(node.whenTrue, row) : evaluate(node.whenFalse, row);
    }

    case 'call':
      return evaluateCall(node, row);

    default:
      throw new ExprError('internal', `未知表达式节点 ${node.type}`);
  }
}

function evaluateBinary(node, row) {
  const op = node.op;

  if (op === '&&') {
    const left = evaluate(node.left, row);
    if (isNull(left)) return NULL;
    if (!truthy(left)) return false;
    return evaluate(node.right, row);
  }

  if (op === '||') {
    const left = evaluate(node.left, row);
    if (isNull(left)) return NULL;
    if (truthy(left)) return true;
    return evaluate(node.right, row);
  }

  const left = evaluate(node.left, row);
  if (isNull(left)) {
    // Three-valued equality: null == null is true, null == x is false.
    if (op === '==' || op === '!=') {
      const right = evaluate(node.right, row);
      const equal = isNull(right);
      return op === '==' ? equal : !equal;
    }
    return NULL;
  }
  const right = evaluate(node.right, row);
  if (isNull(right)) {
    if (op === '==' || op === '!=') return op === '==' ? false : true;
    return NULL;
  }

  switch (op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      if (right === 0) return NULL; // division by zero yields null rather than Infinity
      return left / right;
    case '%':
      if (right === 0) return NULL;
      return left % right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    default:
      throw new ExprError('internal', `未知运算符 ${op}`);
  }
}

function evaluateCall(node, row) {
  const definition = FUNCTIONS[node.name];
  if (!definition) throw new ExprError('internal', `未知函数 ${node.name}`);

  // coalesce is the one short-circuiting function.
  if (node.name === 'coalesce') {
    for (const arg of node.args) {
      const value = evaluate(arg, row);
      if (!isNull(value)) return value;
    }
    return NULL;
  }

  const args = node.args.map((arg) => evaluate(arg, row));

  // Null propagation: every other whitelisted function returns null on a null input.
  if (args.some(isNull)) return NULL;

  return definition.impl(args);
}

/** Compile a list of {name, ast} into stable evaluators used by the engine. */
export function evaluators(definitions) {
  const out = {};
  for (const [name, ast] of Object.entries(definitions)) {
    out[name] = (row) => evaluate(ast, row);
  }
  return out;
}
