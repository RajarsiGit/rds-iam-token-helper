# Improvements

Review of the extension as of 2026-10-16. Items are ordered by priority within each section.

## Bugs

### 1. Picking a role on AWS's own role-chooser page doesn't work

`background.js:37`

When a sign-in has several roles, the first POST to `/saml` arrives without `roleIndex`, so the extension marks it pending and shows `?`. The user then clicks a role on AWS's page, and the browser POSTs the **same** `SAMLResponse` again, this time with `roleIndex`. The check `samlB64 === lastAssertion` throws that second POST away, so the user has to pick the role again in the popup.

Test 4 in `test/background.test.mjs` misses this because it uses a new assertion instead of re-sending the same one.

**Fix:** compare on `samlB64 + "|" + selectedRoleArn`, and add a test that re-sends the same assertion with `roleIndex`.

### 2. Any write to session storage redraws the whole popup

`popup/popup.js:388`

Saving the database list cache (`dbcache`) also triggers `refresh()`. That rebuilds `roleSelect`, so a role the user was in the middle of choosing gets reset, and an old `lastError` can be shown again.

**Fix:** only refresh when `creds`, `pending` or `lastError` changed.

### 3. The badge stays `OK` after the credentials expire

The role session ends after about an hour, but the badge only changes when the popup is opened.

**Fix:** set a `chrome.alarms` timer to `expiration` that switches the badge to an "expired" state. This needs the `alarms` permission.

### 4. A pending SAML assertion is never cleared

A multi-role sign-in that nobody finishes leaves the assertion in `session.pending` until the browser closes. AWS stops accepting it after about 5 minutes anyway.

**Fix:** clear `pending` after about 5 minutes.

## Functional improvements

### 5. Session length is always 1 hour

`lib/sts.js`

`assumeRoleWithSAML` doesn't pass `DurationSeconds`, so STS uses its 1-hour default. This happens even when the identity provider sets the `https://aws.amazon.com/SAML/Attributes/SessionDuration` attribute, which the AWS console honours.

**Fix:** read that attribute from the assertion and pass it to STS. If STS rejects it because the role's maximum is lower, retry without it.

### 6. Discovery misses some endpoints

`lib/discover.js`

It doesn't list:

- extra RDS Proxy endpoints (`DescribeDBProxyEndpoints`, such as read-only proxy endpoints)
- Aurora custom endpoints (`CustomEndpoints` on each cluster)

### 7. The port is not validated

`popup/popup.js:267`

A blank or invalid port silently becomes 5432. The port is part of the signed token, so this fails later as a confusing "PAM authentication failed".

**Fix:** check that the port is between 1 and 65535 and show an error otherwise.

### 8. Pasted credentials can share history across accounts

If the account lookup fails because of a network error, the credentials are saved under the account `unknown`. All such accounts then share one recent-connections list.

## Housekeeping

### 9. There is no `.gitignore`

Running `npm install` would leave `node_modules/` untracked in the repo.

**Fix:** add a `.gitignore` before installing, and commit `package-lock.json`. Also, everything apart from the initial commit is still untracked.

### 10. The version number is in two places

It is hardcoded in both `scripts/gen-manifest.mjs` and `package.json`.

**Fix:** have the script read it from `package.json`.

### 11. The README is out of date

Its "Development and tests" section lists three test files, and `test/popup.test.mjs` is missing.

### 12. `signedPost` builds the Authorization header twice

`lib/aws.js:37`

It is built once in `headers.Authorization` and once in a separate `authorization` field. Only `test/aws.test.mjs` reads the second one.

**Fix:** remove the `authorization` field and have the test read `headers.Authorization` instead.

## Suggested order

Start with #1, since it breaks the normal multi-role sign-in, then #2 and #9.
