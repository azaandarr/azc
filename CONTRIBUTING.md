# Contributing to azc

Thanks for wanting to improve azc! This guide covers everything you need to get started.

## Getting set up

```bash
git clone https://github.com/azaandarr/azc.git
cd azc
npm install
npm link    # makes `azc` available globally for local testing
```

You'll need Node.js 20 or later. For commands that talk to Azure (`scan`, `compare`), you also need the Azure CLI installed and an `az login` session — but `azc price` and `azc plan` work without any Azure credentials.

## Making changes

1. **Fork the repo** and create a branch from `main`. Name it something descriptive: `fix/redis-price-matching`, `feat/aks-support`, `docs/improve-readme`.
2. **Write your code.** This project uses plain JavaScript with CommonJS modules — no TypeScript, no build step. Keep it that way.
3. **Comment generously.** Every function and every non-obvious line should have an inline comment explaining *why*, not just *what*. This is a deliberate style choice for the project.
4. **Run the tests** before pushing:
   ```bash
   npm test
   ```
5. **Open a pull request** against `main`. Fill out the PR template — it's short.

## Code style

- Plain JavaScript, CommonJS (`require` / `module.exports`)
- `camelCase` for variables and functions, `kebab-case` for file names, `UPPER_SNAKE` for constants
- No classes — use plain functions and objects
- Use the `logger` utility (`src/utils/logger.js`) for all terminal output, never raw `console.log`
- Lint with `npm run lint` (uses [Standard](https://standardjs.com/))

## Adding a new resource type

The most common contribution is adding support for a new Azure resource type. Here's the process:

1. Query Azure Resource Graph to see the shape of the resource response for that type.
2. Add a mapper function in `src/services/sku-mapper.js` that extracts the SKU, quantity, and pricing parameters.
3. Figure out the correct `serviceName` and filter values for the Retail Prices API.
4. Add a test case in `test/sku-mapper.test.js` with a realistic fixture.
5. Test against a real Azure subscription to verify the prices match the Azure Portal.

See the existing mappers in `sku-mapper.js` for the pattern to follow.

## Testing

Tests use Node's built-in test runner:

```bash
npm test                              # run everything
node --test test/sku-mapper.test.js   # run a single file
```

- **Unit tests** for sku-mapper, currency formatting, price-cache, config
- **Integration tests** for retail-prices.js (hits the live public API — this is safe and free)
- Mock Resource Graph responses using fixtures in `test/fixtures/`
- Don't mock the Retail Prices API — it's public, free, and the live response is the best assertion

## Reporting bugs

Open an issue using the **Bug Report** template. Include the command you ran, what you expected, and what actually happened. If `azc` printed an error code (like `AZC_AUTH_FAILED`), include that too.

## Suggesting features

Open an issue using the **Feature Request** template. Describe the problem you're trying to solve, not just the solution you have in mind.

## Commit messages

No strict convention enforced, but aim for clear, imperative-mood summaries:

```
Add support for AKS clusters in sku-mapper
Fix Redis price disambiguation for Premium tier
Update README with compare command examples
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
