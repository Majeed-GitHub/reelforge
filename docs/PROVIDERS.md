# Bring your own key (BYOK)

Reelforge does not resell model access. You point it at the model you already
pay for — or at one running on your own machine — and it records demos with that.
Every supported provider speaks the same OpenAI-compatible
`POST {baseUrl}/chat/completions` protocol, so one planner implementation covers
all of them.

Two ways to configure it:

1. **Environment variables** — set once for the process, wins over everything.
2. **Dashboard → Settings → Providers** — paste a key per workspace. The key is
   encrypted before it reaches SQLite and is never returned by the API.

```
env var  >  workspace setting  >  nothing (offline scripted planner)
```

With nothing configured, Reelforge still works end to end: the scripted planner
drives common flows and the offline TTS chain narrates them. BYOK upgrades the
brain, it is not a prerequisite.

---

## Provider matrix

| Provider | `providerId` | Base URL | Key env var | Default model | Notes |
|---|---|---|---|---|---|
| **GMI Cloud** | `gmi` | `https://api.gmi-serving.com/v1` | `GMI_API_KEY` | *(discovered)* | Model ids come from the GMI console and look like `vendor/model-name`. Leave the model empty to take the first entry from `/models`. |
| **OpenAI** | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-4.1-mini` | Vision-capable models read screenshots; smaller models fall back to DOM-only. |
| **OpenRouter** | `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4` | One key, most frontier models. Ids are `vendor/model`. |
| **Groq** | `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Very low latency; good for long demo runs. |
| **Together AI** | `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | — |
| **Fireworks AI** | `fireworks` | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | — |
| **DeepSeek** | `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `deepseek-chat` | — |
| **Ollama (local)** | `ollama` | `http://127.0.0.1:11434/v1` | *(none)* | *(discovered)* | Runs on your machine. No key, no data leaves the box. |
| **LM Studio (local)** | `lmstudio` | `http://127.0.0.1:1234/v1` | *(none)* | *(discovered)* | Start the local server in LM Studio, then pick it. |
| **Custom gateway** | `custom` | *(you set it)* | `REELFORGE_LLM_API_KEY` | *(you set it)* | Any gateway that speaks `/chat/completions` — vLLM, LiteLLM, an internal proxy. |

Shared environment variables:

| Variable | Meaning |
|---|---|
| `REELFORGE_LLM_PROVIDER` | `gmi`, `openai`, `openrouter`, `groq`, `together`, `fireworks`, `deepseek`, `ollama`, `lmstudio`, `custom`, `auto` (default) or `none`. |
| `REELFORGE_LLM_API_KEY` | Key fallback shared by every provider (and the only key var `custom` reads). |
| `REELFORGE_LLM_BASE_URL` | Override the base URL (auto-selects `custom` when no provider is named). |
| `REELFORGE_LLM_MODEL` | Override the model id. Empty means the catalog default, or live discovery for providers with no default. |
| `REELFORGE_LLM_TIMEOUT_MS` | Planner request timeout (default 60000). |
| `REELFORGE_WORKSPACE_ID` | Workspace used by a headless/worker process when it needs dashboard settings. |
| `REELFORGE_TTS_PROVIDER` / `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` | Narration BYOK, same precedence rules. |

`auto` (the default) means: first provider-specific key found wins; a lone
`REELFORGE_LLM_API_KEY` maps to OpenAI exactly like 0.1's `config.LLM`.
An explicit provider always wins. `REELFORGE_LLM_PROVIDER=none` disables the LLM
planner even if a workspace key is stored.

---

## Run 100% locally with Ollama

No account, no key, no internet after the model download.

```bash
# 1. Install Ollama, then start the server (it usually runs as a service already).
ollama serve

# 2. Pull a model. Any chat model works; a vision model reads screenshots and
#    usually plans better.
ollama pull llama3.2-vision:11b

# 3. Point Reelforge at it. Ollama exposes an OpenAI-compatible /v1 path.
REELFORGE_LLM_PROVIDER=ollama \
REELFORGE_LLM_MODEL=llama3.2-vision:11b \
  node --env-file-if-exists=.env packages/api/src/server.ts
```

Or do the same from the dashboard: **Settings → Providers → Ollama (local)**.
The base URL is prefilled with `http://127.0.0.1:11434/v1`, it needs no key, and
**Fetch models** lists what you have pulled locally. **Test connection** sends one
`"say ok"` completion so you see cold-start latency before recording anything.

Notes:

- Ollama answers on `127.0.0.1:11434/v1/models` too, so discovery and the model
  picker work exactly as they do for hosted providers.
- Local models are slower on the first request (weights load into RAM/VRAM).
  Raise `REELFORGE_LLM_TIMEOUT_MS` (e.g. `120000`) if runs degrade right after
  startup.
- LM Studio is the same story: start its local server (default
  `http://127.0.0.1:1234/v1`), then select **LM Studio (local)**.
- Narration can stay fully offline as well — leave `REELFORGE_TTS_PROVIDER=auto`
  and the renderer uses `edge-tts` if installed, then Windows SAPI.

---

## GMI Cloud

GMI Cloud is a first-class provider: base URL `https://api.gmi-serving.com/v1`,
key env `GMI_API_KEY`.

GMI publishes model ids per region/account in its **console**, and they look like
`vendor/model-name` — they change as new models are onboarded, so this repository
does not hard-code a default. Either:

```bash
# List exactly what your key can serve (server-side, key never in the URL):
curl "http://127.0.0.1:4400/api/providers/models?provider=gmi" \
  -H "X-API-Key: $REELFORGE_API_KEY"
```

or leave the model field empty — the planner asks `/models` on first use and
takes the first id. Either way, if a model is retired you get a fast
`PROVIDER_NOT_FOUND` from **Test connection** instead of a failed demo.

Environment-only setup:

```bash
REELFORGE_LLM_PROVIDER=gmi \
GMI_API_KEY=gmi_... \
REELFORGE_LLM_MODEL=vendor/model-name \
  node --env-file-if-exists=.env packages/api/src/server.ts
```

---

## API

All routes require the usual `X-API-Key: rg_…`. Success uses Director's
`{ message, data }` envelope.

| Method & path | Body / query | Returns (`data`) |
|---|---|---|
| `GET /api/providers` | — | `{ llm: { active, providers[] }, tts: { active, providers[] } }` |
| `POST /api/providers` | `{ llm?: { providerId, apiKey?, model?, baseUrl? }, tts?: { providerId, voice? } }` | same as `GET`, refreshed |
| `DELETE /api/providers` | — | same as `GET` after clearing every workspace override |
| `GET /api/providers/models` | `?provider=gmi&baseUrl=…` | `{ models: string[], source: "live" \| "default" }` |
| `POST /api/providers/test` | `{ providerId, apiKey?, baseUrl?, model? }` | `{ ok, latencyMs, model, error }` |

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

# Clear the dashboard override; env variables (if any) take over again
curl -X DELETE http://127.0.0.1:4400/api/providers -H "X-API-Key: $REELFORGE_API_KEY"
```

`active.source` is `env` when an environment variable is in effect, `workspace`
when the dashboard setting is, and `none` when nothing is configured. When
`active.source` is `env`, the dashboard shows "set by environment" and hides the
key field — the process environment cannot be overridden from the UI.

`POST /api/providers` details:

- `llm.providerId` is required; `"none"` clears the workspace override.
- Switching provider resets the stored model/base URL/key — the new provider's
  defaults apply, and anything you send in the same request is written after.
- `apiKey: ""` clears the stored key without switching provider; omitting
  `apiKey` keeps it.
- `baseUrl` is validated as an absolute `http(s)` URL; empty clears the override.
- A provider-side probe failure is **not** an HTTP error: `/test` returns
  `200` with `{ ok:false, error:{ code, message, hint? } }` so the UI can render
  the remedy. Invalid request bodies still return `VALIDATION_ERROR` (400).

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
- `REELFORGE_LLM_API_KEY` and provider-specific env vars are read into memory and
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
`POST /api/providers/test`, and in the demo log line
`[planner] … fell back` (the demo keeps running on the scripted planner).

| Symptom / code | Likely cause | Fix |
|---|---|---|
| `PROVIDER_UNAUTHORIZED` / HTTP **401** (or 403) | Wrong, expired or revoked key; key from another provider pasted; `Bearer ` accidentally included in the value. | Paste the raw key from the provider console. Test connection in Settings → Providers. |
| `PROVIDER_NOT_FOUND` / HTTP **404** | Wrong base URL — usually missing or duplicated `/v1`; wrong region/endpoint; retired model id (GMI/OpenRouter). | Base URLs end in `/v1` (see matrix). For llama.cpp/Ollama/LM Studio use their `/v1`. Re-fetch models. |
| `PROVIDER_TIMEOUT` | Cold local model loading, oversized model, network stall, or a gateway that accepted the socket but never answered. | Wait for first load; raise `REELFORGE_LLM_TIMEOUT_MS`; check the server is not swapping. |
| `PROVIDER_UNREACHABLE` | Nothing listening (Ollama/LM Studio not started), DNS failure, proxy/TLS interception, VPN. | Start the local server; `curl {baseUrl}/models` from the same machine. |
| `PROVIDER_RATE_LIMITED` / HTTP **429** | Provider plan/quota or per-minute limit. | Retry later, switch to a smaller model, or use a local model for that run. |
| `PROVIDER_BAD_RESPONSE` | The URL serves HTML/an API that is not OpenAI-compatible, or `/models` returned an empty list. | Point the base URL at the OpenAI-compatible root (…/v1). |
| `PROVIDER_CONFIG` | No key, no base URL, or no model could be discovered. | Save a key/base URL, or pick a model explicitly. |
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
