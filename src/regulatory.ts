import { z } from "zod";

// A region's regulatory model: its regulators (what each supervises, the licences it grants and the
// GRC each licence carries) and the legal instruments those rest on.

const Id = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use a lowercase id like 'rbi' or 'nbfc_icc'");
const Qualification = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .default({})
  .describe("Criteria as key/value pairs, e.g. { min_net_worth_inr: 50000000, resident: true }");
// One action or several; stored as a list.
const actions = <T extends z.ZodTypeAny>(item: T) =>
  z.union([item, z.array(item).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]) as z.infer<T>[]);

export const PRODUCT_ACTIONS = ["issuance", "sale", "purchase", "secondary_sale", "repackaging"] as const;

const ProductTypeScope = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().default(""),
  type_id: z.string().describe("The Mynt product category this maps to (see list_product_categories)"),
  action: actions(z.enum(PRODUCT_ACTIONS)),
});

const Persona = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().default(""),
  qualification: Qualification,
  action: actions(z.string().regex(/^[a-z][a-z0-9_]*$/)).describe("e.g. onboarding, identity_validation, deposit_custody"),
});

const Stakeholder = Persona.extend({
  obligations: z.array(z.string()).default([]).describe("Obligation ids from this licence's register, or short descriptions"),
});

const Obligation = z.object({
  id: Id,
  title: z.string().min(1),
  description: z.string().default(""),
  frequency: z.string().optional().describe("e.g. ongoing, annual, on_event"),
  legal_ref: z.string().optional().describe("Id of the legal instrument this comes from"),
});

const Filing = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().default(""),
  frequency: z.string().optional(),
  due: z.string().optional().describe("e.g. 'within 30 days of quarter end'"),
  form: z.string().optional(),
  legal_ref: z.string().optional(),
});

const Risk = z.object({
  id: Id,
  title: z.string().min(1),
  description: z.string().default(""),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
});

const Control = z.object({
  id: Id,
  title: z.string().min(1),
  description: z.string().default(""),
  mitigates: z.array(z.string()).default([]).describe("Risk ids in this register"),
  owner: z.string().optional().describe("Stakeholder id responsible"),
});

const RepoItem = z.object({
  title: z.string().min(1),
  date: z.string().optional(),
  url: z.string().url().optional(),
  summary: z.string().default(""),
});

const LicenseType = z.object({
  _id: Id,
  name: z.string().min(1),
  scope: z.string().default(""),
  application_procedure: z.array(z.string().min(1)).default([]).describe("How to obtain the licence, in order"),
  grc: z.object({
    registers: z
      .object({
        obligations: z.array(Obligation).default([]),
        reporting_disclosure_filings: z.array(Filing).default([]),
        risks: z.array(Risk).default([]),
        controls: z.array(Control).default([]),
      })
      .default({ obligations: [], reporting_disclosure_filings: [], risks: [], controls: [] }),
    repositories: z
      .object({
        regulatory_communications: z.array(RepoItem).default([]),
        enforcement_actions: z.array(RepoItem).default([]),
        press_releases: z.array(RepoItem).default([]),
        policies: z.array(RepoItem).default([]),
        risk_models: z.array(RepoItem).default([]),
      })
      .default({ regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [] }),
    allowed_product_types: z.array(z.string()).default([]).describe("Ids from this regulator's scope.product_types"),
    allowed_customer_segments: z.array(z.string()).default([]).describe("Ids from this regulator's scope.customer_personas"),
    mandatory_stakeholders: z
      .object({ internal: z.array(Stakeholder).default([]), external: z.array(Stakeholder).default([]) })
      .default({ internal: [], external: [] }),
  }),
});

export const RegulatorSchema = z.object({
  id: Id,
  name: z.string().min(1),
  short_name: z.string().optional().describe("How products cite it, e.g. RBI"),
  scope: z
    .object({
      product_types: z.array(ProductTypeScope).default([]),
      customer_personas: z.array(Persona).default([]),
    })
    .default({ product_types: [], customer_personas: [] }),
  license_types: z.array(LicenseType).default([]),
});

export const LEGAL_KINDS = ["act", "rule", "regulation", "master_direction", "circular", "guideline", "notification", "judgment"] as const;

export const LegalInstrumentSchema = z.object({
  id: Id,
  title: z.string().min(1),
  kind: z.enum(LEGAL_KINDS),
  citation: z.string().optional().describe("e.g. 'Act No. 2 of 1934' or a circular number"),
  issued_by: z.string().optional().describe("Regulator id, or the legislature"),
  effective_from: z.string().optional(),
  url: z.string().url().optional(),
  summary: z.string().default(""),
  applies_to: z
    .object({
      regulators: z.array(z.string()).default([]),
      license_types: z.array(z.string()).default([]),
      product_types: z.array(z.string()).default([]),
      customer_personas: z.array(z.string()).default([]),
    })
    .default({ regulators: [], license_types: [], product_types: [], customer_personas: [] }),
});

export type Regulator = z.infer<typeof RegulatorSchema>;
export type LegalInstrument = z.infer<typeof LegalInstrumentSchema>;
export interface RegulatoryModel {
  regulators: Regulator[];
  legal: LegalInstrument[];
}
export const EMPTY_MODEL: RegulatoryModel = { regulators: [], legal: [] };

const dupes = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

// Errors break the regulator's own links and block the write; warnings point outside it.
export function validateRegulator(
  r: Regulator,
  ctx: { categories: string[]; legalIds: string[] },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const productIds = r.scope.product_types.map((p) => p.id);
  const personaIds = r.scope.customer_personas.map((p) => p.id);
  for (const d of dupes(productIds)) errors.push(`duplicate product type id '${d}'`);
  for (const d of dupes(personaIds)) errors.push(`duplicate persona id '${d}'`);
  for (const d of dupes(r.license_types.map((l) => l._id))) errors.push(`duplicate licence id '${d}'`);
  for (const p of r.scope.product_types) {
    if (!ctx.categories.includes(p.type_id)) warnings.push(`product type '${p.id}' maps to '${p.type_id}', which isn't a Mynt product category`);
  }
  for (const l of r.license_types) {
    const where = `licence '${l._id}'`;
    for (const id of l.grc.allowed_product_types) if (!productIds.includes(id)) errors.push(`${where} allows product type '${id}', which ${r.id} doesn't define`);
    for (const id of l.grc.allowed_customer_segments) if (!personaIds.includes(id)) errors.push(`${where} allows segment '${id}', which ${r.id} doesn't define`);
    const reg = l.grc.registers;
    const riskIds = reg.risks.map((x) => x.id);
    for (const c of reg.controls) for (const m of c.mitigates) if (!riskIds.includes(m)) errors.push(`${where} control '${c.id}' mitigates unknown risk '${m}'`);
    const stakeholderIds = [...l.grc.mandatory_stakeholders.internal, ...l.grc.mandatory_stakeholders.external].map((s) => s.id);
    for (const c of reg.controls) if (c.owner && !stakeholderIds.includes(c.owner)) warnings.push(`${where} control '${c.id}' is owned by '${c.owner}', which isn't a mandatory stakeholder`);
    for (const ref of [...reg.obligations, ...reg.reporting_disclosure_filings].map((x) => x.legal_ref).filter(Boolean) as string[]) {
      if (!ctx.legalIds.includes(ref)) warnings.push(`${where} cites legal instrument '${ref}', which isn't recorded for this region yet`);
    }
    for (const kind of ["obligations", "reporting_disclosure_filings", "risks", "controls"] as const) {
      for (const d of dupes((reg[kind] as { id: string }[]).map((x) => x.id))) errors.push(`${where} has duplicate ${kind} id '${d}'`);
    }
  }
  return { errors, warnings };
}

// Licences that let a firm do `action` with a product of `category` for `persona`, across regulators.
export function findLicenses(model: RegulatoryModel, q: { category?: string; action?: string; persona?: string }) {
  const out = [];
  for (const r of model.regulators) {
    for (const l of r.license_types) {
      const products = r.scope.product_types.filter(
        (p) => l.grc.allowed_product_types.includes(p.id) && (!q.category || p.type_id === q.category) && (!q.action || (p.action as string[]).includes(q.action)),
      );
      if ((q.category || q.action) && products.length === 0) continue;
      const segments = r.scope.customer_personas.filter((p) => l.grc.allowed_customer_segments.includes(p.id));
      if (q.persona && !segments.some((s) => s.id === q.persona)) continue;
      out.push({
        regulator: { id: r.id, name: r.name },
        license: { _id: l._id, name: l.name, scope: l.scope },
        product_types: products.map((p) => ({ id: p.id, name: p.name, type_id: p.type_id, action: p.action })),
        customer_segments: segments.map((s) => ({ id: s.id, name: s.name, qualification: s.qualification })),
        application_procedure: l.application_procedure,
        mandatory_stakeholders: {
          internal: l.grc.mandatory_stakeholders.internal.map((s) => s.name),
          external: l.grc.mandatory_stakeholders.external.map((s) => s.name),
        },
        obligations: l.grc.registers.obligations.length,
        filings: l.grc.registers.reporting_disclosure_filings.map((f) => ({ name: f.name, frequency: f.frequency, due: f.due })),
      });
    }
  }
  return out;
}

export function summarizeModel(model: RegulatoryModel) {
  return {
    regulators: model.regulators.map((r) => ({
      id: r.id,
      name: r.name,
      short_name: r.short_name,
      product_types: r.scope.product_types.length,
      customer_personas: r.scope.customer_personas.length,
      license_types: r.license_types.map((l) => ({ _id: l._id, name: l.name })),
    })),
    legal: model.legal.map((l) => ({ id: l.id, title: l.title, kind: l.kind, citation: l.citation })),
  };
}
