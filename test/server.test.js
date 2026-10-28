import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../dist/server.js";
import { createMcpHttpServer } from "../dist/http.js";
import { Store } from "../dist/store.js";
import { loadCatalog } from "../dist/catalog.js";
import { runProductTests } from "../dist/product-tests.js";

const CATALOG_TOOLS = ["get_product", "list_apps", "list_categories", "list_products", "whoami"];
const CONSUMER_TOOLS = ["cancel_enrollment", "enroll_in_product", "list_my_enrollments"];
const DEVELOPER_TOOLS = ["create_app", "list_my_apps", "preview_app", "publish_app", "update_app"];
const INNOVATOR_TOOLS = ["create_product", "list_my_products", "publish_product", "test_product", "unpublish_product", "update_product"];

async function connect(store, user = null) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
};
const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();

function setup() {
  const store = new Store(":memory:");
  const as = (name, roles) => store.createUser(name, roles).user;
  return {
    store,
    consumer: as("Asha", ["consumer"]),
    developer: as("Dev", ["developer"]),
    innovator: as("Ines", ["innovator"]),
    rival: as("Ravi", ["innovator"]),
  };
}

const greenFd = {
  id: "green-fd",
  name: "Green Fixed Deposit",
  product_line: "treasury",
  category: "deposits",
  region: "IN",
  risk_level: "low",
  liquidity: "low",
  typical_horizon: "medium",
  return_type: "fixed_interest",
  regulator: "RBI",
  description: "Fixed deposit whose proceeds fund certified renewable-energy projects.",
  key_features: ["Fixed rate", "Funds green projects"],
};

test("each role sees only its own tools", async () => {
  const { store, consumer, developer, innovator } = setup();
  assert.deepEqual(await toolNames(await connect(store)), CATALOG_TOOLS);
  assert.deepEqual(await toolNames(await connect(store, consumer)), [...CATALOG_TOOLS, ...CONSUMER_TOOLS].sort());
  assert.deepEqual(await toolNames(await connect(store, developer)), [...CATALOG_TOOLS, ...DEVELOPER_TOOLS].sort());
  assert.deepEqual(await toolNames(await connect(store, innovator)), [...CATALOG_TOOLS, ...INNOVATOR_TOOLS].sort());
  const multi = store.createUser("Max", ["consumer", "innovator"]).user;
  assert.deepEqual(await toolNames(await connect(store, multi)), [...CATALOG_TOOLS, ...CONSUMER_TOOLS, ...INNOVATOR_TOOLS].sort());
});

test("catalog covers credit, wealth, insurance and treasury", async () => {
  const client = await connect(setup().store);
  const { data } = await call(client, "list_categories");
  for (const line of ["credit", "wealth", "insurance", "treasury"]) assert.ok(data.product_lines[line] >= 5, line);
  const treasury = (await call(client, "list_products", { product_line: "treasury", limit: 100 })).data;
  assert.equal(treasury.total, data.product_lines.treasury);
  assert.ok(treasury.products.every((p) => p.product_line === "treasury"));
  assert.ok(treasury.products.some((p) => p.id === "treasury-bills"));
});

test("every bundled product passes the product test suite", () => {
  for (const p of loadCatalog()) {
    const failed = runProductTests(p).checks.filter((c) => c.status === "fail");
    assert.deepEqual(failed, [], p.id);
  }
});

test("list_products filters and paginates", async () => {
  const client = await connect(setup().store);
  const us = (await call(client, "list_products", { region: "US" })).data;
  assert.ok(us.products.every((p) => p.region === "US" || p.region === "global"));
  const gold = (await call(client, "list_products", { query: "gold" })).data;
  assert.deepEqual(gold.products.map((p) => p.id).sort(), ["gold-loan", "sovereign-gold-bond"]);
  const page = (await call(client, "list_products", { limit: 5, offset: 5 })).data;
  assert.equal(page.products.length, 5);
});

test("innovator creates, tests and publishes; consumer and developer then use it", async () => {
  const { store, consumer, developer, innovator } = setup();
  const inno = await connect(store, innovator);
  const guest = await connect(store);

  assert.equal((await call(inno, "create_product", greenFd)).data.status, "draft");
  assert.equal((await call(guest, "get_product", { id: "green-fd" })).isError, true, "drafts are private");

  const untested = await call(inno, "publish_product", { id: "green-fd" });
  assert.match(untested.data.error, /test_product/);

  const report = (await call(inno, "test_product", { id: "green-fd" })).data;
  assert.equal(report.passed, true);

  // Editing after a test invalidates it.
  await call(inno, "update_product", { id: "green-fd", name: "Green FD" });
  assert.equal((await call(inno, "publish_product", { id: "green-fd" })).isError, true);
  await call(inno, "test_product", { id: "green-fd" });
  assert.equal((await call(inno, "publish_product", { id: "green-fd" })).data.status, "published");
  assert.equal((await call(guest, "get_product", { id: "green-fd" })).data.name, "Green FD");

  const cons = await connect(store, consumer);
  const enrollment = (await call(cons, "enroll_in_product", { product_id: "green-fd", amount: 50000 })).data;
  assert.equal(enrollment.status, "active");
  assert.equal((await call(cons, "enroll_in_product", { product_id: "green-fd" })).isError, true, "no duplicate enrollment");
  assert.equal((await call(cons, "list_my_enrollments")).data[0].product.name, "Green FD");

  const dev = await connect(store, developer);
  const app = (await call(dev, "create_app", {
    name: "Climate Saver",
    description: "Save while funding renewables",
    audience: "Eco-conscious savers in India",
    product_ids: ["green-fd", "ppf"],
  })).data;
  assert.equal((await call(dev, "publish_app", { app_id: app.id })).data.status, "published");
  const [listed] = (await call(guest, "list_apps")).data;
  assert.deepEqual(listed.products.map((p) => p.id), ["green-fd", "ppf"]);

  // Unpublishing hides the product from new enrollments and flags it in apps.
  await call(inno, "unpublish_product", { id: "green-fd" });
  assert.equal((await call(cons, "enroll_in_product", { product_id: "green-fd" })).isError, true);
  assert.deepEqual((await call(dev, "preview_app", { app_id: app.id })).data.unavailable_product_ids, ["green-fd"]);

  assert.equal((await call(cons, "cancel_enrollment", { enrollment_id: enrollment.id })).data.status, "cancelled");
});

test("product tests enforce product-line rules and catch misleading claims", async () => {
  const { store, innovator } = setup();
  const inno = await connect(store, innovator);
  await call(inno, "create_product", {
    ...greenFd,
    id: "sure-win-fund",
    product_line: "wealth",
    return_type: "market_linked",
    risk_level: "high",
    description: "Equity fund with guaranteed double-digit returns every single year.",
  });
  const report = (await call(inno, "test_product", { id: "sure-win-fund" })).data;
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((c) => c.name === "misleading_claims").status, "fail");
  assert.equal((await call(inno, "publish_product", { id: "sure-win-fund" })).isError, true);

  await call(inno, "create_product", { ...greenFd, id: "cheap-loan", product_line: "credit" });
  const credit = (await call(inno, "test_product", { id: "cheap-loan" })).data;
  assert.equal(credit.checks.find((c) => c.name === "credit_consistency").status, "fail");

  await call(inno, "create_product", { ...greenFd, id: "odd-cover", product_line: "insurance" });
  const insurance = (await call(inno, "test_product", { id: "odd-cover" })).data;
  assert.equal(insurance.checks.find((c) => c.name === "insurance_consistency").status, "fail");
});

test("users cannot touch other users' products, apps or enrollments", async () => {
  const { store, consumer, developer, innovator, rival } = setup();
  await call(await connect(store, innovator), "create_product", greenFd);
  const rivalClient = await connect(store, rival);
  assert.equal((await call(rivalClient, "test_product", { id: "green-fd" })).isError, true);
  assert.equal((await call(rivalClient, "update_product", { id: "green-fd", name: "Mine" })).isError, true);
  assert.equal((await call(rivalClient, "create_product", greenFd)).isError, true, "ids are unique");
  assert.equal((await call(rivalClient, "update_product", { id: "ppf", name: "Mine" })).isError, true, "bundled products are read-only");

  const app = (await call(await connect(store, developer), "create_app", {
    name: "A", description: "B", audience: "C", product_ids: ["ppf"],
  })).data;
  const otherDev = await connect(store, store.createUser("Dee", ["developer"]).user);
  assert.equal((await call(otherDev, "preview_app", { app_id: app.id })).isError, true);

  const e = (await call(await connect(store, consumer), "enroll_in_product", { product_id: "ppf" })).data;
  const otherConsumer = await connect(store, store.createUser("Cy", ["consumer"]).user);
  assert.equal((await call(otherConsumer, "cancel_enrollment", { enrollment_id: e.id })).isError, true);
});

test("HTTP transport authenticates bearer tokens", async () => {
  const store = new Store(":memory:");
  const { token } = store.createUser("Ines", ["innovator"]);
  const http = createMcpHttpServer(store).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  const clientFor = async (tok) => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const headers = tok ? { Authorization: `Bearer ${tok}` } : {};
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    return client;
  };
  try {
    const inno = await clientFor(token);
    assert.ok((await toolNames(inno)).includes("create_product"));
    assert.equal((await call(inno, "whoami")).data.name, "Ines");
    assert.deepEqual(await toolNames(await clientFor()), CATALOG_TOOLS);
    await assert.rejects(clientFor("fpm_bogus"));
  } finally {
    http.close();
  }
});

test("CLI issues tokens that work over stdio", async () => {
  const env = { ...process.env, FINANCIAL_PRODUCTS_DB: join(mkdtempSync(join(tmpdir(), "fpm-")), "db.sqlite") };
  const out = execFileSync(process.execPath, ["dist/index.js", "users", "add", "--name", "Asha", "--role", "consumer"], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const { token, roles } = JSON.parse(out);
  assert.deepEqual(roles, ["consumer"]);

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...env, FINANCIAL_PRODUCTS_TOKEN: token } }),
  );
  const { data } = await call(client, "enroll_in_product", { product_id: "etf" });
  assert.equal(data.status, "active");
  await client.close();
});
