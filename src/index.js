// grading-rig — can a language model grade a trade it has not seen the outcome of?
//
// One export: gradeTrades(trades, config).
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
// A deterministic grader (a coroner, an attribution model, a rules engine) MEASURES what
// happened. This asks for a JUDGEMENT made from entry-time information only, and then
// measures whether that judgement carries any information the measurement does not. The
// experiment has a real chance of coming back NO, and either answer is worth having.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
// It never decides anything. It produces grades and a scorecard; nothing here opens a
// position, vetoes one, or feeds a scorer that does. If a grade ever earns a place in a
// decision, it earns it on a forward record, in a sandbox, like any other unproven signal.
'use strict';

const { LEVELS, blindCase, buildPrompt, assertBlindable } = require('./blind-levels.js');
const { GRADES, MIN_N, parseGrade, spearman, discrimination, hindsightPremium } = require('./scorer.js');
const { loadRegistry } = require('./registry.js');
const { runGrading } = require('./runner.js');

/**
 * @param {Array<object>} trades   closed trades. Each needs the visible fields, the level
 *                                 fields it will be graded at, and a realised return.
 * @param {object} config
 *   visibleKeys  string[]  REQUIRED. Entry-time allowlist. Never a denylist.
 *   outcomeKeys  string[]  REQUIRED. Every field that reveals what happened — including
 *                          any DURATION. Refuses without it; see blind-levels.js.
 *   nestedKeys   object    optional per-field inner allowlists for object-valued fields.
 *   models       array     from loadRegistry(), or the same shape.
 *   levels       string[]  default ['narrative','full'] — both ends of the premium.
 *   returnOf     fn        (trade) => realised return. Kept OUT of visibleKeys by design:
 *                          it is the label, and it must reach the scorer without ever
 *                          reaching the prompt.
 *   apiKey/baseUrl/timeoutMs/throttleMs/caseId
 * @param {object} hooks   { call, onRecord, has, log } — all injectable, so the package
 *                         runs against a fake in tests and a real gateway in production.
 */
async function gradeTrades(trades, config, hooks) {
  // Fail before spending anything. A blind that cannot be enforced makes every grade in
  // the run worthless, and finding that out after the API bill is the wrong order.
  assertBlindable(config);
  if (!Array.isArray(config.models) || !config.models.length)
    throw new Error('grading-rig: config.models is empty — nothing to run');
  if (typeof config.returnOf !== 'function')
    throw new Error('grading-rig: config.returnOf(trade) is required — without the realised return ' +
                    'the grades can be collected but never scored, which is a corpus, not an experiment');

  const rows = Array.isArray(trades) ? trades.filter(Boolean) : [];
  const { records, tally, levels } = await runGrading(rows, config, hooks);

  // ── SCORE PER LEVEL, THEN TAKE THE DIFFERENCE ──────────────────────────────
  // Scored separately because they are separate observations of the same trade under
  // different conditions. Pooling them would average a blind grade with a sighted one and
  // report the mean as though it were a judgement.
  const byId = new Map();
  rows.forEach((t, i) => byId.set((config.caseId || ((x, n) => String(x && x.id || n)))(t, i), t));

  const report = {};
  for (const m of config.models) {
    const perLevel = {};
    const rhoByLevel = {};
    for (const level of levels) {
      const pairs = records
        .filter(r => r.model === m.id && r.level === level)
        .map(r => ({ grade: r.grade, ret: config.returnOf(byId.get(r.caseId)) }));
      const d = discrimination(pairs);
      perLevel[level] = d;
      rhoByLevel[level] = d.rho;                        // null when thin / no spread
    }
    report[m.id] = {
      label: m.label, weights: m.weights,
      byLevel: perLevel,
      premium: hindsightPremium(rhoByLevel),
      tally: tally[m.id]
    };
  }

  return { report, records, levels };
}

module.exports = {
  gradeTrades,
  // The parts, so a consumer can build its own runner without reimplementing the blind.
  LEVELS, GRADES, MIN_N,
  blindCase, buildPrompt, parseGrade,
  spearman, discrimination, hindsightPremium,
  loadRegistry, runGrading
};
