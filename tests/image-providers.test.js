const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');
const { ImageGenerationService, fillWorkflow } = require('../utils/image-generation-service');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-image-providers-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const image = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#4488aa' } }).png().toBuffer();
  return { directory, image, output: path.join(directory, 'result.png') };
}

test('fal polls the returned queue URLs, downloads without credentials, and validates a real image', async t => {
  const f = await fixture(t);
  let polls = 0;
  const service = new ImageGenerationService({}, {
    env: { IMAGE_PROVIDER: 'fal', FAL_KEY: 'secret-fal-key' }, pollMs: 0,
    http: {
      async post(url, payload, config) {
        assert.equal(url, 'https://queue.fal.run/fal-ai/flux/schnell');
        assert.equal(config.headers.Authorization, 'Key secret-fal-key');
        assert.equal(payload.image_size, 'landscape_16_9');
        assert.equal(payload.enable_safety_checker, true);
        return { data: { status_url: 'https://queue.fal.run/fal-ai/flux/requests/123/status', response_url: 'https://queue.fal.run/fal-ai/flux/requests/123' } };
      },
      async get(url, config) {
        if (url.endsWith('/status')) return { data: { status: ++polls === 1 ? 'IN_PROGRESS' : 'COMPLETED' } };
        if (url.endsWith('/123')) return { data: { images: [{ url: 'https://example.test/output.png' }] } };
        assert.equal(config.headers, undefined, 'API key leaked into output download');
        return { data: f.image };
      }
    }
  });
  await service.generate('An abandoned bridge', f.output);
  assert.equal(polls, 2);
  assert.equal((await sharp(f.output).metadata()).width, 320);
});

test('explicit local selection never calls a configured paid provider', async t => {
  const f = await fixture(t);
  let paidCalls = 0;
  const service = new ImageGenerationService({}, {
    env: { IMAGE_PROVIDER: 'local', FAL_KEY: 'unused', LOCAL_IMAGE_URL: 'http://127.0.0.1:7860' },
    legacy: { openai: { isAvailable: () => true, generate: () => { paidCalls++; } } },
    http: { async post() { throw new Error('Local server unavailable'); } }
  });
  await assert.rejects(service.generate('test', f.output), /Local server unavailable/);
  assert.equal(paidCalls, 0);
});

test('AUTOMATIC1111-compatible server produces a decoded PNG through the real HTTP client', async t => {
  const f = await fixture(t);
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(request.url, '/sdapi/v1/txt2img');
    assert.equal(payload.prompt, 'A historical railway');
    assert.equal(payload.width, 768);
    assert.equal(payload.height, 432);
    assert.equal(payload.batch_size, 1);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ images: [f.image.toString('base64')] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const service = new ImageGenerationService({}, { env: { IMAGE_PROVIDER: 'local', LOCAL_IMAGE_URL: `http://127.0.0.1:${server.address().port}` } });
  await service.generate('A historical railway', f.output);
  assert.equal((await sharp(f.output).metadata()).height, 180);
});

test('ComfyUI substitutes typed workflow inputs, polls history, and fetches only its output', async t => {
  const f = await fixture(t);
  const workflowPath = path.join(f.directory, 'workflow.json');
  await fs.writeFile(workflowPath, JSON.stringify({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    '2': { class_type: 'KSampler', inputs: { seed: '{{seed}}' } },
    '3': { class_type: 'SaveImage', inputs: {} }
  }));
  let polls = 0;
  const service = new ImageGenerationService({}, {
    env: { IMAGE_PROVIDER: 'local', LOCAL_IMAGE_BACKEND: 'comfyui', COMFYUI_WORKFLOW_PATH: workflowPath }, pollMs: 0,
    http: {
      async post(url, payload) {
        assert.equal(url, 'http://127.0.0.1:8188/prompt');
        assert.equal(payload.prompt['1'].inputs.text, 'A "quoted" story\nwith a newline');
        assert.equal(typeof payload.prompt['2'].inputs.seed, 'number');
        return { data: { prompt_id: 'our-job' } };
      },
      async get(url) {
        if (url.includes('/history/')) {
          assert.ok(url.endsWith('/history/our-job'));
          return { data: ++polls === 1 ? {} : { 'our-job': { outputs: { '3': { images: [{ filename: 'ours.png', subfolder: '', type: 'output' }] } } } } };
        }
        const imageUrl = new URL(url);
        assert.equal(imageUrl.searchParams.get('filename'), 'ours.png');
        return { data: f.image };
      }
    }
  });
  await service.generate('A "quoted" story\nwith a newline', f.output);
  assert.equal((await sharp(f.output).metadata()).format, 'png');
});

test('ComfyUI workflow validation and execution failures surface without paid fallback', async t => {
  const f = await fixture(t);
  const workflowPath = path.join(f.directory, 'workflow.json');
  await fs.writeFile(workflowPath, JSON.stringify({ '1': { class_type: 'SaveImage', inputs: {} } }));
  const service = new ImageGenerationService({}, { env: { IMAGE_PROVIDER: 'local', LOCAL_IMAGE_BACKEND: 'comfyui', COMFYUI_WORKFLOW_PATH: workflowPath }, http: { post() { assert.fail('Invalid workflow submitted'); } } });
  await assert.rejects(service.generate('story', f.output), /must include \{\{prompt\}\}/);
  await fs.writeFile(workflowPath, JSON.stringify({ '1': { class_type: 'SaveImage', inputs: { text: '{{prompt}}' } } }));
  service.http = { post: async () => ({ data: { prompt_id: 'failed' } }), get: async () => ({ data: { failed: { status: { status_str: 'error' } } } }) };
  await assert.rejects(service.generate('story', f.output), /execution failed/);
});

test('paid-image opt-out never submits a fal request', async t => {
  const f = await fixture(t);
  const service = new ImageGenerationService({}, { env: { IMAGE_PROVIDER: 'fal', FAL_KEY: 'test-key' }, http: { post() { assert.fail('Paid request made'); } } });
  await assert.rejects(service.generate('test', f.output, { allowPaid: false }), /No image generation provider/);
});

test('automatic mode preserves legacy fallback and none mode makes no requests', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const service = new ImageGenerationService({}, {
    env: {},
    legacy: {
      openai: { isAvailable: () => true, generate: async () => { attempts++; throw new Error('No quota'); } },
      gemini: { isAvailable: () => true, generate: async (_prompt, target) => { attempts++; await fs.writeFile(target, f.image); } }
    }
  });
  await service.generate('test', f.output);
  assert.equal(attempts, 2);
  service.env.IMAGE_PROVIDER = 'none';
  assert.equal(await service.isAvailable(), false);
  await assert.rejects(service.generate('test', f.output));
  assert.equal(attempts, 2);
});

test('fal failures redact the key and reject unexpected credential destinations', async t => {
  const f = await fixture(t);
  const key = 'super-secret-fal-key';
  const service = new ImageGenerationService({}, {
    env: { IMAGE_PROVIDER: 'fal', FAL_KEY: key },
    http: { post: async () => { throw new Error(`Authorization: Key ${key} was rejected`); } }
  });
  await assert.rejects(service.generate('test', f.output), error => !error.message.includes(key) && error.message.includes('[redacted]'));
  service.http = { post: async () => ({ data: { status_url: 'https://evil.test/status', response_url: 'https://queue.fal.run/result' } }), get: () => assert.fail('Key sent to unexpected host') };
  await assert.rejects(service.generate('test', f.output), /unexpected queue URL/);
});

test('fal timeout requests cancellation instead of leaving an unobserved queued job', async t => {
  const f = await fixture(t);
  let clock = 0;
  let cancelled = false;
  const service = new ImageGenerationService({}, {
    env: { IMAGE_PROVIDER: 'fal', FAL_KEY: 'test-key' }, timeoutMs: 50, now: () => clock += 100,
    http: {
      post: async () => ({ data: { status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result', cancel_url: 'https://queue.fal.run/cancel' } }),
      put: async () => { cancelled = true; }
    }
  });
  await assert.rejects(service.generate('test', f.output), /timed out/);
  assert.equal(cancelled, true);
});

test('HTML or empty provider responses cannot become approved image assets', async t => {
  const f = await fixture(t);
  const service = new ImageGenerationService({}, { env: { IMAGE_PROVIDER: 'local' }, http: { post: async () => ({ data: { images: [Buffer.from('<html>Error</html>').toString('base64')] } }) } });
  await assert.rejects(service.generate('test', f.output));
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('database settings and typed workflow replacement work without process-wide configuration', async () => {
  const service = new ImageGenerationService({ fal: { apiKey: 'saved-key' } }, { env: {}, db: { getAllSettings: async () => ({ image_provider: 'fal', fal_image_model: 'fal-ai/flux/dev' }) } });
  assert.equal((await service.selected())[0].id, 'fal');
  assert.equal((await service.settings()).falModel, 'fal-ai/flux/dev');
  assert.deepEqual(fillWorkflow({ width: '{{width}}', text: 'Scene: {{prompt}}' }, { '{{width}}': 768, '{{prompt}}': 'a bridge' }), { width: 768, text: 'Scene: a bridge' });
});

test('settings API privately saves fal credentials and rejects invalid local configuration', async t => {
  const { YouTubeAutomationAgent } = require('../index');
  const agent = new YouTubeAutomationAgent();
  const settings = {};
  let saves = 0;
  agent.db = {
    getAllSettings: async () => ({ ...settings }),
    setSetting: async (key, value) => { settings[key] = value; }
  };
  agent.credentials = { credentials: {}, saveCredentials: async () => { saves++; } };
  agent.setupOperatorAPI();
  agent.app.use(require('express').json());
  // JSON parsing must precede the routes, as setupAPI normally arranges it.
  const app = require('express')();
  app.use(require('express').json());
  app.use(agent.app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = body => fetch(`http://127.0.0.1:${server.address().port}/api/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY || '' }, body: JSON.stringify(body)
  });
  let response = await request({ image_provider: 'fal', fal_image_model: 'fal-ai/flux/schnell', fal_api_key: 'private-fal-key' });
  assert.equal(response.status, 200);
  assert.equal(agent.credentials.credentials.fal.apiKey, 'private-fal-key');
  assert.equal(saves, 1);
  assert.equal((await response.text()).includes('private-fal-key'), false);
  assert.equal(settings.fal_api_key, undefined);
  response = await request({ image_provider: 'local', local_image_url: 'file:///private' });
  assert.equal(response.status, 400);
  assert.equal(settings.image_provider, 'fal', 'invalid request partially changed image selection');
  response = await request({ image_provider: 'local', local_image_backend: 'comfyui', local_image_url: 'http://127.0.0.1:8188', comfyui_workflow_path: 'config/workflow.json', fal_api_key: '' });
  assert.equal(response.status, 200);
  assert.equal(settings.local_image_backend, 'comfyui');
  assert.equal(agent.credentials.credentials.fal.apiKey, 'private-fal-key');
});

test('production uses a local-only image service even without OpenAI or Gemini', async t => {
  const f = await fixture(t);
  const { AIVideoGenerator } = require('../utils/ai-video-generator');
  const service = new ImageGenerationService({}, {
    env: { IMAGE_PROVIDER: 'local' },
    http: { post: async () => ({ data: { images: [f.image.toString('base64')] } }) }
  });
  const generator = new AIVideoGenerator({}, { imageService: service });
  generator.openai = null;
  generator.gemini = null;
  const assets = await generator.generateVisualAssets('A forgotten railway', 'documentary', 1);
  assert.equal(assets.length, 1);
  t.after(() => fs.unlink(assets[0]));
  assert.equal((await sharp(assets[0]).metadata()).width, 320);
});

test('readiness can verify local images without opting into paid requests', async t => {
  const f = await fixture(t);
  const { ProductionReadinessService } = require('../utils/production-readiness-service');
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ images: [f.image.toString('base64')] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = {};
  const overrides = { IMAGE_PROVIDER: 'local', LOCAL_IMAGE_BACKEND: 'automatic1111', LOCAL_IMAGE_URL: `http://127.0.0.1:${server.address().port}` };
  for (const [key, value] of Object.entries(overrides)) { previous[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const key of Object.keys(overrides)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const service = new ProductionReadinessService({}, { credentials: { fal: { apiKey: 'unused-paid-key' } } });
  const result = await service.probeImage(f.directory, false);
  assert.ok(result.details.bytes > 100);
});
