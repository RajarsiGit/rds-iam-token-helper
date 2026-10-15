// Minimal SigV4 (header auth) for AWS Query-protocol APIs (STS, RDS).

import { sha256Hex, hmac, toHex } from "./sigv4.js";

export async function signedPost({ service, region, host, body, credentials, now = new Date() }) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const headers = {
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    host,
    "x-amz-date": amzDate,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, names.join(";"), await sha256Hex(body)].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  const { host: _host, ...sendHeaders } = headers; // browsers set Host themselves
  return {
    url: `https://${host}/`,
    headers: {
      ...sendHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
    },
    body,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

const tag = (xml, name) => {
  const m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(xml);
  return m ? m[1].trim() : null;
};

export async function awsQuery({ service, region, host, params, credentials }) {
  const body = new URLSearchParams(params).toString();
  const req = await signedPost({ service, region, host, body, credentials });
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  const text = await res.text();
  if (!res.ok) {
    const code = tag(text, "Code") || String(res.status);
    const message = tag(text, "Message") || "request failed";
    const err = new Error(`${code}: ${message}`);
    err.awsCode = code;
    throw err;
  }
  return text;
}

/** Who do these credentials belong to? Needs no IAM permissions. */
export async function getCallerIdentity({ credentials }) {
  const xml = await awsQuery({
    service: "sts",
    region: "us-east-1",
    host: "sts.amazonaws.com",
    params: { Action: "GetCallerIdentity", Version: "2011-06-15" },
    credentials,
  });
  return parseCallerIdentity(xml);
}

export function parseCallerIdentity(xml) {
  const accountId = tag(xml, "Account");
  const arn = tag(xml, "Arn");
  if (!accountId || !arn) throw new Error("Unexpected GetCallerIdentity response");
  // arn:aws:sts::<acct>:assumed-role/<RoleName>/<session>
  const m = /:assumed-role\/([^/]+)\//.exec(arn);
  const roleName = m ? m[1] : arn.split("/").pop();
  return {
    accountId,
    roleName,
    roleArn: m ? `arn:aws:iam::${accountId}:role/${roleName}` : arn,
  };
}
