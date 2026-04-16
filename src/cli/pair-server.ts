import http from "http";
import QRCode from "qrcode";
import type { WhatsAppClient } from "../clients/whatsapp.js";

const REFRESH_SECONDS = 15;

interface PairServerOptions {
  port: number;
  whatsapp: WhatsAppClient;
  authToken?: string;
}

export function startPairServer(opts: PairServerOptions): http.Server {
  const { port, whatsapp, authToken } = opts;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (authToken) {
      const provided = url.searchParams.get("t") || req.headers["x-pair-token"];
      if (provided !== authToken) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized — append ?t=<PAIR_TOKEN> to the URL");
        return;
      }
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`state=${whatsapp.getConnectionState()}`);
      return;
    }

    if (url.pathname === "/qr.png") {
      const qr = whatsapp.getLatestQR();
      if (!qr) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("No QR available yet — refresh in a few seconds.");
        return;
      }
      try {
        const png = await QRCode.toBuffer(qr, { type: "png", margin: 2, width: 360 });
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        });
        res.end(png);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error rendering QR: " + (err as Error).message);
      }
      return;
    }

    if (url.pathname === "/pair-code") {
      const phone = url.searchParams.get("phone");
      if (!phone) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing ?phone=<E.164 digits>");
        return;
      }
      try {
        const code = await whatsapp.requestPairingCode(phone);
        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`Pairing code for ${phone}: ${formatted}\n\nIn WhatsApp on that phone:\nSettings → Linked Devices → Link with phone number → enter the code above.`);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error requesting pairing code: " + (err as Error).message);
      }
      return;
    }

    if (url.pathname === "/" || url.pathname === "/pair") {
      const state = whatsapp.getConnectionState();
      const hasQR = !!whatsapp.getLatestQR();
      const tokenSuffix = authToken ? `?t=${encodeURIComponent(authToken)}` : "";
      const html = renderPage({ state, hasQR, tokenSuffix });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`[PairServer] Escuchando en puerto ${port}`);
    console.log(`[PairServer] Abre la URL pública de Railway + /pair${authToken ? `?t=<PAIR_TOKEN>` : ""}`);
  });

  return server;
}

function renderPage(args: { state: string; hasQR: boolean; tokenSuffix: string }): string {
  const { state, hasQR, tokenSuffix } = args;

  if (state === "open") {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Redin · WhatsApp</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#0f172a}h1{font-size:22px}p{color:#475569}.ok{color:#15803d}</style>
</head><body>
<h1>Redin · WhatsApp</h1>
<p class="ok">✅ Conectado. El agente está en línea — ya puedes cerrar esta pestaña.</p>
<p>Estado: <code>${state}</code></p>
</body></html>`;
  }

  const qrBlock = hasQR
    ? `<img src="/qr.png${tokenSuffix}" alt="QR de vinculación" width="360" height="360" />`
    : `<p><em>Esperando que Baileys genere el QR... la página se recarga sola.</em></p>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Redin · Vincular WhatsApp</title>
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<style>
body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#0f172a}
h1{font-size:22px;margin-bottom:4px}
.sub{color:#64748b;margin-top:0}
ol{color:#334155}
.qr{margin:24px 0;padding:24px;border:1px solid #e2e8f0;border-radius:12px;text-align:center;background:#fff}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:14px}
.state{font-size:13px;color:#64748b;margin-top:24px}
</style></head><body>
<h1>Vincular WhatsApp · Redin</h1>
<p class="sub">Escanea el QR desde el teléfono que será el agente. La página se recarga cada ${REFRESH_SECONDS}s — el QR rota cada ~20s.</p>
<ol>
  <li>Abre WhatsApp en el teléfono del agente</li>
  <li>Ajustes → Dispositivos vinculados → <strong>Vincular un dispositivo</strong></li>
  <li>Escanea el QR de abajo</li>
</ol>
<div class="qr">${qrBlock}</div>
<p class="state">Estado actual: <code>${state}</code> · QR disponible: <code>${hasQR}</code></p>
<p class="state">¿Sin cámara? Usa <code>/pair-code?phone=573XXXXXXXXX${tokenSuffix ? `&${tokenSuffix.slice(1)}` : ""}</code> y entra el código en "Vincular con número de teléfono".</p>
</body></html>`;
}
