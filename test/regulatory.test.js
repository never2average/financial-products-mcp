import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() });
  const as = async (name, roles) => (await store.createUser(name, roles)).user;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
  };
  return { store, as, connect, call };
}

// A test fixture in the pasted schema's shape (not a statement of real regulation).
const regulator = (over = {}) => ({
  id: "rbi",
  name: "Reserve Bank of India",
  short_name: "RBI",
  scope: {
    product_types: [
      { id: "term_deposit", name: "Term deposit", type_id: "deposits", action: "issuance" },
      { id: "personal_loan", name: "Personal loan", type_id: "credit", action: ["issuance", "sale"] },
    ],
    customer_personas: [
      { id: "retail_resident", name: "Resident individual", qualification: { resident: true, min_age: 18 }, action: ["onboarding", "identity_validation"] },
      { id: "hni", name: "High-net-worth individual", qualification: { min_net_worth_inr: 50000000 }, action: "onboarding" },
    ],
  },
  license_types: [
    {
      _id: "nbfc_d",
      name: "Deposit-taking NBFC",
      scope: "Accept public deposits and lend",
      application_procedure: ["Incorporate", "Apply for a certificate of registration", "Meet net-owned-fund requirement"],
      grc: {
        registers: {
          obligations: [{ id: "kyc", title: "Customer due diligence", legal_ref: "kyc_direction" }],
          reporting_disclosure_filings: [{ id: "alm_return", name: "ALM return", frequency: "quarterly" }],
          risks: [{ id: "liquidity", title: "Liquidity mismatch", severity: "high" }],
          controls: [{ id: "alm_committee", title: "ALM committee", mitigates: ["liquidity"], owner: "cro" }],
        },
        repositories: { enforcement_actions: [{ title: "Penalty on an NBFC", url: "https://example.org/penalty" }] },
        allowed_product_types: ["term_deposit", "personal_loan"],
        allowed_customer_segments: ["retail_resident"],
        mandatory_stakeholders: {
          internal: [{ id: "cro", name: "Chief Risk Officer", action: "risk_oversight", obligations: ["kyc"] }],
          external: [{ id: "statutory_auditor", name: "Statutory auditor", action: "audit" }],
        },
      },
    },
  ],
  ...over,
});

test("admins load regulators and legal instruments in the pasted schema; innovators query them", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));

  // Citing a law that isn't recorded yet is a warning, not an error.
  const first = (await call(admin, "define_regulator", { region: "IN", regulator: regulator() })).data;
  assert.ok(first.warnings.some((w) => /kyc_direction/.test(w)));
  await call(admin, "define_legal_instrument", {
    region: "IN",
    instrument: { id: "kyc_direction", title: "KYC Master Direction", kind: "master_direction", issued_by: "rbi", summary: "Customer due diligence rules" },
  });
  const second = (await call(admin, "define_regulator", { region: "IN", regulator: regulator() })).data;
  assert.equal(second.replaced, true);
  assert.deepEqual(second.warnings, []);

  // Single actions are stored as lists; the short name joins the region's regulator list.
  const rbi = (await call(inno, "get_regulator", { region: "IN", regulator_id: "rbi" })).data;
  assert.deepEqual(rbi.scope.product_types[0].action, ["issuance"]);
  assert.equal(rbi.license_types[0].grc.repositories.enforcement_actions.length, 1);
  const region = (await call(inno, "get_region", { code: "IN" })).data;
  assert.deepEqual(region.regulatory.regulators[0].license_types, [{ _id: "nbfc_d", name: "Deposit-taking NBFC" }]);
  assert.ok(region.regulators.includes("RBI"));

  // Which licence lets me issue a term deposit to a resident individual?
  const hits = (await call(inno, "find_licenses", { region: "IN", category: "deposits", action: "issuance", persona: "retail_resident" })).data;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].license._id, "nbfc_d");
  assert.deepEqual(hits[0].mandatory_stakeholders.internal, ["Chief Risk Officer"]);
  assert.deepEqual((await call(inno, "find_licenses", { region: "IN", category: "deposits", persona: "hni" })).data, [], "HNIs aren't an allowed segment");
  assert.deepEqual((await call(inno, "find_licenses", { region: "IN", category: "deposits", action: "repackaging" })).data, []);

  const laws = (await call(inno, "list_legal_instruments", { region: "IN", applies_to: "rbi" })).data;
  assert.deepEqual(laws.map((l) => l.id), ["kyc_direction"]);
});

test("broken links inside a regulator are refused; links outside it are warnings", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const broken = regulator();
  broken.license_types[0].grc.allowed_product_types.push("ghost_product");
  broken.license_types[0].grc.registers.controls.push({ id: "c2", title: "x", mitigates: ["ghost_risk"] });
  const refused = await call(admin, "define_regulator", { region: "IN", regulator: broken });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.errors.length, 2);

  const odd = regulator();
  odd.scope.product_types.push({ id: "token", name: "Token", type_id: "crypto", action: "issuance" });
  const ok = (await call(admin, "define_regulator", { region: "IN", regulator: odd })).data;
  assert.ok(ok.warnings.some((w) => /'crypto'/.test(w)));

  assert.equal((await call(admin, "define_regulator", { region: "ZZ", regulator: regulator() })).isError, true, "region must exist");
});

test("test_product reports which licence covers a product, and warns when none does", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));
  const base = {
    name: "Green FD",
    product_line: "treasury",
    category: "deposits",
    region: "IN",
    risk_level: "low",
    liquidity: "low",
    typical_horizon: "medium",
    return_type: "fixed_interest",
    regulator: "RBI",
    description: "Fixed deposit whose proceeds fund renewable-energy projects.",
    key_features: ["Fixed rate", "Green projects"],
  };
  await call(inno, "create_product", { id: "green-fd", ...base });
  assert.equal((await call(inno, "test_product", { id: "green-fd" })).data.checks.find((c) => c.name === "licensing").status, "warn");

  await call(admin, "define_regulator", { region: "IN", regulator: regulator() });
  const licensed = (await call(inno, "test_product", { id: "green-fd" })).data.checks.find((c) => c.name === "licensing");
  assert.equal(licensed.status, "pass");
  assert.match(licensed.message, /Deposit-taking NBFC \(rbi\)/);

  await call(admin, "remove_regulator", { region: "IN", regulator_id: "rbi" });
  assert.deepEqual((await call(inno, "find_licenses", { region: "IN", category: "deposits" })).data, []);
  const actions = (await call(admin, "audit_log")).data.map((e) => e.action);
  assert.deepEqual(actions.slice(0, 2), ["remove_regulator", "define_regulator"]);
});
