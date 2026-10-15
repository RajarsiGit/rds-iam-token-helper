// Runs popup/popup.js in jsdom with a stubbed chrome API and mocked RDS responses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../popup/popup.html", import.meta.url), "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const dom = new JSDOM(html, { url: "chrome-extension://test/popup/popup.html" });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = window.DOMParser;

const copied = [];
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async (t) => copied.push(t) } },
  configurable: true,
});

// ---- chrome stub ----
const mem = () => {
  const data = {};
  return {
    data,
    get: async (keys) => {
      const ks = keys === undefined ? Object.keys(data) : [].concat(keys);
      return Object.fromEntries(ks.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    set: async (o) => Object.assign(data, structuredClone(o)),
  };
};
const session = mem();
const local = mem();
const permRequests = [];
const granted = new Set(["https://rds.us-east-1.amazonaws.com/*", "https://rds.us-west-2.amazonaws.com/*"]);
globalThis.chrome = {
  storage: { session, local, onChanged: { addListener() {} } },
  permissions: {
    contains: async ({ origins }) => origins.every((o) => granted.has(o)),
    request: async ({ origins }) => {
      permRequests.push(...origins);
      origins.forEach((o) => granted.add(o));
      return true;
    },
  },
  runtime: { sendMessage: async () => ({ ok: true }) },
};

session.data.creds = {
  accessKeyId: "ASIAEXAMPLEKEY12345",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "FwoGZXIvYXdz+EXAMPLE/token==",
  expiration: new Date(Date.now() + 3600_000).toISOString(),
  accountId: "712427214116",
  roleName: "Enterprise_Role_DatabaseAdmin",
};

// ---- mocked RDS ----
const NS = 'xmlns="http://rds.amazonaws.com/doc/2014-10-31/"';
const clusters = `<R ${NS}><DBClusters><DBCluster><DBClusterIdentifier>dbserver-1-aurora-cluster</DBClusterIdentifier><Status>available</Status>
<Endpoint>dbserver-1-aurora-cluster.cluster-abc.us-east-1.rds.amazonaws.com</Endpoint><ReaderEndpoint>dbserver-1-aurora-cluster.cluster-ro-abc.us-east-1.rds.amazonaws.com</ReaderEndpoint>
<Port>5432</Port><Engine>aurora-postgresql</Engine><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled></DBCluster></DBClusters></R>`;
const instances = `<R ${NS}><DBInstances>
<DBInstance><DBInstanceIdentifier>dbserver-10</DBInstanceIdentifier><Engine>postgres</Engine><Endpoint><Address>dbserver-10.abc.us-east-1.rds.amazonaws.com</Address><Port>5432</Port></Endpoint><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled></DBInstance>
<DBInstance><DBInstanceIdentifier>dbserver-11</DBInstanceIdentifier><Engine>postgres</Engine><Endpoint><Address>dbserver-11.abc.us-east-1.rds.amazonaws.com</Address><Port>5433</Port></Endpoint><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled></DBInstance>
</DBInstances></R>`;
const proxies = `<R ${NS}><DBProxies><DBProxy><DBProxyName>app-proxy</DBProxyName><EngineFamily>POSTGRESQL</EngineFamily><Auth><member><IAMAuth>REQUIRED</IAMAuth></member></Auth><Endpoint>app-proxy.proxy-abc.us-east-1.rds.amazonaws.com</Endpoint></DBProxy></DBProxies></R>`;
const west = `<R ${NS}><DBInstances><DBInstance><DBInstanceIdentifier>west-db</DBInstanceIdentifier><Engine>postgres</Engine><Endpoint><Address>west-db.abc.us-west-2.rds.amazonaws.com</Address><Port>5432</Port></Endpoint><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled></DBInstance></DBInstances></R>`;

const calls = [];
globalThis.fetch = async (url, opts) => {
  const action = new URLSearchParams(opts.body).get("Action");
  calls.push({ url, action });
  const body = url.includes("us-west-2")
    ? action === "DescribeDBInstances" ? west : `<R ${NS}/>`
    : { DescribeDBClusters: clusters, DescribeDBInstances: instances, DescribeDBProxies: proxies }[action];
  return { ok: true, status: 200, text: async () => body };
};

// ---- load the popup ----
await import("../popup/popup.js");
const $ = (id) => document.getElementById(id);
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const fire = (el, type = "change") => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const optionValues = (sel) => [...sel.options].map((o) => o.value);
await settle();

// 1. credentials card
assert.equal($("account").textContent, "712427214116");
assert.equal($("role").textContent, "Enterprise_Role_DatabaseAdmin");
console.log("  ok  account and role shown from the login");

// 2. endpoint is a dropdown, auto-loaded because RDS access for us-east-1 is already granted
assert.equal($("host").tagName, "SELECT");
assert.equal($("region").tagName, "SELECT");
const hostVals = optionValues($("host"));
assert.equal(hostVals[0], "");
assert.equal(hostVals.at(-1), "__manual__");
assert.equal(hostVals.length, 2 + 5, "placeholder + 2 cluster endpoints + 2 instances + 1 proxy... plus manual");
assert.ok(hostVals.includes("app-proxy.proxy-abc.us-east-1.rds.amazonaws.com"));
assert.equal(calls.length, 3, "one call per Describe action");
assert.deepEqual(permRequests, [], "no permission prompt for an already-granted region");
console.log("  ok  endpoint dropdown auto-filled from the account (no prompt, 3 API calls)");

// 3. choosing an entry sets the port
$("host").value = "dbserver-11.abc.us-east-1.rds.amazonaws.com";
fire($("host"));
assert.equal($("port").value, "5433");
assert.equal($("hostManual").hidden, true);
console.log("  ok  selecting a database fills the port");

// 4. generate from dropdown
$("user").value = "ai_hunter";
$("genBtn").click();
await settle();
assert.ok($("token").value.startsWith("dbserver-11.abc.us-east-1.rds.amazonaws.com:5433/?Action=connect&DBUser=ai_hunter"), $("token").value.slice(0, 120));
assert.equal(copied.at(-1), $("token").value);
const rec = local.data.recentByAccount["712427214116"];
assert.equal(rec.length, 1);
assert.deepEqual(rec[0], { host: "dbserver-11.abc.us-east-1.rds.amazonaws.com", port: 5433, user: "ai_hunter", region: "us-east-1" });
console.log("  ok  token generated from the dropdown, copied, remembered per account");

// 5. manual entry
$("host").value = "__manual__";
fire($("host"));
assert.equal($("hostManual").hidden, false);
$("hostManual").value = "https://x.proxy-zz.eu-west-1.rds.amazonaws.com:6432/";
fire($("hostManual"), "input");
assert.equal($("region").value, "eu-west-1", "region detected from manual endpoint");
$("user").value = "svc";
$("genBtn").click();
await settle();
assert.ok($("token").value.startsWith("x.proxy-zz.eu-west-1.rds.amazonaws.com:6432/?Action=connect&DBUser=svc"), $("token").value.slice(0, 100));
console.log("  ok  manual endpoint: cleaned, region detected, port taken from URL");

// 6. validation
$("host").value = "";
fire($("host"));
$("genBtn").click();
await settle();
assert.match($("msg").textContent, /Choose a database/);
console.log("  ok  empty endpoint is rejected");

// 7. region change reloads the list for that region
const before = calls.length;
$("region").value = "us-west-2";
fire($("region"));
await settle();
assert.ok(calls.slice(before).every((c) => c.url.includes("rds.us-west-2.amazonaws.com")));
assert.ok(optionValues($("host")).includes("west-db.abc.us-west-2.rds.amazonaws.com"));
assert.ok(!optionValues($("host")).includes("dbserver-10.abc.us-east-1.rds.amazonaws.com"), "old region's databases cleared");
console.log("  ok  changing region reloads the dropdown for that region");

// 8. ungranted region: no auto-call, Find prompts once
$("region").value = "ap-south-1";
fire($("region"));
await settle();
const n = calls.length;
assert.match($("hostHint").textContent, /Find databases/);
assert.equal(calls.length, n, "no API call without permission");
$("findBtn").click();
await settle();
assert.deepEqual(permRequests, ["https://rds.ap-south-1.amazonaws.com/*"]);
assert.ok(calls.length > n);
console.log("  ok  ungranted region: hint, then Find requests permission and loads");

// 9. cache: returning to us-west-2 does not call the API again
const m = calls.length;
$("region").value = "us-west-2";
fire($("region"));
await settle();
assert.equal(calls.length, m, "served from cache");
assert.ok(optionValues($("host")).includes("west-db.abc.us-west-2.rds.amazonaws.com"));
console.log("  ok  database list cached per account and region");

// 10. recent connection that is not in the loaded list is still selectable
$("recent").value = "0";
fire($("recent"));
await settle();
assert.equal($("host").value, "x.proxy-zz.eu-west-1.rds.amazonaws.com");
assert.equal($("user").value, "svc");
assert.equal($("region").value, "eu-west-1");
console.log("  ok  recent connection restores endpoint, user, port and region");

console.log("\npopup checks passed");
process.exit(0);
