// logger.js — Chalk-based logging utility for all CLI output.
// Every piece of terminal output flows through here so we can respect
// --quiet (suppress non-essential output), --no-color (strip ANSI codes),
// and --verbose (show debug-level detail for troubleshooting).
// Never use raw console.log anywhere else in the codebase.

const chalk = require('chalk');

// Module-level flags — set once at startup by the CLI entry point.
// We store them here so every call to info/warn/error automatically respects them.
let quietMode = false;
let noColor = false;
let verboseMode = false;

/**
 * Configure the logger. Called once from bin/azc.js after commander parses global flags.
 * @param {object} opts
 * @param {boolean} opts.quiet   - Suppress info/dim/success output (errors and warnings still print)
 * @param {boolean} opts.noColor - Strip chalk colours (useful for piping output to files)
 * @param {boolean} opts.verbose - Show debug-level output (API URLs, cache hits, timing)
 */
function configure(opts = {}) {
  if (opts.quiet) quietMode = true;
  if (opts.verbose) verboseMode = true;
  if (opts.noColor) {
    noColor = true;
    chalk.level = 0;
  }
}

/**
 * Standard informational message — the default "print something" function.
 * Suppressed in quiet mode.
 */
function info(msg) {
  if (quietMode) return;
  process.stdout.write(chalk.white(msg) + '\n');
}

/**
 * Success message in green — used for completed operations and totals.
 * Suppressed in quiet mode.
 */
function success(msg) {
  if (quietMode) return;
  process.stdout.write(chalk.green(msg) + '\n');
}

/**
 * Warning message in yellow — something went wrong but we can continue.
 * Always prints, even in quiet mode (the user needs to see warnings).
 */
function warn(msg) {
  process.stderr.write(chalk.yellow(`⚠ ${msg}`) + '\n');
}

/**
 * Error message in red — something failed and we might need to stop.
 * Always prints, even in quiet mode. Includes an optional error code
 * for easy support triage (e.g. AZC_AUTH_FAILED).
 * @param {string} msg       - Human-readable error description
 * @param {string} [code]    - Machine-readable error code (e.g. 'AZC_AUTH_FAILED')
 */
function error(msg, code) {
  const prefix = code ? chalk.red.bold(`[${code}] `) : chalk.red.bold('Error: ');
  process.stderr.write(prefix + chalk.red(msg) + '\n');
}

/**
 * Dim/muted text — used for secondary information, separators, and hints.
 * Suppressed in quiet mode.
 */
function dim(msg) {
  if (quietMode) return;
  process.stdout.write(chalk.dim(msg) + '\n');
}

/**
 * Debug-level output — only shown when --verbose is set.
 * Used for API URLs, cache hit/miss details, timing info, and internal state.
 * Writes to stderr so it doesn't interfere with JSON piping on stdout.
 * @param {string} msg - Debug message
 */
function debug(msg) {
  if (!verboseMode) return;
  process.stderr.write(chalk.magenta(`[debug] ${msg}`) + '\n');
}

/**
 * Bold header text — used for section titles in scan output.
 * Suppressed in quiet mode.
 */
function header(msg) {
  if (quietMode) return;
  process.stdout.write(chalk.bold.white(msg) + '\n');
}

/**
 * Print a blank line for visual spacing.
 * Suppressed in quiet mode.
 */
function spacer() {
  if (quietMode) return;
  process.stdout.write('\n');
}

/**
 * Raw write — bypasses quiet mode. Used by formatters that handle
 * their own output (e.g. the table formatter writes directly).
 */
function raw(msg) {
  process.stdout.write(msg);
}

module.exports = {
  configure,
  info,
  success,
  warn,
  error,
  dim,
  debug,
  header,
  spacer,
  raw,
};
