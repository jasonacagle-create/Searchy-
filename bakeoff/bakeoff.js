// bakeoff.js — run one task across several models and say which won, or that none did.
//
// Searchy is the open bake-off platform: a place to compare open-weight models on a task
// with a GROUND TRUTH, away from cell-network's conventions. OCR is the first tenant, and
// it is a good one for an unobvious reason — you know what the page says, so scoring is
// arithmetic rather than opinion. A harness calibrated on a task with real answers can
// later be trusted on tasks with softer ones.
//
// ── THE FAILURES THIS IS BUILT TO AVOID ──────────────────────────────────────
// 1. A MODEL THAT ANSWERS NOTHING IS NOT A MODEL THAT ANSWERS BADLY. Scoring a refusal
//    as 100% error puts it on the same axis as garbage output and hides that it never
//    ran. Refusals are counted separately and never averaged into the error rate.
// 2. NORMALISATION DECIDES RANKINGS. Lowercasing and stripping punctuation can move CER
//    by tens of percent, so the choice is declared, applied to BOTH sides, and reported
//    with the result. A hidden normalisation is a thumb on the scale.
// 3. A MACHINE-WRITTEN REFERENCE MEASURES AGREEMENT, NOT ACCURACY. If the ground truth
//    came from a model, the bake-off ranks models by similarity to that model. Fixtures
//    declare their provenance and a machine-written one is REFUSED, not warned about.
// 4. NO VERDICT ON TOO FEW SAMPLES, and cost and latency sit beside accuracy — a model
//    2% better at 30x the price has not won this job.
'use strict';

const MIN_SAMPLES = 5;

// Declared, not incidental. `raw` is the honest default for OCR (case and punctuation are
// part of what was on the page); the looser modes exist for tasks where they are noise.
const NORMALISERS = {
  raw: (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim(),
  nocase: (s) => NORMALISERS.raw(s).toLowerCase(),
  loose: (s) => NORMALISERS.nocase(s).replace(/[^\w\s]/g, '').replace(/\s+/g, ' ')
};

// Levenshtein with two rows — the full matrix is O(n*m) memory and a textbook page runs to
// thousands of characters.
function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Error rates are DISTANCE / REFERENCE LENGTH, and an empty reference is undefined rather
// than zero — a fixture with nothing to match against cannot grade anything, and a 0.0
// there would read as a perfect score.
function errorRates(hyp, ref, mode) {
  const n = NORMALISERS[mode] || NORMALISERS.raw;
  const h = n(hyp), r = n(ref);
  if (!r.length) return { cer: null, wer: null, reason: 'empty_reference' };
  const cer = levenshtein(h, r) / r.length;
  const hw = h.split(/\s+/).filter(Boolean), rw = r.split(/\s+/).filter(Boolean);
  const wer = rw.length ? levenshtein(hw.join(' '), rw.join(' ')) / rw.length : null;
  return {
    cer: +Math.min(cer, 1).toFixed(4),
    wer: wer == null ? null : +Math.min(wer, 1).toFixed(4),
    reason: null
  };
}

/**
 * One model's result on one fixture.
 * `status`: 'ok' | 'refused' (call succeeded, no usable output) | 'error' (call failed).
 * Only 'ok' rows contribute to accuracy — that separation is §1 above.
 */
function scoreOne(result, fixture, mode) {
  if (!result || result.status !== 'ok') {
    return { status: (result && result.status) || 'error', cer: null, wer: null, fields: null };
  }
  const rates = errorRates(result.text, fixture && fixture.text, mode);
  if (rates.cer == null) return { status: 'unscoreable', cer: null, wer: null, fields: null, reason: rates.reason };
  // Structured fields are exact-match or nothing. A page number is right or wrong, and an
  // edit distance on "12" vs "13" would call that half correct.
  const want = (fixture && fixture.fields) || {};
  const got = result.fields || {};
  const keys = Object.keys(want);
  const hits = keys.filter(k => String(want[k]) === String(got[k])).length;
  return {
    status: 'ok', cer: rates.cer, wer: rates.wer,
    fields: keys.length ? { hits, total: keys.length, rate: +(hits / keys.length).toFixed(3) } : null,
    latencyMs: num(result.latencyMs), costUsd: num(result.costUsd)
  };
}

/**
 * Roll up one model's rows. Accuracy is computed over 'ok' rows ONLY, and the refusal
 * count travels beside it: a model with 2% CER on the third of pages it deigned to read
 * has not beaten one with 6% on all of them, and a single averaged number would say it had.
 */
function summarise(model, rows) {
  const rs = Array.isArray(rows) ? rows : [];
  const ok = rs.filter(r => r && r.status === 'ok');
  const pick = (f) => ok.map(f).filter(v => v != null);
  const cers = pick(r => r.cer);
  const wers = pick(r => r.wer);
  const frs = pick(r => r.fields && r.fields.rate);
  const costs = pick(r => r.costUsd);
  return {
    model,
    n: rs.length,
    scored: ok.length,
    refused: rs.filter(r => r && r.status === 'refused').length,
    errored: rs.filter(r => r && r.status === 'error').length,
    unscoreable: rs.filter(r => r && r.status === 'unscoreable').length,
    cer: cers.length ? +mean(cers).toFixed(4) : null,
    wer: wers.length ? +mean(wers).toFixed(4) : null,
    fieldRate: frs.length ? +mean(frs).toFixed(3) : null,
    // Coverage is not a rounding detail — it is the denominator the accuracy is true of.
    coverage: rs.length ? +(ok.length / rs.length).toFixed(3) : null,
    medianLatencyMs: median(pick(r => r.latencyMs)),
    totalCostUsd: costs.length ? +costs.reduce((a, b) => a + b, 0).toFixed(4) : null
  };
}

/**
 * The verdict. Refuses to crown a winner it cannot support, and names which of the
 * reasons applies rather than returning a bare null.
 */
function compare(summaries, opts) {
  const minN = (opts && opts.minSamples) || MIN_SAMPLES;
  const rows = (summaries || []).filter(s => s && s.cer != null).sort((a, b) => a.cer - b.cer);
  if (!rows.length) {
    return { winner: null, verdict: 'nothing_scored', rows: [],
      reason: 'No model produced a scoreable answer. That is a harness or fixture problem, not a finding about models.' };
  }
  if (rows.every(s => s.scored < minN)) {
    return { winner: null, verdict: 'too_thin', rows,
      reason: `Every model scored fewer than ${minN} page(s). A ranking off this is noise.` };
  }
  const [best, second] = rows;
  const thin = rows.filter(s => s.scored < minN).length;
  if (second && Math.abs(best.cer - second.cer) < 0.01) {
    return { winner: null, verdict: 'tie', rows,
      reason: `${best.model} and ${second.model} are within 1 point of CER. ` +
              'Pick on cost, latency or licence — not accuracy.' };
  }
  return { winner: best.model, verdict: 'winner', rows,
    reason: `${best.model} at CER ${best.cer} over ${best.scored} page(s), coverage ${best.coverage}.` +
            (thin ? ` (${thin} model(s) scored under ${minN} and are ranked with that caveat.)` : '') };
}

/**
 * A fixture whose reference was written by a model measures AGREEMENT WITH THAT MODEL,
 * not accuracy, and the resulting ranking looks entirely normal. Refused rather than
 * warned about: a warning beside a plausible table gets read as a footnote.
 */
function validateFixture(f) {
  if (!f || typeof f !== 'object') return { ok: false, error: 'not_an_object' };
  if (typeof f.text !== 'string' || !f.text.trim()) return { ok: false, error: 'no_reference_text' };
  const src = f.referenceSource;
  if (!src) return { ok: false, error: 'no_reference_source',
    message: 'Declare referenceSource: "human" or the fixture cannot be trusted as ground truth.' };
  if (src !== 'human') return { ok: false, error: 'machine_reference',
    message: `referenceSource "${src}" — a model-written reference ranks models by similarity to it.` };
  return { ok: true };
}

module.exports = {
  MIN_SAMPLES, NORMALISERS, levenshtein, errorRates,
  scoreOne, summarise, compare, median, validateFixture
};
