// List the RDS clusters, standalone instances and proxies visible to the
// current credentials in one region. Needs rds:DescribeDBClusters,
// rds:DescribeDBInstances and rds:DescribeDBProxies on the role.
// `parseXml` is injected (DOMParser in the popup, xmldom in tests).

import { awsQuery } from "./aws.js";

const kids = (el) => [...el.childNodes].filter((n) => n.nodeType === 1);
const nm = (n) => n.localName || n.nodeName;
const child = (el, name) => kids(el).find((k) => nm(k) === name);
const text = (el, ...path) => {
  let cur = el;
  for (const p of path) cur = cur && child(cur, p);
  return cur ? cur.textContent.trim() : undefined;
};

const PROXY_PORTS = { POSTGRESQL: 5432, MYSQL: 3306, SQLSERVER: 1433 };

async function pages(region, action, itemTag, credentials, parseXml) {
  const items = [];
  let marker;
  for (let i = 0; i < 20; i++) {
    const params = { Action: action, Version: "2014-10-31" };
    if (marker) params.Marker = marker;
    const xml = await awsQuery({
      service: "rds",
      region,
      host: `rds.${region}.amazonaws.com`,
      params,
      credentials,
    });
    const doc = parseXml(xml);
    items.push(...[...doc.getElementsByTagName(itemTag)]);
    const m = doc.getElementsByTagName("Marker")[0];
    marker = m && m.textContent.trim();
    if (!marker) break;
  }
  return items;
}

const clusters = (els, region) =>
  els.flatMap((c) => {
    const id = text(c, "DBClusterIdentifier");
    const port = Number(text(c, "Port")) || 5432;
    const engine = text(c, "Engine");
    const status = text(c, "Status");
    const iam = text(c, "IAMDatabaseAuthenticationEnabled") === "true";
    const out = [];
    const writer = text(c, "Endpoint");
    const reader = text(c, "ReaderEndpoint");
    if (writer) out.push({ kind: "cluster writer", id, host: writer, port, engine, status, iam, region });
    if (reader) out.push({ kind: "cluster reader", id, host: reader, port, engine, status, iam, region });
    return out;
  });

const instances = (els, region) =>
  els
    .filter((i) => !text(i, "DBClusterIdentifier")) // cluster members are reached via the cluster endpoints
    .map((i) => ({
      kind: "instance",
      id: text(i, "DBInstanceIdentifier"),
      host: text(i, "Endpoint", "Address"),
      port: Number(text(i, "Endpoint", "Port")) || 5432,
      engine: text(i, "Engine"),
      status: text(i, "DBInstanceStatus"),
      iam: text(i, "IAMDatabaseAuthenticationEnabled") === "true",
      region,
    }))
    .filter((e) => e.host);

const proxies = (els, region) =>
  els
    .map((p) => {
      const auth = p.getElementsByTagName("IAMAuth");
      const modes = [...auth].map((a) => a.textContent.trim());
      const family = text(p, "EngineFamily");
      return {
        kind: "proxy",
        id: text(p, "DBProxyName"),
        host: text(p, "Endpoint"),
        port: PROXY_PORTS[family] || 5432,
        engine: family && family.toLowerCase(),
        status: text(p, "Status"),
        iam: modes.some((m) => m === "REQUIRED" || m === "OPTIONAL"),
        region,
      };
    })
    .filter((e) => e.host);

export const labelFor = (e) =>
  `${e.id} · ${e.kind}${e.engine ? " · " + e.engine : ""}${e.iam ? "" : " · IAM auth off"}`;

export async function listDatabases({ credentials, region, parseXml }) {
  const jobs = [
    pages(region, "DescribeDBClusters", "DBCluster", credentials, parseXml).then((x) => clusters(x, region)),
    pages(region, "DescribeDBInstances", "DBInstance", credentials, parseXml).then((x) => instances(x, region)),
    pages(region, "DescribeDBProxies", "DBProxy", credentials, parseXml).then((x) => proxies(x, region)),
  ];
  const settled = await Promise.allSettled(jobs);
  const errors = settled.filter((s) => s.status === "rejected").map((s) => String(s.reason.message || s.reason));
  if (errors.length === settled.length) throw new Error(errors[0]);

  const entries = settled
    .filter((s) => s.status === "fulfilled")
    .flatMap((s) => s.value)
    .map((e) => ({ ...e, label: labelFor(e) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { entries, errors };
}
