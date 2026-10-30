import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuildService, buildConfigFromEnv, buildTask } from "../dist/builds.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";

const SHA = "a".repeat(64);
const COMMIT = "c".repeat(40);
const V = "/home/user/mynt-verify";

// A stand-in for boat.dev: sandboxes become ready when told to, files live in memory, the agents' work
// is simulated by writing files, and shell commands are matched by what they do.
function fakeBoat() {
  const sandboxes = new Map();
  let n = 0;
  const boat = {
    sandboxes,
    branchMatches: true,
    tamperDuringAudit: false,
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "provisioning", opts, files: new Map(), prompts: [], steers: [], commands: [], stopped: false, interrupted: false, cost: 0, checksRunning: true });
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
    async exec(id, command, opts = {}) {
      const s = sandboxes.get(id);
      s.commands.push({ command, ...opts });
      if (command.includes("tar --exclude")) return { exitCode: 0, stdout: `${SHA}  /home/user/mynt-out/app.tgz\n`, stderr: "" };
      if (command.includes("verify.sh --rehash")) {
        s.files.set(`${V}/after.sha`, boat.tamperDuringAudit ? "changed\n" : s.files.get(`${V}/before.sha`));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("verify.sh")) return { processId: 7, exitCode: null, stdout: "", stderr: "" };
      if (command.includes("git rev-parse")) return boat.branchMatches ? { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async commandStatus(id) {
      return { running: sandboxes.get(id).checksRunning, exitCode: sandboxes.get(id).checksRunning ? null : 0 };
    },
    async downloadUrl(id, path) {
      return `https://files.example/${id}${path}?sig=x`;
    },
    // Test controls
    ready(id) {
      sandboxes.get(id).state = "ready";
    },
    write(id, path, value) {
      sandboxes.get(id).files.set(path, typeof value === "string" ? value : JSON.stringify(value));
    },
    finishPrompt(id, status = "finished") {
      const p = sandboxes.get(id).prompts.at(-1);
      p.status = status;
      p.done = true;
    },
  };
  return boat;
}

function fakeRepos() {
  const prs = [];
  return {
    prs,
    async installationFor(repo) {
      return repo === "acme/savings-app" ? 42 : null;
    },
    async tokenFor() {
      return { token: "ghs_short_lived", expires_at: new Date(Date.now() + 3600e3).toISOString() };
    },
    installUrl: () => "https://github.com/apps/mynt-builder/installations/new",
    async openPullRequest(repo, installation, pr) {
      prs.push({ repo, installation, ...pr });
      return `https://github.com/${repo}/pull/7`;
    },
  };
}

async function setup({ boat = fakeBoat(), config = {} } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db);
  const repos = fakeRepos();
  const builds = await BuildService.open(db, store, boat, repos, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", ...config });
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
  return { pg, store, builds, boat, repos, as, connect, call };
}

const passingChecks = [
  { name: "source", status: "pass" },
  { name: "tests", status: "pass" },
  { name: "secrets_scan", status: "pass" },
  { name: "dependency_audit", status: "pass" },
  { name: "sbom", status: "pass" },
  { name: "disclosures", status: "pass" },
];
const cleanAudit = { counts: { critical: 0, high: 0, medium: 2, low: 5 }, findings: [], summary: "No blocking findings" };
const agentReport = { maxwell: { counts: { critical: 0, high: 0 } }, readiness: [], preview: { port: 8080 }, push: { branch: "mynt/build-x" } };

// Drives one build from start through the agent's work into verification, then lets `verification`
// shape what the clean sandbox reports, and returns the final build.
async function runBuild(ctx, { dev, startArgs, agent = agentReport, verification = {} }) {
  const { builds, boat, call } = ctx;
  const started = (await call(dev, "start_build", startArgs)).data;
  assert.ok(started.id, JSON.stringify(started));
  await builds.tick(); // sandbox requested
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick(); // agent prompted
  boat.write(sbx, "/home/user/mynt/result.json", agent);
  boat.finishPrompt(sbx);
  await builds.tick(); // source packaged, verifier requested
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  boat.ready(vid);
  await builds.tick(); // checks started
  boat.sandboxes.get(vid).checksRunning = false;
  boat.write(vid, `${V}/before.sha`, "tree\n");
  boat.write(vid, `${V}/report.json`, { checks: verification.checks ?? passingChecks });
  await builds.tick(); // auditor prompted
  if (verification.maxwell !== null) boat.write(vid, `${V}/maxwell.json`, verification.maxwell ?? cleanAudit);
  boat.finishPrompt(vid, verification.auditStatus ?? "finished");
  await builds.tick(); // decided
  return { started, sbx, vid, build: (await call(dev, "get_build", { build_id: started.id })).data };
}

test("a build is verified by Mynt in a clean sandbox, then Mynt opens the PR", async () => {
  const ctx = await setup();
  const { boat, repos, as, connect, call, builds } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  assert.equal((await call(dev, "connect_repository", { repository: "acme/savings-app" })).data.connected, true);

  const { started, sbx, vid, build } = await runBuild(ctx, {
    dev,
    startArgs: { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app" },
  });

  // The coding sandbox: secrets only in its env, the task and SDK in files, no PR from the agent.
  const coding = boat.sandboxes.get(sbx);
  assert.equal(coding.opts.env.GITHUB_TOKEN, "ghs_short_lived");
  assert.match(coding.opts.env.MYNT_SANDBOX_KEY, /^mynt_test_/);
  const task = coding.files.get("/home/user/mynt/TASK.md");
  assert.match(task, /Do not open a pull request/);
  assert.match(task, /re-runs the audit and the checks itself/);
  assert.ok(coding.files.has("/home/user/mynt/sdk/openapi.json"));

  // The verifier: a fresh sandbox with no secrets, Mynt's own script, and an audit-only agent.
  const verifier = boat.sandboxes.get(vid);
  assert.deepEqual(verifier.opts.env, {});
  assert.match(verifier.files.get(`${V}/verify.sh`), /gitleaks/);
  assert.match(verifier.commands.find((c) => c.detached).command, new RegExp(`verify\\.sh 'https://files\\.example/${sbx}/home/user/mynt-out/app\\.tgz\\?sig=x' ${SHA}`));
  assert.match(verifier.prompts[0].prompt, /Do not modify anything inside \/home\/user\/app/);
  assert.ok(verifier.stopped, "the verifier is stopped once it has reported");

  assert.equal(build.status, "succeeded");
  assert.equal(build.pr_url, "https://github.com/acme/savings-app/pull/7");
  assert.equal(build.commit_sha, COMMIT);
  assert.equal(build.source_sha256, SHA);
  assert.equal(build.source_url, undefined, "the signed URL is never shown");
  assert.match(build.preview_url, /-8080\./);
  assert.equal(repos.prs.length, 1);
  assert.match(repos.prs[0].body, /verified by Mynt/);
  assert.match(repos.prs[0].body, /\| secrets_scan \| pass \|/);
  const phases = build.timeline.map((e) => e.phase).filter((p, i, a) => p !== a[i - 1]);
  assert.deepEqual(phases, ["queued", "provisioning", "coding", "verifying", "succeeded"]);
  assert.equal((await builds.get(started.id)).agent_report.preview.port, 8080, "the agent's report is kept as advice");
});

for (const [label, opts, status, pattern] of [
  ["the agent's own report can't hide findings: Mynt's audit decides", { agent: { ...agentReport, maxwell: { counts: { high: 0 } } }, verification: { maxwell: { counts: { critical: 0, high: 2 } } } }, "blocked", /Security gate: 2/],
  ["no independent audit, no ship", { verification: { maxwell: null } }, "blocked", /No independent Maxwell audit/],
  ["an audit that didn't finish doesn't count", { verification: { auditStatus: "failed" } }, "blocked", /No independent Maxwell audit/],
  ["a failing check from Mynt's script fails the build", { verification: { checks: [...passingChecks, { name: "secrets_scan", status: "fail", detail: "1 secret(s)" }] } }, "failed", /secrets_scan/],
]) {
  test(label, async () => {
    const ctx = await setup();
    const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
    const { build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" }, ...opts });
    assert.equal(build.status, status);
    assert.match(build.error, pattern);
    assert.equal(build.pr_url, null);
  });
}

test("a build is blocked if the audit changed the code, or the pushed branch isn't the verified source", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  await ctx.call(dev, "connect_repository", { repository: "acme/savings-app" });

  ctx.boat.tamperDuringAudit = true;
  let r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", repository: "acme/savings-app" } });
  assert.equal(r.build.status, "blocked");
  assert.match(r.build.error, /source changed during the audit/);

  ctx.boat.tamperDuringAudit = false;
  ctx.boat.branchMatches = false;
  r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", repository: "acme/savings-app" } });
  assert.equal(r.build.status, "blocked");
  assert.match(r.build.error, /pushed branch doesn't match/);
  assert.equal(ctx.repos.prs.length, 0, "no PR for either");
});

test("a build that doesn't ship revokes its Mynt sandbox key", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
  const { started } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", app_id: app.id }, verification: { maxwell: { counts: { critical: 1 } } } });
  const b = await ctx.builds.get(started.id);
  assert.equal(b.status, "blocked");
  assert.equal((await ctx.store.getApiKey(b.sandbox_key_id)).status, "revoked");
});

test("the verifier is told which disclosures to find", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  await ctx.store.setProductAccess("fixed-deposit", "open", { required_disclosures: ["Deposits are insured up to the statutory limit"] });
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
  const { vid } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", app_id: app.id } });
  assert.deepEqual(JSON.parse(ctx.boat.sandboxes.get(vid).files.get(`${V}/disclosures.json`)), [
    { product_id: "fixed-deposit", text: "Deposits are insured up to the statutory limit" },
  ]);
});

test("spend caps count both sandboxes, and the monthly budget refuses new builds", async () => {
  const ctx = await setup({ config: { capUsd: 5, monthlyCapUsd: 8 } });
  const { builds, boat, as, connect, call } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please", cap_usd: 50 })).data;
  assert.equal(started.cap_usd, 5, "capped at the platform maximum");
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  boat.write(sbx, "/home/user/mynt/result.json", agentReport);
  boat.finishPrompt(sbx);
  boat.sandboxes.get(sbx).cost = 3;
  await builds.tick(); // verifying
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  boat.sandboxes.get(vid).cost = 2.5;
  await builds.tick();
  const b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "over_budget");
  assert.equal(b.cost_usd, 5.5);
  assert.ok(boat.sandboxes.get(sbx).stopped && boat.sandboxes.get(vid).stopped);
  assert.match((await call(dev, "start_build", { goal: "Another build please" })).data.error, /Monthly build budget/);
});

test("developers track, steer and stop their own builds; admins see all", async () => {
  const { builds, boat, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const admin = await connect(await as("Ada", ["admin"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  boat.write(sbx, "/home/user/mynt/status.json", { phase: "auditing", message: "Running Maxwell" });
  await builds.tick();
  let b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "auditing");
  assert.equal((await call(dev, "get_build_activity", { build_id: started.id })).data.activity[0].type, "tool_use");
  assert.equal((await call(dev, "steer_build", { build_id: started.id, message: "Use the existing design system" })).data.steered, true);
  assert.equal((await call(other, "get_build", { build_id: started.id })).isError, true);
  assert.equal((await call(other, "stop_build", { build_id: started.id })).isError, true);
  b = (await call(dev, "stop_build", { build_id: started.id })).data;
  assert.equal(b.status, "stopped");
  assert.ok(boat.sandboxes.get(sbx).stopped);
  const all = (await call(admin, "list_all_builds")).data;
  assert.equal(all.builds.length, 1);
  assert.equal(all.builds[0].source_url, undefined);
  assert.match((await call(dev, "steer_build", { build_id: started.id, message: "go on" })).data.error, /only a running agent/);
});

test("without a boat.dev key builds are disabled cleanly, and agents never connect outside services", async () => {
  const { as, connect, call } = await setup({ boat: null });
  const dev = await connect(await as("Dev", ["developer"]));
  assert.match((await call(dev, "start_build", { goal: "Build a savings page please" })).data.error, /aren't enabled/);
  const task = buildTask({ id: "x", repository: null, branch: null, maxwellRepo: "https://github.com/OnFinance/Maxwell", files: { task: "t", spec: "s", status: "st", result: "r", sdk: "k" } });
  assert.match(task, /Do not connect any external service or sign in anywhere/);
  const { auditorPrompt } = await import("../dist/verify-script.js");
  assert.match(auditorPrompt("https://github.com/OnFinance/Maxwell"), /Do not connect any external service or sign in anywhere/);
});
