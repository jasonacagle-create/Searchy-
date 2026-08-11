// run.js — run a task across several models and print the table.
//
//   node bakeoff/run.js --task ocr --dry                  validate fixtures, call nothing
//   node bakeoff/run.js --task ocr --models a,b,c         run the bake-off
//
// OPENROUTER_KEY is required for a real run and the runner refuses without it rather than
// pretending. Fixtures live in fixtures/<task>/ as JSON, one per case.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const B = require('./bakeoff.js');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.indexOf(n) !== -1;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TASK_NAME = arg('--task', 'ocr');
const KEY = process.env.OPENROUTER_KEY || '';
// The incumbent is in the default list on purpose: a bake-off among open-weight models
// that never checks what it is replacing cannot say whether switching costs anything.
const MODELS = (arg('--models', process.env.BAKEOFF_MODELS ||
  'qwen/qwen2.5-vl-72b-instruct,meta-llama/llama-3.2-90b-vision-instruct,openai/gpt-4.1-mini')
).split(',').map(s => s.trim()).filter(Boolean);

function loadTask(name) {
  const p = path.join(__dirname, 'tasks', name + '.js');
  if (!fs.existsSync(p)) { console.error(`no such task: ${name} (looked in ${p})`); process.exit(2); }
  return require(p);
}

function loadFixtures(name) {
  const dir = path.join(__dirname, '..', 'fixtures', name);
  if (!fs.existsSync(dir)) return { ok: [], bad: [{ file: dir, error: 'no_fixture_dir' }] };
  const ok = [], bad = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { bad.push({ file: f, error: 'bad_json' }); continue; }
    const v = B.validateFixture(d);
    // A REFUSED FIXTURE IS NOT SKIPPED QUIETLY. A bake-off that silently drops half its
    // ground truth still prints a confident table.
    if (!v.ok) { bad.push({ file: f, error: v.error, message: v.message }); continue; }
    ok.push(Object.assign({ file: f }, d));
  }
  return { ok, bad };
}

async function callModel(model, messages) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      // temperature 0: a re-run must be the same transcription, or the bake-off is
      // measuring the sampler.
      body: JSON.stringify({ model, temperature: 0, max_tokens: 4000, messages }),
      signal: AbortSignal.timeout(120000)
    });
    const latencyMs = Date.now() - t0;
    if (!r.ok) return { status: 'error', latencyMs, error: 'http_' + r.status };
    const d = await r.json();
    const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    // OpenRouter reports usage; cost is part of the verdict, so it is carried when given
    // and left null when not — never estimated.
    const costUsd = d && d.usage && typeof d.usage.total_cost === 'number' ? d.usage.total_cost : null;
    return { status: 'raw', raw: text || '', latencyMs, costUsd };
  } catch (e) {
    return { status: 'error', latencyMs: Date.now() - t0, error: (e && e.name) || 'threw' };
  }
}

function printTable(summaries, verdict, task, fixtures) {
  const pad = (s, n) => String(s).padEnd(n);
  const w = Math.max(12, ...summaries.map(s => s.model.length));
  console.log('');
  console.log(`BAKE-OFF · task=${task.NAME} · normalise=${task.NORMALISE} · fixtures=${fixtures}`);
  console.log('');
  console.log('  ' + pad('model', w) + '  scored  refused  errored     CER     WER  fields  cover   ms   cost');
  console.log('  ' + '-'.repeat(w + 66));
  for (const s of summaries) {
    console.log('  ' + pad(s.model, w) +
      String(s.scored).padStart(8) + String(s.refused).padStart(9) + String(s.errored).padStart(9) +
      String(s.cer == null ? '—' : s.cer.toFixed(4)).padStart(8) +
      String(s.wer == null ? '—' : s.wer.toFixed(4)).padStart(8) +
      String(s.fieldRate == null ? '—' : s.fieldRate.toFixed(2)).padStart(8) +
      String(s.coverage == null ? '—' : s.coverage.toFixed(2)).padStart(7) +
      String(s.medianLatencyMs == null ? '—' : s.medianLatencyMs).padStart(6) +
      String(s.totalCostUsd == null ? '  —' : '$' + s.totalCostUsd.toFixed(4)).padStart(8));
  }
  console.log('');
  console.log('  VERDICT: ' + verdict.verdict.toUpperCase());
  console.log('  ' + verdict.reason);
  console.log('');
  console.log('  CER/WER are computed over SCORED rows only. `cover` is the fraction of');
  console.log('  fixtures a model actually answered — read it before the error rate.');
  console.log('');
}

async function main() {
  const task = loadTask(TASK_NAME);
  const { ok: fixtures, bad } = loadFixtures(TASK_NAME);

  for (const b of bad) console.error(`  FIXTURE REFUSED  ${b.file}: ${b.error}${b.message ? ' — ' + b.message : ''}`);
  if (!fixtures.length) {
    console.error(`\nNo usable fixtures for task "${TASK_NAME}". A bake-off with no ground truth ` +
                  'cannot rank anything — this is a setup failure, not a result.\n');
    process.exit(1);
  }
  console.log(`${fixtures.length} fixture(s) accepted${bad.length ? `, ${bad.length} refused` : ''}`);

  if (has('--dry')) {
    const f = fixtures[0];
    console.log(`\nTASK: ${task.NAME}   normalise: ${task.NORMALISE}\nMODELS: ${MODELS.join(', ')}`);
    console.log(`\nFIXTURE ${f.file}: reference ${f.text.length} chars, source "${f.referenceSource}"`);
    console.log(`fields: ${JSON.stringify(f.fields || {})}`);
    console.log(`\nSYSTEM PROMPT:\n${task.SYSTEM}\n`);
    console.log('No model was called. Add --models and OPENROUTER_KEY for a real run.\n');
    return;
  }
  if (!KEY) { console.error('OPENROUTER_KEY not set — refusing to pretend'); process.exit(1); }

  const summaries = [];
  for (const model of MODELS) {
    const rows = [];
    for (const f of fixtures) {
      if (!f.imageDataUrl) { rows.push({ status: 'error', reason: 'fixture_has_no_image' }); continue; }
      const res = await callModel(model, task.buildMessages(f));
      if (res.status !== 'raw') { rows.push({ status: 'error' }); await sleep(700); continue; }
      const p = task.parse(res.raw);
      rows.push(B.scoreOne(
        p.status === 'ok'
          ? { status: 'ok', text: p.text, fields: p.fields, latencyMs: res.latencyMs, costUsd: res.costUsd }
          : { status: 'refused' },
        f, task.NORMALISE));
      await sleep(700);
    }
    const s = B.summarise(model, rows);
    summaries.push(s);
    console.log(`  ${model}: scored ${s.scored}/${s.n}, CER ${s.cer == null ? '—' : s.cer}`);
  }

  printTable(summaries.sort((a, b) => (a.cer == null) - (b.cer == null) || a.cer - b.cer),
    B.compare(summaries), task, fixtures.length);
}

main().catch(e => { console.error('bakeoff failed:', e && e.message); process.exit(1); });
