# PingRoom text contrast audit

Review up to eight design-token color pairs on a phone. A named person classifies each text usage; application code calculates its WCAG 2.2 AA contrast result and writes a local audit with attribution. It does not inspect rendering, change stylesheets or certify WCAG conformance.

## Try it offline

Choose **Use this template** on GitHub, then clone your repository. With Node.js 22 or later:

```sh
npm ci
npm test
npm run demo
```

The demo runs the real pinned SDK against an in-memory transport. It exercises a passing audit, a known failure and an Unknown response without credentials or network calls.

## Set up your audit

```sh
cp examples/contrast.json contrast.json
cp config.example.json config.json
npm run preview
npm run connect
npm run inspect
```

Edit `contrast.json` before starting. Supply a stable `auditId`, short `title`, and `pairs`, each with a unique `id`, `foreground`, `background` and `usage`. Colors must be opaque six-digit sRGB hex values such as `#767676` and `#FFFFFF`. Describe the delivered font size, weight, context and any claimed exemption in `usage`. The example includes a failing body-text color.

Supply solid, known foreground/background colors. Resolve actual colors first; gradients, alpha, images behind text, unknown compositing and other color spaces need separate assessment. A valid hex value does not establish what the page renders. This program does not fetch styles, inspect screenshots or check anti-aliasing.

`connect` prints the PingRoom installation and pairing links. Approve access to a standard private room containing the reviewer. `inspect` lists member UUIDs; verify the intended person in the app, then put their exact UUID and a descriptive label in `config.json`. Labels alone do not establish identity. Pairing credentials stay in ignored `.pingroom/`.

For an existing connection, optionally copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. If either exists in the shell, both must come from the shell. A partial pair never borrows values from `.env` or saved credentials.

```sh
npm start
# Answer the pending Question in PingRoom, then run again:
npm start
npm run status
npm run report
npm run export
```

Each invocation creates at most one Question or reads the active one once. After recording an answer, run it again for the next pair. Pairs are asked in ID order, with both colors and the full usage description on the phone. At most eight Questions target the reviewer, each valid for 15 minutes.

## Classification and calculation

| Button | Treatment |
| --- | --- |
| Normal text | Contrast must be at least 4.5:1. |
| Large text | Contrast must be at least 3:1. |
| Exempt | Excluded; never recorded as passed. |
| Unknown | Whole audit remains incomplete. |

Large text means at least 18 pt regular or 14 pt bold: exactly 24 CSS px or 18⅔ CSS px, respectively. Assess the delivered size before user resizing; do not round the bold threshold down. The criterion also recognizes equivalent sizes for Chinese, Japanese and Korean fonts; use Unknown if eligibility cannot be established. See the [large-scale definition](https://www.w3.org/TR/WCAG22/#dfn-large-scale) and [CSS absolute-unit relationships](https://www.w3.org/TR/css-values-4/#absolute-lengths).

Exempt is limited to SC 1.4.3: text in an inactive UI component, pure decoration, text invisible to everyone, text within a picture containing significant other visual content, or text forming a logo/brand name. Brand colors alone do not exempt ordinary text. Non-text content is outside this starter's scope, **not automatically exempt**; UI/non-text contrast belongs to other requirements. See [Understanding Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

For each 8-bit sRGB channel, code divides by 255, then uses `s / 12.92` when `s <= 0.04045`, otherwise `((s + 0.055) / 1.055) ** 2.4`. Luminance is `0.2126 R + 0.7152 G + 0.0722 B`; contrast is `(lighter + 0.05) / (darker + 0.05)`. Comparisons use unrounded values: `#767676` on white passes normal text; `#777777` fails. See the [normative luminance formula](https://www.w3.org/TR/WCAG22/#dfn-relative-luminance).

## Results and recovery

`report` writes private `.contrast/report.json`; `export` writes `.contrast/audit.json` only after every pair has a known classification. Both run offline. The complete artifact includes canonical source, source hash, attributed Question evidence, raw ratios, thresholds and findings. Known failures are exportable: `finding: "fail"`, `overallPass: false`. All-exempt gives `no_applicable_pairs` and `overallPass: null`. Unknown, missing, expired, cancelled or invalid evidence withholds the complete `audit` and export.

Results depend on the supplied colors and classifications and cover neither other WCAG criteria nor the rendered page. Local hashes bind inputs and evidence; they are not signatures or proof of independent history.

For `create_unknown`, keep all state:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

A lost response never triggers a replacement POST. No match in a bounded recent search does not prove creation failed. Recover only the original Question. Expired, cancelled or invalid Questions are retained, not reissued. Resolve pending/uncertain operations before archiving `.contrast/` for a new audit; never delete state to retry. Resolve or revoke uncertain pairing in Connected Agents before archiving its pending record.

Run/recover exit codes: `0` complete audit (including failed contrast), `2` incomplete/Unknown or newly failed Question, `3` ready/pending, `4` uncertain creation, `1` operational error. Inspect JSON findings for the contrast outcome. Offline status/report success exits `0` even for partial results.

## Adaptation and bounds

Change the fixture and reviewer before starting; input, configuration, room and credential are bound to saved state. Pairs are sorted by ID; color case is normalized. Keep usage meanings intact when adapting prompts. Limits: eight pairs, title 40 and usage 100 UTF-16 units, pair IDs 16 characters, input 64 KiB, config 16 KiB, state 1 MiB and HTTP responses 512 KiB. Metadata must be trimmed, single-line, well-formed Unicode without control/format characters. Requests have five-second deadlines.

Private directories/files use modes `0700`/`0600` and are ignored by Git. Atomic writes and local locks support one machine; they are not distributed coordination. Remove a stale lock only after confirming its owning process stopped. SDK `0.7.1` is pinned with a lockfile; `.npmrc` requests a 14-day minimum release age where npm supports it. MIT licensed; GitHub Actions checks Node.js 22 and 24 with mocks only.
