# Browlicious Clients

A phone app for client tracking, bookings, follow-ups, payments and SMS reminders for a microblading and brow/lash business. It runs in the browser (Chrome on Android) and is hosted on GitHub Pages. You install it to the home screen.

## Where the data lives

- **Working copy on the phone** (browser IndexedDB). None of it is in this public repository.
- **Encrypted copy in a private GitHub repo** (default `browlicious/browlicious-data`). Data is gzipped and encrypted on the phone with AES-256-GCM (key from a passphrase, PBKDF2-SHA256, 310,000 rounds) before upload, so GitHub only stores ciphertext. Each save replaces the branch with one new commit, so old copies don't build up in git history.
- The GitHub token and passphrase are stored only on the phone (localStorage). They are never in this repo, the app data or the Drive backup. The app refuses to save to a repo that is public.
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
- **Messages**: each client has a preferred contact (SMS by default, Email or Facebook) with fallback if details are missing. SMS opens Android Messages; Email opens the mail app (Gmail) with subject and text; Facebook copies the text and opens Messenger (Facebook can't be pre-filled). Nothing is sent automatically. Templates (with email subjects) are editable.
- **Clients**: search, filters (visited in last 12 months, due, lapsed, owing, messaged, tags...), sorting, A-Z headers, one-tap tags such as "Reminder set".
- **Financials**: earnings by month and year from payments taken in the app, calendar year or NZ tax year (Apr-Mar), cash/EFTPOS split, by service, optional GST (15%) breakdown, CSV export.
- **Google Contacts**: reads her contacts (read-only) and suggests missing phone numbers/emails for clients. Existing details are never overwritten.
- **Google Calendar**: import the export file (.zip/.ics) or sync directly. New bookings made in the app are written to Google Calendar. Events moved or cancelled in Google update the app.
- **Review queue**: imported events are matched to a client and service by keywords. Anything unclear waits for her to confirm.

## Deploy (GitHub Pages)

1. Push this folder to a GitHub repo.
2. Go to Settings > Pages > Source: *Deploy from a branch* > `main` / root.
3. Open `https://<user>.github.io/<repo>/` on the phone in Chrome, then use the menu > **Add to Home screen**. Installing also stops Chrome from clearing the app's storage.

After changing files, bump `VERSION` in `sw.js` so phones pick up the update.

## GitHub data storage setup (one-off)

1. On the account that owns the data, create a **private** repo (e.g. `browlicious-data`) with a README.
2. Settings > Developer settings > Personal access tokens > **Fine-grained tokens** > Generate:
   - Repository access: **Only select repositories** > the data repo
   - Permissions: **Contents: Read and write** (Metadata read-only is added automatically)
   - Expiration: e.g. 1 year. The app shows the expiry date and warns 30 days before.
3. On the phone: More > Settings > GitHub data storage. Paste the token, choose a passphrase (10+ characters, **write it down**), tap Connect.
4. Saving happens about a minute after changes and when the app is closed. If two devices both changed data, the app asks which version to keep (and saves a backup file first).

## Google setup (one-off, about 10 minutes)

Needed for Calendar sync, Drive backup and Contacts. Uses the browser token flow, so there is no server and no client secret.

1. Go to https://console.cloud.google.com/ and create a project, e.g. "Browlicious".
2. APIs & Services > Library: enable the **Google Calendar API**, the **Google Drive API** and the **People API** (contacts).
3. Google Auth Platform (OAuth consent screen):
   - Audience: External, publishing status **Testing**.
   - Test users: add the Gmail account that owns the calendar.
   - Data access: add the scopes `.../auth/calendar.events`, `.../auth/drive.file` and `.../auth/contacts.readonly`.
4. Clients > Create client > **Web application**.
   - Authorised JavaScript origins: `https://browlicious.github.io` (plus `http://localhost:8080` if you test locally).
   - No redirect URIs needed.
5. Copy the client ID (`xxxx.apps.googleusercontent.com`) into the app under More > Settings > OAuth client ID, or into `js/config.js`. The client ID is not a secret.
6. In the app, tap **Connect Google** and tick all three permissions. Because the app is in Testing and unverified, Google shows an "unverified app" warning. That is expected for a private single-user app.

### Limits to know about

- With no server, Google gives the app an access token that lasts about **1 hour**. Backups and calendar sync run automatically while the app is open and connected. If the token has expired, the Today screen shows a "Backup due" banner and one tap reconnects. A real scheduled backup with the phone closed would need a small server (e.g. a Cloudflare Worker) holding a refresh token. That is a version 2 item.
- `drive.file` only lets the app see files it created itself. It cannot read anything else in her Drive.
- Repeating calendar events in the import file are imported once (first date only). Google sync expands them properly.
- Calendar times with a TZID in the .ics file are read as the phone's local time (NZ).

## Code layout

| File | Purpose |
|---|---|
| `js/db.js` | IndexedDB storage and lookups |
| `js/ghstore.js` | Encrypted copy in the private GitHub repo |
| `js/contact.js` | Preferred contact channel, SMS / email / Facebook links |
| `js/contacts.js` | Google Contacts matching |
| `js/finance.js` | Earnings by month/year, GST, CSV |
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
