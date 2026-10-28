# financial-products-mcp

An [MCP](https://modelcontextprotocol.io) server that returns a searchable catalog of financial products — deposits, government savings schemes, retirement accounts, mutual funds, ETFs, bonds, derivatives, insurance and credit products — for India (`IN`), the US (`US`) and products available everywhere (`global`).

## Tools

| Tool | Purpose |
| --- | --- |
| `list_products` | List products, filtered by `category`, `region`, `risk_level` and/or free-text `query`, with `limit`/`offset` pagination |
| `get_product` | Full details for one product by `id` (e.g. `ppf`, `index-fund`, `term-life-insurance`) |
| `list_categories` | Available categories, regions and risk levels with counts |

The full catalog is also exposed as the resource `financial-products://catalog`.

Each product has: `id`, `name`, `category`, `region`, `risk_level`, `liquidity`, `typical_horizon`, `return_type`, `regulator`, `description`, `key_features`.

## Install & build

```bash
git clone https://github.com/never2average/financial-products-mcp.git
cd financial-products-mcp
npm install
npm run build
```

## Use with an MCP client

Claude Code:

```bash
claude mcp add financial-products -- node /absolute/path/to/financial-products-mcp/dist/index.js
```

Claude Desktop / other clients (`mcpServers` config):

```json
{
  "mcpServers": {
    "financial-products": {
      "command": "node",
      "args": ["/absolute/path/to/financial-products-mcp/dist/index.js"]
    }
  }
}
```

Or run straight from GitHub without cloning:

```json
{ "command": "npx", "args": ["-y", "github:never2average/financial-products-mcp"] }
```

## Using your own catalog

Set `FINANCIAL_PRODUCTS_FILE` to a JSON array of products with the same fields as [`data/products.json`](data/products.json):

```json
{ "command": "node", "args": ["dist/index.js"], "env": { "FINANCIAL_PRODUCTS_FILE": "/path/to/my-products.json" } }
```

## Development

```bash
npm test   # builds, then runs tests over in-memory and stdio transports
```

## Disclaimer

The bundled catalog describes product *types* for informational purposes. It contains no live rates and is not financial advice; rules (tax treatment, limits, lock-ins) change, so verify with the relevant regulator or provider.

## License

MIT
