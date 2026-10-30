# Mynt

**Mynt** is an [MCP](https://modelcontextprotocol.io) server for **credit, wealth, insurance and treasury** products. MCP clients show it as `mynt`. It has four kinds of user:

| User type | Can | Tools (in addition to the catalog tools) |
| --- | --- | --- |
| **Consumer** | Use financial products and respond to offers | `enroll_in_product`, `list_my_enrollments`, `cancel_enrollment`, `list_offers`, `upgrade_enrollment` |
| **Developer** | Build app experiences and do GTM engineering around financial products | Apps: `create_app`, `update_app`, `list_my_apps`, `preview_app`, `publish_app`. GTM: `create_segment`, `list_my_segments`, `create_campaign`, `update_campaign`, `lint_campaign`, `launch_campaign`, `pause_campaign`, `end_campaign`, `list_my_campaigns`, `get_campaign_metrics` |
| **Innovator** | Create, test, publish, version and upgrade financial products | `create_product`, `update_product`, `test_product`, `publish_product`, `unpublish_product`, `list_my_products`, `create_product_version`, `update_product_version`, `list_product_versions`, `diff_product_versions`, `restore_product_version`, `upgrade_enrollments` |
| **Admin** | Run Mynt: geographies, product types, the whitelist, and oversight, all from Mynt itself | `define_region`, `define_product_category`, `list_whitelist`, `invite_user`, `revoke_user`, `list_all_campaigns`, `admin_pause_campaign`, `admin_set_product_status`, `audit_log` |

Everyone (including guests without a token) gets the catalog tools: `whoami`, `list_products`, `get_product`, `list_categories`, `list_regions`, `list_product_categories`, `list_apps`, plus the resource `mynt://catalog`.

### Administration

Admins own Mynt's reference data and access. **Every admin action is written to the audit log with who did it.**
- **Geographies** (`define_region`): where products may be offered. Each region records its regulators, its regulatory ecosystem (each regulator's remit, the key laws and bodies), the legal procedure to launch each product line there (licences, approvals, filings, timeline), and the official sources. Fields you leave out keep their values. Innovators read the full picture with `get_region`.
- **Regulatory model** (`define_regulator`, `define_legislation`, `define_judgment`): per region, each regulator's **scope** (the product types it supervises, mapped to Mynt categories, with the actions covered: issuance, sale, purchase, secondary sale, repackaging; and the customer personas with their qualifications), and the **licence types** it grants. Each licence carries **GRC**: registers of obligations, reporting/disclosure filings, risks and controls; repositories of regulatory communications, enforcement actions, press releases, policies and risk models; the product types and customer segments it allows; mandatory internal and external stakeholders; and how to apply. **Legal** is recorded alongside in two branches. **Legislative** covers acts, ordinances, rules, regulations, master directions, circulars, guidelines, notifications and orders, each with its issuer, the instrument it's made under (`parent_id`), status and effective date. **Judiciary** covers court and tribunal decisions, each with court and level, bench, holding, the legislation it interprets, and whether it's still good law. Obligations and filings cite either kind by `legal_ref`. Broken links inside a regulator are refused; looser links come back as warnings. Innovators read it with `get_regulator` and `list_legal_instruments` (both branches, filterable), and ask `find_licenses` which licence covers a category, action and persona. `test_product` names the covering licence or warns when there is none.
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
- **How products are checked against them:** `test_product` fails a product whose region or category isn't defined and active, or whose category doesn't allow its product line. It warns when the regulator isn't one listed for the region, and when no launch procedure is documented for the product's line there. Retiring a region or category (`active: false`) stops new products from using it; live products stay. Mynt seeds both lists from the bundled catalog the first time it starts.
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

A developer can have Mynt **build and ship** one of their experiences. `start_build` runs a coding agent in a fresh [boat.dev](https://boat.dev) sandbox. The agent:
1. writes the code against the app's products and their build terms
2. runs the **[Maxwell](https://github.com/OnFinance/Maxwell)** static security probes (secure code review, CI/CD, agent code, schemas, infrastructure as code) and fixes what it can
3. works through a **production-readiness checklist**: tests, lint and types, secrets scan, dependency audit, SBOM, required disclosures, permitted actions only, no financial-data collection, docs
4. deploys a token-gated **preview**
5. with a connected repository, pushes a branch and opens a **pull request**; never to the default branch

**Gates:**
- **critical or high** Maxwell findings, or no audit at all → `blocked`
- an unmet readiness check → `failed`
- otherwise → `succeeded`, with the preview URL and PR

**Tracking:** developers follow builds with `get_build` (phase, timeline, cost against the cap, Maxwell summary, readiness, links), see the agent's live activity with `get_build_activity`, `steer_build` it, or `stop_build` it. `list_builds` shows this month's spend. Admins see every build and total spend with `list_all_builds`.

**Spend** is capped per build (`BUILD_CAP_USD`, default 10) and per developer per month (`BUILD_MONTHLY_CAP_USD`, default 100). Mynt reads the sandbox's machine and model cost as it runs, and stops a build that passes its cap.

**Repositories:** developers install the Mynt GitHub App on a repository and run `connect_repository`. Each build gets an installation token limited to that one repository, with contents and pull-request write access for an hour. No long-lived credential enters the sandbox.

**Configuration:** `BOAT_API_KEY` (builds are disabled without it); `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` (pushing is disabled without them); optional `BUILD_AGENT_PROVIDER` (default `claude-code`), `BUILD_AGENT_MODEL`, `BUILD_SANDBOX_TYPE` and `BUILD_SANDBOX_TTL_SECONDS`.

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

Roles nest: **every admin is also an innovator, every innovator a developer, and every developer a consumer**. Each role gets its own tools plus everything below it. Tools are registered per user, so a client only *sees* the tools its roles allow. `whoami` shows both the granted and the effective roles.

## Product lines

Every product has a `product_line`:

- **credit**: cards, personal/home/auto/education/gold loans, BNPL, working-capital loans
- **wealth**: mutual funds, ETFs, REITs/InvITs, stocks, retirement accounts, government savings schemes
- **insurance**: term/whole life, health, motor, home, travel, ULIPs, annuities
- **treasury**: deposits, sweep accounts, liquid/money-market funds, T-bills, commercial paper, government and corporate bonds, FX forwards, interest-rate swaps, derivatives

`list_products` filters by `product_line`, `category`, `region` (`IN`, `US`, `global`), `risk_level` or free text, and `list_categories` returns counts for each. The bundled catalog has 50 product types.

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

## Seeding your own catalog

Set `FINANCIAL_PRODUCTS_FILE` to a JSON array with the same fields as [`data/products.json`](data/products.json). On every start, products whose `id` isn't in the database yet are inserted as published, read-only products.

## Development

```bash
npm test   # builds, then tests roles, the innovator workflow, ownership and HTTP auth on in-process Postgres (PGlite)
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test   # also runs the CLI/stdio test against a real Postgres
```

## Disclaimer

The bundled catalog describes product *types* for informational purposes. It contains no live rates and is not financial advice; rules (tax treatment, limits, lock-ins) change, so verify with the relevant regulator or provider. Enrollments here are records in this server's database, not real accounts.

## License

MIT
