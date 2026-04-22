# Spec 02 — Unified Indicator / Survey / Pulse-Check Engine

**Roadmap epic:** P0-2
**Status:** Draft v1 — for review

## Motivation

The notes describe three distinct "questionnaire" modalities that the current schema partially shares but the routes and UIs don't:

1. **Wellbeing Indicators** — scored, with sections, each section maps a score range → pre-built verbiage → auto-generated confidential participant report (emailed + archived).
2. **Surveys** — no scoring, no personal report; raw-data collection with demographic anonymity toggle and admin export.
3. **Pulse Checks** — short, recurring, ICC pushes a global standard; orgs can author their own additional ones.

The key insight: **one engine, three presentation modes**. The schema already supports most of (1); (2) and (3) require small extensions.

## What the notes explicitly add

From ICC §Wellbeing Indicators, paraphrased and tightened:

> Each indicator has one or more sections. Each section contains questions. Each question contributes a score. The section has a total-score range. That range is sliced into bands. **Each band has its own descriptive verbiage.** The participant's final report is assembled by looking up which band their section-score fell into, and pulling that band's verbiage into the report template. Reports are 100% confidential — emailed to the participant and stored for re-download; never personally identified in aggregates.

> "The section that is missing in the AI version is where we are able to create the templates that align with all of the possible responses that a participant could potentially receive."

That missing piece is **`indicator_section_ranges`** — spec below.

## Schema additions

```sql
-- The verbiage-per-band table. This is the one the notes flag as missing.
CREATE TABLE IF NOT EXISTS indicator_section_ranges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID NOT NULL REFERENCES indicator_sections(id) ON DELETE CASCADE,
  band_label VARCHAR(100) NOT NULL,            -- e.g. 'Low', 'Moderate', 'High', 'Excellent'
  score_min INTEGER NOT NULL,                  -- inclusive
  score_max INTEGER NOT NULL,                  -- inclusive
  short_description TEXT,                      -- shown in UI preview
  report_verbiage_html TEXT NOT NULL,          -- pulled verbatim into participant PDF / email
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (score_max >= score_min)
);

CREATE INDEX IF NOT EXISTS idx_indicator_section_ranges_section
  ON indicator_section_ranges(section_id);

-- Each indicator can also define an OVERALL-score band set that overlays the per-section bands.
-- E.g. "if all sections averaged to 60–80, the report's conclusion paragraph is X".
CREATE TABLE IF NOT EXISTS indicator_overall_ranges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  indicator_id UUID NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  band_label VARCHAR(100) NOT NULL,
  score_min INTEGER NOT NULL,
  score_max INTEGER NOT NULL,
  conclusion_html TEXT NOT NULL,               -- closes the report
  recommendation_resource_ids UUID[],          -- suggested wellbeing resources (the "nudge" in the notes)
  sort_order INTEGER DEFAULT 0
);
```

### Survey additions

`surveys` already exists. Two needed columns for the notes' "demographic anonymity" feature:

```sql
ALTER TABLE surveys
  ADD COLUMN IF NOT EXISTS collect_demographics BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS demographic_fields JSONB DEFAULT '[]'::jsonb;
  -- e.g. [{"key":"age_band","anonymous":true},{"key":"gender","anonymous":true},{"key":"bu","anonymous":false}]
```

`survey_responses` needs a matching anonymization flag so the export layer knows whether a row was identified.

### Pulse-check additions

```sql
CREATE TABLE IF NOT EXISTS pulse_checks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  scope VARCHAR(20) NOT NULL,                  -- 'icc_global' | 'company'
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,  -- NULL for icc_global
  created_by_icc UUID REFERENCES icc_admins(id),
  created_by_user UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'draft',          -- draft | active | archived
  frequency VARCHAR(20) DEFAULT 'continuous',  -- continuous | weekly | monthly | once
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (scope = 'icc_global' AND company_id IS NULL AND created_by_icc IS NOT NULL)
    OR
    (scope = 'company' AND company_id IS NOT NULL AND created_by_user IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS pulse_check_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pulse_check_id UUID NOT NULL REFERENCES pulse_checks(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  metric_key VARCHAR(100) NOT NULL,            -- 'overall'|'energy'|'stress'|'connection'|'purpose' for the global one
  scale_min INTEGER DEFAULT 1,
  scale_max INTEGER DEFAULT 10,
  sort_order INTEGER DEFAULT 0
);

-- Link existing wellbeing_checks to the pulse_check that produced them
ALTER TABLE wellbeing_checks
  ADD COLUMN IF NOT EXISTS pulse_check_id UUID REFERENCES pulse_checks(id) ON DELETE SET NULL;

-- Seed the ICC global pulse-check with the 5 standard metrics
INSERT INTO pulse_checks (id, title, scope, created_by_icc, status, frequency)
VALUES ('11111111-1111-1111-1111-111111111111', 'ICC Global Pulse',
        'icc_global',
        (SELECT id FROM icc_admins WHERE role = 'super_admin' LIMIT 1),
        'active', 'continuous');

INSERT INTO pulse_check_questions (pulse_check_id, question_text, metric_key, sort_order) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Overall wellbeing today?',   'overall',    10),
  ('11111111-1111-1111-1111-111111111111', 'Energy level?',              'energy',     20),
  ('11111111-1111-1111-1111-111111111111', 'Stress level?',              'stress',     30),
  ('11111111-1111-1111-1111-111111111111', 'Sense of connection?',      'connection', 40),
  ('11111111-1111-1111-1111-111111111111', 'Sense of purpose?',         'purpose',    50);
```

## Unified builder UX

One `Builder` component, three modes. Toggle at the top:

```
┌──────────────────────────────────────────────────────┐
│  Mode: ( ) Indicator  ( ) Survey  ( ) Pulse Check    │
├──────────────────────────────────────────────────────┤
│  Step 1 — Core info (title, category, banner, intro) │
│  Step 2 — Sections (with order)                      │
│  Step 3 — Questions per section                      │
│  Step 4 — Scoring                                    │
│         (indicator only — else skipped)              │
│  Step 5 — Section ranges + report verbiage           │
│         (indicator only)                             │
│  Step 6 — Conclusion / overall bands                 │
│         (indicator only)                             │
│  Step 7 — Demographics                               │
│         (survey only)                                │
│  Step 8 — Distribution                               │
│         (org assignment, cohort, retake rules)       │
│  Step 9 — Preview + publish                          │
└──────────────────────────────────────────────────────┘
```

### Question types

Specified in the notes. Build to this matrix:

| Type | Scorable | UI |
|---|---|---|
| Single-choice (radio) | ✓ | radios with per-option score |
| Dropdown | ✓ | select with per-option score |
| Multi-choice (checkbox) | ✓ | checkboxes, sum of checked scores |
| Linear scale (slider) | ✓ | 1–N slider with labels |
| Short answer | ✗ | text input, no score |
| Paragraph | ✗ | textarea, no score |

Persist as existing `indicator_questions.question_type` + `indicator_answers` rows for the option/score pairs.

## Report generation

New service `src/services/indicatorReportGenerator.js`:

```js
// INPUT:  completion_id (a row in indicator_completions)
// OUTPUT: { html, pdfBuffer, summaryJson }
// STEPS:
//   1. Load completion → responses → questions → sections → indicator
//   2. For each section, sum scores across responses
//   3. Look up matching indicator_section_ranges band by score
//   4. Concatenate: intro_html → [per section: title + band verbiage] → overall band conclusion
//   5. Render with a Handlebars template (new file: templates/indicator-report.hbs)
//   6. Produce PDF with puppeteer or a lighter alternative (html-pdf-node, pdfkit)
//   7. Email via existing nodemailer
//   8. Persist final HTML + PDF URL on indicator_completions
```

The "nudge to resources" the notes describe: after step 4, look up `indicator_overall_ranges.recommendation_resource_ids` and render clickable cards pointing at `/resources/:id`.

## Anonymization guarantee

Every route that exposes indicator/survey/pulse response data to anyone other than the participant must route through `src/services/anonymize.js`. The function takes a response row and returns it with `user_id` stripped and demographic fields filtered per `surveys.demographic_fields` policy.

A unit test at `tests/anonymization.spec.js` asserts:
- `GET /api/icc/indicators/:id/responses` never returns `user_id`.
- `GET /api/companies/:id/indicators/:id/responses` never returns `user_id` and filters demographics marked `anonymous:true`.
- The only endpoint that returns `user_id` is `GET /api/me/wellbeing/reports` (participant looking at their own archive).

## Route surface

```
POST   /api/v2/indicators                         # create
PUT    /api/v2/indicators/:id                     # update (core)
POST   /api/v2/indicators/:id/sections
POST   /api/v2/indicators/:id/sections/:sid/questions
POST   /api/v2/indicators/:id/sections/:sid/ranges    # ← NEW (the missing piece)
POST   /api/v2/indicators/:id/overall-ranges          # ← NEW
POST   /api/v2/indicators/:id/publish
POST   /api/v2/indicators/:id/assign                  # to orgs / cohorts
GET    /api/v2/indicators/:id/report/:completionId    # participant download
GET    /api/v2/indicators/:id/responses               # anonymized export for ICC / admin

# Survey
POST   /api/v2/surveys                                # scope: company | icc
POST   /api/v2/surveys/:id/demographics               # configure demographic capture + anonymity
GET    /api/v2/surveys/:id/responses/export           # CSV, respects anonymity rules

# Pulse Checks
POST   /api/v2/pulse-checks                           # scope enforced by requirePermission
GET    /api/v2/pulse-checks/active                    # returns global + company pulse checks for the caller
POST   /api/v2/pulse-checks/:id/responses             # submit
```

## Assignment / distribution logic

The notes want flexible assignment. Add to `indicator_org_assignments`:

```sql
ALTER TABLE indicator_org_assignments
  ADD COLUMN IF NOT EXISTS retake_rule VARCHAR(50) DEFAULT 'once',
    -- 'once' | 'window' | 'recurring_every_n_days'
  ADD COLUMN IF NOT EXISTS retake_window_days INTEGER,
  ADD COLUMN IF NOT EXISTS cohort_type VARCHAR(50) DEFAULT 'all',
    -- 'all' | 'business_unit' | 'department' | 'user_list'
  ADD COLUMN IF NOT EXISTS cohort_value JSONB;
```

## Dependencies

- Blocked by nothing — this can ship independently of RBAC (v1 role checks still work).
- Unblocks: P1-3 (pulse on home), P1-6 (my wellbeing report archive + nudges), P1-13 (company survey builder), P2-3 (indicator builder UI rebuild), P2-4 (survey builder UI), P2-9 (analytics — real data model to aggregate over).

## Open questions for you

1. **PDF engine** — puppeteer is heavy but produces beautiful output. Alternative: `html-pdf-node` (wraps puppeteer) or server-side Handlebars → pdfkit (smaller but less design flexibility). Preference?
2. **Report storage** — local filesystem, S3-compatible object store, or keep them in Postgres as bytea? Object store is the right answer long-term.
3. **Short-answer / paragraph aggregation** — if a survey has free-text and the company admin exports responses, do we return raw text (risks re-identification)? Or offer a masking option?
4. **Retake cadence triggers** — cron-driven reopens, or opportunistic check on login? Cron is more accurate; opportunistic is simpler.
