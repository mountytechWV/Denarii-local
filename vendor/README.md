# vendor/

Third-party browser libraries loaded by `index.html`, copied from `node_modules`
so Denarii Local starts and runs offline. Do not edit these files by hand.

To update: change the exact version in `package.json` `devDependencies`, run
`npm install`, then `npm run vendor` (`scripts/vendor.js`), and update the
matching path in `index.html`.

| Folder | Source package | Version | License | Used for |
|---|---|---|---|---|
| `lightweight-charts/4.1.1/` | `lightweight-charts` | 4.1.1 | Apache-2.0 (`LICENSE`) | Trade candle chart |
| `plotly/2.27.1/` | `plotly.js-dist-min` | 2.27.1 | MIT (`LICENSE`) | Analysis page charts |
| `crypto-js/4.1.1/` | `crypto-js` | 4.1.1 | MIT (`LICENSE`) | Account encryption |
| `papaparse/5.4.1/` | `papaparse` | 5.4.1 | MIT (`LICENSE`) | Broker CSV import |
| `marked/12.0.2/` | `marked` | 12.0.2 | MIT (`LICENSE.md`) | AI output Markdown |
| `dompurify/3.4.17/` | `dompurify` | 3.4.17 | Apache-2.0 OR MPL-2.0 (`LICENSE`, `LICENSE-MPL`) | AI output sanitizing |
| `fonts/inter/` | `@fontsource/inter` | 5.3.0 | SIL OFL 1.1 (`LICENSE`) | Inter latin 400/500/600/700, Plotly chart text |

Notes:
- `crypto-js` must stay at 4.1.1. Later versions changed defaults used by
  existing encrypted data. The npm package ships the unminified `crypto-js.js`.
- `fonts/inter/inter.css` is written by hand (not copied); `npm run vendor`
  copies only the woff2 files and `LICENSE` next to it.
- The `lightweight-charts` npm package has no separate NOTICE file. Its
  copyright and license header is kept at the top of the vendored file.
