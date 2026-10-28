import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../dist/server.js";

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { ...res, data: JSON.parse(res.content[0].text) };
};

test("exposes the three tools", async () => {
  const { tools } = await (await connect()).listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_product", "list_categories", "list_products"]);
});

test("list_products returns the whole catalog by default", async () => {
  const { data } = await call(await connect(), "list_products");
  assert.ok(data.total >= 30);
  assert.equal(data.products.length, Math.min(data.total, 50));
});

test("list_products filters by category, region and query", async () => {
  const client = await connect();
  const insurance = (await call(client, "list_products", { category: "insurance" })).data;
  assert.ok(insurance.products.every((p) => p.category === "insurance"));
  const us = (await call(client, "list_products", { region: "US" })).data;
  assert.ok(us.products.every((p) => p.region === "US" || p.region === "global"));
  const gold = (await call(client, "list_products", { query: "gold" })).data;
  assert.deepEqual(gold.products.map((p) => p.id).sort(), ["gold-loan", "sovereign-gold-bond"]);
});

test("list_products paginates", async () => {
  const { data } = await call(await connect(), "list_products", { limit: 5, offset: 5 });
  assert.equal(data.products.length, 5);
  assert.equal(data.offset, 5);
});

test("get_product returns details and errors on unknown id", async () => {
  const client = await connect();
  assert.equal((await call(client, "get_product", { id: "ppf" })).data.name, "Public Provident Fund (PPF)");
  const missing = await call(client, "get_product", { id: "nope" });
  assert.equal(missing.isError, true);
});

test("list_categories counts add up", async () => {
  const client = await connect();
  const { data } = await call(client, "list_categories");
  const total = (await call(client, "list_products")).data.total;
  assert.equal(Object.values(data.categories).reduce((a, b) => a + b, 0), total);
});

test("catalog resource is readable", async () => {
  const { contents } = await (await connect()).readResource({ uri: "financial-products://catalog" });
  assert.ok(JSON.parse(contents[0].text).length >= 30);
});

test("runs over stdio", async () => {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));
  const { data } = await call(client, "get_product", { id: "etf" });
  assert.equal(data.category, "exchange_traded");
  await client.close();
});
