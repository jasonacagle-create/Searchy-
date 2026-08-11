// grading-rig — can a language model grade a trade it has not seen the outcome of?
//
// One export: gradeTrades(trades, config) -> { ranked, raw, winner, methodology }
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
// A deterministic grader (a coroner, an attribution model, a rules engine) MEASURES what
// happened. This asks for a JUDGEMENT made from entry-time information only, then measures
// whether that judgement carries information the measurement does not. The experiment has
// a real chance of coming back NO, and either answer is worth having.
//
// It never decides anything. Nothing here opens a position, vetoes one, or feeds a scorer
// that does.
'use strict';

const { LEVELS, blindCase, buildPrompt, assertBlindable } = require('./blind-levels.js');
const { GRADES, GRADE_NUM, MIN_N, parseGrade, spearman, discrimination, hindsightPremium } = require('./scorer.js');
const { loadRegistry } = require('./registry.js');
const { runGrading } = require('./runner.js');
const { num } = require('./util.js');

// ── `blinding` ACCEPTS A STRING, AND DEFAULTS TO BOTH ENDS ANYWAY ────────────
// The proposed signature was `blinding = 'narrative'` — one level, defaulting to the blind
// one. A string is accepted here because that call should work, but the DEFAULT is both
// ends, and the reason is the defect this package was extracted to fix:
//
//   the premium is `full − narrative`. A run that grades one end can never produce it.
//
// In the engine this came from, the runner asked for one level and the premium function
// was called from nowhere for days: the library could measure the leak and nothing asked
// it to. A singular `blinding` default reproduces that at the API surface — every "is the
// level being passed?" check would pass, and the headline number would still never exist.
// A single-level run is legitimate and stays available; it just has to be asked for, and
// the methodology block says what it cost.
const DEFAULT_LEVELS = Object.freeze(['narrative', 'full']);

function resolveLevels(blinding) {
  const raw = blinding == null ? DEFAULT_LEVELS : (Array.isArray(blinding) ? blinding : [blinding]);
  const known = raw.filter(l => Object.prototype.hasOwnProperty.call(LEVELS, l));
  if (!known.length)
    throw new Error('grading-rig: blinding names no known level. Known: ' + Object.keys(LEVELS).join(', '));
  return known;
}

// ── THE TIE BAND IS THE SAMPLING NOISE, NOT A ROUND NUMBER ───────────────────
// The harness beside this one refuses a winner "within 1 point of CER" — a declared
// margin, which is honest but arbitrary. A rank correlation carries its own scale: the
// standard error of Spearman's rho is ~1/sqrt(n-1). Two models closer than that are not
// separated BY THIS SAMPLE, and saying so is arithmetic rather than a threshold anybody
// chose. It also tightens automatically as the corpus grows, which a fixed margin cannot.
const tieBand = (n) => (n > 1 ? 1 / Math.sqrt(n - 1) : Infinity);

/**
 * Rank the models and refuse to crown one the sample cannot support.
 *
 * RANKED ON THE **BLIND** RHO, DELIBERATELY. The narrative grade is the product; a model
 * that ranks outcomes brilliantly once shown the P&L has demonstrated subtraction. Ranking
 * on the sighted number would reward exactly the behaviour the blind exists to detect.
 */
function rankModels(rows, primaryLevel) {
  const scored = rows
    .map(r => ({ model: r.model, label: r.label, weights: r.weights,
                 rho: r.byLevel[primaryLevel] ? r.byLevel[primaryLevel].rho : null,
                 n: r.byLevel[primaryLevel] ? r.byLevel[primaryLevel].n : 0,
                 verdict: r.byLevel[primaryLevel] ? r.byLevel[primaryLevel].verdict : 'not_run',
                 premium: r.premium.premium }))
    .sort((a, b) => (b.rho == null ? -Infinity : b.rho) - (a.rho == null ? -Infinity : a.rho));

  const rankable = scored.filter(s => s.rho != null);
  let winner = null;
  if (!rankable.length) {
    winner = { model: null, reason: 'no_rankable_model',
      detail: 'no model produced a usable correlation at ' + primaryLevel +
              ' — thin sample, or every grade was the same letter. Both are findings, neither is a ranking.' };
  } else if (rankable[0].n < MIN_N) {
    winner = { model: null, reason: 'too_thin',
      detail: `${rankable[0].n} scored row(s); ${MIN_N} needed before a leaderboard means anything.` };
  } else if (rankable.length > 1 && (rankable[0].rho - rankable[1].rho) < tieBand(rankable[0].n)) {
    winner = { model: null, reason: 'tie',
      detail: `${rankable[0].label} and ${rankable[1].label} differ by ` +
              `${(rankable[0].rho - rankable[1].rho).toFixed(4)}, inside this sample's noise of ` +
              `${tieBand(rankable[0].n).toFixed(4)} (1/sqrt(n-1)). Decide on cost, latency or licence.` };
  } else {
    winner = { model: rankable[0].model, label: rankable[0].label, rho: rankable[0].rho,
      reason: 'clear', detail: `leads by ${(rankable[0].rho - (rankable[1] ? rankable[1].rho : 0)).toFixed(4)} ` +
              `against a noise floor of ${tieBand(rankable[0].n).toFixed(4)}.` };
  }
  return { ranked: scored, winner };
}

/**
 * Agreement with a deterministic grader, when one exists.
 *
 * THE ATTRIBUTION IS NOT A LETTER, AND THIS REFUSES TO PRETEND IT IS. A coroner emits a
 * CLASS — thesis-wrong, market-beta, regime-shift, earned-alpha — not an A–F grade. There
 * is no arithmetic that turns one into the other, so:
 *
 *   coronerOrder GIVEN    -> a real rank correlation, against the ordering YOU declared
 *   coronerOrder ABSENT   -> the crosstab only. Mean grade per class, with n.
 *
 * The crosstab still answers the useful question (do thesis-wrong trades grade lower?)
 * without inventing an equivalence. A single agreement percentage would require an
 * ordering, and manufacturing one here would bury an assumption inside a number.
 */
function coronerAgreement(records, byId, coronerField, coronerOrder) {
  const rows = records
    .map(r => ({ grade: r.grade, klass: (byId.get(r.caseId) || {})[coronerField] }))
    .filter(r => GRADES.includes(r.grade) && r.klass != null && r.klass !== '');
  if (!rows.length) return { n: 0, byClass: {}, rho: null, reason: 'no_rows_carry_' + coronerField };

  const byClass = {};
  for (const r of rows) {
    const k = String(r.klass);
    (byClass[k] = byClass[k] || { n: 0, sum: 0, grades: {} });
    byClass[k].n++;
    byClass[k].sum += GRADE_NUM[r.grade];
    byClass[k].grades[r.grade] = (byClass[k].grades[r.grade] || 0) + 1;
  }
  for (const k of Object.keys(byClass)) byClass[k].meanGrade = +(byClass[k].sum / byClass[k].n).toFixed(2);

  if (!Array.isArray(coronerOrder) || !coronerOrder.length)
    return { n: rows.length, byClass, rho: null,
      reason: 'no_ordering_declared — a single agreement number needs coronerOrder (best to worst). ' +
              'The per-class means above are the honest form without one.' };

  const pos = new Map(coronerOrder.map((k, i) => [String(k), coronerOrder.length - i]));
  const pairs = rows.filter(r => pos.has(String(r.klass)))
                    .map(r => ({ grade: r.grade, ret: pos.get(String(r.klass)) }));
  const sp = spearman(pairs);
  return { n: pairs.length, byClass, rho: sp.rho, reason: sp.reason,
           assumes: 'coronerOrder treats ' + coronerOrder.join(' > ') + ' as best-to-worst. ' +
                    'That ordering is a claim about your attributions, declared by you, not derived here.' };
}

/**
 * @param {Array<object>} trades
 * @param {object} config
 *   visibleKeys  string[]  REQUIRED — entry-time allowlist. Never a denylist.
 *   outcomeKeys  string[]  REQUIRED — everything that reveals what happened, incl. DURATION.
 *   nestedKeys   object    optional inner allowlists for object-valued fields.
 *   models       array     from loadRegistry().
 *   blinding     string|string[]  default ['narrative','full'] — both ends of the premium.
 *   returnOf     fn        (trade) => realised return. The LABEL: reaches the scorer, never the prompt.
 *   coronerField string    optional field holding a deterministic verdict to compare against.
 *   coronerOrder string[]  optional best-to-worst ordering of those verdicts.
 *   apiKey/baseUrl/timeoutMs/throttleMs/caseId
 * @param {object} hooks  { call, onRecord, has, log } — injectable, so this runs against a
 *                        fake in tests and a real gateway in production.
 */
async function gradeTrades(trades, config = {}, hooks) {
  // Fail before spending anything. A blind that cannot be enforced makes every grade in
  // the run worthless, and finding that out after the API bill is the wrong order.
  assertBlindable(config);
  if (!Array.isArray(config.models) || !config.models.length)
    throw new Error('grading-rig: config.models is empty — nothing to run');
  if (typeof config.returnOf !== 'function')
    throw new Error('grading-rig: config.returnOf(trade) is required — without the realised return the ' +
                    'grades can be collected but never scored, which is a corpus, not an experiment');

  const levels = resolveLevels(config.blinding);
  const rows = Array.isArray(trades) ? trades.filter(Boolean) : [];
  const idOf = config.caseId || ((x, n) => String((x && x.id) || n));

  const { records, tally } = await runGrading(rows, Object.assign({}, config, { levels }), hooks);

  const byId = new Map();
  rows.forEach((t, i) => byId.set(idOf(t, i), t));

  // Scored PER LEVEL. They are separate observations of the same trade under different
  // conditions; pooling them would average a blind grade with a sighted one and report the
  // mean as though it were a judgement.
  const raw = config.models.map(m => {
    const byLevel = {}, rhoByLevel = {};
    for (const level of levels) {
      const pairs = records.filter(r => r.model === m.id && r.level === level)
                           .map(r => ({ grade: r.grade, ret: num(config.returnOf(byId.get(r.caseId))) }));
      const d = discrimination(pairs);
      byLevel[level] = d;
      rhoByLevel[level] = d.rho;
    }
    const out = { model: m.id, label: m.label, weights: m.weights, byLevel,
                  premium: hindsightPremium(rhoByLevel), tally: tally[m.id] };
    if (config.coronerField)
      out.coroner = coronerAgreement(records.filter(r => r.model === m.id && r.level === levels[0]),
                                     byId, config.coronerField, config.coronerOrder);
    return out;
  });

  // The blind level is the primary metric when it was run; otherwise whatever was.
  const primary = levels.includes('narrative') ? 'narrative' : levels[0];
  const { ranked, winner } = rankModels(raw, primary);

  // ── METHODOLOGY TRAVELS WITH THE RESULT ────────────────────────────────────
  // Not decoration. A rho means nothing without the level it was measured at, the n behind
  // it, and what the model was allowed to see — and a reader who has to go looking for
  // those will quote the number without them.
  const methodology = {
    levels,
    primaryLevel: primary,
    rankedOn: `spearman(grade, realised return) at ${primary}`,
    tieBand: 'one standard error of rho, 1/sqrt(n-1) — the sample\'s own noise, not a chosen margin',
    minN: MIN_N,
    tradesOffered: rows.length,
    visibleKeys: config.visibleKeys.slice(),
    outcomeKeys: config.outcomeKeys.slice(),
    premiumComputable: levels.includes('narrative') && levels.includes('full'),
    note: levels.includes('narrative') && levels.includes('full')
      ? 'premium = rho(full) − rho(narrative); positive means the outcome is doing work the judgement could not'
      : `only [${levels.join(', ')}] was graded, so the hindsight premium cannot be computed. ` +
        'It needs both narrative and full; this run can say whether the grades predict, not how much of that is hindsight.',
    coroner: config.coronerField
      ? `compared against "${config.coronerField}"` + (config.coronerOrder ? ', ordering declared by the caller' : ', crosstab only — no ordering declared')
      : null
  };

  return { ranked, raw, winner, methodology, records, levels };
}

module.exports = {
  gradeTrades,
  // The parts, so a consumer can build its own runner without reimplementing the blind.
  LEVELS, GRADES, MIN_N, DEFAULT_LEVELS,
  blindCase, buildPrompt, parseGrade,
  spearman, discrimination, hindsightPremium,
  loadRegistry, runGrading, tieBand
};
