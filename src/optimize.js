import { parseDSL, formatPlan } from './dsl.js';
import { evaluateDetailed, multisetDiff } from './engine.js';
import { generateCandidates } from './rules.js';

function auditCandidate(beforePlan, beforeEval, candidate, catalog) {
  const audit = {
    formallyLegal: candidate.legal,
    empiricalEquivalent: false,
    equivalenceError: null,
    diff: null,
    costBefore: beforeEval.cost,
    costAfter: null,
    costDelta: null,
    afterCount: null,
    afterSchema: null,
    runtimeError: null,
  };

  try {
    const after = evaluateDetailed(candidate.proposed, catalog);
    audit.costAfter = after.cost;
    audit.costDelta = round(after.cost - beforeEval.cost);
    audit.afterCount = after.rows.length;
    audit.afterSchema = after.schema.map(c => c.key);
    audit.diff = multisetDiff(beforeEval.rows, after.rows, beforeEval.schema.map(c => c.key));
    audit.empiricalEquivalent = audit.diff.equivalent;
  } catch (error) {
    audit.runtimeError = error.message || String(error);
    audit.empiricalEquivalent = false;
  }

  candidate.audit = audit;
  candidate.verdict = verdictFor(candidate, null);
  return audit;
}

function verdictFor(candidate, recommendedId) {
  if (!candidate.legal) return 'rejected-rule';
  if (candidate.audit?.runtimeError) return 'rejected-runtime';
  if (candidate.audit && !candidate.audit.empiricalEquivalent) return 'rejected-differential';
  if (recommendedId && candidate.id === recommendedId) return 'adopted';
  return 'eligible';
}

function round(n) { return Math.round(n * 100) / 100; }

const RULE_PRIORITY = {
  'push-where-left-preserved': 100,
  'push-where-inner-left': 100,
  'push-where-inner-right': 100,
  'push-on-right-input': 95,
  'push-on-inner-left': 95,
  'left-to-inner-null-rejecting': 90,
  'merge-where-inner-on': 85,
  'push-filter-through-project': 80,
  'prune-base-columns': 70,
  'merge-adjacent-projects': 60,
  'filter-split-and': 55,
  'eliminate-identity-project': 40,
};

export function stepOnce(input, catalog) {
  const beforePlan = typeof input === 'string' ? parseDSL(input) : input;
  const beforeText = typeof input === 'string' ? input.trim() : formatPlan(beforePlan);
  const beforeEval = evaluateDetailed(beforePlan, catalog);
  const candidates = generateCandidates(beforePlan, catalog);

  for (const candidate of candidates) {
    auditCandidate(beforePlan, beforeEval, candidate, catalog);
  }

  const eligible = candidates.filter(c => c.legal
    && !c.audit.runtimeError
    && c.audit.empiricalEquivalent);

  eligible.sort((a, b) => {
    // Pedagogical/heuristic ordering: move/validate predicates first, then
    // projection cleanup. Cost breaks ties within the same rule class.
    const priorityGap = (RULE_PRIORITY[b.ruleId] || 0) - (RULE_PRIORITY[a.ruleId] || 0);
    if (priorityGap !== 0) return priorityGap;
    return a.audit.costAfter - b.audit.costAfter;
  });

  const recommended = eligible[0] || null;
  const recommendedId = recommended?.id || null;
  for (const c of candidates) c.verdict = verdictFor(c, recommendedId);

  return {
    beforeText: formatPlan(beforePlan),
    beforeCost: beforeEval.cost,
    beforeCount: beforeEval.rows.length,
    beforeSchema: beforeEval.schema.map(c => c.key),
    beforeRows: beforeEval.rows,
    candidates,
    recommendedId,
    recommendedText: recommended?.proposedText || null,
    recommended,
  };
}

export function runOptimization(input, catalog, maxSteps = 12) {
  const steps = [];
  let current = input;
  let finalText = typeof input === 'string' ? input : formatPlan(input);
  let stoppedReason = null;

  for (let i = 0; i < maxSteps; i++) {
    let step;
    try {
      step = stepOnce(current, catalog);
    } catch (error) {
      stoppedReason = `解析或执行失败：${error.message}`;
      return { steps, finalText, stoppedReason, error: error.message };
    }
    steps.push(step);

    if (!step.recommended) {
      stoppedReason = '没有更多可证明合法且经验证等价的候选';
      break;
    }
    step.selectedId = step.recommendedId;
    step.selectedByPolicy = true;
    finalText = step.recommendedText;
    current = step.recommended.proposed;
  }

  if (!stoppedReason && steps.length === maxSteps) stoppedReason = '达到最大步数';

  let finalEval = null;
  let originalEval = null;
  let totalDiff = null;
  try {
    const originalPlan = typeof input === 'string' ? parseDSL(input) : input;
    finalEval = evaluateDetailed(parseDSL(finalText), catalog);
    originalEval = evaluateDetailed(originalPlan, catalog);
    totalDiff = multisetDiff(originalEval.rows, finalEval.rows, originalEval.schema.map(c => c.key));
  } catch (error) {
    stoppedReason = `最终校验失败：${error.message}`;
  }

  return {
    steps,
    finalText,
    stoppedReason,
    finalEval,
    originalEval,
    totalDiff,
    equivalent: totalDiff?.equivalent ?? false,
  };
}

export { parseDSL, formatPlan };
