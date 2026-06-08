# CatSnip Session Log

## Goal
Build and deploy CatSnip volunteer SMS broadcast system on user's Optiplex with Vonage, cloudflared tunnel, and single-page admin UI.

## Constraints & Preferences
- Cheapest SMS provider (Vonage)
- Host on Optiplex (Linux Mint 22.3) via Tailscale + cloudflared tunnel
- Single-page admin UI with hash routing, light/dark mode, mobile-first CSS
- Volunteers auto-register by texting the Vonage number; replies appear in live feed
- Admin login required; admin can text the Vonage number to broadcast to all volunteers
- No build tools, vanilla JS, CDN libs (Lucide), no inline comments
- Domain is `catsnip.2hostyou.net` (not .com)
- Manage authorized SMS broadcast numbers via admin UI, not .env

## Progress
### Done
- Created project structure: Express + sql.js + @vonage/server-sdk + dotenv
- Built single-page admin UI (Broadcast, History, Volunteers, Settings views)
- Installed Node.js v22.14.0 + npm deps on Optiplex
- Added auth system: login endpoint, Bearer token middleware, login view
- Added auto-register via SMS (unknown numbers become "New Volunteer" + welcome SMS)
- Added name-update flow: new volunteers reply with their name to personalize their record; supports `NAME:` command for already-named volunteers
- Added admin SMS broadcast: designated phone numbers (in `admin_phones` DB table) can text the Vonage number to broadcast to all active volunteers
- Settings view with webhook URL copy button, Vonage setup guide, admin phone management, and report recipient management
- **Fixed admin login** — was browser cache; added `?v=1` cache-busting to CSS/JS links
- **Fixed details modal** — CSS `.modal { display: flex }` overrode `hidden` attribute; added `.modal[hidden] { display: none }`
- **Created systemd service** — `catsnip.service` enabled and running on port 3001, restarts on failure and auto-starts on boot
- **Updated Vonage credentials** — API key `c6b99c0a`, secret `dynJvcswh(BP2$vt)u` confirmed working ($2.00 balance)
- **Configured tunnel** — Cloudflare tunnel routes `catsnip.2hostyou.net` → `localhost:3001`; webhook endpoint responds 200
- **Updated branding** — logo SVGs match Catsnip Etc. cat silhouette, `favicon.ico`, page title
- **Published GitHub repo** — `https://github.com/E3RC/catsnip`
- **Admin phone management** — new `admin_phones` DB table, API CRUD routes, Settings UI to add/remove numbers
- **Daily email report structure** — `report_recipients` + `report_log` tables, `generateDailyReport()` produces text/HTML, `sendDailyReport()` uses nodemailer (sendmail or SMTP relay), POST `/api/report/send` manual trigger, Settings UI to manage recipients, scheduled delivery via `REPORT_SCHEDULE_ENABLED=true` (defaults off)

### In Progress
- (none)

### Blocked
- (none)

## Key Decisions
- Switched from Twilio to Vonage due to Twilio compliance profile wait
- Changed port from 3000 to 3001 because Inbox Zero was already on 3000
- Using cloudflared tunnel with `catsnip.2hostyou.net` (not .com)
- Using sql.js instead of better-sqlite3 to avoid native compilation
- `.env` kept out of git repo via `.gitignore`; credentials not exposed
- Using nodemailer with sendmail transport (no SMTP config needed); SMTP_HOST env vars optional for relay
- Report scheduling off by default; enable via `REPORT_SCHEDULE_ENABLED=true` in .env
- First admin number `+15743708318` (Brent) seeded into `admin_phones` table on deploy

## Next Steps
- Test report sending via Settings "Send Test" button (requires working sendmail on Optiplex)
- Configure SMTP in `.env` if sendmail is not available
- Enable scheduled delivery via `REPORT_SCHEDULE_ENABLED=true` when ready
- Test admin SMS broadcast from non-Brent numbers after adding via Settings UI
- Test full flow: admin texts number → broadcast sent → volunteers receive SMS → replies appear in feed

## Critical Context
- Server runs as systemd service: `sudo systemctl status catsnip`
- Source code lives at `C:\Scripts\catsnip` on Windows; deployed to `~/catsnip` on Optiplex
- Vonage inbound webhook URL: `https://catsnip.2hostyou.net/api/incoming-sms` (confirmed Vonage has it saved)
- Incoming SMS handler checks `admin_phones` DB table for authorized broadcast senders
- Admin phone `+15743708318` is seeded in DB as "Brent"
- Vonage API returns 200 on form-encoded POST to webhook; `req.body.Body` and `req.body.msisdn` for Vonage format
- The `$` in the Vonage secret requires escaping in shell/PowerShell
- Report email uses nodemailer — sendmail transport by default, SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM env vars for relay
- Daily report scheduled send: set `REPORT_SCHEDULE_ENABLED=true` + optional `REPORT_SEND_TIME` (default 17:00)

## Relevant Files
- `C:\Scripts\catsnip\server.js`: Express server with all API routes, auth, Vonage integration, SQLite, incoming SMS handler with admin broadcast logic, daily report generation + email + scheduling
- `C:\Scripts\catsnip\public\index.html`: single-page admin UI (login, broadcast, history, volunteers, settings views with admin phones + report management)
- `C:\Scripts\catsnip\public\assets\css\style.css`: styling with light/dark mode, mobile-first, `.modal[hidden]` fix
- `C:\Scripts\catsnip\public\assets\js\app.js`: frontend logic including auth, hash routing, polling, settings, admin phone CRUD, report recipient CRUD + send
- `C:\Scripts\catsnip\public\favicon.ico`: cat silhouette favicon
- `C:\Scripts\catsnip\SESSION.md`: this file — session state log
- `~/catsnip/.env` on Optiplex: admin credentials, Vonage API key/secret, port 3001
- `/etc/systemd/system/catsnip.service`: systemd unit for server auto-start
