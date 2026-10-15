// RDS / RDS Proxy IAM auth token = SigV4 presigned GET URL for rds-db:connect
// (scheme stripped). Pure WebCrypto, no dependencies. Verified against
// @aws-sdk/rds-signer in test/verify.mjs.

const enc = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

// RFC 3986 percent-encoding, as SigV4 requires.
const encode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export { toHex, sha256Hex, hmac };

/** Best-effort region detection from an RDS / Aurora / Proxy endpoint. */
export function regionFromHost(host) {
  const m = /\.([a-z]{2,}(?:-[a-z]+)+-\d)\.rds\.amazonaws\.com(?:\.cn)?$/i.exec(host || "");
  return m ? m[1].toLowerCase() : null;
}

export async function generateRdsAuthToken({
  hostname,
  port = 5432,
  username,
  region,
  credentials,
  expiresIn = 900,
  now = new Date(),
}) {
  if (!hostname || !username || !region) throw new Error("hostname, username and region are required");
  const { accessKeyId, secretAccessKey, sessionToken } = credentials || {};
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS credentials are missing");

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20261015T063000Z
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/rds-db/aws4_request`;
  const host = `${hostname}:${port}`;

  const params = {
    Action: "connect",
    DBUser: username,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  };
  if (sessionToken) params["X-Amz-Security-Token"] = sessionToken;

  const query = Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k])}`)
    .join("&");

  const canonicalRequest = ["GET", "/", query, `host:${host}\n`, "host", EMPTY_SHA256].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "rds-db");
  const kSigning = await hmac(kService, "aws4_request");
  params["X-Amz-Signature"] = toHex(await hmac(kSigning, stringToSign));

  // The SDK emits all parameters sorted, signature included.
  const signedQuery = Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k])}`)
    .join("&");

  return {
    token: `${host}/?${signedQuery}`,
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
  };
}
