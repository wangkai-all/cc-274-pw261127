import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { analyzeExpression } from '../src/expr/typecheck.js';
import { evaluate } from '../src/expr/evaluator.js';
import { parseExpression, canonicalString } from '../src/expr/parser.js';
import { ExprError } from '../src/expr/tokenizer.js';

const row = {
  event_id: 'e1',
  event_time: 5_000,
  user_id: 'u1',
  region: 'East',
  plan: 'pro',
  action: 'checkout',
  amount: 1250,
  duration_ms: 320,
  ok: true,
  device: 'ios',
  channel: 'organic',
  country: 'CN',
  ts: 5_000,
};

const evalOf = (source, data = row) => evaluate(analyzeExpression(source, 'filter').ast, data);
const groupOf = (source, data = row) => evaluate(analyzeExpression(source, 'group').ast, data);

describe('restricted expression language', () => {
  test('arithmetic and precedence', () => {
    assert.equal(evaluate(analyzeExpression('amount / 100 + 2 * 3', 'measure').ast, row), 18.5);
    assert.equal(evaluate(analyzeExpression('(amount + 100) / 2', 'measure').ast, row), 675);
    assert.equal(evaluate(analyzeExpression('amount % 100', 'measure').ast, row), 50);
  });

  test('comparison, equality and logic', () => {
    assert.equal(evalOf('amount > 1000 && ok'), true);
    assert.equal(evalOf('amount > 1000 && !ok'), false);
    assert.equal(evalOf('region == "East" || region == "West"'), true);
    assert.equal(evalOf('region != "East"'), false);
    assert.equal(evalOf('duration_ms <= 320 && duration_ms >= 320'), true);
  });

  test('ternary requires matching branch types', () => {
    assert.equal(evaluate(analyzeExpression('ok ? amount : 0', 'measure').ast, row), 1250);
    assert.throws(
      () => analyzeExpression('ok ? amount : "none"', 'measure'),
      (error) => error instanceof ExprError && error.code === 'type',
    );
  });

  test('null propagation is three-valued', () => {
    const data = { ...row, amount: null };
    assert.equal(evaluate(analyzeExpression('amount + 1', 'measure').ast, data), null);
    assert.equal(evaluate(analyzeExpression('amount > 1', 'filter').ast, data), null);
    assert.equal(evaluate(analyzeExpression('amount == null', 'filter').ast, data), true);
    assert.equal(evaluate(analyzeExpression('amount != null', 'filter').ast, data), false);
    assert.equal(evaluate(analyzeExpression('to_number(region) == null', 'filter').ast, row), true);
  });

  test('division by zero yields null rather than Infinity', () => {
    assert.equal(evaluate(analyzeExpression('amount / 0', 'measure').ast, row), null);
    assert.equal(evaluate(analyzeExpression('amount % 0', 'measure').ast, row), null);
  });

  test('coalesce supplies a default and short-circuits', () => {
    assert.equal(groupOf('coalesce(device, "unknown")'), 'ios');
    assert.equal(groupOf('coalesce(event_id, "x")'), 'e1');
    assert.throws(
      () => analyzeExpression('coalesce(device, 1)', 'group'),
      (error) => error.code === 'type' && /类型必须一致/.test(error.message),
    );
  });

  test('whitelisted string and number functions', () => {
    assert.equal(groupOf('lower(region)'), 'east');
    assert.equal(groupOf('upper(region)'), 'EAST');
    assert.equal(evalOf('starts_with(device, "i")'), true);
    assert.equal(evalOf('contains(channel, "gan")'), true);
    assert.equal(evaluate(analyzeExpression('len(device)', 'measure').ast, row), 3);
    assert.equal(evaluate(analyzeExpression('abs(-amount)', 'measure').ast, row), 1250);
    assert.equal(evaluate(analyzeExpression('min(amount, 1000)', 'measure').ast, row), 1000);
    assert.equal(evaluate(analyzeExpression('max(amount, 1000)', 'measure').ast, row), 1250);
    assert.equal(evaluate(analyzeExpression('round(amount / 1000, 2)', 'measure').ast, row), 1.25);
  });

  test('round digit bounds are enforced statically', () => {
    assert.throws(
      () => analyzeExpression('round(amount, 9)', 'measure'),
      (error) => error.code === 'type',
    );
  });
});

describe('rejections: no arbitrary code', () => {
  const rejected = [
    ['semantic', 'amount > 1; process.exit(1)'],
    ['semantic', 'amount > 1\nprocess.exit(1)'],
    ['comma-operator', '(1, 2)'],
    ['member', 'event.constructor'],
    ['bracket', 'event["amount"]'],
    ['assignment', 'amount = 5'],
    ['arrow', '() => 1'],
    ['template', '`${amount}`'],
    ['comment', 'amount // ok'],
    ['global', 'globalThis'],
    ['eval', 'eval("1")'],
    ['require', 'require("fs")'],
    ['unknown-function', 'execute(amount)'],
    ['unknown-field', 'secret_token'],
    ['in-operator', 'amount in [1]'],
    ['increment', 'amount++'],
  ];

  for (const [label, source] of rejected) {
    test(`rejects ${label}: ${source.replaceAll('\n', '\\n')}`, () => {
      assert.throws(
        () => analyzeExpression(source, 'filter'),
        (error) => error instanceof ExprError,
        `expected rejection for ${source}`,
      );
    });
  }

  test('tokenizer rejects unsupported escapes and newlines in strings', () => {
    assert.throws(() => parseExpression('"a\\qb"'), (error) => error.code === 'tokenize');
    assert.throws(() => parseExpression('"a\nb"'), (error) => error.code === 'tokenize');
  });

  test('type checker refuses implicit coercion', () => {
    assert.throws(() => analyzeExpression('amount > "100"', 'filter'), (error) => error.code === 'type');
    assert.throws(() => analyzeExpression('region + 1 > 2', 'filter'), (error) => error.code === 'type');
    assert.throws(() => analyzeExpression('amount && ok', 'filter'), (error) => error.code === 'type');
    assert.throws(() => analyzeExpression('ok > true', 'filter'), (error) => error.code === 'type');
  });

  test('role checks: filter boolean, measure number, group scalar', () => {
    assert.throws(() => analyzeExpression('amount', 'filter'), (error) => error.code === 'type');
    assert.throws(() => analyzeExpression('region', 'measure'), (error) => error.code === 'type');
    assert.throws(() => analyzeExpression('null', 'group'), (error) => error.code === 'type');
  });

  test('depth, length and token limits hold', () => {
    assert.throws(
      () => analyzeExpression(`${'('.repeat(60)}1${')'.repeat(60)}`, 'measure'),
      (error) => error.code === 'limit',
    );
    assert.throws(
      () => analyzeExpression(`1${' + 1'.repeat(600)}`, 'measure'),
      (error) => error.code === 'limit',
    );
    assert.throws(() => parseExpression(`"${'a'.repeat(400)}"`), (error) => error.code === 'limit');
  });
});

describe('canonical form', () => {
  test('equivalent spellings hash identically', () => {
    const a = canonicalString(parseExpression('amount>1&&ok'));
    const b = canonicalString(parseExpression('amount > 1 && ok'));
    const c = canonicalString(parseExpression('ok && amount > 1'));
    assert.equal(a, b);
    assert.notEqual(a, c, 'operand order is significant');
    assert.equal(
      canonicalString(parseExpression('(amount)')),
      canonicalString(parseExpression('amount')),
      'redundant parentheses do not change meaning',
    );
  });
});
