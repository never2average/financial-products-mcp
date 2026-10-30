import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";

// A stand-in for boat.dev: sandboxes become ready when told to, files live in memory, and the agent's
// work is simulated by writing its status and result files.
function fakeBoat() {
  const sandboxes = new Map();
  let n = 0;
  return {
    sandboxes,
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "provisioning", opts, files: new Map(), prompts: [], steers: [], stopped: false, interrupted: false, cost: 0 });
      return { id, state: "provisioning" };
    },
    async getSandbox(id) {
      return sandboxes.get(id);
    },
    async writeFile(id, path, content) {
      sandboxes.get(id).files.set(path, content);
    },
    async readFile(id, path) {
      return sandboxes.get(id).files.get(path) ?? null;
    },
    async prompt(id, opts) {
      const s = sandboxes.get(id);
      s.prompts.push({ ...opts, status: "running", done: false });
      return { promptId: `p_${s.prompts.length}`, conversationId: "c1" };
    },
    async promptStatus(id) {
      const p = sandboxes.get(id).prompts.at(-1);
      return { status: p.status, done: p.done };
    },
    async events() {
      return [{ id: "e1", type: "tool_use", timestamp: Date.now(), data: { tool: "bash", command: "npm test" } }];
    },
    async steer(id, message) {
      sandboxes.get(id).steers.push(message);
    },
    async interrupt(id) {
      sandboxes.get(id).interrupted = true;
    },
    async host(id, port) {
      return { url: `https://${id}-${port}.preview.example?_token=t` };
    },
    async costDollars(id) {
      return sandboxes.get(id).cost;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
    // Test controls
    ready(id) {
      sandboxes.get(id).state = "ready";
    },
    agentWrites(id, path, value) {
      sandboxes.get(id).files.set(path, JSON.stringify(value));
    },
    agentFinishes(id, status = "finished") {
      const p = sandboxes.get(id).prompts.at(-1);
      p.status = status;
      p.done = true;
    },
  };
}

const fakeRepos = () => ({
  async installationFor(repo) {
    return repo === "acme/savings-app" ? 42 : null;
  },
  async tokenFor() {
    return { token: "ghs_short_lived", expires_at: new Date(Date.now() + 3600e3).toISOString() };
  },
  installUrl: () => "https://github.com/apps/mynt-builder/installations/new",
});

async function setup({ boat = fakeBoat(), config = {} } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db);
  const builds = await BuildService.open(db, store, boat, fakeRepos(), { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", ...config });
  const as = async (name, roles) => (await store.createUser(name, roles)).user;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    return { isError: res.isError ?? false, data };
  };
  return { pg, store, builds, boat, as, connect, call };
}

const goodResult = {
  maxwell: { counts: { critical: 0, high: 0, medium: 2, low: 5 }, findings: [], summary: "No blocking findings" },
  readiness: [
    { name: "tests", status: "pass" },
    { name: "secrets_scan", status: "pass" },
    { name: "sbom", status: "pass" },
    { name: "disclosures", status: "pass" },
  ],
  preview: { port: 8080 },
  push: { branch: "mynt/build-x", commit: "abc123", pr_url: "https://github.com/acme/savings-app/pull/7" },
};

test("a build runs end to end: sandbox, agent, tracked phases, Maxwell and readiness gates, preview and PR", async () => {
  const { builds, boat, as, connect, call } = await setup();
  const devUser = await as("Dev", ["developer"]);
  const dev = await connect(devUser);
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;

  assert.equal((await call(dev, "connect_repository", { repository: "acme/other" })).data.connected, false, "app not installed there");
  assert.equal((await call(dev, "connect_repository", { repository: "acme/savings-app" })).data.connected, true);
  const started = (await call(dev, "start_build", { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app" })).data;
  assert.equal(started.status, "queued");
  assert.equal(started.cap_usd, 10);

  await builds.tick();
  let b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "provisioning");
  const sbx = boat.sandboxes.get(b.sandbox_id);
  assert.equal(sbx.opts.env.GITHUB_TOKEN, "ghs_short_lived", "a repo-scoped token, only as an env var");
  assert.equal(sbx.opts.env.GITHUB_REPOSITORY, "acme/savings-app");

  await builds.tick();
  assert.equal((await call(dev, "get_build", { build_id: started.id })).data.status, "provisioning", "waits for the sandbox");
  boat.ready(b.sandbox_id);
  await builds.tick();
  b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "coding");
  const task = sbx.files.get("/root/mynt/TASK.md");
  assert.match(task, /OnFinance\/Maxwell/);
  assert.match(task, /critical and high finding/);
  assert.match(task, /never moves money/);
  assert.doesNotMatch(task, /ghs_short_lived/, "the token is never written into files");
  const spec = JSON.parse(sbx.files.get("/root/mynt/build.json"));
  assert.equal(spec.products[0].id, "fixed-deposit");
  assert.ok(spec.products[0].build_terms);
  assert.equal(spec.mynt_api, "https://mynt.example.com/v1");

  // The agent reports progress; Mynt mirrors it into the timeline.
  boat.agentWrites(b.sandbox_id, "/root/mynt/status.json", { phase: "auditing", message: "Running Maxwell static probes" });
  sbx.cost = 1.25;
  await builds.tick();
  b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "auditing");
  assert.equal(b.phase_message, "Running Maxwell static probes");
  assert.equal(b.cost_usd, 1.25);
  const activity = (await call(dev, "get_build_activity", { build_id: started.id })).data;
  assert.equal(activity.activity[0].type, "tool_use");

  assert.equal((await call(dev, "steer_build", { build_id: started.id, message: "Use the existing design system" })).data.steered, true);
  assert.deepEqual(sbx.steers, ["Use the existing design system"]);

  boat.agentWrites(b.sandbox_id, "/root/mynt/result.json", goodResult);
  boat.agentFinishes(b.sandbox_id);
  await builds.tick();
  b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "succeeded");
  assert.match(b.preview_url, /-8080\.preview\.example\?_token=/);
  assert.equal(b.pr_url, "https://github.com/acme/savings-app/pull/7");
  assert.equal(b.maxwell.counts.medium, 2);
  const phases = b.timeline.map((e) => e.phase).filter((p, i, a) => p !== a[i - 1]);
  assert.deepEqual(phases, ["queued", "provisioning", "coding", "auditing", "succeeded"]);
  assert.ok(b.timeline.some((e) => e.message === "Steered by the developer" && e.data.message === "Use the existing design system"));
  const listed = (await call(dev, "list_builds")).data;
  assert.equal(listed.month_spend_usd, 1.25);
});

for (const [label, result, status, pattern] of [
  ["high Maxwell findings block the build", { ...goodResult, maxwell: { counts: { critical: 0, high: 1 } } }, "blocked", /Security gate: 1/],
  ["a build can't ship without a Maxwell audit", { ...goodResult, maxwell: undefined }, "blocked", /No Maxwell audit/],
  ["unmet readiness checks fail the build", { ...goodResult, readiness: [{ name: "secrets_scan", status: "fail" }] }, "failed", /secrets_scan/],
]) {
  test(label, async () => {
    const { builds, boat, as, connect, call } = await setup();
    const dev = await connect(await as("Dev", ["developer"]));
    const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
    await builds.tick();
    const id = (await builds.get(started.id)).sandbox_id;
    boat.ready(id);
    await builds.tick();
    boat.agentWrites(id, "/root/mynt/result.json", result);
    boat.agentFinishes(id);
    await builds.tick();
    const b = (await call(dev, "get_build", { build_id: started.id })).data;
    assert.equal(b.status, status);
    assert.match(b.error, pattern);
    assert.equal(b.pr_url, null);
  });
}

test("spend caps: a build stops when it passes its cap, and the monthly budget refuses new builds", async () => {
  const { builds, boat, as, connect, call } = await setup({ config: { capUsd: 5, monthlyCapUsd: 8 } });
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please", cap_usd: 50 })).data;
  assert.equal(started.cap_usd, 5, "capped at the platform maximum");
  await builds.tick();
  const id = (await builds.get(started.id)).sandbox_id;
  boat.ready(id);
  await builds.tick();
  boat.sandboxes.get(id).cost = 5.4;
  await builds.tick();
  const b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "over_budget");
  assert.ok(boat.sandboxes.get(id).stopped && boat.sandboxes.get(id).interrupted);
  // 5.40 spent + a 5.00 cap would exceed the 8.00 month.
  assert.match((await call(dev, "start_build", { goal: "Another build please" })).data.error, /Monthly build budget/);
});

test("developers stop their own builds, can't see others', and admins see all", async () => {
  const { builds, boat, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const admin = await connect(await as("Ada", ["admin"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  assert.equal((await call(other, "get_build", { build_id: started.id })).isError, true);
  assert.equal((await call(other, "stop_build", { build_id: started.id })).isError, true);
  const stopped = (await call(dev, "stop_build", { build_id: started.id })).data;
  assert.equal(stopped.status, "stopped");
  assert.ok(boat.sandboxes.get(stopped.sandbox_id).stopped);
  assert.equal((await call(admin, "list_all_builds")).data.builds.length, 1);
  assert.match((await call(dev, "steer_build", { build_id: started.id, message: "go on" })).data.error, /only a running agent/);
});

test("without a boat.dev key builds are disabled cleanly, and the agent never connects outside services", async () => {
  const { as, connect, call } = await setup({ boat: null });
  const dev = await connect(await as("Dev", ["developer"]));
  assert.match((await call(dev, "start_build", { goal: "Build a savings page please" })).data.error, /aren't enabled/);
  const { buildTask } = await import("../dist/builds.js");
  const task = buildTask({ id: "x", repository: null, branch: null, maxwellRepo: "https://github.com/OnFinance/Maxwell", files: { task: "t", spec: "s", status: "st", result: "r" } });
  assert.match(task, /Do not connect any external service or sign in anywhere/);
});
