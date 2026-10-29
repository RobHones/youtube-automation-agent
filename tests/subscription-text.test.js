const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { setImmediate, setTimeout, clearTimeout } = require('node:timers');
const vm = require('node:vm');
const realSpawn = require('cross-spawn');

const sourcePath = path.join(__dirname, '..', 'utils', 'subscription-text.js');
const localRequire = createRequire(sourcePath);
const source = fs.readFileSync(sourcePath, 'utf8');

// Load the production implementation with isolated env and process boundaries.
// Private helpers are exported only inside this test's VM, not in the app API.
function loadRunner({ spawn = realSpawn, env = {}, platform = process.platform, kill = process.kill.bind(process) } = {}) {
  const sandbox = {
    module: { exports: {} },
    require: name => name === 'cross-spawn' ? spawn : localRequire(name),
    process: { env, platform, versions: process.versions, kill },
    Buffer,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(`${source}\nmodule.exports.__test = { spawnCommand };`, sandbox, { filename: sourcePath });
  return sandbox.module.exports;
}

function mockSpawn(respond) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 41000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const input = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) { input.push(Buffer.from(chunk)); done(); } });
    child.kill = () => { child.killed = true; return true; };
    const call = { command, args, options, child };
    calls.push(call);
    setImmediate(async () => {
      try {
        const result = await respond({ ...call, input: Buffer.concat(input).toString('utf8') });
        if (!result) return; // Keep a process open for timeout and output-limit tests.
        child.stdout.end(result.stdout || '');
        child.stderr.end(result.stderr || '');
        child.emit('close', result.code ?? 0);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

function assertCleaned(calls) {
  for (const { options } of calls) {
    if (options.cwd) assert.equal(fs.existsSync(options.cwd), false, 'scratch directory was not cleaned');
  }
}

test('parallel Codex requests use separate result files and clean both scratch directories', async () => {
  const execCalls = [];
  const spawn = mockSpawn(async call => {
    assert.equal(call.command, 'codex');
    if (call.args[0] === 'login') return { stderr: 'Logged in using ChatGPT\n' };
    execCalls.push(call);
    const reply = call.input.includes('first request') ? 'FIRST' : 'SECOND';
    await new Promise(resolve => setTimeout(resolve, reply === 'FIRST' ? 25 : 5));
    const outputPath = call.args[call.args.indexOf('--output-last-message') + 1];
    fs.writeFileSync(outputPath, ` ${reply}\n`);
    return { stdout: 'CLI progress is not the final answer' };
  });
  const runner = loadRunner({ spawn });
  const subscription = { id: 'chatgpt', model: 'gpt-test', runtime: 'local' };
  const replies = await Promise.all([
    runner.generateSubscriptionText(subscription, 'first request'),
    runner.generateSubscriptionText(subscription, 'second request'),
  ]);
  assert.deepEqual(replies, ['FIRST', 'SECOND']);
  assert.equal(execCalls.length, 2);
  assert.notEqual(execCalls[0].options.cwd, execCalls[1].options.cwd);
  assertCleaned(spawn.calls);
});

test('Codex cleans scratch files after execution errors and missing final messages', async t => {
  for (const failure of ['exec-error', 'missing-message', 'empty-message']) {
    await t.test(failure, async () => {
      const spawn = mockSpawn(call => {
        if (call.args[0] === 'login') return { stderr: 'Logged in using ChatGPT' };
        if (failure === 'exec-error') return { code: 1, stderr: 'model is unavailable' };
        if (failure === 'empty-message') {
          fs.writeFileSync(call.args[call.args.indexOf('--output-last-message') + 1], ' \n');
        }
        return {};
      });
      const runner = loadRunner({ spawn });
      await assert.rejects(
        runner.generateSubscriptionText({ id: 'chatgpt', model: 'gpt-test' }, 'test'),
        failure === 'exec-error' ? /model is unavailable/ : failure === 'missing-message' ? /without a final message/ : /empty response/
      );
      assertCleaned(spawn.calls);
    });
  }
});

test('Codex rejects an API-key CLI login before starting generation', async () => {
  const spawn = mockSpawn(() => ({ stderr: 'Logged in using an API key - sk-test' }));
  const runner = loadRunner({ spawn });
  await assert.rejects(
    runner.generateSubscriptionText({ id: 'chatgpt', model: 'gpt-test' }, 'test'),
    /ChatGPT subscription authentication is required/
  );
  assert.equal(spawn.calls.length, 1);
  assert.deepEqual(Array.from(spawn.calls[0].args), ['login', 'status']);
  assertCleaned(spawn.calls);
});

test('a missing model remains a provider error instead of a missing CLI diagnostic', async () => {
  const spawn = mockSpawn(call => call.args[0] === 'login'
    ? { stderr: 'Logged in using ChatGPT' }
    : { code: 1, stderr: 'Requested model was not found' });
  const runner = loadRunner({ spawn });
  await assert.rejects(
    runner.generateSubscriptionText({ id: 'chatgpt', model: 'missing-model' }, 'test'),
    error => error.message === 'Requested model was not found'
  );
  assertCleaned(spawn.calls);
});

test('Codex strips API credentials and endpoint overrides without changing the parent environment', async () => {
  const env = {
    OPENAI_API_KEY: 'api-key', CODEX_API_KEY: 'codex-key', OPENAI_BASE_URL: 'https://override.invalid',
    openai_api_key: 'case-insensitive-key', CODEX_HOME: 'test-home', PATH: 'test-path',
  };
  const before = { ...env };
  const spawn = mockSpawn(call => {
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'openai_api_key']) {
      assert.equal(call.options.env[key], undefined);
    }
    assert.equal(call.options.env.CODEX_HOME, 'test-home');
    assert.equal(call.options.env.PATH, 'test-path');
    if (call.args[0] === 'login') return { stderr: 'Logged in using ChatGPT' };
    fs.writeFileSync(call.args[call.args.indexOf('--output-last-message') + 1], 'READY');
    return {};
  });
  const runner = loadRunner({ spawn, env });
  assert.equal(await runner.generateSubscriptionText({ id: 'chatgpt', model: 'gpt-test' }, 'test'), 'READY');
  assert.deepEqual(env, before);
  assertCleaned(spawn.calls);
});

test('Claude permits only subscription authentication methods', async t => {
  for (const authMethod of ['claude.ai', 'oauth_token', 'api_key', 'console', 'none']) {
    await t.test(authMethod, async () => {
      const spawn = mockSpawn(call => call.args[0] === 'auth'
        ? { stdout: JSON.stringify({ authMethod }) }
        : { stdout: ' READY \n' });
      const runner = loadRunner({ spawn });
      const request = runner.generateSubscriptionText({ id: 'claude', model: 'sonnet' }, 'test');
      if (['claude.ai', 'oauth_token'].includes(authMethod)) {
        assert.equal(await request, 'READY');
        assert.equal(spawn.calls.length, 2);
      } else {
        await assert.rejects(request, /Claude subscription authentication is required/);
        assert.equal(spawn.calls.length, 1);
      }
      assertCleaned(spawn.calls);
    });
  }
});

test('Claude strips API tokens and provider routing variables while preserving subscription login', async () => {
  const stripped = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_AWS_WORKSPACE_ID',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX',
  ];
  const env = Object.fromEntries(stripped.map(key => [key, 'API-routing-value']));
  env.CLAUDE_CODE_OAUTH_TOKEN = 'subscription-token';
  env.PATH = 'test-path';
  const before = { ...env };
  const spawn = mockSpawn(call => {
    for (const key of stripped) assert.equal(call.options.env[key], undefined);
    assert.equal(call.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-token');
    assert.equal(call.options.env.PATH, 'test-path');
    return call.args[0] === 'auth' ? { stdout: '{"authMethod":"oauth_token"}' } : { stdout: 'READY' };
  });
  const runner = loadRunner({ spawn, env });
  assert.equal(await runner.generateSubscriptionText({ id: 'claude', model: 'sonnet' }, 'test'), 'READY');
  assert.deepEqual(env, before);
  assertCleaned(spawn.calls);
});

test('an early child exit preserves CLI diagnostics when stdin closes during a large prompt', async () => {
  const runner = loadRunner();
  const result = await runner.__test.spawnCommand(process.execPath, [
    '-e', 'process.stdin.destroy(); process.stderr.write("early CLI diagnostic"); process.exit(2);',
  ], { env: { ...process.env }, input: Buffer.alloc(2 * 1024 * 1024, 'x'), timeoutMs: 5000 });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /early CLI diagnostic/);
});

test('EPIPE while writing stdin does not become an uncaught error', async () => {
  const spawn = mockSpawn(call => {
    const error = new Error('broken pipe');
    error.code = 'EPIPE';
    call.child.stdin.emit('error', error);
    return { code: 2, stderr: 'authentication failed' };
  });
  const runner = loadRunner({ spawn });
  const result = await runner.__test.spawnCommand('mock-cli', [], { input: 'prompt' });
  assert.equal(result.code, 2);
  assert.equal(result.stderr, 'authentication failed');
});

test('a timeout terminates the Windows CLI process tree', async () => {
  const spawn = mockSpawn(call => /taskkill\.exe$/i.test(call.command) ? {} : null);
  const runner = loadRunner({ spawn, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  await assert.rejects(runner.__test.spawnCommand('mock-cli', [], { timeoutMs: 15 }), /timed out after 15ms/);
  assert.equal(spawn.calls.length, 2);
  assert.deepEqual(Array.from(spawn.calls[1].args), ['/pid', String(spawn.calls[0].child.pid), '/T', '/F']);
  assert.equal(spawn.calls[1].options.windowsHide, true);
  assert.equal(spawn.calls[1].options.stdio, 'ignore');
});

test('a timeout terminates the POSIX process group', async () => {
  const spawn = mockSpawn(() => null);
  const killed = [];
  const runner = loadRunner({ spawn, platform: 'linux', kill: (pid, signal) => killed.push({ pid, signal }) });
  await assert.rejects(runner.__test.spawnCommand('mock-cli', [], { timeoutMs: 15 }), /timed out after 15ms/);
  assert.deepEqual(killed, [{ pid: -spawn.calls[0].child.pid, signal: 'SIGKILL' }]);
  assert.equal(spawn.calls[0].options.detached, true);
});

test('a failed Windows taskkill falls back to killing the child and preserves the timeout', async () => {
  const spawn = mockSpawn(call => /taskkill\.exe$/i.test(call.command) ? { code: 1 } : null);
  const runner = loadRunner({ spawn, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  await assert.rejects(runner.__test.spawnCommand('mock-cli', [], { timeoutMs: 15 }), /timed out after 15ms/);
  assert.equal(spawn.calls.length, 2);
  assert.equal(spawn.calls[0].child.killed, true);
});

test('combined stdout and stderr are bounded and excess output terminates the process tree', async () => {
  const killed = [];
  const spawn = mockSpawn(call => {
    call.child.stdout.write(Buffer.alloc(4 * 1024 * 1024));
    call.child.stderr.write(Buffer.alloc(4 * 1024 * 1024 + 1));
    return null;
  });
  const runner = loadRunner({ spawn, platform: 'linux', kill: (pid, signal) => killed.push({ pid, signal }) });
  await assert.rejects(runner.__test.spawnCommand('mock-cli', [], { timeoutMs: 5000 }), /8 MiB output limit/);
  assert.deepEqual(killed, [{ pid: -spawn.calls[0].child.pid, signal: 'SIGKILL' }]);
});
