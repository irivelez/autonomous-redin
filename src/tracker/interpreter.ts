import type { IncomingMessage } from "../clients/whatsapp.js";

export interface InterpretedUpdate {
  type: "status_update" | "completion_report" | "problem_report" | "photo_evidence" | "question" | "unknown";
  otNumber?: string;
  city?: string;
  status?: "started" | "in_progress" | "completed" | "blocked";
  description: string;
  hasPhotos: boolean;
}

const OT_NUMBER_PATTERN = /(?:ot|orden|#)\s*(\d+)/i;
const COMPLETION_KEYWORDS = /termin[éóa]|listo|acabé|finaliz[éóa]|entrega|complet/i;
const PROBLEM_KEYWORDS = /problem|dañ|falt[aó]|no se pued|dificultad|imprevist|atraso|retraso|demora/i;
const START_KEYWORDS = /empec[eé]|inici[eé]|arranqu[eé]|ya estoy|llegué|en sitio/i;
const PROGRESS_KEYWORDS = /avance|progreso|llevamos|vamos en|estamos en|porcentaje/i;

export function interpretMessage(msg: IncomingMessage): InterpretedUpdate {
  const text = msg.body.toLowerCase().trim();

  const otMatch = msg.body.match(OT_NUMBER_PATTERN);
  const otNumber = otMatch ? otMatch[1] : undefined;

  const hasPhotos = msg.mediaBuffers.length > 0;

  if (hasPhotos && !text) {
    return {
      type: "photo_evidence",
      otNumber,
      description: `${msg.mediaBuffers.length} foto(s) recibida(s)`,
      hasPhotos: true,
    };
  }

  if (COMPLETION_KEYWORDS.test(text)) {
    return {
      type: "completion_report",
      otNumber,
      status: "completed",
      description: msg.body,
      hasPhotos,
    };
  }

  if (PROBLEM_KEYWORDS.test(text)) {
    return {
      type: "problem_report",
      otNumber,
      status: "blocked",
      description: msg.body,
      hasPhotos,
    };
  }

  if (START_KEYWORDS.test(text)) {
    return {
      type: "status_update",
      otNumber,
      status: "started",
      description: msg.body,
      hasPhotos,
    };
  }

  if (PROGRESS_KEYWORDS.test(text)) {
    return {
      type: "status_update",
      otNumber,
      status: "in_progress",
      description: msg.body,
      hasPhotos,
    };
  }

  if (text.includes("?")) {
    return {
      type: "question",
      otNumber,
      description: msg.body,
      hasPhotos,
    };
  }

  return {
    type: "unknown",
    otNumber,
    description: msg.body,
    hasPhotos,
  };
}

export function generateReply(update: InterpretedUpdate): string {
  switch (update.type) {
    case "completion_report":
      return update.otNumber
        ? `✅ Recibido — reporte de finalización para OT #${update.otNumber}. ${update.hasPhotos ? "Fotos registradas. " : "Por favor envía fotos del antes/después. "}El arquitecto será notificado.`
        : "✅ Recibido tu reporte de finalización. ¿Puedes indicar el número de OT?";

    case "problem_report":
      return update.otNumber
        ? `⚠️ Recibido — problema reportado en OT #${update.otNumber}. El arquitecto será notificado inmediatamente. Describe la situación con el mayor detalle posible.`
        : "⚠️ Entendido, hay un problema. ¿Cuál es el número de OT? El arquitecto será notificado.";

    case "status_update":
      if (update.status === "started") {
        return update.otNumber
          ? `👍 Registrado — inicio de trabajo en OT #${update.otNumber}. Envía fotos del estado actual (antes).`
          : "👍 Registrado el inicio. ¿Cuál es el número de OT?";
      }
      return update.otNumber
        ? `📊 Actualización registrada para OT #${update.otNumber}. ${update.hasPhotos ? "Fotos guardadas." : ""}`
        : "📊 Actualización recibida. ¿Número de OT?";

    case "photo_evidence":
      return update.otNumber
        ? `📸 ${update.description} para OT #${update.otNumber}. Registradas correctamente.`
        : "📸 Fotos recibidas. ¿A qué OT corresponden?";

    case "question":
      return "📩 Tu pregunta fue recibida. Un arquitecto te responderá pronto.";

    default:
      return "👋 Mensaje recibido. Si necesitas reportar avance, indica el número de OT y el estado (inicio/avance/terminado/problema).";
  }
}
