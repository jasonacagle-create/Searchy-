// examples/cell-network.js — a worked consumer adapter, and the four things that make it
// different from the obvious version.
//
// This is what a repo like cell-network writes on ITS side to point the rig at its own
// book. It is an example, not a dependency: nothing in grading-rig imports it.
'use strict';

const { gradeTrades, loadRegistry } = require('../src/index.js');
const rtdb = require('../adapters/rtdb.js');

// ── 1 · NORMALISE, DO NOT STRIP. THE BLIND IS NOT THE ADAPTER'S JOB ──────────
// The obvious adapter drops the outcome fields while mapping, on the reasoning that what
// never enters cannot leak. It is the wrong layer, and it silently destroys the experiment:
//
//   `mechanics` reveals exitPrice.  `full` reveals profit and percentGain.
//   An adapter that stripped them leaves those levels with nothing to reveal, so every
//   level renders identically, the premium comes out ~0, and the run reports that the
//   model has judgement when what actually happened is that it was never shown anything.
//
// That failure is invisible: three levels, three sets of grades, a premium of zero, and a
// conclusion exactly backwards from the truth. So the record carries EVERYTHING and the
// blind decides what is shown — which is the one place that decision is enforced and
// tested.
//
// ── 2 · NAMES ARE NORMALISED FOR MATCHING, SO A RENAME CANNOT SMUGGLE ────────
// `exit_price`, `exitPrice` and `Exit-Price` are one name to the outcome check. Renaming a
// field on the way in does not move it out of the outcome set — verified in the test.
function normalise(t) {
  return {
    // identity
    id: (t.ticker || 'ZZ') + '_' + (t.openTs || Date.parse(t.entryTime || 0) || 0),
    symbol: t.ticker,
    side: t.side,
    tier: t.tier,

    // ── 3 · THE ENTRY-TIME FIELDS DECIDE WHAT THE EXPERIMENT CAN ASK ─────────
    // The rig asks the model for `risk_quality`. A record carrying entry and size but no
    // STOP makes that question unanswerable — the grader is being scored on something it
    // was never shown. Dropping stopLoss/target/atrPct is not a smaller experiment, it is
    // a differently-shaped one whose risk column means nothing.
    entryPrice: t.entry,
    stopLoss: t.stopLoss,
    target: t.takeProfit,
    atrPct: t.atrPct,
    trailPct: t.trailingStopPercent,
    quantity: t.positionSize,
    holdDays: t.holdDays,          // the PLANNED clock — not the realised duration
    exitBy: t.exitBy,              // the planned deadline, likewise
    thesis: t.thesis || t.why,
    conviction: t.confidence,
    spyAtEntry: t.spyAtEntry,
    vixAtEntry: t.vixAtEntry,

    // ── THE NESTED BLOCKS ARE THE RICHEST SIGNAL AND THE KNOWN LEAK VECTOR ──
    // These carry the entry-time read the scorer produced, and they are exactly where an
    // outcome ends up by accident: the day someone stamps realizedPnl onto valueRead, or
    // an exit_reason into a feature vector, a top-level allowlist forwards the whole
    // OBJECT and the leak rides inside it. Two defences, and only the first is the guard:
    //   nestedKeys  — an inner allowlist, refuses unknown names by default
    //   outcomeKeys — the deep scrub, catches declared outcome names at any depth
    // This is the only part of the record where outcomeKeys does real work; for top-level
    // fields the allowlist alone already decides.
    feat: t.feat,
    read: t.valueRead,

    // OUTCOMES — carried deliberately. Declared below, revealed only by level.
    exitPrice: t.exitPrice,
    exitReason: t.exitReason,
    profit: t.profit,
    percentGain: t.percentGain,
    durationMinutes: t.durationMinutes,
    exitTime: t.exitTime,
    coronerAttribution: t.coronerVerdict || t.verdict || null
  };
}

const BLIND = {
  visibleKeys: ['symbol', 'side', 'tier', 'entryPrice', 'stopLoss', 'target', 'atrPct',
                'trailPct', 'quantity', 'holdDays', 'exitBy', 'thesis', 'conviction',
                'spyAtEntry', 'vixAtEntry', 'feat', 'read'],
  nestedKeys: {
    feat: ['atr_pct', 'px_vs_ema8_pct', 'px_vs_ema20_atr', 'ret_10d_pct', 'spy_ret_10d_pct',
           'range_pos', 'days_to_earnings'],
    read: ['score', 'rrRatio', 'valueScore', 'valueGrade', 'rangePos', 'flags', 'readable']
  },
  // Every field that reveals what happened. DURATION IS IN HERE and it is the one that
  // looks innocent — a 12-minute hold on a swing setup is a stop-out. `exitTime` is here
  // too: entry time and exit time shown separately leak the duration just as completely,
  // because their difference is the same number.
  outcomeKeys: ['exitPrice', 'exitReason', 'profit', 'percentGain', 'durationMinutes',
                'exitTime', 'realizedPnl', 'realizedR']
};

async function gradePaperPortfolio({ models, blinding, dbUrl, secret, book = 'paper_portfolio', apiKey } = {}) {
  // ── 4 · A FAILED READ MUST THROW, NOT YIELD [] ───────────────────────────
  // `Object.values(snapshot.val() || {})` turns an unreachable database into a clean,
  // successful run over a book it never saw — and on a keyless path an undeclared node
  // answers 401 exactly like a locked one, so this is not hypothetical. adapters/rtdb.js
  // throws and names the likely cause.
  const closed = await rtdb.closedTrades({ dbUrl, path: book, secret });
  const trades = closed.map(normalise).filter(t => t.symbol);

  return gradeTrades(trades, Object.assign({}, BLIND, {
    models,
    blinding,                                   // omit for both ends; a string runs one level
    // THE LABEL. It reaches the scorer and never the prompt — which is why it is a
    // function of the raw record rather than a visible key.
    returnOf: (t) => (t && typeof t.percentGain === 'number' ? t.percentGain * 100 : null),
    coronerField: 'coronerAttribution',
    // No ordering declared, so the coroner section reports the crosstab rather than a
    // single agreement number. Supplying one is a claim about YOUR attributions:
    //   coronerOrder: ['earned-alpha', 'beta-win', 'market-beta', 'regime-shift', 'thesis-wrong']
    apiKey,
    caseId: (t) => t.id
  }));
}

module.exports = { gradePaperPortfolio, normalise, BLIND };

// Run it:
//   const { models, problems, warnings } = loadRegistry('./models.json');
//   if (problems.length) throw new Error(problems.join('\n'));
//   warnings.forEach(w => console.warn('WARN: ' + w));
//   const out = await gradePaperPortfolio({ models, dbUrl: process.env.FIREBASE_DB_URL,
//                                           apiKey: process.env.OPENROUTER_KEY });
//   console.log(out.winner, out.methodology);
void loadRegistry;
