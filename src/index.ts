import "dotenv/config";
import cron from "node-cron";
import { AppSheetClient } from "./clients/appsheet.js";
import { ArchitectLookup } from "./clients/architect-lookup.js";
import { UserRegistry, normalizePhone, type EnrolledUser, type UserRole } from "./clients/user-registry.js";
import {
  TelegramClient,
  type CallbackEvent,
  type ContactEvent,
  type TextMessageEvent,
} from "./clients/telegram.js";
import { ExecutionMonitor, formatAlerts } from "./tracker/monitor.js";
import { interpretWithLLM, isLLMConfigured, type IntentResult } from "./llm/intent.js";
import { extractOTNumber } from "./llm/context.js";
import { buildOpsBundle, renderBundleForPrompt } from "./llm/context-bundle.js";

const TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const MANAGER_PHONE_RAW = process.env.MANAGER_PHONE || "";
const MANAGER_PHONE = normalizePhone(MANAGER_PHONE_RAW);

const appsheet = new AppSheetClient({
  appId: requireEnv("APPSHEET_APP_ID"),
  accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
});

const telegram = new TelegramClient(TOKEN);
const registry = new UserRegistry();
const architects = new ArchitectLookup(appsheet);
const monitor = new ExecutionMonitor(appsheet);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[Config] Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function roleFromPhone(phone: string, isInArquitectoTable: boolean): UserRole | null {
  if (MANAGER_PHONE && normalizePhone(phone) === MANAGER_PHONE) return "manager";
  if (isInArquitectoTable) return "architect";
  return null;
}

function managerChatId(): number | null {
  const envId = process.env.MANAGER_TELEGRAM_CHAT_ID;
  if (envId) return parseInt(envId, 10);
  const m = registry.allEnrolled().find((u) => u.role === "manager");
  return m?.chatId ?? null;
}

function formatReply(result: IntentResult): string {
  const lines: string[] = [result.reply.trim()];
  if (result.suggested_actions.length > 0) {
    lines.push("");
    lines.push("*Acciones sugeridas:*");
    for (const a of result.suggested_actions.slice(0, 4)) lines.push(`• ${a}`);
  }
  return lines.join("\n");
}

export async function interpretForUser(params: {
  user: EnrolledUser;
  text: string;
  hasMedia: boolean;
}): Promise<IntentResult> {
  const { user, text, hasMedia } = params;
  const otNumber = extractOTNumber(text);
  const bundle = await buildOpsBundle(appsheet, otNumber);
  const opsContext = renderBundleForPrompt(bundle);
  return interpretWithLLM({
    message: text,
    hasPhotos: hasMedia,
    senderName: user.name,
    senderPhone: user.phone,
    senderRole: user.role,
    opsContext,
  });
}

async function handleText(ev: TextMessageEvent): Promise<void> {
  const user = registry.findByChatId(ev.chatId);
  if (!user) {
    await telegram.sendText(
      ev.chatId,
      "No estás autorizado todavía. Usa /start para registrarte."
    );
    return;
  }

  const displayName = user.name;
  console.log(`[Msg] ${displayName} (${user.role}) chat=${ev.chatId}: "${ev.text.substring(0, 100)}"`);

  if (!isLLMConfigured()) {
    await telegram.sendText(ev.chatId, "⚠️ Asistente sin configurar (falta GEMINI_API_KEY).");
    return;
  }

  try {
    const result = await interpretForUser({ user, text: ev.text, hasMedia: ev.hasMedia });
    console.log(
      `[LLM] ${displayName} intent=${result.intent} ot=${result.ot_number ?? "?"} ` +
        `urgency=${result.urgency} confidence=${result.confidence}`
    );
    console.log(`[LLM] summary: ${result.summary}`);
    const replyFlat = formatReply(result).replace(/\n/g, " ⏎ ");
    console.log(`[LLM] reply: ${replyFlat.substring(0, 500)}`);
    if (result.suggested_actions.length > 0) {
      console.log(`[LLM] suggested: ${result.suggested_actions.join(" | ")}`);
    }
    await telegram.sendText(ev.chatId, formatReply(result));

    const mgrChat = managerChatId();
    const alertWorthy =
      user.role !== "manager" &&
      (result.urgency === "critical" ||
        (result.urgency === "high" && result.needs_human) ||
        result.intent === "problem_report");
    if (alertWorthy && mgrChat && mgrChat !== ev.chatId) {
      const icon = result.urgency === "critical" ? "🚨" : "⚠️";
      const alertBody =
        `${icon} ${result.urgency.toUpperCase()} — de ${displayName}\n` +
        `OT: ${result.ot_number ?? "no especificado"}\n` +
        `Resumen: ${result.summary}\n` +
        `Texto: ${ev.text.substring(0, 300)}`;
      telegram.sendText(mgrChat, alertBody).catch((e) => console.error("[Alert] manager send:", e));
    }
  } catch (err) {
    console.error("[LLM] failed:", (err as Error).message);
    await telegram.sendText(
      ev.chatId,
      "⚠️ Error temporal en el asistente. Reintenta en un momento."
    );
  }
}

async function handleStart(chatId: number, firstName?: string): Promise<void> {
  const existing = registry.findByChatId(chatId);
  if (existing) {
    await telegram.sendText(
      chatId,
      `Hola ${existing.name}, ya estás registrado como ${existing.role}. Hazme una pregunta operativa directamente.`
    );
    return;
  }
  await telegram.sendText(
    chatId,
    `Hola${firstName ? ` ${firstName}` : ""} — soy el copiloto operativo de Redin.\n\n` +
      `Para confirmar tu identidad, comparte tu número de teléfono con el botón abajo. Solo el personal autorizado puede usar el bot.`,
    { kind: "share_phone", text: "📱 Compartir mi número" }
  );
}

async function handleContact(ev: ContactEvent): Promise<void> {
  if (ev.contactUserId && ev.contactUserId !== ev.userId) {
    await telegram.sendText(
      ev.chatId,
      "Por seguridad, debes compartir TU propio número (no el de otro contacto)."
    );
    return;
  }

  const phone = ev.phoneNumber.startsWith("+") ? ev.phoneNumber : `+${ev.phoneNumber}`;
  const normalized = normalizePhone(phone);

  let arq = null;
  try {
    arq = await architects.findByPhone(phone);
  } catch (err) {
    console.error("[Enroll] Arquitecto lookup failed:", (err as Error).message);
    await telegram.sendText(ev.chatId, "⚠️ No pude verificar tu registro. Intenta de nuevo en un momento.");
    return;
  }

  const role = roleFromPhone(phone, !!arq);
  if (role) {
    const name = role === "manager" ? (arq?.Arquitecto || ev.firstName || "Manager") : arq!.Arquitecto;
    const user = registry.enroll({
      chatId: ev.chatId,
      userId: ev.userId,
      phone,
      name,
      role,
    });
    console.log(`[Enroll] ✅ ${user.name} (${user.role}) — ${phone} — chat=${ev.chatId}`);

    await telegram.sendText(
      ev.chatId,
      `✅ Autorizado. Bienvenido ${user.name} (${user.role}).\n\n` +
        `Soy tu analista operativo. Pregúntame sobre OTs, rentabilidad, SLAs, cotizaciones pendientes — en lenguaje natural.`,
      { kind: "remove_keyboard" }
    );

    const mgrChat = managerChatId();
    if (mgrChat && mgrChat !== ev.chatId) {
      telegram
        .sendText(mgrChat, `ℹ️ Nuevo usuario enrolado: ${user.name} (${user.role}) — ${phone}`)
        .catch((e) => console.error("[Enroll] manager notify:", e));
    }
    return;
  }

  const displayName = ev.firstName || "(sin nombre)";
  registry.addPending({
    chatId: ev.chatId,
    userId: ev.userId,
    phone,
    displayName,
  });

  await telegram.sendText(
    ev.chatId,
    "He enviado tu solicitud al administrador. Te avisaré cuando autorice tu acceso.",
    { kind: "remove_keyboard" }
  );

  const mgrChat = managerChatId();
  if (!mgrChat) {
    console.warn(`[Enroll] Pending: ${displayName} ${phone} chat=${ev.chatId} — no manager chat configured yet`);
    return;
  }

  const data = `approve:${ev.chatId}:${normalized}`;
  const denyData = `deny:${ev.chatId}`;
  await telegram.sendText(
    mgrChat,
    `🆕 Solicitud de acceso\n\n` +
      `Nombre: ${displayName}\n` +
      `Teléfono: ${phone}\n` +
      `¿Autorizas?`,
    {
      kind: "inline",
      rows: [[{ text: "✅ Autorizar", data }, { text: "❌ Rechazar", data: denyData }]],
    }
  );
}

async function handleCallback(ev: CallbackEvent): Promise<void> {
  const user = registry.findByChatId(ev.chatId);
  if (!user || user.role !== "manager") {
    await ev.answer("Solo el administrador puede autorizar.");
    return;
  }

  if (ev.data.startsWith("approve:")) {
    const parts = ev.data.split(":");
    const targetChatId = parseInt(parts[1], 10);
    const pending = registry.findPending(targetChatId);
    if (!pending) {
      await ev.answer("La solicitud ya no existe.");
      return;
    }
    const enrolled = registry.enroll({
      chatId: pending.chatId,
      userId: pending.userId,
      phone: pending.phone,
      name: pending.displayName,
      role: "architect",
    });
    await ev.answer("Autorizado");
    if (ev.messageId) {
      await telegram.editMessageText(
        ev.chatId,
        ev.messageId,
        `✅ Autorizado: ${enrolled.name} (${enrolled.phone})`
      );
    }
    telegram
      .sendText(
        enrolled.chatId,
        `✅ El administrador autorizó tu acceso. Bienvenido ${enrolled.name}.\n\nPregúntame lo que necesites sobre operaciones de Redin.`
      )
      .catch((e) => console.error("[Callback] notify enrolled:", e));
    return;
  }

  if (ev.data.startsWith("deny:")) {
    const parts = ev.data.split(":");
    const targetChatId = parseInt(parts[1], 10);
    const pending = registry.findPending(targetChatId);
    registry.removePending(targetChatId);
    await ev.answer("Rechazado");
    if (ev.messageId) {
      await telegram.editMessageText(
        ev.chatId,
        ev.messageId,
        `❌ Rechazado: ${pending?.displayName ?? "solicitante"} (${pending?.phone ?? targetChatId})`
      );
    }
    if (pending) {
      telegram
        .sendText(pending.chatId, "El administrador no autorizó tu acceso.")
        .catch((e) => console.error("[Callback] notify denied:", e));
    }
    return;
  }

  await ev.answer();
}

async function runScan(): Promise<void> {
  console.log(`\n[Scan] ${new Date().toLocaleString("es-CO")} — Scanning...`);
  try {
    const alerts = await monitor.scan();
    console.log(formatAlerts(alerts));
    const mgrChat = managerChatId();
    if (!mgrChat) return;
    const critical = alerts.filter((a) => a.severity === "critical" || a.severity === "high");
    if (critical.length === 0) return;
    const summary = critical.slice(0, 10).map((a) => a.message).join("\n");
    await telegram.sendAlert(
      mgrChat,
      `🚨 ${critical.length} alertas críticas en Redin`,
      summary
    );
  } catch (err) {
    console.error("[Scan] Error:", err);
  }
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════");
  console.log("  REDIN Copilot — Telegram edition     ");
  console.log("═══════════════════════════════════════\n");

  telegram.wire({
    onStart: async (ctx) => {
      if (!ctx.chat) return;
      await handleStart(ctx.chat.id, ctx.from?.first_name);
    },
    onContact: handleContact,
    onText: handleText,
    onCallback: handleCallback,
  });

  // Prime caches so first user gets a fast response.
  architects.all().catch((e) => console.error("[Init] Arquitecto prefetch:", (e as Error).message));

  await runScan();
  cron.schedule("*/30 8-19 * * 1-6", runScan, { timezone: "America/Bogota" });
  console.log("[Cron] Scheduled: scan every 30 min, Mon-Sat 8am-7pm COT");

  await telegram.start();
}

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
