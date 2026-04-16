import { GoogleGenAI, Type } from "@google/genai";

export type Intent =
  | "operational_query"
  | "status_request"
  | "action_request"
  | "completion_report"
  | "problem_report"
  | "progress_update"
  | "schedule_request"
  | "payment_question"
  | "quote_question"
  | "general_chat"
  | "unknown";

export type Urgency = "critical" | "high" | "normal" | "low";
export type SenderRole = "architect" | "manager" | "contractor" | "client" | "unknown";

export interface IntentResult {
  intent: Intent;
  ot_number: string | null;
  urgency: Urgency;
  needs_human: boolean;
  summary: string;
  reply: string;
  suggested_actions: string[];
  confidence: "high" | "medium" | "low";
}

export interface InterpretInput {
  message: string;
  hasPhotos: boolean;
  senderName?: string;
  senderPhone: string;
  senderRole: SenderRole;
  opsContext: string;
}

const MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 15000;

const SYSTEM_PROMPT = `Eres el ASISTENTE EJECUTIVO AUTÓNOMO de REDIN (Red de Ingenieros Nacional), empresa colombiana B2B de mantenimiento locativo y telecomunicaciones. Operas para José Luis Capacho (fundador/gerente), Cristian Capacho (Director de Operaciones), y los arquitectos Brayan García, Yenny Mauna, Tatiana Arias.

NO ERES UN BOT DE ATENCIÓN AL CLIENTE. Eres un COPILOTO OPERATIVO para los arquitectos y la gerencia. Tu usuario es interno y experto — habla como chief of staff, no como recepcionista.

NEGOCIO EN UNA LÍNEA:
~100 OTs/mes para Casa Limpia (32 OTs, intermediario), Servicios Bolívar (25 OTs, intermediario), e Inter Rapidísimo (22 OTs, DIRECTO, con SLA de multas por hora: L1=2%/h respuesta, L2=1%/h, L3=0.05%/h).

CICLO DE UNA OT:
Solicitud → Visita → Cotización → Aprobación → Coordinar → En ejecución → Por aprobar → Terminado → Facturado → Pagado

QUÉ HACES:
1. INTERPRETAR la intención real del usuario.
2. USAR el BRIEFING OPERATIVO que te dan como verdad absoluta — es data real de AppSheet de Redin, recién leída.
3. DAR RESPUESTAS PROACTIVAS y ACCIONABLES:
   - Si preguntan estado general → responde con los números reales del briefing + qué necesita atención ahora.
   - Si preguntan por una OT específica → resume estado + próximo paso claro + alerta si hay SLA/retraso.
   - Si reportan un evento → resume qué debe hacer el arquitecto + sugiere la próxima acción.
4. SUGERIR ACCIONES CONCRETAS en el campo suggested_actions (frases imperativas cortas, ej: "Llamar al maestro de OT 198", "Enviar recordatorio de cotización a Casa Limpia sobre OT 230", "Escalar OT 170 a Cristian por SLA vencido").
5. CLASIFICAR urgencia honestamente:
   - critical = SLA vencido o a <1h de vencer con multas activas
   - high = OT bloqueada, maestro sin respuesta, cliente enojado, problema técnico en sitio
   - normal = actualización rutinaria, preguntas de estado
   - low = saludo, charla, consulta no operativa

REGLAS DURAS:
- NUNCA mientas sobre acciones tomadas. Si solo diste info, NO digas "actualización registrada" ni "ya notifiqué al arquitecto" — solo di lo que realmente pasó.
- RESPUESTAS CORTAS Y DENSAS. Máximo 3 frases o 4 bullets. Datos reales del briefing, no generalidades. Sin relleno corporativo ("hemos recibido su solicitud", "a la brevedad"). Directo.
- Usa los NOMBRES REALES que ves en el briefing (arquitectos, ciudades, clientes, números de OT).
- El usuario es experto — no expliques lo obvio.
- Si el briefing muestra algo crítico no relacionado a la pregunta pero que el usuario debe saber, SURFACEALO al final: "— Nota: OT 170 Neiva tiene SLA vencido, requiere atención."

FORMATO: JSON estructurado. Nada fuera del JSON.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: [
        "operational_query",
        "status_request",
        "action_request",
        "completion_report",
        "problem_report",
        "progress_update",
        "schedule_request",
        "payment_question",
        "quote_question",
        "general_chat",
        "unknown",
      ],
    },
    ot_number: { type: Type.STRING, nullable: true },
    urgency: { type: Type.STRING, enum: ["critical", "high", "normal", "low"] },
    needs_human: { type: Type.BOOLEAN },
    summary: { type: Type.STRING, description: "Resumen en una línea" },
    reply: {
      type: Type.STRING,
      description:
        "Respuesta densa y accionable en español. Usa datos reales del briefing. Máx 3 frases o 4 bullets. Sin relleno corporativo.",
    },
    suggested_actions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Acciones concretas que el arquitecto/gerente puede tomar ahora. 0-4 items. Frases imperativas cortas.",
    },
    confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
  },
  required: ["intent", "ot_number", "urgency", "needs_human", "summary", "reply", "suggested_actions", "confidence"],
};

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no está configurado");
  client = new GoogleGenAI({ apiKey });
  return client;
}

export function isLLMConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

function buildUserPrompt(input: InterpretInput): string {
  const parts: string[] = [];
  parts.push(`REMITENTE: ${input.senderName || "(sin nombre)"} (${input.senderPhone}) — rol detectado: ${input.senderRole}`);
  parts.push(`MENSAJE: """${input.message || "(sin texto)"}"""`);
  if (input.hasPhotos) parts.push(`ADJUNTOS: el mensaje incluye foto(s).`);
  parts.push(`\n=== ${input.opsContext} ===\n`);
  parts.push(
    `Responde al mensaje del remitente usando el briefing de arriba. Si el mensaje es una consulta operativa, responde con datos reales. Si reporta algo, sugiere próximos pasos concretos.`
  );
  return parts.join("\n");
}

/**
 * Gemini sometimes emits literal control chars (\n, \r, \t) inside string
 * values, which breaks JSON.parse. Walk the text and escape control chars
 * only when we're inside an unescaped string. Idempotent on already-valid JSON.
 */
function sanitizeLLMJSON(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += c;
    } else {
      out += c;
    }
  }
  return out;
}

function parseLLMJSON<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const sanitized = sanitizeLLMJSON(text);
    try {
      return JSON.parse(sanitized) as T;
    } catch (err2) {
      console.error("[LLM] Raw response that failed to parse (first 1500 chars):");
      console.error(text.substring(0, 1500));
      throw err2;
    }
  }
}

export async function interpretWithLLM(input: InterpretInput): Promise<IntentResult> {
  const ai = getClient();
  const userPrompt = buildUserPrompt(input);

  const callPromise = ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 800,
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Gemini timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  );

  const response = await Promise.race([callPromise, timeoutPromise]);
  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");

  const parsed = parseLLMJSON<IntentResult>(text);

  if (parsed.ot_number === "null" || parsed.ot_number === "") parsed.ot_number = null;
  if (typeof parsed.needs_human !== "boolean") parsed.needs_human = false;
  if (!Array.isArray(parsed.suggested_actions)) parsed.suggested_actions = [];

  const usage = response.usageMetadata;
  if (usage) {
    const inTok = usage.promptTokenCount || 0;
    const outTok = usage.candidatesTokenCount || 0;
    const cents = ((inTok * 0.075 + outTok * 0.30) / 1_000_000) * 100;
    console.log(`[LLM] tokens in=${inTok} out=${outTok} cost=$${(cents / 100).toFixed(5)}`);
  }

  return parsed;
}
