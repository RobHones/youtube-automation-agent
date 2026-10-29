const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: flush } = require('node:timers/promises');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'utils', 'subscription-text.js');
const TIMEOUT_MS = 50;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function cursorHarness(t, create) {
  let source = fs.readFileSync(sourcePath, 'utf8');
  const timeoutDeclaration = 'const SUBSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;';
  const sdkImport = "sdk = await import('@cursor/sdk');";
  assert.ok(source.includes(timeoutDeclaration), 'The test must replace the production deadline');
  assert.ok(source.includes(sdkImport), 'The test must replace the real SDK import');
  source = source
    .replace(timeoutDeclaration, `const SUBSCRIPTION_TIMEOUT_MS = ${TIMEOUT_MS};`)
    .replace(sdkImport, 'sdk = globalThis.cursorSdk;');
  source += '\nmodule.exports.generateCursorText = generateCursorText;';

  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const directories = [];
  const warnings = [];
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === 'cross-spawn') return () => assert.fail('A Cursor test must not start a CLI');
      assert.ok(['fs', 'os', 'path'].includes(name), `Unexpected runtime dependency: ${name}`);
      return require(name);
    },
    // The SDK is mocked, so these tests also run on the project's Node 20 CI.
    process: { versions: { node: '22.13.0' }, env: {}, platform: process.platform },
    Symbol,
    Buffer,
    Date: class extends Date {
      static now() { return now; }
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    cursorSdk: {
      Agent: {
        create(options) {
          directories.push(options.local.cwd);
          return create(options);
        },
      },
    },
  };
  vm.runInNewContext(source, context, { filename: sourcePath });

  t.after(() => {
    for (const directory of directories) {
      // Only remove directories created by this test's real scratchDir call.
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
      assert.match(relative, /^youtube-automation-agent-cursor-[^\\/]+$/);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  return {
    generate: () => context.module.exports.generateCursorText({
      apiKey: 'test-key',
      model: 'composer-2.5',
      runtime: 'local',
      prompt: 'Reply with READY.',
      logger: { info() {}, warn(message) { warnings.push(message); } },
    }),
    async advance(milliseconds) {
      now += milliseconds;
      for (;;) {
        const due = [...timers].find(([, timer]) => timer.due <= now);
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
    },
    directories,
    warnings,
    assertClean() {
      for (const directory of directories) assert.equal(fs.existsSync(directory), false);
      assert.equal(timers.size, 0, 'All Cursor deadline and cleanup timers must be cleared');
    },
  };
}

test('Cursor returns its response when disposal fails and removes its scratch directory', async t => {
  let disposed = 0;
  const harness = cursorHarness(t, async () => ({
    agentId: 'test-agent',
    send: async () => ({
      id: 'test-run',
      status: 'finished',
      wait: async () => ({ status: 'finished', result: 'READY' }),
    }),
    async [Symbol.asyncDispose]() {
      disposed += 1;
      throw new Error('Disposal failed');
    },
  }));

  assert.equal(await harness.generate(), 'READY');
  assert.equal(disposed, 1);
  assert.ok(harness.warnings.some(message => message.includes('Disposal failed')));
  harness.assertClean();
});

test('Cursor cancels and disposes a run that exceeds its deadline', async t => {
  let cancelled = 0;
  let disposed = 0;
  const run = {
    id: 'test-run',
    status: 'running',
    wait: () => new Promise(() => {}),
    async cancel() {
      cancelled += 1;
      run.status = 'cancelled';
    },
  };
  const harness = cursorHarness(t, async () => ({
    agentId: 'test-agent',
    send: async () => run,
    async [Symbol.asyncDispose]() { disposed += 1; },
  }));
  const rejection = assert.rejects(harness.generate(), /Cursor timed out after 50ms/);
  await flush();
  assert.equal(fs.existsSync(harness.directories[0]), true);

  await harness.advance(TIMEOUT_MS);
  await rejection;

  assert.equal(cancelled, 1);
  assert.equal(disposed, 1);
  harness.assertClean();
});

test('Cursor disposes a late-created agent and removes any late scratch files', async t => {
  const creation = deferred();
  let disposed = 0;
  const harness = cursorHarness(t, () => creation.promise);
  const rejection = assert.rejects(harness.generate(), /Cursor timed out after 50ms/);
  await flush();

  await harness.advance(TIMEOUT_MS);
  await rejection;
  harness.assertClean();

  // Model SDK initialization can finish after the timeout and write again.
  const directory = harness.directories[0];
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'late-state.json'), '{}');
  creation.resolve({ async [Symbol.asyncDispose]() { disposed += 1; } });
  await flush();

  assert.equal(disposed, 1);
  harness.assertClean();
});

test('Cursor cancels a late-submitted run and removes its late scratch files', async t => {
  const submission = deferred();
  let cancelled = 0;
  let disposed = 0;
  const harness = cursorHarness(t, async () => ({
    send: () => submission.promise,
    async [Symbol.asyncDispose]() { disposed += 1; },
  }));
  const rejection = assert.rejects(harness.generate(), /Cursor timed out after 50ms/);
  await flush();

  await harness.advance(TIMEOUT_MS);
  await rejection;
  assert.equal(disposed, 1);
  harness.assertClean();

  const directory = harness.directories[0];
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'late-state.json'), '{}');
  submission.resolve({ async cancel() { cancelled += 1; } });
  await flush();

  assert.equal(cancelled, 1);
  assert.equal(disposed, 1);
  harness.assertClean();
});

test('Cursor preserves startup failures and cleans scratch files when no agent is created', async t => {
  const harness = cursorHarness(t, async () => {
    throw new Error('Subscription authentication failed');
  });

  await assert.rejects(harness.generate(), /Subscription authentication failed/);
  harness.assertClean();
});
