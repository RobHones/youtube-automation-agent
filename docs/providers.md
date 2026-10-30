# AI providers

YouTube Automation Agent can bill text generation to a subscription you already pay for, or to a pay-as-you-go API key. One text provider is enough to start. Narration, images, and AI video stay on their own providers. Pick a provider in `npm run walkthrough`, or set it in `.env` ([`.env.example`](../.env.example) documents every setting).

## Subscription text

These three write scripts, strategy, and SEO. They do not generate narration or images. An ambient `CURSOR_API_KEY` is not enough on its own; Cursor also needs `CURSOR_RUNTIME`.

| Provider | Where it runs | How you sign in | Env vars |
| --- | --- | --- | --- |
| **Cursor** | `local` (agent loop on this machine) or `cloud` (an empty Cursor VM, no repo and no pull request) | User API key from [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations) | `CURSOR_API_KEY` and `CURSOR_RUNTIME=local` or `cloud`. Optional `CURSOR_MODEL` (`composer-2.5` or `auto`) |
| **Claude** | Local only | `claude auth login` with Claude Pro or Max. Do not pass `--console` | `CLAUDE_RUNTIME=local`. Optional `CLAUDE_MODEL` (`sonnet`, `opus`, `haiku`, or `fable`) |
| **ChatGPT** | Local only | `codex login` with no flags, using your ChatGPT plan | `CODEX_RUNTIME=local`. Optional `CODEX_MODEL` (`gpt-5.6-luna` or `gpt-5.6-terra`) |

The app requires Node.js 22.13 or newer, matching its current dependencies. Cursor text generation also needs the optional `@cursor/sdk` package (`npm install`).

Claude has cloud sessions, but `claude -p` rejects `--cloud` when the command includes a task, so this app cannot collect a cloud reply. Sign in with the Claude Code CLI. The adapter checks `claude auth status` and accepts subscription OAuth authentication only. It removes API keys, API auth tokens, custom endpoints, and third-party provider routing variables from the child process environment. `--bare` is not used, because bare mode does not read the subscription login.

Selecting ChatGPT in `npm run walkthrough` checks your existing Codex sign-in. If needed, the walkthrough starts `codex login` and opens the real ChatGPT sign-in flow, then verifies the login and makes a small text request before saving the provider. It reuses an existing ChatGPT login automatically. If Codex is missing, it shows the install command.

ChatGPT cloud tasks exist as `codex cloud exec`, and that command requires a cloud environment id and only submits the task. It does not return the script, so text generation stays on local `codex exec`. Do not sign in with `codex login --with-api-key`. The adapter checks `codex login status` for ChatGPT authentication and removes `OPENAI_API_KEY`, `CODEX_API_KEY`, and `OPENAI_BASE_URL` from the child process environment. Text generation leaves the shared CLI login unchanged.

Each request uses a separate temporary directory, cleaned up after completion. Generation has a ten-minute timeout; CLI timeouts terminate the child process tree, and Cursor timeouts cancel the run. Claude and Codex authentication checks have a separate 30-second timeout. Saved provider choices take precedence over environment settings; rerun the walkthrough to switch providers while keeping your image and narration credentials.

```env
# Cursor — both required
CURSOR_API_KEY=cursor_...
CURSOR_RUNTIME=local
CURSOR_MODEL=composer-2.5

# Claude — after `claude auth login`
CLAUDE_RUNTIME=local
CLAUDE_MODEL=sonnet

# ChatGPT — after `codex login`
CODEX_RUNTIME=local
CODEX_MODEL=gpt-5.6-luna
```

## Text API keys

Pick one in the walkthrough, or set its key in `.env`. The SDK base URL is configured for you.

| Provider | Models | Key | Env var |
| --- | --- | --- | --- |
| **Google Gemini** | Gemini 3.8 Flash, Gemini 4 Argon (paid only), 3.5 Flash-Lite | [AI Studio](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` |
| **OpenAI** | GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna | [platform.openai.com](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| **OpenRouter** | 400+ models through one key; curated defaults are checked against its live catalog | [openrouter.ai](https://openrouter.ai/keys) | `OPENROUTER_API_KEY` |
| **Kimi (Moonshot AI)** | Kimi K3, K2.7 Code, K2.6 | [platform.kimi.ai](https://platform.kimi.ai) | `MOONSHOT_API_KEY` |
| **MiMo (Xiaomi)** | MiMo V2.6 Pro, V2.6 Flash | [mimo.mi.com](https://mimo.mi.com) | `MIMO_API_KEY` |
| **GLM (Zhipu AI)** | GLM-5.3, 5.3 Flash, 5.2 | [z.ai](https://z.ai) | `GLM_API_KEY` |
| **DeepSeek** | DeepSeek V4.1 Flash, V4 Pro | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | `DEEPSEEK_API_KEY` |
| **MiniMax** | MiniMax M3.1 Flash, M3 | [platform.minimax.io](https://platform.minimax.io/user-center/basic-information/interface-key) | `MINIMAX_TEXT_API_KEY` |

Anthropic Claude is available through OpenRouter (`anthropic/claude-fable-5.1`). OpenRouter, Kimi, MiMo, GLM, DeepSeek, and MiniMax cover scripts only. Add a Gemini or OpenAI key for images and narration, or ElevenLabs for narration.

## Narration and images

- **Narration** uses the first configured provider in this order: ElevenLabs (Eleven v3, needs `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`), OpenAI (`gpt-4o-mini-tts`), then Gemini (`gemini-3.8-flash-tts`). A video without working narration can't be approved.
- **Images** are selected separately in **Channel setup** or the walkthrough's image step: OpenAI, Gemini, fal.ai, a local image server, automatic routing, or gradient backgrounds. Image generators also support scene repairs and the production thumbnail generator. The built-in thumbnail designer can still produce gradient-and-text designs.

### Image providers

| Selection | Requirements | Cost model |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY`; project calls GPT Image 2 | Paid API usage |
| Gemini | `GEMINI_API_KEY`; default `gemini-3.1-flash-image` | Paid image API quota; this model has no free tier |
| fal.ai | `FAL_KEY` or a key saved privately through Channel setup | Paid per model's pricing; default `fal-ai/flux/schnell` |
| Local | A separately running AUTOMATIC1111/Forge-compatible API or ComfyUI with models installed | No hosted provider fee; uses your hardware, electricity, and disk space |
| Gradient backgrounds | No image service | No image-generation charges |

**Automatic** tries configured OpenAI, Gemini, fal.ai, then local. Hosted calls can charge. An explicit selection only calls that provider: **Local** never falls back to a paid provider. `IMAGE_PROVIDER` in `.env` overrides the dashboard selection; otherwise dashboard settings take effect on the next image request without a restart. API keys added to `.env` require restarting the app. Saved fal keys are stored in `config/credentials.json`, never returned to the dashboard.

For fal.ai, choose **fal.ai** under **Channel setup → Image provider**, paste the key in its password field, and save. You can also set `FAL_KEY` in `.env`. The default endpoint produces widescreen images; compatible alternative fal text-to-image endpoints can be specified with `FAL_IMAGE_MODEL` or the model field. Endpoints with different input/output schemas need a separate adapter. See the [fal endpoint/API reference](https://fal.ai/models/fal-ai/flux/schnell/api) and its current pricing before generating. Authentication uses the queue API; returned queue URLs are polled, then the actual image is downloaded and decoded. A timeout requests cancellation; check fal request history before retrying because an already running request can still incur charges.

For local AUTOMATIC1111/Forge-compatible generation:

1. Install an image server and a compatible checkpoint, then start its API (`--api` for AUTOMATIC1111).
2. In **Channel setup**, select **Local image server**, backend **AUTOMATIC1111 / Forge API**, and its base URL (usually `http://127.0.0.1:7860`).
3. Save and run **Production readiness**. It makes a real local image without enabling the paid-image checkbox.

For local ComfyUI:

1. Run ComfyUI with the image model/workflow you want to use. This integration does not install ComfyUI or download checkpoints.
2. Export an **API-format** workflow, with a `SaveImage` output node. Put `{{prompt}}` in the positive text prompt. Optional `{{seed}}`, `{{width}}`, and `{{height}}` placeholders are substituted as typed values. Workflows with only previews or UI-format graphs are not accepted.
3. Save it as `config/comfyui-image-workflow.json` (or use another path). The provided `config/comfyui-image-workflow.example.json` illustrates a basic Stable Diffusion workflow; replace its checkpoint filename with an installed compatible model. Other model families require their own exported workflow.
4. Select **Local image server → ComfyUI**, set the base URL (usually `http://127.0.0.1:8188`) and the workflow path, then save.

The adapter submits a workflow, polls only its prompt ID, and retrieves its output through ComfyUI's API. It does not interrupt other workflows on timeout. The small local default is 768×432; custom ComfyUI workflows can use fixed dimensions instead of placeholders. Runtime depends on the model, backend, GPU support, and available memory; benchmark your machine before choosing an upload cadence. Checkpoints and their licenses are separate from the image-server software.

Local image generation and **Local slideshow** are different: the image server creates pictures, and the slideshow assembles them into MP4s. fal.ai/local image choices do not provide narration; keep a separate working narration provider. Readiness skips paid image calls unless **Include paid image probe** is enabled, but can verify configured local generation without it. Image outputs must decode successfully before they are used; unavailable services retain the existing gradient fallback.

## Research

Automatic research uses your ChatGPT (Codex) or Claude (Claude Code) subscription to find and open sources before a documentary is written, then audits the finished text before any narration or visuals are generated. Research is off by default because it turns every generation into an evidence-backed historical documentary. Turn it on under **Channel setup → Research subscription** (or with `RESEARCH_PROVIDER`). `auto` uses the configured ChatGPT or Claude text subscription and stays off without one. Research is the only subscription mode with web access. It allows web search and page retrieval only, and normal writing requests stay text-only.

1. **Fact pack.** The worker returns sources with short verbatim passages and page or section locations, plus atomic claims linked to those passages. Faulty evidence is left out rather than failing the topic: a source that wasn't opened during the run, duplicates another, or doesn't contain its passage is dropped, and so is any claim that is compound, contested, not backed by its passage, or high-risk without two independent evidence origins (copies of one account count once). Gaps the worker reports become limitations that the script must not contradict. Research only fails when fewer than `RESEARCH_MIN_CLAIMS` (default 5) verified facts remain, and then the next candidate topic is tried.
2. **Grounded writing.** The script and metadata may use only facts from the pack. Template fallbacks are disabled for researched documentaries.
3. **Audit.** A separate pass splits all audience-facing text (narration, title, description, tags, thumbnail wording) into units and classifies each one. Every factual unit must link to supported claims. Failed audits trigger a bounded number of automatic rewrites.
4. **Approval.** Review Studio shows the audited sources, claims and any exceptions as read-only. The audit is the only fact review, so nothing needs checking by hand. Editing audited text makes the audit stale, and approval and upload stay blocked until **Run research audit** passes again. Media-rights confirmation and approval (if `approval_required` is on) still apply as for any video.

Scheduled runs stay off until you've trialled researched episodes and enabled **daily research** in Channel setup (or set `RESEARCH_SCHEDULED_ENABLED=true`). Research counts against your subscription's usage limits.

ChatGPT research doesn't capture page text, so its passages are matched against the worker's own sources rather than against the downloaded page. Claude's WebFetch results are captured, and each passage is also checked against them. Claude gives the stronger check if you want passages matched against the real page.

## Video

Local slideshow rendering is the default, so you never pay for video unless you choose a provider in **Channel setup** and set a paid-seconds cap. If a provider fails, the video falls back to the local slideshow.

| Provider | Default model | Best fit | Clip limits | Env var |
| --- | --- | --- | --- | --- |
| ByteDance | `bytedance/seedance-2.5` through Replicate | Cinematic long scenes and large reference sets | 4–30 seconds | `REPLICATE_API_TOKEN` |
| MiniMax | `MiniMax-H3` | Multimodal references, native stereo audio, optional 2K | 4–15 seconds | `MINIMAX_API_KEY` |
| Google | `gemini-omni-1.1-flash` | Fast generation and conversational editing | 3–10 seconds | `GEMINI_API_KEY` |
| Kuaishou | `kling-v3-omni` | Storyboards and character/voice consistency | 3–15 seconds | `KLING_ACCESS_KEY`, `KLING_SECRET_KEY` |
| Alibaba | Wan 2.7 task-specific models | Efficient generation, reference video, and continuation | 2–15 seconds | `DASHSCOPE_API_KEY` |

Long videos use hybrid assembly: generated clips for the hook and key sections, with the rest of the timeline filled locally. See [AI video generation](features.md#ai-video-generation).

## Environment variables

`npm run walkthrough` writes your configuration for you. To edit it by hand, copy [`.env.example`](../.env.example) to `.env`. The essentials:

```env
# One text provider (see the table above)
GEMINI_API_KEY=...

# Optional: narration, images, and AI video
# ELEVENLABS_API_KEY=...
# ELEVENLABS_VOICE_ID=...
# OPENAI_API_KEY=sk-...
# VIDEO_PROVIDER=slideshow   # auto, seedance, minimax_h3, google_omni, kling, wan
# VIDEO_MAX_GENERATED_SECONDS=60

# App
PORT=3456
# HOST=127.0.0.1             # default: this machine only
# API_KEY=some-long-random-string
CHANNEL_NAME=Your Channel Name
DEFAULT_PRIVACY_STATUS=private
```

The dashboard listens on `127.0.0.1` by default. If you set `HOST=0.0.0.0` to reach it from other devices, also set `API_KEY`, which every request that changes something must then send in the `x-api-key` header.

## Adding a provider

See [Extending](../CONTRIBUTING.md#extending) in the contributing guide for how to add a text or video provider.

## Acknowledgments

- [Google](https://ai.google.dev/): Gemini 3.8 Flash, Gemini 4 Argon, Gemini 3.1 Flash Image, Gemini 3.8 Flash TTS, Gemini Omni Flash, and the YouTube Data and Analytics APIs
- [OpenAI](https://openai.com/): GPT-6.1 Sol, GPT Image 2, gpt-4o-mini-tts
- [OpenRouter](https://openrouter.ai/): unified multi-model API
- [Moonshot AI](https://www.moonshot.ai/): Kimi K3
- [Xiaomi](https://mimo.mi.com/): MiMo V2.6 Pro
- [Zhipu AI](https://z.ai/): GLM-5.3
- [DeepSeek](https://www.deepseek.com/): DeepSeek V4.1 Flash
- [MiniMax](https://www.minimax.io/): MiniMax M3 text and H3 video
- [ElevenLabs](https://elevenlabs.io/): Eleven v3 TTS
- [Replicate](https://replicate.com/): Seedance 2.5 and Wan 2.7 hosting
- [Kuaishou Kling](https://kling.ai/): Kling 3.0 Omni
- [Alibaba Cloud Model Studio](https://modelstudio.console.alibabacloud.com/): Wan 2.7
