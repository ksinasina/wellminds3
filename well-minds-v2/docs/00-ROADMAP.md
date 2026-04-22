# WellMinds / ICC — v2 Update Roadmap

**Source:** two update-notes docs (ICC Admin + Company App) — ~1,000 lines of narrative requirements.
**Baseline:** `well-minds-hand-off-final.zip` — Node/Express + PostgreSQL, 105 tables, 16 route modules, two HTML frontends (employee app + ICC admin panel).
**Author intent:** *"Separate new files only"* — no edits to originals.

---

## TL;DR — where the gaps actually are

Good news: the baseline schema is **more mature than the notes imply**. Tables already exist for connect cycles, reflections with consolidation/sign-off, 360 feedback, indicator sections + questions + answers, survey builder, module subscriptions, RBAC (`roles` + `role_permissions`), custom HRIS fields, and EAP flags.

Most of the work is one of three things:
1. **Wire the frontend** to the schema that already exists (both HTML files under-surface what the DB supports).
2. **Fill targeted holes** in the schema (see §A below — these are the items that genuinely aren't modeled yet).
3. **Build new modules** that don't exist at all (pulse checks, EAP content pages, social wall audience targeting, comms template rename + WhatsApp, RBAC granularity).

---

## A. Genuinely missing from schema (new tables / columns)

| # | Item | Scope | Doc ref |
|---|---|---|---|
| A1 | **Indicator section ranges + report verbiage** — per section, N score-bands, each with a description + HTML verbiage block pulled into the generated participant report | 1 new table `indicator_section_ranges` | ICC §Wellbeing Indicators |
| A2 | **Pulse checks (ICC-pushed + company-authored)** — 5-metric ICC global pulse + org-level custom pulses; `wellbeing_checks` as-is is fine for responses but the *definition* table is missing | 2 new tables `pulse_checks`, `pulse_check_questions`; `wellbeing_checks.pulse_check_id` FK | Company §Pulse Check, ICC §Dashboard |
| A3 | **Company subdomain** — `companies.subdomain` + DNS hostname resolution in middleware | 1 column | ICC §Client Registrations |
| A4 | **Subscription tier bands + renewal tracking** — `subscription_tiers` lookup (0–10, 11–20, 21–50, 51–100, 101–250, 251–500, 501–1000, 1000+ bespoke), plus `company_subscriptions` with `tier_id`, `start_date`, `renewal_date`, `status`, `approved_by`, `approved_at` | 2 new tables | ICC §Client Registrations |
| A5 | **Post audience targeting** — `posts.audience_type` (org\|bu\|dept\|users), `post_audience` join table (for multi-user targeting), + compliance acknowledgement boolean | 1 column + 1 new table | Company §Social Wall |
| A6 | **EAP content page** — structured beyond the `eap_url` flag: banner, services list, contact block, custom HTML sections, editable by company admin | 2 new tables `eap_pages`, `eap_services` | Company §Professionals |
| A7 | **Resource impact reflections** — 21-day nudge-triggered feedback: rating + notes tied to a specific resource/milestone per user | 1 new table `resource_impact_reflections` | ICC §Wellbeing Resources |
| A8 | **Smile category ↔ culture behaviour statement** — `smile_categories.behaviour_statement`, `smile_categories.culture_doc_source_id` (for the eventual AI-agent ingest) | 2 columns | Company §Smiles |
| A9 | **Connect cycle objective submission window** — `connect_cycles.objective_window_days` (N days from start within which employees must upload objectives) | 1 column | Company §Performance Connect |
| A10 | **Objective approval workflow** — `performance_objectives.approval_status` (pending\|approved\|rejected\|alternative_suggested), `approved_by`, `manager_note`, `cascaded_from_objective_id` | 4 columns × 3 tables (perf/dev/wellbeing) | Company §Performance Connect |
| A11 | **Communication templates** — rename semantic: one unified `communication_templates` table keyed by event (email / in-app notification / WhatsApp / nudge). Channel + trigger enum, company override layer | 2 new tables `communication_templates`, `communication_template_company_overrides` | ICC §Email Templates |
| A12 | **RBAC module enum expansion** — `role_permissions.module` currently caps at 8 values; notes need every ICC + company module covered at view/add/edit/delete grain | CHECK constraint rewrite | ICC §Admin Users, Company §HR |
| A13 | **ICC admin role permissions** — no equivalent of `role_permissions` exists on the `icc_admins` side; super-admin can only be distinguished by the flat `role` string column | 2 new tables `icc_roles`, `icc_role_permissions` | ICC §Admin Users |
| A14 | **Training + certification renewal alerts** — need a scheduled-job surface: `certification_renewal_alerts` (user_id, cert_id, fire_at, sent_at, channel) or just a query + cron | 1 new table *or* scheduler job spec | Company §My Profile |
| A15 | **Client self-registration public link** — `client_registrations` already exists; add `intake_token`, `intake_token_expires_at`, `intake_source` (public_link\|direct_invite), `rejection_reason` | 4 columns | ICC §Client Registrations |
| A16 | **Growth snapshot materialized view** — optional perf optimization: `mv_user_growth_snapshot` rolling up perf/dev/wellbeing connect completion % | 1 materialized view | Company §Home |

→ All of the above delivered as a new file: **`docs/schema-additions.sql`** (to be written in Phase 2 — not in this initial drop).

---

## B. Epic list — prioritized

Each epic lists the touched layers. **BE** = backend route, **FE-C** = company HTML, **FE-A** = ICC admin HTML, **DB** = schema change, **UX** = UI spec.

### Phase 0 — Foundation (blocks most of the rest)

| ID | Epic | Layers | Depends on | Effort |
|---|---|---|---|---|
| P0-1 | **Full RBAC rebuild** — expand module enum, add ICC-side role_permissions, wire a middleware gate `requirePermission(module, action)` used by every route | DB, BE, FE-C, FE-A | — | L (see `01-rbac-spec.md`) |
| P0-2 | **Unified Indicator / Survey / Pulse-Check engine** — one builder, three modalities (indicator = scored + verbiage report, survey = raw-data + demographics, pulse = short repeatable org-push) | DB, BE, FE-A, FE-C | — | XL (see `02-indicator-survey-spec.md`) |
| P0-3 | **Connect Cycles v2** — submission windows, cascade, approval, consolidation conversation, sign-off, downloadable PDF report, hierarchy visibility | DB, BE, FE-C | P0-1 | L (see `03-connect-cycles-spec.md`) |
| P0-4 | **Client self-registration flow** — public intake link, ICC approve/reject with email, subscription tier assignment, employee-limit enforcement | DB, BE, FE-A | — | M |

### Phase 1 — Company App frontend alignment

| ID | Epic | Layers | Depends on | Effort |
|---|---|---|---|---|
| P1-1 | Home: add Growth snapshot + connect-cycle completion cards | BE (new `/api/growth/snapshot`), FE-C | P0-3 | S |
| P1-2 | Home: leaderboards — challenges + smiles (with category breakdown) | BE, FE-C | — | S |
| P1-3 | Home: ICC-pushed pulse check card + org-custom pulse | BE, FE-C | P0-2 | S |
| P1-4 | My Profile → full HRIS profile — tabs for Personal, Employment, Documents (with missing-doc flags), Training (self-report), Certifications (with renewal nudging), Custom Fields rename → "HR Information" | BE, FE-C | — | L |
| P1-5 | My Profile → public directory view — admin-controlled field visibility; employee directory list on home with click-through | DB (visibility_settings), BE, FE-C | P1-4 | M |
| P1-6 | My Wellbeing → downloadable reports archive, nudge-to-resource, connect-objective progress | BE, FE-C | P0-2, P0-3 | M |
| P1-7 | Wellbeing Indicators & Resources → category-first UI (4 hero boxes → hover → assessments) | FE-C | — | S |
| P1-8 | Professional Connect → module visibility gated on `professionals_enabled`, rename "cases" → "sessions" | BE guard, FE-C | P0-1 | S |
| P1-9 | EAP page — new menu item under Wellbeing, company-admin editable content | DB, BE, FE-C | — | M |
| P1-10 | Social Wall rebuild — media upload, comments on comments, audience targeting (org/BU/dept/user), compliance ack, per-employee post feed, own-posts view | DB, BE, FE-C | — | L |
| P1-11 | Smiles — surface behaviour statement per category, leaderboard by category | BE, FE-C | A8 | S |
| P1-12 | Events — audience targeting, calendar (ICS) attach, email/WhatsApp invite, notification card | BE, FE-C | A11 | M |
| P1-13 | Surveys — company-side builder + raw-data export + demographic anonymity toggle | BE, FE-C | P0-2 | M |
| P1-14 | Learning Sessions — company-side authoring parity with ICC, view-only streaming from ICC bucket, completion dashboard | BE, FE-C | — | M |
| P1-15 | Wellbeing Challenges — company-side authoring parity; leaderboard redesign (cards not tables) | BE, FE-C | P0-1 | M |
| P1-16 | HR section → dashboards/org-chart; move Staff Management under Settings | BE, FE-C | P1-4 | M |

### Phase 2 — ICC Admin alignment

| ID | Epic | Layers | Depends on | Effort |
|---|---|---|---|---|
| P2-1 | Dashboard — adoption per module (not just wellbeing): social wall, smiles, perf/dev/wellbeing connect, surveys. Drill-down per org | BE, FE-A | — | M |
| P2-2 | Client Registrations UI — name/surname split, full module list, subdomain capture, address API, tier assignment, renewal flags | BE, FE-A | P0-4 | M |
| P2-3 | Indicator Builder UI — category selector up-front, section ranges + report-verbiage editor, retake rules, assign-to-all-orgs shortcut | BE, FE-A | P0-2 | L |
| P2-4 | Survey Builder UI — separate from indicator builder; raw-data export path | BE, FE-A | P0-2 | M |
| P2-5 | Learning Sessions — category from indicator taxonomy, banner, link-to-share, recordings hosted on ICC side only (card links back to ICC view-only) | BE (signed-view), FE-A | — | M |
| P2-6 | Professionals — full invite + registration form; session outcome fields | BE, FE-A | — | M |
| P2-7 | Challenges — category, theme, custom challenge types, badge-add logic documented | BE, FE-A | — | S |
| P2-8 | Communication Templates — rename + unify (email + in-app + WhatsApp + nudge) + trigger catalogue | DB, BE, FE-A | A11 | L |
| P2-9 | Analytics — per-org and cross-org views; anonymized wellbeing data exports; foundation for an AI-agent layer (descriptive → prescriptive → predictive) | BE, FE-A | P0-2 | XL |
| P2-10 | ICC Admin Users — wire role_permissions UI (P0-1's ICC side) | BE, FE-A | P0-1 | M |

### Phase 3 — AI / automations (stretch)

| ID | Epic | Notes |
|---|---|---|
| P3-1 | Contract-upload AI agent → auto-populate employee HRIS fields | separate service, calls LLM with contract OCR |
| P3-2 | Culture-document AI agent → suggest Smile categories + behaviour statements | same infra |
| P3-3 | ICC analytics AI agent — RAG over anonymized indicator responses per-org | same infra |

---

## C. Cross-cutting concerns (apply to every epic)

1. **Anonymity guarantees in wellbeing reports** — every query that returns indicator response data to anyone other than the participant themselves must strip `user_id` before aggregation. Document this in a single `src/utils/anonymize.js` and use it everywhere. Enforced by unit test.
2. **Subscription gate** — before any module route responds, check `module_subscriptions.is_enabled` for the requesting company. Centralize in middleware.
3. **Employee limit enforcement** — on `POST /api/hris/employees` and bulk upload, check count vs tier.
4. **Per-company theming** — surface on login page before auth by looking up company by subdomain.
5. **Hierarchy visibility** — reports viewable by employee, their manager, and the full upward chain. Build a recursive CTE helper once; reuse.

---

## D. Delivery plan (what gets built when)

Given "separate new files only", here's the pattern for each epic:

```
well-minds-v2/
├── docs/                          ← planning artifacts (this drop)
│   ├── 00-ROADMAP.md              (this file)
│   ├── 01-rbac-spec.md
│   ├── 02-indicator-survey-spec.md
│   └── 03-connect-cycles-spec.md
├── schema/
│   └── v2-migrations.sql          ← all A1–A16 schema deltas (not in this drop)
├── src/
│   ├── middleware/
│   │   ├── requirePermission.js   ← new RBAC gate
│   │   ├── requireModule.js       ← subscription gate
│   │   └── resolveSubdomain.js    ← tenant resolution
│   ├── routes/
│   │   ├── v2-pulse-checks.js
│   │   ├── v2-communication-templates.js
│   │   ├── v2-eap-pages.js
│   │   ├── v2-growth-snapshot.js
│   │   ├── v2-leaderboards.js
│   │   └── v2-connect-cycles.js   ← consolidation / sign-off / PDF
│   ├── services/
│   │   ├── indicatorReportGenerator.js
│   │   ├── anonymize.js
│   │   └── hierarchyVisibility.js
│   └── index.v2.js                ← new entrypoint mounting all v2 routes in addition to v1
└── public/
    ├── wellminds-app.v2.html      ← rebuild or partial-wire
    └── icc-admin.v2.html          ← rebuild or partial-wire
```

Nothing in `well-minds/` (the original folder) gets edited. v2 routes mount alongside v1 in a new `index.v2.js`; switching over is a server-config flip, not a code surgery.

---

## E. Suggested first slice (if we ship one epic to prove the shape)

**P0-4 + P2-2 (Client Self-Registration end-to-end).** Why:

- Touches everything (DB column adds, new public route, email template, ICC admin approve/reject UI, tier assignment, subdomain capture) — validates the v2 delivery pattern.
- Doesn't block on RBAC or indicator rebuilds.
- Unlocks clean onboarding for new orgs immediately.

Or — if you'd rather start where the user-facing pain is most visible:

**P0-2 + P2-3 (Indicator builder with section ranges + verbiage).** Why:

- The notes call this out explicitly as "missing in the AI version".
- The schema additions are isolated (just `indicator_section_ranges`).
- Produces a visible, demonstrable improvement on day one.

---

## F. Open questions — please confirm before Phase 2 begins

1. **Hosting of videos / recordings** — the notes say recordings should "sit on ICC admin" and not be downloadable. Signed URLs from a private S3 bucket? Or stream via a backend proxy? What object-store will we assume?
2. **WhatsApp delivery** — which provider? (Meta Cloud API direct, Twilio, or a message-orchestration platform?)
3. **Subdomain strategy** — wildcard TLS on `*.icc.interbeingleadership.com` acceptable? Or do we also need to support custom apex domains per enterprise client?
4. **360-feedback** — the notes say the full form model is TBD. Ship it as a phase-2 epic with a separate spec?
5. **AI agents (P3-1, P3-2, P3-3)** — scope out as separate project? All three share the same LLM-call infra but each has its own data contract.
6. **Contract-upload OCR** — accepted file types (PDF, DOCX, scanned-image)? Confidence threshold before auto-filling?

---

*See companion docs for detailed specs on the three foundation epics:*

- **`01-rbac-spec.md`** — RBAC rebuild
- **`02-indicator-survey-spec.md`** — Unified indicator / survey / pulse-check engine
- **`03-connect-cycles-spec.md`** — Connect Cycles v2
