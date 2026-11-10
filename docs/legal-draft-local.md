# Draft: legal text for Denarii Local

Status: this is the text shipped in the app (js/legal-bundle.js, version 2.0, effective November 10, 2026). If you change the legal text, update both places and bump LEGAL_BUNDLE_VERSION.

Written in plain language for the desktop (local) edition, released as free software under GPL-3.0-or-later. This is not legal advice. Have it reviewed before you use it.

---

## Denarii End User License Agreement

Version 2.0. Effective: November 10, 2026

### 1. What this is
Denarii is a trading journal that runs on your computer. By using it, you agree to these terms. If you don't agree, don't use Denarii.

### 2. License
Denarii is free software. You can use, copy, change and share it under the GNU General Public License, version 3 or (at your option) any later version ("GPL"). The full text is in the LICENSE file that comes with Denarii and at https://www.gnu.org/licenses/gpl-3.0.html. If anything in this agreement conflicts with the GPL, the GPL wins. This agreement does not take away any right the GPL gives you.

The source code is at https://github.com/mountytechWV/Denarii-local.

Third-party libraries included with Denarii are covered by their own licenses.

### 3. No warranty
Denarii is provided "as is", without warranty of any kind, express or implied, including fitness for a particular purpose, accuracy, or freedom from bugs or data loss. To the extent the law allows, the author is not liable for any damages from using or not being able to use Denarii, including lost data, lost profits or trading losses. (See sections 15 and 16 of the GPL.)

### 4. No support
No support is provided, and no maintenance or updates are promised. The author may release updates, or may stop, at any time. There is no contact address; the project lives at https://github.com/mountytechWV/Denarii-local.

### 5. Not financial advice; AI output
Denarii is a record-keeping and review tool. Nothing in it is financial, investment, tax or legal advice. This includes statistics, charts, imported data and AI-generated text. AI output can be wrong or incomplete. You alone are responsible for your trading decisions. Check imported and calculated figures against your broker's records.

### 6. Your responsibilities
- **Backups.** Your data exists only on your computer. Back it up regularly (Settings > Data) and keep copies somewhere else. If your computer or disk fails and you have no backup, your data is gone.
- **Password and recovery key.** Your data is encrypted with a key that only your password or your recovery key can unlock. The author cannot reset your password or recover your data. **If you forget your password and don't have your recovery key, your data cannot be recovered.**
- **API keys.** If you connect third-party services, you get your own keys, keep them secret, and follow those services' terms. You are responsible for any usage or charges on your accounts.
- **Your computer.** Anyone who can sign in to your Windows account may be able to use Denarii if you turn on "Stay signed in on this computer".

### 7. Third-party services
Denarii can connect to services you choose to set up with your own keys (see the Privacy Policy). These services are not run by the author. Their availability, accuracy and terms are their own.

### 8. Governing law
This agreement is governed by the laws of the State of Florida, United States, without regard to its conflict-of-law rules, except where the law of your place of residence requires otherwise.

### 9. Changes
If these terms change in a later version, Denarii will show the new terms and ask you to accept them.

---

## Denarii Privacy Policy

Version 2.0. Effective: November 10, 2026

### 1. Summary
Denarii stores your data only on your computer. The author does not run a server for Denarii and never receives your data.

### 2. What Denarii stores, and where
- Your journal (trades, notes, planners, reviews, settings) and your account details are stored in `%APPDATA%\Denarii` on your computer.
- Your journal and your API keys are encrypted with your account's key before they are saved.
- Backups you create are saved wherever you choose. Automatic backups are kept in `%APPDATA%\Denarii\backups`.
- If you turn on "Stay signed in on this computer", a protected copy of your account key is stored in `%APPDATA%\Denarii`, readable only by your Windows user account.
- If you connect Webull, your Webull app key, secret and access token are stored in `%APPDATA%\Denarii`, protected so that only your Windows user account can read them.
- Uninstalling Denarii does not delete this folder.

### 3. What the author receives
Nothing. Denarii has no accounts on any server, no analytics, no tracking and no crash reporting.

### 4. Update checks
The installed app checks GitHub Releases (github.com) for new versions. GitHub sees the request (including your IP address) as it does for any download, under GitHub's own privacy terms. No journal data is sent.

### 5. Optional services you connect
These are off until you add your own key. Each service receives only what the feature you use sends to it, and handles it under its own terms and privacy policy. Like any internet request, each service also sees your IP address.

| Service | Used for | What is sent |
|---|---|---|
| Google Gemini | AI analysis, reports and prompts | Your Gemini key, the prompt, and the trade and journal data the feature includes (for example the trades in the selected range, or one trade and its notes). Your key is also used to list the models available to it. |
| Twelve Data | Stock charts | Your Twelve Data key, the ticker symbol, the chart interval, and the trade's date (price data for that one day is requested). No prices, quantities, notes or other trade details are sent. |
| Webull OpenAPI | Importing your trades | Your Webull app key, a signature made with your app secret (the secret itself is not sent), your access token, and read-only requests for your account list and order history by date range. Denarii never places, changes or cancels orders. |

Data you get back from these services is stored on your computer like the rest of your journal.

### 6. Your control
You can remove any key in Settings > Integrations, disconnect Webull, export or back up your data, and delete accounts and data from your computer at any time.

### 7. Children
Denarii is not intended for anyone under 18.

### 8. Changes
If this policy changes in a later version, Denarii will show the new policy and ask you to accept it.

---

## Changing this text

1. Edit the `html` of the document in `js/legal-bundle.js` (existing style: `<h3>` title, muted version/date line, `<h4>` sections, `\n`-joined single-quoted string with HTML entities), and update this file to match.
2. Bump the document's `version` and `LEGAL_BUNDLE_VERSION`. Every existing account is asked to accept again on its next sign-in (`js/auth.js` compares `auth.legalAcceptedVersion` with it).
3. If the list of documents changes, update `checkboxLabel` and the two hard-coded checkbox labels in `index.html` (`#reg-legal-label` and the legal acceptance modal).
4. Run `npm test`.
