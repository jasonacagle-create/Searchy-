# grading-rig

**Can a language model grade a trade it has not seen the outcome of — and how much of the grade is hindsight?**

Zero runtime dependencies. Node ≥ 18. One export: `gradeTrades(trades, config)`.

---

## What this is

A deterministic grader — a coroner, an attribution model, a rules engine — **measures** what happened. This asks for a **judgement** made from entry-time information only, then measures whether that judgement carries information the measurement does not.

The experiment has a real chance of coming back **no**, and either answer is worth having.

**It never decides anything.** It produces grades and a scorecard. Nothing here opens a position, vetoes one, or feeds a scorer that does. If a grade ever earns a place in a decision, it earns that on a forward record, in a sandbox, like any other unproven signal.

---

## The blind is the whole experiment

Show a model the exit price and it rationalises backwards — A for the winners, D for the losers — and you have built an expensive P&L restater with opinions. Every model does this. It is not a capability problem, it is a leak.

**Three levels make the leak a measured variable:**

| level | sees | asks |
|---|---|---|
| `narrative` | entry-time only | the real question |
| `mechanics` | + exit price | can it subtract, then grade the result? |
| `full` | + P&L and exit reason | does it just narrate? |

A binary blind can only answer *do the grades predict?* Three levels also answer **how much of the grade is hindsight**, because the gap between `narrative` and `full` **is** the hindsight premium. A model whose blind grades predict as well as its sighted ones has judgement. One whose sighted grades are far better is restating the outcome — and that gap is now a number instead of a suspicion.

`narrative` is the default. The other levels exist to be measured against, never to be used alone.

---

## Three rules this package is built on

**1 · The blind is an ALLOWLIST, never a denylist.** A denylist silently leaks every field added to your records later — the day someone stamps `realizedR` onto a closed trade, a denylist forwards it and nothing looks wrong.

**2 · It refuses to run without a declared outcome set.** `config.outcomeKeys` is required. Defaulting it to empty would be the most dangerous line in the package: a green run, a full corpus of grades, and no blind at all — with nothing in the output saying so.

**3 · An unrankable state never shares a value with a rankable one.** `rho` is `null` with a named reason when the sample is thin or the grades have no spread — never `0.0`, which is a real value meaning *no correlation*. A model that graded everything B must be distinguishable from one whose grades genuinely carry no signal. That matters **more** with levels, not less: the premium is a difference of two scores, so an unknown masquerading as a zero propagates into it silently.

**Duration is outcome information**, and it is the one that looks innocent. A 12-minute hold on a swing setup is a stop-out. Put any duration field in `outcomeKeys` — and note that showing entry time and exit time *separately* leaks it just as completely, because their difference is the same number.

---

## Usage

```js
const { gradeTrades, loadRegistry } = require('grading-rig');
const rtdb = require('grading-rig/adapters/rtdb.js');

const trades = await rtdb.closedTrades({ dbUrl: process.env.DB_URL, path: 'paper_portfolio' });
const { models, problems, warnings } = loadRegistry('./models.json');
if (problems.length) throw new Error(problems.join('\n'));
warnings.forEach(w => console.warn('WARN: ' + w));

const { report } = await gradeTrades(trades, {
  visibleKeys: ['ticker','side','tier','entry','stopLoss','target','atrPct','thesis','conviction'],
  outcomeKeys: ['exitPrice','exitReason','profit','percentGain','durationMinutes','exitTime'],
  nestedKeys : { feat: ['atr_pct','px_vs_ema8_pct'] },
  returnOf   : t => t.percentGain * 100,      // the LABEL. Never in visibleKeys.
  models,
  levels     : ['narrative','full'],          // both ends, or there is no premium
  apiKey     : process.env.OPENROUTER_KEY,
  caseId     : t => t.ticker + '_' + t.openTs
});

for (const [id, r] of Object.entries(report)) {
  console.log(id, r.byLevel.narrative.verdict, '· premium', r.premium.premium ?? r.premium.reason);
}
```

`returnOf` is deliberately separate from `visibleKeys`: it is the **label**, and it must reach the scorer without ever reaching the prompt.

### Storage is yours

`gradeTrades` returns records; it does not persist them. Pass `hooks.onRecord` to write each one and `hooks.has(model, level, caseId)` to skip work already done.

**Key your storage by `(model, level, caseId)`.** One trade graded at two levels is **two observations** — a shared key lets the last write win, and the premium then compares a grade against itself.

---

## Adapters

An adapter is one function returning an array of plain trade objects. That is the entire contract:

```js
async function closedTrades(opts) -> Array<object>
```

It must **throw** on a read failure rather than return `[]`. *"The store did not answer"* and *"there are no closed trades"* are opposite facts, and a rig handed `[]` reports a clean, successful run over a book it never saw.

- **`adapters/rtdb.js`** — Firebase Realtime Database. Written, tested against its own error paths, zero-dep (RTDB speaks plain REST).
- **Firestore — not written.** It was in the original sketch and is deliberately absent: Firestore's REST surface needs an auth flow this package cannot exercise, and shipping an untested adapter that *looks* finished is worse than shipping none. The contract above is four lines; write it against your own project and you will know it works.

---

## Reading the result

- **`verdict: no_spread`** — every grade was the same letter. This is a **real finding**, not a failed run, and it is the likeliest first-run outcome.
- **`verdict: too_thin`** — fewer than 20 graded rows with a usable return. A rho off a handful of rows is noise in a statistic's costume.
- **`premium: null, reason: need_both_levels`** — one end is missing or unrankable. Not a premium of zero; the opposite finding.
- **Bucket means are colour, never the ranking key.** Ranking on the A-bucket-minus-F-bucket average discards every trade in between and lets one outsized winner carry the leaderboard. Spearman uses every row and is not moved by a single whale.

---

## Tests

```
npm test
```

Runs against an injected model caller — no network, no keys, no market. A rig whose tests need a live gateway gets run once and never again.

The end-to-end case is the one worth knowing about: a deliberately hindsight-driven fake model (grades the outcome when it can see it, guesses when it cannot) must produce a **large positive premium**. If the premium ever stops detecting that, the metric has stopped working.

Nine guards are mutation-tested. One of them, the deep scrub, initially survived its mutation — every nested object in the fixture had a declared inner allowlist, so the scrub was never reached. The fixture now includes an object with **no** declared shape, which is the only case where the scrub is the thing standing between an outcome and the model.
