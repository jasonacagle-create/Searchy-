// registry.js — which models are in the bake-off.
//
// A FILE, NOT AN ENVIRONMENT VARIABLE. Adding a model is a line in models.json rather than
// a code change or a remembered env string, and the file is the record of what a given
// result was run against. JSON rather than YAML for one reason only: this package has zero
// runtime dependencies and a YAML parser would cost that. The benefit was always the
// registry, never the format.
'use strict';

const fs = require('node:fs');

// `weights` is REQUIRED and is not decoration. A bake-off among open-weight models that
// never checks a strong closed one cannot say what the choice COSTS — it can only rank the
// candidates against each other and call the winner good. That is the same error as a
// control group nobody ran.
const WEIGHTS = Object.freeze(['open', 'closed']);

function validate(models) {
  const out = [];
  const problems = [];
  (Array.isArray(models) ? models : []).forEach((m, i) => {
    const at = `models[${i}]`;
    if (!m || typeof m !== 'object') { problems.push(`${at} is not an object`); return; }
    if (typeof m.id !== 'string' || !m.id.trim()) { problems.push(`${at} has no id`); return; }
    if (!WEIGHTS.includes(m.weights))
      { problems.push(`${at} (${m.id}) needs weights: ${WEIGHTS.join('|')} — a bake-off with no closed-weight control cannot price the choice`); return; }
    if (typeof m.licence !== 'string' || !m.licence.trim())
      { problems.push(`${at} (${m.id}) needs a licence string — an open-weight model with unstated terms is not usable evidence`); return; }
    out.push({
      id: m.id.trim(),
      label: (typeof m.label === 'string' && m.label.trim()) || m.id.trim(),
      weights: m.weights,
      licence: m.licence.trim(),
      enabled: m.enabled !== false
    });
  });
  return { models: out, problems };
}

/**
 * Load and validate a registry. Returns { models, problems, warnings }.
 *
 * The closed-weight control is a WARNING, not a refusal, and the split is deliberate: a
 * malformed entry means the file cannot be trusted and the run should stop, while running
 * without a control produces a REAL result that simply cannot answer one question. Refusing
 * there would stop someone doing a legitimate open-only comparison; staying silent would let
 * them quote a winner as though the field had been surveyed. So it runs, loudly.
 */
function loadRegistry(pathOrObject) {
  let raw = pathOrObject;
  if (typeof pathOrObject === 'string') {
    raw = JSON.parse(fs.readFileSync(pathOrObject, 'utf8'));
  }
  const list = Array.isArray(raw) ? raw : (raw && raw.models);
  const { models, problems } = validate(list);
  const enabled = models.filter(m => m.enabled);

  const warnings = [];
  if (!enabled.length) problems.push('no enabled models — nothing to run');
  if (enabled.length && !enabled.some(m => m.weights === 'closed'))
    warnings.push('NO CLOSED-WEIGHT CONTROL is enabled. The result can rank these models against ' +
                  'each other but cannot say what choosing open weights costs. Enable one, or state ' +
                  'this limitation wherever the number is quoted.');
  if (enabled.length === 1)
    warnings.push('one model enabled — this is a grading run, not a bake-off. The comparison this ' +
                  'package exists for needs at least two.');
  return { models: enabled, all: models, problems, warnings };
}

module.exports = { loadRegistry, validate, WEIGHTS };
