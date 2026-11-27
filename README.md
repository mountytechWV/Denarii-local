# Denarii

Denarii is a trading journal for Windows. You log trades (by hand, from a broker CSV, or synced from Webull), add notes and planners, review your performance with charts and analytics, and optionally ask an AI model about your trading.

It is a desktop app built with Electron. Everything runs and is stored on your own computer.

## Installing on Windows

1. Open the [latest release](https://github.com/mountytechWV/Denarii-local/releases/latest) and download `Denarii-Setup-<version>.exe` under **Assets**.
2. If your browser warns that the file isn't commonly downloaded, choose **Keep** (you may need to click **Show more** first).
3. Run the installer. If Windows shows "Windows protected your PC", click **More info** (the small link under the message), check that the app is `Denarii-Setup-<version>.exe`, then click **Run anyway**.
   - Alternative: right-click the installer, choose **Properties**, check **Unblock**, click **OK**, then run it.
4. Accept the license, choose a folder, and finish. Denarii starts when the installer closes.

### Why you see security warnings

Denarii is not code-signed by a registered publisher yet (see [CODE_SIGNING.md](CODE_SIGNING.md)), so Windows lists it as "Unknown publisher". Windows and many antivirus programs warn about any app like that, especially new ones that few people have downloaded. The warning does not mean a threat was found in the file.

- **Microsoft Defender SmartScreen** shows "Windows protected your PC". Use **More info**, then **Run anyway**, as in step 3.
- **McAfee, Norton, Avast, AVG, Bitdefender or other antivirus** may block the installer or move it to quarantine. Open your antivirus, find `Denarii-Setup` in its blocked items or quarantine history, and choose **Restore** or **Allow**. The exact wording differs between programs.
- Only allow a file you downloaded from this repository's Releases page. Don't turn off SmartScreen or your antivirus.
- To check the file is the one published here, compare its SHA-256 with the `sha256` shown next to it under **Assets**. In PowerShell: `Get-FileHash .\Denarii-Setup-<version>.exe`

These warnings only appear on the first install. After that, updates install from inside the app.

## Your data

- All data is stored on your computer in `%APPDATA%\Denarii` (a SQLite database, `denarii.sqlite`, plus a `backups` folder). Nothing is sent to the author.
- Your journal and API keys are encrypted with a key that is unlocked by your password. When you register you get a recovery key. **If you forget your password and lose the recovery key, your data cannot be recovered.**
- **You are responsible for your own backups.** Use **Settings > Data** to back up all data to a `.sqlite` file, restore from a backup, or open the backups folder. Keep copies somewhere other than this computer.
- Uninstalling Denarii does not delete `%APPDATA%\Denarii`.

## Bring your own keys

Denarii has no built-in API keys and no server. Optional features use services you sign up for yourself; enter the keys in **Settings > Integrations**. Each service receives only what the feature sends to it, under that service's own terms.

| Feature | Service | Where to get a key |
|---|---|---|
| AI analysis, reports and prompts | Google Gemini | [Google AI Studio](https://aistudio.google.com/apikey) |
| Stock charts (price data) | Twelve Data | [twelvedata.com](https://twelvedata.com/) (free plan available; key under your account's API keys) |
| Automatic trade import | Webull OpenAPI | [Webull Developer](https://developer.webull.com/) |

Webull notes:

- Denarii only reads order history. It never places, changes or cancels orders.
- Webull's API approval lasts about 15 days. When it expires, Denarii asks you to approve the connection again.

## Run from source

Requires Node.js (a current LTS release) on Windows.

```
npm install
npm start          # run the app
npm test           # run the test suite (node --test)
npm run dist       # build the Windows installer into dist/
```

`npm run vendor` refreshes the browser libraries in `vendor/` from `node_modules`, and `npm run icon` regenerates `build/icon.ico`.

## Project layout

| Path | What it is |
|---|---|
| `electron/main.js` | Electron main process: window, `app://denarii` protocol, CSP, IPC |
| `electron/preload.js` | The bridge the page uses (`window.denariiStore`, `denariiAutoSignIn`, `denariiWebull`, ...) |
| `electron/db.js` | SQLite storage, backups and restore |
| `electron/auto-signin.js` | "Stay signed in on this computer" |
| `electron/webull/` | Read-only Webull client, sync scheduler and IPC (main process) |
| `electron/updater.js` | Automatic updates from GitHub Releases |
| `index.html`, `Denarii.js`, `Denarii.css` | The app page and its core logic |
| `js/` | Auth, encryption helpers, pages, AI service, Webull page-side sync |
| `vendor/` | Bundled third-party browser libraries |
| `tests/` | `node --test` suite |
| `docs/` | Design and planning notes |
| `build/` | Installer icon and NSIS script |

## Make it your own

Denarii is open source, so you can change it for yourself with the help of an AI coding tool, even if you're not a programmer. [docs/MAKING-CHANGES.md](docs/MAKING-CHANGES.md) explains what you need, the general steps, and what to watch out for (back up your data first). Custom builds don't auto-update; only official releases do.

## Support

No support is provided. Use your own AI coding tool to maintain or change it; [CLAUDE.md](CLAUDE.md) and [docs/](docs/) explain the code.

## Disclaimer

Denarii is a record-keeping tool. Nothing in it, including AI output, is financial advice.

## License

Copyright © 2026 mountytechWV.

Denarii is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (GPL-3.0-or-later). It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE).

Bundled third-party libraries in `vendor/` keep their own licenses.
