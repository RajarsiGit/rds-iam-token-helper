// Regenerates manifest.json so optional_host_permissions stay in sync with lib/regions.js.
// Run: node scripts/gen-manifest.mjs
import { writeFileSync } from "node:fs";
import { REGIONS } from "../lib/regions.js";

const manifest = {
  manifest_version: 3,
  name: "RDS IAM Token Helper",
  version: "1.1.0",
  description: "Captures your AWS SAML sign-in and generates RDS / RDS Proxy IAM authentication tokens for whichever account you are logged in to.",
  permissions: ["webRequest", "storage"],
  host_permissions: ["https://signin.aws.amazon.com/saml*", "https://sts.amazonaws.com/*"],
  optional_host_permissions: REGIONS.map((r) => `https://rds.${r}.amazonaws.com/*`),
  background: { service_worker: "background.js", type: "module" },
  icons: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
  action: {
    default_title: "RDS IAM Token",
    default_popup: "popup/popup.html",
    default_icon: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
  },
};

writeFileSync(new URL("../manifest.json", import.meta.url), JSON.stringify(manifest, null, 2) + "\n");
console.log("manifest.json written with", REGIONS.length, "optional RDS hosts");
