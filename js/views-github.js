// Settings section for the encrypted GitHub data copy.

import { html, fmtDate, fmtTime } from './util.js';
import * as GH from './ghstore.js';

/** GitHub sends e.g. "2027-11-09 10:00:00 UTC". */
function parseExpiry(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' UTC', 'Z').replace(' ', 'T'));
  return isNaN(d) ? null : d;
}

export function githubSection() {
  const c = GH.config();
  const st = GH.state();
  const on = GH.isConfigured();
  const exp = parseExpiry(st.tokenExpires);
  const expSoon = exp && exp - Date.now() < 30 * 86400000;

  let status = 'Not connected.';
  if (on) {
    status = html`${st.lastPushAt ? `Last saved to GitHub: ${fmtDate(st.lastPushAt)} ${fmtTime(st.lastPushAt)}.` : 'Not saved to GitHub yet.'}
      ${GH.hasPending() ? ' Changes waiting to be saved.' : ''}
      ${st.lastError ? html`<br><span class="bad">Last error: ${st.lastError}</span>` : ''}
      ${exp ? html`<br>${expSoon ? html`<b class="bad">Token expires ${fmtDate(exp)}. Create a new one soon.</b>` : `Token expires ${fmtDate(exp)}.`}` : ''}`;
  }

  return html`<section><h2>GitHub data storage (encrypted)</h2>
    <form data-form="github">
      <p class="hint">Keeps an encrypted copy of all data in a private GitHub repo. The token and passphrase stay on this phone only and are not included in backups.</p>
      <div class="grid2">
        <label>Owner<input name="owner" value="${c.owner}" autocomplete="off"></label>
        <label>Private repo<input name="repo" value="${c.repo}" autocomplete="off"></label>
      </div>
      <label>Access token<input name="token" type="password" autocomplete="off" placeholder="${c.token ? 'Saved (leave blank to keep)' : 'github_pat_...'}"></label>
      <label>Encryption passphrase<input name="passphrase" type="password" autocomplete="new-password" placeholder="${c.passphrase ? 'Saved (leave blank to keep)' : 'At least 10 characters'}"></label>
      ${c.passphrase ? '' : html`<label>Repeat passphrase<input name="passphrase2" type="password" autocomplete="new-password"></label>
        <p class="hint"><b>Write the passphrase down somewhere safe.</b> Without it the GitHub copy cannot be read (the Google Drive backup still can).</p>`}
      <div class="btn-row">
        <button class="btn primary" type="submit">${on ? 'Save' : 'Connect'}</button>
        ${on ? html`<button class="btn" type="button" data-act="gh-sync">Sync now</button>
          <button class="btn danger" type="button" data-act="gh-disconnect">Disconnect</button>` : ''}
      </div>
      <p class="hint">${status}</p>
    </form></section>`;
}
