// AssumeRoleWithSAML against the global STS endpoint. The call is unsigned:
// the SAML assertion itself is the credential.

function tag(xml, name) {
  const m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(xml);
  return m ? m[1].trim() : null;
}

export function parseStsResponse(xml) {
  const accessKeyId = tag(xml, "AccessKeyId");
  const secretAccessKey = tag(xml, "SecretAccessKey");
  const sessionToken = tag(xml, "SessionToken");
  const expiration = tag(xml, "Expiration");
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error("STS response did not contain credentials");
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
}

export async function assumeRoleWithSAML({ roleArn, principalArn, samlAssertion }) {
  const body = new URLSearchParams({
    Action: "AssumeRoleWithSAML",
    Version: "2011-06-15",
    RoleArn: roleArn,
    PrincipalArn: principalArn,
    SAMLAssertion: samlAssertion,
  });

  const res = await fetch("https://sts.amazonaws.com/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();

  if (!res.ok) {
    const code = tag(text, "Code") || String(res.status);
    const msg = tag(text, "Message") || "STS request failed";
    throw new Error(`${code}: ${msg}`);
  }
  return parseStsResponse(text);
}
