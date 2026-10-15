# RDS IAM Token Helper (Chrome extension)

Generates **RDS / Aurora / RDS Proxy IAM authentication tokens** for whichever AWS account you are logged in to. It works like CloudKeeper: log in through the portal, and the account, role and credentials are captured automatically. There are no saved profiles to maintain.

## How it works

1. You log in through your AWS portal and click a role. The browser POSTs a SAML assertion to `https://signin.aws.amazon.com/saml`.
2. The background worker observes that POST (`webRequest`, read-only) and reads the `SAMLResponse` field.
3. It reads the account and role from the assertion and calls STS `AssumeRoleWithSAML` (an unsigned call; the assertion is the credential).
4. The temporary credentials are kept in `chrome.storage.session` only (memory, cleared when the browser closes). The popup shows the **account, role and time left**.
5. In the popup, choose the region, enter the database or proxy **endpoint** and **DB user**, then click **Generate & copy token**. The token is a SigV4 presigned `rds-db:connect` URL built locally. No AWS call is made, and it is valid for 15 minutes.

Switch to another account or role by logging in through the portal again. The popup follows the new login automatically.

## Install (load unpacked)

1. `chrome://extensions` -> enable **Developer mode**.
2. **Load unpacked** -> select this folder (the one containing `manifest.json`). Keep the folder in place.
3. Pin the extension to the toolbar.
4. Log in through the portal **after** installing and click your role. The badge shows `OK` once credentials are captured.

If you were already logged in when you installed it, either log in again, or use **Paste credentials manually** with CloudKeeper's Copy button. The extension checks pasted credentials with AWS (`sts:GetCallerIdentity`) so the account and role still show up.

## The connection form

| Field | Notes |
|---|---|
| **Recent connections** | Appears once you have generated a token for the current account. One click refills the form. Stored per account in `chrome.storage.local` (hostnames, users, regions only; no secrets). |
| **Region** | Auto-set when the endpoint contains it (`...us-east-1.rds.amazonaws.com`). Change it for custom DNS names. |
| **Endpoint** | A dropdown, like Region, listing the cluster (writer and reader), instance and **RDS Proxy** endpoints your role can see in the selected region, with an "IAM auth off" note where relevant. It loads automatically once the region has been allowed, and the list is cached for 15 minutes per account and region. Choose **Enter endpoint manually...** to type one yourself (custom DNS, or a role without `rds:Describe*`); `https://` prefixes and `:port` suffixes are cleaned up. |
| **Port / DB user** | Port defaults to 5432, or follows the database you pick. |
| **Find databases in this account & region** | Forces a refresh of the list. The first time you use a region, Chrome asks once to allow access to `rds.<region>.amazonaws.com`; until then the dropdown stays empty. Needs `rds:DescribeDBClusters`, `rds:DescribeDBInstances` and `rds:DescribeDBProxies` on the role. |

## Using the token

```bash
export PGPASSWORD='<paste token>'
psql "host=<endpoint> port=5432 dbname=<db> user=<db_user> sslmode=require"
```

Paste it into the password field in pgAdmin or DBeaver, and enable SSL. Tokens are long (about 1 KB+); make sure the client does not truncate the password.

## AWS-side prerequisites

**1. IAM policy on the role**

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "rds-db:connect",
    "Resource": [
      "arn:aws:rds-db:<region>:<account-id>:dbuser:<dbi-or-cluster-resource-id>/<db_user>",
      "arn:aws:rds-db:<region>:<account-id>:dbuser:prx-<proxy-resource-id>/<db_user>"
    ]
  }]
}
```

- Instance: `DbiResourceId` (`db-XXXX`). Aurora cluster: cluster resource ID (`cluster-XXXX`). Proxy: proxy ID (`prx-XXXX`).
- `*` can replace the resource ID or user for broader access.

**2. Database user**

```sql
GRANT rds_iam TO iam_user;   -- RDS / Aurora PostgreSQL
```

**3. RDS Proxy:** IAM authentication must be allowed or required on the proxy's auth configuration. Connect to the **proxy endpoint** with the token.

**4.** Connect over SSL.

## Security notes

- Permissions: `webRequest`, `storage`, host access to `signin.aws.amazon.com/saml*` and `sts.amazonaws.com`. RDS regional endpoints are **optional** permissions, requested only when you click "Find databases". No `tabs`, history or `<all_urls>`.
- Credentials never touch `chrome.storage.local`, are never logged, and are sent only to STS (and RDS, for discovery). Tokens are generated on demand and not stored.
- The session credentials are as powerful as the role. Treat the popup like a terminal holding your keys.
- Check that your internal security policy allows a custom extension that handles SAML sign-ins.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Popup says *No credentials* | You have not clicked a role in the portal since installing, or the browser was restarted. Log in through the portal again. |
| Account / role show `unknown` | Credentials were pasted and the account lookup could not run. Log in through the portal instead. |
| Badge `!` and an error in the popup | STS rejected the assertion (expired, already used, or role/provider mismatch). Log in again. |
| Badge `?` | Several roles in one assertion. Open the popup and pick one. |
| Endpoint dropdown is empty or shows `AccessDenied` | Region not yet allowed (click "Find databases") or the role lacks `rds:DescribeDB*`. Use "Enter endpoint manually...". |
| `PAM authentication failed` / `password authentication failed` | The role lacks `rds-db:connect` on that exact `dbuser` ARN, the DB user lacks `rds_iam`, or the region/endpoint is wrong. |
| Works, then fails after ~15 min | The token expired. Generate a new one. Open connections stay alive; only new ones need a fresh token. |
| Credentials show "expired" | The role session ended (usually 1 hour). Log in through the portal again. |

## Development and tests

```bash
npm install
npm test
node scripts/gen-manifest.mjs   # regenerate manifest.json after editing lib/regions.js
```

- `test/verify.mjs`: tokens compared byte-for-byte with `@aws-sdk/rds-signer`; SAML, STS and credential-paste parsing.
- `test/background.test.mjs`: the service worker driven with a stubbed `chrome` API and mocked STS.
- `test/aws.test.mjs`: request signing compared with the AWS SDK's SigV4, discovery parsing (including pagination and partial failures), and manifest consistency.

The extension has no runtime dependencies and no build step. `node_modules` is only needed for tests.

## Layout

```
manifest.json         (generated by scripts/gen-manifest.mjs)
background.js         SAML capture + STS exchange
lib/saml.js           assertion decode, role extraction
lib/sts.js            AssumeRoleWithSAML
lib/sigv4.js          RDS IAM token (WebCrypto SigV4)
lib/aws.js            signed STS / RDS calls, GetCallerIdentity
lib/discover.js       list clusters, instances, proxies
lib/creds.js          parse pasted credentials
lib/regions.js        region list
popup/                the UI
test/                 verification against the AWS SDK
```
