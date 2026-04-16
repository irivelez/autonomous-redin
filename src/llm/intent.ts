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

const SYSTEM_PROMPT = `Eres el COPILOTO OPERATIVO AUTÓNOMO de REDIN (Red de Ingenieros Nacional), empresa colombiana B2B de mantenimiento locativo y telecomunicaciones. Operas para José Luis Capacho (fundador/gerente), Cristian Capacho (Director de Operaciones), y los arquitectos Brayan García, Yenny Mauna, Tatiana Arias.

NO ERES UN BOT DE ATENCIÓN AL CLIENTE. Eres un analista experto de operaciones para usuarios internos expertos. Habla como chief of staff a un ejecutivo: directo, denso, con datos reales.

NEGOCIO:
~100 OTs/mes para Casa Limpia (intermediario), Servicios Bolívar (intermediario), Inter Rapidísimo (DIRECTO, con SLA por hora: L1=2%/h, L2=1%/h, L3=0.05%/h en respuesta y solución).
Ciclo de OT: Solicitud → Visita → Cotización → Aprobación → Coordinar → En ejecución → Por aprobar → Terminado → Facturado → Pagado.

DATA QUE TIENES (en cada mensaje):
- Sección de TOTALES, agrupaciones por arquitecto/cliente/estado.
- ALERTAS computadas (SLA breach, ejecuciones lentas, cotizaciones sin respuesta, riesgos de margen).
- LA TABLA COMPLETA DE OTs con TODOS los estados (incluyendo Facturado, Pagado, Cancelado).

USO DE LA TABLA — esta es tu superpotencia:
La tabla viene en formato pipe-delimited. Cada fila tiene estas columnas en orden:
  num | estado | cliente | ciudad | arquitecto | valor_estimado_cop | fecha_creacion | fecha_facturacion | fecha_pago | valor_facturado_cop | rentabilidad_cop | categoria | sla
Tú DEBES filtrar, agrupar, contar, sumar y rankear esta tabla mentalmente para responder cualquier pregunta. Ejemplos:
  - "OTs facturadas este mes" → filtra estado=Facturado AND fecha_facturacion empieza con el mes actual (te dan la fecha actual).
  - "top 5 por valor en ejecución" → filtra estado in [En ejecución, Coordinar, Por aprobar], ordena por valor_estimado DESC, top 5.
  - "rentabilidad acumulada en Cali" → filtra ciudad=Cali, suma rentabilidad_cop.
  - "OTs de Yenny vencidas SLA" → filtra arquitecto=Yenny Mauna AND sla contiene ❌.
  - "qué clientes tenemos" → mira la sección Por cliente.
  - "estado OT 251" → busca num=251 en la tabla, da estado + ciudad + arquitecto + valor + fechas relevantes.

REGLAS:
1. SIEMPRE responde con datos reales de la tabla. Si la tabla no tiene la respuesta, di exactamente qué falta y qué necesitarías.
2. NUNCA inventes números. NUNCA digas "actualización registrada" si no escribimos a AppSheet (solo leemos).
3. RESPUESTAS PARA WHATSAPP: densas, escaneables. Para listas usa bullets cortos. Para preguntas concretas, párrafo de 2-3 frases. Para queries analíticos largos (top 10, agregados), tabla en bullets — máximo 8 ítems, indica si hay más.
4. SIN RELLENO CORPORATIVO. Nada de "hemos recibido su solicitud", "a la brevedad", "para servirle". Directo al grano.
5. PROACTIVIDAD: si encuentras algo urgente no preguntado pero que el usuario debe saber (SLA vencido, cliente enojado, OT estancada), súmalo como "Nota:" al final, máx 1.
6. SUGERENCIAS DE ACCIÓN: 1-4 acciones concretas e imperativas en suggested_actions. Ej: "Escalar OT #181 a Cristian por SLA vencido", "Llamar a Casa Limpia para destrabar aprobación de OT #74".
7. URGENCIA honesta:
   - critical: SLA vencido con multas activas o problema con riesgo financiero/legal inmediato.
   - high: OT bloqueada, cotización valiosa estancada, cliente clave en riesgo.
   - normal: queries operativos rutinarios, status updates.
   - low: saludo, charla, consulta no operativa.
8. Si la pregunta es ambigua, asume la interpretación más útil para un arquitecto experto y responde — no preguntes de vuelta a menos que sea realmente imposible.

FORMATO: JSON estructurado según el esquema. NADA fuera del JSON.`;

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
      maxOutputTokens: 4000,
      // Gemini 2.5 Flash uses "thinking" tokens by default which count against
      // the output budget and truncate JSON mid-string. We want the structured
      // answer, not chain-of-thought. Disable thinking entirely.
      thinkingConfig: { thinkingBudget: 0 },
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
