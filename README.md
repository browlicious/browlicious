# Browlicious Clients

A phone app for client tracking, bookings, follow-ups, payments and SMS reminders for a microblading and brow/lash business. It runs in the browser (Chrome on Android) and is hosted on GitHub Pages. You install it to the home screen.

## Where the data lives

- **All client data stays on the phone** (browser IndexedDB). None of it is in this repository.
- This repo is public. **Never commit client data, backups, exports or photos of forms.** `.gitignore` blocks the usual file types, but check before every commit anyway.
- Backups: automatic to the user's own Google Drive (folder "Browlicious Backups"), or a manual backup file.
- Health questionnaires and consent forms stay on paper.

## Features

- **Today screen**: today's and tomorrow's bookings, past bookings to close off, unpaid visits, and clients due or overdue for a follow-up.
- **Follow-up rules** for each service, editable under More > Services. Defaults:
  - Microblading: perfecting session +6 weeks, then touch-up +12 months
  - Touch-up: next touch-up +12 months, at the higher price if the last visit was more than 365 days ago
  - Lash lift +8 weeks, brow styling +6 weeks
- **Payments**: cash or EFTPOS, part-payments, an outstanding list, and history on each client.
- **SMS**: one tap opens Android Messages with the text filled in. Nothing is sent automatically. Templates are editable.
- **Google Calendar**: import the export file (.zip/.ics) or sync directly. New bookings made in the app are written to Google Calendar. Events moved or cancelled in Google update the app.
- **Review queue**: imported events are matched to a client and service by keywords. Anything unclear waits for her to confirm.

## Deploy (GitHub Pages)

1. Push this folder to a GitHub repo.
2. Go to Settings > Pages > Source: *Deploy from a branch* > `main` / root.
3. Open `https://<user>.github.io/<repo>/` on the phone in Chrome, then use the menu > **Add to Home screen**. Installing also stops Chrome from clearing the app's storage.

After changing files, bump `VERSION` in `sw.js` so phones pick up the update.

## Google setup (one-off, about 10 minutes)

Needed for Calendar sync and Drive backup. Uses the browser token flow, so there is no server and no client secret.

1. Go to https://console.cloud.google.com/ and create a project, e.g. "Browlicious".
2. APIs & Services > Library: enable the **Google Calendar API** and the **Google Drive API**.
3. Google Auth Platform (OAuth consent screen):
   - Audience: External, publishing status **Testing**.
   - Test users: add the Gmail account that owns the calendar.
   - Data access: add the scopes `.../auth/calendar.events` and `.../auth/drive.file`.
4. Clients > Create client > **Web application**.
   - Authorised JavaScript origins: `https://<user>.github.io` (plus `http://localhost:8080` if you test locally).
   - No redirect URIs needed.
5. Copy the client ID (`xxxx.apps.googleusercontent.com`) into the app under More > Settings > OAuth client ID, or into `js/config.js`. The client ID is not a secret.
6. In the app, tap **Connect Google** and allow both permissions. Because the app is in Testing and unverified, Google shows an "unverified app" warning. That is expected for a private single-user app.

### Limits to know about

- With no server, Google gives the app an access token that lasts about **1 hour**. Backups and calendar sync run automatically while the app is open and connected. If the token has expired, the Today screen shows a "Backup due" banner and one tap reconnects. A real scheduled backup with the phone closed would need a small server (e.g. a Cloudflare Worker) holding a refresh token. That is a version 2 item.
- `drive.file` only lets the app see files it created itself. It cannot read anything else in her Drive.
- Repeating calendar events in the import file are imported once (first date only). Google sync expands them properly.
- Calendar times with a TZID in the .ics file are read as the phone's local time (NZ).

## Code layout

| File | Purpose |
|---|---|
| `js/db.js` | IndexedDB storage and lookups |
| `js/defaults.js` | Seed services (from the price list), SMS templates, settings |
| `js/rules.js` | What's due next, payment status, touch-up pricing |
| `js/match.js` | Guess client and service from calendar event text |
| `js/ics.js` | Read the Google Calendar export (.zip/.ics) |
| `js/google.js` | Google sign-in, Drive and Calendar API |
| `js/sync.js` | Review queue, calendar push/pull, backups |
| `js/views.js` | Screens and forms |
| `js/app.js` | Router and tap/form handlers |

No build step and no dependencies. Plain ES modules.

## Local testing

Serve the folder over http, for example `npx http-server -p 8080`, then open http://localhost:8080.
