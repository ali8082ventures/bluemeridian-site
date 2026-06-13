# Blue Meridian — Ambassador Backend & Dashboard: Release Guide

This deploys three things to your existing production droplet:
1. The backend service (applications, referral attribution, admin API)
2. The admin dashboard at https://api.bluemeridian.ai/admin
3. The HubSpot custom properties (one-time script)

It also updates ambassador.html so the application form is real.

---

## What's in the bm-backend folder

| File | Purpose |
|---|---|
| `setup-hubspot.js` | One-time script: creates ALL Blue Meridian custom properties in HubSpot (the original set + the new ambassador ones). Safe to re-run. |
| `server.js` | The backend service. |
| `public/dashboard.html` | The admin dashboard UI. |
| `package.json` | Dependencies (just Express) and start scripts. |
| `.env.example` | Template for the secrets file. Copy to `.env` ON THE SERVER and fill in. |
| `.gitignore` | Stops `.env` and `node_modules` ever reaching GitHub. |

**Never put the HubSpot token or admin key into GitHub or into chat. They live only in `.env` on the server.**

---

## Step 1 — HubSpot Private App token (browser)

HubSpot → Settings (gear) → Integrations → Private Apps → your app (or Create).
Under **Scopes**, make sure ALL of these are ticked:

- `crm.objects.contacts` — Read AND Write
- `crm.objects.deals` — Read AND Write
- `crm.schemas.contacts` — Read AND Write
- `crm.schemas.deals` — Read AND Write

(The `schemas` ones let the setup script create properties.) Copy the token — you'll type it into the server in Step 4.

## Step 2 — Upload to GitHub (browser)

In your **bluemeridian-site** repo:
1. **Add file → Upload files** → drag the whole **bm-backend folder** in → Commit.
2. Upload the new **ambassador.html**, replacing the old one → Commit.

## Step 3 — DNS (browser)

Add an A record: Hostname **api** → **167.99.92.235** (same as you did for `ambassador`).

## Step 4 — On the PRODUCTION server

Prompt must read `deploy@bluemeridian-production`. Then paste Block A (pull + install):

```bash
SITE_DIR=$(dirname "$(sudo find /var/www -maxdepth 3 -name ".git" | head -1)")
cd "$SITE_DIR" && git pull
node -v || (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs)
cd "$SITE_DIR/bm-backend"
npm install
cp -n .env.example .env
nano .env
```

`nano` opens the secrets file. Replace the two placeholder values:
- `HUBSPOT_TOKEN=` your token from Step 1
- `ADMIN_KEY=` a long password you invent (this opens the dashboard — treat it like a bank password)

Save and exit nano: **Ctrl+O, Enter, Ctrl+X**.

Then Block B (create HubSpot properties + start the service permanently):

```bash
npm run setup-hubspot
sudo npm install -g pm2
pm2 start server.js --name bm-backend --cwd "$PWD" --node-args="--env-file=.env"
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u deploy --hp /home/deploy
pm2 save
curl -s http://127.0.0.1:3001/health
```

You want the setup script to print `[ok] created ...` (or `[skip] already exists`) lines, and the last line to print `{"ok":true,"service":"bm-backend"}`.

Then Block C (put it on the internet — only after the `api` DNS record from Step 3 exists):

```bash
sudo tee /etc/nginx/sites-available/api.bluemeridian.ai > /dev/null << 'NGINX'
server {
    listen 80;
    server_name api.bluemeridian.ai;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/api.bluemeridian.ai /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.bluemeridian.ai --non-interactive --agree-tos -m ali@8082.ventures --redirect
```

## Step 5 — Test the whole loop (browser)

1. **https://api.bluemeridian.ai/health** → should show `{"ok":true,...}`
2. **https://ambassador.bluemeridian.ai** → submit a test application with your own email
3. **https://api.bluemeridian.ai/admin** → enter your ADMIN_KEY → your application is under "Pending applications"
4. Click **Activate ambassador** → copy the referral link it gives you
5. Check HubSpot → Contacts → you'll see yourself with the Blue Meridian ambassador fields filled in

## Day-to-day operation

- **Applications** arrive in the dashboard (and in HubSpot). Activate the good ones, send them their link.
- **Attribution** is automatic: visitors via `bluemeridian.ai/?ref=CODE` are remembered for 90 days (once the referral snippet is added to index.html — see referral-snippet.html).
- **When a deal closes**, in HubSpot set the deal to Closed Won, fill **Amount** (gross charter value) and **BM — Blue Meridian profit on this deal**. The dashboard does all tier/commission/override math from those two numbers.
- **Monthly payouts**: open the dashboard, the "Total owed (12m)" column and the monthly table give you everything for bank transfers. (A dedicated per-month statement view is a good next iteration.)

## Updating the backend later

GitHub upload → on production: `cd $SITE_DIR && git pull && pm2 restart bm-backend`.
