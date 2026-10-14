# Putting Whot Table live (frontend + backend in one service)

Your Node server serves the pages AND the WebSocket on one domain, so you deploy one thing.

## 1. Test on your computer
    npm install
    npm run dev          # same as: node --env-file=key.env server.js
Open http://localhost:3000, make two accounts in two browsers, tap Play Online in both.

## 2. Protect secrets
- key.env is in .gitignore. Never upload it. Because it was shared during development, change ADMIN_KEY to a new 24+ character random value.

## 3. GitHub
    git init
    git add .
    git commit -m "whot"
    git branch -M main
    git remote add origin <your private repo url>
    git push -u origin main

## 4. Deploy on Render (paid "Starter" plan: needed for the disk, and it never sleeps)
1. Render dashboard > New > Blueprint > pick your repo. render.yaml sets everything up.
2. When asked, type a value for ADMIN_KEY.
3. Deploy. Open the https://....onrender.com address and test.
The database lives on the disk at /var/data/whot.sqlite, so deploys keep accounts and chips.
Run ONE instance only (SQLite + in-memory tables cannot be shared across instances).

## 5. Domain
Render > your service > Settings > Custom Domains. Add DNS records they show. HTTPS is automatic (needed for mic and installing the app).

## 6. Recovery codes (optional but recommended)
With NODE_ENV=production the server never shows codes on screen, so email/phone verification only works once a provider is set.
- Email: set SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM (Brevo, Resend, Mailgun all give SMTP).
- Phone: server.js supports Twilio only: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.

## 7. Voice chat
Add a TURN server in social.js (the commented line near the top), or players on some mobile networks will not hear each other.

## 8. Final checks
- Two real phones on mobile data: register, Play Online, voice.
- https://yourdomain/admin : enter ADMIN_KEY to see earnings.
- UptimeRobot on /healthz. Download a copy of /var/data/whot.sqlite regularly (Render disk snapshots help too).

## 9. Updating
git push and Render redeploys. Live games are refunded their stake on restart, so deploy at quiet times. If you change front-end files, raise V in sw.js.

## Legal
Staked games with Buy/Withdraw count as gaming in Nigeria. Deposits and withdrawals are currently disabled in server.js, which is the safe state until you have a licence and legal advice.
