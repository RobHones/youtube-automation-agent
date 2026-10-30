const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { setImmediate, setTimeout, clearTimeout } = require('node:timers');
const vm = require('node:vm');
const {
  buildClaudeArgs, buildCodexArgs, buildClaudeResearchArgs, buildCodexResearchArgs,
  parseClaudeResearch, parseCodexResearch,
} = require('../utils/subscription-text');

const sourcePath = path.join(__dirname, '..', 'utils', 'subscription-text.js');
const localRequire = createRequire(sourcePath);
const source = fs.readFileSync(sourcePath, 'utf8');
const pack = { sources: [{ url: 'https://museum.example/record' }], claims: [] };
const jsonl = events => events.map(event => JSON.stringify(event)).join('\n');
const codexFetch = {
  type: 'item.completed', item: {
    id: 'fetch-1', type: 'web_search', action: { type: 'other' },
    results: [{ url: 'https://museum.example/record', ref_id: 'turn2view0', title: 'Archive record' }],
  },
};
const codexEvents = [codexFetch, { type: 'turn.completed' }];
const claudeEvents = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: { url: 'https://museum.example/record' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fetch-1', content: 'A passage from the archive.' }] } },
  { type: 'result', subtype: 'success', result: JSON.stringify(pack) },
];

function mockRunner(respond, env = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 44000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const input = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) { input.push(Buffer.from(chunk)); done(); } });
    child.kill = () => true;
    const call = { command, args, options, child };
    calls.push(call);
    setImmediate(async () => {
      try {
        const result = await respond({ ...call, input: Buffer.concat(input).toString('utf8') });
        child.stdout.end(result.stdout || '');
        child.stderr.end(result.stderr || '');
        child.emit('close', result.code ?? 0);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  const sandbox = {
    module: { exports: {} }, require: name => name === 'cross-spawn' ? spawn : localRequire(name),
    process: { env, platform: process.platform, versions: process.versions, kill: () => {} },
    Buffer, URL, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename: sourcePath });
  return { ...sandbox.module.exports, calls };
}

test('research flags permit web retrieval while preserving the text-only defaults', () => {
  const codexText = buildCodexArgs({ model: 'test-model', cwd: 'scratch', outputPath: 'result' });
  const codex = buildCodexResearchArgs({ model: 'test-model', cwd: 'scratch', outputPath: 'result', schemaPath: 'schema' });
  assert.ok(codexText.includes('web_search="disabled"'));
  assert.ok(codex.includes('web_search="live"'));
  assert.ok(codex.includes('--json'));
  assert.ok(codex.includes('shell_tool'));
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(codex[codex.indexOf('--output-schema') + 1], 'schema');
  assert.ok(buildClaudeArgs('sonnet').includes('*'));
  const claude = buildClaudeResearchArgs({ model: 'sonnet' });
  assert.equal(claude[claude.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(claude[claude.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.equal(claude[claude.indexOf('--disallowedTools') + 1], 'mcp__*');
  assert.ok(claude.includes('--safe-mode'));
  assert.ok(claude.includes('--restricted'));
});

test('Codex accepts only completed page opens and keeps the exact retrieved URL', () => {
  const stream = [
    { type: 'item.started', item: { ...codexFetch.item, id: 'started-only' } },
    { type: 'item.completed', item: { ...codexFetch.item, id: 'search-only', action: { type: 'search' }, results: [{ url: 'https://unopened.example/', ref_id: 'turn0search0' }] } },
    ...codexEvents,
  ];
  const result = parseCodexResearch(jsonl(stream), JSON.stringify(pack));
  assert.deepEqual(result.data, pack);
  assert.equal(result.retrievals.length, 1);
  assert.equal(result.retrievals[0].url, 'https://museum.example/record');
  assert.equal(result.retrievals[0].status, 'completed');
});

test('Codex rejects missing retrieval, invalid JSON, failed/incomplete runs, and non-web tools', () => {
  assert.throws(() => parseCodexResearch(jsonl([{ type: 'turn.completed' }]), '{}'), /page retrievals/);
  assert.throws(() => parseCodexResearch(jsonl(codexEvents), '```json\n{}\n```'), /invalid JSON/);
  assert.throws(() => parseCodexResearch(jsonl([codexFetch]), '{}'), /completed turn/);
  assert.throws(() => parseCodexResearch(jsonl([...codexEvents, { type: 'turn.failed' }]), '{}'), /failed/);
  assert.throws(() => parseCodexResearch(jsonl([...codexEvents, { type: 'item.started', item: { type: 'command_execution' } }]), '{}'), /web-only policy/);
  assert.throws(() => parseCodexResearch('not json', '{}'), /event stream/);
});

test('Claude matches successful fetch results to their tool-use URL and handles structured output', () => {
  const events = [...claudeEvents.slice(0, -1), { type: 'result', subtype: 'success', structured_output: pack }];
  const result = parseClaudeResearch(jsonl(events));
  assert.deepEqual(result.data, pack);
  assert.equal(result.retrievals[0].url, 'https://museum.example/record');
  assert.equal(result.retrievals[0].content, 'A passage from the archive.');
});

test('Claude rejects failed fetches, search-only responses, malformed final output and failed turns', () => {
  const failedFetch = JSON.parse(JSON.stringify(claudeEvents));
  failedFetch[1].message.content[0].is_error = true;
  assert.throws(() => parseClaudeResearch(jsonl(failedFetch)), /page retrievals/);
  const searchOnly = JSON.parse(JSON.stringify(claudeEvents));
  searchOnly[0].message.content[0].name = 'WebSearch';
  assert.throws(() => parseClaudeResearch(jsonl(searchOnly)), /page retrievals/);
  assert.throws(() => parseClaudeResearch(jsonl(claudeEvents), true), /requested structured output/);
  assert.throws(() => parseClaudeResearch(jsonl(claudeEvents.slice(0, -1))), /successful final/);
  assert.throws(() => parseClaudeResearch(jsonl([...claudeEvents, { type: 'result', subtype: 'error_max_turns', is_error: true }])), /successful final/);
  assert.throws(() => parseClaudeResearch(jsonl([...claudeEvents, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }])), /web-only policy/);
});

test('ChatGPT research verifies subscription auth, strips API overrides and cleans scratch files', async () => {
  const env = { OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'https://override.invalid', CODEX_HOME: 'subscription-home' };
  const runner = mockRunner(call => {
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.equal(call.options.env.CODEX_API_KEY, undefined);
    assert.equal(call.options.env.OPENAI_BASE_URL, undefined);
    assert.equal(call.options.env.CODEX_HOME, 'subscription-home');
    if (call.args[0] === 'login') return { stderr: 'Logged in using ChatGPT' };
    fs.writeFileSync(call.args[call.args.indexOf('--output-last-message') + 1], JSON.stringify(pack));
    assert.match(call.input, /Open source pages/);
    return { stdout: jsonl(codexEvents) };
  }, env);
  const result = await runner.generateSubscriptionResearch({ provider: 'chatgpt', model: 'test-model', prompt: 'Research railway' });
  assert.equal(result.provider, 'chatgpt');
  assert.equal(result.data.sources[0].url, 'https://museum.example/record');
  assert.equal(env.OPENAI_API_KEY, 'secret');
  for (const call of runner.calls) assert.equal(fs.existsSync(call.options.cwd), false);
});

test('Claude research verifies subscription auth and strips alternate paid routing', async () => {
  const env = { ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' };
  const runner = mockRunner(call => {
    assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(call.options.env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(call.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-token');
    return call.args[0] === 'auth' ? { stdout: '{"authMethod":"oauth_token"}' } : { stdout: jsonl(claudeEvents) };
  }, env);
  const result = await runner.generateSubscriptionResearch({ provider: 'claude', model: 'sonnet', prompt: 'Research railway' });
  assert.equal(result.provider, 'claude');
  assert.equal(result.retrievals.length, 1);
  for (const call of runner.calls) assert.equal(fs.existsSync(call.options.cwd), false);
});

test('research fails before generation on API auth and cleans up', async () => {
  for (const provider of ['chatgpt', 'claude']) {
    const runner = mockRunner(() => provider === 'chatgpt'
      ? { stderr: 'Logged in using an API key' }
      : { stdout: '{"authMethod":"api_key"}' });
    await assert.rejects(runner.generateSubscriptionResearch({ provider, model: 'test', prompt: 'Research' }), /subscription authentication is required/);
    assert.equal(runner.calls.length, 1);
    assert.equal(fs.existsSync(runner.calls[0].options.cwd), false);
  }
});

test('research rejects unsupported provider, runtime and unbounded timeout', async () => {
  const runner = mockRunner(() => { throw new Error('must not spawn'); });
  await assert.rejects(runner.generateSubscriptionResearch({ provider: 'cursor' }), /research provider/);
  await assert.rejects(runner.generateSubscriptionResearch({ provider: 'chatgpt', runtime: 'cloud' }), /local CLI/);
  await assert.rejects(runner.generateSubscriptionResearch({ provider: 'claude', model: 'sonnet', prompt: 'Research', timeoutMs: Infinity }), /Research timeout/);
  assert.equal(runner.calls.length, 0);
});
