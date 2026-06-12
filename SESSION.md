# CatSnip Session Log

## Goal
Deploy CatSnip volunteer SMS broadcast system on Oracle Cloud VM with Vonage, Apache reverse proxy, and single-page admin UI.

## Constraints & Preferences
- Cheapest SMS provider (Vonage)
- Host on Oracle Cloud VM (o-cloud) via Tailscale + Apache virtual host
- Single-page admin UI with hash routing, light/dark mode, mobile-first CSS
- Volunteers auto-register by texting the Vonage number; replies appear in live feed
- Admin login required; admin can text the Vonage number to broadcast to all volunteers
- No build tools, vanilla JS, CDN libs (Lucide), no inline comments
- Domain is `catsnip.2hostyou.net` proxied through Cloudflare (orange cloud)
- Manage authorized SMS broadcast numbers via admin UI, not .env

## Progress
### Done
- Created project structure: Express + sql.js + @vonage/server-sdk + dotenv
- Built single-page admin UI (Broadcast, History, Volunteers, Settings views)
- Added auth system: login endpoint, Bearer token middleware, login view
- Added auto-register via SMS (unknown numbers become "New Volunteer" + welcome SMS)
- Added name-update flow: new volunteers reply with their name to personalize their record; supports `NAME:` command for already-named volunteers
- Added admin SMS broadcast: designated phone numbers (in `admin_phones` DB table) can text the Vonage number to broadcast to all active volunteers
- Settings view with webhook URL copy button, Vonage setup guide, admin phone management, and report recipient management, 10DLC registration links
- **Published GitHub repo** — `https://github.com/E3RC/catsnip`
- **Admin phone management** — `admin_phones` DB table, API CRUD routes, Settings UI to add/remove numbers
- **Daily email report** — `report_recipients` + `report_log` tables, `generateDailyReport()` text/HTML, `sendDailyReport()` via nodemailer/Brevo SMTP, manual trigger + scheduled delivery
- **Fixed Vonage inbound webhook** — accepts both modern Vonage JSON format (`from`, `text`) and classic format (`msisdn`, `Body`)
- **Fixed volunteer query** — `SELECT *` instead of `SELECT id` so `volunteer.name` is available for "New Volunteer" detection
- **Added webhook logging** — logs method, user-agent, content-type, and body for debugging
- **sendSmsReply logging** — added success/error logging instead of silent catch
- **Logo fix** — `CatSnip` → `Catsnip` everywhere
- **10DLC registration section** in Settings with direct Vonage dashboard links

#### Hosting (o-cloud — Oracle Linux 10.1)
- Installed Node.js v22.14.0, cloned repo, installed deps
- Systemd service — `catsnip.service` enabled, auto-starts on boot
- Apache virtual host — `catsnip.2hostyou.net` proxies to `localhost:3001` (both port 80 and 443)
- Self-signed SSL cert for origin (Cloudflare handles edge SSL)
- No cloudflared tunnel — Cloudflare DNS A record points to `138.2.215.65`
- Zeroclaw AI agent installed (accessible via Tailscale at port 42617)

#### Vonage Status
- Account upgraded from trial (paid)
- 10DLC registration PENDING — required for SMS to T-Mobile/Google Voice/etc.
- Webhook URL: `https://catsnip.2hostyou.net/api/incoming-sms` (unchanged)
- Admin number `+15743708318` (Verizon) works; other carriers blocked until 10DLC approved

### In Progress
- None

### Blocked
- **10DLC registration** — awaiting carrier approval before non-Verizon numbers work

## Key Decisions
- Switched from Twilio to Vonage due to Twilio compliance profile wait
- Changed port from 3000 to 3001 because Inbox Zero was already on 3000
- Using Cloudflare proxy (orange cloud) instead of cloudflared tunnel
- Using sql.js instead of better-sqlite3 to avoid native compilation
- `.env` kept out of git repo via `.gitignore`; credentials not exposed
- Using Brevo SMTP (smtp-relay.brevo.com:587) as email provider
- Report scheduling off by default; enable via `REPORT_SCHEDULE_ENABLED=true` in .env
- Removed `ADMIN_PHONE` env var in favor of `admin_phones` DB table managed via Settings UI
- Using self-signed cert on origin; Cloudflare handles SSL termination

## Next Steps
- Wait for 10DLC carrier approval (1-3 days)
- Re-enable Vonage webhook in dashboard if needed after DNS change
- Test broadcast from T-Mobile/AT&T/Google Voice numbers after 10DLC approved
- Enable daily report scheduling via `REPORT_SCHEDULE_ENABLED=true`

## Critical Context
- Server: o-cloud (Oracle Cloud VM, 25GB disk, 945MB RAM)
- OS: Oracle Linux Server 10.1
- Tailscale: `o-cloud` (100.97.145.51)
- Public IP: `138.2.215.65`
- Catsnip runs as systemd service: `systemctl status catsnip`
- Zeroclaw runs on port 42617: `http://o-cloud:42617`
- Source code: `C:\Scripts\catsnip` on Windows; `/opt/catsnip` on o-cloud
- Vonage phone: `+17035659871`, API key `c6b99c0a`, secret `dynJvcswh(BP2$vt)u`
- Vonage webhook: `https://catsnip.2hostyou.net/api/incoming-sms`
- Admin login: username `admin`, password `catsnip123`
- Admin phone `+15743708318` (Brent) seeded in `admin_phones` table
- Domain DNS: Cloudflare A record → `138.2.215.65` (orange cloud proxied)
- 10DLC registration needed for full carrier support
- `$` in Vonage secret requires escaping in shell/PowerShell
- Database: `/opt/catsnip/data/catsnip.db` (sql.js)

## Relevant Files
- `C:\Scripts\catsnip\server.js`: Express server with all API routes, auth, Vonage integration, SQLite, incoming SMS handler with admin broadcast logic, daily report generation + email + scheduling
- `C:\Scripts\catsnip\public\index.html`: single-page admin UI (login, broadcast, history, volunteers, settings views with admin phones + report management + 10DLC links)
- `C:\Scripts\catsnip\public\assets\css\style.css`: styling with light/dark mode, mobile-first
- `C:\Scripts\catsnip\public\assets\js\app.js`: frontend logic including auth, hash routing, polling, settings, admin phone CRUD, report recipient CRUD + send
- `C:\Scripts\catsnip\public\favicon.ico`: cat silhouette favicon
- `C:\Scripts\catsnip\SESSION.md`: this file — session state log
- `/opt/catsnip/.env` on o-cloud: admin credentials, Vonage API key/secret, port
- `/etc/systemd/system/catsnip.service`: systemd unit
- `/etc/httpd/conf.d/catsnip.conf`: Apache vhost (port 80)
- `/etc/httpd/conf.d/catsnip-ssl.conf`: Apache SSL vhost (port 443)
