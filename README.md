# WellMinds — Employee Wellbeing Platform

Full-stack deployment of the InterBeing Care Connect platform. Two sibling folders
(`well-minds/` = v1, `well-minds-v2/` = v2 additive modules) served from a single
Node/Express app against a shared PostgreSQL database.

## Live demo URLs (after Render deploy)

- `https://<your-app>.onrender.com/demo` — Company (employee + manager)
- `https://<your-app>.onrender.com/demo/icc` — ICC Admin
- `https://<your-app>.onrender.com/app` — v1 company app
- `https://<your-app>.onrender.com/admin` — v1 ICC admin

Demo credentials (after first seed):
- Company: `liz@demo.interbeing.care` / `Demo@123456`
- ICC Admin: `icc@interbeing.care` / `Demo@123456`

## One-click deploy

This repo ships with a `render.yaml` blueprint. On render.com:
1. **New → Blueprint** → connect GitHub → select repo → **Apply**
2. Render provisions Postgres + Node service automatically
3. First deploy migrates schemas + seeds demo data via `bootstrap.js`

See `DEPLOY-RENDER.md` for the exact clicks.

## Repo layout

```
repo/
├── render.yaml              ← Render blueprint
├── .gitignore
├── README.md                ← you are here
├── DEPLOY-RENDER.md         ← step-by-step Render deploy
├── well-minds/              ← v1 (original, untouched)
└── well-minds-v2/           ← v2 additive modules
    └── scripts/bootstrap.js ← Render entry point
```

## What's in v2

| Spec | Feature | Route |
|---|---|---|
| 01 | RBAC (company + ICC) | `/api/v2/rbac` |
| 02 | Indicator narrative engine | `/api/v2/indicator-ranges` |
| 03 | Connect cycles w/ multi-party sign-off | `/api/v2/connect` |
| A1 | Pulse checks | `/api/v2/pulse` |
| A2 | Growth leaderboards | `/api/v2/growth` |
| A3 | EAP services | `/api/v2/eap` |
| A4 | Communication templates | `/api/v2/communication-templates` |
| A5 | Social wall w/ audience targeting | `/api/v2/social-wall` |
