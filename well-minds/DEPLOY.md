# Deploying WeelMinds to Railway

## Prerequisites

- A GitHub account (free) at github.com
- A Railway account (free) at railway.com (sign up with GitHub)

## Step 1: Create a GitHub Repository

1. Go to github.com/new
2. Name it `wellminds` (or whatever you like)
3. Set it to **Private**
4. Do NOT initialize with a README (we already have files)
5. Click "Create repository"

## Step 2: Push Your Code

Open Terminal on your Mac, then run these commands one by one:

```bash
# Navigate to the project folder
cd /path/to/wellminds-backend

# Copy the frontend files into the public folder
cp ../wellminds-app.html public/
cp ../icc-admin.html public/

# Initialize git
git init
git add .
git commit -m "Initial commit - WeelMinds platform"

# Connect to your GitHub repo (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/wellminds.git
git branch -M main
git push -u origin main
```

## Step 3: Deploy on Railway

1. Go to **railway.com** and sign in with GitHub
2. Click **"New Project"**
3. Select **"Deploy from GitHub Repo"**
4. Find and select your `wellminds` repository
5. Railway will detect it as a Node.js app and start building

## Step 4: Add a PostgreSQL Database

1. Inside your Railway project, click **"+ New"** (top right)
2. Select **"Database" > "Add PostgreSQL"**
3. Railway automatically creates a `DATABASE_URL` variable and links it to your app

## Step 5: Set Environment Variables

1. Click on your app service (not the database)
2. Go to the **"Variables"** tab
3. Add these variables:

```
NODE_ENV=production
JWT_SECRET=<generate-a-long-random-string>
JWT_REFRESH_SECRET=<generate-a-different-long-random-string>
CORS_ORIGINS=https://your-app.up.railway.app
```

To generate random strings, run this in your Terminal:
```bash
openssl rand -hex 32
```

Run it twice to get two different strings for JWT_SECRET and JWT_REFRESH_SECRET.

## Step 6: Run the Database Schema

1. In Railway, click on your **PostgreSQL** service
2. Go to the **"Data"** tab > **"Query"**
3. Copy the entire contents of `schema.sql` and paste it in
4. Click "Run" to create all 105 tables

## Step 7: Seed the First Admin Users

1. Back on your app service in Railway, go to **"Settings"**
2. Under the section find the **"Railway CLI"** or use the built-in terminal
3. Or, temporarily set these extra env variables and redeploy:

The easier method - run it from your local machine by connecting to the Railway database:

1. In Railway, click on PostgreSQL > **"Connect"** tab
2. Copy the `DATABASE_URL` connection string
3. On your local machine, run:

```bash
cd /path/to/wellminds-backend
npm install
DATABASE_URL="paste-the-url-here" npm run db:seed
```

This creates:
- ICC Admin: `admin@interbeingcare.com` / `Admin@123456`
- Org Admin: `orgadmin@demo.com` / `OrgAdmin@123456`

## Step 8: Get Your Live URL

1. In Railway, click on your app service
2. Go to **"Settings"** > **"Networking"**
3. Click **"Generate Domain"** to get a public URL like `wellminds-production.up.railway.app`
4. Update your `CORS_ORIGINS` env variable with this URL

## You're Live!

- **Org App:** `https://your-app.up.railway.app/app`
- **ICC Admin:** `https://your-app.up.railway.app/admin`
- **API Health:** `https://your-app.up.railway.app/health`

## Troubleshooting

**Build fails:** Check the deploy logs in Railway. Most common issue is a missing dependency - make sure all files were pushed to GitHub.

**Database connection errors:** Ensure the PostgreSQL service is linked to your app. Railway should auto-inject `DATABASE_URL` but you can verify in the Variables tab.

**CORS errors in browser:** Update the `CORS_ORIGINS` variable to match your exact Railway URL (including https://).

**Blank page on /app or /admin:** Make sure you copied the HTML files into the `public/` folder before pushing to GitHub (Step 2).
