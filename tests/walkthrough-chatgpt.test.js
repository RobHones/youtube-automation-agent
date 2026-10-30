const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { setImmediate, setTimeout, clearTimeout } = require('node:timers');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const runnerPath = path.join(root, 'utils', 'subscription-text.js');
const walkthroughPath = path.join(root, 'walkthrough.js');

function mockSpawn(respond) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 42000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.kill = () => true;
    const call = { command, args, options, child };
    calls.push(call);
    setImmediate(async () => {
      try {
        const result = await respond(call);
        if (!result) return;
        child.stdout.end(result.stdout || '');
        child.stderr.end(result.stderr || '');
        child.emit('close', result.code === undefined ? 0 : result.code);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

function loadConnector(spawn, env = {}, platform = process.platform, kill = () => assert.fail('Unexpected process kill')) {
  const localRequire = createRequire(runnerPath);
  const sandbox = {
    module: { exports: {} },
    require: name => name === 'cross-spawn' ? spawn : localRequire(name),
    process: { env, platform, versions: process.versions, kill },
    Buffer,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(runnerPath, 'utf8'), sandbox, { filename: runnerPath });
  return sandbox.module.exports.connectChatGPTSubscription;
}

function assertCleaned(calls) {
  for (const { options } of calls) {
    assert.equal(fs.existsSync(options.cwd), false, 'login scratch directory was not cleaned');
  }
}

test('ChatGPT connection reuses the existing subscription login without starting sign-in', async () => {
  const spawn = mockSpawn(() => ({ stderr: 'Logged in using ChatGPT\n' }));
  const connect = loadConnector(spawn);
  const result = await connect({ onOutput: () => assert.fail('Existing login should not open sign-in') });
  assert.equal(result.reused, true);
  assert.equal(spawn.calls.length, 1);
  assert.deepEqual(Array.from(spawn.calls[0].args), ['login', 'status']);
  assertCleaned(spawn.calls);
});

test('signed-out and API-key logins start browser sign-in and verify the resulting subscription', async t => {
  for (const prior of ['signed-out', 'api-key']) {
    await t.test(prior, async () => {
      let statuses = 0;
      const spawn = mockSpawn(call => {
        assert.equal(call.command, 'codex');
        if (call.args.length === 1) {
          assert.deepEqual(Array.from(call.args), ['login']);
          return {
            stdout: 'Open this sign-in URL: https://auth.openai.com/authorize?test=true\n',
            stderr: 'Waiting for browser authentication...\n',
          };
        }
        statuses += 1;
        return statuses === 1
          ? prior === 'signed-out'
            ? { code: 1, stderr: 'Not logged in' }
            : { stderr: 'Logged in using an API key - sk-test' }
          : { stderr: 'Logged in using ChatGPT' };
      });
      const env = {
        OPENAI_API_KEY: 'api-test', CODEX_API_KEY: 'codex-test', OPENAI_BASE_URL: 'https://invalid.test',
        CODEX_HOME: 'test-home', PATH: 'test-path',
      };
      const before = { ...env };
      const output = [];
      const result = await loadConnector(spawn, env)({ onOutput: value => output.push(value) });
      assert.equal(result.reused, false);
      assert.deepEqual(spawn.calls.map(call => Array.from(call.args)), [['login', 'status'], ['login'], ['login', 'status']]);
      assert.match(output.join(''), /https:\/\/auth\.openai\.com\/authorize\?test=true/);
      assert.match(output.join(''), /Waiting for browser authentication/);
      for (const call of spawn.calls) {
        assert.equal(call.options.env.OPENAI_API_KEY, undefined);
        assert.equal(call.options.env.CODEX_API_KEY, undefined);
        assert.equal(call.options.env.OPENAI_BASE_URL, undefined);
        assert.equal(call.options.env.CODEX_HOME, 'test-home');
        assert.equal(call.options.env.PATH, 'test-path');
        assert.equal(call.options.windowsHide, true);
      }
      assert.deepEqual(env, before);
      assertCleaned(spawn.calls);
    });
  }
});

test('missing Codex CLI gives installation guidance and cleans the login scratch directory', async () => {
  const spawn = mockSpawn(() => {
    const error = new Error('spawn codex ENOENT');
    error.code = 'ENOENT';
    throw error;
  });
  await assert.rejects(loadConnector(spawn)(), /Install it with npm install -g @openai\/codex/);
  assert.equal(spawn.calls.length, 1);
  assertCleaned(spawn.calls);
});

test('failed or cancelled browser sign-in never reports a successful connection', async t => {
  for (const failure of [
    { code: 1, stderr: 'Browser sign-in failed' },
    { code: null, stderr: 'Sign-in cancelled', signal: 'SIGINT' },
  ]) {
    await t.test(failure.stderr, async () => {
      const spawn = mockSpawn(call => call.args.length === 1
        ? failure
        : { code: 1, stderr: 'Not logged in' });
      await assert.rejects(loadConnector(spawn)(), /failed|cancelled|not completed/i);
      assert.ok(spawn.calls.length >= 2);
      assertCleaned(spawn.calls);
    });
  }
});

test('a successful login command must be followed by verified ChatGPT authentication', async () => {
  const spawn = mockSpawn(call => call.args.length === 1
    ? { stdout: 'Sign-in completed' }
    : { stderr: 'Logged in using an API key' });
  await assert.rejects(loadConnector(spawn)(), /ChatGPT sign-in was not completed/);
  assert.equal(spawn.calls.length, 3);
  assertCleaned(spawn.calls);
});

test('cancelling pending browser sign-in terminates the process group and cleans up', async () => {
  const controller = new AbortController();
  const killed = [];
  const spawn = mockSpawn(call => {
    if (call.args.length === 1) {
      controller.abort();
      return null;
    }
    return { code: 1, stderr: 'Not logged in' };
  });
  const connect = loadConnector(spawn, {}, 'linux', (pid, signal) => killed.push({ pid, signal }));
  await assert.rejects(connect({ signal: controller.signal }), error => {
    assert.match(error.message, /sign-in cancelled/i);
    assert.equal(error.isTtyError, true);
    return true;
  });
  assert.deepEqual(killed, [{ pid: -spawn.calls[1].child.pid, signal: 'SIGKILL' }]);
  assert.equal(spawn.calls.length, 2);
  assertCleaned(spawn.calls);
});

function walkthroughHarness({ reused = false, connectError = null, probeOk = true } = {}) {
  const localRequire = createRequire(walkthroughPath);
  const events = [];
  const opened = [];
  const logs = [];
  const prompts = [];
  const originalCredentials = { aiProvider: { provider: 'openai', apiKey: 'previous-key', model: 'previous-model' } };
  const fakeProcess = new EventEmitter();
  fakeProcess.versions = process.versions;
  fakeProcess.platform = process.platform;
  fakeProcess.env = {};
  fakeProcess.stdout = { write: value => logs.push(value) };
  let walkthrough;
  const sandbox = {
    module: { exports: {} },
    __dirname: root,
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'inquirer') return {
        async prompt(questions) {
          const name = questions[0].name;
          prompts.push(name);
          if (name === 'redo') return { redo: true };
          if (name === 'providerId') return { providerId: 'chatgpt' };
          if (name === 'model') {
            events.push('model');
            return { model: sandbox.module.exports.AI_PROVIDER_GUIDE.chatgpt.defaultModel };
          }
          assert.fail('Unexpected prompt: ' + name);
        },
      };
      if (name === './utils/credential-manager') return { CredentialManager: class {} };
      if (name === './utils/subscription-text') return {
        async connectChatGPTSubscription({ onOutput }) {
          events.push('connect');
          onOutput('Actual sign-in URL from the CLI\n');
          if (connectError) throw connectError;
          return { reused };
        },
      };
      return localRequire(name);
    },
    console: { log: (...values) => logs.push(values.join(' ')) },
    process: fakeProcess,
    AbortController,
  };
  vm.runInNewContext(fs.readFileSync(walkthroughPath, 'utf8'), sandbox, { filename: walkthroughPath });
  walkthrough = new sandbox.module.exports.SetupWalkthrough();
  walkthrough.cm.credentials = JSON.parse(JSON.stringify(originalCredentials));
  walkthrough.cm.hasAITextProvider = () => true;
  walkthrough.cm.saveCredentials = async () => events.push('save');
  walkthrough.header = () => {};
  walkthrough.openBrowser = url => opened.push(url);
  walkthrough.validateAIKey = async (guide, apiKey, model) => {
    events.push('probe');
    assert.deepEqual(walkthrough.cm.credentials, originalCredentials, 'credentials changed before the live probe');
    assert.equal(guide, sandbox.module.exports.AI_PROVIDER_GUIDE.chatgpt);
    assert.equal(apiKey, 'subscription');
    assert.equal(model, guide.defaultModel);
    return probeOk;
  };
  return { walkthrough, originalCredentials, events, prompts, opened, logs, fakeProcess };
}

test('ChatGPT walkthrough connects and probes before saving, without opening docs or asking self-reported readiness', async t => {
  for (const reused of [true, false]) {
    await t.test(reused ? 'existing sign-in' : 'new sign-in', async () => {
      const h = walkthroughHarness({ reused });
      await h.walkthrough.stepAIProvider();
      assert.deepEqual(h.events, ['connect', 'model', 'probe', 'save']);
      assert.deepEqual(h.opened, []);
      assert.deepEqual(h.prompts, ['redo', 'providerId', 'model']);
      assert.equal(h.walkthrough.cm.credentials.aiProvider.provider, 'chatgpt');
      assert.equal(h.walkthrough.cm.credentials.aiProvider.apiKey, 'subscription');
      assert.match(h.logs.join(''), /Actual sign-in URL from the CLI/);
      assert.match(h.logs.join(''), reused ? /existing ChatGPT sign-in/ : /sign-in completed/);
    });
  }
});

test('failed or cancelled ChatGPT walkthrough login preserves the prior provider', async t => {
  for (const message of ['Codex CLI is not installed', 'Sign-in cancelled']) {
    await t.test(message, async () => {
      const h = walkthroughHarness({ connectError: new Error(message) });
      await h.walkthrough.stepAIProvider();
      assert.deepEqual(h.events, ['connect']);
      assert.deepEqual(h.walkthrough.cm.credentials, h.originalCredentials);
      assert.deepEqual(h.opened, []);
      assert.match(h.logs.join(''), /ChatGPT was not saved/);
    });
  }
});

test('failed ChatGPT generation probe preserves the prior provider and does not save', async () => {
  const h = walkthroughHarness({ reused: true, probeOk: false });
  await h.walkthrough.stepAIProvider();
  assert.deepEqual(h.events, ['connect', 'model', 'probe']);
  assert.deepEqual(h.walkthrough.cm.credentials, h.originalCredentials);
  assert.deepEqual(h.opened, []);
});

test('walkthrough cancellation preserves credentials and removes its SIGINT listener', async () => {
  const error = new Error('ChatGPT sign-in cancelled.');
  error.isTtyError = true;
  const h = walkthroughHarness({ connectError: error });
  await assert.rejects(h.walkthrough.stepAIProvider(), caught => caught === error);
  assert.deepEqual(h.events, ['connect']);
  assert.deepEqual(h.walkthrough.cm.credentials, h.originalCredentials);
  assert.equal(h.fakeProcess.listenerCount('SIGINT'), 0);
});
