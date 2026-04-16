# Redin Execution Tracker — Production Deployment

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      RAILWAY (or Fly.io / VPS)                   │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐    │
│   │           Node.js Process (always-on)                  │    │
│   │                                                        │    │
│   │   ┌──────────────┐    ┌──────────────────────────┐   │    │
│   │   │  node-cron   │    │   Baileys WebSocket       │   │    │
│   │   │  every 30m   │    │   (WhatsApp linked device)│   │    │
│   │   └──────┬───────┘    └──────────┬───────────────┘   │    │
│   │          │                       │                    │    │
│   │          ▼                       ▼                    │    │
│   │   ┌──────────────────────────────────────────────┐   │    │
│   │   │         ExecutionMonitor (tracker)            │   │    │
│   │   │  • SLA scan  • Stale OTs  • Quote follow-up  │   │    │
│   │   └────────────────┬─────────────────────────────┘   │    │
│   │                    │                                  │    │
│   └────────────────────┼──────────────────────────────────┘    │
│                        │                                        │
│   ┌────────────────────▼────────────────┐                      │
│   │  Persistent Volume (/data)          │                      │
│   │  └─ whatsapp-auth/                  │                      │
│   │     (Baileys session — avoids       │                      │
│   │      re-scan on redeploy)           │                      │
│   └─────────────────────────────────────┘                      │
└──────────────────┬───────────────────────────┬──────────────────┘
                   │                           │
                   ▼                           ▼
         ┌──────────────────┐        ┌──────────────────┐
         │   AppSheet API   │        │  WhatsApp servers│
         │  (Redin's data)  │        │  (via WebSocket) │
         └──────────────────┘        └──────────────────┘
```

**Key property:** Everything runs in a single always-on Node.js process. No separate webhook server, no database, no queue system. Baileys maintains a persistent WebSocket to WhatsApp; node-cron triggers the scan logic.

## Why always-on is required

Baileys is not webhook-based. It maintains a persistent WebSocket connection to WhatsApp's servers (the same way WhatsApp Web stays connected when you leave a browser tab open). This rules out serverless platforms that spin down on idle (AWS Lambda, Cloudflare Workers, Render free tier).

## Deploy to Railway (MVP — recommended)

### First-time setup

1. **Push the repo to GitHub:**
   ```bash
   cd /Users/irina/AI-driven-OS/autonomous/redin
   git init && git add . && git commit -m "Initial agent"
   gh repo create autonomous-redin --private --source=. --push
   ```

2. **Create Railway project:**
   - Go to railway.app → New Project → Deploy from GitHub repo
   - Select `autonomous-redin`, root directory: `agent`
   - Railway auto-detects the Dockerfile

3. **Set environment variables** in Railway dashboard:
   ```
   APPSHEET_APP_ID=99809d68-72db-42b1-bc32-bc0819559c03
   APPSHEET_ACCESS_KEY=V2-...
   MANAGER_WHATSAPP=573166222563
   WA_AUTH_DIR=/data/whatsapp-auth
   PAIR_TOKEN=<random 24+ char string>      # protects /pair URL — anyone who hits it without ?t=<token> gets 401
   GEMINI_API_KEY=<key from aistudio.google.com/apikey>   # LLM for message interpretation
   ```
   `PORT` is auto-injected by Railway — do not set it manually.

   **Get a Gemini API key:**
   1. Go to https://aistudio.google.com/apikey
   2. Sign in with any Google account → "Create API key" → copy the key
   3. Free tier covers Redin's volume (Gemini 2.5 Flash: ~1500 requests/day free; Redin handles ~100 OTs/month → well under)
   4. If you skip this step, the agent runs in safe-fallback mode (acknowledges messages but does not pretend to register them)

4. **Attach a persistent volume** (critical for WhatsApp auth):
   - Railway dashboard → Settings → Volumes → New Volume
   - Mount path: `/data/whatsapp-auth`
   - Size: 1GB is plenty

5. **Generate a public URL:**
   - Railway dashboard → Settings → Networking → Generate Domain
   - You'll get something like `redin-agent-production.up.railway.app`

6. **First deploy — pair WhatsApp via the browser:**
   - Open `https://<your-railway-domain>/pair?t=<PAIR_TOKEN>` in a browser
   - The page shows a live QR (rotates every ~20s, page auto-refreshes every 15s)
   - Open WhatsApp on the Redin phone → Settings → Linked Devices → Link a Device
   - Scan the QR — page flips to "✅ Conectado"
   - Credentials are saved to the volume — no re-scan needed ever again

   **No camera?** Use pairing code instead:
   `https://<your-railway-domain>/pair-code?phone=573166222563&t=<PAIR_TOKEN>`
   then enter the 8-digit code in WhatsApp → Linked Devices → Link with phone number.

7. **Subsequent deploys:** just `git push`. The volume preserves the WhatsApp session across redeploys. The /pair URL stays live but does nothing unless the session is lost.

> Why a browser flow instead of pasting `creds.json` as an env var?
> Baileys' generated `creds.json` (even after pruning) is too large for Railway's env var UI to handle reliably (truncation, paste failures). Pairing directly on the deployed instance writes auth straight to the volume — zero credential transfer.

### Cost: ~$5-7/month

## Migration path as autonomous grows

```
STAGE 1 — MVP (1 client)
  Railway, Dockerfile, one process, $5/mo
  ✓ Redin running here

STAGE 2 — 2-5 clients
  Still Railway, but refactor to config-driven multi-tenant:
    ONE process, reads a clients.json config,
    loops through all clients during each scan,
    WhatsApp session per client (separate auth dirs).
  Cost: still $5-7/mo

STAGE 3 — 5+ clients
  Move to Hetzner VPS ($3.29/mo) or Fly.io ($3-5/mo):
    One server, N Docker containers (one per client),
    or one multi-tenant process if clients are similar.
  Cost stays flat as you add clients.
```

## Multi-tenant refactor (when client #2 arrives)

The current code has Redin's config hardcoded via env vars. To add a second client, abstract into a registry:

```ts
// config/clients.json
{
  "redin": {
    "appsheet": { "appId": "...", "accessKey": "..." },
    "whatsapp": { "authDir": "/data/redin-wa-auth", "managerPhone": "..." },
    "tracker": { "slaRules": "interrapidisimo-3-levels" }
  },
  "client2": { ... }
}
```

Then the main loop becomes:

```ts
const clients = loadClientsConfig();
for (const client of clients) {
  const agent = new ExecutionTracker(client);
  await agent.start();
}
```

This takes maybe 2 hours of refactoring when the second client arrives. Not needed now.

## Monitoring & ops

**Logs:** Railway's built-in log viewer shows all stdout. Every scan logs:
- `[Scan] ... Scanning...`
- `[Alerts] N alerts found`
- `[WhatsApp] sender: "msg" (N media)`

**Health check:** If the process dies, Railway restarts it automatically (`restartPolicyMaxRetries = 10` in `railway.toml`).

**WhatsApp session lost:** Rare, but if the Redin phone is unlinked manually, the agent logs `logged_out` and stops replying. SSH into the volume, delete auth state, redeploy, re-scan QR.

**Scaling concerns:** Baileys can handle thousands of messages/day on a single 512MB container. Redin's ~100 OTs/month is negligible. No scaling needed for years.

## What this gives Redin today

Running on Railway, the agent will:

1. **Every 30 min (business hours)** — scan AppSheet, detect SLA breaches, stale executions, quote follow-ups, profitability risks
2. **Send critical alerts via WhatsApp** to the manager (José/Cristian)
3. **Receive WhatsApp messages from contractors** — interpret "terminé OT 123" or photos, confirm receipt, notify architect
4. **Log everything** for audit and improvement

First revenue impact (estimated):
- Catch SLA breaches before they accumulate multi-hour penalties → save potentially significant % of Inter Rapidísimo monthly contract
- Follow up on 17 stale quotes (~$50-200M COP worth of estimated value sitting idle) → convert some to revenue
- Flag profitability risks in real time → prevent losses like OT #133 (-31% margin)
