import { z } from "zod";
import { licenseInForce } from "./access.js";
import { licenseProducts, normalizeModel, PRODUCT_ACTIONS } from "./regulatory.js";
import type { ProductRecord, Store } from "./store.js";

// Products are compositions of regulated primitives: a recurring deposit is a recurring payment mandate
// plus a term deposit. The primitives are each region's regulated product types; a product lists its
// components, and its regulatory regime follows from them: who supervises each component, which licences
// may provide it, the law recorded against it, and whether the firm (or a named partner) holds that licence.

export const ComponentSchema = z.object({
  region: z.string().regex(/^(global|[A-Z]{2})$/).describe("The jurisdiction this component is regulated in (a global product lists components per jurisdiction)"),
  primitive: z.string().min(1).describe("A regulated product type id in that region (see list_regulated_product_types)"),
  action: z.enum(PRODUCT_ACTIONS).describe("What is done with it in this product: issuance, sale, purchase, secondary_sale or repackaging"),
  role: z.string().min(3).max(300).describe("What it does in the product, e.g. 'collects the monthly instalment'"),
  provided_by: z.enum(["self", "partner"]).default("self").describe("self: your firm provides it under its own licence; partner: another licensed firm does"),
  partner_entity_id: z.string().uuid().nullable().optional().describe("The partner's firm on Mynt, if it's on Mynt (its licences are then checked)"),
  partner_name: z.string().max(200).nullable().optional().describe("The partner's name, if it isn't on Mynt"),
});
export type Component = z.infer<typeof ComponentSchema>;

type Coverage =
  | { status: "covered"; by: { entity_id: string; regulator_id: string; license_id: string; registration_number: string }[] }
  | { status: "uncovered"; reason: string }
  | { status: "partner_declared"; partner: string }
  | { status: "reference"; reason: string }
  | { status: "unknown_primitive"; reason: string };

// Checks components against the region catalogues before they're saved.
export async function validateComponents(store: Store, product: ProductRecord, components: Component[]) {
  const errors: string[] = [];
  const types = await store.regulatedProductTypes();
  for (const [i, c] of components.entries()) {
    const where = `component ${i + 1} (${c.primitive})`;
    if (product.product.region !== "global" && c.region !== product.product.region) errors.push(`${where}: the product is offered in ${product.product.region}, not ${c.region}`);
    const t = types.find((x) => x.region === c.region && x.id === c.primitive);
    if (!t) errors.push(`${where}: no regulated product type '${c.primitive}' in ${c.region}`);
    else if (!t.actions.includes(c.action)) errors.push(`${where}: ${c.action} isn't possible on ${t.name} (${t.actions.join(", ")})`);
    if (c.provided_by === "partner" && !c.partner_entity_id && !c.partner_name) errors.push(`${where}: name the partner (partner_entity_id or partner_name)`);
    if (c.provided_by === "self" && (c.partner_entity_id || c.partner_name)) errors.push(`${where}: a partner is named but provided_by is 'self'`);
  }
  return errors;
}

// The regime for each jurisdiction the product has components in.
export async function productRegime(store: Store, product: ProductRecord) {
  const ref = await store.referenceData(true);
  const types = await store.regulatedProductTypes();
  const mappings = await store.productMappings();
  const regions = [...new Set(product.components.map((c) => c.region))];
  const heldBy = new Map<string, Awaited<ReturnType<Store["licensesOf"]>>>();
  const held = async (entityId: string) => {
    if (!heldBy.has(entityId)) heldBy.set(entityId, (await store.licensesOf(entityId)).filter((l) => licenseInForce(l)));
    return heldBy.get(entityId)!;
  };

  const out = [];
  for (const region of regions) {
    const model = normalizeModel(ref.regions.find((r) => r.code === region)?.regulatory);
    const components = [];
    for (const c of product.components.filter((x) => x.region === region)) {
      const primitive = types.find((t) => t.region === region && t.id === c.primitive);
      if (!primitive) {
        components.push({ ...c, primitive_info: null, supervised_by: [], licences: [], law: [], coverage: { status: "unknown_primitive", reason: `No regulated product type '${c.primitive}' in ${region}` } as Coverage });
        continue;
      }
      const supervised_by = mappings
        .filter((m) => m.region === region && m.product_type_id === c.primitive && m.actions.includes(c.action))
        .map((m) => ({ regulator_id: m.regulator_id, name: model.regulators.find((r) => r.id === m.regulator_id)?.name ?? m.regulator_id }));
      const licences = model.regulators.flatMap((r) =>
        r.license_types
          .filter((l) => licenseProducts(r, l).some((p) => p.id === c.primitive && (p.action as string[]).includes(c.action)))
          .map((l) => ({ regulator_id: r.id, license_id: l._id, name: l.name })),
      );
      const regulatorIds = new Set(supervised_by.map((s) => s.regulator_id));
      const law = model.legal.legislative
        .filter((l) => (l.applies_to?.product_types ?? []).includes(c.primitive) || (l.applies_to?.regulators ?? []).some((r) => regulatorIds.has(r)) || regulatorIds.has(l.issued_by ?? ""))
        .slice(0, 25)
        .map((l) => ({ legal_ref: l.id, title: l.title, kind: l.kind, status: l.status }));

      let coverage: Coverage;
      const grants = new Set(licences.map((l) => `${l.regulator_id}/${l.license_id}`));
      const coveredBy = async (entityId: string) =>
        (await held(entityId))
          .filter((h) => h.region === region && grants.has(`${h.regulator_id}/${h.license_id}`))
          .map((h) => ({ entity_id: entityId, regulator_id: h.regulator_id, license_id: h.license_id, registration_number: h.registration_number }));
      if (c.provided_by === "partner") {
        if (c.partner_entity_id) {
          const by = await coveredBy(c.partner_entity_id);
          coverage = by.length ? { status: "covered", by } : { status: "uncovered", reason: "The partner firm holds no verified licence for this" };
        } else coverage = { status: "partner_declared", partner: c.partner_name ?? "unnamed" };
      } else if (!product.entity_id) {
        coverage = product.owner_id ? { status: "uncovered", reason: "The product isn't attached to a firm" } : { status: "reference", reason: "A Mynt reference product: no firm offers it yet" };
      } else {
        const by = await coveredBy(product.entity_id);
        coverage = by.length ? { status: "covered", by } : { status: "uncovered", reason: licences.length ? `Needs one of: ${licences.map((l) => l.license_id).join(", ")}` : "No licence in the regulatory model grants this yet" };
      }
      components.push({ ...c, primitive_info: { name: primitive.name, category: primitive.type_id, actions: primitive.actions }, supervised_by, licences, law, coverage });
    }
    const statuses: string[] = components.map((x) => x.coverage.status);
    out.push({
      region,
      components,
      regulators: [...new Set(components.flatMap((x) => x.supervised_by.map((s) => s.regulator_id)))],
      covered: !statuses.some((s) => s === "uncovered" || s === "unknown_primitive"),
    });
  }
  return { product_id: product.product.id, composed: product.components.length > 0, regions: out };
}

// Components the firm itself must cover but doesn't (or that point at unknown primitives): publishing stops on these.
export function blockingComponents(regime: Awaited<ReturnType<typeof productRegime>>, region: string) {
  return regime.regions
    .filter((r) => region === "global" || r.region === region)
    .flatMap((r) => r.components.filter((c) => c.coverage.status === "uncovered" || c.coverage.status === "unknown_primitive").map((c) => ({ region: r.region, primitive: c.primitive, action: c.action, reason: "reason" in c.coverage ? c.coverage.reason : "" })));
}
