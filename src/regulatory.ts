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

// ---- legal: split into the legislative branch (what the law says) and the judiciary (how courts
// have read it). Obligations and filings cite either by id through legal_ref.

const AppliesTo = z
  .object({
    regulators: z.array(z.string()).default([]),
    license_types: z.array(z.string()).default([]),
    product_types: z.array(z.string()).default([]),
    customer_personas: z.array(z.string()).default([]),
  })
  .default({ regulators: [], license_types: [], product_types: [], customer_personas: [] });

export const LEGISLATIVE_KINDS = [
  "act",
  "ordinance",
  "rule",
  "regulation",
  "master_direction",
  "circular",
  "guideline",
  "notification",
  "order",
] as const;

export const LegislativeSchema = z.object({
  id: Id,
  title: z.string().min(1),
  kind: z.enum(LEGISLATIVE_KINDS),
  citation: z.string().optional().describe("e.g. 'Act No. 2 of 1934' or a circular number"),
  issued_by: z.string().optional().describe("Regulator id, or the legislature (e.g. parliament)"),
  parent_id: z.string().optional().describe("The legislative id this is made under, e.g. the act a rule or direction derives from"),
  effective_from: z.string().optional(),
  status: z.enum(["in_force", "amended", "repealed", "draft"]).default("in_force"),
  url: z.string().url().optional(),
  summary: z.string().default(""),
  applies_to: AppliesTo,
});

export const COURT_LEVELS = ["supreme_court", "high_court", "tribunal", "appellate_authority", "other"] as const;

export const JudgmentSchema = z.object({
  id: Id,
  title: z.string().min(1).describe("Case name, e.g. 'X v. Union of India'"),
  court: z.string().min(1).describe("e.g. Supreme Court of India, Securities Appellate Tribunal"),
  court_level: z.enum(COURT_LEVELS),
  citation: z.string().optional().describe("e.g. a law-report citation or case number"),
  decided_on: z.string().optional(),
  bench: z.array(z.string()).default([]),
  holding: z.string().default("").describe("The legal principle the court decided"),
  summary: z.string().default(""),
  interprets: z.array(z.string()).default([]).describe("Legislative ids this judgment construes"),
  status: z.enum(["good_law", "overruled", "distinguished", "stayed", "under_appeal"]).default("good_law"),
  url: z.string().url().optional(),
  applies_to: AppliesTo,
});

// The earlier single-list shape, still accepted by the deprecated define_legal_instrument tool.
export const LegacyLegalSchema = LegislativeSchema.extend({ kind: z.enum([...LEGISLATIVE_KINDS, "judgment"]) }).omit({ status: true, parent_id: true });

export type Regulator = z.infer<typeof RegulatorSchema>;
export type Legislation = z.infer<typeof LegislativeSchema>;
export type Judgment = z.infer<typeof JudgmentSchema>;
export interface LegalModel {
  legislative: Legislation[];
  judiciary: Judgment[];
}
export interface RegulatoryModel {
  regulators: Regulator[];
  legal: LegalModel;
}
export const EMPTY_MODEL: RegulatoryModel = { regulators: [], legal: { legislative: [], judiciary: [] } };

// Accepts what is stored, including the earlier flat legal list, and returns the split shape.
export function normalizeModel(raw: unknown): RegulatoryModel {
  const m = (raw ?? {}) as { regulators?: Regulator[]; legal?: unknown };
  const legal = m.legal;
  if (Array.isArray(legal)) {
    const items = legal as (Omit<Legislation, "kind"> & { kind: string })[];
    return {
      regulators: m.regulators ?? [],
      legal: {
        legislative: items.filter((l) => l.kind !== "judgment") as Legislation[],
        judiciary: items.filter((l) => l.kind === "judgment").map(legacyToJudgment),
      },
    };
  }
  const l = (legal ?? {}) as Partial<LegalModel>;
  return { regulators: m.regulators ?? [], legal: { legislative: l.legislative ?? [], judiciary: l.judiciary ?? [] } };
}

export function legacyToJudgment(l: { id: string; title: string; issued_by?: string; citation?: string; effective_from?: string; url?: string; summary?: string; applies_to?: Judgment["applies_to"] }): Judgment {
  return {
    id: l.id,
    title: l.title,
    court: l.issued_by ?? "Verify: court not recorded",
    court_level: "other",
    citation: l.citation,
    decided_on: l.effective_from,
    bench: [],
    holding: "",
    summary: l.summary ?? "",
    interprets: [],
    status: "good_law",
    url: l.url,
    applies_to: l.applies_to ?? { regulators: [], license_types: [], product_types: [], customer_personas: [] },
  };
}

export const legalIds = (m: RegulatoryModel) => [...m.legal.legislative.map((l) => l.id), ...m.legal.judiciary.map((j) => j.id)];

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
    legal: {
      legislative: model.legal.legislative.map((l) => ({ id: l.id, title: l.title, kind: l.kind, status: l.status, citation: l.citation })),
      judiciary: model.legal.judiciary.map((j) => ({ id: j.id, title: j.title, court: j.court, decided_on: j.decided_on, status: j.status })),
    },
  };
}
