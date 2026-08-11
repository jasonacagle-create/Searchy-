// node bakeoff/bakeoff.test.js — zero deps, plain node:assert.
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const B = require('./bakeoff.js');
const OCR = require('./tasks/ocr.js');

const runSrc = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8').replace(/\r\n/g, '\n');

// ── 1 · a REFUSAL is not a wrong answer ────────────────────────────────────
// Scoring "I cannot read this" as 100% error ranks an honest refusal beside a confident
// hallucination — exactly backwards, and it hides that the model never ran.
{
  const fx = { text: 'the cat sat on the mat', fields: { page: 12 }, referenceSource: 'human' };
  const refused = B.scoreOne({ status: 'refused' }, fx, 'raw');
  assert.strictEqual(refused.cer, null, 'a refusal has no error rate, not a maximal one');
  assert.strictEqual(refused.status, 'refused');

  const s = B.summarise('m', [
    { status: 'ok', cer: 0.02, wer: 0.05 },
    { status: 'refused' }, { status: 'refused' }, { status: 'error' }
  ]);
  assert.strictEqual(s.cer, 0.02, 'accuracy is over SCORED rows only');
  assert.strictEqual(s.refused, 2);
  assert.strictEqual(s.errored, 1);
  assert.strictEqual(s.coverage, 0.25, 'and coverage says what that accuracy is true of');
  console.log('  ✓ refusals are counted, never averaged in as failures');
}

// ── 2 · coverage is reported, so a cherry-picking model cannot win quietly ──
// 2% CER on a third of the pages has not beaten 6% on all of them.
{
  const picky = B.summarise('picky', [{ status: 'ok', cer: 0.02 }, { status: 'refused' }, { status: 'refused' }]);
  const solid = B.summarise('solid', [{ status: 'ok', cer: 0.06 }, { status: 'ok', cer: 0.06 }, { status: 'ok', cer: 0.06 }]);
  assert.ok(picky.coverage < solid.coverage);
  assert.match(B.compare([picky, solid], { minSamples: 1 }).reason, /coverage/,
    'the verdict states coverage rather than leaving it in the table');
}

// ── 3 · normalisation is DECLARED, because it decides rankings ─────────────
// The same pair scores 0.4286 raw and 0.0000 loose — a 43-point swing from a choice that
// could easily have been made invisibly.
{
  assert.strictEqual(B.errorRates('The Cat.', 'the cat', 'raw').cer, 0.4286);
  assert.strictEqual(B.errorRates('The Cat.', 'the cat', 'loose').cer, 0);
  assert.strictEqual(OCR.NORMALISE, 'raw',
    'OCR scores raw: case and punctuation are part of what was on the page');
  assert.match(runSrc, /normalise=\$\{task\.NORMALISE\}/,
    'and the mode is printed with every result, not buried in a module');
}

// ── 4 · an empty reference is UNSCOREABLE, never a perfect score ───────────
{
  assert.strictEqual(B.errorRates('anything', '').cer, null);
  assert.strictEqual(B.errorRates('anything', '').reason, 'empty_reference');
  const r = B.scoreOne({ status: 'ok', text: 'x' }, { text: '' }, 'raw');
  assert.strictEqual(r.status, 'unscoreable');
  assert.strictEqual(r.cer, null, 'a fixture with nothing to match cannot grade anything');
}

// ── 5 · A MACHINE-WRITTEN REFERENCE IS REFUSED, not warned about ───────────
// Ground truth from a model ranks models by similarity to that model, and the table looks
// entirely normal. A warning beside a plausible table reads as a footnote.
{
  assert.strictEqual(B.validateFixture({ text: 'x', referenceSource: 'gpt-4.1-mini' }).error, 'machine_reference');
  assert.strictEqual(B.validateFixture({ text: 'x' }).error, 'no_reference_source',
    'an UNDECLARED source is refused too — silence is not a claim of human authorship');
  assert.strictEqual(B.validateFixture({ text: '  ', referenceSource: 'human' }).error, 'no_reference_text');
  assert.strictEqual(B.validateFixture({ text: 'x', referenceSource: 'human' }).ok, true);
  assert.match(runSrc, /FIXTURE REFUSED/, 'and a refused fixture is named, never dropped quietly');
  console.log('  ✓ ground truth must be declared human, or nothing is scored');
}

// ── 6 · no winner the sample cannot support ────────────────────────────────
{
  const thin = [B.summarise('a', [{ status: 'ok', cer: 0.01 }]), B.summarise('b', [{ status: 'ok', cer: 0.30 }])];
  assert.strictEqual(B.compare(thin).verdict, 'too_thin', 'two pages cannot rank two models');

  const rows = (cer) => Array.from({ length: 6 }, () => ({ status: 'ok', cer }));
  const close = B.compare([B.summarise('a', rows(0.050)), B.summarise('b', rows(0.055))]);
  assert.strictEqual(close.verdict, 'tie');
  assert.match(close.reason, /cost, latency or licence/, 'a tie sends the decision somewhere useful');

  const clear = B.compare([B.summarise('a', rows(0.02)), B.summarise('b', rows(0.30))]);
  assert.strictEqual(clear.verdict, 'winner');
  assert.strictEqual(clear.winner, 'a');

  assert.strictEqual(B.compare([]).verdict, 'nothing_scored');
  assert.match(B.compare([]).reason, /harness or fixture problem, not a finding about models/,
    'zero scored rows is a setup failure and must not read as a result about models');
}

// ── 7 · the OCR parser refuses rather than inventing ───────────────────────
{
  assert.strictEqual(OCR.parse('').status, 'refused');
  assert.strictEqual(OCR.parse('sorry, I cannot read this image').status, 'refused');
  assert.strictEqual(OCR.parse('{"text":""}').reason, 'declared_unreadable',
    'the prompt asks for an empty text when unreadable, so that path is expected and named');
  const p = OCR.parse('```json\n{"chapter":"3","page":12,"title":" Cells ","text":"Body."}\n```');
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.fields.chapter, 3, 'a numeric string is coerced');
  assert.strictEqual(p.fields.page, 12);
  assert.strictEqual(p.fields.title, 'Cells');
  // null, never 0 — "no chapter visible" and "chapter zero" are different claims.
  assert.strictEqual(OCR.parse('{"text":"x"}').fields.chapter, null);
  assert.strictEqual(OCR.parse('{"text":"x","page":"n/a"}').fields.page, null);
  console.log('  ✓ the parser refuses, coerces only what is unambiguous, and never guesses');
}

// ── 8 · fields are exact-match, not edit distance ──────────────────────────
// A page number is right or wrong. Edit distance would call 12-vs-13 half correct.
{
  const fx = { text: 'abc', fields: { chapter: 3, page: 12 }, referenceSource: 'human' };
  const r = B.scoreOne({ status: 'ok', text: 'abc', fields: { chapter: 3, page: 13 } }, fx, 'raw');
  assert.strictEqual(r.fields.rate, 0.5);
  assert.strictEqual(r.fields.hits, 1);
}

// ── 9 · the prompt forbids improving the page ─────────────────────────────
// A transcription that reads better than the original is a wrong transcription, and it is
// the failure a fluent model is most likely to produce.
{
  assert.match(OCR.SYSTEM, /Do NOT summarise, correct, complete or tidy/i);
  assert.match(OCR.SYSTEM, /reads\n?\s*better than the page is a wrong transcription/i);
  assert.match(OCR.SYSTEM, /Do not infer it/i, 'and forbids inventing a missing page number');
}

// ── 10 · the incumbent stays in the default line-up ───────────────────────
// A bake-off among open-weight models that never checks what it is replacing cannot say
// whether switching costs anything.
{
  assert.match(runSrc, /openai\/gpt-4\.1-mini/, 'the model being replaced is measured too');
  assert.match(runSrc, /temperature: 0(?![.\d])/, 'a re-run must be the same transcription');
  assert.match(runSrc, /refusing to pretend/, 'no key, no run');
  assert.ok(!/total_cost[^\n]*\|\|\s*[0-9]/.test(runSrc), 'cost is null when unreported, never estimated');
}

console.log('bakeoff.test.js — a harness that refuses to rank is worth more than one that always does');
