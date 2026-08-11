// tasks/ocr.js — the first tenant: read a photographed textbook page.
//
// Chosen first because it has GROUND TRUTH. You know what the page says, so the score is
// arithmetic and a wrong answer is provably wrong — unlike most model comparisons, which
// come down to which output someone preferred. A harness calibrated here can be trusted
// later on tasks whose answers are softer.
//
// The page it replaces called OpenAI gpt-4.1-mini (recovered from the deleted
// netlify/functions/extract-pages-batch.js at 6512b7c). That is the baseline to beat, and
// it is deliberately kept in the model list: a bake-off among open-weight models that
// never checks the incumbent cannot tell you whether switching costs you anything.
'use strict';

// A task is three functions and a name. Anything satisfying this shape can be baked off,
// which is what makes Searchy a platform rather than an OCR script.
const NAME = 'ocr';

const SYSTEM = [
  'You transcribe a photographed textbook page. Return JSON only, no prose outside it:',
  '{"chapter":<number|null>,"page":<number|null>,"title":<string|null>,"text":"<full text>"}',
  '',
  'Rules:',
  '- text is the COMPLETE body text of the page, verbatim. Preserve case and punctuation.',
  '- Do NOT summarise, correct, complete or tidy the text. A transcription that reads',
  '  better than the page is a wrong transcription.',
  '- If the page number or chapter is not visible, use null. Do not infer it.',
  '- If the image is unreadable, return {"text":""} rather than guessing.'
].join('\n');

function buildMessages(fixture) {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: 'Transcribe this page.' },
      { type: 'image_url', image_url: { url: fixture.imageDataUrl } }
    ] }
  ];
}

/**
 * Parse a reply into { text, fields } or a refusal.
 *
 * AN EMPTY TRANSCRIPTION IS A REFUSAL, NOT A PERFECT FAILURE. The prompt tells a model to
 * return {"text":""} when the image is unreadable, so that path is expected and must be
 * counted apart — scoring it as CER 1.0 would rank an honest "I cannot read this" beside
 * a confident hallucination, which is exactly backwards.
 */
function parse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { status: 'refused', reason: 'empty_reply' };
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { status: 'refused', reason: 'no_json' };
  let d;
  try { d = JSON.parse(m[0]); } catch (e) { return { status: 'refused', reason: 'bad_json' }; }
  const text = typeof d.text === 'string' ? d.text : '';
  if (!text.trim()) return { status: 'refused', reason: 'declared_unreadable' };
  const asNum = (v) => (typeof v === 'number' && isFinite(v)) ? v
    : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : null);
  return {
    status: 'ok',
    text,
    // null, never 0 — "no chapter visible" and "chapter zero" are different claims, and
    // the prompt explicitly asks for null rather than a guess.
    fields: { chapter: asNum(d.chapter), page: asNum(d.page),
              title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : null }
  };
}

// Case and punctuation are part of what was on the page, so OCR is scored raw. A task
// where they were noise would declare a different mode — the choice belongs to the task,
// not to the harness, and it is reported with every result.
const NORMALISE = 'raw';

module.exports = { NAME, SYSTEM, NORMALISE, buildMessages, parse };
