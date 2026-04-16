import "dotenv/config";
import { AppSheetClient } from "./clients/appsheet.js";
import { WhatsAppClient, type IncomingMessage } from "./clients/whatsapp.js";
import { ExecutionMonitor, formatAlerts } from "./tracker/monitor.js";
import { interpretMessage } from "./tracker/interpreter.js";
import { startPairServer } from "./cli/pair-server.js";
import { interpretWithLLM, isLLMConfigured, type IntentResult } from "./llm/intent.js";
import { extractOTNumber, fetchOTContext } from "./llm/context.js";
import cron from "node-cron";

const appsheet = new AppSheetClient({
  appId: process.env.APPSHEET_APP_ID!,
  accessKey: process.env.APPSHEET_ACCESS_KEY!,
});

const whatsapp = new WhatsAppClient();
const monitor = new ExecutionMonitor(appsheet);

async function runLLMInterpretation(msg: IncomingMessage): Promise<IntentResult> {
  const otNumber = extractOTNumber(msg.body);
  const ot = otNumber ? await fetchOTContext(appsheet, otNumber) : null;

  return interpretWithLLM({
    message: msg.body,
    hasPhotos: msg.mediaBuffers.length > 0,
    senderName: msg.profileName,
    senderPhone: msg.from,
    ot,
  });
}

function fallbackReply(msg: IncomingMessage): { reply: string; needsAlert: boolean; otNumber: string | null } {
  // Honest fallback: do NOT pretend to register anything. Just acknowledge and route.
  const update = interpretMessage(msg);
  const safeReply = "📩 Mensaje recibido. Un arquitecto te responderá pronto.";
  return {
    reply: safeReply,
    needsAlert: update.type === "problem_report",
    otNumber: update.otNumber || null,
  };
}

const handleMessage = async (msg: IncomingMessage): Promise<string | null> => {
  if (msg.isGroup) return null;

  const senderLabel = msg.profileName || msg.from;
  const managerPhone = process.env.MANAGER_WHATSAPP;
  let reply: string;
  let needsAlert = false;
  let alertSummary = "";
  let otRef: string | null = null;
  let urgency: string = "normal";

  if (isLLMConfigured()) {
    try {
      const result = await runLLMInterpretation(msg);
      console.log(
        `[LLM] intent=${result.intent} ot=${result.ot_number || "?"} urgency=${result.urgency} ` +
          `confidence=${result.confidence} needs_human=${result.needs_human}`
      );
      console.log(`[LLM] summary: ${result.summary}`);
      reply = result.reply;
      otRef = result.ot_number;
      urgency = result.urgency;
      needsAlert =
        result.urgency === "critical" ||
        (result.urgency === "high" && result.needs_human) ||
        result.intent === "problem_report";
      alertSummary = result.summary;
    } catch (err) {
      console.error("[LLM] failed, using safe fallback:", (err as Error).message);
      const fb = fallbackReply(msg);
      reply = fb.reply;
      needsAlert = fb.needsAlert;
      otRef = fb.otNumber;
      alertSummary = msg.body.substring(0, 200);
    }
  } else {
    console.warn("[LLM] GEMINI_API_KEY not set — using safe fallback (no false 'registered' replies)");
    const fb = fallbackReply(msg);
    reply = fb.reply;
    needsAlert = fb.needsAlert;
    otRef = fb.otNumber;
    alertSummary = msg.body.substring(0, 200);
  }

  if (needsAlert && managerPhone) {
    const icon = urgency === "critical" ? "🚨" : "⚠️";
    const alertMsg =
      `${icon} ${urgency.toUpperCase()} — mensaje de ${senderLabel}\n` +
      `OT: ${otRef || "no especificado"}\n` +
      `Resumen: ${alertSummary}\n` +
      `Texto original: ${msg.body.substring(0, 300)}`;
    await whatsapp.sendMessage(managerPhone, alertMsg).catch(console.error);
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

  // Start pair server FIRST so it's reachable while Baileys is generating the QR.
  // Railway provides PORT; use 3000 locally.
  const port = parseInt(process.env.PORT || "3000", 10);
  startPairServer({ port, whatsapp, authToken: process.env.PAIR_TOKEN });

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
