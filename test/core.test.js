import test from 'node:test';
import assert from 'node:assert/strict';

import { EXAMPLES, CATALOG } from '../src/examples.js';
import { parseDSL, parsePredicate, formatPlan } from '../src/dsl.js';
import { evalExpr, evaluatePlan, multisetDiff } from '../src/engine.js';
import { stepOnce, runOptimization } from '../src/optimize.js';

function cloneCatalog() {
  return structuredClone(CATALOG);
}

test('three-valued logic: NOT equality on NULL remains UNKNOWN and WHERE rejects it', () => {
  const p = parsePredicate(`NOT (d.name = 'Sales')`);
  assert.equal(evalExpr(p, { 'd.name': 'Engineering' }), true);
  assert.equal(evalExpr(p, { 'd.name': 'Sales' }), false);
  assert.equal(evalExpr(p, { 'd.name': null }), null);

  const plan = parseDSL(`(filter {NOT (x = 1)} (table t))`);
  const catalog = {
    t: { columns: ['x'], rows: [{ x: 1 }, { x: 2 }, { x: null }] },
  };
  const rows = evaluatePlan(plan, catalog);
  assert.deepEqual(rows, [{ 't.x': 2 }]);
});

test('LEFT JOIN preserves unmatched left rows with NULL-extended right columns', () => {
  const plan = parseDSL(`
    (project [e.name, d.name AS dept]
      (join left {e.dept_id = d.id}
        (table emp e)
        (table dept d)))
  `);
  const rows = evaluatePlan(plan, cloneCatalog());
  const dave = rows.find(r => r['e.name'] === 'Dave');
  assert.ok(dave);
  assert.equal(dave.dept, null);
  assert.ok(rows.length >= 6);
});

test('every built-in example optimizes to a multiset-equivalent plan', () => {
  for (const example of EXAMPLES) {
    const result = runOptimization(example.plan, cloneCatalog(), 14);
    assert.equal(result.error, undefined, `${example.id}: ${result.error}`);
    assert.equal(result.equivalent, true, `${example.id}: final result differs`);
    assert.equal(result.totalDiff.missing.length, 0, example.id);
    assert.equal(result.totalDiff.extra.length, 0, example.id);
  }
});

test('every formally legal candidate passes differential check and DSL roundtrip', () => {
  let checked = 0;
  for (const example of EXAMPLES) {
    let text = example.plan;
    for (let round = 0; round < 8; round++) {
      const step = stepOnce(text, cloneCatalog());
      for (const candidate of step.candidates) {
        checked++;
        const reparsed = parseDSL(candidate.proposedText);
        const beforeRoundtrip = evaluatePlan(candidate.proposed, cloneCatalog());
        const afterRoundtrip = evaluatePlan(reparsed, cloneCatalog());
        assert.equal(
          multisetDiff(beforeRoundtrip, afterRoundtrip).equivalent,
          true,
          `${example.id} ${candidate.ruleId} changed during format/parse roundtrip`,
        );

        if (candidate.legal) {
          assert.equal(candidate.audit.runtimeError, null,
            `${example.id} ${candidate.ruleId}: ${candidate.audit.runtimeError}`);
          assert.equal(candidate.audit.empiricalEquivalent, true,
            `${example.id} legal candidate ${candidate.ruleId} failed differential`);
        }
      }
      if (!step.recommended) break;
      text = step.recommendedText;
    }
  }
  assert.ok(checked >= 40, `expected dozens of candidates, got ${checked}`);
});

test('named wrong rules are broken by the bundled counterexample data', () => {
  for (const example of EXAMPLES.filter(x => x.badRuleId)) {
    const step = stepOnce(example.plan, cloneCatalog());
    const bad = step.candidates.find(c => c.ruleId === example.badRuleId);
    assert.ok(bad, `${example.id} did not generate ${example.badRuleId}`);
    assert.equal(bad.legal, false, `${example.badRuleId} must be marked illegal`);
    assert.equal(bad.audit.empiricalEquivalent, false,
      `${example.id} counterexample should produce a data difference`);
    assert.ok(
      bad.audit.diff.missing.length + bad.audit.diff.extra.length > 0,
      `${example.id} should have missing or extra rows`,
    );
  }
});

test('safe pushdown rules survive randomized NULL-heavy catalogs', () => {
  const values = {
    key: ['d1', 'd2', 'd3', 'd9', null],
    level: [1, 2, 3, 5, null],
    boolean: [true, false, null],
    name: ['Sales', 'Engineering', null],
  };

  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function makeCatalog(seed) {
    let s = seed >>> 0;
    const rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const empRows = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      name: `e${i}`,
      dept_id: pick(rng, values.key),
      level: pick(rng, values.level),
      active: pick(rng, values.boolean),
    }));
    const deptRows = Array.from({ length: 4 }, (_, i) => ({
      id: pick(rng, ['d1', 'd2', 'd3', null]),
      name: pick(rng, values.name),
      min_level: pick(rng, values.level),
    }));
    return {
      emp: { columns: ['id', 'name', 'dept_id', 'level', 'active'], rows: empRows },
      dept: { columns: ['id', 'name', 'min_level'], rows: deptRows },
    };
  }

  const plans = [
    `(project [e.name, d.name AS dept]
       (filter {e.active = true AND d.min_level <= e.level}
         (join inner {e.dept_id = d.id} (table emp e) (table dept d))))`,
    `(project [e.name, d.name AS dept]
       (filter {d.name = 'Sales'}
         (join left {e.dept_id = d.id} (table emp e) (table dept d))))`,
    `(project [e.name, e.active, d.name AS dept]
       (join left {e.dept_id = d.id AND e.active = true}
         (table emp e) (table dept d)))`,
    `(project [e.name, e.level, d.min_level AS min_level]
       (filter {e.level >= d.min_level}
         (join left {e.dept_id = d.id} (table emp e) (table dept d))))`,
  ];

  for (let seed = 1; seed <= 80; seed++) {
    const catalog = makeCatalog(seed * 997);
    for (const plan of plans) {
      const result = runOptimization(plan, catalog, 10);
      assert.equal(result.error, undefined, `seed ${seed}: ${result.error}`);
      assert.equal(result.equivalent, true, `seed ${seed} plan ${plan.slice(0, 30)}`);

      const step = stepOnce(plan, catalog);
      for (const c of step.candidates.filter(x => x.legal)) {
        assert.equal(c.audit.empiricalEquivalent, true,
          `seed ${seed}: legal ${c.ruleId} failed on randomized NULL data`);
      }
    }
  }
});

test('formatter produces parseable plans for optimized final output', () => {
  for (const example of EXAMPLES) {
    const result = runOptimization(example.plan, cloneCatalog());
    assert.doesNotThrow(() => parseDSL(result.finalText), example.id);
    assert.ok(result.finalText.includes('(table'), example.id);
  }
});
