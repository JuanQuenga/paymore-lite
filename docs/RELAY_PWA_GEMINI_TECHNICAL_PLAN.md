## TECHNICAL_PLAN: Voice Relay + PWA (Gemini 2.5 Pro Realtime)

This plan describes a separate GitHub repo to deploy on Vercel that provides:

- A Relay service (REST + WebSocket) for QR pairing and transcript fan-out
- An optional Token Broker for Gemini/Vertex ephemeral access
- A Phone PWA that streams mic audio to Gemini 2.5 Pro Realtime and posts transcripts to the Relay

### Goals

- QR-based pairing: desktop extension creates a session; phone joins via QR
- Phone streams mic audio to Gemini Realtime; receives interim/final transcripts
- Phone forwards transcripts to the Relay, which delivers to the paired desktop client
- No API keys in the extension; limited, short-lived tokens for the PWA

### High-Level Architecture

- Vercel monorepo with two apps (or two Vercel projects):
  - `apps/relay` (Edge functions + WebSocket server)
  - `apps/pwa` (Next.js PWA: React 19 + Tailwind v4)
- Desktop extension creates sessions via `relay` and subscribes via WS
- Phone PWA scans QR, joins the session, connects to Gemini Realtime, and forwards transcripts to `relay`

### Technology

- Runtime: Vercel Edge Functions (Deno-based) for REST + WS
- PWA: Next.js 15 (App Router), React 19, Tailwind v4, PWA manifest + Service Worker
- Gemini: Google AI Realtime API or Vertex AI Realtime (choose one at deploy time)

### Environments & Secrets

- `RELAY_PUBLIC_BASE_URL` (e.g., `https://relay.paymore.app`)
- `JWT_SECRET` (sign short-lived session tokens)
- If using Google AI API key directly on server:
  - `GEMINI_API_KEY`
- If using Vertex AI (recommended for ephemeral auth):
  - `GOOGLE_APPLICATION_CREDENTIALS` (Vercel Secret containing service account JSON) or access via workload identity

### Data Model

- `sessionId`: 128-bit random string (Base64URL) identifying a pairing session
- `token` (JWT): contains `sid`, `exp`, optional `ua`/`origin`
- `TranscriptEvent`:

```ts
type TranscriptEvent = {
  type: "transcript";
  interim: boolean;
  text: string;
  timestampMs: number;
};
```

### REST API (Relay)

- POST `/api/sessions`
  - Auth: server-side admin header or signed HMAC (optional for MVP)
  - Body: `{ lang?: string, model?: string }`
  - Returns: `{ sessionId, token, relayUrl, qrUrl }`
- POST `/api/token/gemini` (optional, Token Broker)
  - Auth: Bearer JWT from `/api/sessions`
  - Returns:
    - If Google AI API key flow: ephemeral client token (signed JWT with short TTL) for client to call a narrow proxy endpoint, or return a one-time token consumed by a server proxy
    - If Vertex AI: short-lived OAuth access token or an ephemeral session token compatible with client SDK

### WebSocket API (Relay)

- Path: `wss://<RELAY_PUBLIC_BASE_URL>/api/relay/s/[sessionId]?t=<jwt>`
- Authorization: `t` is the session JWT
- Rooms: one `sessionId` room; allow one producer (phone) and N consumers (desktop)
- Messages:
  - Client→Server (phone): `{ type: "transcript", interim: boolean, text: string, ts?: number }`
  - Server→Client (desktop): same shape; server adds `timestampMs` if missing
- Server rules:
  - Validate JWT `sid` matches `[sessionId]` and `exp` not expired
  - Rate-limit inbound messages per session
  - Drop non-JSON or oversized messages
  - TTL: session auto-expires (e.g., 30–60 minutes)

### PWA (Phone)

- Pages: `/` with Scan → Pair → Stream UI
- Flow:
  1. On load, parse `?s=<sessionId>&t=<token>&lang=&model=` from QR
  2. Validate token via `POST /api/sessions/validate` or attempt WS join
  3. Acquire mic via `getUserMedia` (mono, 16 kHz)
  4. Start Gemini Realtime session:
     - Option A: Direct Google AI Realtime WebSocket
     - Option B: Vertex AI Realtime (WebSocket or SDK)
     - Option C: (fallback) Server proxy endpoint that connects to Gemini on behalf of client
  5. Stream audio frames; read interim/final transcripts
  6. Publish transcripts to Relay WS `s/<sessionId>`
- UI controls: push-to-talk, language selection, model selection, reconnect
- Offline handling: buffer locally until WS ready; resume on network changes

### Gemini Realtime Integration (Phone)

- Audio format: 16 kHz mono PCM or Opus (per Gemini Realtime requirements)
- Request options: enable interim results, punctuation, smart formatting
- Backoff and reconnection: exponential backoff, resume session if supported
- Privacy: no transcripts stored; no API key persisted in local storage

### Token Broker (Recommended)

- Purpose: prevent embedding `GEMINI_API_KEY` in PWA
- Two approaches:
  - Vertex AI: Mint short-lived access tokens server-side; PWA uses Bearer token for Realtime
  - Google AI API: Do not hand API key to client; use a server proxy route `/api/gemini/realtime` that upgrades a WS and injects the server key, forwarding frames between client and Gemini
- Both cases: authorize using the session JWT; restrict to the `sessionId` and TTL

### Security

- JWT for sessions; HS256 with `JWT_SECRET`; 30–60 min TTL
- Rate limiting on REST + WS per IP/session
- CORS: allow PWA origin only
- WS validation: disconnect invalid JWT or wrong session
- No transcript persistence in server logs (unless debug with scrubbing)

### Folder Structure (Monorepo)

```
repo/
  apps/
    relay/            # Edge runtime, REST + WS
      api/
        sessions/route.ts         # POST create session
        token/gemini/route.ts     # POST token broker (optional)
        relay/s/[sessionId]/route.ts  # WS upgrade handler
      lib/
        jwt.ts
        wsHub.ts
        rateLimit.ts
      vercel.json
    pwa/
      app/
        (routes)
        layout.tsx
        page.tsx
      public/
        manifest.webmanifest
        icons/
      lib/
        geminiClient.ts
        audioWorklet.ts
        wsClient.ts
      next.config.mjs
      tailwind.config.ts
  packages/
    types/
      index.ts        # Shared types (TranscriptEvent, Session)
  .github/
    workflows/
      ci.yml
  README.md
```

### Vercel Config

- `apps/relay/vercel.json` (Edge runtime + WS):

```json
{
  "functions": {
    "api/**": { "runtime": "edge" }
  }
}
```

- Set project env vars per environment (Preview/Prod)

### Implementation Checklist

1. Relay: implement `POST /api/sessions`
   - Generate `sessionId`; sign JWT with `sid`, `exp`
   - Return `{ sessionId, token, relayUrl, qrUrl }`
2. Relay WS: `GET /api/relay/s/[sessionId]` (WS upgrade)
   - Verify `t` JWT; join room; broadcast inbound transcript messages to subscribers
3. Token Broker (optional)
   - Vertex: endpoint to mint short-lived access tokens (scoped to `sid`)
   - Google AI API: implement WS proxy `/api/gemini/realtime` guarded by session JWT
4. PWA
   - Route parses QR params; pair state UI
   - Mic capture → Gemini Realtime (direct or via proxy)
   - Receive transcripts; publish to Relay WS
   - Basic settings (language/model), push-to-talk, reconnect
5. Observability
   - Structured logging with request IDs; redact transcript content
   - Minimal metrics (sessions created, WS connections, drops)
6. Security & Limits
   - Add rate limits and size caps; clear expired rooms

### Message Shapes

```ts
// Client → Relay
type ClientMessage =
  | { type: "hello" }
  | { type: "transcript"; interim: boolean; text: string; ts?: number };

// Relay → Client
type ServerMessage =
  | { type: "ready" }
  | { type: "error"; code: string; message: string }
  | { type: "transcript"; interim: boolean; text: string; timestampMs: number };
```

### Env Examples

```
RELAY_PUBLIC_BASE_URL=https://relay.paymore.app
JWT_SECRET=replace-with-strong-secret
# If using Google AI API
GEMINI_API_KEY=sk-...
# If using Vertex AI (server-to-server)
GOOGLE_APPLICATION_CREDENTIALS={"type":"service_account",...}
```

### Deliverables

- Deployed Vercel projects:
  - Relay: `https://relay.paymore.app`
  - PWA: `https://voice.paymore.app`
- README with pairing steps and QR parameters
- Postman/Bruno collection for REST + WS examples

### Notes

- Prefer Vertex AI for enterprise auth and ephemeral tokens
- If WS proxying Gemini, ensure low-latency binary piping and backpressure handling
- Keep transcripts out of logs; scrub on error paths
