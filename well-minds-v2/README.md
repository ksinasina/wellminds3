# WellMinds v2 — additive hand-off

This is a **new sibling folder** to the original `well-minds/` hand-off. It
adds the v2 modules described in the two spec docs (ICC Admin + Company App)
without touching a single file in v1.

```
well-minds/           ← original hand-off (read-only)
well-minds-v2/        ← you are here
```

## Open the demos right now — no backend needed

```bash
open well-minds-v2/public/wellminds-v2-demo.html   # Company side
open well-minds-v2/public/icc-admin-v2-demo.html   # ICC Admin side
```

Both files are self-contained. Every screen populates from baked-in mock data.
Click the **"Try live API"** pill in the top bar to upgrade to fetch-mode — if
a backend is running, calls hit `/api/v2/*`; otherwise the page silently keeps
showing mocks so stakeholders never see a broken screen.

## Run the full stack

See [`DEPLOY-V2.md`](./DEPLOY-V2.md) for the step-by-step. Short version:

```bash
cd well-minds-v2
npm install
npm run db:migrate-v2          # applies schema-v2.sql (additive, idempotent)
npm run db:seed-v2             # seeds Demo Co with realistic data
npm start                      # boots v1 + v2 routes on :3001
```

Then:
- `http://localhost:3001/demo` — new company app (v2 demo)
- `http://localhost:3001/demo/icc` — new ICC admin (v2 demo)
- `http://localhost:3001/app` — original company app (v1, unchanged)
- `http://localhost:3001/admin` — original ICC admin (v1, unchanged)

Demo login (after seeding):
- Company employee: `liz@demo.interbeing.care` / `Demo@123456`
- ICC admin: `icc@interbeing.care` / `Demo@123456`

## What's new in v2

Eight new API mount points under `/api/v2/*`, backed by 19 new tables and 3
new services:

| Spec | Feature | Route |
|---|---|---|
| 01 | RBAC (company + ICC) with permission modules, role CRUD, matrix, `/me` | `/api/v2/rbac` |
| 02 | Indicator narrative engine — section + overall band verbiage + recommended resources | `/api/v2/indicator-ranges` |
| 03 | Connect cycles — objectives with approval/cascade, reflection consolidate, multi-party sign-off | `/api/v2/connect` |
| A1 | Pulse checks — unified engine (ICC-global + company), anonymity gate ≥5 respondents | `/api/v2/pulse` |
| A2 | Growth leaderboards — hierarchy-visible, opt-in | `/api/v2/growth` |
| A3 | EAP — company-level page + services CRUD | `/api/v2/eap` |
| A4 | Communication templates across email / in-app / WhatsApp / nudge with per-company overrides | `/api/v2/communication-templates` |
| A5 | Social wall v2 — audience targeting (all / team / department / custom), compliance ack | `/api/v2/social-wall` |

## Folder map

```
well-minds-v2/
├── README.md                   ← this file
├── DEPLOY-V2.md                ← full deploy runbook
├── package.json
├── docs/                       ← specs (roadmap + 3 spec docs)
│   ├── 00-ROADMAP.md
│   ├── 01-rbac-spec.md
│   ├── 02-indicator-survey-spec.md
│   └── 03-connect-cycles-spec.md
├── schema/
│   └── schema-v2.sql           ← 19 new tables, 10 ALTERs, 6 indexes, v_user_growth_snapshot view
├── src/
│   ├── index-v2.js             ← boots v1 + v2 routes together
│   ├── middleware/
│   │   └── requirePermission.js
│   ├── services/
│   │   ├── hierarchyVisibility.js
│   │   ├── anonymize.js
│   │   └── indicatorReportGenerator.js
│   └── routes-v2/              ← 8 route files (one per /api/v2/* mount)
├── scripts/
│   └── seed-v2.js              ← idempotent demo data (Demo Co, 9 users, full cycle)
└── public/
    ├── wellminds-v2-demo.html  ← company side (employee + manager)
    └── icc-admin-v2-demo.html  ← ICC admin side
```

## Contract with v1

v2 is strictly additive:
- `well-minds/` is never modified.
- v2 reads v1's DB pool via `require('../../well-minds/src/db')`.
- v2 reuses v1's JWT middleware (`authenticate`, `authenticateICC`) for v2-route auth.
- New v2 routes mount under `/api/v2/*` — v1's `/api/*` endpoints keep working.
- If you revert the load balancer to `well-minds/src/index.js`, v2 disappears cleanly.

Full checklist and rollback in `DEPLOY-V2.md`.
