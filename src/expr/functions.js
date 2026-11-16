/**
 * Static description of event fields and the whitelisted function library.
 *
 * Type inference is intentionally conservative: anything that cannot be proven
 * is rejected at publish time rather than failing mid-stream. Nulls propagate
 * through arithmetic and comparisons in the usual three-valued way.
 */

import { ExprError } from './tokenizer.js';

export const FIELD_NAMES = Object.freeze([
  'event_id',
  'event_time',
  'user_id',
  'region',
  'plan',
  'action',
  'amount',
  'duration_ms',
  'ok',
  'device',
  'channel',
  'country',
  'ts',
]);

export const FIELD_INFO = Object.freeze({
  event_id: { type: 'string', description: '事件唯一标识（系统字段）' },
  event_time: { type: 'number', description: '事件时间戳（毫秒，系统字段）' },
  user_id: { type: 'string', description: '用户标识' },
  region: { type: 'string', description: '销售区域' },
  plan: { type: 'string', description: '订阅计划' },
  action: { type: 'string', description: '事件动作' },
  amount: { type: 'number', description: '金额（分）' },
  duration_ms: { type: 'number', description: '耗时（毫秒）' },
  ok: { type: 'boolean', description: '是否成功' },
  device: { type: 'string', description: '设备类型' },
  channel: { type: 'string', description: '来源渠道' },
  country: { type: 'string', description: '国家/地区代码' },
  ts: { type: 'number', description: '事件时间戳（毫秒）' },
});

const t = (type) => ({ type });

function arg(index, accepted, message) {
  return { index, accepted, message };
}

export const FUNCTIONS = Object.freeze({
  coalesce: {
    minArgs: 1,
    maxArgs: 4,
    signature: 'coalesce(a, b, ...)',
    description: '返回第一个非 null 参数',
    arityTypes: (args) => {
      const first = args[0];
      for (const arg of args) {
        if (arg !== first) {
          throw new ExprError('type', 'coalesce 的参数类型必须一致');
        }
      }
      return first;
    },
    impl: (args) => args.find((value) => value !== null && value !== undefined) ?? null,
  },

  len: {
    minArgs: 1,
    maxArgs: 1,
    signature: 'len(text)',
    description: '字符串长度',
    argTypes: [arg(0, ['string'], 'len 需要字符串')],
    returns: 'number',
    impl: (args) => args[0].length,
  },

  lower: {
    minArgs: 1,
    maxArgs: 1,
    signature: 'lower(text)',
    description: '转为小写',
    argTypes: [arg(0, ['string'], 'lower 需要字符串')],
    returns: 'string',
    impl: (args) => args[0].toLowerCase(),
  },

  upper: {
    minArgs: 1,
    maxArgs: 1,
    signature: 'upper(text)',
    description: '转为大写',
    argTypes: [arg(0, ['string'], 'upper 需要字符串')],
    returns: 'string',
    impl: (args) => args[0].toUpperCase(),
  },

  starts_with: {
    minArgs: 2,
    maxArgs: 2,
    signature: 'starts_with(text, prefix)',
    description: '字符串前缀判断',
    argTypes: [
      arg(0, ['string'], 'starts_with 第一个参数需要字符串'),
      arg(1, ['string'], 'starts_with 第二个参数需要字符串'),
    ],
    returns: 'boolean',
    impl: (args) => args[0].startsWith(args[1]),
  },

  contains: {
    minArgs: 2,
    maxArgs: 2,
    signature: 'contains(text, part)',
    description: '子串判断',
    argTypes: [
      arg(0, ['string'], 'contains 第一个参数需要字符串'),
      arg(1, ['string'], 'contains 第二个参数需要字符串'),
    ],
    returns: 'boolean',
    impl: (args) => args[0].includes(args[1]),
  },

  abs: {
    minArgs: 1,
    maxArgs: 1,
    signature: 'abs(number)',
    description: '绝对值',
    argTypes: [arg(0, ['number'], 'abs 需要数字')],
    returns: 'number',
    impl: (args) => Math.abs(args[0]),
  },

  round: {
    minArgs: 1,
    maxArgs: 2,
    signature: 'round(number[, digits])',
    description: '四舍五入，digits 取 0~6',
    argTypes: [
      arg(0, ['number'], 'round 第一个参数需要数字'),
      arg(1, ['number'], 'round 第二个参数需要数字'),
    ],
    returns: 'number',
    impl: (args) => {
      const digits = args.length === 2 ? args[1] : 0;
      if (!Number.isInteger(digits) || digits < 0 || digits > 6) {
        throw new ExprError('runtime-type', 'round 的 digits 必须是 0~6 的整数');
      }
      const factor = 10 ** digits;
      return Math.round((args[0] + Number.EPSILON) * factor) / factor;
    },
  },

  min: {
    minArgs: 2,
    maxArgs: 2,
    signature: 'min(a, b)',
    description: '较小值',
    argTypes: [
      arg(0, ['number'], 'min 需要数字'),
      arg(1, ['number'], 'min 需要数字'),
    ],
    returns: 'number',
    impl: (args) => Math.min(args[0], args[1]),
  },

  max: {
    minArgs: 2,
    maxArgs: 2,
    signature: 'max(a, b)',
    description: '较大值',
    argTypes: [
      arg(0, ['number'], 'max 需要数字'),
      arg(1, ['number'], 'max 需要数字'),
    ],
    returns: 'number',
    impl: (args) => Math.max(args[0], args[1]),
  },

  to_number: {
    minArgs: 1,
    maxArgs: 1,
    signature: 'to_number(text)',
    description: '严格解析十进制数字，失败返回 null',
    argTypes: [arg(0, ['string'], 'to_number 需要字符串')],
    returns: 'number',
    impl: (args) => {
      if (!/^-?\d+(\.\d+)?$/.test(args[0].trim())) return null;
      const value = Number(args[0]);
      return Number.isFinite(value) ? value : null;
    },
  },
});

export const FUNCTION_HELP = Object.freeze(
  Object.entries(FUNCTIONS).map(([name, definition]) => ({
    name,
    signature: definition.signature,
    description: definition.description,
    minArgs: definition.minArgs,
    maxArgs: definition.maxArgs,
  })),
);

/** Human-readable type labels used by the UI and API errors. */
export const TYPE_LABELS = Object.freeze({
  number: '数字',
  string: '字符串',
  boolean: '布尔',
  'null': '空值',
  any: '任意',
});
