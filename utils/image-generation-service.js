const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');

const IMAGE_PROVIDERS = ['auto', 'none', 'openai', 'gemini', 'fal', 'local'];
const LOCAL_BACKENDS = ['automatic1111', 'comfyui'];
const DEFAULT_FAL_MODEL = 'fal-ai/flux/schnell';

function httpUrl(value, name) {
  let url;
  try { url = new URL(value); } catch (_error) { throw new Error(`${name} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/$/, '');
}

function fillWorkflow(value, replacements) {
  if (Array.isArray(value)) return value.map(item => fillWorkflow(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillWorkflow(item, replacements)]));
  }
  if (typeof value !== 'string') return value;
  if (Object.hasOwn(replacements, value)) return replacements[value];
  return value.replace(/\{\{(?:prompt|seed|width|height)\}\}/g, token => String(replacements[token]));
}

class ImageGenerationService {
  constructor(credentials = {}, options = {}) {
    this.credentials = credentials?.credentials || credentials;
    this.db = options.db;
    this.env = options.env || process.env;
    this.http = options.http || axios;
    this.legacy = options.legacy || {};
    this.logger = options.logger || { warn() {} };
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
    this.timeoutMs = Number(options.timeoutMs || this.env.IMAGE_GENERATION_TIMEOUT_MS || 300000);
    this.pollMs = Number(options.pollMs ?? 1000);
  }

  async settings() {
    const saved = await this.db?.getAllSettings?.() || {};
    const provider = this.env.IMAGE_PROVIDER || saved.image_provider || 'auto';
    const backend = this.env.LOCAL_IMAGE_BACKEND || saved.local_image_backend || 'automatic1111';
    if (!IMAGE_PROVIDERS.includes(provider)) throw new Error(`Unsupported image provider: ${provider}`);
    if (!LOCAL_BACKENDS.includes(backend)) throw new Error(`Unsupported local image backend: ${backend}`);
    const localUrl = this.env.LOCAL_IMAGE_URL || saved.local_image_url || this.credentials.localImage?.url || '';
    const falModel = this.env.FAL_IMAGE_MODEL || saved.fal_image_model || this.credentials.fal?.imageModel || DEFAULT_FAL_MODEL;
    if (!/^[\w-]+\/[\w./-]+$/.test(falModel) || falModel.split('/').includes('..')) {
      throw new Error('FAL_IMAGE_MODEL must be a fal endpoint ID such as fal-ai/flux/schnell');
    }
    return {
      provider, backend, falModel,
      localConfigured: Boolean(localUrl || provider === 'local'),
      localUrl: httpUrl(localUrl || (backend === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860'), 'Local image URL'),
      workflowPath: this.env.COMFYUI_WORKFLOW_PATH || saved.comfyui_workflow_path || this.credentials.localImage?.workflowPath || '',
      width: 768, height: 432
    };
  }

  falKey() { return this.credentials.fal?.apiKey || this.env.FAL_KEY; }

  async list() {
    const settings = await this.settings();
    return [
      { id: 'openai', name: 'OpenAI', paid: true, available: this.legacy.openai?.isAvailable() ?? Boolean(this.credentials.openai?.apiKey || this.env.OPENAI_API_KEY) },
      { id: 'gemini', name: 'Google Gemini', paid: true, available: this.legacy.gemini?.isAvailable() ?? Boolean(this.credentials.gemini?.apiKey || this.env.GEMINI_API_KEY) },
      { id: 'fal', name: 'fal.ai', paid: true, available: Boolean(this.falKey()), model: settings.falModel },
      { id: 'local', name: `Local (${settings.backend})`, paid: false, available: settings.localConfigured, backend: settings.backend }
    ];
  }

  async selected() {
    const settings = await this.settings();
    const providers = await this.list();
    if (settings.provider === 'none') return [];
    if (settings.provider === 'auto') return providers.filter(provider => provider.available);
    return providers.filter(provider => provider.id === settings.provider && provider.available);
  }

  async isAvailable() { return (await this.selected()).length > 0; }

  safeError(error) {
    // Do not serialize Axios errors: their request config contains Authorization.
    let message = String(error?.response?.data?.detail || error?.response?.data?.error?.message || error?.message || 'Image request failed');
    for (const key of [this.falKey(), this.env.LOCAL_IMAGE_API_KEY, this.credentials.openai?.apiKey, this.env.OPENAI_API_KEY, this.credentials.gemini?.apiKey, this.env.GEMINI_API_KEY]) {
      if (key) message = message.split(key).join('[redacted]');
    }
    return message.replace(/(Bearer|Key)\s+[^\s,]+/gi, '$1 [redacted]').slice(0, 500);
  }

  async generate(prompt, imagePath, options = {}) {
    const providers = await this.selected();
    const eligible = options.allowPaid === false ? providers.filter(provider => !provider.paid) : providers;
    if (!eligible.length) throw new Error('No image generation provider configured for the selected mode');
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    const failures = [];
    for (const provider of eligible) {
      try {
        if (this.legacy[provider.id]) await this.legacy[provider.id].generate(prompt, imagePath);
        else if (provider.id === 'fal') await this.generateFal(prompt, imagePath);
        else await this.generateLocal(prompt, imagePath);
        const metadata = await sharp(imagePath, { failOn: 'error' }).metadata();
        if (!metadata.width || !metadata.height) throw new Error('Provider returned an invalid image');
        return imagePath;
      } catch (error) {
        const message = this.legacy[provider.id]?.describeError?.(error) || `${provider.name} image generation failed: ${this.safeError(error)}`;
        failures.push(message);
        this.logger.warn(message);
      }
    }
    throw new Error(failures.join(' | '));
  }

  async saveImage(data, imagePath) {
    let buffer;
    if (Buffer.isBuffer(data)) buffer = data;
    else if (typeof data === 'string' && /^data:image\/[\w.+-]+;base64,/.test(data)) buffer = Buffer.from(data.split(',')[1], 'base64');
    else if (typeof data === 'string' && /^https:\/\//.test(data)) {
      // Output downloads deliberately carry no provider API credentials.
      const response = await this.http.get(data, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 30 * 1024 * 1024 });
      buffer = Buffer.from(response.data);
    } else throw new Error('Provider returned no supported image output');
    if (!buffer.length || buffer.length > 30 * 1024 * 1024) throw new Error('Provider image is empty or too large');
    const image = sharp(buffer, { failOn: 'error' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) throw new Error('Provider returned an invalid image');
    const ext = path.extname(imagePath).toLowerCase();
    if (['.jpg', '.jpeg'].includes(ext)) await image.jpeg({ quality: 92 }).toFile(imagePath);
    else if (ext === '.webp') await image.webp().toFile(imagePath);
    else await image.png().toFile(imagePath);
  }

  async generateFal(prompt, imagePath) {
    const settings = await this.settings();
    const config = { headers: { Authorization: `Key ${this.falKey()}` }, timeout: 30000 };
    const started = this.now();
    const submitted = await this.http.post(`https://queue.fal.run/${settings.falModel}`, {
      prompt, image_size: 'landscape_16_9', num_images: 1, enable_safety_checker: true, output_format: 'png'
    }, config);
    const { status_url: statusUrl, response_url: responseUrl, cancel_url: cancelUrl } = submitted.data;
    for (const url of [statusUrl, responseUrl, cancelUrl].filter(Boolean)) {
      if (new URL(url).origin !== 'https://queue.fal.run') throw new Error('fal returned an unexpected queue URL');
    }
    if (!statusUrl || !responseUrl) throw new Error('fal returned no queue tracking URLs');
    while (this.now() - started < this.timeoutMs) {
      const status = await this.http.get(statusUrl, config);
      if (status.data.status === 'COMPLETED') {
        const result = await this.http.get(responseUrl, config);
        return this.saveImage(result.data.images?.[0]?.url, imagePath);
      }
      if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.data.status)) throw new Error('fal image request failed');
      await this.sleep(this.pollMs);
    }
    if (cancelUrl) await this.http.put(cancelUrl, {}, config).catch(() => {});
    throw new Error('fal image request timed out; cancellation requested. Check fal request history before retrying.');
  }

  async generateLocal(prompt, imagePath) {
    const settings = await this.settings();
    const config = { timeout: this.timeoutMs, maxContentLength: 40 * 1024 * 1024 };
    if (this.env.LOCAL_IMAGE_API_KEY) config.headers = { Authorization: `Bearer ${this.env.LOCAL_IMAGE_API_KEY}` };
    if (settings.backend === 'automatic1111') {
      const response = await this.http.post(`${settings.localUrl}/sdapi/v1/txt2img`, {
        prompt, width: settings.width, height: settings.height, steps: 20, batch_size: 1, n_iter: 1,
        send_images: true, save_images: false
      }, config);
      const encoded = response.data.images?.[0];
      return this.saveImage(encoded?.startsWith('data:') ? encoded : `data:image/png;base64,${encoded || ''}`, imagePath);
    }
    if (!settings.workflowPath) throw new Error('ComfyUI needs an API-format workflow file; set COMFYUI_WORKFLOW_PATH or choose it in Channel setup');
    const source = await fs.readFile(path.resolve(settings.workflowPath), 'utf8');
    if (!source.includes('{{prompt}}')) throw new Error('ComfyUI workflow must include {{prompt}} in its positive text prompt');
    const workflow = fillWorkflow(JSON.parse(source), {
      '{{prompt}}': prompt, '{{seed}}': crypto.randomInt(2147483647), '{{width}}': settings.width, '{{height}}': settings.height
    });
    if (!Object.values(workflow).some(node => node?.class_type === 'SaveImage')) throw new Error('ComfyUI API workflow needs a SaveImage output node');
    const submitted = await this.http.post(`${settings.localUrl}/prompt`, { prompt: workflow, client_id: crypto.randomUUID() }, config);
    const promptId = submitted.data.prompt_id;
    if (!promptId || submitted.data.error) throw new Error('ComfyUI rejected the workflow; check model filenames and nodes');
    const started = this.now();
    while (this.now() - started < this.timeoutMs) {
      const result = await this.http.get(`${settings.localUrl}/history/${encodeURIComponent(promptId)}`, config);
      const entry = result.data[promptId];
      if (entry?.status?.status_str === 'error') throw new Error('ComfyUI workflow execution failed; check its console and model setup');
      const image = Object.values(entry?.outputs || {}).flatMap(output => output.images || []).find(output => output.type === 'output');
      if (image) {
        const url = new URL(`${settings.localUrl}/view`);
        url.searchParams.set('filename', image.filename);
        url.searchParams.set('subfolder', image.subfolder || '');
        url.searchParams.set('type', 'output');
        const response = await this.http.get(url.toString(), { ...config, responseType: 'arraybuffer' });
        return this.saveImage(Buffer.from(response.data), imagePath);
      }
      if (entry?.status?.completed) throw new Error('ComfyUI completed without an output image');
      await this.sleep(this.pollMs);
    }
    // Only delete our pending job. /interrupt would also stop unrelated workflows.
    await this.http.post(`${settings.localUrl}/queue`, { delete: [promptId] }, config).catch(() => {});
    throw new Error('ComfyUI image request timed out; a running workflow may still finish in ComfyUI');
  }
}

module.exports = { ImageGenerationService, IMAGE_PROVIDERS, LOCAL_BACKENDS, DEFAULT_FAL_MODEL, httpUrl, fillWorkflow };
