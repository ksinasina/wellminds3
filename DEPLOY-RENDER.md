# Deploy to Render — step-by-step

## Prerequisites
- GitHub account
- Render account (free — https://render.com)

## 1. Push to GitHub

```bash
cd wellminds-repo
git init
git add .
git commit -m "Initial deploy"
git branch -M main

# Create an EMPTY repo on github.com (no README/gitignore there), then:
git remote add origin <YOUR_REPO_URL>
git push -u origin main
```

## 2. Deploy on Render

1. Go to https://dashboard.render.com
2. **New +** → **Blueprint**
3. Connect GitHub (first time only) → select your `wellminds` repo
4. Render reads `render.yaml` and shows: 1 web service + 1 Postgres DB
5. Click **Apply**

First deploy takes ~4–6 minutes. In the Logs tab you should see:
```
[bootstrap] v1-schema applied OK
[bootstrap] v2-schema applied OK
[bootstrap] seed completed
[bootstrap] server starting index-v2.js
[server] WellMinds v2 API listening on port 3001
```

## 3. Share URLs

Dashboard → your service → copy the public URL.

```
https://<your-app>.onrender.com/demo         ← Company app
https://<your-app>.onrender.com/demo/icc     ← ICC Admin
```

Login:
- Company: `liz@demo.interbeing.care` / `Demo@123456`
- ICC: `icc@interbeing.care` / `Demo@123456`

## After first deploy

- **Auto re-deploy** on every `git push origin main`
- **SEED_ON_BOOT=true** — safe, uses `ON CONFLICT DO NOTHING`. Set `false` in Render → Environment to stop re-seeding
- **Free tier sleeps** after 15 min inactivity; first request takes ~30s. Upgrade to $7/mo for always-on

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails | Check Node ≥ 18 in Render settings |
| `/api/v2/*` returns 404 | Check Logs; bootstrap must show `server starting` |
| DB errors | Redeploy; Render auto-wires `DATABASE_URL` |

## Rollback

Render → Settings → change Start Command to `node well-minds/src/index.js` → redeploy.
V2 disappears; v1 keeps working.
