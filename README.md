# Mynt

**Lovable for finance apps.** Describe the financial product you want; Mynt's AI agents design it, price it, test it, clear compliance, build it and launch it.

## The problem

The need for a better financial product is usually obvious from the data. Examples:
- pay-later for a shop's regular customers;
- cover for a slow season;
- six weeks of working capital before a festival, repaid a little every day, instead of a 12-month loan with fixed EMIs.

Building one still takes months:
- pricing and feasibility;
- finding a licensed partner;
- working out which regulations and licences apply;
- controls and disclosures;
- the app itself;
- distribution.

So products get built for the average customer, and nobody builds the one that fits.

## Describe it. Agents build it.

You chat with Mynt and describe the product or app. Its agents take it from there:

1. **The chat agent** works out what's needed, asking one clarifying question at a time.
2. **The product foundry** designs the terms and pricing and picks the licensed partner.
   - A product is composed from regulated building blocks: a recurring deposit is a recurring payment mandate plus a term deposit.
   - So its regulatory regime follows from what it's made of.
   - Its feasibility is worked out in code.
3. **Compliance, platform, acquisition and back office** are spun up for that one product:
   - its compliance is checked against the regulation and the licences behind it;
   - it runs in its own isolated environment;
   - experiences are built for it, and it reaches the right customers;
   - it's serviced and reconciled.
4. **It comes back to the same chat** as a product card: the terms, and a one-tap accept.

```
You:   I need ₹80,000 of stock for six weeks before Diwali.
Mynt:  Got it. Should repayments come from your daily settlements?
You:   Yes, a little every day.
Mynt:  ┌─────────────────────────────────────────────┐
       │ SIX-WEEK STOCK LOAN · READY                 │
       │ ₹80,000 · 6 weeks · 12% p.a. · partner bank │
       │ [ Accept ]  [ Look for more options ]       │
       └─────────────────────────────────────────────┘
```

**From months of launch work to one conversation.**

## A self-improving compliance loop

Every product gets its own compliance workspace. That workspace links the regulations to:
- the business functions and people responsible;
- what each of them must do and how;
- the policies and controls that do it;
- the metrics and evidence that prove it;
- the disclosures and reports that go back to the regulator.

Each new product, review and inspection makes the loop better. Everything has an audit trail, version history, reporting and connectors to external data.

## Business model

A simple take rate on every product sold:

| Credit | Insurance | Treasury | Asset management |
| --- | --- | --- | --- |
| 1% | 20% | 10% | 5% |

## What's in this repository

This repository is Mynt's platform, published as an [MCP](https://modelcontextprotocol.io) server (MCP clients show it as `mynt`). It covers **credit, wealth, insurance and treasury** products, and serves the people and agents around a product:

| Who | What Mynt gives them |
| --- | --- |
| **Consumers** | Products and offers they can use, and a way to say what they need |
| **Innovators** (licensed firms) | The product foundry: composition from regulated primitives, term sheets and feasibility analysis in their own model repository, versioning, licensing checks, distribution |
| **Developers** | Apps and experiences on top of products: SDKs, APIs, webhooks, sandbox, GTM campaigns, and coding agents that build and ship them |
| **Admins** | The regulatory model (regulators, licences, law, GRC), the governance desk that reviews firms, licences and products, and oversight |

Hosted agents do the work: they build, audit, run the product desk, review governance and do business development. Each one is steered by its own folder under `workspaces/`, and Mynt checks whatever an agent produces itself.

The rest of this README is the technical reference.

---

## Reference

Mynt has four kinds of user:

| User type | Can | Tools (in addition to the catalog tools) |
| --- | --- | --- |
| **Consumer** | Use financial products, respond to offers and request products that don't exist yet | `enroll_in_product`, `list_my_enrollments`, `cancel_enrollment`, `list_offers`, `upgrade_enrollment`, `request_product`, `list_my_product_requests` (the last two for any signed-in user) |
| **Developer** | Build app experiences and do GTM engineering around financial products | Apps: `create_app`, `update_app`, `list_my_apps`, `preview_app`, `publish_app`. GTM: `create_segment`, `list_my_segments`, `create_campaign`, `update_campaign`, `lint_campaign`, `launch_campaign`, `pause_campaign`, `end_campaign`, `list_my_campaigns`, `get_campaign_metrics`. Runtime: `create_api_key`, `list_api_keys`, `rotate_api_key`, `revoke_api_key`, `create_webhook`, `list_webhooks`, `delete_webhook`, `rotate_webhook_secret`, `list_webhook_deliveries`, `create_test_consumer`, `simulate_handoff`, `release_app`, `list_app_releases`, `rollback_app`, `get_app_metrics` |
| **Innovator** | Create, test, publish, version and upgrade financial products | `create_product`, `update_product`, `test_product`, `publish_product`, `unpublish_product`, `list_my_products`, `create_product_version`, `update_product_version`, `list_product_versions`, `diff_product_versions`, `restore_product_version`, `upgrade_enrollments`, `get_product_distribution_metrics`, `report_handoff_outcome`. Product requests: `list_product_requests` (requesters shown only by a pseudonymous id), `respond_to_product_request` (offer one of your published products; audited) |
| **Admin** | Run Mynt: geographies, product types, the whitelist, and oversight, all from Mynt itself | `define_region`, `define_product_category`, `list_whitelist`, `invite_user`, `revoke_user`, `list_all_campaigns`, `admin_pause_campaign`, `admin_set_product_status`, `audit_log` |

Everyone (including guests without a token) gets the catalog tools: `whoami`, `list_products`, `get_product`, `list_categories`, `list_regions`, `list_product_categories`, `list_apps`, plus the resource `mynt://catalog`.

### Administration

Admins own Mynt's reference data and access. **Every admin action is written to the audit log with who did it.**
- **Geographies** (`define_region`): where products may be offered. Each region records its regulators, its regulatory ecosystem (each regulator's remit, the key laws and bodies), the legal procedure to launch each product line there (licences, approvals, filings, timeline), and the official sources. Fields you leave out keep their values. Innovators read the full picture with `get_region`.
- **Regulated product types** (`define_regulated_product_type`, `list_regulated_product_types`): per region, a catalogue of the product types regulators supervise, kept apart from any one regulator. Each has a Mynt category and the actions that can be taken on it (issuance, sale, purchase, secondary sale, repackaging). Regulators map onto it **many to many**: one product type, such as a sovereign gold bond, can be supervised by several regulators, each for its own subset of actions. A product type can't be removed, or lose an action, while a regulator still supervises it.
- **Regulatory model** (`define_regulator`, `define_legislation`, `define_judgment`): per region, each regulator's **scope** (the regulated product types it supervises, by id, with the actions it covers; and the customer personas with their qualifications), and the **licence types** it grants. A licence **grants specific actions on specific product types** (a bare id grants everything its regulator supervises on it), so `find_licenses` returns only licences that actually permit the action. Persona and licence ids belong to one regulator: they must start with `<regulator id>_` and can't be reused by another regulator in the region. Each licence carries **GRC**: registers of obligations, reporting/disclosure filings, risks and controls; repositories of regulatory communications, enforcement actions, press releases, policies and risk models; the product types and customer segments it allows; mandatory internal and external stakeholders; and how to apply. **Legal** is recorded alongside in two branches. **Legislative** covers acts, ordinances, rules, regulations, master directions, circulars, guidelines, notifications and orders, each with its issuer, the instrument it's made under (`parent_id`), status and effective date. **Judiciary** covers court and tribunal decisions, each with court and level, bench, holding, the legislation it interprets, and whether it's still good law. Obligations and filings cite either kind by `legal_ref`. Broken links inside a regulator are refused; looser links come back as warnings. Innovators read it with `get_regulator` and `list_legal_instruments` (both branches, filterable), and ask `find_licenses` which licence covers a category, action and persona. `test_product` names the covering licence or warns when there is none.
- **GRC: data and templates.** Each licence's GRC holds two kinds of thing.
  - **Data the regulator requires or has identified:**
    - obligations: recurrence, criticality, how to comply, links to a risk, an owner and the law
    - reporting, disclosure and filings: category, frequency, due rule, form, channels, priority, the obligation it evidences
    - risks: impact, likelihood, how often controls over it must be tested
    - regulatory communications, enforcement actions and press releases

    Frequencies share one vocabulary: one_time, daily … annual, biennial, periodic, event_driven, continuous, on_demand. Free text is mapped to it, and any detail that doesn't fit is kept in `frequency_note`.
  - **Templates (schemas of schemas):** **controls**, **policies**, **risk models**, **inspection history** and **inspection events** aren't records. They teach licensees how to define their own. Each template carries:
    - `guidance` on what the regulator expects
    - the `legal_ref` behind it
    - kind-specific settings (a control's minimum test frequency, a policy's review cadence and approver)
    - a **field schema** licensees' records must follow

    Schemas start from Mynt's defaults (a control's type, test method, test frequency, test status and last test rating; a risk model's scoring methods, factors and thresholds; an inspection's type, outcome and findings by severity). The regulator adds or overrides fields by key, each with its own guidance, or opts out of the defaults. Innovators read a template's resolved schema with `get_template`, and the defaults with `list_template_defaults`.
- **Product types** (`define_product_category`): the categories products may have, and which of the four product lines each may be used in.
- **How products are checked against them:** `test_product` fails a product whose region or category isn't defined and active, or whose category doesn't allow its product line. It warns when the regulator isn't one listed for the region, and when no launch procedure is documented for the product's line there. Retiring a region or category (`active: false`) stops new products from using it; live products stay. A new Mynt starts with neither: admins define them.
- **Whitelist** (`invite_user`, `revoke_user`, `list_whitelist`): kept in step with Clerk's allowlist. Mynt refuses any change that would remove the last admin.
- **Oversight:** see every campaign and pause any of them. Unpublish any product, or republish one; republishing re-runs the tests first.

**Inviting from Clerk** works too, and is the easiest way to create the first admin:
1. In the Clerk dashboard, go to **Users → Invite**, enter the email, and set **public metadata** to `{"mynt_roles": ["admin"]}`. Any role works: `admin`, `innovator`, `developer` or `consumer`.
2. The person accepts Clerk's emailed invitation and signs up.
3. On their first Mynt request, Mynt whitelists them with those roles and logs `invite_via_clerk` in the audit log.

Only Clerk dashboard owners can set public metadata; users can't edit their own. After that first sign-in, manage the person in Mynt: role changes and revocations are written back to their Clerk metadata, so an old grant can't restore access. With Clerk's allowlist on, add the email under **Configure → Restrictions → Allowlist** too, in case the invitation alone isn't enough to sign up.

The CLI (`users invite --role admin`) remains as a fallback for creating the first admin.

### Who does what: licensed innovators, software developers

- **Innovators are the licensed layer.** Any firm doing a regulated financial action:
  - issuing a product (a bank, NBFC, AMC or insurer)
  - selling another issuer's product (a mutual fund distributor, insurance broker, lending service provider)
  - repackaging others' products (a model portfolio)

  Each innovator acts for a **firm** (`create_entity`) and registers the **licences** it holds (`register_license`), which an admin verifies against the regulator's register (`review_license`). A product declares its `action` (`issuance`, `sale` or `repackaging`, with `underlying_product_ids` for the last two). **`publish_product` requires a verified, in-date licence held by the firm that covers that action on that category in that region.**
- **Developers are the software layer.** They build SDKs, apps and experiences on innovators' products, and never issue, sell, hold funds or collect financial data. Onboarding, KYC and payments hand off to the innovator's own flow (`deep_link` / `initiate_onboarding`).

**Opening products to developers.** Each product has an **access mode**, set with `set_product_access`:

| Mode | Developers |
| --- | --- |
| `open` | Build and publish any experience that meets the terms |
| `approval` (default) | Build now; go live once the innovator approves their request |
| `private` | Only developers the innovator invites (`invite_developer`) |

Each product also has **build terms**:
- **permitted actions:** display, compare, prefill, deep_link, embed_widget, initiate_onboarding
- **required disclosures**
- **banned phrases**
- **allowed customer personas**
- **branding**
- **commercials:** none, referral fee or revenue share
- **handoff_url:** where runtime API hand-offs send the user (https)

**The developer side:**
- **Find products:** `list_buildable_products` and `get_product_sdk` (data shape, sandbox sample, permitted actions, hand-offs).
- **Ask for access:** `request_product_access` and `list_my_requests`.
- **Check and publish:** `check_experience`, then `publish_app`. Publishing needs access to every product **and** a passing check against each product's terms.

**The innovator side:**
- **Inbox:** `list_requests` and `review_request` (approve or reject, with a note).
- **Visibility:** `list_experiences` shows every app using their products.
- **Control:** `revoke_access`, and **`suspend_product_experiences`** as a kill switch (the product goes private, every grant is revoked, and live campaigns using it are paused).

**Campaigns.** Promoting a financial product is a regulated act:
- A campaign over the launcher's own (or their firm's) products, or the open reference catalogue, goes live once its copy passes the lint.
- A campaign over **another innovator's** products becomes `pending_approval` and lands in that innovator's inbox. It goes live when every product's innovator approves, and goes back to draft on any rejection.

### Coding-agent builds (developers)

A developer can have Mynt **build and ship** one of their experiences. `start_build` runs a coding agent in a fresh [boat.dev](https://boat.dev) sandbox. boat.dev only provides the machine: Mynt installs a pinned Claude Code there and runs it headless with a dollar budget (`--max-budget-usd`, from the build's cap). The agent reaches the model only through Mynt's agent proxy (`/agent`), using a token that works only while its build runs. Mynt calls Claude on Google Cloud Vertex AI with its own service account, or the Anthropic API with its own key, so no credentials ever enter a sandbox. Developers follow the agent's activity live and can steer it: Mynt interrupts the current turn and sends their message as the next one. The agent writes the code against the app's products and their build terms, using a freshly generated SDK and a Mynt **sandbox key** (simulated hand-offs) for end-to-end tests. It runs the [Maxwell](https://github.com/OnFinance/Maxwell) static probes to find and fix issues, starts a preview, and pushes a branch.

**The agent doesn't grade its own work.** When it finishes, Mynt verifies the build itself, in a **fresh sandbox the agent never touched**, with no secrets:
1. **Package:** Mynt packages the workspace source (without dependencies), records its SHA-256, and the verifier downloads it and checks the checksum.
2. **Mynt's own checks** (`src/verify-script.ts`): tests; lint and types; a secrets scan with `gitleaks`; a dependency audit; a CycloneDX SBOM with `syft`; and every required disclosure present in the source. `gitleaks` and `syft` are pinned versions, checked against their releases' published checksums.
3. **Independent audit:** a separate, audit-only Claude Code run executes the Maxwell static workflows. Mynt then re-hashes the source tree to prove the audit changed nothing.
4. **Decision**, from Mynt's results only. The agent's own report is kept, as advice:
   - the source changed during the audit, no audit, or **critical or high** findings → `blocked`
   - a failing check → `failed`
   - with a repository, the pushed branch must be exactly the verified source, or the build is `blocked`
5. **Ship:** on success, Mynt exposes the token-gated **preview** and **opens the pull request itself**, through its GitHub App, with the verified results in the description. The agent never opens PRs.

**Tracking:** developers follow builds with `get_build` (phase, timeline, cost against the cap, Maxwell summary, readiness, links), see the agent's live activity with `get_build_activity`, `steer_build` it, or `stop_build` it. `list_builds` shows this month's spend. Admins see every build and total spend with `list_all_builds`.

**Spend** is capped per build (`BUILD_CAP_USD`, default 10) and per developer per month (`BUILD_MONTHLY_CAP_USD`, default 100). Mynt reads the sandbox's machine and model cost as it runs, and stops a build that passes its cap.

**Repositories:** developers install the Mynt GitHub App on a repository and run `connect_repository`. Each build gets an installation token limited to that one repository, with contents and pull-request write access for an hour. No long-lived credential enters the sandbox.

**Configuration:** `BOAT_API_KEY`, `PUBLIC_URL` and a model backend for the agent proxy (builds are disabled without them): either `GOOGLE_APPLICATION_CREDENTIALS` (a service account key file with Vertex AI User on a project where the Claude models are enabled; optional `VERTEX_PROJECT_ID`, `VERTEX_REGION`, default `global`) or `ANTHROPIC_API_KEY` (a dedicated key with a spend limit); `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` (pushing is disabled without them); optional `BUILD_AGENT_MODEL` (default `claude-opus-5-5`), `BUILD_SANDBOX_TYPE` and `BUILD_SANDBOX_TTL_SECONDS`.

### The product desk (innovators)

The desk works out whether a product makes sense, financially and legally. Each firm connects its own GitHub repository as its **workspace** (`connect_desk_repository`, after installing the Mynt GitHub App on it). Its computational logic accumulates there as models: `models/<name>/model.json` declares which products a model applies to, the inputs it needs, and how to run it. The code reads the product, its term sheet and the relevant regulation, and writes a report: a verdict (feasible, marginal or infeasible), metrics, checks that cite the law by `legal_ref`, and stress scenarios.

Work is split by what it needs:
- **Code runs (no AI).** `analyze_product` checks the workspace for a model that applies. If the product's term sheet (`set_product_terms`) has that model's inputs, Mynt clones the repository in a sandbox and executes the model. This is deterministic and re-runnable, costs cents, and never involves an agent. The clone token is removed before any model code runs. If inputs are missing, you get the list to fill in.
- **Agent tasks (intelligence).** If no model applies yet, or you ask for one with `desk_task` (e.g. "add an ALM liquidity ladder for our FD book"), the desk agent takes over. That's Claude Code in a sandbox, through Mynt's agent proxy. It designs the model, chooses and states the assumptions, interprets the regulation from the admins' model, and writes the code and tests on a branch. All arithmetic happens in code. **Mynt then runs that branch itself** in a clean sandbox with no credentials, saves that report, and opens a pull request on the workspace with Mynt's numbers. The agent's own numbers are never used.

`test_product` adds an advisory `feasibility` check from the latest report for the current term sheet. It reports stale when the terms changed. `get_product_terms` shows the term sheet and its analysis; `list_desk_jobs`, `get_desk_job` and `stop_desk_job` track the work.

**Configuration:** a boat.dev key and the GitHub App, plus a model backend for agent tasks. Optional: `DESK_JOB_CAP_USD` (per agent task, default 5), `DESK_RUN_CAP_USD` (per code run, default 1) and `DESK_MONTHLY_CAP_USD` (per firm, default 50; unfinished jobs count at their cap).

### Agent workspaces

Every hosted agent is steered by a folder in this repository, not by prompts in the code. When an agent starts, Mynt copies its folder into the sandbox and makes it the agent's working directory. Claude Code picks up its `CLAUDE.md` and skills from there, the skills call the folder's scripts, and the job's data arrives under `job/`. To improve an agent, change its folder.

```
workspaces/
├── coding-build/        developers' coding agent: CLAUDE.md, skills (mynt-sdk, maxwell-audit, production-readiness), scripts/report_status.py
├── build-audit/         the audit-only agent in a build's clean verification sandbox (maxwell-static-audit)
├── product-desk/        innovators' desk agent: designs models in the firm's repo (model-contract, financial-modelling)
├── governance-review/   admins' review agent: checklists, register skills, evidence scripts
└── connector/           the business-development agent (prospecting, outreach, replies-and-consent, introductions)
```

Whatever an agent produces, Mynt checks it itself afterwards:
- **builds:** a clean-sandbox verification;
- **the desk:** running the agent's code;
- **reviews:** re-verifying quotes and computing the recommendation;
- **the connector:** the rules in `send()`.

### The governance desk (admins)

Admins can have an agent review a firm, a licence it registered, or a product it offers, before they decide (`open_review_case`). With `REVIEW_AUTO_OPEN=1`, a case opens for every licence awaiting review. The agent only researches and judges; it can't change anything, and the admin makes every decision.

**The agent is steered by a workspace folder in this repository**, `workspaces/governance-review/`. It's copied into the sandbox and becomes the agent's working directory:

```
workspaces/governance-review/
├── CLAUDE.md                         standing instructions: evidence or nothing, silent ≠ failed, never guess
├── .claude/skills/
│   ├── review-entity/SKILL.md        company registries and GLEIF
│   ├── review-licence/SKILL.md       the regulator's own register: entry, holder, type, in force, enforcement
│   ├── review-product/SKILL.md       limits, misleading claims, disclosures against the recorded regulation
│   └── cite-evidence/SKILL.md        how to quote so Mynt can verify it
├── checklists/{entity,license,product}.json   every item: who checks it (Mynt or the agent), and whether it's material
└── scripts/
    ├── fetch_page.py                 saves a page's text for verbatim quoting
    └── check_review.py               the agent runs it until its review meets Mynt's rules
```

**Mynt does the rest itself:**
- **Its own items:** it decides the items it can from its own records (licence coverage, segments, product tests, feasibility, the licence type) and freezes the case.
- **Evidence:** after the agent finishes, Mynt re-fetches every cited source (public https pages only) and checks each quote is really there. An item backed only by quotes it can't find becomes **unverified**; a "silent" answer that doesn't say what was searched becomes **not reviewed**.
- **The recommendation is Mynt's, not the agent's:**
  - any material item that fails → reject;
  - any material item not confirmed → needs info;
  - otherwise verify;
  - no recommendation at all if more than 20% of items weren't reviewed.
- **Admins:**
  - `get_review_case` shows the dossier: each item's status, verified and unverified evidence, what was searched, the agent's notes, and its suggestions for improving the workspace.
  - `decide_review_case` records the decision in the audit log next to Mynt's recommendation. For a licence, verify or reject sets its review status, as `review_license` does.

**Configuration:** a boat.dev key, `PUBLIC_URL` and a model backend. Optional: `REVIEW_AUTO_OPEN`, `REVIEW_CASE_CAP_USD` (default 3) and `REVIEW_MONTHLY_CAP_USD` (default 60).

### The connector: business development by an agent

Mynt's **connector** is an AI agent that grows Mynt. It finds innovators (licensed firms that could offer products) and developers (who could build on them), talks with them, and introduces people who should work together. It runs on its own schedule on the same harness as builds: Claude Code in a sandbox, using the model through Mynt's agent proxy. Its only tools are Mynt's MCP server: the `bd_*` tools and the public catalogue. Prospects, conversations and introductions live only in Mynt's database.

Everything the connector does to a person goes through one path, and Mynt enforces the rules there, whatever the agent intends:
- **First contact is by email only.** It can go to an address the person or their firm published for business contact (the source is recorded), or to someone a Mynt user referred. WhatsApp and calls are only for people who asked for them.
- **Every message says who's writing** (an AI agent for Mynt) and carries an opt-out. Email gets a one-click unsubscribe link and `List-Unsubscribe` headers. Replying STOP, the link, or an admin's `bd_suppress` ends contact for good. Opted-out addresses are kept as hashes so they can't be re-added.
- **Caps:**
  - a few unanswered messages at most, days apart;
  - weekday working hours where the person is;
  - a daily message cap;
  - a spend cap per run and per month.
- **Introductions share each person's details only once both said yes.**
- **Consent is a per-purpose ledger:** contacting by email, by WhatsApp or by phone, introductions, and the
  profile itself.
  - Every grant and withdrawal is appended with its basis (consent, published business contact, referral, or
    publicly available information), its evidence and its actor.
  - Tools check the latest entry, and the agent can ask first with `bd_check_consent`.
- **Erasure:**
  - A person can have the connector forget them, with `connect_forget_me`, or by asking in a reply, which the
    agent handles with `bd_erase_on_request`. Admins use `bd_erase`.
  - Their profile, messages, introductions and consents are deleted. Only the suppression hashes and the
    reason remain.
- **Retention:** profiles built from public sources, for people who never replied, are erased after
  `BD_PROFILE_RETENTION_DAYS` (default 180), without suppressing them.
- Replies, web pages and emails are data to the agent, never instructions.

Anyone signed in can talk to the connector from their MCP client: `connect_with_mynt` (what you do and who you'd like to meet), `connect_refer`, and `connect_my_intros` / `connect_answer_intro`. Admins have `bd_overview`, `bd_prospects`, `bd_run_now`, `bd_suppress` and the kill switch `bd_pause`, which also stops a running agent.

**Configuration:** `BD_ENABLED=1`, on top of what builds need (a boat.dev key, `PUBLIC_URL` and a model backend). Optional: `BD_DAILY_CAP` (default 40), `BD_MAX_UNANSWERED` (3), `BD_FOLLOW_UP_GAP_DAYS` (3), `BD_RUN_CAP_USD` (3), `BD_MONTHLY_CAP_USD` (60), `BD_RUN_EVERY_HOURS` (6) and `BD_SENDER_NAME`. Sending providers for email, WhatsApp and voice plug into `ChannelSender`. Until a channel has one, its messages are kept as drafts for admins to review.

### SDKs and experiences (developers)

**SDKs.** `create_sdk(name, languages, product_ids)` defines an SDK over products you can build on: open or approval products, or private ones you were invited to. `generate_sdk_release(sdk_id, version, changelog)` then writes an immutable, semver-versioned bundle:
- `openapi.json`: an OpenAPI 3.1 document for the app API (`GET /v1/products`, `GET /v1/products/{id}`, `POST /v1/handoffs`, `POST /v1/events`, signed webhooks), with a schema per product built from its fields.
- `typescript/`: `src/schema.d.ts` generated from the document by [openapi-typescript](https://openapi-ts.dev), an [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) client for every operation, and a thin `src/index.ts` of Mynt helpers: `createMyntClient`, `startHandoff` (typed to each product's permitted hand-offs), `trackEvent`, `verifyWebhook`, and constants for every product's required disclosures, branding and banned phrases (`disclosuresFor(id)`).
- `python/`: `generate.sh` runs [openapi-python-client](https://github.com/openapi-generators/openapi-python-client) on the document to produce the client, plus a standard-library `mynt_helpers.py` (`verify_webhook`, `disclosures_for`, `check_handoff`, the same constants). openapi-python-client is not a Mynt dependency; tests use it only when installed (set `OPENAPI_PYTHON_CLIENT` to its path to point at a virtualenv).

`list_sdks`, `list_sdk_releases` and `get_sdk_release` (files as `{path, content}`) flag a release **stale**, with reasons, when a product has published a newer version, changed its build terms, been unpublished, or your access was revoked. Generate a new release to pick the changes up. `get_product_sdk` still describes a single product.

**Experiences.** `set_experience(app_id, experience)` gives an app a structured definition: screens of `product_card`, `comparison_table`, `calculator` (maturity, emi, sip), `disclosure_block`, `handoff_cta` and `text` components. On top of the terms lint, `check_experience` and `publish_app` then require:
- every screen showing a product also carries that product's `disclosure_block`, which renders its required disclosures verbatim
- CTAs use only hand-offs the product permits, and comparisons only products that permit `compare`
- components reference only the app's products
- no banned phrase in any title, text or label

`render_experience_preview(app_id)` returns a self-contained HTML page (no scripts or external assets, everything escaped) with product data, disclosures and branding, for review.

### GTM engineering (campaigns)

- **Segments** pick consumers by what they currently hold: `enrolled_in`, `enrolled_in_lines`, and `not_enrolled_in` for cross-sell.
- **Campaigns** target a segment (or everyone) on chosen channels, with up to 5 copy variants for A/B tests.
- **`lint_campaign`** checks every variant against its products. It blocks guaranteed or risk-free claims for products that can lose value, requires a market-risk disclosure for market-linked products, and requires interest/fee disclosure for credit. `launch_campaign` refuses copy that fails.
- **Attribution:** live campaigns show up in consumers' `list_offers`. Each consumer always sees the same variant, and `enroll_in_product` with the offer's `campaign_id` is attributed. `get_campaign_metrics` reports audience, enrollments, conversion, and results per variant and per product.

### Versioning (innovators)

A published product isn't edited in place:
- `create_product_version` drafts the next version with a changelog. `test_product` and `publish_product` then act on that draft, with the same gates as a new product. The live version keeps serving until the draft is published.
- `list_product_versions` and `diff_product_versions` show the history.
- `restore_product_version` drafts a rollback as a new version, so history stays linear.
- Enrollments remember the version they joined on. `upgrade_enrollments` moves all of them to the live version, and a consumer can `upgrade_enrollment` their own.

### Runtime API, webhooks and sandbox (developers)

The MCP tools are for building; a shipped app talks to Mynt's **runtime API** under `/v1`. It is separate from `/mcp`: requests authenticate with a per-app key, not a Clerk sign-in.

**Keys.** `create_api_key(app_id, environment, label, allowed_origins?)` returns a key once (Mynt stores only its SHA-256 hash). Manage keys with `list_api_keys`, `rotate_api_key` (the old secret stops working at once) and `revoke_api_key`; each of these is audit-logged.
- `mynt_live_…` keys work only once the app is published.
- `mynt_test_…` (sandbox) keys work on drafts too.

Send the key as `Authorization: Bearer mynt_live_…`.

| Endpoint | Does |
| --- | --- |
| `GET /v1/products` | `{ products: [...] }`: the products this app may show right now (published, and access granted for the app), each with its fields, `version` and `build_terms`. Revoked or suspended products drop out immediately |
| `GET /v1/products/{id}` | One of those, else `404` |
| `POST /v1/handoffs` | `{ product_id, action: "deep_link" \| "initiate_onboarding", consumer_ref? }` → `201 { handoff_id, redirect_url, sandbox }`. Only if the product's build terms permit the action (`403`). Live: `redirect_url` is the innovator's `handoff_url` with `?handoff_id=…&app_id=…`, or `409 handoff_not_configured` if it has none |
| `POST /v1/events` | `{ type: "view" \| "click" \| "handoff_started", product_id, screen? }` → `202` |
| `POST /v1/sandbox/handoffs/{id}` | Sandbox key only: `{ outcome: "completed" \| "failed" }` resolves a simulated hand-off |

The API never takes or returns consumer financial data:
- `consumer_ref` is the app's own opaque id (letters, digits, `_`, `-`, up to 64 characters). Anything that looks like a phone, account or card number is refused.
- Unknown body fields are refused.

**Errors** are JSON `{ error, message }`, with status `400`, `401`, `403`, `404`, `405`, `409`, `413`, `429` or `500`.

**Limits.**
- Each key gets 60 requests a minute (a token bucket). Past that, the API answers `429` with `Retry-After`.
- Request bodies are limited to 16 KiB.

**CORS.** No wildcard: a browser may call the API only from the origins listed on the key (`allowed_origins`). A key with no origins is for server-side use only.

**Hand-offs.** Innovators set `handoff_url` (https) in a product's build terms with `set_product_access`. When their onboarding finishes or is abandoned, they call `report_handoff_outcome(handoff_id, outcome)`. Only the outcome is shared, never customer data.

**Webhooks.** Each app can register webhooks:
- **Tools:** `create_webhook(app_id, url, events[])` returns the signing secret once. Then `list_webhooks`, `rotate_webhook_secret`, `delete_webhook`, and `list_webhook_deliveries(webhook_id)` (status, attempts, last response code).
- **Events:** `product.version_published`, `product.unpublished`, `product.suspended`, `access.approved`, `access.revoked`, `request.decided`, `handoff.completed`, `handoff.failed`. Each goes to every webhook of every app affected.
- **URLs:** must be https and publicly reachable in production. Plain `http://127.0.0.1` is allowed only outside production, for local testing.
- **Delivery:** each body is `{ id, type, created_at, data }`, where `data` includes the receiving `app_id`. A delivery that fails is retried with exponential backoff (30 s, 1 m, 2 m and so on, doubling each time, 8 attempts in all). `serve-http` runs the delivery worker.

Verify the `Mynt-Signature: t=<unix>,v1=<hex>` header against the raw body:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyMynt(secret, header, rawBody, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1?.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

**Sandbox.** Sandbox keys see the same product data as live keys. Hand-offs are simulated:
- `redirect_url` points at a Mynt sandbox page.
- Resolve a hand-off with `simulate_handoff(handoff_id, outcome)` or `POST /v1/sandbox/handoffs/{id}`. Either one sends `handoff.completed` or `handoff.failed` to your webhooks.
- `create_test_consumer(app_id, label)` gives you an opaque `consumer_ref` to test with.
- Sandbox events and hand-offs are stored but flagged, and are left out of live analytics.

**Releases.** `release_app(app_id, version, changelog)` runs `publish_app`'s checks, publishes the app, and snapshots the whole app definition.
- Versions are semver and must increase.
- `list_app_releases` shows the history.
- `rollback_app(app_id, version)` makes an earlier snapshot current again, if it still passes the products' current terms.
- `publish_app` records a first release (`1.0.0`) if an app has none.

**Analytics.**
- Developers: `get_app_metrics(app_id, from?, to?, include_sandbox?)` gives views, clicks and hand-offs (started, completed, failed) per product and per day. It also gives conversion (completed hand-offs per view) and the hand-off completion rate. Only live traffic counts unless you set `include_sandbox`.
- Innovators: `get_product_distribution_metrics(product_id)` shows how one of their products performs across every app that shows it.

Roles nest: **every admin is also an innovator, every innovator a developer, and every developer a consumer**. Each role gets its own tools plus everything below it. Tools are registered per user, so a client only *sees* the tools its roles allow. `whoami` shows both the granted and the effective roles.

## Product lines

Every product has a `product_line`:

- **credit**: cards, personal/home/auto/education/gold loans, BNPL, working-capital loans
- **wealth**: mutual funds, ETFs, REITs/InvITs, stocks, retirement accounts, government savings schemes
- **insurance**: term/whole life, health, motor, home, travel, ULIPs, annuities
- **treasury**: deposits, sweep accounts, liquid/money-market funds, T-bills, commercial paper, government and corporate bonds, FX forwards, interest-rate swaps, derivatives

`list_products` filters by `product_line`, `category`, `region` (`IN`, `US`, `global`), `risk_level` or free text, and `list_categories` returns counts for each.

Each product has: `id`, `name`, `product_line`, `category`, `region`, `risk_level`, `liquidity`, `typical_horizon`, `return_type`, `regulator`, `description`, `key_features`.

## Innovator workflow: create → test → publish

1. `create_product` saves a **draft**, visible only to its creator.
2. `test_product` runs the checks: required disclosures (description, regulator, at least 2 features), valid enums, product-line rules (credit uses `cost_of_credit` and risk `not_applicable`; insurance uses protection, guaranteed or market-linked returns), and a **misleading-claims** check that fails market-linked products promising "guaranteed", "assured" or "risk-free" returns.
3. `publish_product` lists it in the catalog. It is allowed only if the latest test passed **and** the product hasn't changed since. Editing a product means re-testing it.
4. `unpublish_product` hides it again. Existing enrollments are kept, new ones are blocked, and developers' apps flag it under `unavailable_product_ids`.

Bundled catalog products are read-only and pass the same checks.

## Install & build

Requires Node.js 22.13+ and a Postgres database. [Supabase](https://supabase.com) (self-hosted or cloud) is the intended backend; any Postgres 15+ works.

```bash
git clone https://github.com/never2average/mynt.git
cd mynt
npm install
npm run build
```

## Users and tokens

Users, roles, products, enrollments and apps are stored in Postgres (Supabase), in a dedicated `financial_products` schema. Supabase's auto-generated REST API only exposes `public`, so this data isn't reachable through it. Set `DATABASE_URL` to the connection string; the schema is created on first start. If the schema already exists and is owned by the app's role (as the deploy script sets it up), the role needs no database-level privileges.

Create users with the CLI. Each command prints a token once; only its hash is stored.

```bash
export DATABASE_URL=postgres://user:password@host:5432/postgres
node dist/index.js users add --name "Asha" --role consumer
node dist/index.js users add --name "Dev"  --role developer
node dist/index.js users add --name "Ines" --role innovator
node dist/index.js users add --name "Max"  --role consumer --role innovator   # several roles
node dist/index.js users list
```

## Run it

### Locally over stdio (one user per client)

Pass the user's token in `FINANCIAL_PRODUCTS_TOKEN`. Without it, the server runs as a read-only guest.

Claude Code:

```bash
claude mcp add mynt -e DATABASE_URL=postgres://... -e FINANCIAL_PRODUCTS_TOKEN=fpm_... -- node /absolute/path/to/mynt/dist/index.js
```

Claude Desktop / other clients:

```json
{
  "mcpServers": {
    "mynt": {
      "command": "node",
      "args": ["/absolute/path/to/mynt/dist/index.js"],
      "env": { "DATABASE_URL": "postgres://...", "FINANCIAL_PRODUCTS_TOKEN": "fpm_..." }
    }
  }
}
```

Or run straight from GitHub: `npx -y github:never2average/mynt`.

### Shared server over HTTP (many users)

```bash
node dist/index.js serve-http --port 3000 --host 0.0.0.0
```

Clients connect to `http://host:3000/mcp` (Streamable HTTP) with `Authorization: Bearer fpm_...`. Requests without a token are served as a guest, and invalid tokens get `401`. Put it behind TLS (e.g. Caddy or nginx) before exposing it publicly.

Set `MYNT_PSEUDONYM_SECRET` to a long random string (e.g. `openssl rand -hex 32`) so innovators can see product requests: each requester appears to each innovator under a pseudonym keyed with it. Without it, `list_product_requests` refuses to list anything.

```bash
claude mcp add --transport http mynt https://your-host/mcp --header "Authorization: Bearer fpm_..."
```

## Whitelist sign-in with Clerk

Set `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and `PUBLIC_URL` (e.g. `https://mcp.example.com`) and the HTTP server accepts only whitelisted people signed in with [Clerk](https://clerk.com):

- The server is an OAuth-protected resource with Clerk as its authorization server. MCP clients (Claude, Claude Code and others) discover this from `/.well-known/oauth-protected-resource/mcp`, register themselves with Clerk and open Clerk's sign-in page.
- Each request's Clerk access token is verified, and must be issued for this server's `/mcp` resource. The caller's **verified** email must be on the whitelist. The whitelist entry also decides the caller's roles, and removing it cuts them off on their next request.
- Local `fpm_` tokens and guests are refused over HTTP. They still work over stdio.

```bash
node dist/index.js clerk setup                                          # once: allowlist, client registration, PKCE, audience claims
node dist/index.js users invite --email ines@example.com --role innovator
node dist/index.js users invite --email asha@example.com --role consumer --role developer
node dist/index.js users revoke --email asha@example.com
node dist/index.js users list
```

`users invite` and `users revoke` also update Clerk's allowlist, so people who aren't invited can't sign up at all. Connect a client with just the URL; it will open Clerk's sign-in page:

```bash
claude mcp add --transport http mynt https://mcp.example.com/mcp
```

## Deploying to a VM with self-hosted Supabase

[`deploy/setup-vm.sh`](deploy/setup-vm.sh) sets up an Ubuntu VM end to end and is safe to re-run for updates:

```bash
# as root on the VM, with the domain's A record pointing at it
curl -fsSL https://raw.githubusercontent.com/never2average/mynt/main/deploy/setup-vm.sh -o setup-vm.sh
bash setup-vm.sh mcp.example.com [git-ref]
```

What it does:

- Installs Docker and opens only SSH, 80 and 443 in `ufw`.
- Runs Supabase's official Docker stack in `/opt/supabase` with freshly generated secrets. Studio, the API gateway and the pooler are bound to localhost; reach Studio with `ssh -L 8000:127.0.0.1:8000 root@<vm>`.
- Creates a least-privilege Postgres role `financial_products_app` that owns only the `financial_products` schema.
- Builds the MCP image and runs it with Caddy, which gets the TLS certificate automatically, serving `https://<domain>/mcp`.

Create users on the VM:

```bash
docker compose -f /opt/mynt/src/deploy/docker-compose.yml exec mcp \
  node dist/index.js users add --name "Ines" --role innovator
```

## Starting empty

A new deployment starts with no products, regions or categories: admins define regions, categories and the regulatory model, and innovators publish products. Mynt's reference catalogue (owner-less, read-only products open to every developer) is kept in the database; its products are composed of regulated primitives like any other (`admin_set_product_composition`, `get_product_regime`).

## Development

```bash
npm test   # builds, then tests roles, the innovator workflow, ownership and HTTP auth on in-process Postgres (PGlite)
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test   # also runs the CLI/stdio test against a real Postgres
```

## Disclaimer

Mynt ships no catalogue: every product comes from an innovator. Product information is for informational purposes, contains no live rates and is not financial advice; rules (tax treatment, limits, lock-ins) change, so verify with the relevant regulator or provider. Enrollments here are records in this server's database, not real accounts.

## License

MIT
