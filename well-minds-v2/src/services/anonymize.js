'use strict';

/**
 * anonymize.js
 * --------------------------------------------------------------------------
 * Spec 02. A single guarantee: when aggregated results for wellbeing /
 * indicator / pulse data are returned to a non-ICC viewer, we never emit a
 * bucket with fewer than N respondents. Default N is 5; overridable per
 * company in a later iteration.
 *
 * Callers pass the raw aggregate rows and the count column name. Buckets
 * below threshold are either hidden entirely (`drop`) or replaced with a
 * redaction placeholder (`redact`).
 */

const DEFAULT_MIN_BUCKET = 5;

function redactSmallBuckets(rows, { countField = 'n', min = DEFAULT_MIN_BUCKET, mode = 'redact' } = {}) {
  if (!Array.isArray(rows)) return rows;

  if (mode === 'drop') {
    return rows.filter((row) => Number(row[countField] || 0) >= min);
  }

  return rows.map((row) => {
    const count = Number(row[countField] || 0);
    if (count >= min) return row;
    // Redact all numeric fields except the count so stakeholders know the
    // bucket exists but can't back-solve to individuals.
    const redacted = { ...row };
    for (const k of Object.keys(redacted)) {
      if (k === countField) continue;
      const v = redacted[k];
      if (typeof v === 'number') redacted[k] = null;
    }
    redacted._redacted = true;
    redacted._reason = `Below anonymity threshold of ${min}`;
    return redacted;
  });
}

/**
 * Convenience: given {filters, count}, return either the full filtered data
 * set or a top-level redaction signal.
 */
function applyOverallGate(rows, { countField = 'n', min = DEFAULT_MIN_BUCKET } = {}) {
  const total = rows.reduce((s, r) => s + Number(r[countField] || 0), 0);
  if (total < min) {
    return {
      rows: [],
      redacted: true,
      reason: `Fewer than ${min} respondents in this slice — suppressed.`,
    };
  }
  return { rows: redactSmallBuckets(rows, { countField, min }), redacted: false };
}

module.exports = { redactSmallBuckets, applyOverallGate, DEFAULT_MIN_BUCKET };
