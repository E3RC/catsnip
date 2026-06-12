# CatSnip Volunteer SMS Broadcast

A lightweight, self-hosted SMS broadcast system for volunteer management. Volunteers auto-register by texting your Vonage number, and admins can broadcast messages to all active volunteers via SMS or the web UI.

## Features

- **Auto-register** — New numbers that text in become "New Volunteers" automatically
- **Name update** — Volunteers reply with their name to personalize their contact info
- **SMS broadcast** — Admins text the Vonage number to broadcast to all active volunteers
- **Admin web UI** — Single-page app with Broadcast, History, Volunteers, Settings views
- **Live reply feed** — Volunteer responses appear in real-time
- **Daily email reports** — End-of-day summary via Brevo SMTP (optional)
- **Admin phone management** — Add/remove authorized broadcast numbers via Settings UI
- **Mobile-first** — Responsive CSS with light/dark mode

## Quick Start

### Prerequisites
- Node.js v22+
- A Vonage account with a provisioned SMS-capable number
- DNS pointing to your server (Cloudflare recommended)

### Install
```bash
git clone https://github.com/E3RC/catsnip.git
cd catsnip
npm install
cp .env.example .env
# Edit .env with your Vonage credentials
node server.js
```

### Environment Variables
| Variable | Description |
|---|---|
| `VONAGE_API_KEY` | Vonage API key |
| `VONAGE_API_SECRET` | Vonage API secret |
| `VONAGE_PHONE_NUMBER` | Your Vonage number (with country code, e.g. +1703...) |
| `ADMIN_USERNAME` | Admin login username (default: admin) |
| `ADMIN_PASSWORD` | Admin login password |
| `PORT` | Server port (default: 3000) |
| `REPORT_SCHEDULE_ENABLED` | Enable daily email reports (true/false) |
| `REPORT_SEND_TIME` | Report send time HH:MM (default: 17:00) |
| `SMTP_HOST` | SMTP relay host (e.g. smtp-relay.brevo.com) |
| `SMTP_PORT` | SMTP port (default: 587) |
| `SMTP_SECURE` | Use TLS (true/false) |
| `SMTP_USER` | SMTP login |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From email address |

### Vonage Webhook
Set your Vonage number's inbound SMS webhook to:
```
https://yourdomain.com/api/incoming-sms
```

## Tech Stack
- **Backend:** Node.js, Express, sql.js, @vonage/server-sdk
- **Frontend:** Vanilla JS, Lucide icons (CDN)
- **Email:** Nodemailer (sendmail or SMTP relay)
- **Auth:** Bearer token (in-memory sessions)

## Project Structure
```
catsnip/
├── server.js              # Express server (all routes, auth, SMS, reports)
├── public/
│   ├── index.html         # Single-page admin UI
│   ├── favicon.ico
│   └── assets/
│       ├── css/style.css
│       └── js/app.js
├── data/                  # SQLite database (created at runtime)
├── .env                   # Configuration (not in repo)
└── package.json
```

## License
MIT
