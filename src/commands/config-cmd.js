// config-cmd.js — `azc config` command.
// View and modify ~/.azc/config.json from the terminal.
// Supports viewing all settings, getting/setting individual values,
// and managing subscription aliases.

const logger = require('../utils/logger');
const { loadConfig, saveConfig, CONFIG_PATH } = require('../config/config');
const { formatMoney } = require('../utils/currency');

/**
 * Register the config command on the parent commander program.
 * @param {import('commander').Command} program
 */
module.exports = function registerConfigCommand(program) {
  const cmd = program
    .command('config')
    .description('View or modify azc configuration');

  // ── azc config show ─────────────────────────────────────────────
  cmd
    .command('show', { isDefault: true })
    .description('Show all current configuration')
    .action(() => {
      const config = loadConfig(true);
      logger.header('azc configuration');
      logger.dim(CONFIG_PATH);
      logger.spacer();

      // Defaults section
      logger.info('Defaults:');
      const defaults = config.defaults || {};
      for (const [key, value] of Object.entries(defaults)) {
        logger.info(`  ${key}: ${value}`);
      }

      // Subscriptions section
      logger.spacer();
      logger.info('Subscription aliases:');
      const subs = config.subscriptions || {};
      const subEntries = Object.entries(subs);
      if (subEntries.length === 0) {
        logger.dim('  (none configured)');
      } else {
        for (const [name, id] of subEntries) {
          logger.info(`  ${name}: ${id}`);
        }
      }

      logger.spacer();
      logger.dim(`Edit directly: ${CONFIG_PATH}`);
    });

  // ── azc config get <key> ────────────────────────────────────────
  cmd
    .command('get <key>')
    .description('Get a config value (e.g. "region", "currency")')
    .action((key) => {
      const config = loadConfig(true);
      const defaults = config.defaults || {};

      if (key in defaults) {
        logger.info(defaults[key]);
      } else if (key === 'subscriptions') {
        const subs = config.subscriptions || {};
        for (const [name, id] of Object.entries(subs)) {
          logger.info(`${name}: ${id}`);
        }
      } else {
        logger.warn(`Unknown config key: ${key}`);
        logger.dim('Available keys: region, currency, os, format, subscriptions');
      }
    });

  // ── azc config set <key> <value> ────────────────────────────────
  cmd
    .command('set <key> <value>')
    .description('Set a default value (e.g. "region uksouth", "currency USD")')
    .action((key, value) => {
      const config = loadConfig(true);

      const validKeys = ['region', 'currency', 'os', 'format'];
      if (!validKeys.includes(key)) {
        logger.error(
          `Invalid config key: "${key}"\n  Valid keys: ${validKeys.join(', ')}`,
          'AZC_INVALID_KEY'
        );
        process.exit(1);
      }

      // Validate specific values
      if (key === 'currency' && !['GBP', 'USD', 'EUR'].includes(value.toUpperCase())) {
        logger.error('Currency must be GBP, USD, or EUR', 'AZC_INVALID_VALUE');
        process.exit(1);
      }
      if (key === 'os' && !['linux', 'windows'].includes(value.toLowerCase())) {
        logger.error('OS must be linux or windows', 'AZC_INVALID_VALUE');
        process.exit(1);
      }
      if (key === 'format' && !['table', 'json'].includes(value.toLowerCase())) {
        logger.error('Format must be table or json', 'AZC_INVALID_VALUE');
        process.exit(1);
      }

      if (!config.defaults) config.defaults = {};
      config.defaults[key] = key === 'currency' ? value.toUpperCase() : value.toLowerCase();
      saveConfig(config);
      logger.success(`Set ${key} = ${config.defaults[key]}`);
    });

  // ── azc config add-sub <name> <id> ─────────────────────────────
  cmd
    .command('add-sub <name> <subscription-id>')
    .description('Add a subscription alias (e.g. "prod xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")')
    .action((name, id) => {
      // Basic GUID validation
      const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!guidPattern.test(id)) {
        logger.error(
          `"${id}" doesn't look like a subscription GUID.\n  Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
          'AZC_INVALID_GUID'
        );
        process.exit(1);
      }

      const config = loadConfig(true);
      if (!config.subscriptions) config.subscriptions = {};
      config.subscriptions[name] = id;
      saveConfig(config);
      logger.success(`Added subscription alias: ${name} → ${id}`);
      logger.dim(`Now you can use: azc scan -s ${name}`);
    });

  // ── azc config remove-sub <name> ───────────────────────────────
  cmd
    .command('remove-sub <name>')
    .description('Remove a subscription alias')
    .action((name) => {
      const config = loadConfig(true);
      if (!config.subscriptions || !(name in config.subscriptions)) {
        logger.warn(`No subscription alias named "${name}"`);
        return;
      }

      delete config.subscriptions[name];
      saveConfig(config);
      logger.success(`Removed subscription alias: ${name}`);
    });

  // ── azc config path ────────────────────────────────────────────
  cmd
    .command('path')
    .description('Print the config file path')
    .action(() => {
      logger.info(CONFIG_PATH);
    });
};
