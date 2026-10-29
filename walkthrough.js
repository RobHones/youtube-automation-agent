require('dotenv').config();

const inquirer = require('inquirer');
const chalk = require('chalk');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { CredentialManager } = require('./utils/credential-manager');
const {
  AITextService,
  PROVIDERS,
  GEMINI_MODELS,
  GEMINI_DEFAULT_MODEL
} = require('./utils/ai-text-service');
const { Database } = require('./database/db');
const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
const { VideoProviderRegistry } = require('./utils/video-providers');
const { ImageGenerationService, httpUrl } = require('./utils/image-generation-service');
const { connectChatGPTSubscription } = require('./utils/subscription-text');

// Everything a beginner needs to know about each provider, in one place
const AI_PROVIDER_GUIDE = {
  cursor: {
    label: 'Cursor — your Cursor plan, local or cloud (not a vendor API key)',
    keyUrl: 'https://cursor.com/dashboard/integrations',
    keyHint: 'starts with "cursor_"',
    auth: 'cursor-key',
    instructions: [
      'Open Cursor Dashboard → Integrations and create a user API key',
      'Copy the key. It bills this app to your Cursor plan',
      'Choose local (agent loop on this machine) or cloud (an empty Cursor VM, no repo and no pull request)'
    ],
    models: [...PROVIDERS.cursor.models],
    defaultModel: PROVIDERS.cursor.defaultModel,
    defaultRuntime: PROVIDERS.cursor.defaultRuntime,
    runtimeChoices: [
      { name: 'Local — on this machine, billed to your Cursor plan', value: 'local' },
      { name: 'Cloud — empty Cursor VM, no repo checkout, same plan', value: 'cloud' }
    ],
    covers: 'scripts, strategy, and SEO. Images and narration still need Gemini, OpenAI, or ElevenLabs. Requires Node.js 22.13+',
    save(credentials, apiKey, model) {
      credentials.aiProvider = {
        provider: 'cursor',
        apiKey,
        model,
        runtime: AI_PROVIDER_GUIDE.cursor.selectedRuntime || PROVIDERS.cursor.defaultRuntime
      };
    },
    validationCreds: (apiKey, model) => ({
      aiProvider: {
        provider: 'cursor',
        apiKey,
        model,
        runtime: AI_PROVIDER_GUIDE.cursor.selectedRuntime || PROVIDERS.cursor.defaultRuntime
      }
    })
  },
  claude: {
    label: 'Claude — Claude Pro/Max via Claude Code (not an Anthropic API key)',
    keyUrl: 'https://code.claude.com/docs/en/authentication',
    keyHint: 'Claude Code subscription login',
    auth: 'claude-cli',
    instructions: [
      'Install Claude Code',
      'Run claude auth login and sign in with your Pro or Max account',
      'Do not pass --console, and do not set ANTHROPIC_API_KEY (that switches billing to the API)',
      'Confirm with claude auth status. authMethod should be claude.ai'
    ],
    models: [...PROVIDERS.claude.models],
    defaultModel: PROVIDERS.claude.defaultModel,
    defaultRuntime: 'local',
    covers: 'scripts, strategy, and SEO on this machine. Cloud print mode is not available. Images and narration still need Gemini, OpenAI, or ElevenLabs',
    save(credentials, apiKey, model) {
      credentials.aiProvider = {
        provider: 'claude',
        apiKey,
        model,
        runtime: 'local'
      };
    },
    validationCreds: (apiKey, model) => ({
      aiProvider: { provider: 'claude', apiKey, model, runtime: 'local' }
    })
  },
  chatgpt: {
    label: 'ChatGPT — your ChatGPT plan via Codex (not an OpenAI API key)',
    keyUrl: 'https://developers.openai.com/codex/auth',
    keyHint: 'Codex ChatGPT sign-in',
    auth: 'codex-cli',
    instructions: [
      'The walkthrough checks for an existing ChatGPT sign-in through Codex',
      'If needed, it opens ChatGPT sign-in in your browser; finish signing in and return here',
      'Your connection is tested before this provider is saved'
    ],
    models: [...PROVIDERS.chatgpt.models],
    defaultModel: PROVIDERS.chatgpt.defaultModel,
    defaultRuntime: 'local',
    covers: 'scripts, strategy, and SEO with your ChatGPT plan. Images and narration need a separate provider',
    save(credentials, apiKey, model) {
      credentials.aiProvider = {
        provider: 'chatgpt',
        apiKey,
        model,
        runtime: 'local'
      };
    },
    validationCreds: (apiKey, model) => ({
      aiProvider: { provider: 'chatgpt', apiKey, model, runtime: 'local' }
    })
  },
  gemini: {
    label: 'Google Gemini — free text/TTS tiers; paid AI images',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'starts with "AIza"',
    instructions: [
      'Sign in with any Google account',
      'Click "Create API key"',
      'Copy the key it shows you'
    ],
    models: [...GEMINI_MODELS],
    defaultModel: GEMINI_DEFAULT_MODEL,
    covers: 'scripts + voice narration on supported free tiers; AI images require paid access',
    save(credentials, apiKey, model) {
      credentials.gemini = { apiKey, model };
      credentials.aiProvider = { provider: 'gemini', apiKey, model };
    },
    validationCreds: (apiKey, model) => ({ aiProvider: { provider: 'gemini', apiKey, model } })
  },
  openai: {
    label: 'OpenAI — paid text, image, and voice models',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'starts with "sk-"',
    instructions: [
      'Sign in (or create an account) and add billing',
      'Click "Create new secret key"',
      'Copy the key — it is shown only once'
    ],
    models: [...PROVIDERS.openai.models],
    defaultModel: PROVIDERS.openai.defaultModel,
    covers: 'scripts + images + voice narration',
    save(credentials, apiKey, model) {
      credentials.openai = { apiKey, model };
      credentials.aiProvider = { provider: 'openai', apiKey, model };
    },
    validationCreds: (apiKey, model) => ({ aiProvider: { provider: 'openai', apiKey, model } })
  },
  openrouter: {
    label: 'OpenRouter — one key, 400+ models (pay per use)',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'starts with "sk-or-"',
    instructions: [
      'Sign in and add a few dollars of credit',
      'Create a key and copy it'
    ],
    models: [...PROVIDERS.openrouter.models],
    defaultModel: 'google/gemini-3.8-flash',
    covers: 'scripts only (add a Gemini or OpenAI key for images/voice)',
    save(credentials, apiKey, model) {
      credentials.aiProvider = { provider: 'openrouter', apiKey, model };
    },
    validationCreds: (apiKey, model) => ({ aiProvider: { provider: 'openrouter', apiKey, model } })
  },
  kimi: {
    label: 'Kimi (Moonshot AI) — K3 and K2 family text models',
    keyUrl: 'https://platform.kimi.ai',
    keyHint: 'from the Moonshot platform console',
    instructions: ['Create an account', 'Open the API keys page and create a key'],
    models: [...PROVIDERS.kimi.models],
    defaultModel: PROVIDERS.kimi.defaultModel,
    covers: 'scripts only (add a Gemini or OpenAI key for images/voice)',
    save(credentials, apiKey, model) {
      credentials.aiProvider = { provider: 'kimi', apiKey, model };
    },
    validationCreds: (apiKey, model) => ({ aiProvider: { provider: 'kimi', apiKey, model } })
  },
  mimo: {
    label: 'MiMo (Xiaomi) — competitive pricing',
    keyUrl: 'https://mimo.mi.com',
    keyHint: 'from the MiMo console',
    instructions: ['Create an account', 'Create an API key in the console'],
    models: [...PROVIDERS.mimo.models],
    defaultModel: PROVIDERS.mimo.defaultModel,
    covers: 'scripts only (add a Gemini or OpenAI key for images/voice)',
    save(credentials, apiKey, model) {
      credentials.aiProvider = { provider: 'mimo', apiKey, model };
    },
    validationCreds: (apiKey, model) => ({ aiProvider: { provider: 'mimo', apiKey, model } })
  },
  glm: {
    label: 'GLM (Zhipu AI) — GLM-5 family text models',
    keyUrl: 'https://z.ai',
    keyHint: 'from the Z.ai console',
    instructions: ['Create an account', 'Create an API key in the console'],
    models: [...PROVIDERS.glm.models],
    defaultModel: PROVIDERS.glm.defaultModel,
    covers: 'scripts only (add a Gemini or OpenAI key for images/voice)',
    save(credentials, apiKey, model) {
      credentials.aiProvider = { provider: 'glm', apiKey, model };
    },
    validationCreds: (apiKey, model) => ({ aiProvider: { provider: 'glm', apiKey, model } })
  },
  deepseek: {
    label: 'DeepSeek — low-cost V4.1 Flash and V4 Pro text models',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'starts with "sk-"',
    instructions: ['Create an account and add credit', 'Create an API key and copy it'],
    models: [...PROVIDERS.deepseek.models],
    defaultModel: PROVIDERS.deepseek.defaultModel,
    covers: 'scripts only (add a Gemini or OpenAI key for images/voice)',
    save(credentials, apiKey, model) {
      credentials.aiProvider = { provider: 'deepseek', apiKey, model };
    },
    validationCreds: (apiKey, model) => ({ aiProvider: { provider: 'deepseek', apiKey, model } })
  },
  minimax: {
    label: 'MiniMax — M3 family text models',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    keyHint: 'from the MiniMax platform console',
    instructions: ['Create an account', 'Open Interface Key and create a key'],
    models: [...PROVIDERS.minimax.models],
    defaultModel: PROVIDERS.minimax.defaultModel,
    covers: 'scripts only (add a Gemini or OpenAI key for images/voice)',
    save(credentials, apiKey, model) {
      credentials.aiProvider = { provider: 'minimax', apiKey, model };
    },
    validationCreds: (apiKey, model) => ({ aiProvider: { provider: 'minimax', apiKey, model } })
  }
};

const VIDEO_PROVIDER_GUIDE = {
  slideshow: {
    label: 'Local slideshow — no external video charges',
    keyUrl: null,
    covers: 'local FFmpeg assembly using generated stills and narration'
  },
  seedance: {
    label: 'ByteDance Seedance 2.5 — cinematic 30-second multimodal scenes',
    keyUrl: 'https://replicate.com/account/api-tokens',
    credentialName: 'Replicate API token',
    save(credentials, value) { credentials.replicate = { ...(credentials.replicate || {}), apiKey: value }; }
  },
  minimax_h3: {
    label: 'MiniMax H3 — multimodal native-audio video up to 2K',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    credentialName: 'MiniMax API key',
    save(credentials, value) { credentials.minimax = { apiKey: value }; }
  },
  google_omni: {
    label: 'Google Gemini Omni Flash — fast conversational video generation',
    keyUrl: 'https://aistudio.google.com/apikey',
    credentialName: 'Gemini API key',
    save(credentials, value) { credentials.gemini = { ...(credentials.gemini || {}), apiKey: value }; }
  },
  kling: {
    label: 'Kuaishou Kling 3.0 Omni — storyboards and character performance',
    keyUrl: 'https://kling.ai/global/dev',
    credentialName: 'Kling access key',
    secretName: 'Kling secret key',
    save(credentials, value, secret) { credentials.kling = { accessKey: value, secretKey: secret }; }
  },
  wan: {
    label: 'Alibaba Wan 2.7 — efficient multimodal and continuation workflows',
    keyUrl: 'https://modelstudio.console.alibabacloud.com/',
    credentialName: 'DashScope API key',
    save(credentials, value) { credentials.wan = { apiKey: value }; }
  }
};

class SetupWalkthrough {
  constructor() {
    this.cm = new CredentialManager();
    this.totalSteps = 7;
  }

  header(step, title) {
    console.log(chalk.cyan.bold(`\n━━━ Step ${step} of ${this.totalSteps}: ${title} `.padEnd(62, '━')));
  }

  openBrowser(url) {
    const commands = {
      win32: `start "" "${url}"`,
      darwin: `open "${url}"`,
      linux: `xdg-open "${url}"`
    };
    const command = commands[process.platform];
    if (command) {
      exec(command, () => {}); // best effort — the URL is printed either way
    }
  }

  async connectChatGPT() {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once('SIGINT', onInterrupt);
    try {
      return await connectChatGPTSubscription({
        onOutput: text => process.stdout.write(text),
        signal: controller.signal,
      });
    } finally {
      process.removeListener('SIGINT', onInterrupt);
    }
  }

  async run() {
    console.log(chalk.cyan.bold('\n🧭 YouTube Automation Agent — Guided Walkthrough'));
    console.log(chalk.gray('═'.repeat(60)));
    console.log(chalk.white('This takes about 10–15 minutes and explains everything as you go.'));
    console.log(chalk.white('Every step can be skipped and finished later — your progress is'));
    console.log(chalk.white('saved after each step. Re-run any time with: ') + chalk.cyan('npm run walkthrough'));

    await this.cm.loadCredentials();
    await this.cm.loadTokens();

    try {
      await this.stepSystemCheck();
      await this.stepAIProvider();
      await this.stepImageProvider();
      await this.stepVideoProvider();
      await this.stepYouTube();
      await this.stepChannelBasics();
      await this.stepFinish();
    } catch (error) {
      if (error && (error.isTtyError || /User force closed/i.test(error.message || ''))) {
        console.log(chalk.yellow('\n\n👋 No problem — everything you completed is saved.'));
        console.log(chalk.cyan('Pick up where you left off with: npm run walkthrough'));
        return;
      }
      throw error;
    }
  }

  // ── Step 1: environment ────────────────────────────────────────────────
  async stepSystemCheck() {
    this.header(1, 'Checking your system');

    const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
    console.log(nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13)
      ? chalk.green(`  ✓ Node.js ${process.versions.node}`)
      : chalk.red(`  ✗ Node.js ${process.versions.node} — version 22.13+ is required (https://nodejs.org)`));

    const ffmpegOk = await checkFFmpeg();
    console.log(ffmpegOk
      ? chalk.green('  ✓ FFmpeg (video assembly)')
      : chalk.yellow(`  ✗ FFmpeg — ${ffmpegInstallHint()}`));

    const directories = [
      'config', 'logs', 'data', 'data/production', 'data/assets', 'data/videos',
      'data/audio', 'data/scripts', 'data/captions', 'temp/processing', 'uploads/thumbnails'
    ];
    for (const dir of directories) {
      await fs.mkdir(path.join(__dirname, dir), { recursive: true });
    }
    console.log(chalk.green('  ✓ Project folders'));

    const db = new Database();
    await db.initialize();
    await db.close();
    console.log(chalk.green('  ✓ Database'));

    // Create .env from a minimal template if the user doesn't have one yet
    try {
      await fs.access(path.join(__dirname, '.env'));
      console.log(chalk.green('  ✓ .env file'));
    } catch (error) {
      await fs.writeFile(path.join(__dirname, '.env'), [
        '# Created by the guided walkthrough — see .env.example for every option',
        'NODE_ENV=production',
        'PORT=3456',
        'LOG_LEVEL=info',
        'DEFAULT_PRIVACY_STATUS=private',
        ''
      ].join('\n'));
      console.log(chalk.green('  ✓ .env file created'));
    }
  }

  // ── Step 2: AI provider ────────────────────────────────────────────────
  async stepAIProvider() {
    this.header(2, 'Your AI text provider');

    if (this.cm.hasAITextProvider()) {
      const { redo } = await inquirer.prompt([{
        type: 'confirm',
        name: 'redo',
        message: 'An AI provider is already configured. Set up a different one?',
        default: false
      }]);
      if (!redo) return;
    } else {
      console.log(chalk.white('The agent needs one AI service. If you don\'t want to spend money,'));
      console.log(chalk.white('Google Gemini offers free tiers for supported text and TTS usage.'));
      console.log(chalk.white('AI image generation requires paid access; gradient visuals are the fallback.'));
    }

    const { providerId } = await inquirer.prompt([{
      type: 'list',
      name: 'providerId',
      message: 'Which AI provider do you want to use?',
      choices: Object.entries(AI_PROVIDER_GUIDE).map(([value, guide]) => ({ name: guide.label, value }))
    }]);

    const guide = AI_PROVIDER_GUIDE[providerId];

    console.log(chalk.cyan(`\nHow to connect (${guide.keyHint}):`));
    guide.instructions.forEach((line, i) => console.log(chalk.white(`  ${i + 1}. ${line}`)));
    if (guide.auth !== 'codex-cli') {
      console.log(chalk.white(`  → ${chalk.blue(guide.keyUrl)} (opening in your browser)`));
      this.openBrowser(guide.keyUrl);
    }
    console.log(chalk.gray(`  This covers: ${guide.covers}`));

    if (guide.runtimeChoices) {
      const runtimeAnswer = await inquirer.prompt([{
        type: 'list',
        name: 'runtime',
        message: 'Where should this provider run?',
        choices: guide.runtimeChoices,
        default: guide.defaultRuntime
      }]);
      guide.selectedRuntime = runtimeAnswer.runtime;
    } else {
      guide.selectedRuntime = guide.defaultRuntime || null;
      if (guide.auth === 'claude-cli') {
        console.log(chalk.gray('  Runtime: local. This provider has no print-mode cloud reply.'));
      }
    }

    if (guide.auth === 'codex-cli') {
      try {
        const connection = await this.connectChatGPT();
        console.log(chalk.green(connection.reused
          ? '  ✓ Using your existing ChatGPT sign-in.'
          : '  ✓ ChatGPT sign-in completed.'));
      } catch (error) {
        if (error.isTtyError) throw error;
        console.log(chalk.red(`  ✗ ${error.message}`));
        console.log(chalk.yellow('  ChatGPT was not saved. Choose it again after completing sign-in.'));
        return;
      }
    } else if (guide.auth === 'claude-cli') {
      const { ready } = await inquirer.prompt([{
        type: 'confirm',
        name: 'ready',
        message: 'Have you finished the subscription sign-in above?',
        default: true
      }]);
      if (!ready) {
        console.log(chalk.yellow('  Skipped — configure later with: npm run walkthrough'));
        return;
      }
    }

    if (guide.auth === 'claude-cli' || guide.auth === 'codex-cli') {
      const { model } = await inquirer.prompt([{
        type: 'list',
        name: 'model',
        message: 'Model to use:',
        choices: guide.models,
        default: guide.defaultModel
      }]);
      console.log(chalk.gray('  Testing the subscription login with a tiny request...'));
      const ok = await this.validateAIKey(guide, 'subscription', model);
      if (ok) {
        guide.save(this.cm.credentials, 'subscription', model);
        await this.cm.saveCredentials();
        console.log(chalk.green('  ✓ Subscription login works. Saved.'));
        return;
      }
      console.log(chalk.yellow('  Skipped — finish the login, then run: npm run walkthrough'));
      return;
    }

    while (true) {
      const { apiKey } = await inquirer.prompt([{
        type: 'password',
        name: 'apiKey',
        mask: '*',
        message: `Paste your ${providerId} API key (or leave empty to skip this step):`
      }]);

      if (!apiKey.trim()) {
        console.log(chalk.yellow('  Skipped — configure later with: npm run walkthrough'));
        return;
      }

      const { model } = await inquirer.prompt([{
        type: 'list',
        name: 'model',
        message: 'Model to use:',
        choices: guide.models,
        default: guide.defaultModel
      }]);

      console.log(chalk.gray('  Testing your key with a tiny request...'));
      const ok = await this.validateAIKey(guide, apiKey.trim(), model);

      if (ok) {
        guide.save(this.cm.credentials, apiKey.trim(), model);
        await this.cm.saveCredentials();
        console.log(chalk.green('  ✓ Key works! Saved.'));
        return;
      }

      const { retry } = await inquirer.prompt([{
        type: 'confirm',
        name: 'retry',
        message: 'That key didn\'t work. Try pasting it again?',
        default: true
      }]);
      if (!retry) {
        console.log(chalk.yellow('  Skipped — configure later with: npm run walkthrough'));
        return;
      }
    }
  }

  async validateAIKey(guide, apiKey, model) {
    // Temporarily clear provider env keys so the test hits exactly the pasted key
    const envKeys = [...Object.values(PROVIDERS).map(p => p.envKey), 'GEMINI_API_KEY'];
    const savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      const service = new AITextService(guide.validationCreds(apiKey, model));
      const reply = await service.generateText('Reply with the single word OK.', { maxTokens: 256, temperature: 0 });
      return typeof reply === 'string' && reply.length > 0;
    } catch (error) {
      console.log(chalk.red(`  ✗ ${error.message}`));
      return false;
    } finally {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }
  }

  async stepImageProvider() {
    this.header(3, 'Image generation (separate from video assembly)');
    console.log(chalk.white('Hosted images use paid API credit. Local generation needs a running image server and downloaded models.'));
    console.log(chalk.white('Keeping local slideshow video assembly does not supply images or voice narration.'));
    const db = new Database();
    await db.initialize();
    try {
      const current = await db.getAllSettings();
      const { providerId } = await inquirer.prompt([{
        type: 'list', name: 'providerId', message: 'Which image provider should the agent use?',
        default: current.image_provider || 'auto',
        choices: [
          { name: 'Keep automatic routing across configured providers (hosted calls may charge)', value: 'auto' },
          { name: 'fal.ai — paid per image', value: 'fal' },
          { name: 'Local image server — no provider fee', value: 'local' },
          { name: 'Google Gemini — paid image API, not the free text tier', value: 'gemini' },
          { name: 'OpenAI — paid image API', value: 'openai' },
          { name: 'Gradient backgrounds only — no image generation', value: 'none' }
        ]
      }]);
      if (providerId === 'local') {
        const { backend } = await inquirer.prompt([{
          type: 'list', name: 'backend', message: 'Local image server type:',
          default: current.local_image_backend || 'automatic1111',
          choices: [{ name: 'AUTOMATIC1111 / Forge (start with --api)', value: 'automatic1111' }, { name: 'ComfyUI (API-format workflow)', value: 'comfyui' }]
        }]);
        const answers = await inquirer.prompt([
          { type: 'input', name: 'url', message: 'Local image server base URL:', default: current.local_image_url || (backend === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860'), validate: value => { try { httpUrl(value, 'Server URL'); return true; } catch (error) { return error.message; } } },
          { type: 'input', name: 'workflow', message: 'ComfyUI API workflow file (use {{prompt}} and SaveImage):', when: () => backend === 'comfyui', default: current.comfyui_workflow_path || 'config/comfyui-image-workflow.json' }
        ]);
        await db.setSetting('local_image_backend', backend);
        await db.setSetting('local_image_url', httpUrl(answers.url, 'Server URL'));
        if (backend === 'comfyui') await db.setSetting('comfyui_workflow_path', answers.workflow);
      } else if (['fal', 'openai', 'gemini'].includes(providerId)) {
        const envKey = { fal: 'FAL_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' }[providerId];
        const { key } = await inquirer.prompt([{ type: 'password', name: 'key', mask: '*', message: `${providerId} API key (empty to keep an existing key):` }]);
        if (key.trim()) {
          this.cm.credentials[providerId] = { ...this.cm.credentials[providerId], apiKey: key.trim() };
          await this.cm.saveCredentials();
        } else if (!this.cm.credentials[providerId]?.apiKey && !process.env[envKey]) {
          console.log(chalk.yellow('  No key supplied; existing image settings kept.'));
          return;
        }
        if (providerId === 'fal') {
          const { model } = await inquirer.prompt([{ type: 'input', name: 'model', message: 'fal.ai image endpoint:', default: current.fal_image_model || 'fal-ai/flux/schnell', validate: value => /^[\w-]+\/[\w./-]+$/.test(value) && !value.split('/').includes('..') || 'Enter a fal model endpoint ID' }]);
          await db.setSetting('fal_image_model', model);
        }
      }
      await db.setSetting('image_provider', providerId);
      console.log(chalk.green('  Image settings saved. No image generation was requested.'));
      console.log(chalk.gray('  Verify image access in Production readiness; hosted image tests require its paid-image option.'));
    } finally { await db.close(); }
  }

  async stepVideoProvider() {
    this.header(4, 'Video generation provider');
    console.log(chalk.white('Long-form videos use hybrid assembly: selected AI clips plus local FFmpeg rendering.'));
    console.log(chalk.white('Local slideshow stays available and is the default so setup never spends credits unexpectedly.'));
    const { providerId } = await inquirer.prompt([{
      type: 'list',
      name: 'providerId',
      message: 'Which video provider should YouTube Automation Agent use?',
      choices: Object.entries(VIDEO_PROVIDER_GUIDE).map(([value, guide]) => ({ name: guide.label, value }))
    }]);
    const guide = VIDEO_PROVIDER_GUIDE[providerId];
    const db = new Database();
    await db.initialize();
    try {
      if (providerId === 'slideshow') {
        await db.setSetting('video_provider', 'slideshow');
        console.log(chalk.green('  ✓ Local slideshow selected.'));
        return;
      }
      console.log(chalk.white(`  → ${chalk.blue(guide.keyUrl)} (opening in your browser)`));
      this.openBrowser(guide.keyUrl);
      const answers = await inquirer.prompt([
        { type: 'password', name: 'key', mask: '*', message: `Paste your ${guide.credentialName} (empty to skip):` },
        { type: 'password', name: 'secret', mask: '*', message: `Paste your ${guide.secretName}:`, when: current => Boolean(guide.secretName && current.key) }
      ]);
      if (!answers.key?.trim()) {
        console.log(chalk.yellow('  Skipped — local slideshow remains selected.'));
        await db.setSetting('video_provider', 'slideshow');
        return;
      }
      guide.save(this.cm.credentials, answers.key.trim(), answers.secret?.trim());
      await this.cm.saveCredentials();
      await db.setSetting('video_provider', providerId);
      console.log(chalk.green(`  ✓ ${guide.label} selected.`));
      console.log(chalk.gray('  Run the paid video probe in Production readiness before enabling autonomous generation.'));
    } finally {
      await db.close();
    }
  }

  // ── Step 4: YouTube ────────────────────────────────────────────────────
  async stepYouTube() {
    this.header(5, 'Connecting your YouTube channel');

    if (this.cm.credentials.youtube && this.cm.tokens.youtube) {
      const { redo } = await inquirer.prompt([{
        type: 'confirm',
        name: 'redo',
        message: 'YouTube is already connected. Reconnect?',
        default: false
      }]);
      if (!redo) return;
    } else {
      console.log(chalk.white('This lets the agent upload to your channel. It\'s the fiddliest step,'));
      console.log(chalk.white('but it\'s free and you only do it once. You can also skip it — videos'));
      console.log(chalk.white('will still be generated locally in data/videos/.'));
    }

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: 'How do you want to proceed?',
      choices: [
        { name: '🧭 Walk me through creating the Google credentials (~5 min)', value: 'guided' },
        { name: '⚡ I already have a Client ID and Client Secret', value: 'have' },
        { name: '⏭️  Skip for now', value: 'skip' }
      ]
    }]);

    if (action === 'skip') {
      console.log(chalk.yellow('  Skipped — connect later with: npm run walkthrough'));
      return;
    }

    if (action === 'guided') {
      console.log(chalk.cyan('\nDo this in the browser tab that just opened:'));
      console.log(chalk.white('  1. Create a project (any name) — top bar → "New project"'));
      console.log(chalk.white('  2. Menu → "APIs & Services" → "Library" → search "YouTube Data API v3" → Enable'));
      console.log(chalk.white('  3. "APIs & Services" → "OAuth consent screen" → External → fill the 3 required'));
      console.log(chalk.white('     fields → add YOUR OWN email under "Test users"'));
      console.log(chalk.white('  4. "APIs & Services" → "Credentials" → "Create credentials" → "OAuth client ID"'));
      console.log(chalk.white('     → Application type: "Desktop app"'));
      console.log(chalk.white('  5. Copy the Client ID and Client Secret it shows you'));
      console.log(chalk.white(`  → ${chalk.blue('https://console.cloud.google.com/')}`));
      this.openBrowser('https://console.cloud.google.com/');
    }

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'clientId',
        message: 'Paste your Client ID (ends in .apps.googleusercontent.com, empty to skip):'
      },
      {
        type: 'password',
        name: 'clientSecret',
        mask: '*',
        message: 'Paste your Client Secret:',
        when: (a) => a.clientId.trim().length > 0
      }
    ]);

    if (!answers.clientId.trim()) {
      console.log(chalk.yellow('  Skipped — connect later with: npm run walkthrough'));
      return;
    }

    this.cm.credentials.youtube = {
      client_id: answers.clientId.trim(),
      client_secret: (answers.clientSecret || '').trim(),
      redirect_uris: ['http://127.0.0.1']
    };
    await this.cm.saveCredentials();

    console.log(chalk.cyan('\nNow let\'s sign in. A Google page will open — approve the access.'));
    console.log(chalk.gray('(You may see "Google hasn\'t verified this app" — click "Continue".'));
    console.log(chalk.gray(' That\'s expected: the "app" is your own Cloud project.)'));

    try {
      const { ModernAuth } = require('./modern-auth');
      const auth = new ModernAuth();
      await auth.authenticate();
      await this.cm.loadTokens();
      console.log(chalk.gray('  Checking which channel this is...'));
      await auth.testAuthentication();
    } catch (error) {
      console.log(chalk.red(`  ✗ Sign-in failed: ${error.message}`));
      console.log(chalk.yellow('  Your Client ID/Secret are saved — retry with: npm run walkthrough'));
    }
  }

  // ── Step 5: channel basics ─────────────────────────────────────────────
  async stepChannelBasics() {
    this.header(6, 'Channel & content basics');

    const existing = this.cm.credentials.channel || {};
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'channelName',
        message: 'What\'s your channel called?',
        default: existing.channelName || 'My Automated Channel'
      },
      {
        type: 'list',
        name: 'postingFrequency',
        message: 'How often should it post?',
        choices: [
          { name: 'Daily', value: 'daily' },
          { name: 'Every other day', value: 'every-2-days' },
          { name: '3 times per week', value: '3-per-week' },
          { name: 'Weekly', value: 'weekly' }
        ],
        default: this.cm.credentials.content?.postingFrequency || 'daily'
      },
      {
        type: 'input',
        name: 'targetAudience',
        message: 'Describe your target audience in one line:',
        default: this.cm.credentials.content?.targetAudience || 'General audience interested in educational content'
      }
    ]);

    this.cm.credentials.channel = {
      ...existing,
      channelName: answers.channelName,
      channelDescription: existing.channelDescription || 'Automated content channel',
      defaultCategory: existing.defaultCategory || '22',
      defaultPrivacy: existing.defaultPrivacy || 'private'
    };
    this.cm.credentials.content = {
      contentTypes: this.cm.credentials.content?.contentTypes || ['tutorial', 'explainer', 'list'],
      competitorChannels: this.cm.credentials.content?.competitorChannels || [],
      targetAudience: answers.targetAudience,
      postingFrequency: answers.postingFrequency,
      preferredPostTime: this.cm.credentials.content?.preferredPostTime || '14:00'
    };
    await this.cm.saveCredentials();

    console.log(chalk.green('  ✓ Saved.') + chalk.gray(' Uploads default to PRIVATE so you can review them first —'));
    console.log(chalk.gray('  set DEFAULT_PRIVACY_STATUS=public in .env when you\'re confident.'));
  }

  // ── Step 6: summary ────────────────────────────────────────────────────
  async stepFinish() {
    this.header(7, 'All set — here\'s what your pipeline can do');

    await this.cm.loadCredentials();
    await this.cm.loadTokens();
    const creds = this.cm.credentials;

    const hasText = this.cm.hasAITextProvider();
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const db = new Database();
    await db.initialize();
    let hasImages;
    try { hasImages = await new ImageGenerationService(creds, { db }).isAvailable(); } finally { await db.close(); }
    const hasNarration = Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY || hasGemini || creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY);
    const hasFFmpeg = await checkFFmpeg();
    const hasUpload = Boolean(creds.youtube && this.cm.tokens.youtube);
    const videoProviders = new VideoProviderRegistry(creds).list();
    const hasVideoProvider = videoProviders.some(provider => provider.available && provider.id !== 'slideshow');

    const rows = [
      { ok: hasText, name: 'Write scripts & pick topics', fix: 'step 2 (AI provider)' },
      { ok: hasImages, name: 'Image provider configured (access still needs a readiness test)', fix: 'step 3 — choose local generation or a hosted image provider' },
      { ok: hasNarration, name: 'Voice narration provider configured', fix: 'add Gemini, OpenAI, or ElevenLabs narration credentials' },
      { ok: hasFFmpeg, name: 'Assemble real .mp4 videos', fix: ffmpegInstallHint() },
      { ok: hasVideoProvider, name: 'Generate AI video clips', fix: 'step 4 — or keep the local slideshow provider' },
      { ok: hasUpload, name: 'Upload to YouTube', fix: 'step 5 (YouTube connection)' }
    ];

    for (const row of rows) {
      console.log(row.ok
        ? chalk.green(`  ✓ ${row.name}`)
        : chalk.yellow(`  ✗ ${row.name} — re-run the walkthrough: ${row.fix}`));
    }

    console.log(chalk.cyan.bold('\n🚀 Next steps:'));
    console.log(chalk.white('  1. npm start'));
    console.log(chalk.white('  2. Open http://localhost:3456 and press "Generate Content"'));
    console.log(chalk.white('     (or wait — it generates automatically every day at 6 AM)'));
    console.log(chalk.white('  3. Finished videos land in data/videos/ and upload as PRIVATE'));
    console.log(chalk.gray('\nChanged your mind about anything? Just run: npm run walkthrough'));
  }
}

if (require.main === module) {
  new SetupWalkthrough().run().catch(error => {
    console.error(chalk.red('\nWalkthrough failed:'), error.message);
    console.log(chalk.yellow('Your progress so far is saved — re-run: npm run walkthrough'));
    process.exit(1);
  });
}

module.exports = { SetupWalkthrough, AI_PROVIDER_GUIDE, VIDEO_PROVIDER_GUIDE };
