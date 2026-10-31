import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostingService } from "../dist/hosting.js";
import { createMcpHttpServer } from "../dist/http.js";
import { ModuleRegistry } from "../dist/modules.js";
import { createServer } from "../dist/server.js";
import { publishDefined, setup, definitionFor } from "./v2-helpers.js";

// Records what Mynt asks of the cloud.
function fakeProvider() {
  const calls = [];
  return {
    calls,
    name: "fake",
    async createVm(spec) {
      calls.push(["create", spec]);
      return { id: "vm-1" };
    },
    async lockDown(id, ip, port) {
      calls.push(["lockDown", id, ip, port]);
    },
    async powerOff(id) {
      calls.push(["powerOff", id]);
    },
    async powerOn(id) {
      calls.push(["powerOn", id]);
    },
    async deleteVm(id) {
      calls.push(["delete", id]);
    },
  };
}
const CONFIG = {
  publicUrl: "https://mynt.example.com",
  gatewayEndpoint: "203.0.113.10:51820",
  gatewayPublicKey: "G".repeat(43) + "=",
  gatewayIp: "203.0.113.10",
  region: "blr1",
  size: "s-1vcpu-2gb",
  appsDomain: "apps.example.com",
};
const WG_KEY = "A".repeat(43) + "=";

async function world() {
  const ctx = await setup();
  await publishDefined(ctx, (d) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    return d;
  });
  await ctx.call(ctx.client, "set_product_access", {
    id: "everyday-rd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" },
  });
  const provider = fakeProvider();
  const hosting = await HostingService.open(ctx.store.db, provider, CONFIG, async () => "ghs_readonly");
  const modules = await ModuleRegistry.open(ctx.store.db);
  const connectWith = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(ctx.store, user, { hosting, modules }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const { user: devUser } = await ctx.store.createUser("Dev", ["developer"]);
  const dev = await connectWith(devUser);
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "Daily saving", audience: "Savers", product_ids: ["everyday-rd"] })).data;
  // The builds service owns build_runs; a minimal table stands in for it here.
  await ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS financial_products.build_runs (id uuid PRIMARY KEY, developer_id uuid, app_id uuid, repository text, commit_sha text, status text)`);
  const build = async (status, sha = "a".repeat(40)) => {
    const id = randomUUID();
    await ctx.store.db.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, repository, commit_sha, status) VALUES ($1, $2, $3, $4, $5, $6)", [id, devUser.id, app.id, "dev/saver", sha, status]);
    return id;
  };
  const http = createMcpHttpServer(ctx.store, null, { hosting, modules }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const close = () => {
    http.closeAllConnections();
    http.close();
  };
  return { ...ctx, provider, hosting, modules, connectWith, devUser, dev, app, build, api, close };
}

test("hosting: a locked-down VM per developer, apps from verified builds, a policy over the tunnel, and a kill switch", async () => {
  const w = await world();
  try {
    const { call, dev, api } = w;
    const tenant = (await call(dev, "request_hosting")).data;
    assert.equal(tenant.status, "provisioning");
    const [, spec] = w.provider.calls.find(([c]) => c === "create");
    assert.deepEqual([spec.region, spec.size, spec.tags], ["blr1", "s-1vcpu-2gb", ["mynt-tenant"]]);
    assert.match(spec.userData, /wg genkey/, "the VM makes its own WireGuard key");
    assert.match(spec.userData, /--runtime runsc --read-only/, "apps run under gVisor, read-only");
    assert.doesNotMatch(spec.userData, /PrivateKey = [A-Za-z0-9+/]{43}=/, "no private key is ever sent to it");
    const token = spec.userData.match(/\\"token\\":\\"([A-Za-z0-9_-]+)\\"/)[1];
    assert.equal((await call(dev, "request_hosting")).data.id, tenant.id, "one VM per developer");

    // It registers once, gets its tunnel address, and is locked down to WireGuard to the gateway.
    assert.equal((await api("POST", "/v1/hosting/bootstrap", null, { token, wg_public_key: "not a key" })).status, 400);
    const reg = await api("POST", "/v1/hosting/bootstrap", null, { token, wg_public_key: WG_KEY });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.tunnel_ip, "10.88.1.2");
    assert.deepEqual(w.provider.calls.find(([c]) => c === "lockDown"), ["lockDown", "vm-1", "203.0.113.10", 51820]);
    assert.equal((await api("POST", "/v1/hosting/bootstrap", null, { token, wg_public_key: WG_KEY })).status, 401, "the token works once");
    const agent = reg.body.agent_token;

    // Only builds Mynt verified are deployed.
    const failed = await w.build("failed");
    assert.match((await call(dev, "deploy_app", { app_id: w.app.id, build_id: failed })).data.error, /didn't pass Mynt's verification/);
    const ok = await w.build("succeeded");
    const deployed = await call(dev, "deploy_app", { app_id: w.app.id, build_id: ok });
    assert.equal(deployed.isError, false, JSON.stringify(deployed.data));
    assert.equal(deployed.data.port, 9000);
    assert.equal(deployed.data.environment, "sandbox");
    assert.ok(deployed.data.egress.includes("bank.example.com") && deployed.data.egress.includes("mynt.example.com") && !deployed.data.egress.includes("evil.example.com"));

    // The agent's policy: the verified commit, a read-only token to fetch it, the app's dedicated key.
    assert.equal((await api("GET", "/v1/hosting/policy", "wrong")).status, 401);
    const policy = (await api("GET", "/v1/hosting/policy", agent)).body;
    const [a] = policy.apps;
    assert.equal(a.commit_sha, "a".repeat(40));
    assert.equal(a.source_url, `https://api.github.com/repos/dev/saver/tarball/${"a".repeat(40)}`);
    assert.equal(a.source_token, "ghs_readonly");
    assert.match(a.app_key, /^mynt_test_/);
    assert.equal(a.tunnel_ip, "10.88.1.2");
    const sealed = (await w.store.db.query("SELECT app_key_sealed FROM financial_products.hosted_apps")).rows[0].app_key_sealed;
    assert.ok(!sealed.includes(a.app_key), "the app key is stored sealed");

    // The gateway's peers and the edge's routes.
    assert.match(await w.hosting.wireguardPeers(), new RegExp(`PublicKey = ${WG_KEY.replace(/[+/=]/g, "\\$&")}\\nAllowedIPs = 10.88.1.2/32`));
    assert.deepEqual(await w.hosting.routes(), [{ host: `${w.app.id.slice(0, 8)}.apps.example.com`, upstream: "10.88.1.2:9000" }]);

    // The kill switch: off the gateway at once, powered off; resume brings it back.
    const { user: adminUser } = await w.store.createUser("Ada", ["admin"]);
    const admin = await w.connectWith(adminUser);
    assert.equal((await call(admin, "suspend_tenant", { tenant_id: tenant.id, reason: "abuse report" })).data.status, "suspended");
    assert.ok(w.provider.calls.some(([c, id]) => c === "powerOff" && id === "vm-1"));
    assert.equal(await w.hosting.wireguardPeers(), "");
    assert.deepEqual(await w.hosting.routes(), []);
    assert.deepEqual((await api("GET", "/v1/hosting/policy", agent)).body, { apps: [], status: "suspended" });
    assert.equal((await call(admin, "resume_tenant", { tenant_id: tenant.id })).data.status, "running");
    assert.equal((await api("GET", "/v1/hosting/policy", agent)).body.apps.length, 1);

    assert.equal((await call(dev, "undeploy_app", { app_id: w.app.id })).isError, false);
    assert.deepEqual((await api("GET", "/v1/hosting/policy", agent)).body.apps, []);
  } finally {
    w.close();
  }
});

test("modules: manifests checked against live contracts, namespaces owned, outdated once a contract changes", async () => {
  const w = await world();
  try {
    const { call, dev } = w;
    const manifest = (over = {}) => ({
      module: "@asha/rd-planner",
      version: "1.0.0",
      description: "Plans a recurring deposit and sets up its mandate",
      runtime: "client",
      built_on: [{ product_id: "everyday-rd", contract_version: 1, actions: ["view_offers", "mandate_setup"] }],
      exports: [{ name: "RdPlanner", kind: "component", renders_documents: ["kfs"] }],
      consent_purposes: ["mandate_setup"],
      ...over,
    });
    const errors = async (m) => (await call(dev, "check_module", { manifest: m })).data.errors.join("\n");
    assert.match(await errors(manifest({ consent_purposes: [] })), /declare consent purpose 'mandate_setup'/);
    assert.match(await errors(manifest({ exports: [{ name: "RdPlanner", kind: "component" }] })), /must render document 'kfs'/);
    assert.match(await errors(manifest({ built_on: [{ product_id: "everyday-rd", contract_version: 1, actions: ["premature_closure"] }] })), /a client module can't use 'premature_closure'/);
    assert.match(await errors(manifest({ built_on: [{ product_id: "everyday-rd", contract_version: 7, actions: ["view_offers"] }] })), /on contract version 1, not 7/);
    assert.match(await errors(manifest({ source_build_id: randomUUID() })), /No build of yours/);

    const published = await call(dev, "publish_module", { manifest: manifest({ source_build_id: await w.build("succeeded") }) });
    assert.equal(published.isError, false, JSON.stringify(published.data));
    assert.equal(published.data.verified, true);
    assert.match((await call(dev, "publish_module", { manifest: manifest() })).data.error, /already published/);

    const { user: rivalUser } = await w.store.createUser("Ravi", ["developer"]);
    const rival = await w.connectWith(rivalUser);
    assert.match((await call(rival, "publish_module", { manifest: manifest({ module: "@asha/other", version: "1.0.0" }) })).data.error, /belongs to another developer/);
    const listed = (await call(rival, "list_modules", { query: "planner" })).data;
    assert.deepEqual(listed.map((m) => [m.module, m.verified, m.current, m.mine]), [["@asha/rd-planner", true, true, false]]);

    // The product publishes contract version 2: the module is outdated until republished on it.
    const def = definitionFor(w, (await w.store.grcRecords(w.entity.id)).find((r) => r.section === "risk_models").id);
    def.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    def.descriptions.summary = "A daily recurring deposit, now with a higher rate.";
    assert.equal((await call(w.client, "set_product_definition", { product_id: "everyday-rd", definition: def })).isError, false);
    await call(w.client, "test_product", { id: "everyday-rd" });
    assert.equal((await call(w.client, "publish_product", { id: "everyday-rd" })).isError, false);
    assert.equal((await call(rival, "list_modules", {})).data[0].current, false);
  } finally {
    w.close();
  }
});
