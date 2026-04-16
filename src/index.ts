import "dotenv/config";
import { AppSheetClient } from "./clients/appsheet.js";
import { WhatsAppClient, type IncomingMessage } from "./clients/whatsapp.js";
import { ExecutionMonitor, formatAlerts } from "./tracker/monitor.js";
import { interpretMessage, generateReply } from "./tracker/interpreter.js";
import cron from "node-cron";

const appsheet = new AppSheetClient({
  appId: process.env.APPSHEET_APP_ID!,
  accessKey: process.env.APPSHEET_ACCESS_KEY!,
});

const whatsapp = new WhatsAppClient();
const monitor = new ExecutionMonitor(appsheet);

const handleMessage = async (msg: IncomingMessage): Promise<string | null> => {
  if (msg.isGroup) return null;

  const update = interpretMessage(msg);
  console.log(`[Interpreter] Type: ${update.type}, OT: ${update.otNumber || "?"}, Status: ${update.status || "—"}`);

  const reply = generateReply(update);

  if (update.type === "problem_report") {
    const alertMsg = `🚨 PROBLEMA reportado por ${msg.profileName || msg.from}\n` +
      `OT: ${update.otNumber || "no especificado"}\n` +
      `Mensaje: ${update.description}`;
    const managerPhone = process.env.MANAGER_WHATSAPP;
    if (managerPhone) {
      await whatsapp.sendMessage(managerPhone, alertMsg).catch(console.error);
    }
  }

  return reply;
};

async function runScan() {
  console.log(`\n[Scan] ${new Date().toLocaleString("es-CO")} — Scanning...`);
  try {
    const alerts = await monitor.scan();
    console.log(formatAlerts(alerts));

    if (whatsapp.isConnected() && alerts.length > 0) {
      const critical = alerts.filter((a) => a.severity === "critical" || a.severity === "high");
      if (critical.length > 0) {
        const summary = critical.slice(0, 10).map((a) => a.message).join("\n");
        const managerPhone = process.env.MANAGER_WHATSAPP;
        if (managerPhone) {
          await whatsapp.sendAlert(managerPhone, {
            message: `🚨 ${critical.length} alertas críticas en Redin`,
            actionRequired: summary,
          });
        }
      }
    }
  } catch (err) {
    console.error("[Scan] Error:", err);
  }
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  REDIN Execution Tracker — Starting   ");
  console.log("═══════════════════════════════════════\n");

  // Run initial scan
  await runScan();

  // Schedule periodic scans (every 30 minutes during work hours)
  cron.schedule("*/30 8-19 * * 1-6", runScan, { timezone: "America/Bogota" });
  console.log("[Cron] Scheduled: scan every 30 min, Mon-Sat 8am-7pm COT");

  // Connect WhatsApp (Baileys — persistent WebSocket)
  console.log("\n[WhatsApp] Iniciando conexión...");
  await whatsapp.connect(handleMessage);
}

main().catch(console.error);
