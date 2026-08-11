// tasks/trade-grading.js — the second tenant: grade a trade you cannot see the outcome of.
//
// The first tenant (ocr) was chosen because it has GROUND TRUTH — you know what the page
// says, so the score is arithmetic. This one is the opposite case on purpose, and it is
// why it is worth having beside OCR rather than instead of it: there is no reference
// answer. No one can say what grade a trade "should" have got. What CAN be measured is
// whether a model's grades RANK the outcomes, and how much of that ranking survives when
// the outcome is hidden.
//
// ── THE ONE PLACE THIS TASK DOES NOT FIT THE HARNESS, STATED PLAINLY ─────────
// `bakeoff/run.js` scores each case against `fixture.reference` with CER/WER, then
// averages. This task has no per-case reference and cannot be scored that way:
//
//   ocr             per case:    distance(hypothesis, reference)      -> mean CER
//   trade-grading   per CORPUS:  spearman(grades, realised returns)   -> one rho
//
// A rank correlation is not an average of per-case scores and cannot be computed one case
// at a time. So this task exports the four functions the harness needs to CALL a model
// (which is the half that genuinely generalises — prompt, parse, refusal discipline) and
// brings its own scorer in ../../src/scorer.js for the half that does not.
//
// Faking it would have been easy and wrong: give each case a "reference grade" from
// somewhere and let CER run. That reference would be a machine's opinion, and the harness
// already refuses machine-written references for exactly this reason — it would measure
// agreement with whoever wrote them, and the table would look normal.
'use strict';

const { blindCase, buildPrompt, LEVELS, SYSTEM: BLIND_SYSTEM } = require('../../src/blind-levels.js');
const { parseGrade } = require('../../src/scorer.js');

const NAME = 'trade-grading';

// ── `SYSTEM` IS A CONSTANT IN THIS INTERFACE, AND FOR THIS TASK IT VARIES ────
// The harness exports one SYSTEM per task and prints it under --dry. This task's system
// message DEPENDS ON THE BLINDING LEVEL: at `narrative` it says the outcome is withheld,
// which is true; shipping that same sentence at `mechanics` or `full` would be a request
// whose system message contradicts its own user message — the precise defect this rig was
// built to avoid, and it would land on exactly the two levels the hindsight premium is
// computed from.
//
// So: SYSTEM is the narrative wording (the default, and what --dry should show), and
// buildMessages owns the real one. `systemFor` is exported so a caller printing prompts
// can show all three rather than one that is true of only a third of the run.
const SYSTEM = BLIND_SYSTEM;
const systemFor = (level) => buildPrompt({}, level)[0].content;

// Nothing about a trade record is noise the way case and punctuation can be in text, and
// nothing here is compared by string distance at all. Declared rather than omitted,
// because the harness prints it with every result and a blank would read as a choice
// nobody made.
const NORMALISE = 'n/a — scored by rank correlation, not string distance';

/**
 * fixture shape:
 *   { trade: {...}, level: 'narrative'|'mechanics'|'full', blind: { visibleKeys, outcomeKeys, nestedKeys } }
 *
 * The blind config travels WITH the fixture rather than living here, because what counts
 * as an outcome is a property of the caller's records, not of this task. blindCase()
 * refuses outright if it is missing — see src/blind-levels.js.
 */
function buildMessages(fixture) {
  const level = (fixture && fixture.level) || 'narrative';
  const { case: blinded } = blindCase(fixture && fixture.trade, level, fixture && fixture.blind);
  if (!blinded) throw new Error('trade-grading: fixture has no usable trade');
  return buildPrompt(blinded, level);
}

/**
 * Parse a reply into the harness's { status } shape.
 *
 * THE REFUSAL DISCIPLINE IS THE SAME AND IT IS NOT A COINCIDENCE. ocr.js counts "I cannot
 * read this" apart from a confident hallucination; here an off-schema grade — "B+", a
 * hedge, a refusal — is REFUSED rather than coerced to a letter. Coercing it would file a
 * grade nobody issued and feed it to the correlation as though the model had said it,
 * which is the same error as scoring an honest refusal as CER 1.0.
 */
function parse(raw) {
  const g = parseGrade(raw);
  if (!g.ok) return { status: 'refused', reason: g.error };
  return {
    status: 'ok',
    // `text` is the harness's field for the comparable answer. For this task the grade IS
    // the answer, and it is a letter rather than a transcription.
    text: g.grade,
    fields: {
      grade: g.grade,
      // null, never a middling default — an absent sub-score is not a 3.
      thesisQuality: g.thesisQuality,
      riskQuality: g.riskQuality,
      confidence: g.confidence,
      wouldTakeAgain: g.wouldTakeAgain,
      reasons: g.reasons
    }
  };
}

module.exports = { NAME, SYSTEM, NORMALISE, buildMessages, parse, systemFor, LEVELS };
