// util.js — the two coercions the rest of the package depends on, in one place so they
// cannot drift. Both encode the same rule: MISSING IS NULL, NEVER A NUMBER.
'use strict';

// Normalises a key for outcome matching: case and punctuation removed, so `exit_reason`,
// `exitReason` and `Exit-Reason` are one name. The scrub and the overlap check MUST use
// the same normaliser or a caller can declare an outcome the scrub never recognises.
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

// A finite number, or null. Never 0 for "absent" — an absent score is not a low score,
// and a missing rho is not a rho of zero.
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v
  : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);

// Arrays and null are objects to `typeof`; neither should be walked as a record.
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

module.exports = { norm, num, isPlainObject };
