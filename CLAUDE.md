# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension that captures an AWS SAML sign-in, exchanges it for temporary STS credentials, and generates RDS / Aurora / RDS Proxy IAM auth tokens locally. Plain ES modules with **no build step and no runtime dependencies**. `node_modules` exists only for tests. To try it, load the repo folder unpacked at `chrome://extensions`.

## Commands

```bash
npm install
npm test                          # runs all four test files in sequence
node test/verify.mjs              # run a single test file directly (likewise background/aws/popup .test.mjs)
node scripts/gen-manifest.mjs     # regenerate manifest.json (required after editing lib/regions.js)
python3 scripts/make-icons.py     # redraw icons/*.png (needs numpy + Pillow)
```

The tests are plain Node scripts that use `node:assert/strict`, with no test framework. A failed assertion throws and stops that file.

## Architecture

There are two execution contexts, and they share state only through `chrome.storage`:

- **`background.js` (service worker)** listens with `webRequest.onBeforeRequest` for the POST to `signin.aws.amazon.com/saml`, reads `SAMLResponse`, extracts roles (`lib/saml.js`) and calls STS `AssumeRoleWithSAML` (`lib/sts.js`, an unsigned call). The result goes to `chrome.storage.session.creds`. With several roles and no `roleIndex`, it stores `pending` and sets the badge to `?`. The popup then sends a `{type: "assume-role", roleArn}` runtime message to finish the exchange. Errors go to `session.lastError` and set the badge to `!`.
- **`popup/popup.js`** reads `creds` / `pending` / `lastError` from session storage and re-renders on `storage.onChanged`. It builds the token with `lib/sigv4.js` (WebCrypto SigV4 presign, no network). It discovers endpoints with `lib/discover.js` → `lib/aws.js` (signed RDS Query API calls). It also handles pasted credentials (`lib/creds.js`), which it validates with `sts:GetCallerIdentity`.

Storage rules (the README states these as security guarantees, so keep them):
- Credentials live only in `chrome.storage.session`. Never write them to `chrome.storage.local` and never log them.
- `chrome.storage.local` holds only non-secret `recentByAccount` (hosts, users, regions per account).
- `session.dbcache` caches discovery results for each account and region (15 minutes).

RDS regional hosts are **optional** host permissions. The popup requests `https://rds.<region>.amazonaws.com/*` the first time discovery runs in a region. `manifest.json` is **generated** from `lib/regions.js` by `scripts/gen-manifest.mjs`, so do not hand-edit it. `test/aws.test.mjs` checks that the two stay consistent. The extension version is hardcoded in both `scripts/gen-manifest.mjs` and `package.json`.

The lib modules must run in both a service worker (no DOM, so no `DOMParser`) and Node. `lib/discover.js` therefore takes an injected `parseXml` (the popup passes `DOMParser`; tests pass `@xmldom/xmldom`).

## Tests

- `test/verify.mjs`: checks tokens byte-for-byte against `@aws-sdk/rds-signer`, plus SAML, STS and credential-paste parsing.
- `test/background.test.mjs`: imports `background.js` with a stubbed `globalThis.chrome` and a mocked `fetch`, then drives its captured listeners.
- `test/aws.test.mjs`: checks `signedPost` against `@smithy/signature-v4`, discovery parsing (pagination, partial failures), and manifest/regions consistency.
- `test/popup.test.mjs`: runs `popup.js` in jsdom with a chrome stub and mocked RDS responses.

When you change a chrome API used by `background.js` or `popup.js`, extend the matching stub in the test file.
