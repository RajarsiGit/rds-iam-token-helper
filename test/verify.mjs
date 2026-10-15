// Verifies the extension's logic against the official AWS SDK and sample data.
// Run: npm install && npm test
import assert from "node:assert/strict";
import { Signer } from "@aws-sdk/rds-signer";
import { generateRdsAuthToken, regionFromHost } from "../lib/sigv4.js";
import { decodeAssertion, extractRoles } from "../lib/saml.js";
import { parseStsResponse } from "../lib/sts.js";
import { parseCredentialsText } from "../lib/creds.js";

// ---- freeze the clock so both implementations sign the same instant ----
const RealDate = Date;
const FIXED = new RealDate("2026-10-15T06:30:00.000Z");
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(FIXED.getTime());
    super(...args);
  }
  static now() {
    return FIXED.getTime();
  }
};

let passed = 0;
const ok = (name) => {
  passed++;
  console.log("  ok  " + name);
};

// ---------- 1. token vs official SDK ----------
const cases = [
  {
    name: "aurora instance, plain token",
    hostname: "dbserver-1.cluster-abc123.us-east-1.rds.amazonaws.com",
    port: 5432,
    username: "iam_user",
    region: "us-east-1",
    credentials: { accessKeyId: "ASIAEXAMPLEKEY12345", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", sessionToken: "FwoGZXIvYXdz+EXAMPLE/token==" },
  },
  {
    name: "rds proxy, other region, non-default port, special chars in user",
    hostname: "my-proxy.proxy-xyz789.ap-south-1.rds.amazonaws.com",
    port: 6432,
    username: "svc.reader@corp",
    region: "ap-south-1",
    credentials: { accessKeyId: "ASIAEXAMPLEKEY99999", secretAccessKey: "abc+def/ghi123EXAMPLE", sessionToken: "IQoJb3JpZ2luX2VjEXAMPLE+/+/AAA=" },
  },
];

for (const c of cases) {
  const signer = new Signer({
    hostname: c.hostname,
    port: c.port,
    username: c.username,
    region: c.region,
    credentials: c.credentials,
  });
  const expected = await signer.getAuthToken();
  const { token } = await generateRdsAuthToken({ ...c, now: FIXED });
  // SDK may or may not keep a scheme prefix; normalise.
  assert.equal(token, expected.replace(/^https?:\/\//, ""), `token mismatch for: ${c.name}`);
  ok("token matches @aws-sdk/rds-signer: " + c.name);
}

// ---------- 2. region detection ----------
assert.equal(regionFromHost("a.cluster-x.us-east-1.rds.amazonaws.com"), "us-east-1");
assert.equal(regionFromHost("p.proxy-x.ap-south-1.rds.amazonaws.com"), "ap-south-1");
assert.equal(regionFromHost("localhost"), null);
ok("region detection");

// ---------- 3. SAML role parsing ----------
const role = "arn:aws:iam::712427214116:role/Enterprise_Role_DatabaseAdmin";
const prov = "arn:aws:iam::712427214116:saml-provider/Okta";
const mk = (prefix, values) =>
  `<${prefix}:Response xmlns:${prefix}="urn:oasis:names:tc:SAML:2.0:protocol"><${prefix}:Assertion><${prefix}:AttributeStatement>` +
  `<${prefix}:Attribute Name="https://aws.amazon.com/SAML/Attributes/RoleSessionName"><${prefix}:AttributeValue>me@x.com</${prefix}:AttributeValue></${prefix}:Attribute>` +
  `<${prefix}:Attribute Name="https://aws.amazon.com/SAML/Attributes/Role" NameFormat="x">${values
    .map((v) => `<${prefix}:AttributeValue xsi:type="xs:string">${v}</${prefix}:AttributeValue>`)
    .join("")}</${prefix}:Attribute></${prefix}:AttributeStatement></${prefix}:Assertion></${prefix}:Response>`;

let r = extractRoles(mk("saml2", [`${role},${prov}`]));
assert.equal(r.length, 1);
assert.equal(r[0].roleArn, role);
assert.equal(r[0].principalArn, prov);
assert.equal(r[0].accountId, "712427214116");
assert.equal(r[0].roleName, "Enterprise_Role_DatabaseAdmin");
ok("single role (role,provider order, saml2: prefix)");

r = extractRoles(mk("saml", [`${prov},${role}`]));
assert.equal(r[0].roleArn, role);
assert.equal(r[0].principalArn, prov);
ok("provider,role order");

const role2 = "arn:aws:iam::111122223333:role/Other";
r = extractRoles(mk("saml2", [`${role},${prov}`, `${role2},arn:aws:iam::111122223333:saml-provider/Okta`]));
assert.equal(r.length, 2);
assert.equal(r[1].accountId, "111122223333");
ok("multiple roles");

assert.deepEqual(extractRoles("<a/>"), []);
ok("no role attribute gives empty list");

// base64 round trip, including '+' turned into ' ' by form encoding
const xml = mk("saml2", [`${role},${prov}`]);
const b64 = Buffer.from(xml, "utf8").toString("base64");
assert.equal(decodeAssertion(b64), xml);
assert.equal(decodeAssertion(b64.replace(/\+/g, " ")), xml);
ok("assertion decode");

// ---------- 4. STS response parsing ----------
const sts = parseStsResponse(`<AssumeRoleWithSAMLResponse><AssumeRoleWithSAMLResult><Credentials>
<AccessKeyId>ASIAXYZ</AccessKeyId><SecretAccessKey>sec/ret+1</SecretAccessKey>
<SessionToken>tok==</SessionToken><Expiration>2026-10-15T07:30:00Z</Expiration>
</Credentials></AssumeRoleWithSAMLResult></AssumeRoleWithSAMLResponse>`);
assert.deepEqual(sts, { accessKeyId: "ASIAXYZ", secretAccessKey: "sec/ret+1", sessionToken: "tok==", expiration: "2026-10-15T07:30:00Z" });
assert.throws(() => parseStsResponse("<Error/>"));
ok("STS response parsing");

// ---------- 5. pasted credentials (all three CloudKeeper formats) ----------
const want = { accessKeyId: "ASIA1", secretAccessKey: "se/c+r=et", sessionToken: "to/k+en==" };
assert.deepEqual(parseCredentialsText(`[default]\naws_access_key_id = ASIA1\naws_secret_access_key = se/c+r=et\naws_session_token = to/k+en==`), want);
assert.deepEqual(parseCredentialsText(`export AWS_ACCESS_KEY_ID="ASIA1"\nexport AWS_SECRET_ACCESS_KEY="se/c+r=et"\nexport AWS_SESSION_TOKEN="to/k+en=="`), want);
assert.deepEqual(parseCredentialsText(`$Env:AWS_ACCESS_KEY_ID="ASIA1"\n$Env:AWS_SECRET_ACCESS_KEY="se/c+r=et"\n$Env:AWS_SESSION_TOKEN="to/k+en=="`), want);
assert.throws(() => parseCredentialsText("nothing here"));
ok("pasted credentials: file, bash, powershell");

console.log(`\n${passed} checks passed`);
