// adapters/rtdb.js — read closed trades out of a Firebase Realtime Database.
//
// Zero dependency: RTDB speaks plain REST, so this is `fetch` and nothing else. The whole
// adapter surface is one function returning an array of records — see the contract in
// README.md. The rig never knows where trades came from, which is the point of the split.
'use strict';

/**
 * @param {object} opts
 *   dbUrl   e.g. https://<project>-default-rtdb.firebaseio.com   (no trailing slash needed)
 *   path    the book, e.g. 'paper_portfolio'
 *   field   array field holding closed trades, default 'closed'
 *   secret  optional admin secret for locked paths
 *
 * A read failure THROWS. It does not return an empty array: "the database did not answer"
 * and "there are no closed trades" are opposite facts, and a rig handed [] would report a
 * clean, empty, successful run over a book it never saw. That conflation is the single
 * easiest way to make this whole package lie.
 */
async function closedTrades(opts) {
  const { dbUrl, path = 'paper_portfolio', field = 'closed', secret } = opts || {};
  if (!dbUrl) throw new Error('rtdb adapter: dbUrl is required');
  const base = String(dbUrl).replace(/\/+$/, '');
  const q = secret ? '?auth=' + encodeURIComponent(secret) : '';
  const url = `${base}/${path}.json${q}`;

  const r = await fetch(url);
  if (!r.ok) {
    // A 401 here is nearly always a rules problem on an UNDECLARED path rather than a bad
    // secret — an undeclared node inherits deny-by-default and answers exactly like a
    // locked one. Named because the two need completely different fixes.
    throw new Error(`rtdb adapter: GET /${path} -> ${r.status}` +
      (r.status === 401 ? ' — check the path is declared readable in database.rules.json, not just that the secret is right' : ''));
  }
  const body = await r.json();
  if (body && typeof body === 'object' && body.error)
    throw new Error(`rtdb adapter: /${path} returned an error body: ${body.error}`);
  if (body == null) return [];                    // the node genuinely does not exist yet

  const list = body[field];
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`rtdb adapter: /${path}/${field} is not an array`);
  return list.filter(t => t && typeof t === 'object');
}

module.exports = { closedTrades };
