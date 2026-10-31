import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  };
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const admin = await connect(adminUser);
  // Two regulated primitives and a regulator that supervises them, with a bank licence that may do both and
  // a payment-aggregator licence that may only sell mandates.
  for (const t of [
    { id: "in_term_deposit", name: "Term deposit", type_id: "deposits", actions: ["issuance", "sale"] },
    { id: "in_recurring_mandate", name: "Recurring payment mandate", type_id: "deposits", actions: ["issuance", "sale"] },
  ]) {
    assert.equal((await call(admin, "define_regulated_product_type", { region: "IN", product_type: { ...t, description: "" } })).isError, false);
  }
  const grc = (grants) => ({
    registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
    repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [] },
    allowed_product_types: grants,
    allowed_customer_segments: [],
    mandatory_stakeholders: { internal: [], external: [] },
  });
  const regulator = {
    id: "rbi",
    name: "Reserve Bank of India",
    short_name: "RBI",
    scope: { product_types: [{ id: "in_term_deposit" }, { id: "in_recurring_mandate", actions: ["sale"] }], customer_personas: [] },
    license_types: [
      { _id: "rbi_bank", name: "Bank", scope: "", application_procedure: [], grc: grc(["in_term_deposit", "in_recurring_mandate"]) },
      { _id: "rbi_pa", name: "Payment aggregator", scope: "", application_procedure: [], grc: grc([{ id: "in_recurring_mandate", actions: ["sale"] }]) },
    ],
  };
  const defined = await call(admin, "define_regulator", { region: "IN", regulator });
  assert.equal(defined.isError, false, JSON.stringify(defined.data));
  await call(admin, "define_legislation", {
    region: "IN",
    instrument: { id: "in_banking_regulation_act", kind: "act", title: "Banking Regulation Act", issued_by: "parliament", status: "in_force", applies_to: { regulators: ["rbi"] } },
  });
  // A firm with a verified bank licence.
  const innovator = async (name, licence) => {
    const { user } = await store.createUser(name, ["innovator"]);
    const entity = await store.createEntity(user.id, { name: `${name} Bank`, registration_numbers: {}, regions: ["IN"] });
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
    if (licence) {
      const held = await store.registerLicense(user.id, { entity_id: entity.id, region: "IN", regulator_id: "rbi", license_id: licence, registration_number: "X-1", valid_from: null, valid_to: null });
      await store.reviewLicense(held.id, "verified", adminUser.id, "ok");
    }
    return { user, client: await connect(user) };
  };
  return { store, admin, call, connect, innovator };
}

const rd = {
  id: "everyday-rd",
  name: "Everyday Recurring Deposit",
  product_line: "treasury",
  category: "deposits",
  region: "IN",
  risk_level: "low",
  liquidity: "low",
  typical_horizon: "medium",
  return_type: "fixed_interest",
  regulator: "RBI",
  description: "A recurring deposit that collects a small amount every day from a mandate and pays a fixed rate.",
  key_features: ["Daily instalments", "Fixed rate"],
};
const components = [
  { region: "IN", primitive: "in_term_deposit", action: "issuance", role: "holds the deposit and pays interest", provided_by: "self" },
  { region: "IN", primitive: "in_recurring_mandate", action: "sale", role: "collects the daily instalment", provided_by: "partner", partner_name: "A sponsor bank" },
];

test("a product's regime follows from its components: who supervises, which licences, the law, and coverage", async () => {
  const { call, innovator, connect } = await setup();
  const { client } = await innovator("Ines", "rbi_bank");
  assert.equal((await call(client, "create_product", rd)).isError, false);
  const set = await call(client, "set_product_composition", { product_id: "everyday-rd", components });
  assert.equal(set.isError, false, JSON.stringify(set.data));
  const [inRegion] = set.data.regions;
  const deposit = inRegion.components.find((c) => c.primitive === "in_term_deposit");
  assert.deepEqual(deposit.supervised_by.map((s) => s.regulator_id), ["rbi"]);
  assert.deepEqual(deposit.licences.map((l) => l.license_id), ["rbi_bank"]);
  assert.ok(deposit.law.some((l) => l.legal_ref === "in_banking_regulation_act"));
  assert.equal(deposit.coverage.status, "covered");
  const mandate = inRegion.components.find((c) => c.primitive === "in_recurring_mandate");
  assert.deepEqual(mandate.licences.map((l) => l.license_id).sort(), ["rbi_bank", "rbi_pa"]);
  assert.deepEqual(mandate.coverage, { status: "partner_declared", partner: "A sponsor bank" });
  assert.equal(inRegion.covered, true);

  const tested = (await call(client, "test_product", { id: "everyday-rd" })).data;
  assert.equal(tested.checks.find((c) => c.name === "composition_coverage").status, "warn", "a declared partner isn't verified on Mynt");
  const published = await call(client, "publish_product", { id: "everyday-rd" });
  assert.equal(published.isError, false, JSON.stringify(published.data));

  const guest = await connect(null);
  const regime = (await call(guest, "get_product_regime", { product_id: "everyday-rd" })).data;
  assert.equal(regime.composed, true);
  assert.equal(regime.regions[0].components.length, 2);
});

test("publishing stops when a component the firm provides isn't covered by its licences", async () => {
  const { call, innovator } = await setup();
  const { client } = await innovator("Omar", "rbi_pa"); // may sell mandates, may not take deposits
  await call(client, "create_product", rd);
  const set = await call(client, "set_product_composition", { product_id: "everyday-rd", components: [{ ...components[0] }, { ...components[1], provided_by: "self", partner_name: null }] });
  assert.equal(set.isError, false, JSON.stringify(set.data));
  const byPrimitive = Object.fromEntries(set.data.regions[0].components.map((c) => [c.primitive, c.coverage]));
  assert.equal(byPrimitive.in_recurring_mandate.status, "covered");
  assert.equal(byPrimitive.in_term_deposit.status, "uncovered");
  assert.match(byPrimitive.in_term_deposit.reason, /rbi_bank/);
  const tested = (await call(client, "test_product", { id: "everyday-rd" })).data;
  assert.equal(tested.checks.find((c) => c.name === "composition_coverage").status, "fail");
  const refused = await call(client, "publish_product", { id: "everyday-rd" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /Not covered: in_term_deposit \(issuance, IN\)/);
});

test("compositions are checked against the region's catalogue", async () => {
  const { call, innovator } = await setup();
  const { client } = await innovator("Ines", "rbi_bank");
  await call(client, "create_product", rd);
  const bad = await call(client, "set_product_composition", {
    product_id: "everyday-rd",
    components: [
      { region: "IN", primitive: "in_unknown_thing", action: "sale", role: "does something", provided_by: "self" },
      { region: "IN", primitive: "in_term_deposit", action: "repackaging", role: "repackages it", provided_by: "self" },
      { region: "US", primitive: "in_term_deposit", action: "issuance", role: "wrong region", provided_by: "self" },
      { region: "IN", primitive: "in_recurring_mandate", action: "sale", role: "no partner named", provided_by: "partner" },
    ],
  });
  assert.equal(bad.isError, true);
  const errors = bad.data.errors.join("\n");
  assert.match(errors, /no regulated product type 'in_unknown_thing'/);
  assert.match(errors, /repackaging isn't possible on Term deposit/);
  assert.match(errors, /offered in IN, not US/);
  assert.match(errors, /name the partner/);
  const { client: other } = await innovator("Rival", "rbi_bank");
  assert.equal((await call(other, "set_product_composition", { product_id: "everyday-rd", components })).isError, true, "only the owner composes a product");
});

test("admins compose Mynt's reference products; their own components show as reference, not uncovered", async () => {
  const { call, admin } = await setup();
  const id = CATALOG.find((p) => p.region === "IN" && p.category === "deposits").id;
  const set = await call(admin, "admin_set_product_composition", { product_id: id, components: [components[0]] });
  assert.equal(set.isError, false, JSON.stringify(set.data));
  assert.equal(set.data.regions[0].components[0].coverage.status, "reference");
  assert.equal(set.data.regions[0].covered, true);
});
