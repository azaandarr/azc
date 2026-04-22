#!/usr/bin/env node

// azc.js — Entry point for the Azure Costing CLI.
// This file wires up commander with all commands and global flags,
// configures the logger, and handles graceful shutdown on SIGINT.

const { Command } = require('commander');
const logger = require('../src/utils/logger');
const pkg = require('../package.json');

// ─── Graceful shutdown ──────────────────────────────────────────────
// Catch Ctrl+C so we print a clean exit instead of a raw stack trace.
// This also prevents partial cache writes from corrupting files.
process.on('SIGINT', () => {
  logger.spacer();
  logger.dim('Interrupted — exiting cleanly.');
  process.exit(0);
});

// Catch unhandled promise rejections globally so they surface as
// readable errors instead of silent swallowed failures.
process.on('unhandledRejection', (err) => {
  logger.error(
    `Unexpected error: ${err.message || err}\nThis is likely a bug in azc. Please report it.`,
    'AZC_UNHANDLED'
  );
  process.exit(1);
});

// ─── Commander setup ────────────────────────────────────────────────
const program = new Command();

program
  .name('azc')
  .description('Azure Costing CLI — fast, terminal-native Azure cost estimation')
  .version(pkg.version, '-v, --version', 'Print the current azc version')

  // Global flags available to every command
  .option('-q, --quiet', 'Suppress non-essential output')
  .option('--no-color', 'Disable coloured output (useful when piping to a file)')
  .option('--verbose', 'Show debug-level output for troubleshooting');

// ─── Pre-action hook ────────────────────────────────────────────────
// Runs before every command to configure the logger with global flags.
// This way individual commands never need to think about --quiet or --no-color.
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();
  logger.configure({
    quiet: opts.quiet,
    noColor: opts.color === false,
    verbose: opts.verbose,
  });
});

// ─── Register commands ──────────────────────────────────────────────
require('../src/commands/scan')(program);
require('../src/commands/price')(program);
require('../src/commands/compare')(program);
require('../src/commands/plan')(program);
require('../src/commands/config-cmd')(program);

// ─── Parse and run ──────────────────────────────────────────────────
// parseAsync() handles the async action handlers in our commands.
// If no command is given, commander prints the help text automatically.
program.parseAsync(process.argv).catch((err) => {
  logger.error(err.message, 'AZC_FATAL');
  process.exit(1);
});
