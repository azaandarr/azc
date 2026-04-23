// config.js — Read/write the user's azc configuration at ~/.azc/config.json.
// On first run, this module creates the config directory and writes sensible
// defaults so the user has something to start with. Subsequent calls read
// from the cached in-memory copy unless forceReload is set.

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');

// The root config directory — all azc state lives under ~/.azc/
const AZC_HOME = path.join(os.homedir(), '.azc');
const CONFIG_PATH = path.join(AZC_HOME, 'config.json');
const CACHE_DIR = path.join(AZC_HOME, 'cache');
const ESTIMATES_DIR = path.join(AZC_HOME, 'estimates');

// Default configuration written on first run.
// Users can override any of these in ~/.azc/config.json.
const DEFAULT_CONFIG = {
  defaults: {
    region: 'uksouth',
    currency: 'GBP',
    os: 'linux',
    format: 'table',
  },
  subscriptions: {},
};

// In-memory cache of the loaded config — avoids re-reading the file
// on every call within the same CLI invocation.
let cachedConfig = null;

/**
 * Ensure a directory exists, creating it (and parents) if needed.
 * Uses recursive:true so we don't need to check each level.
 * @param {string} dirPath - Absolute path to the directory
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Initialise the ~/.azc/ directory structure on first run.
 * Creates config.json with defaults and the cache/estimates subdirectories.
 * Only runs if ~/.azc/config.json doesn't exist yet.
 */
function initConfigDir() {
  ensureDir(AZC_HOME);
  ensureDir(CACHE_DIR);
  ensureDir(ESTIMATES_DIR);

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');

    // First-run welcome box
    const lines = [
      '  Welcome to azc — Azure costing from your terminal.  ',
      '',
      '  Quick start:',
      '    azc price "app service p1v3"    price lookup',
      '    azc plan --interactive          build an estimate',
      '    azc scan -s <sub-id>            scan a subscription',
      '',
      `  Config saved to ${CONFIG_PATH}`,
    ];
    const width = Math.max(...lines.map((l) => l.length)) + 2;
    logger.raw('\n');
    logger.raw('  ┌' + '─'.repeat(width) + '┐\n');
    for (const line of lines) {
      logger.raw('  │' + line.padEnd(width) + '│\n');
    }
    logger.raw('  └' + '─'.repeat(width) + '┘\n');
    logger.raw('\n');
  }
}

/**
 * Load the config from disk. Initialises the config directory if it
 * doesn't exist yet (first run behaviour).
 * @param {boolean} [forceReload=false] - Skip the in-memory cache and re-read from disk
 * @returns {object} The parsed config object
 */
function loadConfig(forceReload = false) {
  if (cachedConfig && !forceReload) return cachedConfig;

  // Make sure the directory and default file exist
  initConfigDir();

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cachedConfig = JSON.parse(raw);
  } catch (err) {
    // If the file is corrupted or unreadable, fall back to defaults
    // and warn the user so they can fix it.
    logger.warn(`Could not read config at ${CONFIG_PATH}: ${err.message}`);
    logger.warn('Using default configuration. Delete the file and restart to regenerate it.');
    cachedConfig = { ...DEFAULT_CONFIG };
  }

  return cachedConfig;
}

/**
 * Write the current config object back to disk.
 * Always pretty-prints with 2-space indentation for easy manual editing.
 * @param {object} config - The config object to save
 */
function saveConfig(config) {
  ensureDir(AZC_HOME);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  cachedConfig = config;
}

/**
 * Get a specific default value from the config.
 * Falls back to the hardcoded default if the key is missing.
 * @param {string} key - The default key (e.g. 'region', 'currency', 'os', 'format')
 * @returns {string} The configured default value
 */
function getDefault(key) {
  const config = loadConfig();
  return (config.defaults && config.defaults[key]) || DEFAULT_CONFIG.defaults[key];
}

/**
 * Resolve a subscription name-or-id to an actual subscription ID.
 * If the input matches a friendly name in config.subscriptions, return
 * the associated GUID. Otherwise, assume it's already a GUID and pass
 * it through unchanged.
 * @param {string} nameOrId - Friendly name or subscription GUID
 * @returns {string} The resolved subscription ID
 */
function resolveSubscription(nameOrId) {
  const config = loadConfig();
  const subs = config.subscriptions || {};

  // Check if the input matches a friendly name (case-insensitive)
  const lowerInput = nameOrId.toLowerCase();
  for (const [name, id] of Object.entries(subs)) {
    if (name.toLowerCase() === lowerInput) return id;
  }

  // Not a known alias — assume it's a raw subscription GUID
  return nameOrId;
}

module.exports = {
  loadConfig,
  saveConfig,
  getDefault,
  resolveSubscription,
  initConfigDir,
  // Export paths so other modules (cache, estimates) can find the directories
  AZC_HOME,
  CONFIG_PATH,
  CACHE_DIR,
  ESTIMATES_DIR,
};
