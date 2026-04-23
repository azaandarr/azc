# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in azc, please report it responsibly. **Do not open a public GitHub issue.**

Email **azaandarryt@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce it
- The potential impact

You should receive an acknowledgement within 48 hours. I'll work with you to understand and fix the issue before any public disclosure.

## Scope

azc is a read-only CLI tool that queries Azure Resource Graph metadata (resource names, types, SKUs) and the public Azure Retail Prices API. It does not access secrets, connection strings, keys, or customer data.

That said, relevant security concerns include:

- **Credential handling** — azc delegates authentication to `@azure/identity` (`DefaultAzureCredential`). It never stores or transmits credentials itself.
- **Cache files** — Pricing data cached in `~/.azc/cache/` contains only public pricing information. No secrets or resource-specific data.
- **Estimate files** — Saved estimates in `~/.azc/estimates/` contain resource names and types but no access keys or sensitive properties.
- **Dependencies** — Vulnerabilities in upstream packages (`@azure/identity`, `commander`, `inquirer`, etc.) may affect azc.

## Best Practices for Users

- Keep your Azure CLI and Node.js up to date
- Use `az login` for local development; use Managed Identity in CI/CD
- Grant only the `Reader` role on subscriptions you want to scan — azc never needs write access
