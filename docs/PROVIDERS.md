# Bring your own key (BYOK)

Reelforge does not resell model access. You point it at the model you already
pay for — or at one running on your own machine — and it records demos with that.
The catalog ships 31 providers, covering essentially every hosted inference API
worth using plus the local servers people actually run.

Two ways to configure it:

1. **Environment variables** — set once for the process, wins over everything.
2. **Dashboard → Settings → Providers** — paste a key per workspace. The key is
   encrypted before it reaches SQLite and is never returned by the API.

```
env var  >  workspace setting  >  auto-detect (env keys, then local servers)  >  nothing
```

With nothing configured, Reelforge still works end to end: the scripted planner
drives common flows and the offline TTS chain narrates them. BYOK upgrades the
brain, it is not a prerequisite.

---

## Which one should I pick?

- **If you have no key at all:** run [Ollama](#run-100-local-with-ollama) — no
  account, no key, nothing leaves the machine.
- **If you already have an `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
  `GROQ_API_KEY`** (or any other provider key) exported in your shell:
  do nothing. Reelforge auto-detects the first recognised key and uses it, and
  `GET /api/providers` reports `detected: true`.
- **If you are choosing fresh:** GMI Cloud is the maintainer's default and what
  this project is built against (`GMI_API_KEY`, OpenAI-compatible, model ids from
  the console). Groq, Google Gemini, Cerebras and GitHub Models have the most
  usable free tiers; OpenAI/Anthropic have the strongest vision models.
- **If you need a specific frontier model:** OpenRouter gives you one key for
  most vendors; Anthropic is supported natively (not just via a proxy).
- **Cost note:** Reelforge itself adds no markup. You pay your provider's rates,
  and free tiers change without notice — `tier` in the catalog is a hint, not a
  contract. A typical short demo is a few thousand tokens; a cheap model
  (GMI, Groq, Gemini Flash, DeepSeek) is usually the right default.

---

## Provider matrix

`tier` groups providers by the cheapest way to start: **free** means a usable
free tier or free models exist, **paid** means a funded account, **local** means
it runs on hardware you control. Every keyed provider also falls back to
`REELFORGE_LLM_API_KEY` as the last key variable.

### Free tier / free models

| Provider | `providerId` | Base URL | Key env var | Default model | Notes |
|---|---|---|---|---|---|
| Google Gemini | `google-gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-2.5-flash` | Uses Gemini's OpenAI-compatible endpoint; the `/openai` suffix is required and is already in the catalog. |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4` | One key for most vendors; several `:free` models cost no credits. |
| Groq | `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Generous free tier, very low latency; good for long demo runs. |
| Mistral AI | `mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | `mistral-large-latest` | Free "Experiment" tier for evaluation; production is pay-as-you-go. |
| Cerebras | `cerebras` | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | `llama-3.3-70b` | Free developer tier; extremely fast inference. |
| NVIDIA NIM | `nvidia-nim` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | `meta/llama-3.3-70b-instruct` | Free API credits for NVIDIA-hosted open models. |
| GitHub Models | `github-models` | `https://models.inference.ai.azure.com` | `GITHUB_TOKEN` (or `GH_TOKEN`) | `gpt-4o-mini` | Free with a PAT that has `models:read` (or a classic token with the `models` scope). Base URL has no `/v1`. |
| Hugging Face Router | `huggingface` | `https://router.huggingface.co/v1` | `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) | `meta-llama/Llama-3.3-70B-Instruct` | Free monthly inference credits; some router models need a `":provider"` suffix. |
| SambaNova | `sambanova` | `https://api.sambanova.ai/v1` | `SAMBANOVA_API_KEY` | `Meta-Llama-3.3-70B-Instruct` | Free developer tier with fast Llama hosting. |
| Alibaba DashScope (Qwen) | `dashscope` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen-plus` | Free quota on Alibaba Model Studio; international keys may need a region-specific host. |

### Paid

| Provider | `providerId` | Base URL | Key env var | Default model | Notes |
|---|---|---|---|---|---|
| GMI Cloud | `gmi` | `https://api.gmi-serving.com/v1` | `GMI_API_KEY` | *(discovered)* | **Maintainer's default.** Model ids come from the GMI console and look like `vendor/model-name`; leave the model empty to take the first id from `/models`. |
| OpenAI | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-4.1-mini` | Vision models read screenshots; smaller models fall back to DOM-only. |
| Anthropic (Claude) | `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` | **Native Messages API**, not OpenAI-compatible — Reelforge translates requests, responses and screenshot blocks. |
| DeepSeek | `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `deepseek-chat` | Very cheap reasoning/chat models. |
| xAI (Grok) | `xai` | `https://api.x.ai/v1` | `XAI_API_KEY` | `grok-4` | — |
| Together AI | `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Starter credits on signup; low-cost open-weight models. |
| Fireworks AI | `fireworks` | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | — |
| DeepInfra | `deepinfra` | `https://api.deepinfra.com/v1/openai` | `DEEPINFRA_API_KEY` | `meta-llama/Meta-Llama-3.1-70B-Instruct` | Pay-per-token; base URL includes `/v1/openai`. |
| Nebius AI Studio | `nebius` | `https://api.studio.nebius.ai/v1` | `NEBIUS_API_KEY` | `meta-llama/Meta-Llama-3.1-70B-Instruct` | — |
| Novita AI | `novita` | `https://api.novita.ai/v3/openai` | `NOVITA_API_KEY` | `meta-llama/llama-3.3-70b-instruct` | Base URL includes the `/v3/openai` compatibility path. |
| Hyperbolic | `hyperbolic` | `https://api.hyperbolic.xyz/v1` | `HYPERBOLIC_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct` | — |
| Moonshot (Kimi) | `moonshot` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | `moonshot-v1-8k` | — |
| Zhipu GLM | `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPUAI_API_KEY` (or `ZHIPU_API_KEY`) | `glm-4-plus` | OpenAI-compatible v4 path (contains `/paas/v4`). |
| Perplexity | `perplexity` | `https://api.perplexity.ai` | `PERPLEXITY_API_KEY` | `sonar` | Search-grounded chat; base URL has no `/v1` and `/models` is not always available. |
| Azure OpenAI | `azure-openai` | *(your resource deployment URL)* | `AZURE_OPENAI_API_KEY` | *(your deployment)* | `api-key` header + `api-version` query; needs `baseUrl` and the deployment name as `model`. See below. |

### Local / self-hosted

| Provider | `providerId` | Base URL | Key env var | Default model | Notes |
|---|---|---|---|---|---|
| Ollama | `ollama` | `http://127.0.0.1:11434/v1` | *(none)* | *(discovered)* | Runs on your machine. No key, no data leaves the box. Pull a vision-capable model for best results. |
| LM Studio | `lmstudio` | `http://127.0.0.1:1234/v1` | *(none)* | *(discovered)* | Start the local server in LM Studio. |
| llama.cpp server | `llamacpp` | `http://127.0.0.1:8080/v1` | *(none)* | *(discovered)* | `llama-server --host 127.0.0.1 --port 8080` exposes an OpenAI-compatible `/v1`. |
| vLLM | `vllm` | `http://127.0.0.1:8000/v1` | *(none)* | *(discovered)* | `vllm serve <model>`. |
| LocalAI | `localai` | `http://127.0.0.1:8080/v1` | *(none)* | *(discovered)* | LocalAI's OpenAI-compatible API. |
| Custom gateway | `custom` | *(you set it)* | `REELFORGE_LLM_API_KEY` | *(you set it)* | Any gateway speaking `/chat/completions` — LiteLLM, an internal proxy, a hosted clone. |

Shared environment variables:

| Variable | Meaning |
|---|---|
| `REELFORGE_LLM_PROVIDER` | A `providerId` from the tables above, `auto` (default), or `none`. |
| `REELFORGE_LLM_API_KEY` | Key fallback shared by every provider, and the only key var `custom` reads. A lone shared key maps to OpenAI (0.1 compatibility). |
| `REELFORGE_LLM_BASE_URL` | Override the base URL (auto-selects `custom` when no provider is named). Also required for `azure-openai`. |
| `REELFORGE_LLM_MODEL` | Override the model id. Empty means the catalog default, or live discovery for providers with no default. |
| `REELFORGE_LLM_TIMEOUT_MS` | Planner request timeout (default 60000). |
| `REELFORGE_LLM_LOCAL_PROBE` | `off` disables the local-server auto-probe. |
| `REELFORGE_WORKSPACE_ID` | Workspace used by a headless/worker process when it needs dashboard settings. |
| `REELFORGE_TTS_PROVIDER` / `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` | Narration BYOK, same precedence rules. |

---

## Auto-detect: no configuration at all

When `REELFORGE_LLM_PROVIDER` is unset (or `auto`) and the workspace has no
provider override, Reelforge:

1. scans the catalog in **catalog order** for provider-specific key variables and
   picks the first one present;
2. if none is present, probes local servers (`ollama`, `lmstudio`, `llamacpp`,
   `vllm`, `localai`) with a 450 ms `/models` request, in that order, and caches
   the answer for 60 seconds;
3. if neither exists, stays on the offline scripted planner.

The priority is therefore the order in the tables: **gmi, openai, anthropic,
google-gemini, openrouter, groq, deepseek, mistral, xai, together, fireworks,
cerebras, nvidia-nim, github-models, huggingface, sambanova, deepinfra, nebius,
novita, hyperbolic, moonshot, zhipu, dashscope, perplexity, azure-openai**
(azure is skipped unless a base URL is supplied; its key alone cannot guess the
resource URL), then the local probe, then `none`.

So if `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GROQ_API_KEY` are all exported,
**OpenAI wins** (it comes first). Set `REELFORGE_LLM_PROVIDER=groq` to choose
explicitly — an explicit choice always wins and reports `detected: false`.

`GET /api/providers` exposes the result: `llm.active.detected` is `true` when a
key/local server was found automatically, and the matching provider card also has
`detected: true`. The status route refreshes the cached local probe, so opening
the dashboard is enough to pick up a server you just started. To test a local
endpoint manually without relying on the probe, use `POST /api/providers/test`.

---

## Transport quirks are catalog data

Providers disagree about how to carry a key and where their endpoint lives. Those
differences are fields on the catalog entry, used by both the planner and the
connection test:

| Field | Meaning | Used by |
|---|---|---|
| `protocol` | `openai-chat` (default) or `anthropic-messages`. | Anthropic |
| `authStyle` | `bearer` (default) → `Authorization: Bearer`, `api-key-header` → `api-key:`, `x-api-key` → `x-api-key:`. | Azure (`api-key`), Anthropic (`x-api-key`) |
| `pathSuffix` | Appended to `baseUrl` for chat. Defaults to `/chat/completions` (`/messages` for Anthropic). | Per provider |
| `extraQuery` | Query params added to every request. Values support `${NAME}` / `${NAME:-default}`. | Azure's `api-version` |
| `extraHeaders` | Static headers. Same env template syntax. | Anthropic's `anthropic-version` |
| `userSuppliedBaseUrl` | The URL cannot be guessed; the user must provide it. | Azure, custom |

### Anthropic (native Messages API)

Anthropic is not OpenAI-compatible, so Reelforge translates in both directions:

- OpenAI-shaped `system` messages become the top-level `system` string;
- chat messages stay `user`/`assistant` (no `system` in `messages`);
- `max_tokens` is always sent (required by Anthropic);
- OpenAI `image_url` parts become Anthropic `{ type: "image", source: … }` blocks,
  with `data:` URLs decoded to `base64` + `media_type` (screenshots work);
- the response's `content[].text` blocks are joined back into the planner's
  expected text.

Nothing else changes: `REELFORGE_LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` is
the whole setup. Model discovery uses `GET /v1/models` with the same headers.

### Azure OpenAI

Azure needs a customer-specific URL, an `api-key` header and an `api-version`
query:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_API_VERSION=2025-04-01-preview   # optional; this is the default
# base = https://<resource>.openai.azure.com/openai/deployments/<deployment>
export REELFORGE_LLM_PROVIDER=azure-openai
export REELFORGE_LLM_BASE_URL=https://my-resource.openai.azure.com/openai/deployments/my-gpt-4o
export REELFORGE_LLM_MODEL=my-gpt-4o        # the deployment name, not the model name
node --env-file-if-exists=.env packages/api/src/server.ts
```

The request goes to
`{base}/chat/completions?api-version=2025-04-01-preview` with `api-key: …` — no
`Authorization` header. `/models` discovery is not meaningful on a deployment
URL, so set the model (deployment) explicitly.

### Not supported: AWS Bedrock and Google Vertex AI

These are deliberately **not** in the catalog and Reelforge does not pretend
otherwise: they authenticate with AWS SigV4 request signing and Google service
account OAuth respectively, not an API key. Supporting them needs a native
signing adapter. As a workaround, expose them through an OpenAI-compatible proxy
(LiteLLM, an internal gateway) and point `providerId: "custom"` at that proxy.

---

## Run 100% locally

### Ollama

```bash
# 1. Install Ollama, then start the server (it usually runs as a service already).
ollama serve

# 2. Pull a chat model. A vision model reads screenshots and usually plans better.
ollama pull llama3.2-vision:11b

# 3. Point Reelforge at it. Ollama exposes an OpenAI-compatible /v1 path.
REELFORGE_LLM_PROVIDER=ollama \
REELFORGE_LLM_MODEL=llama3.2-vision:11b \
  node --env-file-if-exists=.env packages/api/src/server.ts
```

Or do the same from the dashboard: **Settings → Providers → Ollama (local)**.
The base URL is prefilled, it needs no key, and **Fetch models** lists what you
have pulled. Even with no configuration at all, the local probe detects a
running Ollama and reports it as `detected: true`.

Notes:

- Ollama answers on `127.0.0.1:11434/v1/models`, so discovery and the model
  picker work exactly as they do for hosted providers.
- Local models are slower on the first request (weights load into RAM/VRAM).
  Raise `REELFORGE_LLM_TIMEOUT_MS` (e.g. `120000`) if runs degrade right after
  startup.
- Narration can stay fully offline as well — leave `REELFORGE_TTS_PROVIDER=auto`
  and the renderer uses `edge-tts` if installed, then Windows SAPI.

### llama.cpp / vLLM / LocalAI

All three expose an OpenAI-compatible `/v1` and need no key:

```bash
# llama.cpp (port 8080 is the catalog default)
llama-server --host 127.0.0.1 --port 8080 -m model.gguf

# vLLM (port 8000)
vllm serve <model>

# LocalAI (port 8080 by default)
local-ai run
```

Then choose the matching card in Settings → Providers (or set
`REELFORGE_LLM_PROVIDER=llamacpp|vllm|localai`). The local probe also detects
them automatically if you leave the provider unset.

---

## API

All routes require the usual `X-API-Key: rg_…`. Success uses Director's
`{ message, data }` envelope.

| Method & path | Body / query | Returns (`data`) |
|---|---|---|
| `GET /api/providers` | — | `{ llm: { active, providers[] }, tts: { active, providers[] } }` (refreshes the local probe) |
| `POST /api/providers` | `{ llm?: { providerId, apiKey?, model?, baseUrl? }, tts?: { providerId, voice? } }` | same as `GET`, refreshed |
| `DELETE /api/providers` | — | same as `GET` after clearing every workspace override |
| `GET /api/providers/models` | `?provider=gmi&baseUrl=…` | `{ models: string[], source: "live" \| "default" }` |
| `POST /api/providers/test` | `{ providerId, apiKey?, baseUrl?, model? }` | `{ ok, latencyMs, model, error }` |

Provider cards carry `tier` (`free` | `paid` | `local`) and `detected` (true when
auto-detect chose that provider). `llm.active` carries
`{ providerId, model, baseUrl, source, detected }`; `source` is `env`,
`workspace` or `none`.

```bash
# Save a key (stored encrypted, response only carries a hint)
curl -X POST http://127.0.0.1:4400/api/providers \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{"llm":{"providerId":"gmi","apiKey":"gmi_...","model":"vendor/model-name"}}'
# → data.llm.providers[gmi].keyHint = "gmi…xxxx"; the key itself is never returned

# Probe it before recording
curl -X POST http://127.0.0.1:4400/api/providers/test \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{"providerId":"gmi","model":"vendor/model-name"}'
# → {"message":"Connection OK in 412ms (vendor/model-name)","data":{"ok":true,"latencyMs":412,"model":"vendor/model-name","error":null}}

# What does the provider actually expose? (proxied server-side, no key in the URL)
curl "http://127.0.0.1:4400/api/providers/models?provider=openai" \
  -H "X-API-Key: $REELFORGE_API_KEY"

# Clear the dashboard override; env variables (if any) take over again
curl -X DELETE http://127.0.0.1:4400/api/providers -H "X-API-Key: $REELFORGE_API_KEY"
```

`POST /api/providers` details:

- `llm.providerId` is required; `"none"` clears the workspace override.
- Switching provider resets the stored model/base URL/key — the new provider's
  defaults apply, and anything you send in the same request is written after.
- `apiKey: ""` clears the stored key without switching provider; omitting
  `apiKey` keeps it.
- `baseUrl` is validated as an absolute `http(s)` URL; empty clears the override.
  It is required for `custom` and `azure-openai`.
- A provider-side probe failure is **not** an HTTP error: `/test` returns `200`
  with `{ ok:false, error:{ code, message, hint? } }` so the UI can render the
  remedy. Invalid request bodies still return `VALIDATION_ERROR` (400).

---

## Key handling

- Workspace keys are encrypted with **AES-256-GCM** (`core/crypto.ts`,
  `encryptJson`) before insert into `workspace_settings.value_json`; the format is
  `v1.<iv>.<tag>.<ciphertext>`. They are decrypted only to resolve a provider,
  probe it, or compute the masked hint.
- The encryption key is a 32-byte random keyfile at `data/.secret` (mode 0600),
  generated on first use. **Back it up with `data/`** — without `.secret` the
  stored keys cannot be recovered. Rotating `.secret` invalidates every stored
  provider key (re-enter them).
- The API **never** returns a stored key. `GET/POST /api/providers` return
  `keyHint` only, e.g. `sk-…abcd` (first 3 + last 4 characters). There is no
  endpoint that echoes a key.
- Env vars (`REELFORGE_LLM_API_KEY`, `GMI_API_KEY`, …) are read into memory and
  never written to the database, logs, demo metadata, or error messages.
- Every workspace can have its own provider and key. Resolution is scoped to the
  authenticated workspace on the API; the processing worker reads the workspace
  override when exactly one workspace exists (the normal self-hosted setup). In a
  multi-tenant deployment set `REELFORGE_WORKSPACE_ID` per worker process, or run
  one worker per workspace, so a job never resolves another tenant's key.
- Keys in browser forms are sent only to your Reelforge API over its configured
  origin; the dashboard stores nothing about them locally.

---

## Troubleshooting

Everything below surfaces as a typed error, never a crash — in the dashboard, on
`POST /api/providers/test`, and in the demo log line `[planner] … fell back`
(the demo keeps running on the scripted planner).

| Symptom / code | Likely cause | Fix |
|---|---|---|
| `PROVIDER_UNAUTHORIZED` / HTTP **401** (or 403) | Wrong, expired or revoked key; key from another provider pasted; `Bearer ` accidentally included in the value. | Paste the raw key from the provider console. Test connection in Settings → Providers. |
| `PROVIDER_NOT_FOUND` / HTTP **404** | Wrong base URL — missing/duplicated `/v1`; wrong region; retired model id; wrong Azure deployment path. | Base URLs are in the tables above. For Azure the path must be `/openai/deployments/<deployment>`. Re-fetch models. |
| HTTP **400** from Anthropic | `max_tokens` missing or malformed translated body — should not happen through Reelforge; check the model id. | Update Reelforge; report the request id. |
| `PROVIDER_TIMEOUT` | Cold local model loading, oversized model, network stall, or a gateway that accepted the socket but never answered. | Wait for first load; raise `REELFORGE_LLM_TIMEOUT_MS`; check the server is not swapping. |
| `PROVIDER_UNREACHABLE` | Nothing listening (Ollama/LM Studio not started), DNS failure, proxy/TLS interception, VPN. | Start the local server; `curl {baseUrl}/models` from the same machine. |
| `PROVIDER_RATE_LIMITED` / HTTP **429** | Provider plan/quota or per-minute limit. | Retry later, switch to a smaller model, or use a local model for that run. |
| `PROVIDER_BAD_RESPONSE` | The URL serves HTML, the provider is not OpenAI-compatible, `/models` returned empty, or the protocol is wrong. | Point the base URL at the right API root. Anthropic must use the `anthropic` provider (native adapter), not `custom`. |
| `PROVIDER_CONFIG` | No key, no base URL, or no model could be discovered. | Save a key/base URL, or pick a model explicitly. |
| Auto-detect picked the wrong provider | Multiple keys are exported; catalog order chooses the first. | Set `REELFORGE_LLM_PROVIDER` explicitly. |
| Demo logs `fell back` | The endpoint worked for `/test` but failed mid-run; Reelforge continues with the scripted planner. | Inspect the log line, then re-run after fixing the provider. |

Quick manual checks:

```bash
# Is the API seeing a provider, and from where?
curl http://127.0.0.1:4400/api/providers -H "X-API-Key: $REELFORGE_API_KEY"

# What does the provider actually expose? (proxied server-side, no key in the URL)
curl "http://127.0.0.1:4400/api/providers/models?provider=openai" \
  -H "X-API-Key: $REELFORGE_API_KEY"
```

A `401` means "the provider did not accept the credential"; `404` means "that URL
has no such endpoint"; a timeout means "something accepted the connection but did
not answer in time". Those three cover almost every BYOK setup problem.
