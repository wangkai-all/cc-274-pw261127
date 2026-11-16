/**
 * Rule specification: validation, normalization, semantic canonicalization and
 * change classification.
 *
 * A rule is an immutable, versioned value. The wire format is a small JSON
 * object; every expression is compiled with the restricted expression language
 * in src/expr. Nothing here ever evaluates user text as code.
 */

import { createHash } from 'node:crypto';
import { ExprError } from './expr/tokenizer.js';
import { analyzeExpression } from './expr/typecheck.js';
import { FIELD_INFO } from './expr/functions.js';
import { canonicalString, formatExpression } from './expr/parser.js';

export const AGGREGATES = Object.freeze(['sum', 'count', 'avg', 'min', 'max']);
export const WINDOW_KINDS = Object.freeze(['tumbling', 'hopping']);

export const SPEC_LIMITS = Object.freeze({
  label: 80,
  sizeMs: { min: 1000, max: 3_600_000 },
  slideMs: { min: 1000, max: 3_600_000 },
  latenessMs: { min: 0, max: 600_000 },
  offsetMs: { min: 0, max: 3_599_999 },
  maxWindowsPerEvent: 60,
});

export class SpecError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    this.field = field;
  }
}

export const DEFAULT_SPEC = Object.freeze({
  label: '按设备统计成功事件金额',
  filter: 'ok && amount > 0',
  group: 'coalesce(device, "unknown")',
  dedup: 'event_id',
  measure: 'amount',
  aggregate: 'sum',
  window: {
    kind: 'tumbling',
    sizeMs: 15_000,
    slideMs: 5_000,
    allowedLatenessMs: 3_000,
    offsetMs: 0,
  },
});

const EXPR_ROLES = Object.freeze({
  filter: 'filter',
  group: 'group',
  dedup: 'dedup',
  measure: 'measure',
});

function asString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function integerInRange(value, field, { min, max }, { allowUndefined = false } = {}) {
  if (value === undefined && allowUndefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SpecError('invalid-window', `${field} 必须是 ${min} 到 ${max} 之间的整数`, field);
  }
  return value;
}

/**
 * Validate and normalize a raw spec object into:
 *   spec       - canonical wire format (trimmed, defaults applied)
 *   parsed     - compiled ASTs for each expression
 *   canonical  - object used for semantic comparison
 *   canonicalJson, semanticHash
 */
export function normalizeSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SpecError('invalid-spec', '规则必须是 JSON 对象');
  }
  if (input instanceof Object && Object.keys(input).length > 40) {
    throw new SpecError('invalid-spec', '规则包含过多字段');
  }

  const label = asString(input.label ?? '');
  if (typeof label !== 'string' || label.length === 0) {
    throw new SpecError('invalid-label', '规则名称不能为空', 'label');
  }
  if (label.length > SPEC_LIMITS.label) {
    throw new SpecError('invalid-label', `规则名称不能超过 ${SPEC_LIMITS.label} 个字符`, 'label');
  }
  if (/[\u0000-\u001f\u007f]/.test(label)) {
    throw new SpecError('invalid-label', '规则名称不能包含控制字符', 'label');
  }

  const expressions = {};
  const parsed = {};
  for (const [field, role] of Object.entries(EXPR_ROLES)) {
    const raw = input[field];
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (field === 'group' || field === 'measure') {
        throw new SpecError('missing-expression', `${field === 'group' ? '分组键' : '聚合度量'}表达式不能为空`, field);
      }
      expressions[field] = null;
      parsed[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      throw new SpecError('invalid-expression', `${field} 必须是字符串`, field);
    }
    try {
      const analysis = analyzeExpression(raw, role);
      expressions[field] = raw.trim();
      parsed[field] = analysis.ast;
    } catch (error) {
      if (error instanceof ExprError) {
        throw new SpecError(
          error.code,
          `${expressionLabel(field)}（${raw.trim()}）: ${error.message}`,
          field,
        );
      }
      throw error;
    }
  }

  const aggregate = input.aggregate ?? 'sum';
  if (!AGGREGATES.includes(aggregate)) {
    throw new SpecError('invalid-aggregate', `聚合方式必须是 ${AGGREGATES.join(' / ')}`, 'aggregate');
  }

  const windowInput = input.window ?? {};
  const kind = windowInput.kind ?? 'tumbling';
  if (!WINDOW_KINDS.includes(kind)) {
    throw new SpecError('invalid-window', '窗口类型必须是 tumbling 或 hopping', 'window.kind');
  }
  const sizeMs = integerInRange(windowInput.sizeMs ?? DEFAULT_SPEC.window.sizeMs, '窗口长度', SPEC_LIMITS.sizeMs);
  let slideMs = integerInRange(
    windowInput.slideMs ?? (kind === 'hopping' ? 5_000 : sizeMs),
    '滑动步长',
    SPEC_LIMITS.slideMs,
    { allowUndefined: false },
  );
  if (kind === 'tumbling') {
    slideMs = sizeMs;
  } else {
    if (slideMs > sizeMs) {
      throw new SpecError('invalid-window', '滑动步长不能大于窗口长度', 'window.slideMs');
    }
    if (sizeMs % slideMs !== 0) {
      throw new SpecError('invalid-window', '窗口长度必须是滑动步长的整数倍', 'window.slideMs');
    }
    if (sizeMs / slideMs > SPEC_LIMITS.maxWindowsPerEvent) {
      throw new SpecError(
        'invalid-window',
        `单个事件最多落入 ${SPEC_LIMITS.maxWindowsPerEvent} 个窗口，请增大步长`,
        'window.slideMs',
      );
    }
  }
  const allowedLatenessMs = integerInRange(
    windowInput.allowedLatenessMs ?? 0,
    '允许迟到',
    SPEC_LIMITS.latenessMs,
  );
  if (allowedLatenessMs > sizeMs * 4) {
    throw new SpecError('invalid-window', '允许迟到不能超过窗口长度的 4 倍', 'window.allowedLatenessMs');
  }
  const offsetMs = integerInRange(windowInput.offsetMs ?? 0, '窗口偏移', {
    min: SPEC_LIMITS.offsetMs.min,
    max: Math.max(SPEC_LIMITS.offsetMs.min, sizeMs - 1),
  });

  const spec = {
    label,
    filter: expressions.filter,
    group: expressions.group,
    dedup: expressions.dedup,
    measure: expressions.measure,
    aggregate,
    window: {
      kind,
      sizeMs,
      slideMs: kind === 'tumbling' ? sizeMs : slideMs,
      allowedLatenessMs,
      offsetMs,
    },
  };

  const canonical = {
    filter: expressions.filter ? canonicalString(parsed.filter) : null,
    group: canonicalString(parsed.group),
    dedup: expressions.dedup ? canonicalString(parsed.dedup) : null,
    measure: canonicalString(parsed.measure),
    aggregate,
    window: {
      kind,
      sizeMs,
      slideMs: spec.window.slideMs,
      allowedLatenessMs,
      offsetMs,
    },
  };

  const canonicalJson = JSON.stringify(canonical);
  const semanticHash = createHash('sha256').update(canonicalJson).digest('hex').slice(0, 16);

  return { spec, parsed, canonical, canonicalJson, semanticHash };
}

export function expressionLabel(field) {
  return {
    filter: '过滤条件',
    group: '分组键',
    dedup: '去重键',
    measure: '聚合度量',
  }[field] ?? field;
}

export function describeSpec(spec) {
  const agg = {
    sum: '求和',
    count: '计数',
    avg: '平均',
    min: '最小',
    max: '最大',
  }[spec.aggregate];
  const window =
    spec.window.kind === 'tumbling'
      ? `滚动窗口 ${spec.window.sizeMs}ms`
      : `滑动窗口 ${spec.window.sizeMs}ms/${spec.window.slideMs}ms`;
  return `${spec.group} · ${agg}(${spec.measure}) · ${window} · 迟到 ${spec.window.allowedLatenessMs}ms`;
}

export function summarizeSpec(spec) {
  return {
    label: spec.label,
    filter: spec.filter,
    group: spec.group,
    dedup: spec.dedup,
    measure: spec.measure,
    aggregate: spec.aggregate,
    window: spec.window,
    description: describeSpec(spec),
  };
}

/**
 * Compare a new spec against an existing version.
 * Returns classification: 'noop' | 'migrate' | 'rebuild'.
 *
 * Only changes that can be answered from the neutral aggregate state
 * (count / sum / min / max) are migratable. Everything that changes which
 * events belong to which group/window/measure must be rebuilt from retained
 * raw events.
 */
export function classifyChange(oldSpec, newSpec, oldCanonical) {
  const oldCanonicalObj = oldCanonical ?? canonicalForSpec(oldSpec);
  const newCanonicalObj = canonicalForSpec(newSpec);
  const changes = [];

  const semantic = ['filter', 'group', 'dedup', 'measure'];
  for (const field of semantic) {
    if (oldCanonicalObj[field] !== newCanonicalObj[field]) {
      changes.push({
        field,
        label: expressionLabel(field),
        kind: 'semantic',
        from: oldSpec[field],
        to: newSpec[field],
        why: MIGRATION_WHY[field],
      });
    }
  }

  const oldWindow = oldCanonicalObj.window;
  const newWindow = newCanonicalObj.window;
  for (const key of ['kind', 'sizeMs', 'slideMs', 'allowedLatenessMs', 'offsetMs']) {
    if (oldWindow[key] !== newWindow[key]) {
      changes.push({
        field: `window.${key}`,
        label: WINDOW_KEY_LABELS[key],
        kind: 'semantic',
        from: oldWindow[key],
        to: newWindow[key],
        why: key === 'allowedLatenessMs' ? MIGRATION_WHY.lateness : MIGRATION_WHY.window,
      });
    }
  }

  if (oldCanonicalObj.aggregate !== newCanonicalObj.aggregate) {
    changes.push({
      field: 'aggregate',
      label: '聚合方式',
      kind: 'migratable',
      from: oldSpec.aggregate,
      to: newSpec.aggregate,
      why: '状态同时保留 count / sum / min / max，只是展示口径变化，可直接换算。',
    });
  }

  if (oldSpec.label !== newSpec.label) {
    changes.push({
      field: 'label',
      label: '规则名称',
      kind: 'display',
      from: oldSpec.label,
      to: newSpec.label,
      why: '仅影响展示，不改变状态语义。',
    });
  }

  const rebuild = changes.filter((change) => change.kind === 'semantic');
  const migratable = changes.filter((change) => change.kind === 'migratable');

  let classification;
  if (rebuild.length > 0) classification = 'rebuild';
  else if (migratable.length > 0) classification = 'migrate';
  else classification = 'noop';

  return {
    classification,
    changes,
    reasons: rebuild.map((change) => `${change.label}：${change.why}`),
    migratableReasons: migratable.map((change) => `${change.label}：${change.why}`),
  };
}

function canonicalForSpec(spec) {
  const parsed = {
    filter: spec.filter ? analyzeExpression(spec.filter, 'filter').ast : null,
    group: analyzeExpression(spec.group, 'group').ast,
    dedup: spec.dedup ? analyzeExpression(spec.dedup, 'dedup').ast : null,
    measure: analyzeExpression(spec.measure, 'measure').ast,
  };
  return {
    filter: parsed.filter ? canonicalString(parsed.filter) : null,
    group: canonicalString(parsed.group),
    dedup: parsed.dedup ? canonicalString(parsed.dedup) : null,
    measure: canonicalString(parsed.measure),
    aggregate: spec.aggregate,
    window: { ...spec.window },
  };
}

const MIGRATION_WHY = Object.freeze({
  filter: '过滤条件改变会改变进入聚合的事件集合，旧状态无法反推被排除的事件，必须重放留存原始数据。',
  group: '分组键改变后旧聚合行无法拆分到新键，必须重放留存原始数据。',
  dedup: '去重键改变意味着“哪些事件算重复”的定义变化，旧去重集合不可复用。',
  measure: '已存储的 sum/min/max 属于旧度量表达式，无法换算成新度量的值。',
  window: '窗口长度、步长、类型或偏移改变后，旧窗口边界无法重新切分。',
  lateness: '允许迟到改变会改变窗口关闭与迟到丢弃的判定，旧状态无法保证与全量重算一致。',
});

const WINDOW_KEY_LABELS = Object.freeze({
  kind: '窗口类型',
  sizeMs: '窗口长度',
  slideMs: '滑动步长',
  allowedLatenessMs: '允许迟到',
  offsetMs: '窗口偏移',
});

export function expressionSource(analysis) {
  return formatExpression(analysis.ast);
}

export const SPEC_HELP = Object.freeze({
  fields: FIELD_INFO,
  aggregates: AGGREGATES,
  windowKinds: WINDOW_KINDS,
  limits: SPEC_LIMITS,
  roles: EXPR_ROLES,
});
