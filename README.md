# azc — Azure Costing CLI

Fast, terminal-native Azure infrastructure cost estimation. Replaces the Azure Pricing Calculator for engineers who live in the terminal.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-brightgreen.svg)](https://nodejs.org/)

## Install

```bash
# From npm
npm install -g azc

# Or clone and link for development
git clone https://github.com/azaandarr/azc.git && cd azc
npm install
npm link
```

## Prerequisites

- **Node.js 20+**
- **Azure CLI** (`az`) for authentication — [install guide](https://aka.ms/installazurecliwindows)
- **Reader role** on the Azure subscriptions you want to scan

## Quick start

```bash
# 1. Log in to Azure (one-time, opens browser)
az login

# 2. Look up a price (no login required)
azc price "App Service P1v3"
azc price "VM Standard_D4s_v5" --os linux
azc price "Redis C3" --region westeurope --currency EUR

# 3. Scan a live subscription
azc scan --subscription <subscription-id>
azc scan -s <subscription-id> --resource-group my-rg --out report.xlsx

# 4. Compare a SKU change
azc compare -s <subscription-id> --with "App Service:P1v3"

# 5. Build an estimate interactively
azc plan --interactive
```

## Commands

### `azc price <query>`

Quick price lookup against the public Azure Retail Prices API. No authentication required.

```bash
azc price "App Service P1v3"              # App Service pricing
azc price "VM Standard_D4s_v5" --os linux # VM with OS filter
azc price "PostgreSQL Standard_D2ds_v5"   # Database compute
azc price "Redis C1"                      # Redis cache tiers
azc price "SQL S3"                        # Azure SQL
```

Options: `--region`, `--os`, `--currency`

### `azc scan`

Scan a live Azure subscription and estimate monthly costs for all resources.

```bash
azc scan -s <subscription-id-or-alias>
azc scan -s prod --resource-group api-rg
azc scan -s prod --format json | jq '.totalMonthlyCost'
azc scan -s prod --out report.xlsx
azc scan -s prod --out report.json
```

Options: `--subscription`, `--resource-group`, `--format`, `--out`, `--region`, `--currency`

**Supported resource types (15):**
App Service Plans, Virtual Machines, PostgreSQL Flexible Servers, Storage Accounts, Cosmos DB, Redis Cache, Key Vault, Application Insights, CDN, Application Gateway, Azure SQL, Service Bus, Managed Disks, Public IPs, Container Registry.

Unsupported resource types are listed separately — they won't crash the scan.

### `azc compare`

Compare current costs against a hypothetical SKU change.

```bash
azc compare -s prod --with "App Service:P1v3"
azc compare -s prod --with "PostgreSQL:Standard_D4ds_v5" --name prism-db
azc compare -s prod --with "App Service:S1,instances=3"
```

Options: `--subscription`, `--with`, `--name`, `--format`, `--region`, `--currency`

### `azc plan`

Interactive guided cost estimate builder.

```bash
azc plan --interactive                    # Start fresh
azc plan --load ~/.azc/estimates/est.json # Resume a saved estimate
azc plan -i --region westeurope --out estimate.xlsx
```

Options: `--interactive`, `--load`, `--region`, `--currency`, `--format`, `--out`

### `azc config`

View and modify configuration.

```bash
azc config show                           # Show all settings
azc config get region                     # Get a single value
azc config set region westeurope          # Set a default
azc config set currency EUR               # Change default currency
azc config add-sub prod xxxx-xxxx-xxxx    # Add subscription alias
azc config remove-sub staging             # Remove an alias
azc config path                           # Print config file path
```

## Configuration

Settings are stored in `~/.azc/config.json` (created on first run):

```json
{
  "defaults": {
    "region": "uksouth",
    "currency": "GBP",
    "os": "linux",
    "format": "table"
  },
  "subscriptions": {
    "prod": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "staging": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
  }
}
```

Subscription aliases let you type `azc scan -s prod` instead of the full GUID.

## Global flags

| Flag | Effect |
|------|--------|
| `--quiet` | Suppress non-essential output (errors/warnings still print) |
| `--no-color` | Disable coloured output (useful when piping) |
| `--verbose` | Show debug output (API URLs, cache hits, timing) |
| `--version` | Print version |

## Output formats

- **Table** (default) — coloured, aligned terminal output
- **JSON** (`--format json`) — structured JSON for piping to `jq`
- **Excel** (`--out report.xlsx`) — formatted workbook with summary row

## Caching

Pricing data is cached locally at `~/.azc/cache/` with a 24-hour TTL. The Azure Retail Prices API updates infrequently, so this is safe. Cache files contain only public pricing data — no secrets.

## Security

- No secrets in code. Ever.
- Azure auth handled entirely by `DefaultAzureCredential` (picks up `az login`, Managed Identity, env vars).
- The Retail Prices API is public and unauthenticated.
- The tool only reads resource metadata (names, types, SKUs). It never accesses keys, connection strings, or customer data.
- RBAC: your identity needs the `Reader` role on target subscriptions. Nothing more.

## Development

```bash
npm install       # Install dependencies
npm test          # Run tests (node --test)
npm link          # Link CLI globally for local testing
npm run lint      # Lint with standard
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code style, and how to add support for new Azure resource types.

## License

[MIT](LICENSE)
