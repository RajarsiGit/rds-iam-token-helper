// Service worker: observes the SAML POST to AWS sign-in, exchanges the
// assertion for temporary credentials via STS, and keeps them in
// chrome.storage.session (memory only, cleared when the browser closes).

import { decodeAssertion, extractRoles } from "./lib/saml.js";
import { assumeRoleWithSAML } from "./lib/sts.js";

const SAML_URL = "https://signin.aws.amazon.com/saml*";
let lastAssertion = "";

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function exchange(samlAssertion, role) {
  const c = await assumeRoleWithSAML({
    roleArn: role.roleArn,
    principalArn: role.principalArn,
    samlAssertion,
  });
  await chrome.storage.session.set({
    creds: {
      ...c,
      roleArn: role.roleArn,
      accountId: role.accountId,
      roleName: role.roleName,
      capturedAt: new Date().toISOString(),
      source: "saml",
    },
  });
  await chrome.storage.session.remove(["pending", "lastError"]);
  setBadge("OK", "#188038");
}

async function handleSaml(samlB64, selectedRoleArn) {
  if (samlB64 === lastAssertion) return; // same POST seen twice
  lastAssertion = samlB64;

  const roles = extractRoles(decodeAssertion(samlB64));
  if (!roles.length) throw new Error("No AWS role attribute found in the SAML assertion");

  const picked = selectedRoleArn
    ? roles.find((r) => r.roleArn === selectedRoleArn)
    : roles.length === 1
      ? roles[0]
      : null;

  if (picked) return exchange(samlB64, picked);

  // Several roles and none chosen yet: let the user pick in the popup.
  await chrome.storage.session.set({ pending: { saml: samlB64, roles, at: Date.now() } });
  setBadge("?", "#f9ab00");
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const form = details.requestBody && details.requestBody.formData;
    const saml = form && form.SAMLResponse && form.SAMLResponse[0];
    if (!saml) return;

    handleSaml(saml, form.roleIndex && form.roleIndex[0]).catch(async (err) => {
      await chrome.storage.session.set({ lastError: { message: String(err.message || err), at: Date.now() } });
      setBadge("!", "#d93025");
    });
  },
  { urls: [SAML_URL], types: ["main_frame", "sub_frame"] },
  ["requestBody"]
);

// Popup asks us to finish a multi-role sign-in.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== "assume-role") return;
  (async () => {
    const { pending } = await chrome.storage.session.get("pending");
    if (!pending) throw new Error("No pending sign-in. Log in through the portal again.");
    const role = pending.roles.find((r) => r.roleArn === msg.roleArn);
    if (!role) throw new Error("Role not found in the assertion");
    await exchange(pending.saml, role);
  })()
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // async response
});
