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
      models, levels: ['narrative', 'full'], throttleMs: 0, caseId: (x) => x.id
    }), { call });

    const r = out.report['fake/one'];
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

  console.log(`\n${n} assertions passed — the blind is the experiment\n`);
})().catch(e => { console.error('\nFAILED:', e && e.message); process.exit(1); });
