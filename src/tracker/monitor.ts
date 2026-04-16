import { AppSheetClient, TABLES, ESTADOS, type OrdenTrabajo } from "../clients/appsheet.js";

export interface TrackerAlert {
  type: "sla_breach" | "sla_warning" | "stale_execution" | "quote_no_followup" | "profitability_risk" | "pending_approval";
  severity: "critical" | "high" | "medium" | "low";
  ot: OrdenTrabajo;
  message: string;
  actionRequired: string;
}

const EXECUTION_STATES: ReadonlySet<string> = new Set([
  ESTADOS.COORDINAR,
  ESTADOS.EJECUCION,
  ESTADOS.POR_APROBAR,
]);

const QUOTE_STATES: ReadonlySet<string> = new Set([
  ESTADOS.COTIZACION,
  ESTADOS.REPLANTEO,
]);

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

function isInterrapidisimo(ot: OrdenTrabajo): boolean {
  return ot.ID_Cliente.toLowerCase().includes("interrapidisimo");
}

export class ExecutionMonitor {
  constructor(private client: AppSheetClient) {}

  async getActiveOTs(): Promise<OrdenTrabajo[]> {
    const all = await this.client.find<OrdenTrabajo>(TABLES.ORDENES);
    return all.filter(
      (ot) => !["Facturado", "Pagado", "99. Perdida / Cancelada"].includes(ot.Estado)
    );
  }

  async getExecutionOTs(): Promise<OrdenTrabajo[]> {
    const all = await this.client.find<OrdenTrabajo>(TABLES.ORDENES);
    return all.filter((ot) => EXECUTION_STATES.has(ot.Estado));
  }

  async getQuotePendingOTs(): Promise<OrdenTrabajo[]> {
    const all = await this.client.find<OrdenTrabajo>(TABLES.ORDENES);
    return all.filter((ot) => QUOTE_STATES.has(ot.Estado));
  }

  async scan(): Promise<TrackerAlert[]> {
    const allOTs = await this.client.find<OrdenTrabajo>(TABLES.ORDENES);
    const now = new Date();
    const alerts: TrackerAlert[] = [];

    for (const ot of allOTs) {
      // Skip terminal states
      if (["Facturado", "Pagado", "99. Perdida / Cancelada"].includes(ot.Estado)) continue;

      // SLA checks for Inter Rapidísimo
      if (isInterrapidisimo(ot)) {
        const respDeadline = parseDate(ot.Fecha_Limite_Respuesta);
        const solDeadline = parseDate(ot.Fecha_Limite_Solucion);

        if (ot.Alerta_Respuesta?.includes("❌")) {
          alerts.push({
            type: "sla_breach",
            severity: "critical",
            ot,
            message: `⚠️ SLA RESPUESTA VENCIDO — OT #${ot.Numero_Orden} en ${ot.Ciudad}`,
            actionRequired: "Contactar arquitecto inmediatamente. Cada hora de retraso = multa % del contrato mensual.",
          });
        } else if (respDeadline && hoursBetween(now, respDeadline) <= 1 && hoursBetween(now, respDeadline) > 0) {
          alerts.push({
            type: "sla_warning",
            severity: "high",
            ot,
            message: `⏰ SLA RESPUESTA < 1 hora — OT #${ot.Numero_Orden} en ${ot.Ciudad}`,
            actionRequired: "Responder al cliente antes de que venza el SLA.",
          });
        }

        if (ot.Alerta_Solucion?.includes("❌")) {
          alerts.push({
            type: "sla_breach",
            severity: "critical",
            ot,
            message: `⚠️ SLA SOLUCIÓN VENCIDO — OT #${ot.Numero_Orden} en ${ot.Ciudad}`,
            actionRequired: "Escalar a Director de Operaciones. Multa activa.",
          });
        } else if (solDeadline && hoursBetween(now, solDeadline) <= 2 && hoursBetween(now, solDeadline) > 0) {
          alerts.push({
            type: "sla_warning",
            severity: "high",
            ot,
            message: `⏰ SLA SOLUCIÓN < 2 horas — OT #${ot.Numero_Orden} en ${ot.Ciudad}`,
            actionRequired: "Verificar avance con el contratista en sitio.",
          });
        }
      }

      // Stale execution: OTs in "En ejecución" for too long
      if (ot.Estado === ESTADOS.EJECUCION) {
        const approvalDate = parseDate(ot.TS_Aprobacion);
        if (approvalDate && daysBetween(approvalDate, now) > 15) {
          alerts.push({
            type: "stale_execution",
            severity: "medium",
            ot,
            message: `🐢 OT #${ot.Numero_Orden} lleva ${daysBetween(approvalDate, now)} días en ejecución — ${ot.Ciudad}`,
            actionRequired: `Verificar avance con ${ot.Nombre_Arquitecto_Real}. ¿Está trabada?`,
          });
        }
      }

      // Pending approval: closeout sitting too long
      if (ot.Estado === ESTADOS.POR_APROBAR) {
        const porAprobarDate = parseDate(ot.TS_PorAprobar);
        if (porAprobarDate && daysBetween(porAprobarDate, now) > 5) {
          alerts.push({
            type: "pending_approval",
            severity: "medium",
            ot,
            message: `📋 OT #${ot.Numero_Orden} esperando aprobación hace ${daysBetween(porAprobarDate, now)} días — ${ot.Ciudad}`,
            actionRequired: "Enviar recordatorio al cliente para que apruebe el cierre.",
          });
        }
      }

      // Quote follow-up: quotes sent but no response
      if (QUOTE_STATES.has(ot.Estado)) {
        const quoteDate = parseDate(ot.TS_Cotizacion_Envio);
        if (quoteDate && daysBetween(quoteDate, now) > 7) {
          alerts.push({
            type: "quote_no_followup",
            severity: "low",
            ot,
            message: `💬 Cotización OT #${ot.Numero_Orden} sin respuesta hace ${daysBetween(quoteDate, now)} días — ${ot.Ciudad}`,
            actionRequired: `${ot.Nombre_Arquitecto_Real} debe hacer seguimiento con el cliente.`,
          });
        }
      }

      // Profitability risk: negative or low margin
      const rentabilidad = parseFloat(ot.Rentabilidad_Actual) || 0;
      const valorEstimado = parseFloat(ot.Valor_Estimado) || 1;
      const margenPct = (rentabilidad / valorEstimado) * 100;
      if (ot.Estado === ESTADOS.EJECUCION && margenPct < 30 && valorEstimado > 0) {
        alerts.push({
          type: "profitability_risk",
          severity: "medium",
          ot,
          message: `📉 OT #${ot.Numero_Orden} margen bajo: ${margenPct.toFixed(0)}% (objetivo: 45%) — ${ot.Ciudad}`,
          actionRequired: "Revisar costos de ejecución. Posible sobrecosto de materiales o mano de obra.",
        });
      }
    }

    return alerts.sort((a, b) => {
      const sev = { critical: 0, high: 1, medium: 2, low: 3 };
      return sev[a.severity] - sev[b.severity];
    });
  }
}

export function formatDashboard(ots: OrdenTrabajo[]): string {
  const byStatus: Record<string, OrdenTrabajo[]> = {};
  for (const ot of ots) {
    (byStatus[ot.Estado] ??= []).push(ot);
  }

  const byArch: Record<string, number> = {};
  for (const ot of ots) {
    const arch = ot.Nombre_Arquitecto_Real || "(sin asignar)";
    byArch[arch] = (byArch[arch] || 0) + 1;
  }

  let out = "═══════════════════════════════════════\n";
  out += "       REDIN — EXECUTION TRACKER       \n";
  out += `       ${new Date().toLocaleString("es-CO")}  \n`;
  out += "═══════════════════════════════════════\n\n";

  out += "📊 PIPELINE ACTIVO\n";
  out += "───────────────────────────────────────\n";
  const order = [
    ESTADOS.SOLICITUD, ESTADOS.VISITA, ESTADOS.COTIZACION,
    ESTADOS.REPLANTEO, ESTADOS.COORDINAR, ESTADOS.EJECUCION,
    ESTADOS.POR_APROBAR, ESTADOS.TERMINADO,
  ];
  for (const estado of order) {
    const count = (byStatus[estado] || []).length;
    if (count > 0) {
      const bar = "█".repeat(Math.min(count, 30));
      out += `  ${estado.padEnd(38)} ${String(count).padStart(3)} ${bar}\n`;
    }
  }

  out += "\n👷 CARGA POR ARQUITECTO\n";
  out += "───────────────────────────────────────\n";
  for (const [arch, count] of Object.entries(byArch).sort((a, b) => b[1] - a[1])) {
    out += `  ${arch.padEnd(25)} ${String(count).padStart(3)} OTs activas\n`;
  }

  const interOTs = ots.filter(isInterrapidisimo);
  if (interOTs.length > 0) {
    out += "\n🚨 INTER RAPIDÍSIMO (SLA)\n";
    out += "───────────────────────────────────────\n";
    for (const ot of interOTs) {
      const resp = ot.Alerta_Respuesta || "—";
      const sol = ot.Alerta_Solucion || "—";
      out += `  #${ot.Numero_Orden.padEnd(4)} ${ot.Ciudad.padEnd(18)} ${ot.Estado.padEnd(20)} ${resp} | ${sol}\n`;
    }
  }

  return out;
}

export function formatAlerts(alerts: TrackerAlert[]): string {
  if (alerts.length === 0) return "✅ Sin alertas activas.\n";

  let out = `\n🔔 ${alerts.length} ALERTAS\n`;
  out += "═══════════════════════════════════════\n";

  for (const a of alerts) {
    const icon = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" }[a.severity];
    out += `\n${icon} [${a.severity.toUpperCase()}] ${a.message}\n`;
    out += `   → ${a.actionRequired}\n`;
  }

  return out;
}
