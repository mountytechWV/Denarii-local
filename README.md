# Denarii

Denarii is a trading journal for Windows. You log trades (by hand, from a broker CSV, or synced from Webull), add notes and planners, review your performance with charts and analytics, and optionally ask an AI model about your trading.

It is a desktop app built with Electron. Everything runs and is stored on your own computer.

## Download and install

1. Go to the [Releases page](https://github.com/mountytechWV/Denarii-local/releases) and download the latest `Denarii-Setup-<version>.exe`.
2. Run it. The installer is not code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Accept the license, choose a folder, and finish. Denarii starts when the installer closes.

The installed app checks GitHub Releases for new versions and offers to update itself.

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

Denarii is open source, so you can change it for yourself with the help of an AI coding tool, even if you're not a programmer. [docs/MAKING-CHANGES.md](docs/MAKING-CHANGES.md) explains what you need, the general steps, and what to watch out for (back up your data first, and point the updater at your own fork).

## Support

No support is provided. Use your own AI coding tool to maintain or change it; [CLAUDE.md](CLAUDE.md) and [docs/](docs/) explain the code.

## Disclaimer

Denarii is a record-keeping tool. Nothing in it, including AI output, is financial advice.

## License

Copyright © 2026 mountytechWV.

Denarii is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (GPL-3.0-or-later). It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE).

Bundled third-party libraries in `vendor/` keep their own licenses.
