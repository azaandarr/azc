// credential.js — Azure authentication wrapper using DefaultAzureCredential.
// This module provides a single shared credential instance and a validate()
// function that proactively checks auth before any real work begins.
// By validating early, we give the user a clear "run az login" message
// instead of a cryptic error buried in a Resource Graph call.

const logger = require('../utils/logger');

// Lazy-loaded credential instance — we don't import @azure/identity at
// module load time because it's a heavy dependency and the `azc price`
// command doesn't need Azure auth at all (it only hits the public Retail API).
let credential = null;

/**
 * Get the shared DefaultAzureCredential instance.
 * Creates it on first call and reuses it for the rest of the CLI session.
 * Lazy-loading means `azc price` never pays the import cost of @azure/identity.
 * @returns {import('@azure/identity').DefaultAzureCredential}
 */
function getCredential() {
  if (!credential) {
    // Dynamic require — keeps startup fast for commands that don't need auth
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential();
  }
  return credential;
}

/**
 * Proactively validate that the credential works by requesting a token
 * for the Azure Resource Manager scope. Call this at the start of any
 * command that needs Azure auth (scan, compare) — it gives a clear error
 * message before we're deep into a scan.
 *
 * @throws {Error} If authentication fails (with a helpful AZC_AUTH_FAILED message)
 * @returns {Promise<void>}
 */
async function validate() {
  const cred = getCredential();
  logger.debug('Validating Azure credential (scope: management.azure.com)');

  try {
    const token = await cred.getToken('https://management.azure.com/.default');
    logger.debug(`Token acquired, expires: ${new Date(token.expiresOnTimestamp).toISOString()}`);
  } catch (err) {
    logger.error(
      'Not authenticated with Azure. Please run one of the following:\n' +
      '  • az login              (interactive browser login)\n' +
      '  • az login --use-device-code  (device code flow for remote/SSH)\n' +
      '  • Set AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET env vars\n\n' +
      `  Underlying error: ${err.message}`,
      'AZC_AUTH_FAILED'
    );
    process.exit(1);
  }
}

module.exports = {
  getCredential,
  validate,
};
