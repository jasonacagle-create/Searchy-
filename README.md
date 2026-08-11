# Searchy — an open bake-off platform

A place to run the **same task across several open-weight models** and find out which one
actually wins, on a task that has a **ground truth**.

Deliberately separate from the trading engine. That repo carries heavy conventions —
mutation tests, doctrine files, PR gates on anything user-facing — which are right for
code that sets real stop levels and wrong for "try four models and see what happens."

## Why OCR is the first tenant

Because you know what the page says. Most model comparisons come down to which output
someone preferred; this one is arithmetic, and a wrong answer is provably wrong. A harness
calibrated on a task with real answers can later be trusted on tasks whose answers are
softer.

## What the harness refuses to do

These are the whole point. A bake-off that always produces a ranking is worth less than
one that says it cannot.

| | |
|---|---|
| **Score a refusal as 100% error** | "I cannot read this" and a confident hallucination are different failures. Refusals are counted apart and never averaged into accuracy. |
| **Report accuracy without coverage** | 2% error on the third of pages a model deigned to read has not beaten 6% on all of them. |
| **Hide the normalisation** | The same pair scores **CER 0.4286 raw and 0.0000 loose**. That choice is declared per task and printed with every result. |
| **Score against a machine-written reference** | It measures agreement with whichever model wrote the reference. Fixtures declare `referenceSource`, and anything but `"human"` — including *undeclared* — is refused, not warned about. |
| **Crown a winner it cannot support** | Under 5 scored samples: `too_thin`. Within 1 point of CER: `tie`, decide on cost, latency or licence. |
| **Drop the incumbent** | `openai/gpt-4.1-mini` (what the original page used) stays in the default line-up. A bake-off among open-weight models that never checks what it is replacing cannot tell you whether switching costs anything. |

## Run it

```bash
node bakeoff/run.js --task ocr --dry          # validate fixtures, call nothing
OPENROUTER_KEY=... node bakeoff/run.js --task ocr
node bakeoff/bakeoff.test.js                  # 12 mutations, zero deps
```

Fixtures: `fixtures/ocr/*.json` — see `_TEMPLATE.json.example`.

## Adding a task

A task is a name and three functions, which is what makes this a platform rather than an
OCR script:

```js
module.exports = { NAME, SYSTEM, NORMALISE, buildMessages, parse };
```

Drop it in `bakeoff/tasks/`, put fixtures in `fixtures/<name>/`, run with `--task <name>`.

## `ai-searchy.html`

The original page: photograph textbook pages, extract chapter/page/text, search locally.
It calls `/.netlify/functions/extract-pages-batch`, **which is not in this repo** — it was
deleted at `6512b7c`. The page cannot work as deployed until that endpoint is rebuilt, and
rebuilding it is the natural payoff of the bake-off: whichever model wins goes behind it.

---

## Second tenant: `trade-grading`

**Can a model grade a trade it has not seen the outcome of — and how much of the grade is
hindsight?** The opposite case to OCR on purpose: there is no ground truth. Nobody can say
what grade a trade *should* have got. What can be measured is whether the grades RANK the
outcomes, and how much of that ranking survives once the outcome is hidden.

**Three blinding levels make the leak a measured variable:**

| level | sees | asks |
|---|---|---|
| `narrative` | entry-time only | the real question |
| `mechanics` | + exit price | can it subtract, then grade the result? |
| `full` | + P&L and exit reason | does it just narrate? |

The gap between `narrative` and `full` **is** the hindsight premium. A model whose blind
grades predict as well as its sighted ones has judgement; one whose sighted grades are far
better is restating the outcome — and that is now a number rather than a suspicion.

### What it refuses to do

| refuses | because |
|---|---|
| **Run without a declared outcome set** | `outcomeKeys` is required. Defaulting it to empty gives a green run, a full corpus of grades, and no blind at all — with nothing in the output saying so. |
| **Use a denylist** | The blind is an ALLOWLIST. A denylist leaks every field added to your records later; the day someone stamps `realizedR` on a closed trade it forwards it and nothing looks wrong. |
| **Treat duration as innocent** | A 12-minute hold on a swing setup is a stop-out. Duration is outcome data — and entry time and exit time shown *separately* leak it just as completely. |
| **Report 0.0 for "cannot compute"** | `rho` is `null` with a named reason when the sample is thin or every grade is the same letter. 0.0 is a real value meaning *no correlation*, and the premium is a difference of two scores — an unknown masquerading as a zero propagates silently. |
| **Coerce an off-schema grade** | `"B+"`, a hedge or a refusal is REFUSED, never mapped to F. Same discipline as counting an OCR refusal apart from a hallucination. |
| **Ship one system prompt at every level** | A constant asserting "the outcome is withheld", sent at `full`, contradicts its own user message — on exactly the levels the premium is computed from. |

### THE ONE PLACE IT DOES NOT FIT THIS HARNESS

`bakeoff/run.js` scores each case against `fixture.reference` and averages. This task
cannot be scored that way, and the reason is structural rather than a missing feature:

```
ocr             per case:    distance(hypothesis, reference)     -> mean CER
trade-grading   per CORPUS:  spearman(grades, realised returns)  -> one rho
```

A rank correlation is not an average of per-case scores and cannot be computed one case at
a time. So `tasks/trade-grading.js` exports the four functions the harness needs to CALL a
model — prompt, parse, refusal discipline, the half that genuinely generalises — and
brings its own scorer in `src/scorer.js` for the half that does not. Run it through
`src/index.js`'s `gradeTrades()`, not `bakeoff/run.js`.

**Faking it would have been easy and wrong:** give each case a "reference grade" and let
CER run. That reference would be a machine's opinion — and this harness already refuses
machine-written references for exactly that reason.

```js
const { gradeTrades, loadRegistry } = require('./src/index.js');
const rtdb = require('./adapters/rtdb.js');

const trades = await rtdb.closedTrades({ dbUrl: process.env.DB_URL, path: 'paper_portfolio' });
const { models, problems, warnings } = loadRegistry('./models.json');
if (problems.length) throw new Error(problems.join('\n'));
warnings.forEach(w => console.warn('WARN: ' + w));

const { report } = await gradeTrades(trades, {
  visibleKeys: ['ticker','side','tier','entry','stopLoss','target','atrPct','thesis'],
  outcomeKeys: ['exitPrice','exitReason','profit','percentGain','durationMinutes','exitTime'],
  returnOf   : t => t.percentGain * 100,   // the LABEL. Never in visibleKeys.
  models, levels: ['narrative','full'],    // both ends, or there is no premium
  apiKey     : process.env.OPENROUTER_KEY
});
```

**Key your storage by `(model, level, caseId)`.** One trade graded at two levels is two
observations; a shared key lets the last write win and the premium compares a grade
against itself.

### Adapters

One function, returning an array of trade objects — that is the whole contract:

```js
async function closedTrades(opts) -> Array<object>
```

It must **throw** on a read failure rather than return `[]`. *"The store did not answer"*
and *"there are no closed trades"* are opposite facts.

- **`adapters/rtdb.js`** — Firebase Realtime Database, zero-dep (RTDB speaks plain REST).
- **Firestore — deliberately not written.** Its REST surface needs an auth flow this repo
  cannot exercise, and an untested adapter that *looks* finished is worse than none.

```
node test/rig.test.js     # 16 assertions, 9 mutations, no network
```

One of those mutations is worth knowing about: disabling the deep scrub initially PASSED,
because every nested object in the fixture had a declared inner allowlist and the scrub was
never reached. The fixture now carries an object with **no** declared shape — the only case
where the scrub is what stands between an outcome and the model.
