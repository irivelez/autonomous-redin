import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { EventEmitter } from "events";
import path from "path";
import fs from "fs";

export interface IncomingMessage {
  from: string;
  body: string;
  mediaBuffers: { mimetype: string; buffer: Buffer }[];
  timestamp: Date;
  profileName?: string;
  isGroup: boolean;
  quotedMessage?: string;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<string | null>;

const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(process.env.HOME || "~", ".redin", "whatsapp-auth");
const RECONNECT_BASE_MS = 3000;
const MAX_RECONNECT_MS = 60000;

export class WhatsAppClient extends EventEmitter {
  private sock: WASocket | null = null;
  private handler: MessageHandler | null = null;
  private reconnectAttempts = 0;
  private running = false;

  async connect(handler: MessageHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
    await this.createConnection();
  }

  private wipeAuthDir(): void {
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log(`[WhatsApp] Auth directory wiped: ${AUTH_DIR}`);
      }
    } catch (err) {
      console.error("[WhatsApp] Error wiping auth dir:", err);
    }
  }

  private async createConnection(): Promise<void> {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WhatsApp] Using WA v${version.join(".")} (latest: ${isLatest})`);
    console.log(`[WhatsApp] Auth registered: ${state.creds.registered}`);

    const sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
    });

    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\n[WhatsApp] Escanea este QR con WhatsApp (Dispositivos vinculados):\n");
        qrcode.generate(qr, { small: true });
        this.emit("qr", qr);

        // Request pairing code AFTER the socket is ready (QR event = socket is alive and waiting)
        const pairingPhone = process.env.PAIRING_PHONE;
        if (pairingPhone) {
          try {
            const code = await sock.requestPairingCode(pairingPhone.replace(/[^0-9]/g, ""));
            const formatted = code.match(/.{1,4}/g)?.join("-") || code;
            console.log(`\n[WhatsApp] ═══════════════════════════════════════`);
            console.log(`[WhatsApp] CÓDIGO DE VINCULACIÓN: ${formatted}`);
            console.log(`[WhatsApp] ═══════════════════════════════════════`);
            console.log(`[WhatsApp] En WhatsApp del teléfono ${pairingPhone}:`);
            console.log(`[WhatsApp] Ajustes → Dispositivos vinculados → Vincular con número de teléfono`);
            console.log(`[WhatsApp] Ingresa el código arriba.\n`);
          } catch (err) {
            console.error("[WhatsApp] Error solicitando pairing code:", err);
          }
        }
      }

      if (connection === "open") {
        console.log("[WhatsApp] Conectado correctamente");
        this.reconnectAttempts = 0;
        this.emit("connected");
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.log("[WhatsApp] Sesión cerrada por WhatsApp. Limpiando auth y reiniciando pairing...");
          this.wipeAuthDir();
          this.emit("logged_out");
          if (this.running) {
            setTimeout(() => this.createConnection(), 2000);
          }
          return;
        }

        if (this.running) {
          const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_MS);
          this.reconnectAttempts++;
          console.log(`[WhatsApp] Desconectado (${statusCode}). Reconectando en ${delay / 1000}s...`);
          setTimeout(() => this.createConnection(), delay);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;

        const isGroup = jid.endsWith("@g.us");
        const senderJid = isGroup ? msg.key.participant || "" : jid;
        const phone = senderJid.replace("@s.whatsapp.net", "");

        const textContent =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          "";

        const mediaBuffers: { mimetype: string; buffer: Buffer }[] = [];
        const mediaMsg = msg.message.imageMessage || msg.message.videoMessage ||
          msg.message.documentMessage || msg.message.audioMessage;

        if (mediaMsg) {
          try {
            const buffer = await downloadMediaMessage(msg, "buffer", {});
            mediaBuffers.push({
              mimetype: mediaMsg.mimetype || "application/octet-stream",
              buffer: buffer as Buffer,
            });
          } catch (err) {
            console.error("[WhatsApp] Error descargando media:", err);
          }
        }

        const pushName = msg.pushName || "";
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || undefined;

        const incoming: IncomingMessage = {
          from: phone,
          body: textContent,
          mediaBuffers,
          timestamp: new Date((msg.messageTimestamp as number) * 1000),
          profileName: pushName,
          isGroup,
          quotedMessage: quoted,
        };

        console.log(`[WhatsApp] ${pushName || phone}: "${textContent.substring(0, 80)}" (${mediaBuffers.length} media)`);

        if (this.handler) {
          try {
            const reply = await this.handler(incoming);
            if (reply) {
              await this.sendMessage(jid, reply);
            }
          } catch (err) {
            console.error("[WhatsApp] Error procesando mensaje:", err);
          }
        }
      }
    });
  }

  async sendMessage(to: string, body: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp no conectado");

    const jid = to.includes("@") ? to : `${to.replace(/[^0-9]/g, "")}@s.whatsapp.net`;

    const chunks = this.chunkText(body, 4000);
    for (const chunk of chunks) {
      await this.sock.sendMessage(jid, { text: chunk });
    }
  }

  async sendAlert(to: string, alert: { message: string; actionRequired: string }): Promise<void> {
    const body = `${alert.message}\n\n📌 Acción: ${alert.actionRequired}`;
    await this.sendMessage(to, body);
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  isConnected(): boolean {
    return this.sock !== null;
  }

  private chunkText(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let cut = remaining.lastIndexOf("\n", limit);
      if (cut <= 0) cut = limit;
      chunks.push(remaining.substring(0, cut));
      remaining = remaining.substring(cut).trimStart();
    }
    return chunks;
  }
}
