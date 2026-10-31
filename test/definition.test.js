import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const TEMPLATE = JSON.parse(readFileSync(new URL("./fixtures/rd_template.v2.json", import.meta.url), "utf8"));

// A bank (with a risk-model template on its licence) and a payment aggregator; a firm holding the bank
// licence with the aggregator on its roster.
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
  await call(admin, "define_product_category", { id: "mandates", name: "Payment mandates", product_lines: ["payments"] });
  for (const t of [
    { id: "in_term_deposit", name: "Term deposit", type_id: "deposits", actions: ["issuance", "sale"] },
    { id: "in_recurring_mandate", name: "Recurring payment mandate", type_id: "mandates", actions: ["issuance", "sale"] },
  ])
    await call(admin, "define_regulated_product_type", { region: "IN", product_type: { ...t, description: "" } });
  const grc = (grants, extra = {}) => ({
    registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
    repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [], ...extra },
    allowed_product_types: grants,
    allowed_customer_segments: [],
    mandatory_stakeholders: { internal: [], external: [] },
  });
  const defined = await call(admin, "define_regulator", {
    region: "IN",
    regulator: {
      id: "rbi",
      name: "Reserve Bank of India",
      short_name: "RBI",
      scope: {
        product_types: [{ id: "in_term_deposit" }, { id: "in_recurring_mandate", actions: ["sale"] }],
        customer_personas: [
          { id: "rbi_retail_depositor", name: "Retail depositor", qualification: { resident: true }, action: "deposit_custody" },
          { id: "rbi_senior_depositor", name: "Senior citizen depositor", qualification: { min_age: 60 }, action: "deposit_custody" },
        ],
      },
      license_types: [
        {
          _id: "rbi_bank",
          name: "Bank",
          grc: grc(["in_term_deposit", "in_recurring_mandate"], {
            risk_models: [{ id: "interest_model", name: "Interest computation model", extends_default: false, fields: [{ key: "model", label: "Model", type: "string", required: true }] }],
          }),
        },
        { _id: "rbi_pa", name: "Payment aggregator", grc: grc([{ id: "in_recurring_mandate", actions: ["sale"] }]) },
      ],
    },
  });
  assert.equal(defined.isError, false, JSON.stringify(defined.data));

  const { user } = await store.createUser("Ines", ["innovator"]);
  const entity = await store.createEntity(user.id, { name: "Ines Bank", registration_numbers: {}, regions: ["IN"] });
  await store.setUserEntity(user.id, entity.id);
  user.entity_id = entity.id;
  const licence = async (entityId, id) => {
    const held = await store.registerLicense(user.id, { entity_id: entityId, region: "IN", regulator_id: "rbi", license_id: id, registration_number: `${id}-1`, valid_from: null, valid_to: null });
    await store.reviewLicense(held.id, "verified", adminUser.id, "ok");
    return held;
  };
  const bank = await licence(entity.id, "rbi_bank");
  const partnerEntity = await store.createEntity(null, { name: "Pay Partner", registration_numbers: {}, regions: ["IN"] });
  await licence(partnerEntity.id, "rbi_pa");
  const client = await connect(user);
  const partner = (await call(client, "add_party", { kind: "external", legal_entity_id: partnerEntity.id, relationship: "mandate_collection_agreement" })).data;
  const officer = (await call(client, "add_party", { kind: "internal", person: { name: "Model risk officer" } })).data;
  return { store, admin, call, connect, client, user, entity, bank, partner, officer };
}

const rd = {
  id: "everyday-rd",
  name: "Everyday Recurring Deposit",
  product_line: "account_operations",
  category: "deposits",
  region: "IN",
  risk_level: "low",
  liquidity: "low",
  typical_horizon: "medium",
  return_type: "fixed_interest",
  regulator: "RBI",
  description: "Placeholder until the definition is saved.",
  key_features: ["Daily instalments", "Fixed rate"],
};

// The recurring-deposit template, owned by the firm: the deposit by its bank licence, the mandate by the
// aggregator on its roster (with a handoff), interest governed by a record in the product's GRC folder.
function definitionFor(ctx, governanceRecordId) {
  const d = structuredClone(TEMPLATE);
  d._id = "everyday-rd";
  d.owner_entity_id = ctx.entity.id;
  d.plane = { role: "standalone", sellable: true };
  d.risk_models = [{ _id: "rd_interest_model", model_name: "RD interest model", description: "Compounding per instalment", purpose: "other", repository: "models/rd-interest" }];
  d.partner_handoffs = [
    { _id: "mandate_setup", name: "Register the mandate", trigger: "account_opened", sends: { type: "object", required: ["customer_ref", "amount"] }, returns: { type: "object", required: ["mandate_id"] } },
  ];
  d.connections = d.connections
    .filter((c) => c.type !== "segment_maps_to_persona")
    .concat([
      { _id: "p_deposit", type: "component_provided_by", from: { kind: "component", id: "deposit" }, to: { kind: "owner", licence_id: ctx.bank.id }, attributes: { business_role: "issuer" } },
      { _id: "p_mandate", type: "component_provided_by", from: { kind: "component", id: "mandate" }, to: { kind: "party", id: ctx.partner.id }, attributes: { business_role: "payment_service_provider" } },
      { _id: "h_party", type: "handoff_to_party", from: { kind: "partner_handoff", id: "mandate_setup" }, to: { kind: "party", id: ctx.partner.id }, attributes: { sla: "PT15M", consent_purpose: "mandate_setup", channel: "api" } },
      { _id: "h_serves", type: "handoff_serves_component", from: { kind: "partner_handoff", id: "mandate_setup" }, to: { kind: "component", id: "mandate" } },
      { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "deposit" } },
      { _id: "retail_persona", type: "segment_maps_to_persona", from: { kind: "customer_segment", id: "retail_saver" }, to: { kind: "register_persona", regulator_id: "rbi", id: "rbi_retail_depositor" }, attributes: { fit: "subset" } },
      { _id: "senior_persona", type: "segment_maps_to_persona", from: { kind: "customer_segment", id: "senior_saver" }, to: { kind: "register_persona", regulator_id: "rbi", id: "rbi_senior_depositor" }, attributes: { fit: "subset" } },
      { _id: "uses_model", type: "algorithm_uses_risk_model", from: { kind: "core_algorithm", id: "rd_interest" }, to: { kind: "risk_model", id: "rd_interest_model" }, attributes: { role: "primary", outputs_used: ["rate"] } },
      { _id: "governed", type: "risk_model_governed_by", from: { kind: "risk_model", id: "rd_interest_model" }, to: { kind: "grc_record", id: governanceRecordId, section: "risk_models", product_id: "everyday-rd" }, attributes: { governance_kind: "validation", frequency: "annual", owner_party_id: ctx.officer.id } },
    ]);
  return d;
}

test("a v2 definition is checked, sets the composition and catalogue record, and publishes with its hash pinned", async () => {
  const ctx = await setup();
  const { call, client, bank } = ctx;
  assert.equal((await call(client, "create_product", rd)).isError, false);
  // The model's governance lives in the product's own GRC folder.
  const record = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "rd_interest_model", record: { model: "RD interest model v1.2" } });
  assert.equal(record.isError, false, JSON.stringify(record.data));
  assert.equal((await call(client, "get_grc_folder", { product_id: "everyday-rd" })).data.repositories.risk_models.length, 1);
  assert.equal((await call(client, "get_grc_folder")).data.repositories.risk_models.length, 0, "not in the entity's own folder");

  const def = definitionFor(ctx, record.data.id);
  const checked = await call(client, "check_product_definition", { product_id: "everyday-rd", definition: def });
  assert.equal(checked.data.valid, true, JSON.stringify(checked.data.errors));
  assert.equal(checked.data.catalogue_record.product_line, "account_operations", "the lead component is the first: the deposit");

  const saved = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def });
  assert.equal(saved.isError, false, JSON.stringify(saved.data));
  const p = await ctx.store.getProduct("everyday-rd");
  assert.deepEqual(Object.fromEntries(p.components.map((c) => [c.key, [c.primitive, c.action, c.provider.by]])), {
    mandate: ["payments", "sale", "party"],
    deposit: ["account_operations", "issuance", "self"],
  });
  assert.deepEqual(new Set(p.parties.map((b) => `${b.party_id}/${b.for}`)), new Set([`${ctx.partner.id}/mandate`]));
  assert.equal(p.product.description, TEMPLATE.descriptions.summary);
  assert.equal(p.product.regulator, "RBI");
  assert.equal(p.product.region, "IN");

  const regime = (await call(client, "get_product_regime", { product_id: "everyday-rd", working: true })).data;
  assert.equal(regime.regions[0].covered, true, JSON.stringify(regime.regions[0].components.map((c) => c.coverage)));

  const tested = await call(client, "test_product", { id: "everyday-rd" });
  assert.equal(tested.data.passed, true, JSON.stringify(tested.data.checks.filter((c) => c.status === "fail")));
  const published = await call(client, "publish_product", { id: "everyday-rd" });
  assert.equal(published.isError, false, JSON.stringify(published.data));
  const live = await ctx.store.getProduct("everyday-rd");
  assert.match(live.pins.definition_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await call(client, "get_product_definition", { product_id: "everyday-rd" })).data.live_definition_hash, live.pins.definition_hash);
});

test("definitions are refused with every error: schema, references, ends and composition rules", async () => {
  const ctx = await setup();
  const { call, client, bank, partner } = ctx;
  await call(client, "create_product", rd);
  const governance = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "m", record: { model: "x" } });

  const schemaBroken = definitionFor(ctx, governance.data.id);
  delete schemaBroken.descriptions;
  const s = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: schemaBroken });
  assert.equal(s.isError, true);
  assert.match(s.data.errors.join("\n"), /descriptions/);

  const bad = definitionFor(ctx, governance.data.id);
  // The deposit funds the mandate (wrong way round), a link points nowhere, the mandate's handoff is gone,
  // the persona doesn't exist, the governance record doesn't, and the algorithm has two primaries.
  const funds = bad.connections.find((c) => c.type === "funds");
  [funds.from, funds.to] = [funds.to, funds.from];
  bad.connections.push({ _id: "dangling", type: "requires", from: { kind: "component", id: "deposit" }, to: { kind: "component", id: "nothing" }, attributes: { scope: "same_contract", stage: "origination" } });
  bad.connections = bad.connections.filter((c) => c._id !== "h_serves");
  bad.connections.find((c) => c._id === "retail_persona").to.id = "rbi_martian";
  bad.connections.find((c) => c._id === "governed").to.id = "00000000-0000-4000-8000-000000000000";
  bad.risk_models.push({ _id: "second", model_name: "Second", description: "x", purpose: "other", repository: "models/x" });
  bad.connections.push({ _id: "uses_second", type: "algorithm_uses_risk_model", from: { kind: "core_algorithm", id: "rd_interest" }, to: { kind: "risk_model", id: "second" }, attributes: { role: "primary", outputs_used: ["rate"] } });
  bad.connections.find((c) => c._id === "p_deposit").to.licence_id = "00000000-0000-4000-8000-000000000001";
  const r = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: bad });
  assert.equal(r.isError, true);
  const errors = r.data.errors.join("\n");
  assert.match(errors, /'mandate' \(payments:sale\) can't be the target/);
  assert.match(errors, /no component 'nothing'/);
  assert.match(errors, new RegExp(`provided by party ${partner.id}: add a partner handoff`));
  assert.match(errors, /defines no customer persona 'rbi_martian'/);
  assert.match(errors, /no current record '00000000-0000-4000-8000-000000000000'/);
  assert.match(errors, /algorithm 'rd_interest' needs exactly one primary risk model \(has 2\)/);
  assert.match(errors, /risk model 'second' needs a risk_model_governed_by/);
  assert.match(errors, /the owner holds no licence/);
  assert.equal((await ctx.store.getProduct("everyday-rd")).definition, null, "nothing was saved");

  // Variants aren't saved yet; someone else's product isn't theirs to define.
  const variant = { ...definitionFor(ctx, governance.data.id), plane: { role: "variant", extends: { product_id: "x", version: 1 }, patch: [] } };
  assert.match((await call(client, "set_product_definition", { product_id: "everyday-rd", definition: variant })).data.errors.join(), /Variants/);
  const { user: rival } = await ctx.store.createUser("Ravi", ["innovator"]);
  assert.equal((await call(await ctx.connect(rival), "set_product_definition", { product_id: "everyday-rd", definition: bad })).isError, true);
});

test("a published product's definition change goes into its draft version, and a lapsed party blocks the republish", async () => {
  const ctx = await setup();
  const { call, client, bank, partner } = ctx;
  await call(client, "create_product", rd);
  const governance = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "m", record: { model: "x" } });
  const def = definitionFor(ctx, governance.data.id);
  await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def });
  await call(client, "test_product", { id: "everyday-rd" });
  assert.equal((await call(client, "publish_product", { id: "everyday-rd" })).isError, false);

  def.descriptions.summary = "A daily recurring deposit, now with a senior-citizen bonus.";
  const saved = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def, changelog: "Senior bonus" });
  assert.equal(saved.data.applied_to, "draft_version");
  assert.notEqual((await ctx.store.getProduct("everyday-rd")).product.description, def.descriptions.summary, "the live record is unchanged");
  assert.equal((await ctx.store.draftVersion("everyday-rd")).data.description, def.descriptions.summary);

  // The partner leaves the roster: the saved definition no longer checks out, so the version can't go live.
  await call(client, "end_party", { party_id: partner.id });
  await call(client, "test_product", { id: "everyday-rd" });
  const refused = await call(client, "publish_product", { id: "everyday-rd" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.errors.join("\n"), new RegExp(`party '${partner.id}' isn't active`));
});

test("publishing freezes a developer contract: public offers and actions, nothing private", async () => {
  const ctx = await setup();
  const { call, client, bank, partner } = ctx;
  await call(client, "create_product", rd);
  const governance = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "m", record: { model: "x" } });
  const def = definitionFor(ctx, governance.data.id);
  const preview = await call(client, "check_product_definition", { product_id: "everyday-rd", definition: def });
  assert.ok(preview.data.developer_contract, "innovators see the contract before publishing");
  await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def });
  await call(client, "test_product", { id: "everyday-rd" });
  assert.equal((await call(client, "publish_product", { id: "everyday-rd" })).isError, false);

  const { user: dev } = await ctx.store.createUser("Dev", ["developer"]);
  const developer = await ctx.connect(dev);
  const contract = (await call(developer, "get_developer_contract", { product_id: "everyday-rd" })).data;
  assert.equal(contract.version, 1);
  assert.match(contract.contract_hash, /^sha256:/);
  assert.deepEqual(contract.offers.map((o) => o.segment_id).sort(), ["retail_saver", "senior_saver"]);
  const retail = contract.offers.find((o) => o.segment_id === "retail_saver");
  assert.ok(retail.terms.some((t) => t._id === "tenor_months"), "terms that apply to the product reach every segment");
  const mandate = contract.actions.find((a) => a.id === "mandate_setup");
  assert.deepEqual([mandate.surface, mandate.flow, mandate.host, mandate.component, mandate.consent_purpose], ["client", "hosted", "provider", "mandate", "mandate_setup"]);
  assert.ok(contract.actions.some((a) => a.id === "premature_closure" && a.surface === "server" && a.idempotent));
  assert.ok(contract.events.some((e) => e.type === "mandate_debit_failed"));
  assert.deepEqual(contract.consent_purposes, ["mandate_setup"]);
  // Nothing private leaks: no algorithms, risk models, fraud settings or parties.
  const text = JSON.stringify(contract);
  for (const secret of ["rd_interest_model", "core_algorithms", "risk_model", "fraud", partner.id, ctx.officer.id, ctx.entity.id]) assert.ok(!text.includes(secret), `contract leaks ${secret}`);
  assert.equal((await call(developer, "get_product_sdk", { product_id: "everyday-rd" })).data.contract.contract_hash, contract.contract_hash);

  // A catalogue product without a v2 definition has no contract yet.
  const plain = await call(developer, "get_developer_contract", { product_id: "ppf" });
  assert.equal(plain.isError, true);
  assert.match(plain.data.error, /without a v2 definition/);
});
