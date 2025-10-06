export type TranscriptEvent = {
  type: "transcript";
  interim: boolean;
  text: string;
  timestampMs: number;
};

export type SessionInfo = {
  sessionId: string;
  token: string;
  relayUrl: string;
  expiresAt: number;
};

export type VoiceSessionState = {
  status: string;
  connected: boolean;
};

export function buildRelayWsUrl(info: SessionInfo) {
  const base = info.relayUrl.replace(/\/$/, "");
  return `${base}/s/${info.sessionId}?t=${encodeURIComponent(info.token)}`;
}
