/**
 * Static type checker.
 *
 * A "type" here is {kinds: string[], nullable: boolean} where kinds is at most
 * one of number|string|boolean (or empty for a bare null). We deliberately do
 * not support implicit coercion or union-typed values: ambiguity is rejected
 * before a rule can be published.
 */

import { ExprError } from './tokenizer.js';
import { FIELD_INFO, FUNCTIONS } from './functions.js';
import { parseExpression } from './parser.js';

export class TypeInfo {
  constructor(kinds, nullable) {
    this.kinds = kinds;
    this.nullable = nullable;
  }

  get kind() {
    return this.kinds[0] ?? 'null';
  }

  describe() {
    if (this.kinds.length === 0) return 'null';
    return this.nullable ? `${this.kind}?` : this.kind;
  }

  isScalar() {
    return this.kinds.length === 1 && ['number', 'string', 'boolean'].includes(this.kind);
  }
}

const NUMBER = (nullable = false) => new TypeInfo(['number'], nullable);
const STRING = (nullable = false) => new TypeInfo(['string'], nullable);
const BOOLEAN = (nullable = false) => new TypeInfo(['boolean'], nullable);
const NULL = new TypeInfo([], true);

function unionNullable(a, b) {
  return a.nullable || b.nullable;
}

function fail(node, message, code = 'type') {
  throw new ExprError(code, message, node?.position ?? 0);
}

function requireKind(node, info, allowed, where) {
  if (info.kinds.length === 0) return; // bare null is accepted; it propagates
  if (!info.kinds.every((kind) => allowed.includes(kind))) {
    fail(node, `${where}需要${allowed.map(kindLabel).join('/')}类型，实际为 ${info.describe()}`, 'type');
  }
}

function kindLabel(kind) {
  return { number: '数字', string: '字符串', boolean: '布尔', null: '空值' }[kind] ?? kind;
}

function infer(node, fields) {
  switch (node.type) {
    case 'literal': {
      if (node.value === null) return NULL;
      if (typeof node.value === 'number') return NUMBER();
      if (typeof node.value === 'string') return STRING();
      if (typeof node.value === 'boolean') return BOOLEAN();
      return fail(node, '不支持的字面量类型');
    }

    case 'field': {
      const info = fields[node.name];
      if (!info) fail(node, `未知字段 “${node.name}”`, 'unknown-field');
      return new TypeInfo([info.type], true);
    }

    case 'unary': {
      const operand = infer(node.operand, fields);
      if (node.op === '!') {
        requireKind(node, operand, ['boolean'], '逻辑取反');
        return BOOLEAN(operand.nullable);
      }
      requireKind(node, operand, ['number'], '负号');
      return NUMBER(operand.nullable || operand.kinds.length === 0);
    }

    case 'binary': {
      const left = infer(node.left, fields);
      const right = infer(node.right, fields);
      const nullable = unionNullable(left, right) || left.kinds.length === 0 || right.kinds.length === 0;

      if (['+', '-', '*', '/', '%'].includes(node.op)) {
        requireKind(node, left, ['number'], `运算符 ${node.op} 的左侧`);
        requireKind(node, right, ['number'], `运算符 ${node.op} 的右侧`);
        return NUMBER(nullable);
      }

      if (['&&', '||'].includes(node.op)) {
        requireKind(node, left, ['boolean'], `运算符 ${node.op} 的左侧`);
        requireKind(node, right, ['boolean'], `运算符 ${node.op} 的右侧`);
        return BOOLEAN(nullable);
      }

      if (['==', '!='].includes(node.op)) {
        assertComparable(node, left, right, node.op, true);
        return BOOLEAN();
      }

      if (['<', '<=', '>', '>='].includes(node.op)) {
        assertComparable(node, left, right, node.op, false);
        return BOOLEAN();
      }

      return fail(node, `未知运算符 ${node.op}`, 'internal');
    }

    case 'ternary': {
      const condition = infer(node.condition, fields);
      requireKind(node.condition, condition, ['boolean'], '三元条件');
      const whenTrue = infer(node.whenTrue, fields);
      const whenFalse = infer(node.whenFalse, fields);
      const trueKind = whenTrue.kinds[0] ?? null;
      const falseKind = whenFalse.kinds[0] ?? null;
      if (trueKind && falseKind && trueKind !== falseKind) {
        fail(
          node,
          `三元表达式两个分支类型必须一致，实际为 ${whenTrue.describe()} 与 ${whenFalse.describe()}`,
        );
      }
      const kind = trueKind ?? falseKind;
      if (!kind) {
        return NULL;
      }
      return new TypeInfo([kind], whenTrue.nullable || whenFalse.nullable || !trueKind || !falseKind);
    }

    case 'call':
      return inferCall(node, fields);

    default:
      return fail(node, `未知表达式节点 ${node.type}`, 'internal');
  }
}

function assertComparable(node, left, right, op, allowEquality) {
  const leftKind = left.kinds[0] ?? null;
  const rightKind = right.kinds[0] ?? null;
  if (!leftKind && !rightKind) {
    if (!allowEquality) fail(node, '两个空值不能比较大小');
    return;
  }
  if (leftKind && rightKind && leftKind !== rightKind) {
    fail(
      node,
      `运算符 ${op} 两侧类型不一致：${left.describe()} 与 ${right.describe()}（不支持隐式转换）`,
    );
  }
  if (!allowEquality && leftKind === 'boolean') {
    fail(node, '布尔值只能使用 == 或 != 比较');
  }
}

function inferCall(node, fields) {
  const definition = FUNCTIONS[node.name];
  if (!definition) fail(node, `不支持的函数 “${node.name}”`, 'unknown-function');

  const argInfos = node.args.map((arg) => infer(arg, fields));

  if (node.name === 'coalesce') {
    const kinds = new Set();
    for (const info of argInfos) {
      if (info.kinds.length === 0) continue;
      if (info.kinds.length > 1) fail(node, 'coalesce 不支持联合类型');
      kinds.add(info.kind);
    }
    if (kinds.size > 1) {
      fail(node, `coalesce 的参数类型必须一致，实际为 ${[...kinds].join(' / ')}`);
    }
    const kind = [...kinds][0];
    if (!kind) return NULL;
    return new TypeInfo([kind], argInfos.every((info) => info.nullable || info.kinds.length === 0));
  }

  for (const slot of definition.argTypes ?? []) {
    const info = argInfos[slot.index];
    if (!info) continue;
    requireKind(node.args[slot.index] ?? node, info, slot.accepted, slot.message);
  }

  if (definition.arityTypes) {
    const result = definition.arityTypes(argInfos, node);
    if (result) return result;
  }

  if (node.name === 'round' && node.args[1]?.type === 'literal' && typeof node.args[1].value === 'number') {
    const digits = node.args[1].value;
    if (!Number.isInteger(digits) || digits < 0 || digits > 6) {
      fail(node.args[1], 'round 的 digits 必须是 0~6 的整数', 'type');
    }
  }

  const nullable = argInfos.some((info) => info.nullable || info.kinds.length === 0);
  if (definition.returns === 'number') return NUMBER(nullable || node.name === 'to_number');
  if (definition.returns === 'string') return STRING(nullable);
  if (definition.returns === 'boolean') return BOOLEAN(nullable);
  fail(node, `函数 ${node.name} 缺少返回类型声明`, 'internal');
}

const FIELD_MAP = Object.freeze(
  Object.fromEntries(Object.entries(FIELD_INFO).map(([name, info]) => [name, { type: info.type }])),
);

/**
 * Parse + type-check one expression against a role.
 * role: filter -> boolean, group -> scalar, measure -> number, dedup -> scalar
 */
export function analyzeExpression(source, role, options = {}) {
  const ast = parseExpression(source, { fields: Object.keys(FIELD_MAP) });
  const type = infer(ast, FIELD_MAP);
  const scalarKind = type.kinds[0] ?? null;

  if (role === 'filter') {
    requireKind(ast, type, ['boolean'], '过滤条件');
    if (!scalarKind) fail(ast, '过滤条件不能是空值');
  } else if (role === 'group') {
    if (!scalarKind) fail(ast, '分组键不能是空值，请使用 coalesce 提供默认值');
  } else if (role === 'measure') {
    requireKind(ast, type, ['number'], '聚合度量');
    if (!scalarKind) fail(ast, '聚合度量不能是空值');
  } else if (role === 'dedup') {
    if (!scalarKind) fail(ast, '去重键不能是空值，请使用 coalesce 提供默认值');
  } else {
    throw new ExprError('internal', `未知表达式用途 ${role}`);
  }

  return { ast, type, source: source.trim() };
}

export const FIELD_TYPES = Object.freeze(
  Object.fromEntries(Object.entries(FIELD_INFO).map(([name, info]) => [name, info.type])),
);
