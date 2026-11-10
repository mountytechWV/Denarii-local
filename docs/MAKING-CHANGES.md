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

Denarii updates itself from GitHub. In `package.json`, the `publish` section names the repository it checks for updates. Change its `owner` and `repo` to your own fork, or remove the `publish` section. **If you don't, Denarii's automatic updater will replace your custom version with the official release.**

## Sharing your version

You can keep your changes to yourself. If you share your changed version with others, the GPL requires you to share its source code under the same license.

## Support

The original author provides no support. Your AI tool is your helper.
