// spinner.js — Lightweight CLI spinner for async operations.
// Shows a rotating animation with a message so the user knows
// the tool hasn't frozen during network calls. Also supports
// progress-style updates like "[3/15] Pricing microsoft.cache/redis..."

const chalk = require('chalk');

// Braille-dot spinner frames — smooth animation, widely supported in terminals.
// Each frame is a single character that cycles to create a spinning effect.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// How fast the spinner rotates (milliseconds between frame changes)
const INTERVAL_MS = 80;

/**
 * Create a new spinner instance.
 * Usage:
 *   const s = createSpinner('Authenticating...');
 *   s.start();
 *   // ... do async work ...
 *   s.update('Querying resources...');
 *   // ... more work ...
 *   s.stop('Done!');
 *
 * @param {string} initialMessage - The text to show next to the spinner
 * @returns {object} Spinner with start(), update(), stop(), and progress() methods
 */
function createSpinner(initialMessage = '') {
  let frameIndex = 0;
  let message = initialMessage;
  let timer = null;
  let stopped = false;

  // Render the current frame + message, overwriting the previous line.
  // We use \r to return to the start of the line and clear any leftover
  // characters from a longer previous message.
  function render() {
    const frame = chalk.cyan(FRAMES[frameIndex]);
    // Clear the line and write the current frame
    process.stderr.write(`\r\x1b[K${frame} ${chalk.dim(message)}`);
    frameIndex = (frameIndex + 1) % FRAMES.length;
  }

  return {
    /**
     * Start the spinner animation. Call this before your async operation.
     */
    start() {
      if (timer || stopped) return;
      render();
      timer = setInterval(render, INTERVAL_MS);
    },

    /**
     * Update the spinner message without stopping it.
     * @param {string} newMessage - New text to display
     */
    update(newMessage) {
      message = newMessage;
    },

    /**
     * Show progress as a visual bar: [████░░░░] 3/10  message
     * @param {number} current - Current item number
     * @param {number} total   - Total items
     * @param {string} msg     - Description of current item
     */
    progress(current, total, msg) {
      const barWidth = 16;
      const filled = Math.round((current / total) * barWidth);
      const empty = barWidth - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      message = `[${bar}] ${current}/${total}  ${msg}`;
    },

    /**
     * Stop the spinner and print a final message on its own line.
     * @param {string} [finalMessage] - Optional completion message (printed in green)
     */
    stop(finalMessage) {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Clear the spinner line
      process.stderr.write('\r\x1b[K');
      if (finalMessage) {
        process.stderr.write(chalk.green(`✔ ${finalMessage}`) + '\n');
      }
    },

    /**
     * Stop the spinner and print a failure message.
     * @param {string} [failMessage] - Optional failure message (printed in red)
     */
    fail(failMessage) {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stderr.write('\r\x1b[K');
      if (failMessage) {
        process.stderr.write(chalk.red(`✖ ${failMessage}`) + '\n');
      }
    },
  };
}

module.exports = { createSpinner };
