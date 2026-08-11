// blind-levels.js — what the grader is allowed to see, and how much of the outcome is
// deliberately revealed.
//
// ── THE BLIND IS THE WHOLE EXPERIMENT ────────────────────────────────────────
// Show a model the exit price and it rationalises backwards — A for the winners, D for
// the losers — and you have built an expensive P&L restater with opinions. Every model
// does this; it is not a capability problem, it is a leak. So the case handed to the
// model carries ONLY what was knowable at entry, unless a level deliberately reveals more.
//
// ── THREE LEVELS, WHICH MAKE THE LEAK A MEASURED VARIABLE ────────────────────
//   narrative   entry-time only. The real question.            <- DEFAULT
//   mechanics   + exit price. Can it subtract, then grade on the result?
//   full        + realised P&L and exit reason. Does it just narrate?
//
// A binary blind answers only "do the grades predict?". Three levels also answer HOW MUCH
// OF THE GRADE IS HINDSIGHT, because the gap between narrative and full IS the hindsight
// premium. The extra levels exist to be MEASURED AGAINST, never to be used on their own.
//
// ── DURATION IS OUTCOME INFORMATION, AND IT IS THE ONE THAT LOOKS INNOCENT ───
// How long a position was held is a result: a 12-minute hold on a swing setup is a
// stop-out, five days means it ran the clock. Any duration field belongs in the outcome
// set, and showing entry time and exit time SEPARATELY leaks it just as completely as
// showing the difference — their subtraction is the same number.
'use strict';

const { norm, isPlainObject } = require('./util.js');

const LEVELS = Object.freeze({
  narrative: [],
  mechanics: ['exitPrice'],
  full: ['exitPrice', 'exitReason', 'profit', 'percentGain', 'durationMinutes']
});

// ── THE GUARD THE STANDALONE VERSION HAD TO REBUILD ──────────────────────────
// In the engine this came from, the visible allowlist was checked at REQUIRE-TIME against
// that project's own OUTCOME_KEYS, so a key appearing in both crashed the process before
// a single grade was produced. A library cannot know what an outcome is for an arbitrary
// caller, so the check moves to configuration — and the important half is what happens
// when the caller says nothing:
//
//   outcomeKeys DECLARED   -> the overlap check runs and the deep scrub has teeth
//   outcomeKeys MISSING    -> REFUSE. An empty outcome set makes the scrub a no-op and
//                             the overlap check vacuously true, so the rig would report a
//                             blind it never enforced.
//
// Defaulting to "no outcomes" would be the single most dangerous line in this package: it
// produces a green run, a full corpus of grades, and no blind at all. Every grade after
// that point is worthless and nothing in the output would say so.
function assertBlindable(config) {
  const visible = config && config.visibleKeys;
  const outcome = config && config.outcomeKeys;
  if (!Array.isArray(visible) || !visible.length)
    throw new Error('grading-rig: config.visibleKeys must be a non-empty array — the blind is an ALLOWLIST, ' +
                    'never a denylist. A denylist silently leaks every field added to your records later.');
  if (!Array.isArray(outcome) || !outcome.length)
    throw new Error('grading-rig: config.outcomeKeys must be a non-empty array naming every field that ' +
                    'reveals what happened (exit price, P&L, exit reason, DURATION). Without it the blind ' +
                    'cannot be enforced and every grade this produces would be meaningless. Refusing rather ' +
                    'than running an experiment whose result could not be read.');
  const set = new Set(outcome.map(norm));
  const clash = visible.filter(k => set.has(norm(k)));
  if (clash.length)
    throw new Error('grading-rig: these keys are declared BOTH visible and outcome: ' + clash.join(', ') +
                    ' — that would leak the answer into the question.');
  return { visible: visible.slice(), outcomeNorm: set };
}

// Walks every level and drops any key matching an outcome name once punctuation and case
// are normalised, so `exit_reason` in a snake_case feature vector is caught by the same
// rule as `exitReason`. This is a DENYLIST and is the second line of defence only — the
// allowlist is what actually holds, because it refuses unknown names by default.
function scrubDeep(value, path, stripped, outcomeNorm) {
  if (Array.isArray(value)) return value.map((v, i) => scrubDeep(v, path + '[' + i + ']', stripped, outcomeNorm));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (outcomeNorm.has(norm(k))) { stripped.push((path ? path + '.' : '') + k); continue; }
    out[k] = scrubDeep(v, (path ? path + '.' : '') + k, stripped, outcomeNorm);
  }
  return out;
}

/**
 * The blinded case.
 * Returns { case, omitted, stripped, level } — `omitted` and `stripped` NAME what was
 * withheld, so a run can PROVE the blind fired rather than assert it. A record that
 * cannot show what it hid is not evidence that anything was hidden.
 */
function blindCase(trade, level, config) {
  const { visible, outcomeNorm } = assertBlindable(config);
  const lvl = Object.prototype.hasOwnProperty.call(LEVELS, level) ? level : 'narrative';
  if (!isPlainObject(trade)) return { case: null, omitted: [], stripped: [], level: lvl };

  const stripped = [];
  const out = {};
  for (const k of visible) if (trade[k] !== undefined) out[k] = trade[k];

  // Inner allowlists for nested objects. The outer list gates TOP-LEVEL keys only, so an
  // allowed object rides through ENTIRE unless its own shape is declared — which is how a
  // realised P&L stapled onto a feature vector reaches the model past a clean-looking
  // allowlist. Anything not declared here still meets the deep scrub below.
  for (const [field, keys] of Object.entries((config && config.nestedKeys) || {})) {
    if (isPlainObject(out[field]) && Array.isArray(keys)) {
      const kept = {};
      for (const [k, v] of Object.entries(out[field])) {
        if (keys.includes(k)) kept[k] = v;
        else stripped.push(field + '.' + k);
      }
      out[field] = kept;
    }
  }

  const clean = scrubDeep(out, '', stripped, outcomeNorm);

  // The level's extra fields are added AFTER the scrub, deliberately: they are outcome
  // data being revealed ON PURPOSE, and running them through a filter designed to remove
  // outcome data would silently produce an empty level still calling itself `full`.
  for (const k of LEVELS[lvl]) if (trade[k] !== undefined) clean[k] = trade[k];

  const omitted = Object.keys(trade).filter(k => !visible.includes(k) && !LEVELS[lvl].includes(k));
  return { case: clean, omitted, stripped, level: lvl };
}

// The prompt. It says outright that the outcome is withheld — a model told to grade a
// result it cannot see behaves differently from one that thinks it is summarising.
const SYSTEM = [
  'You grade a trade using ONLY information available at the moment it was opened.',
  'You are NOT told what happened. The outcome is deliberately withheld, and guessing at',
  'it is not the task: grade the DECISION, not the result. A good decision can lose.',
  '',
  'Reply with JSON only, no prose outside it:',
  '{"grade":"A|B|C|D|F","thesis_quality":1-5,"risk_quality":1-5,',
  ' "confidence":0.0-1.0,"would_take_again":true|false,"reasons":["...","..."]}',
  '',
  'grade is the overall quality of the entry decision. Use the full range — if every',
  'trade you see gets a B, your grades carry no information and the experiment fails.'
].join('\n');

const REVEALED = [
  'You ARE shown part of the outcome in this run. That is deliberate and it is being measured:',
  'grade the DECISION anyway. A good decision can lose, and a bad one can win.'
].join('\n');

const WITHHELD = [
  'You are NOT told what happened. The outcome is deliberately withheld, and guessing at',
  'it is not the task: grade the DECISION, not the result. A good decision can lose.'
].join('\n');

// ── THE SYSTEM PROMPT MUST BE TRUE FOR THE LEVEL IT SHIPS WITH ───────────────
// One module-level constant asserting "you do NOT know the exit price", sent at all three
// levels, produces a request whose system message contradicts its own user message at two
// of them — and it lands precisely on the levels the premium is computed from. The task
// wording is IDENTICAL across levels; only the claim about what is visible changes, or
// the levels stop being comparable and the premium measures the prompt instead.
function buildPrompt(blinded, level) {
  const lvl = Object.prototype.hasOwnProperty.call(LEVELS, level) ? level : 'narrative';
  const head = lvl === 'narrative' ? SYSTEM : SYSTEM.replace(WITHHELD, REVEALED);
  return [{ role: 'system', content: head },
          { role: 'user', content: 'Grade this entry:\n\n' + JSON.stringify(blinded, null, 2) }];
}

module.exports = { LEVELS, SYSTEM, blindCase, buildPrompt, scrubDeep, assertBlindable };
