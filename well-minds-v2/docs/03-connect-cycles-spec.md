# Spec 03 — Connect Cycles v2 (Performance / Development / Wellbeing)

**Roadmap epic:** P0-3
**Status:** Draft v1 — for review

## Motivation

The Company App notes describe a multi-phase cycle workflow that the schema already ~70% supports but the routes don't orchestrate as a coherent process. The missing *user-visible* pieces:

- A clear **cycle timeline widget** showing which milestone the employee is in.
- **Objective-submission windows** (e.g. cycle opens 1 Jan → objectives must be added by 7 Jan).
- **Manager approval / rejection / alternative-suggestion** on objectives.
- **Manager → employee cascade** of the manager's objective.
- **Consolidation conversation** (explicit step, even when employee and manager agreed).
- **Sign-off** — employee + manager + functional manager (already partly in schema).
- **Downloadable PDF report** — visible to employee, full upward hierarchy, and users granted explicit view.
- **Ad-hoc notes** — capture 1:1 conversations outside of formal reflections.
- **Wellbeing cycle visibility toggle** — employee decides whether their manager sees wellbeing objectives.

## Phase model

All three modules (performance / development / wellbeing) share the same phase progression:

```
1. Setup        → employee creates objectives (within submission window)
2. Self-reflect → employee fills reflections at each reflection period
3. Manager      → manager fills reflections; adds status + rating
4. Stakeholder  → peer / functional-manager / solicited feedback
5. Consolidate  → manager + employee align on final status/rating per objective
                  (mandatory even if fully agreed)
6. Sign-off     → employee signs → manager signs → functional manager signs
7. Report       → auto-generated downloadable PDF
```

The `performance_reflections` table already has: `is_consolidated`, `consolidated_notes`, `final_agreed_status_id`, `final_agreed_rating_id`, `employee_signed_off`, `manager_signed_off`, `functional_manager_signed_off`. The `development_reflections` and `wellbeing_reflections` tables should mirror this (check and add if missing).

## Schema deltas

```sql
-- Objective submission window (per cycle)
ALTER TABLE connect_cycles
  ADD COLUMN IF NOT EXISTS objective_window_days INTEGER DEFAULT 14,
  ADD COLUMN IF NOT EXISTS allow_late_add_after_close BOOLEAN DEFAULT FALSE;

-- Reflection schedule (derived or explicit). Explicit is cleaner:
CREATE TABLE IF NOT EXISTS cycle_reflection_periods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cycle_id UUID NOT NULL REFERENCES connect_cycles(id) ON DELETE CASCADE,
  label VARCHAR(100) NOT NULL,             -- 'Q1','Q2','Month 3','H1'
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(cycle_id, label)
);

-- Approval workflow columns on objectives (apply to all three modules)
ALTER TABLE performance_objectives
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending',
    -- pending | approved | rejected | alternative_suggested
  ADD COLUMN IF NOT EXISTS manager_note TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cascaded_from_objective_id UUID REFERENCES performance_objectives(id);

ALTER TABLE development_objectives
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS manager_note TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cascaded_from_objective_id UUID REFERENCES development_objectives(id);

ALTER TABLE wellbeing_objectives
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS manager_note TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cascaded_from_objective_id UUID REFERENCES wellbeing_objectives(id),
  ADD COLUMN IF NOT EXISTS share_with_manager BOOLEAN DEFAULT FALSE;
  -- notes §Wellbeing Connect: employee chooses whether to grant manager view

-- Hierarchy visibility grants — explicit allow-list beyond auto upward chain
CREATE TABLE IF NOT EXISTS objective_visibility_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module_type VARCHAR(20) NOT NULL,        -- performance | development | wellbeing
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- owner of the report
  granted_to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Signoff audit (richer than booleans — tracks who, when, from which client)
CREATE TABLE IF NOT EXISTS reflection_signoffs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module_type VARCHAR(20) NOT NULL,        -- performance | development | wellbeing
  reflection_id UUID NOT NULL,             -- polymorphic by module_type
  role VARCHAR(50) NOT NULL,               -- 'employee' | 'manager' | 'functional_manager'
  user_id UUID NOT NULL REFERENCES users(id),
  signed_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address INET,
  note TEXT
);
```

## Hierarchy visibility — recursive CTE helper

New utility `src/services/hierarchyVisibility.js`. One function returns every user who can view a given employee's connect report: the employee themselves, everyone upward in `users.manager_id` chain, `functional_manager_id`, and explicit `objective_visibility_grants`.

```sql
WITH RECURSIVE upward AS (
  SELECT u.id, u.manager_id FROM users u WHERE u.id = $1
  UNION
  SELECT u.id, u.manager_id FROM users u JOIN upward ON u.id = upward.manager_id
)
SELECT id FROM upward
UNION
SELECT functional_manager_id FROM performance_reflections WHERE user_id = $1 AND functional_manager_id IS NOT NULL
UNION
SELECT granted_to_user_id FROM objective_visibility_grants
  WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW());
```

## Route surface

```
# Cycle config (admin)
POST   /api/v2/connect/cycles                       # create (ties to company)
POST   /api/v2/connect/cycles/:id/reflection-periods
POST   /api/v2/connect/cycles/:id/activate

# Objectives
POST   /api/v2/connect/:module/objectives           # employee add
POST   /api/v2/connect/:module/objectives/from-template/:tid
POST   /api/v2/connect/:module/objectives/:oid/cascade   # manager: cascade own objective to team
PATCH  /api/v2/connect/:module/objectives/:oid/approval  # approve | reject | suggest-alternative

# Reflections
POST   /api/v2/connect/:module/reflections                 # employee self
PATCH  /api/v2/connect/:module/reflections/:id/manager     # manager's take
POST   /api/v2/connect/:module/reflections/:id/stakeholder-request
POST   /api/v2/connect/:module/reflections/:id/stakeholder-response/:token

# Consolidation + sign-off
PATCH  /api/v2/connect/:module/reflections/:id/consolidate
POST   /api/v2/connect/:module/reflections/:id/signoff       # body: { role }
GET    /api/v2/connect/:module/reports/:userId/:cycleId      # PDF + on-screen
POST   /api/v2/connect/:module/reports/:userId/:cycleId/grant-view # explicit allow-list

# Employee progress widget
GET    /api/v2/connect/progress/:userId                      # { performance: {...}, development: {...}, wellbeing: {...} }
  # returns per-module: cycle_id, current_phase (setup|self|manager|stakeholder|consolidate|signoff),
  # % complete, next_action_for_user
```

## Timeline widget (frontend)

One component rendered on the home page and inside each connect module. Horizontal rail of 6 steps, with current step highlighted and past steps checked. Clicking a step routes to the relevant screen.

```
[ ✓ Setup ]──[ ✓ Self-Reflect ]──[ ● Manager ]──[ ○ Stakeholder ]──[ ○ Consolidate ]──[ ○ Sign-off ]
    Jan         Mar (Q1)             now         late May            mid Jun            Jun 30
```

## Wellbeing-cycle visibility toggle

On `/connect/wellbeing`, an employee sees a switch: **"Share wellbeing objectives with my manager."** Off by default. When on, `wellbeing_objectives.share_with_manager = TRUE` and the manager route unhides those objectives in the manager's view.

## PDF report shape

```
[Header: Company logo | Employee name | Cycle name | Date range]

Objectives
──────────
Category · Objective · Measure · Final status · Final rating
(rows show agreed-upon values; manager comments collapsed by default)

Reflections
───────────
Per reflection period, employee + manager narratives side-by-side.

Stakeholder feedback
────────────────────
Per stakeholder, per objective targeted, response text.

Consolidation
─────────────
Per objective where status/rating changed in consolidation: who moved, why.

Sign-offs
─────────
Employee signed · Manager signed · Functional manager signed
```

Emits the same PDF infra chosen for Spec 02.

## Dependencies

- Requires RBAC for per-module action gating (P0-1).
- Uses the same `anonymize.js` and `hierarchyVisibility.js` utilities that Spec 02 and the HR-reports work will share.

## Open questions

1. **Functional manager** concept is already in `performance_reflections` but not in the UI. Confirm scope — e.g. matrix-reporting cultures use this, others don't. Optional or always-on?
2. **Submission window late-add** — the `allow_late_add_after_close` flag lets the cycle config choose strictness. Is a manager override also needed (per employee, per objective)?
3. **360 feedback** — notes say the form model is TBD. Out of scope for this spec; treat as its own Phase 2 epic.
4. **Sign-off reversal** — can an employee revoke a sign-off before the manager signs? Current schema is boolean; `reflection_signoffs` table supports audit-trail reversals (add a `revoked_at`).
