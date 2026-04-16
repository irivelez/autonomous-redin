/**
 * Local pairing helper.
 *
 * Runs Baileys from your residential IP (which WhatsApp trusts for new device pairings),
 * prompts for QR scan, then outputs a single base64 string you can paste into Railway
 * as the WA_AUTH_BOOTSTRAP env var.
 *
 * Usage: npm run pair
 */

import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import os from "os";

const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(os.homedir(), ".redin", "whatsapp-auth-local");

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  WhatsApp Local Pairing Helper        ");
  console.log("═══════════════════════════════════════\n");

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  console.log(`Auth dir: ${AUTH_DIR}\n`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("1. Abre WhatsApp en el teléfono que será el agente");
      console.log("2. Ve a Ajustes → Dispositivos vinculados → Vincular un dispositivo");
      console.log("3. Escanea este QR:\n");
      qrcode.generate(qr, { small: true });

      const pairingPhone = process.env.PAIRING_PHONE;
      if (pairingPhone) {
        try {
          const code = await sock.requestPairingCode(pairingPhone.replace(/[^0-9]/g, ""));
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          console.log(`\nO usa el código (más fácil desde teléfono):`);
          console.log(`  → "Vincular con número de teléfono" → ${formatted}\n`);
        } catch (err) {
          // Not critical — QR is the fallback
        }
      }
    }

    if (connection === "open") {
      console.log("\n✅ Conectado exitosamente. Exportando credenciales...\n");

      // Give Baileys a moment to write the final creds
      await new Promise((r) => setTimeout(r, 2000));

      // Only export essential files. Baileys regenerates pre-keys, sessions,
      // and device-list entries automatically. creds.json holds the master
      // credentials needed to reauthenticate.
      const ESSENTIAL = new Set(["creds.json"]);
      const files: Record<string, string> = {};
      for (const name of fs.readdirSync(AUTH_DIR)) {
        if (ESSENTIAL.has(name)) {
          files[name] = fs.readFileSync(path.join(AUTH_DIR, name), "utf-8");
        }
      }

      const encoded = Buffer.from(JSON.stringify(files), "utf-8").toString("base64");

      console.log("═══════════════════════════════════════════════════════════════════");
      console.log("  COPIA ESTO A RAILWAY → Variables → WA_AUTH_BOOTSTRAP             ");
      console.log("═══════════════════════════════════════════════════════════════════\n");
      console.log(encoded);
      console.log("\n═══════════════════════════════════════════════════════════════════");
      console.log(`  Tamaño: ${(encoded.length / 1024).toFixed(1)} KB                   `);
      console.log(`  Archivos incluidos: ${Object.keys(files).length}                   `);
      console.log("═══════════════════════════════════════════════════════════════════\n");

      // Save a backup locally too
      const backupPath = path.join(AUTH_DIR, "..", "whatsapp-auth-bootstrap.txt");
      fs.writeFileSync(backupPath, encoded);
      console.log(`También guardado en: ${backupPath}\n`);

      console.log("Próximos pasos:");
      console.log("1. Ve a Railway → Variables");
      console.log("2. Nueva variable: WA_AUTH_BOOTSTRAP = <el string de arriba>");
      console.log("3. Elimina PAIRING_PHONE (ya no lo necesitas)");
      console.log("4. Railway se redesplegará automáticamente");
      console.log("5. El agente se conectará usando estas credenciales pre-pareadas\n");

      await sock.end(undefined);
      process.exit(0);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("\n❌ Sesión cerrada. Elimina la carpeta de auth y vuelve a intentar.");
        process.exit(1);
      }
      console.log(`\n⚠️  Conexión cerrada (${statusCode}). Esperando reintento...`);
    }
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
