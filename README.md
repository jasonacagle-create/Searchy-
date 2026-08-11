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
