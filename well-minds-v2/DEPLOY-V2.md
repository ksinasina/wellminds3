# WellMinds v2 — Deployment & Demo Guide

This folder (`well-minds-v2/`) is an **additive** layer on top of the original `well-minds/` hand-off.
Nothing in the v1 tree is modified. v2 re-uses v1's DB pool, JWT middleware, and v1 routes;
it adds new tables, new routes at `/api/v2/*`, two new demo HTML pages, and a new boot file.

```
repo/
├── well-minds/          ← v1 (untouched, read-only)
│   ├── src/
│   │   ├── index.js
│   │   ├── db.js
│   │   ├── middleware.js
│   │   └── routes/
│   └── public/
│       ├── wellminds-app.html
│       └── icc-admin.html
└── well-minds-v2/       ← v2 (this folder)
    ├── schema/schema-v2.sql
    ├── src/
    │   ├── index-v2.js          ← new entry point (runs v1 + v2 together)
    │   ├── middleware/requirePermission.js
    │   ├── services/            ← hierarchyVisibility, anonymize, indicatorReportGenerator
    │   └── routes-v2/           ← 8 new v2 route files
    ├── scripts/seed-v2.js
    ├── public/
    │   ├── wellminds-v2-demo.html
    │   └── icc-admin-v2-demo.html
    ├── docs/
    └── package.json
```

---

## 1. View the demos **without** a backend

Both demo HTMLs are self-contained. They ship with baked-in mock data and silently fall
through to mock when the API is unreachable.

```bash
# open directly in any browser
open well-minds-v2/public/wellminds-v2-demo.html        # Company side (employee + manager)
open well-minds-v2/public/icc-admin-v2-demo.html        # ICC Admin side
```

Every nav item, every table, every chart populates immediately. The **"Try live API"** pill
in the top bar toggles into fetch-mode — safe to click even if the backend isn't running, it
just logs the failure to the console and keeps showing the mocks.

Use this mode for stakeholder walkthroughs where you don't want to set up a DB.

---

## 2. Run the full stack

### 2.1 Prerequisites
- Node ≥ 18
- PostgreSQL 14+ with a database created (same one v1 uses, or a fresh one)
- A `.env` file at `well-minds/.env` with at least:
  ```
  DATABASE_URL=postgres://user:pass@localhost:5432/wellminds
  JWT_SECRET=change-me
  NODE_ENV=development
  PORT=3001
  CORS_ORIGINS=http://localhost:3000,http://localhost:5173
  ```

### 2.2 Install
```bash
cd well-minds
npm install                    # v1 deps
cd ../well-minds-v2
npm install                    # v2 deps (subset of v1's)
```

### 2.3 Migrate
```bash
# from well-minds-v2/
npm run db:migrate-v2          # applies schema-v2.sql (creates 25+ new tables, permission_modules, roles, etc.)
```

Or manually:
```bash
psql $DATABASE_URL -f schema/schema-v2.sql
```

The migration is additive. Re-running is safe (uses `CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and `ON CONFLICT DO NOTHING` for seed-like rows).

### 2.4 Seed demo data
```bash
# optional but recommended for realistic demos
npm run db:seed-v2
```

What this creates (all idempotent — safe to re-run):
- **Demo Co** company with subdomain `demo`, EAP enabled
- **Hierarchy**: CEO (Amara) → 2 managers (Ben, Priya) → 6 employees (Liz, Dan, Mo, Sana, Leo, Kai). Password for everyone: `Demo@123456`
- **Wellbeing indicator** with 3 sections × 3 questions, teal/amber/coral bands, narrative verbiage
- **Connect cycle** "FY26 H1" with 3 reflection periods in varied signoff states
- **Social wall** with 5 posts + 1 compliance post
- **EAP** configured with 4 services
- **Pulse submissions** across 4 days × 9 users (clears the 5-respondent anonymity threshold)
- **Communication templates** — 10 templates across email/in-app/WhatsApp/nudge
- **Smiles** — 3 culture categories × 6 pair smiles

### 2.5 Run
```bash
# from well-minds-v2/
npm start                      # boots on :3001 — v1 + v2 routes + both demo sets
```

You should see:
```
[server] WellMinds v2 API listening on port 3001
[server] Demo app:   http://localhost:3001/demo
[server] ICC demo:   http://localhost:3001/demo/icc
[server] V1 app:     http://localhost:3001/app
[server] V1 admin:   http://localhost:3001/admin
```

### 2.6 Try the live API from the demo
1. Open `http://localhost:3001/demo`
2. Sign in (the demo page auto-authenticates with mock creds — or use `liz@demo.interbeing.care` / `Demo@123456` via `/app` first)
3. Click the **"Try live API"** pill in the top bar
4. The pulse check, indicator report, connect cycle, and social wall will now hit `/api/v2/*` and render real DB data. If a call fails, the page silently keeps the mock — stakeholders never see a broken screen.

---

## 3. What each v2 route does

| Mount | File | Key endpoints |
|---|---|---|
| `/api/v2/rbac` | `routes-v2/rbac.js` | Modules, roles CRUD, permission matrix, `/me`, ICC equivalents under `/icc/` |
| `/api/v2/pulse` | `routes-v2/pulse-checks.js` | `/active` (company > global fallback), `/:id/submit`, `/:id/results` (anonymity-gated), create |
| `/api/v2/indicator-ranges` | `routes-v2/indicator-ranges.js` | Upsert section + overall ranges, `GET /completion/:id/report` (runs the narrative generator) |
| `/api/v2/growth` | `routes-v2/growth-leaderboards.js` | `/me`, `/team/:managerId`, `/leaderboard` (respects `leaderboard_opt_in`), `/progress/:userId` |
| `/api/v2/eap` | `routes-v2/eap.js` | EAP page upsert, services CRUD |
| `/api/v2/connect` | `routes-v2/connect-signoff.js` | Objective approval, cascade, reflection consolidate, sign-off (employee/manager/functional), signoff revoke, grant-view, reports per user-cycle |
| `/api/v2/communication-templates` | `routes-v2/communication-templates.js` | Global templates + per-company overrides merged via `COALESCE` |
| `/api/v2/social-wall` | `routes-v2/social-wall-v2.js` | Audience-filtered feed (all/team/department/custom), compliance ack, nested comments |

---

## 4. Deploy checklist

- [ ] Run `npm run db:migrate-v2` in every environment (dev, staging, prod)
- [ ] Set `CORS_ORIGINS` to include your public demo URL
- [ ] Point your load balancer to `well-minds-v2/src/index-v2.js` (replaces `well-minds/src/index.js`)
- [ ] All v1 endpoints keep working — the mount paths `/api/*` are unchanged
- [ ] V1 HTML stays reachable at `/app` and `/admin`; v2 HTML at `/demo` and `/demo/icc`
- [ ] Seed data is idempotent but **should not** be run in production — it creates the "Demo Co" company
- [ ] Permission cache TTL is 60 seconds (in `requirePermission.js`) — bump if you see slow propagation
- [ ] Anonymity threshold is `5` respondents (in `services/anonymize.js`) — adjust `MIN_BUCKET` if your client requires stricter
- [ ] The indicator report narrative HTML is inserted unescaped — keep the editor locked down to trusted ICC admins

---

## 5. Rollback

v2 is fully additive, so rollback is simple:
1. Revert the load balancer target back to `well-minds/src/index.js`
2. The new tables stay in the DB (harmless) or drop them with the "teardown" block at the end of `schema/schema-v2.sql`
3. V1 is untouched and continues to serve `/api/*` exactly as before

---

## 6. Known gaps & next-phase work

- File uploads (media_url on posts, profile images) still write to disk via v1's multer setup — migrate to S3 in phase 2
- Connect-cycle scheduler (auto-advance phases at deadline) is a stub — wire into a cron job
- Growth leaderboard view `v_user_growth_snapshot` is computed on each read — add a materialized view once volume grows
- ICC-side impersonation flow uses v1 JWT issuance — add scoped JWT for audit trail
- WhatsApp + nudge delivery templates are stored but delivery adapters are not wired — plug into Twilio / OneSignal in phase 2

---

## 7. Support

All v2 code lives under `well-minds-v2/src/`. Spec docs are in `well-minds-v2/docs/`.
If something breaks, first check:
1. `npm run db:migrate-v2` completed without error
2. `.env` in `well-minds/` is reachable (v2 reads from the sibling folder)
3. V1 still starts on its own with `cd well-minds && npm start` — if v1 is broken, v2 will be too
