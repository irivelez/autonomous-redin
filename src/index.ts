import "dotenv/config";
import { AppSheetClient } from "./clients/appsheet.js";
import { WhatsAppClient, type IncomingMessage } from "./clients/whatsapp.js";
import { ExecutionMonitor, formatAlerts } from "./tracker/monitor.js";
import { startPairServer } from "./cli/pair-server.js";
import { interpretWithLLM, isLLMConfigured, type IntentResult, type SenderRole } from "./llm/intent.js";
import { extractOTNumber } from "./llm/context.js";
import { buildOpsBundle, renderBundleForPrompt } from "./llm/context-bundle.js";
import cron from "node-cron";

const appsheet = new AppSheetClient({
  appId: process.env.APPSHEET_APP_ID!,
  accessKey: process.env.APPSHEET_ACCESS_KEY!,
});

const whatsapp = new WhatsAppClient();
const monitor = new ExecutionMonitor(appsheet);

// Phone → role mapping. In v1, MANAGER_WHATSAPP = José. Anything else defaults to
// "architect" (internal expert). External/client detection comes later.
function detectSenderRole(phone: string): SenderRole {
  const manager = process.env.MANAGER_WHATSAPP?.replace(/[^0-9]/g, "");
  const clean = phone.replace(/[^0-9]/g, "");
  if (manager && clean === manager) return "manager";
  return "architect";
}

function formatReplyForWhatsApp(result: IntentResult): string {
  const lines: string[] = [result.reply.trim()];
  if (result.suggested_actions.length > 0) {
    lines.push("");
    lines.push("*Acciones sugeridas:*");
    for (const a of result.suggested_actions.slice(0, 4)) {
      lines.push(`• ${a}`);
    }
  }
  return lines.join("\n");
}

async function runLLMInterpretation(msg: IncomingMessage, senderRole: SenderRole): Promise<IntentResult> {
  const otNumber = extractOTNumber(msg.body);
  const bundle = await buildOpsBundle(appsheet, otNumber);
  const opsContext = renderBundleForPrompt(bundle);

  return interpretWithLLM({
    message: msg.body,
    hasPhotos: msg.mediaBuffers.length > 0,
    senderName: msg.profileName,
    senderPhone: msg.from,
    senderRole,
    opsContext,
  });
}

const handleMessage = async (msg: IncomingMessage): Promise<string | null> => {
  if (msg.isGroup) return null;

  const senderLabel = msg.profileName || msg.from;
  const senderRole = detectSenderRole(msg.from);
  const managerPhone = process.env.MANAGER_WHATSAPP;
  let reply: string;
  let needsAlert = false;
  let alertSummary = "";
  let otRef: string | null = null;
  let urgency = "normal";

  console.log(`[Handler] from=${senderLabel} (${msg.from}) role=${senderRole} text="${msg.body.substring(0, 100)}"`);

  if (!isLLMConfigured()) {
    console.warn("[LLM] GEMINI_API_KEY not set — acknowledging safely.");
    reply = "📩 Mensaje recibido. Asistente operativo sin configurar (falta GEMINI_API_KEY).";
    return reply;
  }

  try {
    const result = await runLLMInterpretation(msg, senderRole);
    console.log(
      `[LLM] intent=${result.intent} ot=${result.ot_number || "?"} urgency=${result.urgency} ` +
        `confidence=${result.confidence} needs_human=${result.needs_human}`
    );
    console.log(`[LLM] summary: ${result.summary}`);
    if (result.suggested_actions.length > 0) {
      console.log(`[LLM] suggested: ${result.suggested_actions.join(" | ")}`);
    }
    reply = formatReplyForWhatsApp(result);
    console.log(`[LLM] reply: ${reply.replace(/\n/g, " ⏎ ").substring(0, 300)}`);
    otRef = result.ot_number;
    urgency = result.urgency;
    needsAlert =
      senderRole !== "manager" &&
      (result.urgency === "critical" ||
        (result.urgency === "high" && result.needs_human) ||
        result.intent === "problem_report");
    alertSummary = result.summary;
  } catch (err) {
    console.error("[LLM] failed:", (err as Error).message);
    reply = "⚠️ Error temporal en el asistente operativo. Reintenta en un momento o escribe directo al arquitecto.";
  }

  if (needsAlert && managerPhone) {
    const icon = urgency === "critical" ? "🚨" : "⚠️";
    const alertMsg =
      `${icon} ${urgency.toUpperCase()} — de ${senderLabel}\n` +
      `OT: ${otRef || "no especificado"}\n` +
      `Resumen: ${alertSummary}\n` +
      `Texto: ${msg.body.substring(0, 300)}`;
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

  const port = parseInt(process.env.PORT || "3000", 10);
  startPairServer({ port, whatsapp, authToken: process.env.PAIR_TOKEN });

  await runScan();

  cron.schedule("*/30 8-19 * * 1-6", runScan, { timezone: "America/Bogota" });
  console.log("[Cron] Scheduled: scan every 30 min, Mon-Sat 8am-7pm COT");

  console.log("\n[WhatsApp] Iniciando conexión...");
  await whatsapp.connect(handleMessage);
}

main().catch(console.error);
