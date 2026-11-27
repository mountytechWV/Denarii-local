# Making your own changes to Denarii

Denarii is open source under the GNU General Public License, version 3 or later (GPL-3.0-or-later). Anyone can change it for themselves. You don't need to be a programmer: an AI coding tool can do the work while you describe what you want.

This guide gives the general picture. For the exact steps on your computer, ask your AI tool.

## What you need

- A free [GitHub](https://github.com/) account.
- [Git](https://git-scm.com/), to copy the project to your computer.
- [Node.js](https://nodejs.org/) (a current LTS release), to run and build the app.
- An AI coding tool that can read and edit a project on your computer, such as Claude Code, OpenAI Codex or GitHub Copilot. A regular chat window alone is not enough, because the AI needs to see and edit the files.

## Back up your data first

Before you change anything, back up your journal: **Settings > Data > Back up all data**, and keep the copy somewhere safe.

Your real journal lives in `%APPDATA%\Denarii`. A version you run with `npm start` uses that same data, so a bad change can affect it. Some changes upgrade the database file, and an upgrade cannot be undone.

## The general flow

1. **Fork** the repository on GitHub: https://github.com/mountytechWV/Denarii-local. A fork is your own copy.
2. **Clone** your fork to your computer.
3. **Open** the folder with your AI coding tool. Ask it to read `CLAUDE.md` and the `docs/` folder first. They explain how the app is built and the rules that keep your data safe.
4. **Describe the change** you want in plain words, and let the AI make it.
5. **Test** it: run `npm test`, then try the app with `npm start`.
6. **Build** your own installer with `npm run dist`. It is saved in the `dist/` folder.

## Before you build your own installer

**Custom builds never auto-update.** Only installers built by the official release workflow on GitHub contain the marker file (`build-info.json`) that turns automatic updates on. An installer you build yourself with `npm run dist`, or one built from a fork, never downloads or installs updates, so the official release can't replace your changes.

To get later official changes, merge them from the original repository into your fork with Git (add https://github.com/mountytechWV/Denarii-local as an `upstream` remote, fetch it and merge; your AI tool can help with this and with any conflicts), then test and build your installer again.

If you want your version installed separately from the official Denarii, with its own data folder, change `productName` (it appears twice: at the top and in the `build` section) and `appId` in `package.json` (for example `Denarii Custom` and `com.yourname.denarii-custom`). The data folder name is also set in `electron/main.js` (`app.setName('Denarii')` and the `userData` path next to it); change `Denarii` there too, or both versions will share the same journal. Your version then starts with an empty journal. To bring your data across, back it up first and copy the contents of `%APPDATA%\Denarii` into your version's new folder under `%APPDATA%` before you start it the first time.

## Sharing your version

You can keep your changes to yourself. If you share your changed version with others, the GPL requires you to share its source code under the same license.

## Support

The original author provides no support. Your AI tool is your helper.
