// scorer.js — do the grades predict the outcome, and how much of that is hindsight?
//
// ── THE RULE THIS FILE IS BUILT ON ───────────────────────────────────────────
// AN UNRANKABLE STATE MUST NEVER SHARE A VALUE WITH A RANKABLE ONE.
//
// The version this was extracted from returned 0.0 in four places where the honest answer
// was "cannot compute": too few rows, zero variance, an unrecognised grade, and a length
// mismatch. Every one of those is a real value elsewhere in the same scale — 0.0 means NO
// CORRELATION, and F is a grade a model can actually issue — so a model that graded every
// trade B became indistinguishable from one whose grades genuinely carry no signal. That
// matters MORE with levels, not less: the premium is a difference of two scores, so an
// unknown masquerading as a zero propagates into it silently.
//
// So: null for unknown, with a NAMED reason, and the reporting layer says which.
'use strict';

const { num } = require('./util.js');

// A=5 … F=1. Ordinal and evenly spaced, which is all a rank correlation needs.
const GRADES = Object.freeze(['A', 'B', 'C', 'D', 'F']);
const GRADE_NUM = Object.freeze({ A: 5, B: 4, C: 3, D: 2, F: 1 });

// Below this a rho is noise in a statistic's costume. Not a tuned parameter — it is the
// point at which a correlation stops being quotable at all, and the run says so rather
// than printing a confident number off nine rows.
const MIN_N = 20;

/**
 * Parse and VALIDATE a model's reply. A model that drifts off-schema is REFUSED, not
 * coerced. Mapping an unrecognised grade to a number is the worst available option: "B+"
 * or a hedge or a refusal all become a grade nobody issued, and it feeds every downstream
 * statistic as though the model had said it.
 */
function parseGrade(text) {
  if (typeof text !== 'string') return { ok: false, error: 'no_text' };
  // Models wrap JSON in prose and fences no matter how firmly you ask them not to.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'no_json' };
  let d;
  try { d = JSON.parse(m[0]); } catch (e) { return { ok: false, error: 'bad_json' }; }
  const g = typeof d.grade === 'string' ? d.grade.trim().toUpperCase() : '';
  if (!GRADES.includes(g)) return { ok: false, error: 'bad_grade', got: d.grade };
  const conf = num(d.confidence);
  return {
    ok: true,
    grade: g,
    // Missing is null, never a middling default — an absent score is not a 3.
    thesisQuality: num(d.thesis_quality),
    riskQuality: num(d.risk_quality),
    confidence: conf != null && conf >= 0 && conf <= 1 ? conf : null,
    wouldTakeAgain: typeof d.would_take_again === 'boolean' ? d.would_take_again : null,
    reasons: Array.isArray(d.reasons) ? d.reasons.filter(x => typeof x === 'string').slice(0, 5) : []
  };
}

/**
 * Spearman rank correlation between grade (A=5 … F=1) and realised return.
 *
 * WHY RANK, AND WHY THIS IS THE PRIMARY METRIC. Comparing the A-bucket's mean return
 * against the F-bucket's is the obvious move and it discards every trade in between, then
 * reports a difference of two averages taken over a handful of rows — so one outsized
 * winner in the A bucket carries the whole leaderboard. Rank correlation uses every row,
 * assumes no distribution, and is not moved by a single whale. Bucket means are still
 * reported, as COLOUR beside the number, never as the ranking key.
 */
function spearman(pairs) {
  const rows = (Array.isArray(pairs) ? pairs : [])
    .filter(p => p && GRADES.includes(p.grade) && num(p.ret) != null);
  const n = rows.length;
  if (n < 3) return { rho: null, n, reason: 'too_few' };

  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;                       // ties share the average rank
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };

  const gr = rank(rows.map(p => GRADE_NUM[p.grade]));
  const rr = rank(rows.map(p => num(p.ret)));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mg = mean(gr), mr = mean(rr);
  let cov = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const a = gr[i] - mg, b = rr[i] - mr;
    cov += a * b; sa += a * a; sb += b * b;
  }
  // Zero variance on either axis. NOT a rho of 0 — "every grade was B" is a fact about the
  // model and is the likeliest first-run outcome, so it gets its own name.
  if (sa === 0 || sb === 0) return { rho: null, n, reason: 'no_variance' };
  return { rho: +(cov / Math.sqrt(sa * sb)).toFixed(4), n, reason: null };
}

/**
 * Does the grade separate the outcome? Reports the buckets as colour and REFUSES a verdict
 * when the sample or the spread cannot support one.
 */
function discrimination(pairs) {
  const rows = (Array.isArray(pairs) ? pairs : []).filter(p => p && GRADES.includes(p.grade));
  const buckets = {};
  for (const g of GRADES) buckets[g] = [];
  for (const p of rows) if (num(p.ret) != null) buckets[p.grade].push(num(p.ret));

  const used = GRADES.filter(g => buckets[g].length > 0);
  const summary = GRADES.map(g => ({
    grade: g,
    n: buckets[g].length,
    meanRet: buckets[g].length
      ? +(buckets[g].reduce((a, b) => a + b, 0) / buckets[g].length).toFixed(2)
      : null                                            // no rows is not a mean of zero
  }));
  const sp = spearman(rows);

  let verdict, reason;
  if (sp.n < MIN_N) {
    verdict = 'too_thin';
    reason = `${sp.n} graded row(s) with a usable return. Need ${MIN_N} before the correlation ` +
             'says anything; a rho off a handful of rows is noise in a statistic\'s costume.';
  } else if (used.length < 2) {
    verdict = 'no_spread';
    reason = `every grade is "${used[0] || 'none'}" — the model is not discriminating, so nothing ` +
             'downstream can be read. THIS IS A REAL FINDING, not a failed run.';
  } else if (sp.rho == null) {
    verdict = 'unrankable';
    reason = `no usable correlation (${sp.reason}) — reported as unknown rather than as zero.`;
  } else {
    verdict = Math.abs(sp.rho) >= 0.3 ? 'discriminating' : 'not_discriminating';
    reason = `rho ${sp.rho} over n=${sp.n} across ${used.length} grade level(s).`;
  }
  return { verdict, reason, rho: sp.rho, n: sp.n, gradesUsed: used.length, buckets: summary };
}

/**
 * THE HINDSIGHT PREMIUM — the number the levels exist for.
 *
 * `full − narrative`, in rho. Positive means the outcome is doing work the judgement could
 * not: the model's grades improve once it can see the result, and that gap is hindsight
 * rather than skill. A model whose blind grades predict as well as its sighted ones has
 * genuine judgement, and the difference is now a number instead of a suspicion.
 *
 * Returns null — never 0 — when either end is missing or unrankable. "We did not run both
 * levels" and "there is no premium" are opposite findings.
 */
function hindsightPremium(rhoByLevel) {
  const nar = num(rhoByLevel && rhoByLevel.narrative);
  const full = num(rhoByLevel && rhoByLevel.full);
  if (nar == null || full == null) return { premium: null, narrative: nar, full, reason: 'need_both_levels' };
  const d = +(full - nar).toFixed(4);
  return {
    premium: d, narrative: nar, full,
    reason: d > 0.2
      ? 'the grades improve materially once the outcome is visible — that gap is hindsight, not judgement'
      : 'knowing the outcome adds little, so the blind grades are carrying their own weight'
  };
}

module.exports = { GRADES, GRADE_NUM, MIN_N, parseGrade, spearman, discrimination, hindsightPremium };
