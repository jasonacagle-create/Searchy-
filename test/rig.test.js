// rig.test.js — the blind is the experiment, so most of this file is about the blind.
//
// Everything runs against an INJECTED model caller. No network, no keys, no market. A rig
// whose tests need a live gateway gets run once and never again.
'use strict';

const assert = require('node:assert');
const RIG = require('../src/index.js');
const { loadRegistry } = require('../src/registry.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const T = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

// A realistic closed trade: entry-time fields, outcome fields, and a nested object with an
// outcome smuggled inside it — which is how the leak actually happens in practice.
const TRADE = {
  id: 'ZZ_FIXTURE_1', ticker: 'ZZ_FIXTURE', side: 'long', tier: 'swing',
  entry: 100, stopLoss: 92, target: 120, atrPct: 2.4, positionSize: 30,
  thesis: 'basing above the 50dma', conviction: 0.6,
  feat: { atr_pct: 2.4, px_vs_ema8_pct: 1.1, exit_reason: 'target' },   // <- smuggled
  read: { score: 71, flags: ['basing'], realizedPnl: 213 },             // <- smuggled
  // NO nested allowlist is declared for `context`, so the ALLOWLIST passes it through
  // whole and only the DEEP SCRUB stands between its outcome field and the model. This is
  // the scrub's entire reason to exist; without a case like it the second layer is
  // untested and can be deleted as redundant. Mutation M2 found exactly that.
  context: { regime: 'risk-on', exitReason: 'target', notes: { profit: 540 } },
  // outcomes
  exitPrice: 118, exitReason: 'target', profit: 540, percentGain: 0.18,
  durationMinutes: 3840, entryTime: '2026-08-01T14:00:00Z', exitTime: '2026-08-04T14:00:00Z'
};

const CONFIG = {
  visibleKeys: ['ticker', 'side', 'tier', 'entry', 'stopLoss', 'target', 'atrPct',
                'positionSize', 'thesis', 'conviction', 'feat', 'read', 'context'],
  outcomeKeys: ['exitPrice', 'exitReason', 'profit', 'percentGain', 'durationMinutes',
                'exitTime', 'realizedPnl', 'realized_pnl'],
  nestedKeys: { feat: ['atr_pct', 'px_vs_ema8_pct'], read: ['score', 'flags'] },
  returnOf: (x) => (x && typeof x.percentGain === 'number' ? x.percentGain * 100 : null)
};

console.log('\ngrading-rig');

// ── 1 · THE BLIND ────────────────────────────────────────────────────────────
t('narrative shows no outcome field, at any depth', () => {
  const { case: c, stripped } = RIG.blindCase(TRADE, 'narrative', CONFIG);
  const flat = JSON.stringify(c);
  for (const k of ['exitPrice', 'exitReason', 'profit', 'percentGain', 'durationMinutes', 'exitTime'])
    assert.ok(!(k in c), 'top-level leak: ' + k);
  assert.ok(!/realizedPnl/.test(flat), 'nested realizedPnl reached the model');
  assert.ok(!/exit_reason/.test(flat), 'snake_case outcome reached the model');
  assert.ok(stripped.length >= 2, 'the record must NAME what it stripped, or it is not evidence');
});

// The layers are NOT equivalent and only one of them is the guard. `context` has no
// declared inner shape, so the allowlist forwards it entire and the scrub is the only
// thing that removes its outcome fields — at every depth, including nested objects.
t('the deep scrub catches outcomes inside an object with no declared shape', () => {
  const { case: c, stripped } = RIG.blindCase(TRADE, 'narrative', CONFIG);
  assert.ok(c.context, 'the object itself is allowed through — that is the allowlist working');
  assert.strictEqual(c.context.regime, 'risk-on', 'and its non-outcome fields survive');
  assert.ok(!('exitReason' in c.context), 'the scrub must remove an outcome one level down');
  assert.ok(!/540/.test(JSON.stringify(c.context)), 'and two levels down');
  assert.ok(stripped.some(x => x.startsWith('context.')), 'and must NAME what it removed');
});

t('the inner allowlist is what holds — the scrub alone would leak', () => {
  // realizedPnl IS in outcomeKeys here, so the scrub catches it. Remove it from the
  // outcome list and only the nested allowlist stands between it and the model.
  const loose = Object.assign({}, CONFIG, { outcomeKeys: CONFIG.outcomeKeys.filter(k => !/realized/i.test(k)) });
  const { case: c } = RIG.blindCase(TRADE, 'narrative', loose);
  assert.ok(!/realizedPnl/.test(JSON.stringify(c)),
    'the nested allowlist must refuse unknown names by default — a denylist can only catch what it was told');
});

t('mechanics and full reveal EXACTLY what they declare, and nothing more', () => {
  const mech = RIG.blindCase(TRADE, 'mechanics', CONFIG).case;
  assert.strictEqual(mech.exitPrice, 118);
  assert.ok(!('profit' in mech) && !('percentGain' in mech), 'mechanics must not carry P&L');

  const full = RIG.blindCase(TRADE, 'full', CONFIG).case;
  for (const k of RIG.LEVELS.full) assert.ok(k in full, 'full must carry ' + k);
});

t('an unknown level falls back to narrative rather than revealing everything', () => {
  const c = RIG.blindCase(TRADE, 'FULL!!', CONFIG).case;
  assert.ok(!('exitPrice' in c), 'a typo in the level must fail CLOSED');
});

// ── 2 · THE REFUSAL THAT MATTERS MOST ────────────────────────────────────────
// A caller who declares no outcomes would otherwise get a blind that enforces nothing:
// green run, full corpus, no experiment. It must refuse.
t('refuses to run without a declared outcome set', () => {
  assert.throws(() => RIG.blindCase(TRADE, 'narrative', { visibleKeys: ['ticker'] }),
    /outcomeKeys/, 'an undeclared outcome set must refuse, never default to permissive');
  assert.throws(() => RIG.blindCase(TRADE, 'narrative', { outcomeKeys: ['profit'] }), /visibleKeys/);
});

t('refuses a key declared both visible and outcome', () => {
  assert.throws(() => RIG.blindCase(TRADE, 'narrative',
    { visibleKeys: ['ticker', 'profit'], outcomeKeys: ['profit'] }), /BOTH visible and outcome/);
});

t('the overlap check normalises, so exit_price and exitPrice are one name', () => {
  assert.throws(() => RIG.blindCase(TRADE, 'narrative',
    { visibleKeys: ['exit_price'], outcomeKeys: ['exitPrice'] }), /BOTH visible and outcome/);
});

// ── 3 · THE PROMPT MUST BE TRUE FOR ITS LEVEL ────────────────────────────────
t('the system prompt stops claiming the outcome is hidden once it is shown', () => {
  const sys = (lvl) => RIG.buildPrompt({}, lvl)[0].content;
  assert.match(sys('narrative'), /deliberately withheld/);
  assert.doesNotMatch(sys('mechanics'), /deliberately withheld/,
    'a revealing level must not assert the outcome was withheld');
  assert.doesNotMatch(sys('full'), /deliberately withheld/);
  assert.match(sys('full'), /You ARE shown part of the outcome/);
  // Identical task at every level, or the premium measures the prompt instead of hindsight.
  for (const l of ['narrative', 'mechanics', 'full'])
    assert.match(sys(l), /grade the DECISION/i, l + ' must still ask for the decision');
});

// ── 4 · UNKNOWN IS NEVER ZERO ────────────────────────────────────────────────
t('an unrankable state never shares a value with a rankable one', () => {
  assert.strictEqual(RIG.spearman([{ grade: 'A', ret: 1 }]).rho, null);        // too few
  assert.strictEqual(RIG.spearman([{ grade: 'A', ret: 1 }]).reason, 'too_few');
  const flat = Array.from({ length: 25 }, (_, i) => ({ grade: 'B', ret: i }));  // no variance
  assert.strictEqual(RIG.spearman(flat).rho, null);
  assert.strictEqual(RIG.spearman(flat).reason, 'no_variance');
  assert.strictEqual(RIG.discrimination(flat).verdict, 'no_spread');
});

t('an off-schema grade is refused, not coerced to F', () => {
  assert.strictEqual(RIG.parseGrade('{"grade":"B+"}').ok, false);
  assert.strictEqual(RIG.parseGrade('{"grade":"B+"}').error, 'bad_grade');
  assert.strictEqual(RIG.parseGrade('no json here').error, 'no_json');
  // and a valid one keeps missing sub-scores as null, not a middling 3
  const g = RIG.parseGrade('prose {"grade":"a"} more');
  assert.strictEqual(g.grade, 'A');
  assert.strictEqual(g.thesisQuality, null);
});

t('the premium is null with a reason when either end is missing', () => {
  assert.strictEqual(RIG.hindsightPremium({ narrative: 0.1 }).premium, null);
  assert.strictEqual(RIG.hindsightPremium({ narrative: 0.1 }).reason, 'need_both_levels');
  assert.strictEqual(RIG.hindsightPremium({ narrative: 0.10, full: 0.62 }).premium, 0.52);
});

t('rank correlation is not moved by one whale', () => {
  const base = Array.from({ length: 24 }, (_, i) => ({ grade: 'ABCDF'[i % 5], ret: (5 - (i % 5)) * 2 }));
  const a = RIG.spearman(base).rho;
  const whale = base.map(r => (r.grade === 'F' ? { grade: 'F', ret: 5000 } : r));
  const b = RIG.spearman(whale).rho;
  assert.ok(b < a, 'a whale in the worst bucket must move rho, but not invert the metric');
  assert.ok(Math.abs(b) <= 1 && Math.abs(a) <= 1);
});

// ── 5 · THE REGISTRY ─────────────────────────────────────────────────────────
t('a model without weights or licence is refused; a missing control only warns', () => {
  const bad = loadRegistry({ models: [{ id: 'x', weights: 'open' }] });
  assert.ok(bad.problems.some(p => /licence/.test(p)));
  const openOnly = loadRegistry({ models: [{ id: 'a', weights: 'open', licence: 'MIT' },
                                           { id: 'b', weights: 'open', licence: 'MIT' }] });
  assert.strictEqual(openOnly.problems.length, 0, 'open-only is legitimate and must still run');
  assert.ok(openOnly.warnings.some(w => /CLOSED-WEIGHT CONTROL/.test(w)), 'but it must say so loudly');
});

// ── 6 · END TO END, against a fake model ─────────────────────────────────────
(async () => {
  await T('grades both levels, scores each, and returns a premium', async () => {
    const seen = [];
    const models = [{ id: 'fake/one', label: 'Fake', weights: 'open', licence: 'MIT', enabled: true }];
    // The fake reads what it was SHOWN: blind at narrative it guesses from the stop
    // distance; at full it can see percentGain and grades the result. That is precisely the
    // hindsight the premium is supposed to detect, so the premium must come out positive.
    const call = async ({ messages }) => {
      const body = messages[1].content;
      seen.push(body);
      const shown = JSON.parse(body.slice(body.indexOf('{')));
      const grade = shown.percentGain != null
        ? (shown.percentGain > 0 ? 'A' : 'F')
        : 'ABCDF'[Math.abs(String(shown.ticker).length + (shown.entry || 0)) % 5];
      return { ok: true, text: JSON.stringify({ grade, confidence: 0.5 }) };
    };

    const trades = Array.from({ length: 24 }, (_, i) => Object.assign({}, TRADE, {
      id: 'T' + i, ticker: 'ZZ' + i, entry: 100 + i,
      percentGain: (i % 2 ? 1 : -1) * (0.05 + i / 100)
    }));

    const out = await RIG.gradeTrades(trades, Object.assign({}, CONFIG, {
      models, blinding: ['narrative', 'full'], throttleMs: 0, caseId: (x) => x.id
    }), { call });

    const r = out.raw.find(x => x.model === 'fake/one');
    assert.ok(r.byLevel.narrative && r.byLevel.full, 'both levels must be scored separately');
    assert.strictEqual(r.tally.narrative.ok, 24);
    assert.strictEqual(r.tally.full.ok, 24);
    assert.ok(r.premium.premium > 0.2,
      'a model that grades the outcome when shown it must register a large hindsight premium, got ' + r.premium.premium);

    // and the blind held for every narrative prompt actually sent
    const narrativePrompts = seen.filter(s => !/percentGain/.test(s));
    assert.ok(narrativePrompts.length >= 24, 'at least the narrative half must be outcome-free');
    for (const p of narrativePrompts)
      assert.ok(!/exitPrice|realizedPnl|exit_reason|durationMinutes/.test(p), 'a sent prompt leaked an outcome');
  });

  await T('refuses before spending anything when the config cannot enforce a blind', async () => {
    let called = 0;
    await assert.rejects(
      () => RIG.gradeTrades([TRADE], { visibleKeys: ['ticker'], models: [{ id: 'x' }], returnOf: () => 1 },
        { call: async () => { called++; return { ok: true, text: '{"grade":"A"}' }; } }),
      /outcomeKeys/);
    assert.strictEqual(called, 0, 'it must refuse BEFORE the first API call, not after the bill');
  });

  await T('the bakeoff task adapter conforms, and its prompt is genuinely blinded', async () => {
    const TASK = require('../bakeoff/tasks/trade-grading.js');
    for (const k of ['NAME', 'SYSTEM', 'NORMALISE', 'buildMessages', 'parse'])
      assert.ok(TASK[k] !== undefined, 'task interface is missing ' + k);

    const fixture = { trade: TRADE, level: 'narrative', blind: CONFIG };
    const msgs = TASK.buildMessages(fixture);
    const sent = JSON.stringify(msgs);
    for (const leak of ['exitPrice', 'realizedPnl', 'exit_reason', 'durationMinutes', '"profit"'])
      assert.ok(!sent.includes(leak), 'the task adapter leaked ' + leak + ' into the prompt');

    // The harness prints ONE SYSTEM per task; this task's varies, so systemFor must exist
    // and must actually differ, or --dry would show a sentence true of a third of the run.
    assert.notStrictEqual(TASK.systemFor('narrative'), TASK.systemFor('full'),
      'a single system prompt across levels is the defect this rig exists to avoid');
    assert.strictEqual(TASK.systemFor('narrative'), TASK.SYSTEM, 'SYSTEM must be the narrative default');

    // Refusal discipline matches the harness's: refused is a status, not a bad score.
    assert.strictEqual(TASK.parse('{"grade":"B+"}').status, 'refused');
    assert.strictEqual(TASK.parse('nonsense').status, 'refused');
    const ok = TASK.parse('{"grade":"C","confidence":0.4}');
    assert.strictEqual(ok.status, 'ok');
    assert.strictEqual(ok.text, 'C');
    assert.strictEqual(ok.fields.thesisQuality, null, 'an absent sub-score is not a 3');

    // And it refuses a fixture with no blind config, rather than prompting unblinded.
    // With NO blind config the allowlist check fires first — either refusal is correct, and
    // the property is that it refuses rather than prompting a model with a raw trade.
    assert.throws(() => TASK.buildMessages({ trade: TRADE, level: 'full' }), /visibleKeys|outcomeKeys/);
    // With a visible list but no outcome list it must still refuse, which is the case that
    // would otherwise produce a confident, fully unblinded run.
    assert.throws(() => TASK.buildMessages({ trade: TRADE, level: 'full', blind: { visibleKeys: ['ticker'] } }),
      /outcomeKeys/);
  });

  // ── 7 · THE SIGNATURE'S SHARP EDGES ────────────────────────────────────────
  const fakeModels = [{ id: 'm/a', label: 'A', weights: 'open', licence: 'MIT' },
                      { id: 'm/b', label: 'B', weights: 'closed', licence: 'prop' }];
  const corpus = Array.from({ length: 30 }, (_, i) => Object.assign({}, TRADE, {
    id: 'C' + i, ticker: 'ZZ' + i, entry: 100 + i,
    percentGain: (i % 2 ? 1 : -1) * (0.02 + i / 200),
    coronerVerdict: i % 3 === 0 ? 'thesis-wrong' : (i % 3 === 1 ? 'market-beta' : 'earned-alpha')
  }));
  const base = Object.assign({}, CONFIG, { models: fakeModels, throttleMs: 0, caseId: x => x.id });
  // A grader that genuinely ranks: better entries (lower entry price here) get better grades.
  const skilful = async ({ messages }) => {
    const shown = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
    const g = shown.percentGain != null ? (shown.percentGain > 0 ? 'A' : 'F')
                                        : 'ABCDF'[Math.min(4, Math.floor((shown.entry - 100) / 6))];
    return { ok: true, text: JSON.stringify({ grade: g }) };
  };

  await T('a single blinding level runs, and SAYS the premium is uncomputable', async () => {
    const out = await RIG.gradeTrades(corpus, Object.assign({}, base, { blinding: 'narrative' }), { call: skilful });
    assert.deepStrictEqual(out.levels, ['narrative'], 'a string blinding must be accepted');
    assert.strictEqual(out.methodology.premiumComputable, false);
    assert.match(out.methodology.note, /needs both narrative and full/,
      'a one-level run must state what it cannot answer, not stay quiet about it');
    assert.strictEqual(out.raw[0].premium.premium, null, 'and the premium must be null, never 0');
  });

  await T('the DEFAULT grades both ends, so the premium exists without being asked for', async () => {
    const out = await RIG.gradeTrades(corpus.slice(0, 6), base, { call: skilful });
    assert.deepStrictEqual(out.levels, ['narrative', 'full'],
      'defaulting to one level would reproduce the exact defect this package was extracted to fix');
    assert.strictEqual(out.methodology.premiumComputable, true);
  });

  await T('refuses to crown a winner the sample cannot support', async () => {
    // A THIN corpus with REAL grade spread. The first version of this used six trades whose
    // entries were six dollars apart, so every grade came out 'A' — it hit no_rankable_model
    // and never reached the too_thin branch at all, and a mutation removing that branch
    // passed clean. A test has to reach the code it claims to guard.
    const thinSpread = Array.from({ length: 10 }, (_, i) => Object.assign({}, TRADE, {
      id: 'S' + i, ticker: 'ZZ' + i, entry: 100 + i * 6, percentGain: (i % 2 ? 1 : -1) * (0.03 + i / 100)
    }));
    const thin = await RIG.gradeTrades(thinSpread, base, { call: skilful });
    assert.strictEqual(thin.winner.model, null);
    assert.strictEqual(thin.winner.reason, 'too_thin', 'ten rows with real spread must trip too_thin, not no_spread');
    assert.ok(thin.raw[0].byLevel.narrative.rho != null, 'and the rho must actually be computable, or the branch is untested');

    // Two models given the SAME grader cannot be separated — that must read as a tie,
    // never as a hairline win for whichever floated up in the sort.
    const same = await RIG.gradeTrades(corpus, base, { call: skilful });
    assert.strictEqual(same.winner.model, null, 'identical graders must not produce a winner');
    assert.strictEqual(same.winner.reason, 'tie');
    assert.match(same.winner.detail, /noise/);
  });

  await T('the tie band is the sample noise and tightens as n grows', () => {
    assert.ok(RIG.tieBand(101) < RIG.tieBand(26), 'a bigger corpus must separate models a fixed margin could not');
    assert.strictEqual(RIG.tieBand(1), Infinity);
  });

  await T('coronerField reports the crosstab and REFUSES a single number without an ordering', async () => {
    const noOrder = await RIG.gradeTrades(corpus, Object.assign({}, base, { coronerField: 'coronerVerdict' }), { call: skilful });
    const c = noOrder.raw[0].coroner;
    assert.ok(c.n > 0 && c.byClass['thesis-wrong'], 'per-class means are the honest form');
    assert.strictEqual(c.rho, null, 'no ordering declared means no agreement number');
    assert.match(c.reason, /no_ordering_declared/);

    const ordered = await RIG.gradeTrades(corpus, Object.assign({}, base, {
      coronerField: 'coronerVerdict', coronerOrder: ['earned-alpha', 'market-beta', 'thesis-wrong']
    }), { call: skilful });
    const o = ordered.raw[0].coroner;
    assert.ok(typeof o.rho === 'number' || o.rho === null);
    assert.match(o.assumes, /declared by you, not derived here/,
      'an ordering is a claim the caller made and the output must say so');
  });

  await T('ranks on the BLIND level — a model that only grades well when shown the answer loses', async () => {
    // m/a has judgement: its blind grades track the entry quality.
    // m/b has none: blind it grades at random, sighted it reads percentGain perfectly.
    // Ranked on `full`, m/b wins outright. Ranked on `narrative` — which is the product —
    // m/a must win. Rank on the sighted number and you reward exactly the behaviour the
    // blind exists to detect.
    const call = async ({ model, messages }) => {
      const shown = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
      const sighted = shown.percentGain != null;
      const i = parseInt(String(shown.ticker).slice(2), 10);
      let g;
      if (model === 'm/a') g = 'ABCDF'[Math.min(4, Math.floor(i / 6))];   // tracks entry quality, blind or not
      else g = sighted ? (shown.percentGain > 0 ? 'A' : 'F')              // only useful once shown the answer
                       : 'ABCDF'[(i * 7) % 5];                            // blind: spread, but uncorrelated
      return { ok: true, text: JSON.stringify({ grade: g }) };
    };
    // percentGain MUST change sign across the corpus, or the sighted grader emits one
    // letter, its rho is null, and the premium it is supposed to demonstrate cannot exist.
    // The first version of this fixture was positive throughout and failed for that reason.
    const wide = Array.from({ length: 30 }, (_, i) => Object.assign({}, TRADE, {
      id: 'W' + i, ticker: 'ZZ' + i, entry: 100 + i, percentGain: (14.5 - i) / 100
    }));
    const out = await RIG.gradeTrades(wide, base, { call });
    assert.strictEqual(out.methodology.primaryLevel, 'narrative');

    const a = out.raw.find(r => r.model === 'm/a'), b = out.raw.find(r => r.model === 'm/b');
    assert.ok(Math.abs(a.byLevel.narrative.rho) > Math.abs(b.byLevel.narrative.rho),
      'the fixture must actually separate them blind, or this proves nothing');
    assert.ok(b.premium.premium > a.premium.premium,
      'the hindsight-driven model must show the larger premium — that is what the premium is for');
    if (out.winner.model) assert.strictEqual(out.winner.model, 'm/a', 'the blind winner must win');
  });

  console.log(`\n${n} assertions passed — the blind is the experiment\n`);
})().catch(e => { console.error('\nFAILED:', e && e.message); process.exit(1); });
