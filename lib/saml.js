// SAML helpers: decode the assertion and extract the AWS role attribute.

const ROLE_ATTR = "https://aws.amazon.com/SAML/Attributes/Role";

export function decodeAssertion(b64) {
  // The browser posts standard base64; form encoding may turn '+' into ' '.
  const clean = b64.replace(/ /g, "+").replace(/\s+/g, "");
  const bin = atob(clean);
  // Assertions are UTF-8; decode so non-ASCII attribute values survive.
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Returns [{ roleArn, principalArn, accountId, roleName }] from the assertion XML.
 * The attribute value is "<arn>,<arn>" in either order (role ARN contains ":role/",
 * provider ARN contains ":saml-provider/").
 */
export function extractRoles(xml) {
  const attrRe = new RegExp(
    '<(?:[\\w.-]+:)?Attribute\\b[^>]*\\bName="' +
      ROLE_ATTR.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&") +
      '"[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?Attribute>'
  );
  const attr = attrRe.exec(xml);
  if (!attr) return [];

  const roles = [];
  const valRe = /<(?:[\w.-]+:)?AttributeValue\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?AttributeValue>/g;
  let m;
  while ((m = valRe.exec(attr[1]))) {
    const parts = unescapeXml(m[1]).trim().split(",").map((p) => p.trim());
    if (parts.length !== 2) continue;
    const roleArn = parts.find((p) => /:role\//.test(p));
    const principalArn = parts.find((p) => /:saml-provider\//.test(p));
    if (!roleArn || !principalArn) continue;
    roles.push({
      roleArn,
      principalArn,
      accountId: roleArn.split(":")[4] || "",
      roleName: roleArn.split("/").pop(),
    });
  }
  return roles;
}
