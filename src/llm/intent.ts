import { GoogleGenAI, Type } from "@google/genai";
import type { OrdenTrabajo } from "../clients/appsheet.js";

export type Intent =
  | "completion_report"
  | "problem_report"
  | "progress_update"
  | "start_work"
  | "photo_evidence"
  | "schedule_request"
  | "payment_question"
  | "quote_question"
  | "general_question"
  | "general_chat"
  | "unknown";

export type Urgency = "critical" | "high" | "normal" | "low";

export interface IntentResult {
  intent: Intent;
  ot_number: string | null;
  urgency: Urgency;
  needs_human: boolean;
  summary: string;
  reply: string;
  confidence: "high" | "medium" | "low";
}

export interface InterpretInput {
  message: string;
  hasPhotos: boolean;
  senderName?: string;
  senderPhone: string;
  ot?: OrdenTrabajo | null;
}

const MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 12000;

const SYSTEM_PROMPT = `Eres el asistente operativo de REDIN (Red de Ingenieros Nacional), una empresa colombiana B2B de mantenimiento locativo y telecomunicaciones que opera en 30% de las capitales de Colombia.

CONTEXTO DE NEGOCIO:
- Redin atiende ~100 órdenes de trabajo (OTs) al mes para 3 clientes principales: Casa Limpia, Servicios Bolívar, e Inter Rapidísimo (este último tiene SLAs estrictos con multas por hora de retraso).
- El trabajo lo ejecutan "maestros" (contratistas) coordinados por arquitectos internos de Redin.
- Servicios: pintura, plomería, eléctrico, cableado, aire acondicionado, mobiliario, ornamentación.
- Horario operativo: Lun-Vie 8am-6pm, Sáb 8am-12pm. Urgencias se extienden.

CICLO DE VIDA DE UNA OT:
Solicitud → Visita → Cotización → Aprobación → Coordinar → En ejecución → Por aprobar → Terminado → Facturado → Pagado

QUIÉN TE ESCRIBE:
- Maestros/contratistas reportando avance, problemas, fotos, finalización en sitio
- Arquitectos coordinando con contratistas
- Eventualmente clientes con consultas
Identifica el tipo de remitente por el contexto del mensaje.

TU TRABAJO:
1. Clasificar la intención del mensaje con precisión.
2. Extraer el número de OT si se menciona (busca "OT 123", "orden 123", "#123").
3. Evaluar urgencia: critical=SLA en riesgo o accidente; high=problema bloqueante; normal=actualización rutinaria; low=charla casual.
4. Responder en español, profesional, conciso (máx 2 frases). Sin emojis excesivos (máx 1 si aporta).
5. NUNCA mientas sobre acciones tomadas. Si solo recibimos el mensaje sin actualizar AppSheet, di "recibido y notificado al arquitecto", NO "actualización registrada en el sistema".
6. Si te dan datos reales de la OT (estado actual, arquitecto asignado, deadline), úsalos en tu respuesta para sonar real.
7. Marca needs_human=true si: el caso requiere decisión humana, hay ambigüedad, o el mensaje es complejo.

FORMATO DE SALIDA: JSON estructurado según el esquema dado. NO agregues markdown ni texto fuera del JSON.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: [
        "completion_report",
        "problem_report",
        "progress_update",
        "start_work",
        "photo_evidence",
        "schedule_request",
        "payment_question",
        "quote_question",
        "general_question",
        "general_chat",
        "unknown",
      ],
      description: "Tipo de intención principal del mensaje",
    },
    ot_number: {
      type: Type.STRING,
      nullable: true,
      description: "Número de OT mencionado (solo dígitos), o null",
    },
    urgency: {
      type: Type.STRING,
      enum: ["critical", "high", "normal", "low"],
      description: "Nivel de urgencia",
    },
    needs_human: {
      type: Type.BOOLEAN,
      description: "True si requiere intervención humana de un arquitecto",
    },
    summary: {
      type: Type.STRING,
      description: "Resumen en una línea de qué dijo el remitente, en español",
    },
    reply: {
      type: Type.STRING,
      description: "Respuesta en español para enviar al remitente. Máx 2 frases. Profesional y honesta.",
    },
    confidence: {
      type: Type.STRING,
      enum: ["high", "medium", "low"],
      description: "Qué tan seguro estás de la clasificación",
    },
  },
  required: ["intent", "ot_number", "urgency", "needs_human", "summary", "reply", "confidence"],
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
  parts.push(`Mensaje recibido por WhatsApp:`);
  parts.push(`De: ${input.senderName || "(sin nombre)"} (${input.senderPhone})`);
  parts.push(`Texto: """${input.message || "(sin texto)"}"""`);
  if (input.hasPhotos) parts.push(`Adjuntos: el mensaje incluye foto(s).`);

  if (input.ot) {
    const ot = input.ot;
    parts.push(`\nDATOS REALES DE LA OT MENCIONADA (úsalos en tu respuesta para sonar real):`);
    parts.push(`- Número: #${ot.Numero_Orden}`);
    parts.push(`- Estado actual: ${ot.Estado}`);
    parts.push(`- Ciudad: ${ot.Ciudad}`);
    parts.push(`- Cliente: ${ot.ID_Cliente}`);
    parts.push(`- Arquitecto asignado: ${ot.Nombre_Arquitecto_Real || "(sin asignar)"}`);
    if (ot.Descripcion) parts.push(`- Descripción: ${ot.Descripcion.substring(0, 200)}`);
    if (ot.Fecha_Limite_Solucion) parts.push(`- Deadline solución (Inter Rapidísimo): ${ot.Fecha_Limite_Solucion}`);
    if (ot.Alerta_Respuesta) parts.push(`- Alerta respuesta SLA: ${ot.Alerta_Respuesta}`);
    if (ot.Alerta_Solucion) parts.push(`- Alerta solución SLA: ${ot.Alerta_Solucion}`);
  } else if (input.message.match(/(?:ot|orden|#)\s*(\d+)/i)) {
    parts.push(`\nEl remitente menciona una OT pero no se encontró en AppSheet. Pídele que confirme el número.`);
  }

  return parts.join("\n");
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
      temperature: 0.2,
      maxOutputTokens: 600,
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Gemini timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
  );

  const response = await Promise.race([callPromise, timeoutPromise]);
  const text = response.text;
  if (!text) throw new Error("Gemini returned empty response");

  const parsed = JSON.parse(text) as IntentResult;

  // Defensive normalization
  if (parsed.ot_number === "null" || parsed.ot_number === "") parsed.ot_number = null;
  if (typeof parsed.needs_human !== "boolean") parsed.needs_human = false;

  // Cost tracking (Gemini 2.5 Flash pricing as of 2026: ~$0.075/1M input, $0.30/1M output)
  const usage = response.usageMetadata;
  if (usage) {
    const inTok = usage.promptTokenCount || 0;
    const outTok = usage.candidatesTokenCount || 0;
    const cents = ((inTok * 0.075 + outTok * 0.30) / 1_000_000) * 100;
    console.log(`[LLM] tokens in=${inTok} out=${outTok} cost=$${(cents / 100).toFixed(5)}`);
  }

  return parsed;
}
