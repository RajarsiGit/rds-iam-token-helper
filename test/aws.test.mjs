// SigV4 header signing vs the AWS SDK's signer, STS identity parsing,
// RDS discovery parsing, and manifest consistency.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { signedPost, parseCallerIdentity } from "../lib/aws.js";
import { listDatabases } from "../lib/discover.js";
import { REGIONS } from "../lib/regions.js";

const ok = (n) => console.log("  ok  " + n);
const FIXED = new Date("2026-10-15T06:30:00.000Z");
const credentials = {
  accessKeyId: "ASIAEXAMPLEKEY12345",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "FwoGZXIvYXdz+EXAMPLE/token==",
};

// ---- 1. header signature identical to the SDK's SignatureV4 ----
for (const [service, region, host, body] of [
  ["rds", "us-east-1", "rds.us-east-1.amazonaws.com", "Action=DescribeDBClusters&Version=2014-10-31"],
  ["rds", "ap-south-1", "rds.ap-south-1.amazonaws.com", "Action=DescribeDBInstances&Marker=abc%2B%2Fdef&Version=2014-10-31"],
  ["sts", "us-east-1", "sts.amazonaws.com", "Action=GetCallerIdentity&Version=2011-06-15"],
]) {
  const mine = await signedPost({ service, region, host, body, credentials, now: FIXED });
  const sdk = await new SignatureV4({ credentials, region, service, sha256: Sha256, applyChecksum: false }).sign(
    new HttpRequest({
      method: "POST",
      protocol: "https:",
      hostname: host,
      path: "/",
      headers: { host, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body,
    }),
    { signingDate: FIXED }
  );
  assert.equal(mine.authorization, sdk.headers.authorization, `authorization mismatch: ${service} ${region}`);
  assert.equal(mine.headers["x-amz-date"], sdk.headers["x-amz-date"]);
  assert.equal(mine.headers["x-amz-security-token"], sdk.headers["x-amz-security-token"]);
  ok(`Authorization header matches AWS SDK SigV4: ${service} ${region}`);
}

// ---- 2. GetCallerIdentity parsing ----
const who = parseCallerIdentity(`<GetCallerIdentityResponse><GetCallerIdentityResult>
<Arn>arn:aws:sts::712427214116:assumed-role/Enterprise_Role_DatabaseAdmin/rajarsi@syscloudsoftware.com</Arn>
<UserId>AROAEXAMPLE:rajarsi</UserId><Account>712427214116</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`);
assert.deepEqual(who, {
  accountId: "712427214116",
  roleName: "Enterprise_Role_DatabaseAdmin",
  roleArn: "arn:aws:iam::712427214116:role/Enterprise_Role_DatabaseAdmin",
});
assert.throws(() => parseCallerIdentity("<x/>"));
ok("GetCallerIdentity parsing");

// ---- 3. discovery against realistic RDS responses (mocked HTTP) ----
const NS = 'xmlns="http://rds.amazonaws.com/doc/2014-10-31/"';
const clustersXml = `<DescribeDBClustersResponse ${NS}><DescribeDBClustersResult><DBClusters>
<DBCluster><DBClusterIdentifier>dbserver-1-aurora-cluster</DBClusterIdentifier><Status>available</Status>
<Endpoint>dbserver-1-aurora-cluster.cluster-abc.us-east-1.rds.amazonaws.com</Endpoint>
<ReaderEndpoint>dbserver-1-aurora-cluster.cluster-ro-abc.us-east-1.rds.amazonaws.com</ReaderEndpoint>
<Port>5432</Port><Engine>aurora-postgresql</Engine><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled>
<DBClusterMembers><DBClusterMember><DBInstanceIdentifier>dbserver-1-aurora</DBInstanceIdentifier><IsClusterWriter>true</IsClusterWriter></DBClusterMember></DBClusterMembers>
</DBCluster></DBClusters></DescribeDBClustersResult></DescribeDBClustersResponse>`;

const instancesPage1 = `<DescribeDBInstancesResponse ${NS}><DescribeDBInstancesResult><DBInstances>
<DBInstance><DBInstanceIdentifier>dbserver-10</DBInstanceIdentifier><Engine>postgres</Engine><DBInstanceStatus>available</DBInstanceStatus>
<Endpoint><Address>dbserver-10.abc.us-east-1.rds.amazonaws.com</Address><Port>5432</Port><HostedZoneId>Z1</HostedZoneId></Endpoint>
<IAMDatabaseAuthenticationEnabled>false</IAMDatabaseAuthenticationEnabled></DBInstance>
<DBInstance><DBInstanceIdentifier>dbserver-1-aurora</DBInstanceIdentifier><DBClusterIdentifier>dbserver-1-aurora-cluster</DBClusterIdentifier><Engine>aurora-postgresql</Engine>
<Endpoint><Address>dbserver-1-aurora.abc.us-east-1.rds.amazonaws.com</Address><Port>5432</Port></Endpoint></DBInstance>
</DBInstances><Marker>PAGE2</Marker></DescribeDBInstancesResult></DescribeDBInstancesResponse>`;
const instancesPage2 = `<DescribeDBInstancesResponse ${NS}><DescribeDBInstancesResult><DBInstances>
<DBInstance><DBInstanceIdentifier>dbserver-11</DBInstanceIdentifier><Engine>postgres</Engine><DBInstanceStatus>available</DBInstanceStatus>
<Endpoint><Address>dbserver-11.abc.us-east-1.rds.amazonaws.com</Address><Port>5433</Port></Endpoint>
<IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled></DBInstance>
</DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>`;

const proxiesXml = `<DescribeDBProxiesResponse ${NS}><DescribeDBProxiesResult><DBProxies>
<DBProxy><DBProxyName>app-proxy</DBProxyName><Status>available</Status><EngineFamily>POSTGRESQL</EngineFamily>
<Auth><member><AuthScheme>SECRETS</AuthScheme><IAMAuth>REQUIRED</IAMAuth></member></Auth>
<Endpoint>app-proxy.proxy-abc.us-east-1.rds.amazonaws.com</Endpoint></DBProxy>
<DBProxy><DBProxyName>legacy-proxy</DBProxyName><Status>available</Status><EngineFamily>POSTGRESQL</EngineFamily>
<Auth><member><AuthScheme>SECRETS</AuthScheme><IAMAuth>DISABLED</IAMAuth></member></Auth>
<Endpoint>legacy-proxy.proxy-abc.us-east-1.rds.amazonaws.com</Endpoint></DBProxy>
</DBProxies></DescribeDBProxiesResult></DescribeDBProxiesResponse>`;

const calls = [];
globalThis.fetch = async (url, opts) => {
  const p = new URLSearchParams(opts.body);
  calls.push({ url, action: p.get("Action"), marker: p.get("Marker"), auth: opts.headers.Authorization });
  const body =
    p.get("Action") === "DescribeDBClusters" ? clustersXml
    : p.get("Action") === "DescribeDBProxies" ? proxiesXml
    : p.get("Marker") === "PAGE2" ? instancesPage2 : instancesPage1;
  return { ok: true, status: 200, text: async () => body };
};

const parseXml = (t) => new DOMParser().parseFromString(t, "text/xml");
const { entries, errors } = await listDatabases({ credentials, region: "us-east-1", parseXml });

assert.deepEqual(errors, []);
assert.ok(calls.every((c) => c.url === "https://rds.us-east-1.amazonaws.com/"), "calls go to the regional RDS endpoint");
assert.ok(calls.every((c) => c.auth.startsWith("AWS4-HMAC-SHA256 Credential=ASIAEXAMPLEKEY12345/")), "requests are signed");
assert.equal(calls.filter((c) => c.action === "DescribeDBInstances").length, 2, "instance pagination followed");

const by = Object.fromEntries(entries.map((e) => [e.host, e]));
assert.equal(entries.length, 6); // 2 cluster endpoints + 2 standalone instances + 2 proxies
assert.equal(by["dbserver-1-aurora-cluster.cluster-abc.us-east-1.rds.amazonaws.com"].kind, "cluster writer");
assert.equal(by["dbserver-1-aurora-cluster.cluster-ro-abc.us-east-1.rds.amazonaws.com"].kind, "cluster reader");
assert.ok(!by["dbserver-1-aurora.abc.us-east-1.rds.amazonaws.com"], "cluster member instance not listed separately");
assert.equal(by["dbserver-10.abc.us-east-1.rds.amazonaws.com"].iam, false);
assert.match(by["dbserver-10.abc.us-east-1.rds.amazonaws.com"].label, /IAM auth off/);
assert.equal(by["dbserver-11.abc.us-east-1.rds.amazonaws.com"].port, 5433);
assert.equal(by["app-proxy.proxy-abc.us-east-1.rds.amazonaws.com"].iam, true);
assert.equal(by["app-proxy.proxy-abc.us-east-1.rds.amazonaws.com"].port, 5432);
assert.equal(by["legacy-proxy.proxy-abc.us-east-1.rds.amazonaws.com"].iam, false);
ok("discovery: clusters, instances (paged), proxies");

// partial failure: proxies denied, others still returned
globalThis.fetch = async (url, opts) => {
  const action = new URLSearchParams(opts.body).get("Action");
  if (action === "DescribeDBProxies") {
    return { ok: false, status: 403, text: async () => "<ErrorResponse><Error><Code>AccessDenied</Code><Message>not authorized to perform rds:DescribeDBProxies</Message></Error></ErrorResponse>" };
  }
  return { ok: true, status: 200, text: async () => (action === "DescribeDBClusters" ? clustersXml : instancesPage2) };
};
const partial = await listDatabases({ credentials, region: "us-east-1", parseXml });
assert.equal(partial.errors.length, 1);
assert.match(partial.errors[0], /AccessDenied/);
assert.ok(partial.entries.length >= 3);
ok("discovery: partial failure keeps successful results");

// total failure throws
globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => "<Error><Code>ExpiredToken</Code><Message>The security token included in the request is expired</Message></Error>" });
await assert.rejects(() => listDatabases({ credentials, region: "us-east-1", parseXml }), /ExpiredToken/);
ok("discovery: total failure surfaces AWS error");

// ---- 4. manifest consistency ----
const mf = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
assert.deepEqual(
  mf.optional_host_permissions,
  REGIONS.map((r) => `https://rds.${r}.amazonaws.com/*`),
  "run `node scripts/gen-manifest.mjs`"
);
assert.ok(!("options_page" in mf), "no options page");
assert.deepEqual(mf.permissions.sort(), ["storage", "webRequest"]);
ok("manifest: optional RDS hosts match regions list, minimal permissions");

// ---- 5. icons exist, are PNGs, and have the declared dimensions ----
for (const size of [16, 32, 48, 128]) {
  const rel = mf.icons[size];
  assert.equal(rel, `icons/icon${size}.png`);
  assert.equal(mf.action.default_icon[size], rel);
  const png = readFileSync(new URL("../" + rel, import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), size, `${rel} width`);
  assert.equal(png.readUInt32BE(20), size, `${rel} height`);
}
ok("icons: 16/32/48/128 present with correct dimensions and wired into the manifest");

console.log("\naws checks passed");
