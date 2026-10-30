const OpenAI = require('openai');
const { Logger } = require('./logger');
const {
  cursorEnvSelected,
  claudeEnvSelected,
  codexEnvSelected,
  generateSubscriptionText,
} = require('./subscription-text');

const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-4-argon',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];
// Floor for the single retry after a thinking model exhausts a small budget.
const GEMINI_THINKING_RETRY_MIN_TOKENS = 1024;

const PROVIDERS = {
  cursor: {
    name: 'Cursor',
    defaultModel: 'composer-2.5',
    models: ['composer-2.5', 'auto'],
    envKey: 'CURSOR_API_KEY',
    subscription: true,
    defaultRuntime: 'local',
  },
  claude: {
    name: 'Claude',
    defaultModel: 'sonnet',
    models: ['sonnet', 'opus', 'haiku', 'fable'],
    envKey: 'CLAUDE_RUNTIME',
    subscription: true,
    defaultRuntime: 'local',
  },
  chatgpt: {
    name: 'ChatGPT',
    defaultModel: 'gpt-5.6-luna',
    models: ['gpt-5.6-luna', 'gpt-5.6-terra'],
    envKey: 'CODEX_RUNTIME',
    subscription: true,
    defaultRuntime: 'local',
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-6.1-sol',
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-6.1-sol',
    models: ['openai/gpt-6.1-sol', 'anthropic/claude-fable-5.1', 'google/gemini-3.8-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3', 'deepseek/deepseek-v4.1-flash', 'minimax/minimax-m3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.6-pro',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2'],
    envKey: 'GLM_API_KEY',
  },
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    envKey: 'DEEPSEEK_API_KEY',
  },
  minimax: {
    name: 'MiniMax',
    baseURL: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3.1-Flash',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    // MINIMAX_API_KEY already selects MiniMax H3 video; reusing it here would
    // silently switch Gemini users with a video key over to MiniMax text.
    envKey: 'MINIMAX_TEXT_API_KEY',
  },
};

function isTextProviderConfigured(credentials = {}, env = process.env) {
  if (credentials.openai?.apiKey || credentials.gemini?.apiKey || credentials.aiProvider?.apiKey) {
    return true;
  }
  if (cursorEnvSelected(env) || claudeEnvSelected(env) || codexEnvSelected(env)) {
    return true;
  }
  const envKeys = [
    ...Object.values(PROVIDERS).filter(preset => !preset.subscription).map(preset => preset.envKey),
    'GEMINI_API_KEY',
  ];
  return envKeys.some(key => env[key]);
}

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.subscription = null;
    this.model = null;
    this.providerName = null;
    this._generateSubscription = generateSubscriptionText;

    this._init(credentials);
  }

  _init(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    if (provider === 'gemini' && apiKey) {
      return this._initGemini(apiKey, model);
    }

    if (provider && PROVIDERS[provider]?.subscription && apiKey) {
      return this._initSubscription(provider, {
        apiKey,
        model,
        runtime: credentials.aiProvider.runtime,
      });
    }

    if (provider && PROVIDERS[provider] && apiKey) {
      return this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    }

    const subscription = this._subscriptionFromEnv();
    if (subscription) {
      return this._initSubscription(subscription.provider, subscription);
    }

    for (const [, preset] of Object.entries(PROVIDERS)) {
      if (preset.subscription) continue;
      const key = process.env[preset.envKey];
      if (key) {
        return this._initOpenAICompatible(preset, key);
      }
    }

    // Older setup flows saved OpenAI separately from the explicit text choice.
    if (credentials.openai?.apiKey) {
      return this._initOpenAICompatible(PROVIDERS.openai, credentials.openai.apiKey, credentials.openai.model);
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    this.logger.warn('No AI text provider configured — text generation unavailable');
  }

  _subscriptionFromEnv() {
    const matches = [];
    if (cursorEnvSelected()) {
      matches.push({
        provider: 'cursor',
        apiKey: process.env.CURSOR_API_KEY,
        model: process.env.CURSOR_MODEL,
        runtime: process.env.CURSOR_RUNTIME,
      });
    }
    if (claudeEnvSelected()) {
      matches.push({
        provider: 'claude',
        apiKey: 'subscription',
        model: process.env.CLAUDE_MODEL,
        runtime: process.env.CLAUDE_RUNTIME,
      });
    }
    if (codexEnvSelected()) {
      matches.push({
        provider: 'chatgpt',
        apiKey: 'subscription',
        model: process.env.CODEX_MODEL,
        runtime: process.env.CODEX_RUNTIME,
      });
    }
    if (matches.length > 1) {
      this.logger.warn(
        `Multiple subscription text providers are set (${matches.map(match => match.provider).join(', ')}). Using ${matches[0].provider}.`
      );
    }
    return matches[0] || null;
  }

  _initSubscription(id, { apiKey, model, runtime }) {
    const preset = PROVIDERS[id];
    this.subscription = {
      id,
      apiKey,
      model: model || preset.defaultModel,
      runtime: String(runtime || preset.defaultRuntime).trim().toLowerCase(),
    };
    this.model = this.subscription.model;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} subscription initialized (model: ${this.model}, runtime: ${this.subscription.runtime})`);
  }

  _initOpenAICompatible(preset, apiKey, model) {
    this.client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  async generateText(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    if (this.subscription) {
      const text = await this._generateSubscription({
        ...this.subscription,
        model,
      }, prompt, this.logger);
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${this.providerName} returned an empty response.`);
      }
      return text;
    }

    if (this.gemini) {
      const config = { maxOutputTokens: maxTokens };
      if (!/^gemini-(?:3\.(?:[5-9]|\d{2,})|[4-9]|\d{2,})[.-]/.test(model)) config.temperature = temperature;
      let response = await this.gemini.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      let text = response && response.text;

      // Thinking models (gemini-3.x flash/pro) count thoughts against
      // maxOutputTokens, so a small budget can be spent before any text is
      // written. Retry once with room for the thoughts plus the answer.
      if (!this._hasText(text) && this._geminiFinishReason(response) === 'MAX_TOKENS') {
        const retryTokens = Math.max(maxTokens * 4, GEMINI_THINKING_RETRY_MIN_TOKENS);
        response = await this.gemini.models.generateContent({
          model,
          contents: prompt,
          config: { ...config, maxOutputTokens: retryTokens },
        });
        text = response && response.text;
      }

      if (!this._hasText(text)) {
        throw new Error(this._geminiEmptyResponseMessage(response));
      }
      return text;
    }

    if (!this.client) {
      throw new Error('No AI text provider configured');
    }

    const params = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    };

    const tokenParams = [
      { max_completion_tokens: maxTokens },
      { max_tokens: maxTokens },
    ];

    let lastError = null;
    for (let index = 0; index < tokenParams.length; index++) {
      const request = { ...params, ...tokenParams[index] };
      try {
        const response = await this.client.chat.completions.create(request);
        return this._extractContent(response);
      } catch (error) {
        lastError = error;
        const message = error?.message || '';
        const unsupportedTemperature =
          error?.status === 400 &&
          /temperature/i.test(message) &&
          /(unsupported value|does not support|only the default)/i.test(message);

        if (unsupportedTemperature) {
          const { temperature: _temperature, ...withoutTemperature } = request;
          try {
            const response = await this.client.chat.completions.create(withoutTemperature);
            return this._extractContent(response);
          } catch (retryError) {
            lastError = retryError;
          }
        }

        // Older models and some providers reject max_completion_tokens with a
        // 400; retry with the legacy max_tokens spelling. This also applies if
        // the temperature-compatible retry exposed the token incompatibility.
        if (
          index === 0 &&
          lastError?.status === 400 &&
          /max(_completion)?_tokens/i.test(lastError.message || '')
        ) {
          continue;
        }
        throw lastError;
      }
    }

    throw lastError;
  }

  _hasText(text) {
    return typeof text === 'string' && text.trim().length > 0;
  }

  _geminiFinishReason(response) {
    return response?.candidates?.[0]?.finishReason || null;
  }

  _geminiEmptyResponseMessage(response) {
    const finishReason = this._geminiFinishReason(response);
    const blockReason = response?.promptFeedback?.blockReason;
    if (finishReason === 'MAX_TOKENS') {
      const thoughts = response?.usageMetadata?.thoughtsTokenCount;
      return `${this.providerName} spent its whole output budget${thoughts ? ` (${thoughts} thinking tokens)` : ''} before writing any text. Raise maxTokens, or choose a model that does not think, such as gemini-3.5-flash-lite.`;
    }
    if (blockReason || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(finishReason)) {
      return `${this.providerName} blocked the response (${blockReason || finishReason}). Rephrase the prompt or topic and try again.`;
    }
    return `${this.providerName} returned an empty response${finishReason ? ` (finishReason: ${finishReason})` : ''}. Check the API key and model quota — free-tier Gemini keys are rate-limited and can return empty output.`;
  }

  _extractContent(response) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      throw new Error(
        `${this.providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini || this.subscription);
  }
}

module.exports = {
  AITextService,
  PROVIDERS,
  GEMINI_MODELS,
  GEMINI_DEFAULT_MODEL,
  isTextProviderConfigured,
};
