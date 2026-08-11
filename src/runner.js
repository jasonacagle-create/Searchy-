// runner.js — drive the models over the trades.
//
// ── CONCURRENT ACROSS MODELS, SEQUENTIAL ACROSS TRADES ───────────────────────
// Every model sees the SAME trade at the SAME moment with the SAME prompt, which is what
// makes the comparison fair. Fanning out across TRADES instead would multiply requests
// against one model's rate limit, and a 429 on trade 12 looks exactly like a model that
// refused — a throttle and a refusal must never share an outcome, because one is a fact
// about the provider and the other is a fact about the model.
'use strict';

const { blindCase, buildPrompt, LEVELS } = require('./blind-levels.js');
const { parseGrade } = require('./scorer.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// OpenAI-shaped chat completions, which OpenRouter and most gateways speak. Injectable so
// the package can be tested without a network and pointed at any endpoint.
async function defaultCall({ model, messages, apiKey, baseUrl, timeoutMs }) {
  const r = await fetch((baseUrl || 'https://openrouter.ai/api/v1') + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    // temperature 0 so a re-grade is the same grade. A grader returning a different letter
    // each run is measuring the sampler, not the trade.
    body: JSON.stringify({ model, temperature: 0, max_tokens: 700, messages }),
    signal: AbortSignal.timeout(timeoutMs || 60000)
  });
  if (!r.ok) return { ok: false, error: 'http_' + r.status, body: (await r.text().catch(() => '')).slice(0, 200) };
  const d = await r.json();
  const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  return { ok: true, text: text || '' };
}

/**
 * Grade every trade with every model at every requested level.
 *
 * Yields RECORDS, not opinions: each carries the grade, the level, and `withheld` /
 * `scrubbed` / `shownKeys` so the record proves its own blind. A grade whose record cannot
 * show what was hidden from it is not evidence.
 */
async function runGrading(trades, config, hooks) {
  const {
    models, levels = ['narrative', 'full'], apiKey, baseUrl, timeoutMs,
    throttleMs = 1200, caseId = (t, i) => String(t && t.id || i)
  } = config;

  const call = (hooks && hooks.call) || defaultCall;
  const onRecord = (hooks && hooks.onRecord) || (async () => {});
  const log = (hooks && hooks.log) || (() => {});

  const known = levels.filter(l => Object.prototype.hasOwnProperty.call(LEVELS, l));
  if (!known.length) throw new Error('grading-rig: no known level requested. Known: ' + Object.keys(LEVELS).join(', '));
  // The premium needs BOTH ends. Saying so up front beats a run that completes and then
  // reports `need_both_levels` after spending the money.
  if (!(known.includes('narrative') && known.includes('full')))
    log('NOTE: levels ' + known.join(',') + ' — the hindsight premium needs narrative AND full, ' +
        'so this run will report need_both_levels.');

  const records = [];
  const tally = {};
  for (const m of models) { tally[m.id] = {}; for (const l of known) tally[m.id][l] = { ok: 0, refused: 0 }; }

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const id = caseId(t, i);
    for (const level of known) {
      const { case: blinded, omitted, stripped } = blindCase(t, level, config);
      if (!blinded) { log(`skip ${id} — not a record`); continue; }

      const todo = [];
      for (const m of models) {
        // eslint-disable-next-line no-await-in-loop
        const already = hooks && hooks.has ? await hooks.has(m.id, level, id) : false;
        if (!already) todo.push(m);
      }
      if (!todo.length) continue;

      const results = await Promise.all(todo.map(async (m) => {
        const res = await call({ model: m.id, messages: buildPrompt(blinded, level), apiKey, baseUrl, timeoutMs });
        if (!res.ok) return { m, err: res.error };
        const g = parseGrade(res.text);
        return g.ok ? { m, g } : { m, err: 'unparseable_' + g.error };
      }));

      const marks = [];
      for (const r of results) {
        if (r.err) { tally[r.m.id][level].refused++; marks.push(`${r.m.label}:${r.err}`); continue; }
        const rec = {
          caseId: id, model: r.m.id, label: r.m.label, weights: r.m.weights, level,
          gradedAt: new Date().toISOString(),
          grade: r.g.grade, thesisQuality: r.g.thesisQuality, riskQuality: r.g.riskQuality,
          confidence: r.g.confidence, wouldTakeAgain: r.g.wouldTakeAgain, reasons: r.g.reasons,
          // The blind, provable from the record itself.
          withheld: omitted, scrubbed: stripped, shownKeys: Object.keys(blinded)
        };
        await onRecord(rec);
        records.push(rec);
        tally[r.m.id][level].ok++;
        marks.push(`${r.m.label}:${r.g.grade}`);
      }
      log(`  ${String(id).padEnd(22)} [${level.padEnd(9)}] ${marks.join('  ')}`);
      if (throttleMs) await sleep(throttleMs);
    }
  }
  return { records, tally, levels: known };
}

module.exports = { runGrading, defaultCall };
