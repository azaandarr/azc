// doctor.js — `azc doctor` command.
// Validates the entire azc setup and prints a checklist.
// Engineers paste the output into Slack when asking for help.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');
const config = require('../config/config');
const logger = require('../utils/logger');
const pkg = require('../../package.json');

/**
 * Check Node.js version is >= 20.
 */
function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  return {
    ok: major >= 20,
    label: 'Node.js',
    detail: `${version} ${major >= 20 ? '(need ≥20)' : '— need ≥20, please upgrade'}`,
  };
}

/**
 * Check azc version (always passes — informational).
 */
function checkAzcVersion() {
  return {
    ok: true,
    label: 'azc version',
    detail: pkg.version,
  };
}

/**
 * Check if config file exists.
 */
function checkConfigExists() {
  const exists = fs.existsSync(config.CONFIG_PATH);
  return {
    ok: exists,
    label: 'Config file',
    detail: exists
      ? `${config.CONFIG_PATH} exists`
      : `not found — run any azc command to create it`,
  };
}

/**
 * Check default region (informational).
 */
function checkDefaultRegion() {
  return {
    ok: true,
    label: 'Default region',
    detail: config.getDefault('region'),
  };
}

/**
 * Check default currency (informational).
 */
function checkDefaultCurrency() {
  return {
    ok: true,
    label: 'Default currency',
    detail: config.getDefault('currency'),
  };
}

/**
 * Check if Azure CLI is installed.
 */
function checkAzureCli() {
  try {
    const output = execSync('az --version', { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    const firstLine = output.split('\n')[0] || '';
    const versionMatch = firstLine.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    return {
      ok: true,
      label: 'Azure CLI',
      detail: `${version} installed`,
    };
  } catch (_) {
    return {
      ok: false,
      label: 'Azure CLI',
      detail: 'not found — install from https://aka.ms/installazurecliwindows',
    };
  }
}

/**
 * Check Azure login status.
 */
function checkAzureLogin() {
  try {
    const output = execSync('az account show --query "{user: user.name, sub: name}" -o json', {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const account = JSON.parse(output);
    const user = account.user || 'unknown';
    const sub = account.sub || '';
    return {
      ok: true,
      label: 'Azure login',
      detail: `logged in as ${user}${sub ? ` (${sub})` : ''}`,
    };
  } catch (_) {
    return {
      ok: false,
      label: 'Azure login',
      detail: 'not logged in — run `az login`',
    };
  }
}

/**
 * Check subscription alias count.
 */
function checkSubscriptions() {
  const cfg = config.loadConfig();
  const subs = Object.keys(cfg.subscriptions || {});
  const count = subs.length;
  return {
    ok: count > 0,
    label: 'Subscriptions',
    detail: count > 0
      ? `${count} alias${count !== 1 ? 'es' : ''} configured (${subs.join(', ')})`
      : '0 aliases configured — add with `azc config add-sub`',
  };
}

/**
 * Check Retail Prices API reachability.
 */
async function checkRetailApi() {
  const url = 'https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Virtual%20Machines%27&$top=1';
  const start = Date.now();
  try {
    const res = await fetch(url);
    const elapsed = Date.now() - start;
    if (res.ok) {
      return { ok: true, label: 'Retail Prices API', detail: `reachable (${elapsed}ms)` };
    }
    return { ok: false, label: 'Retail Prices API', detail: `HTTP ${res.status} (${elapsed}ms)` };
  } catch (err) {
    return { ok: false, label: 'Retail Prices API', detail: `unreachable — ${err.message}` };
  }
}

/**
 * Check price cache health.
 */
function checkCacheHealth(cacheDir) {
  const dir = cacheDir || config.CACHE_DIR;
  if (!fs.existsSync(dir)) {
    return { ok: true, label: 'Price cache', detail: 'no cache directory yet' };
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  let expired = 0;

  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(dir, file));
      if (now - stat.mtimeMs > TTL) expired++;
    } catch (_) {}
  }

  return {
    ok: true,
    label: 'Price cache',
    detail: `${files.length} entries, ${expired} expired`,
  };
}

/**
 * Register the doctor command.
 */
module.exports = function registerDoctorCommand(program) {
  program
    .command('doctor')
    .description('Check your azc setup and diagnose common issues')
    .action(async () => {
      logger.spacer();
      logger.header('azc doctor — checking your setup...');
      logger.spacer();

      // Run sync checks
      const checks = [
        checkNodeVersion(),
        checkAzcVersion(),
        checkConfigExists(),
        checkDefaultRegion(),
        checkDefaultCurrency(),
        checkAzureCli(),
        checkAzureLogin(),
        checkSubscriptions(),
      ];

      // Run async checks
      checks.push(await checkRetailApi());
      checks.push(checkCacheHealth());

      // Print results
      let passed = 0;
      let firstFailure = null;

      for (const check of checks) {
        if (check.ok) passed++;
        else if (!firstFailure) firstFailure = check;

        const icon = check.ok ? chalk.green('✔') : chalk.red('✖');
        const label = check.label.padEnd(18);
        const detail = check.ok ? chalk.dim(check.detail) : chalk.yellow(check.detail);
        logger.raw(`  ${icon} ${label} ${detail}\n`);
      }

      logger.spacer();
      logger.info(`${passed}/${checks.length} checks passed.`);

      if (firstFailure) {
        if (firstFailure.label === 'Azure CLI') {
          logger.dim('Install Azure CLI: https://aka.ms/installazurecliwindows');
        } else if (firstFailure.label === 'Azure login') {
          logger.dim('Run `az login` to authenticate with Azure.');
        } else if (firstFailure.label === 'Subscriptions') {
          logger.dim('Run `azc config add-sub prod <subscription-id>` to add an alias.');
        } else if (firstFailure.label === 'Config file') {
          logger.dim('Run any azc command to create the config file.');
        }
      }

      logger.spacer();
    });
};

// Export check functions for testing
module.exports.checkNodeVersion = checkNodeVersion;
module.exports.checkConfigExists = checkConfigExists;
module.exports.checkCacheHealth = checkCacheHealth;
module.exports.checkAzcVersion = checkAzcVersion;
