import { generateRdsAuthToken, regionFromHost } from "../lib/sigv4.js";
import { parseCredentialsText } from "../lib/creds.js";
import { getCallerIdentity } from "../lib/aws.js";
import { listDatabases } from "../lib/discover.js";
import { REGIONS } from "../lib/regions.js";

const $ = (id) => document.getElementById(id);
const MAX_RECENTS = 8;
const MANUAL = "__manual__";
const CACHE_MS = 15 * 60 * 1000;

let creds = null;
let pending = null;
let lastAccount;          // account the form is currently scoped to
let recents = [];         // recent connections for that account
let loadSeq = 0;          // guards against stale database-list responses
let inflight = null;      // "account|region" currently being loaded
const found = new Map();  // endpoint -> discovered entry

const accountKey = () => (creds && creds.accountId) || "unknown";

const opt = (value, text, title) => {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  if (title) o.title = title;
  return o;
};

function say(text, kind = "info") {
  const el = $("msg");
  el.textContent = text || "";
  el.className = "msg " + (text ? kind : "");
}

const hint = (text) => {
  $("hostHint").textContent = text || "";
};

function fmtRemaining(ms) {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const isExpired = () => !!(creds && creds.expiration && new Date(creds.expiration).getTime() <= Date.now());

// ---------- credentials card ----------
function renderCreds() {
  const pill = $("status");
  $("credCard").hidden = !creds;
  $("empty").hidden = !!creds || !!pending;
  $("rolePicker").hidden = !pending;

  if (!creds) {
    pill.textContent = "No credentials";
    pill.className = "pill bad";
    return;
  }
  $("account").textContent = creds.accountId || "unknown";
  $("role").textContent = creds.roleName || "unknown";

  if (creds.expiration) {
    const left = new Date(creds.expiration).getTime() - Date.now();
    $("expiry").textContent = fmtRemaining(left);
    pill.textContent = left > 0 ? "Active" : "Expired";
    pill.className = "pill " + (left > 0 ? (left < 5 * 60 * 1000 ? "warn" : "ok") : "bad");
  } else {
    $("expiry").textContent = "unknown (pasted)";
    pill.textContent = "Active";
    pill.className = "pill ok";
  }
}

// ---------- region ----------
function setRegion(r) {
  if (!r) return;
  const sel = $("region");
  if (![...sel.options].some((o) => o.value === r)) sel.appendChild(opt(r, r));
  sel.value = r;
}

// ---------- endpoint dropdown ----------
/** Strip scheme, path and :port from pasted text. Pure: no side effects. */
function cleanHost(raw) {
  let host = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "");
  let port = null;
  const m = /^(.*):(\d{1,5})$/.exec(host);
  if (m) {
    host = m[1];
    port = m[2];
  }
  return { host, port };
}

function normalizeHost(raw) {
  const { host, port } = cleanHost(raw);
  if (port) $("port").value = port;
  return host;
}

function showManual(on) {
  $("hostManual").hidden = !on;
  if (on) $("hostManual").focus();
}

/** Rebuild the dropdown. `current` stays selected even if it is not in `entries` (e.g. a recent connection). */
function renderHostOptions(entries, current = $("host").value) {
  const sel = $("host");
  sel.replaceChildren();
  sel.appendChild(opt("", entries.length ? "Select a database..." : "No databases loaded"));
  for (const e of entries) sel.appendChild(opt(e.host, e.label, e.host));
  if (current && current !== MANUAL && !entries.some((e) => e.host === current)) {
    sel.appendChild(opt(current, current, current));
  }
  sel.appendChild(opt(MANUAL, "Enter endpoint manually..."));
  sel.value = current && [...sel.options].some((o) => o.value === current) ? current : "";
}

function setHost(h) {
  const sel = $("host");
  if (![...sel.options].some((o) => o.value === h)) sel.insertBefore(opt(h, h, h), sel.lastChild);
  sel.value = h;
  showManual(false);
}

function getHost() {
  const v = $("host").value;
  return v === MANUAL ? normalizeHost($("hostManual").value) : v;
}

function applyEntries(entries) {
  found.clear();
  for (const e of entries) found.set(e.host, e);
  renderHostOptions(entries);
  hint(entries.length ? "" : "No databases or proxies found in this region. Use \"Enter endpoint manually...\".");
}

async function loadDatabases({ interactive = false, force = false } = {}) {
  if (!creds) return interactive ? say("No AWS credentials. Log in through the portal first.", "err") : undefined;
  if (isExpired()) return interactive ? say("Credentials expired. Log in through the portal again.", "err") : undefined;

  const region = $("region").value;
  const origin = `https://rds.${region}.amazonaws.com/*`;
  const key = `${accountKey()}|${region}`;

  // Permission first: request() must run while the click's user gesture is still active.
  try {
    if (interactive) {
      if (!(await chrome.permissions.request({ origins: [origin] }))) {
        return say(`Permission to call RDS in ${region} was not granted.`, "err");
      }
    } else if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      return hint(`Click "Find databases..." to list databases in ${region} (Chrome will ask once).`);
    }
  } catch (e) {
    return interactive ? say(`Cannot access RDS in ${region}: ${e.message || e}`, "err") : hint(String(e.message || e));
  }

  if (!force) {
    const { dbcache = {} } = await chrome.storage.session.get("dbcache");
    const hit = dbcache[key];
    if (hit && Date.now() - hit.at < CACHE_MS) {
      if (region === $("region").value) applyEntries(hit.entries);
      return;
    }
  }
  if (!force && inflight === key) return;

  inflight = key;
  const seq = ++loadSeq;
  hint(`Loading databases in ${region}...`);
  if (interactive) say(`Looking up databases in ${region}...`);
  try {
    const { entries, errors } = await listDatabases({
      credentials: creds,
      region,
      parseXml: (t) => new DOMParser().parseFromString(t, "text/xml"),
    });
    if (seq !== loadSeq || region !== $("region").value) return; // user moved on
    const { dbcache = {} } = await chrome.storage.session.get("dbcache");
    dbcache[key] = { entries, at: Date.now() };
    await chrome.storage.session.set({ dbcache });
    applyEntries(entries);
    if (errors.length) hint(`Some lookups failed: ${errors.join("; ")}`);
    if (interactive) say(entries.length ? `Found ${entries.length} endpoint(s) in ${region}.` : `No databases found in ${region}.`, errors.length ? "err" : "ok");
  } catch (e) {
    if (seq !== loadSeq) return;
    const m = String(e.message || e);
    hint(`Could not list databases (${m}). Choose "Enter endpoint manually...".`);
    if (interactive) say(m, "err");
  } finally {
    if (inflight === key) inflight = null;
  }
}

// ---------- recents (per account) ----------
async function loadRecents() {
  const { recentByAccount = {} } = await chrome.storage.local.get("recentByAccount");
  recents = recentByAccount[accountKey()] || [];
  const sel = $("recent");
  sel.replaceChildren();
  sel.appendChild(opt("", "Choose a recent connection..."));
  recents.forEach((r, i) => sel.appendChild(opt(String(i), `${r.user} @ ${r.host}`, r.host)));
  $("recent").hidden = $("recentLabel").hidden = !recents.length;
}

function fillFrom(r) {
  setRegion(r.region);
  setHost(r.host);
  $("port").value = r.port;
  $("user").value = r.user;
}

async function rememberConnection(c) {
  const { recentByAccount = {} } = await chrome.storage.local.get("recentByAccount");
  const key = accountKey();
  const list = (recentByAccount[key] || []).filter(
    (r) => !(r.host === c.host && r.user === c.user && r.port === c.port && r.region === c.region)
  );
  list.unshift(c);
  recentByAccount[key] = list.slice(0, MAX_RECENTS);
  await chrome.storage.local.set({ recentByAccount });
  await loadRecents();
}

// ---------- scope the form to the logged-in account ----------
async function syncAccount() {
  if (accountKey() === lastAccount) return;
  lastAccount = accountKey();
  found.clear();
  renderHostOptions([], "");
  showManual(false);
  hint("");
  await loadRecents();
  if (recents.length) fillFrom(recents[0]);
  else {
    $("user").value = "";
    $("port").value = "5432";
  }
  loadDatabases();
}

// ---------- token ----------
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $("token").select();
    try {
      document.execCommand("copy");
    } catch {
      /* the token is still visible in the box */
    }
  }
}

async function generate() {
  say("");
  if (!creds) return say("No AWS credentials. Log in through the portal first.", "err");
  if (isExpired()) return say("Credentials expired. Log in through the portal again.", "err");

  const host = getHost();
  const user = $("user").value.trim();
  const port = Number($("port").value) || 5432;
  const region = $("region").value;
  if (!host) return say("Choose a database / proxy endpoint, or enter one manually.", "err");
  if (!user) return say("Enter the database user.", "err");

  try {
    const { token, expiresAt } = await generateRdsAuthToken({
      hostname: host,
      port,
      username: user,
      region,
      credentials: creds,
    });
    $("token").value = token;
    await copy(token);
    await rememberConnection({ host, port, user, region });

    let meta = `Copied. Token valid until ${expiresAt.toLocaleTimeString()} (15 min).`;
    if (creds.expiration && new Date(creds.expiration) < expiresAt) {
      meta += ` Your AWS session ends sooner, at ${new Date(creds.expiration).toLocaleTimeString()}.`;
    }
    $("tokenMeta").textContent = meta;
    say("Token copied to clipboard.", "ok");
  } catch (e) {
    say(String(e.message || e), "err");
  }
}

// ---------- state ----------
async function refresh() {
  const hadCreds = !!creds;
  const s = await chrome.storage.session.get(["creds", "pending", "lastError"]);
  creds = s.creds || null;
  pending = s.pending || null;

  const sel = $("roleSelect");
  sel.replaceChildren();
  if (pending) for (const r of pending.roles) sel.appendChild(opt(r.roleArn, `${r.accountId} / ${r.roleName}`));

  renderCreds();
  await syncAccount();
  if (!hadCreds && creds) loadDatabases();
  if (s.lastError && !creds) say(`Last capture failed: ${s.lastError.message}`, "err");
}

// ---------- wiring ----------
for (const r of REGIONS) $("region").appendChild(opt(r, r));
$("region").value = "us-east-1";
renderHostOptions([], "");

$("genBtn").addEventListener("click", generate);
$("findBtn").addEventListener("click", () => loadDatabases({ interactive: true, force: true }));

$("region").addEventListener("change", () => {
  found.clear();
  renderHostOptions([], "");
  showManual(false);
  hint("");
  loadDatabases();
});

$("host").addEventListener("change", () => {
  const v = $("host").value;
  if (v === MANUAL) return showManual(true);
  showManual(false);
  const e = found.get(v);
  if (e) {
    $("port").value = e.port;
    setRegion(e.region);
  } else {
    const r = regionFromHost(v);
    if (r) setRegion(r);
  }
});

$("hostManual").addEventListener("input", () => {
  const r = regionFromHost(cleanHost($("hostManual").value).host);
  if (r) setRegion(r);
});

$("recent").addEventListener("change", () => {
  const r = recents[Number($("recent").value)];
  if (!r) return;
  const regionChanged = $("region").value !== r.region;
  fillFrom(r);
  if (regionChanged) loadDatabases();
});

$("assumeBtn").addEventListener("click", async () => {
  say("Requesting credentials...");
  const res = await chrome.runtime.sendMessage({ type: "assume-role", roleArn: $("roleSelect").value });
  if (res && res.ok) {
    say("Credentials ready.", "ok");
    refresh();
  } else {
    say(res ? res.error : "No response from background worker", "err");
  }
});

$("pasteBtn").addEventListener("click", async () => {
  try {
    const c = parseCredentialsText($("paste").value);
    say("Checking credentials with AWS...");
    let who = {};
    try {
      who = await getCallerIdentity({ credentials: c });
    } catch (e) {
      // AWS answered and rejected them: don't store. Network-type errors: keep going without account info.
      if (e.awsCode) return say(`AWS rejected these credentials: ${e.message}`, "err");
    }
    await chrome.storage.session.set({
      creds: { ...c, ...who, capturedAt: new Date().toISOString(), source: "pasted", expiration: null },
    });
    $("paste").value = "";
    say(who.accountId ? `Loaded credentials for account ${who.accountId}.` : "Credentials loaded (account could not be resolved).", "ok");
    refresh();
  } catch (e) {
    say(String(e.message || e), "err");
  }
});

chrome.storage.onChanged.addListener((_, area) => {
  if (area === "session") refresh();
});

setInterval(renderCreds, 1000);
await refresh();
