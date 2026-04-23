const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { checkNodeVersion, checkAzcVersion, checkConfigExists, checkCacheHealth } = require('../src/commands/doctor');

describe('doctor checks', () => {
  it('checkNodeVersion returns ok for current Node', () => {
    const result = checkNodeVersion();
    const major = parseInt(process.version.slice(1).split('.')[0], 10);
    assert.equal(result.ok, major >= 20);
    assert.equal(result.label, 'Node.js');
    assert.ok(result.detail.includes(process.version));
  });

  it('checkAzcVersion returns ok with version string', () => {
    const result = checkAzcVersion();
    assert.equal(result.ok, true);
    assert.equal(result.label, 'azc version');
    assert.ok(result.detail.length > 0);
  });

  it('checkConfigExists reflects whether config file exists', () => {
    const result = checkConfigExists();
    assert.equal(result.label, 'Config file');
    assert.equal(typeof result.ok, 'boolean');
  });

  it('checkCacheHealth handles nonexistent cache dir', () => {
    const fakeDir = path.join(os.tmpdir(), `azc-test-cache-${Date.now()}`);
    const result = checkCacheHealth(fakeDir);
    assert.equal(result.ok, true);
    assert.equal(result.label, 'Price cache');
    assert.ok(result.detail.includes('no cache'));
  });

  it('checkCacheHealth counts files in cache dir', () => {
    const tmpDir = path.join(os.tmpdir(), `azc-test-cache-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'test1.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'test2.json'), '{}');

    const result = checkCacheHealth(tmpDir);
    assert.equal(result.ok, true);
    assert.ok(result.detail.includes('2 entries'));

    fs.rmSync(tmpDir, { recursive: true });
  });
});
