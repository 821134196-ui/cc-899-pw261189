import {
  formatPlan, formatExpr, makeAnd, makeOr, splitConjuncts, splitDisjuncts,
  substituteExpr, exprRefs,
} from './dsl.js';
import { analyze, schemaOf, sideOfExpr, isNullRejecting, nullWitness } from './engine.js';

let candidateSeq = 0;

function replaceAtPath(root, path, replacement) {
  if (path.length === 0) return replacement;
  const clone = structuredClone(root);
  let cur = clone;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    cur[key] = structuredClone(cur[key]);
    cur = cur[key];
  }
  cur[path[path.length - 1]] = replacement;
  return clone;
}

function walkPlans(node, path, emit) {
  emit(node, path);
  if (node.input) walkPlans(node.input, [...path, 'input'], emit);
  if (node.left) walkPlans(node.left, [...path, 'left'], emit);
  if (node.right) walkPlans(node.right, [...path, 'right'], emit);
}

function keySets(join, catalog) {
  return {
    leftKeys: new Set(schemaOf(join.left, catalog).map(c => c.key)),
    rightKeys: new Set(schemaOf(join.right, catalog).map(c => c.key)),
  };
}

function removalReplacement(filterNode, conjuncts, index, newInput) {
  if (conjuncts.length === 1) return newInput;
  const rest = makeAnd(conjuncts.filter((_, i) => i !== index));
  return { ...filterNode, pred: rest, input: newInput };
}

function pushIntoChild(join, side, pred) {
  const child = join[side];
  return {
    ...join,
    [side]: { kind: 'filter', pred, input: child },
  };
}

/* ---------------- Candidate rules ---------------- */

function filterCandidates(node, path, catalog, out) {
  if (node.kind !== 'filter') return;

  // 1) Split top-level AND into pipelined filters.
  const conjuncts = splitConjuncts(node.pred);
  if (conjuncts.length > 1) {
    let input = node.input;
    for (const c of conjuncts) input = { kind: 'filter', pred: c, input };
    out.push({
      ruleId: 'filter-split-and',
      title: '把 AND 拆成连续 Filter',
      target: `Filter @ ${pathLabel(path)}`,
      legal: true,
      category: 'normalization',
      detail: 'SQL WHERE 只保留三值逻辑为 TRUE 的行。AND 为 TRUE 当且仅当每个合取项都为 TRUE，因此可拆成管道式过滤，并让单项下推规则继续工作。',
      clauses: ['FALSE 优先于 UNKNOWN；只有 TRUE 通过', '拆分前后接受的行完全相同', '不涉及外连接补 NULL，因此不会改变保留行'],
      path, replacement: input,
    });
  }

  // 2) Push a filter through a projection by substitution.
  if (node.input.kind === 'project') {
    const project = node.input;
    const mapping = new Map(project.cols.map(c => [c.out, c.expr]));
    // Also map unqualified/default output names when unambiguous.
    for (const c of project.cols) {
      if (c.as && c.as !== c.out) mapping.set(c.as, c.expr);
    }
    const pushedPred = substituteExpr(node.pred, mapping);
    const replacement = {
      ...project,
      input: { kind: 'filter', pred: pushedPred, input: project.input },
    };
    out.push({
      ruleId: 'push-filter-through-project',
      title: '谓词穿过 Project（表达式替换）',
      target: `Filter → Project @ ${pathLabel(path)}`,
      legal: true,
      category: 'pushdown',
      detail: 'Projection 是逐行表达式计算，不消除重复行。把外层输出列名替换为其定义表达式后，谓词可安全移动到投影下方；NULL 会沿原表达式传播。',
      clauses: ['词法替换保持三值逻辑', '包语义下每行仍恰好产生一个投影行', '不会把 DISTINCT 或重复消除混入本规则'],
      path, replacement,
    });
  }

  // 3) Deliberately wrong two-valued complement rewrite.
  const badComplement = wrongNullComplement(node.pred);
  if (badComplement) {
    out.push({
      ruleId: 'wrong-null-complement',
      title: '错误规则：把 NOT(x=v) 改成 x<>v OR x IS NULL',
      target: `Filter @ ${pathLabel(path)}`,
      legal: false,
      category: 'null-counterexample',
      detail: '这是经典二值集合补集错觉。x 为 NULL 时，x=v 是 UNKNOWN，NOT UNKNOWN 仍是 UNKNOWN，WHERE 会拒绝该行；但 x IS NULL 分支为 TRUE，错误改写会放行 NULL 行。',
      clauses: ['原表达式在 NULL 上得到 UNKNOWN，不是 TRUE', 'WHERE/Filter 只接受 TRUE', 'OR x IS NULL 把本应拒绝的 NULL 行变成 TRUE'],
      path,
      replacement: { ...node, pred: badComplement },
    });
  }

  // 4) Filter directly above a join.
  if (node.input.kind !== 'join') return;
  const join = node.input;
  const { leftKeys, rightKeys } = keySets(join, catalog);
  const joinConjuncts = splitConjuncts(node.pred);
  const rightKeySet = rightKeys;

  // Wrong cross-side OR decomposition.
  if ((node.pred.kind === 'op' && node.pred.op === 'or') || splitDisjuncts(node.pred).length > 1 && splitConjuncts(node.pred).length === 1) {
    const disjuncts = splitDisjuncts(node.pred);
    const leftParts = [];
    const rightParts = [];
    let localEvery = disjuncts.length > 0;
    for (const d of disjuncts) {
      const side = sideOfExpr(d, leftKeys, rightKeys);
      if (side === 'left') leftParts.push(d);
      else if (side === 'right') rightParts.push(d);
      else localEvery = false;
    }
    if (join.joinType === 'left' && localEvery && leftParts.length && rightParts.length) {
      let newJoin = { ...join };
      if (leftParts.length) newJoin = pushIntoChild(newJoin, 'left', makeOr(leftParts));
      if (rightParts.length) newJoin = pushIntoChild(newJoin, 'right', makeOr(rightParts));
      out.push({
        ruleId: 'wrong-or-both-sides',
        title: '错误规则：把跨表 OR 拆到连接两侧并删除 WHERE',
        target: `Filter(OR…) → LEFT JOIN @ ${pathLabel(path)}`,
        legal: false,
        category: 'outer-join-counterexample',
        detail: 'OR 的每个分支可以匹配不同行，不能变成左右输入上的两个过滤条件后再从 WHERE 删除整个 OR。对 LEFT JOIN，这还会错误删除保留侧行或改变 NULL 补行。',
        clauses: ['OR 不是 AND，不能按合取项方式拆分', '两侧同时过滤会把 OR 语义变成受限的连接语义', '保留表中不满足左侧分支的行会被提前删除'],
        path, replacement: newJoin,
      });
    }
  }

  let offeredOuterInner = false;

  joinConjuncts.forEach((c, index) => {
    const side = sideOfExpr(c, leftKeys, rightKeys);

    if (join.joinType === 'inner') {
      if (side === 'left' || side === 'right') {
        const newJoin = pushIntoChild(join, side, c);
        out.push({
          ruleId: `push-where-inner-${side}`,
          title: `WHERE 单侧谓词下推到 INNER JOIN ${side === 'left' ? '左' : '右'}输入`,
          target: `Filter → INNER JOIN @ ${pathLabel(path)}`,
          legal: true,
          category: 'pushdown',
          detail: 'INNER JOIN 不补 NULL：最终能出现的每一对都必须满足连接和过滤条件。只引用一侧的合取项可在连接前过滤该侧，三值判断保持不变。',
          clauses: ['合取项只引用一侧列', 'INNER JOIN 没有保留行', '同一谓词、同一 3VL，不在 NULL 上替换比较规则'],
          path, replacement: removalReplacement(node, joinConjuncts, index, newJoin),
        });
      } else if (side === 'cross') {
        const newJoin = { ...join, on: makeAnd([join.on, c]) };
        out.push({
          ruleId: 'merge-where-inner-on',
          title: '跨表 WHERE 谓词并入 INNER JOIN ON',
          target: `Filter → INNER JOIN @ ${pathLabel(path)}`,
          legal: true,
          category: 'pushdown',
          detail: 'INNER JOIN 中 WHERE 与 ON 对最终匹配对的接受条件等价：二者都只保留条件为 TRUE 的配对。',
          clauses: ['没有未匹配保留行', 'UNKNOWN 配对在 ON 和 WHERE 中都被拒绝', '合并后仍是同一个合取条件'],
          path, replacement: removalReplacement(node, joinConjuncts, index, newJoin),
        });
      }
      return;
    }

    // LEFT JOIN rules.
    if (side === 'left') {
      out.push({
        ruleId: 'push-where-left-preserved',
        title: 'WHERE 保留侧谓词下推到 LEFT JOIN 左输入',
        target: `Filter → LEFT JOIN @ ${pathLabel(path)}`,
        legal: true,
        category: 'pushdown',
        detail: '左表是保留侧：每个未被右表匹配的左行都会以右侧 NULL 保留。顶层 WHERE 中只引用左列的谓词若不满足，无论是否匹配都会被 WHERE 删除；因此可在连接前删除该左行。',
        clauses: ['谓词只引用保留侧（左）', 'Filter 只接受 TRUE，FALSE/UNKNOWN 均删除', '提前删除的左行本来就不会通过顶层 WHERE'],
        path, replacement: removalReplacement(node, joinConjuncts, index, pushIntoChild(join, 'left', c)),
      });
    }

    if (side === 'right') {
      out.push({
        ruleId: 'wrong-push-where-left-nullable',
        title: '错误规则：WHERE 右侧谓词直接推进 LEFT JOIN 右表',
        target: `Filter → LEFT JOIN @ ${pathLabel(path)}`,
        legal: false,
        category: 'outer-join-counterexample',
        detail: '推进右表只改变“哪些右行参与匹配”，不会删除左表保留行。删除顶层 WHERE 后，原本被谓词过滤掉的 NULL 扩展行会重新出现。',
        clauses: ['右表是 NULL 提供侧，不是保留侧', '下推版本会为失败匹配补右侧 NULL', '顶层 WHERE 通常会拒绝这些 NULL 扩展行；移动并删除 WHERE 后不再拒绝'],
        path, replacement: removalReplacement(node, joinConjuncts, index, pushIntoChild(join, 'right', c)),
      });
    }

    if (side === 'cross') {
      const movedJoin = { ...join, on: makeAnd([join.on, c]) };
      out.push({
        ruleId: 'wrong-move-where-to-left-on',
        title: '错误规则：把 WHERE 跨表谓词移到 LEFT JOIN ON',
        target: `Filter → LEFT JOIN @ ${pathLabel(path)}`,
        legal: false,
        category: 'outer-join-counterexample',
        detail: 'WHERE 条件在连接并补 NULL 之后执行；ON 条件只决定右行是否匹配。跨表谓词移入 ON 后，不满足该谓词的左行仍会以右侧 NULL 被保留，而不是被 WHERE 删除。',
        clauses: ['WHERE：连接、补 NULL 后过滤', 'ON：只决定是否找到匹配，失败后补 NULL', '两者在 LEFT JOIN 中不等价，即使谓词相同'],
        path, replacement: removalReplacement(node, joinConjuncts, index, movedJoin),
      });
    }

    const strict = side === 'right'
      ? nullWitness(c, rightKeySet) !== true
      : isNullRejecting(c, rightKeySet);
    if (strict && !offeredOuterInner && side !== 'constant') {
      offeredOuterInner = true;
      out.push({
        ruleId: 'left-to-inner-null-rejecting',
        title: 'NULL 拒绝谓词使 LEFT JOIN 可降级为 INNER JOIN',
        target: `Filter → LEFT JOIN @ ${pathLabel(path)}`,
        legal: true,
        category: 'outer-join-validation',
        detail: `合取项 ${formatExpr(c)} 在所有右列被补成 NULL 时保证不为 TRUE。因此 NULL 扩展行过不了顶层 WHERE，LEFT JOIN 与 INNER JOIN 在该查询上等价；降级后才能安全应用普通下推。`,
        clauses: ['检查的是 NULL 扩展行，而不只是普通右表 NULL 值', '合取顶层包含一个严格/NULL-rejecting 条件', 'IS NULL 这类在全 NULL 上为 TRUE 的条件不满足本规则'],
        path, replacement: { ...node, input: { ...join, joinType: 'inner' } },
      });
    }
  });
}

function joinCandidates(node, path, catalog, out) {
  if (node.kind !== 'join') return;
  const { leftKeys, rightKeys } = keySets(node, catalog);
  const conjuncts = splitConjuncts(node.on);

  conjuncts.forEach((c, index) => {
    if (c.kind === 'lit' && c.value === true) return;
    const side = sideOfExpr(c, leftKeys, rightKeys);
    const newOn = conjuncts.length === 1
      ? { kind: 'lit', value: true, dataType: 'boolean' }
      : makeAnd(conjuncts.filter((_, i) => i !== index));
    const base = { ...node, on: newOn };

    if (side === 'right') {
      out.push({
        ruleId: 'push-on-right-input',
        title: `ON 右侧单表谓词下推到 ${node.joinType.toUpperCase()} JOIN 右输入`,
        target: `Join ON @ ${pathLabel(path)}`,
        legal: true,
        category: 'pushdown',
        detail: 'ON 中只引用右表的合取项本来就只决定该右行能否成为匹配。先在右输入上用同一三值谓词过滤，不会改变匹配集合，也不会影响左表保留行。',
        clauses: ['位置是 ON，而不是连接后的 WHERE', '右输入是 NULL 提供侧；过滤不合格右行与 ON 判定相同', '保留侧补 NULL 的规则不变'],
        path, replacement: pushIntoChild(base, 'right', c),
      });
    }

    if (side === 'left' && node.joinType === 'inner') {
      out.push({
        ruleId: 'push-on-inner-left',
        title: 'ON 左侧谓词下推到 INNER JOIN 左输入',
        target: `INNER JOIN ON @ ${pathLabel(path)}`,
        legal: true,
        category: 'pushdown',
        detail: 'INNER JOIN 不保留未匹配左行，因此 ON 左表单表合取项可以安全前推。',
        clauses: ['没有 LEFT JOIN 保留语义', 'FALSE/UNKNOWN 左行不会产生结果'],
        path, replacement: pushIntoChild(base, 'left', c),
      });
    }

    if (side === 'left' && node.joinType === 'left') {
      out.push({
        ruleId: 'wrong-push-on-left-preserved',
        title: '错误规则：ON 中左表谓词下推到 LEFT JOIN 左输入',
        target: `LEFT JOIN ON @ ${pathLabel(path)}`,
        legal: false,
        category: 'outer-join-counterexample',
        detail: 'ON 里的左表谓词若不满足，只表示该左行找不到匹配；LEFT JOIN 仍会把它连同右侧 NULL 一起保留。提前过滤左表会让这一整行消失。',
        clauses: ['ON 失败 ≠ 左行被删除', 'LEFT JOIN 会补右 NULL 并保留左行', '只有连接后 WHERE 中的保留侧谓词才可直接下推到左输入'],
        path, replacement: pushIntoChild(base, 'left', c),
      });
    }
  });
}

function projectCandidates(node, path, catalog, out, root) {
  if (node.kind !== 'project') return;

  if (node.input.kind === 'project') {
    const bottom = node.input;
    const mapping = new Map(bottom.cols.map(c => [c.out, c.expr]));
    const mergedCols = node.cols.map(item => ({
      ...item,
      expr: substituteExpr(item.expr, mapping),
    }));
    out.push({
      ruleId: 'merge-adjacent-projects',
      title: '合并相邻 Project',
      target: `Project → Project @ ${pathLabel(path)}`,
      legal: true,
      category: 'projection',
      detail: '内层投影的输出名可替换为其表达式；两个逐行投影合并后不改变包中的行数或值。',
      clauses: ['投影不是 DISTINCT', '输出列名保持外层定义', '表达式替换保留 NULL 传播'],
      path,
      replacement: { ...node, cols: mergedCols, input: bottom.input },
    });
  }

  // Identity projection elimination only when output schema/order is identical.
  try {
    const ownSchema = schemaOf(node, catalog);
    const childSchema = schemaOf(node.input, catalog);
    const identity = node.cols.every((c, i) => c.expr.kind === 'col'
      && c.expr.key === c.out
      && c.out === childSchema[i]?.key)
      && ownSchema.length === childSchema.length
      && ownSchema.every((c, i) => c.key === childSchema[i].key);
    if (identity) {
      out.push({
        ruleId: 'eliminate-identity-project',
        title: '删除恒等 Project',
        target: `Project @ ${pathLabel(path)}`,
        legal: true,
        category: 'projection',
        detail: '该投影按相同顺序输出子节点的全部同名列，没有表达式、重命名或去重，因此节点是恒等的。',
        clauses: ['输出模式完全相同', '不改变行多重性'],
        path, replacement: node.input,
      });
    }
  } catch { /* schema errors are reported by main analysis */ }

  // Root-wide base-column pruning driven by the explicit projection.
  if (path.length === 0) {
    const replacement = pruneTableScans(node, catalog);
    if (replacement && JSON.stringify(tablesOnly(root)) !== JSON.stringify(tablesOnly(replacement))) {
      out.push({
        ruleId: 'prune-base-columns',
        title: '投影列裁剪：只扫描表达式实际需要的基表列',
        target: '所有 TableScan',
        legal: true,
        category: 'projection',
        detail: '顶层 Project 确定输出列。未出现在任何投影、过滤或连接条件中的基表列不可能影响结果或连接行数，因此可从扫描宽度中裁掉；行多重性不变。',
        clauses: ['包语义不因为少读列而去重', '连接和过滤所需列均已保留', '编辑行数据仍保留完整列，只是计划不读取未用列'],
        path: [],
        replacement,
      });
    }
  }
}

function pathLabel(path) {
  return path.length ? path.join(' → ') : 'root';
}

function wrongNullComplement(expr) {
  let found = null;
  const visit = e => {
    if (found || !e || typeof e !== 'object') return;
    if (e.kind === 'op' && e.op === 'not' && e.args[0]?.kind === 'op' && e.args[0].op === '=') {
      found = e;
      return;
    }
    (e.args || []).forEach(visit);
  };
  visit(expr);
  if (!found) return null;
  const eq = found.args[0];
  const wrong = makeOr([
    { kind: 'op', op: '<>', args: eq.args },
    { kind: 'op', op: 'is null', args: [eq.args[0]] },
  ]);
  return replaceNode(expr, found, wrong);
}

function replaceNode(root, target, replacement) {
  if (root === target) return replacement;
  if (!root.args) return root;
  return { ...root, args: root.args.map(a => replaceNode(a, target, replacement)) };
}

function collectPhysicalColumnUsage(plan) {
  const usage = new Map();
  const addExpr = e => {
    for (const key of exprRefs(e)) {
      // Resolved columns carry qual/name; exprRefs alone only gives keys.
    }
    const visit = x => {
      if (!x || typeof x !== 'object') return;
      if (x.kind === 'col' && x.qual && x.name) {
        if (!usage.has(x.qual)) usage.set(x.qual, new Set());
        usage.get(x.qual).add(x.name);
      }
      (x.args || []).forEach(visit);
    };
    visit(e);
  };
  walkPlans(plan, [], n => {
    addExpr(n.pred);
    addExpr(n.on);
    (n.cols || []).forEach(c => addExpr(c.expr));
  });
  return usage;
}

function pruneTableScans(root, catalog) {
  const usage = collectPhysicalColumnUsage(root);
  return transformPlans(structuredClone(root), n => {
    if (n.kind !== 'table') return n;
    const cat = catalog[n.name];
    const all = cat?.columns || [];
    const used = usage.get(n.alias || n.name) || new Set();
    const only = all.filter(c => used.has(c));
    return { ...n, only };
  });
}

function transformPlans(node, fn) {
  let next = fn(node);
  if (next.input) next = { ...next, input: transformPlans(next.input, fn) };
  if (next.left) next = { ...next, left: transformPlans(next.left, fn) };
  if (next.right) next = { ...next, right: transformPlans(next.right, fn) };
  return next;
}

function tablesOnly(plan) {
  const result = [];
  walkPlans(plan, [], n => { if (n.kind === 'table') result.push([n.alias || n.name, n.only || null]); });
  return result;
}

/* ---------------- Public candidate generation ---------------- */

export function generateCandidates(plan, catalog) {
  const analyzed = analyze(plan, catalog);
  const root = analyzed.node;
  const raw = [];

  walkPlans(root, [], (node, path) => {
    filterCandidates(node, path, catalog, raw);
    joinCandidates(node, path, catalog, raw);
    projectCandidates(node, path, catalog, raw, root);
  });

  // De-duplicate identical rule/path/proposed plans.
  const seen = new Set();
  const candidates = [];
  for (const c of raw) {
    const proposed = replaceAtPath(root, c.path, c.replacement);
    const proposedText = formatPlan(proposed);
    const signature = `${c.ruleId}|${c.path.join('.')}|${proposedText}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    candidates.push({
      id: `cand-${++candidateSeq}`,
      signature,
      ruleId: c.ruleId,
      title: c.title,
      target: c.target,
      category: c.category,
      legal: !!c.legal,
      detail: c.detail,
      clauses: c.clauses || [],
      path: c.path,
      proposed,
      proposedText,
    });
  }
  return candidates;
}
