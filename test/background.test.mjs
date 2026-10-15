// Drives background.js with a stubbed chrome API and a mocked STS endpoint.
import assert from "node:assert/strict";

const session = {};
let webRequestListener;
let messageListener;
const badge = [];

globalThis.chrome = {
  runtime: { id: "test-ext", onMessage: { addListener: (fn) => (messageListener = fn) } },
  action: {
    setBadgeText: ({ text }) => badge.push(text),
    setBadgeBackgroundColor: () => {},
  },
  storage: {
    session: {
      get: async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(ks.filter((k) => k in session).map((k) => [k, session[k]]));
      },
      set: async (o) => Object.assign(session, o),
      remove: async (ks) => [].concat(ks).forEach((k) => delete session[k]),
    },
  },
  webRequest: { onBeforeRequest: { addListener: (fn) => (webRequestListener = fn) } },
};

const stsCalls = [];
globalThis.fetch = async (url, opts) => {
  stsCalls.push({ url, body: Object.fromEntries(opts.body) });
  return {
    ok: true,
    text: async () =>
      "<R><Credentials><AccessKeyId>ASIATEST</AccessKeyId><SecretAccessKey>sekret</SecretAccessKey>" +
      "<SessionToken>tok</SessionToken><Expiration>2026-10-15T07:30:00Z</Expiration></Credentials></R>",
  };
};

await import("../background.js");
assert.ok(webRequestListener && messageListener, "listeners registered");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roleA = "arn:aws:iam::712427214116:role/Enterprise_Role_DatabaseAdmin";
const roleB = "arn:aws:iam::111122223333:role/Other";
const prov = (acct) => `arn:aws:iam::${acct}:saml-provider/Okta`;
const assertion = (roles) =>
  Buffer.from(
    `<Response><Attribute Name="https://aws.amazon.com/SAML/Attributes/Role">` +
      roles.map(([r, a]) => `<AttributeValue>${r},${prov(a)}</AttributeValue>`).join("") +
      `</Attribute></Response>`
  ).toString("base64");

// 1. single role: captured automatically
webRequestListener({ method: "POST", requestBody: { formData: { SAMLResponse: [assertion([[roleA, "712427214116"]])] } } });
await sleep(20);
assert.equal(session.creds.accessKeyId, "ASIATEST");
assert.equal(session.creds.accountId, "712427214116");
assert.equal(session.creds.roleName, "Enterprise_Role_DatabaseAdmin");
assert.equal(stsCalls[0].body.Action, "AssumeRoleWithSAML");
assert.equal(stsCalls[0].body.RoleArn, roleA);
assert.equal(stsCalls[0].body.PrincipalArn, prov("712427214116"));
console.log("  ok  single-role capture -> STS -> session storage");

// 2. non-SAML / GET requests are ignored
const before = stsCalls.length;
webRequestListener({ method: "GET" });
webRequestListener({ method: "POST", requestBody: { formData: { other: ["x"] } } });
await sleep(10);
assert.equal(stsCalls.length, before);
console.log("  ok  unrelated requests ignored");

// 3. multi-role: pending, then user picks one
delete session.creds;
const multi = assertion([[roleA, "712427214116"], [roleB, "111122223333"]]);
webRequestListener({ method: "POST", requestBody: { formData: { SAMLResponse: [multi] } } });
await sleep(20);
assert.ok(session.pending && !session.creds, "pending set, no creds yet");
assert.equal(session.pending.roles.length, 2);
const resp = await new Promise((res) => messageListener({ type: "assume-role", roleArn: roleB }, { id: "test-ext" }, res));
assert.equal(resp.ok, true);
assert.equal(session.creds.accountId, "111122223333");
assert.equal(session.pending, undefined);
console.log("  ok  multi-role: pending -> popup selection -> creds");

// 4. roleIndex from AWS's role chooser page is honoured
delete session.creds;
const multi2 = assertion([[roleA, "712427214116"], [roleB, "111122223333"], ["arn:aws:iam::999:role/Z", "999"]]);
webRequestListener({ method: "POST", requestBody: { formData: { SAMLResponse: [multi2], roleIndex: [roleB] } } });
await sleep(20);
assert.equal(session.creds.roleArn, roleB);
console.log("  ok  roleIndex form field selects the role");

// 5. messages from other senders are rejected
const rejected = messageListener({ type: "assume-role", roleArn: roleA }, { id: "evil-ext" }, () => {});
assert.equal(rejected, undefined);
console.log("  ok  foreign sender ignored");

// 6. bad assertion surfaces an error badge, no crash
webRequestListener({ method: "POST", requestBody: { formData: { SAMLResponse: [Buffer.from("<x/>").toString("base64")] } } });
await sleep(20);
assert.ok(session.lastError);
assert.equal(badge.at(-1), "!");
console.log("  ok  malformed assertion -> lastError + badge");

console.log("\nbackground checks passed");
