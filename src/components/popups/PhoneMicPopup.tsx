import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Input } from "../ui/input";

type SessionInfo = {
  sessionId: string;
  token: string;
  relayUrl: string;
  expiresAt: number;
};

export default function PhoneMicPopup() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Idle");
  const [language, setLanguage] = useState<string>("en-US");
  const [model, setModel] = useState<string>("gemini-2.5-pro");
  const [preview, setPreview] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);

  const relayBase = useMemo(() => {
    return (import.meta as any).env?.VITE_RELAY_BASE_URL || "";
  }, []);

  async function createSession() {
    setStatus("Creating session...");
    try {
      const res = await fetch(`${relayBase.replace(/\/$/, "")}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: language, model }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const info: SessionInfo = {
        sessionId: data.sessionId,
        token: data.token,
        relayUrl: data.relayUrl || relayBase,
        expiresAt: Date.now() + 30 * 60 * 1000,
      };
      setSession(info);
      const url = `https://voice.paymore.app?s=${encodeURIComponent(
        info.sessionId
      )}&t=${encodeURIComponent(info.token)}&lang=${encodeURIComponent(
        language
      )}&model=${encodeURIComponent(model)}`;
      const qr = await generateQr(url, 256);
      setQrDataUrl(qr);
      connectRelay(info);
      setStatus("Waiting for phone...");
    } catch (e: any) {
      setStatus(`Failed to create session: ${e?.message || e}`);
    }
  }

  function endSession() {
    setStatus("Ending session");
    try {
      wsRef.current?.close();
    } catch (_) {}
    wsRef.current = null;
    setSession(null);
    setQrDataUrl(null);
    setPreview("");
    setStatus("Idle");
  }

  async function generateQr(text: string, size: number) {
    return new Promise<string>((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { action: "generateQr", text, size },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError.message);
              return;
            }
            if (resp?.success) resolve(resp.dataUrl);
            else reject(resp?.error || "QR generation failed");
          }
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  function connectRelay(info: SessionInfo) {
    try {
      const url = `${info.relayUrl.replace(/\/$/, "")}/s/${info.sessionId}`;
      const ws = new WebSocket(`${url}?t=${encodeURIComponent(info.token)}`);
      wsRef.current = ws;
      ws.onopen = () => setStatus("Connected to relay");
      ws.onclose = () => setStatus("Disconnected");
      ws.onerror = () => setStatus("Relay error");
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === "transcript") {
            const text = String(msg.text || "");
            setPreview((p) => (msg.interim ? `${text}` : `${p}\n${text}`));
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              const tab = tabs?.[0];
              if (!tab?.id) return;
              try {
                chrome.tabs.sendMessage(tab.id, {
                  action: "pm-voice-transcript",
                  interim: !!msg.interim,
                  text,
                  timestampMs: Date.now(),
                });
              } catch (_) {}
            });
          }
        } catch (_) {}
      };
    } catch (e) {
      setStatus(`Failed to connect relay: ${String(e)}`);
    }
  }

  useEffect(() => {
    return () => {
      try {
        wsRef.current?.close();
      } catch (_) {}
    };
  }, []);

  return (
    <div className="p-3 min-w-[360px]">
      <Card>
        <CardHeader>
          <CardTitle>Phone Mic (Gemini 2.5 Pro)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs">Language</label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger>
                  <SelectValue placeholder="Language" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en-US">English (US)</SelectItem>
                  <SelectItem value="es-ES">Español (ES)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs">Model</label>
              <Input value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!session && (
              <Button onClick={createSession}>Create Session</Button>
            )}
            {session && <Button onClick={endSession}>End Session</Button>}
            <span className="text-xs text-muted-foreground">{status}</span>
          </div>
          {qrDataUrl && (
            <div className="flex justify-center">
              <img src={qrDataUrl} width={256} height={256} alt="QR" />
            </div>
          )}
          <div>
            <label className="text-xs">Preview</label>
            <div className="text-sm whitespace-pre-wrap border rounded p-2 h-32 overflow-auto">
              {preview || "(no transcripts yet)"}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
