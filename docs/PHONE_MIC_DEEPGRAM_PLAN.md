## Phone-as-Microphone with Gemini 2.5 Pro — Technical Plan

### Goals

- **Enable QR-based pairing to use a phone as a microphone** for computers without a mic.
- **Transcribe speech with Gemini 2.5 Pro (realtime)** and insert text into any focused textbox/contentEditable in Chrome.
- **Fast, privacy-conscious MVP** with minimal backend; robust pairing and transient sessions.

### High-Level Overview

- **UX**: New popup "Voice" opens a QR code. User scans with phone → phone app starts streaming audio to Gemini realtime. Transcripts appear in the extension and are injected into the current focused field.
- **Architecture**: Extension (popup + background + content script) + lightweight relay service (WebSocket) + mobile web app (PWA) using Gemini realtime.
- **Transport**: For MVP, use a cloud relay (simpler and reliable). Consider optional WebRTC P2P later.

### Architecture

- **Extension**
  - Popup: `entrypoints/popup/voice.html`, `entrypoints/popup/voice.tsx` rendering `src/components/popups/PhoneMicPopup.tsx`.
  - Background/service worker: `entrypoints/background.ts` manages session lifecycle and relay socket.
  - Content script: `src/utils/transcript-injector.ts` injected into active tab to insert transcripts at the caret.
  - Shared utils: `src/utils/voice-session.ts` for session creation, message routing, and reconnection.
- **Relay (Edge-friendly WebSocket service)**
  - Responsibilities: Issue short-lived session IDs + signed tokens; fan-in from phone; fan-out to the paired extension instance.
  - Examples: Cloudflare Workers, Fly.io, Vercel Edge Runtime with WS, or Supabase Realtime channel.
- **Mobile Web App (PWA)**
  - Single-page React + Tailwind (latest versions) hosted at `https://voice.paymore.app`.
  - Uses `getUserMedia` for mic → streams to Gemini 2.5 Pro realtime via Google AI Realtime API (WS) or Vertex AI Realtime, depending on deploy.
  - Push-to-talk and/or VAD; sends interim and final transcripts to Relay tagged by `sessionId`.

### Data Flow (MVP, Relay-based)

1. Extension creates a session via Relay REST: POST `/sessions` → `{ sessionId, token, qrUrl }`.
2. Popup shows a QR encoding `https://voice.paymore.app?s=<sessionId>&t=<token>`.
3. Phone opens PWA, validates token with Relay, joins session via WS `wss://relay/s/<sessionId>?t=<token>`.
4. Phone opens Gemini realtime session, streams audio, receives interim/final transcripts.
5. Phone forwards transcripts to Relay channel for `sessionId`.
6. Extension background connects to Relay WS for `sessionId`, receives transcripts.
7. Background forwards transcripts to the active tab content script.
8. Content script inserts text at caret in focused input/textarea/contentEditable.

### Pairing and Sessions

- **Session**: 128-bit random `sessionId`, TTL 30–60 minutes, single phone ↔ single browser consumer.
- **Token**: Signed JWT with `sessionId`, `exp`, optional `origin`/`ua` claims.
- **QR Contents**: A link to the PWA with `sessionId` and token (no API keys).
- **Security**: No PII; revoke/expire tokens; CORS on REST; origin checks on WS subscribe.

### Gemini 2.5 Pro Integration (Phone-side)

- Stream 16 kHz mono; enable punctuation and interim transcripts; request structured text output.
- Languages: configurable; default en-US.
- Latency target: < 500 ms for interim; < 1 s for finals.
- Do NOT embed Google API/Vertex credentials in the extension; phone-side only or ephemeral token broker.

### Extension Changes

- Manifest/WXT config
  - Ensure permissions: `storage`, `activeTab`, `scripting`, `offscreen`, `notifications` (optional), `tabs`.
  - Add new popup entry `voice.html` and route via WXT.
- Background (`entrypoints/background.ts`)
  - Create/close session; maintain Relay WS; debounce and forward transcripts.
  - Handle reconnection, backoff, and session cleanup on extension suspend.
- Popup (`entrypoints/popup/voice.tsx` + `src/components/popups/PhoneMicPopup.tsx`)
  - UI: create session, show QR, session status, language/model selectors, start/stop, preview of transcripts.
  - Use existing UI primitives in `src/components/ui/*` (button, card, select, badge, tooltip).
- Content Script (`src/utils/transcript-injector.ts`)
  - On transcript event: insert at caret; respect interim vs final; auto-space; optional auto-period.
  - Feature toggles: append vs replace interim; optional "press Enter on final".

### File/Module Plan

- Add
  - `entrypoints/popup/voice.html`
  - `entrypoints/popup/voice.tsx`
  - `src/components/popups/PhoneMicPopup.tsx`
  - `src/utils/voice-session.ts`
  - `src/utils/transcript-injector.ts`
  - `public/assets/icons/mic-phone.svg` (optional)
- Update
  - `wxt.config.ts` to register the new popup entry.
  - `entrypoints/background.ts` to include session/WS plumbing.
  - `tailwind.config.ts` if needed for any plugin or color tokens.

### Minimal Relay API (Spec)

```http
POST /sessions
Authorization: Bearer <server_admin_token>
→ 201 { "sessionId": "<id>", "token": "<jwt>", "qrUrl": "https://voice.paymore.app?s=<id>&t=<jwt>" }

WS wss://relay/s/<sessionId>?t=<jwt>
- Client (phone) → { type: "transcript", interim: true|false, text: string, ts?: number }
- Server → broadcast to extension subscribers
```

### Types (Extension)

```ts
type TranscriptEvent = {
  type: "transcript";
  interim: boolean;
  text: string;
  timestampMs: number;
};

type SessionInfo = {
  sessionId: string;
  token: string;
  relayUrl: string; // wss base
  expiresAt: number;
};
```

### Content Script Insertion Logic (Outline)

```ts
export function insertAtCaret(text: string) {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return;
  const isEditable =
    el.getAttribute("contenteditable") === "" ||
    el.getAttribute("contenteditable") === "true";

  if (
    ((el as HTMLInputElement).selectionStart !== undefined &&
      el instanceof HTMLTextAreaElement) ||
    el instanceof HTMLInputElement
  ) {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.substring(0, start);
    const after = input.value.substring(end);
    input.value = `${before}${text}${after}`;
    const caret = start + text.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (isEditable) {
    document.execCommand("insertText", false, text);
  }
}
```

### UI Sketch (Popup)

- **Header**: Phone Mic
- **Controls**: Create/End session, language, model (Gemini 2.5 Pro), push-to-talk toggle.
- **QR**: Session QR code; copy link; show paired state.
- **Transcript Preview**: Live interim and finalized lines.
- Build with React (latest) + Tailwind (latest), reusing shadcn-style components in `src/components/ui/*`.

### Config and Secrets

- Extension `.env`: `VITE_RELAY_BASE_URL` for REST/WS base.
- Phone PWA: `GEMINI_API_KEY` or Vertex AI access via ephemeral token fetched from backend.
- Do not store Google/Vertex keys in the extension.

### Telemetry & Privacy

- Local-only transcript buffering in extension unless user opts-in to analytics.
- Relay stores nothing beyond ephemeral session routing; no logs of transcript content (configurable).

### Error Handling & Resilience

- Exponential backoff on Relay WS reconnect; session expiry prompts re-pair.
- Background keeps session alive through popup closes; user can end session.
- Content script guards if no editable element focused; queue until focus returns.

### Non-MVP Enhancements

- WebRTC P2P mode (DataChannel for transcripts, MediaStream track for future on-device ASR).
- Hotkey to toggle listening and paste transcript.
- Language auto-detect; profanity filter; timestamps; clipboard fallback.
- Multi-tab routing UI; per-site permissions toggle.

### Milestones

- **M0**: Scaffolding (popup, content script plumbing, icons, config).
- **M1**: Relay service with sessions + QR pairing; extension subscribe.
- **M2**: Phone PWA → Gemini 2.5 Pro realtime streaming; send transcripts to Relay.
- **M3**: Inject transcripts reliably into inputs/contentEditable; options UI.
- **M4**: Polish, reconnection, edge cases; QA on major sites (Gmail, Docs, Notion).
- **M5**: Beta release, documentation, store listing updates.

### Open Questions

- Host choice for Relay (CF Workers vs Vercel Edge) and WS scaling constraints?
- Ephemeral Gemini/Vertex tokens vs static API key on phone—do we need a token broker?
- Should we support multi-browser pairing for one phone session (fan-out)?

### Alternatives Considered

- **Direct WebRTC P2P**: Lower latency, but higher complexity (signaling, NAT traversal, TURN). For transcripts-only, Relay is simpler and robust.
- **Speech-to-text in extension via WebSpeech API**: Not viable (no mic on computer; also inconsistent quality/availability).
