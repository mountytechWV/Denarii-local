# Code signing policy

## Status

Applying to the SignPath Foundation program. Releases are not code-signed yet.

Planned statement, once approved: Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## What is signed

The Windows installer (`Denarii-Setup-<version>.exe`) and the Denarii app it installs, built by [.github/workflows/release.yml](.github/workflows/release.yml) on GitHub Actions from the source in this public repository ([mountytechWV/Denarii-local](https://github.com/mountytechWV/Denarii-local)).

Nothing built on a personal computer, and nothing from another repository, is signed.

## Roles

| Role | Members |
|---|---|
| Committers and reviewers | [mountytechWV](https://github.com/mountytechWV) |
| Approvers | [mountytechWV](https://github.com/mountytechWV) |

Each signing request for a release is approved by hand by an approver.

## Privacy

Denarii does not send any information to other networked systems unless the user sets it up:

- It checks GitHub Releases for updates.
- It contacts Google Gemini, Twelve Data and Webull only after the user adds their own keys for those services.

All journal data stays on the user's computer. See the Privacy Policy in the app (**Help > Legal**) and its source in [js/legal-bundle.js](js/legal-bundle.js).
