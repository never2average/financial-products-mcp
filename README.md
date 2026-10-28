# financial-products-mcp

An [MCP](https://modelcontextprotocol.io) server for **credit, wealth, insurance and treasury** products, with three kinds of user:

| User type | Can | Tools (in addition to the catalog tools) |
| --- | --- | --- |
| **Consumer** | Use financial products | `enroll_in_product`, `list_my_enrollments`, `cancel_enrollment` |
| **Developer** | Build app experiences around financial products | `create_app`, `update_app`, `list_my_apps`, `preview_app`, `publish_app` |
| **Innovator** | Create, test and publish financial products | `create_product`, `update_product`, `test_product`, `publish_product`, `unpublish_product`, `list_my_products` |

Everyone (including guests without a token) gets the catalog tools: `whoami`, `list_products`, `get_product`, `list_categories`, `list_apps`, plus the resource `financial-products://catalog`.

Tools are registered per user, so a client only *sees* the tools its roles allow. A user can hold more than one role.

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
git clone https://github.com/never2average/financial-products-mcp.git
cd financial-products-mcp
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
claude mcp add financial-products -e DATABASE_URL=postgres://... -e FINANCIAL_PRODUCTS_TOKEN=fpm_... -- node /absolute/path/to/financial-products-mcp/dist/index.js
```

Claude Desktop / other clients:

```json
{
  "mcpServers": {
    "financial-products": {
      "command": "node",
      "args": ["/absolute/path/to/financial-products-mcp/dist/index.js"],
      "env": { "DATABASE_URL": "postgres://...", "FINANCIAL_PRODUCTS_TOKEN": "fpm_..." }
    }
  }
}
```

Or run straight from GitHub: `npx -y github:never2average/financial-products-mcp`.

### Shared server over HTTP (many users)

```bash
node dist/index.js serve-http --port 3000 --host 0.0.0.0
```

Clients connect to `http://host:3000/mcp` (Streamable HTTP) with `Authorization: Bearer fpm_...`. Requests without a token are served as a guest, and invalid tokens get `401`. Put it behind TLS (e.g. Caddy or nginx) before exposing it publicly.

```bash
claude mcp add --transport http financial-products https://your-host/mcp --header "Authorization: Bearer fpm_..."
```

## Deploying to a VM with self-hosted Supabase

[`deploy/setup-vm.sh`](deploy/setup-vm.sh) sets up an Ubuntu VM end to end and is safe to re-run for updates:

```bash
# as root on the VM, with the domain's A record pointing at it
curl -fsSL https://raw.githubusercontent.com/never2average/financial-products-mcp/main/deploy/setup-vm.sh -o setup-vm.sh
bash setup-vm.sh mcp.example.com [git-ref]
```

What it does:

- Installs Docker and opens only SSH, 80 and 443 in `ufw`.
- Runs Supabase's official Docker stack in `/opt/supabase` with freshly generated secrets. Studio, the API gateway and the pooler are bound to localhost; reach Studio with `ssh -L 8000:127.0.0.1:8000 root@<vm>`.
- Creates a least-privilege Postgres role `financial_products_app` that owns only the `financial_products` schema.
- Builds the MCP image and runs it with Caddy, which gets the TLS certificate automatically, serving `https://<domain>/mcp`.

Create users on the VM:

```bash
docker compose -f /opt/financial-products-mcp/src/deploy/docker-compose.yml exec mcp \
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
