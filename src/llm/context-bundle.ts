import { AppSheetClient, TABLES, ESTADOS, type OrdenTrabajo } from "../clients/appsheet.js";
import { ExecutionMonitor, type TrackerAlert } from "../tracker/monitor.js";

/**
 * Complete operational snapshot of Redin, ready to inject into the LLM prompt.
 * One AppSheet call + one alert scan, run in parallel. Cached 60s so rapid
 * conversation doesn't hammer AppSheet.
 */
export interface OpsBundle {
  generatedAt: Date;
  totals: {
    allActive: number;
    inExecution: number;
    pendingApproval: number;
    pendingQuotes: number;
    staleQuotes: number;
    interOTsActive: number;
  };
  critical: TrackerAlert[];
  high: TrackerAlert[];
  executionOTs: OrdenTrabajo[];
  staleQuotes: OrdenTrabajo[];
  pendingApproval: OrdenTrabajo[];
  interSLAActive: OrdenTrabajo[];
  byArchitect: Record<string, number>;
  focusOT?: OrdenTrabajo | null;
}

const CACHE_TTL_MS = 60_000;
let cache: { bundle: OpsBundle; at: number } | null = null;

const QUOTE_STATES = new Set<string>([ESTADOS.COTIZACION, ESTADOS.REPLANTEO]);
const EXEC_STATES = new Set<string>([ESTADOS.COORDINAR, ESTADOS.EJECUCION, ESTADOS.POR_APROBAR]);
const TERMINAL_STATES = new Set<string>([ESTADOS.FACTURADO, ESTADOS.PAGADO, ESTADOS.PERDIDA]);

export async function buildOpsBundle(
  appsheet: AppSheetClient,
  focusOTNumber?: string | null
): Promise<OpsBundle> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    const b = { ...cache.bundle };
    if (focusOTNumber) b.focusOT = cache.bundle.executionOTs.find((o) => o.Numero_Orden === focusOTNumber) ||
      (await appsheet.find<OrdenTrabajo>(TABLES.ORDENES)).find((o) => o.Numero_Orden === focusOTNumber) ||
      null;
    return b;
  }

  const monitor = new ExecutionMonitor(appsheet);
  const [allOTs, alerts] = await Promise.all([
    appsheet.find<OrdenTrabajo>(TABLES.ORDENES),
    monitor.scan(),
  ]);

  const active = allOTs.filter((o) => !TERMINAL_STATES.has(o.Estado));
  const executionOTs = active.filter((o) => EXEC_STATES.has(o.Estado));
  const pendingApproval = active.filter((o) => o.Estado === ESTADOS.POR_APROBAR);
  const pendingQuotes = active.filter((o) => QUOTE_STATES.has(o.Estado));

  const staleQuotes = pendingQuotes.filter((o) => {
    const d = o.TS_Cotizacion_Envio ? new Date(o.TS_Cotizacion_Envio) : null;
    if (!d || isNaN(d.getTime())) return false;
    return (Date.now() - d.getTime()) / 86400000 > 7;
  });

  const interSLAActive = active.filter((o) =>
    o.ID_Cliente.toLowerCase().includes("interrapidisimo")
  );

  const byArchitect: Record<string, number> = {};
  for (const ot of active) {
    const a = ot.Nombre_Arquitecto_Real || "(sin asignar)";
    byArchitect[a] = (byArchitect[a] || 0) + 1;
  }

  const critical = alerts.filter((a) => a.severity === "critical");
  const high = alerts.filter((a) => a.severity === "high");

  const bundle: OpsBundle = {
    generatedAt: new Date(),
    totals: {
      allActive: active.length,
      inExecution: executionOTs.length,
      pendingApproval: pendingApproval.length,
      pendingQuotes: pendingQuotes.length,
      staleQuotes: staleQuotes.length,
      interOTsActive: interSLAActive.length,
    },
    critical,
    high,
    executionOTs,
    staleQuotes,
    pendingApproval,
    interSLAActive,
    byArchitect,
    focusOT: focusOTNumber
      ? allOTs.find((o) => o.Numero_Orden === focusOTNumber) || null
      : null,
  };

  cache = { bundle, at: now };
  return bundle;
}

export function invalidateOpsCache(): void {
  cache = null;
}

/** Compact text version to inject into LLM prompt. Keep under ~2500 tokens. */
export function renderBundleForPrompt(bundle: OpsBundle): string {
  const parts: string[] = [];
  const t = bundle.totals;
  parts.push(`BRIEFING OPERATIVO REDIN — ${bundle.generatedAt.toLocaleString("es-CO")}`);
  parts.push(
    `Totales activos: ${t.allActive} OTs | Ejecución: ${t.inExecution} | Por aprobar: ${t.pendingApproval} | Cotizaciones pendientes: ${t.pendingQuotes} (${t.staleQuotes} sin respuesta >7 días) | Inter Rapidísimo: ${t.interOTsActive}`
  );

  parts.push(`\nCarga por arquitecto:`);
  const sorted = Object.entries(bundle.byArchitect).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted.slice(0, 8)) {
    parts.push(`  - ${name}: ${count} OTs activas`);
  }

  if (bundle.critical.length > 0) {
    parts.push(`\n🔴 ALERTAS CRÍTICAS (${bundle.critical.length}) — acción inmediata:`);
    for (const a of bundle.critical.slice(0, 8)) {
      parts.push(`  • OT #${a.ot.Numero_Orden} ${a.ot.Ciudad} — ${a.message} (Arq: ${a.ot.Nombre_Arquitecto_Real || "—"})`);
      parts.push(`    → ${a.actionRequired}`);
    }
    if (bundle.critical.length > 8) parts.push(`  ... y ${bundle.critical.length - 8} más.`);
  }

  if (bundle.high.length > 0) {
    parts.push(`\n🟠 ALERTAS ALTAS (${bundle.high.length}):`);
    for (const a of bundle.high.slice(0, 6)) {
      parts.push(`  • OT #${a.ot.Numero_Orden} ${a.ot.Ciudad} — ${a.message}`);
    }
    if (bundle.high.length > 6) parts.push(`  ... y ${bundle.high.length - 6} más.`);
  }

  if (bundle.interSLAActive.length > 0) {
    parts.push(`\n🚨 INTER RAPIDÍSIMO activas (${bundle.interSLAActive.length}) — SLAs con multa:`);
    for (const ot of bundle.interSLAActive.slice(0, 10)) {
      parts.push(
        `  • #${ot.Numero_Orden} ${ot.Ciudad.padEnd(16)} ${ot.Estado.padEnd(24)} Resp:${ot.Alerta_Respuesta || "—"} Sol:${ot.Alerta_Solucion || "—"} (${ot.Nombre_Arquitecto_Real || "—"})`
      );
    }
  }

  if (bundle.pendingApproval.length > 0) {
    parts.push(`\n📋 Por aprobar por cliente (${bundle.pendingApproval.length}):`);
    for (const ot of bundle.pendingApproval.slice(0, 5)) {
      const d = ot.TS_PorAprobar ? new Date(ot.TS_PorAprobar) : null;
      const days = d && !isNaN(d.getTime()) ? Math.floor((Date.now() - d.getTime()) / 86400000) : "?";
      parts.push(`  • #${ot.Numero_Orden} ${ot.Ciudad} — ${days}d esperando (${ot.Nombre_Arquitecto_Real || "—"})`);
    }
  }

  if (bundle.staleQuotes.length > 0) {
    parts.push(`\n💬 Cotizaciones sin respuesta >7d (${bundle.staleQuotes.length}):`);
    for (const ot of bundle.staleQuotes.slice(0, 6)) {
      const d = ot.TS_Cotizacion_Envio ? new Date(ot.TS_Cotizacion_Envio) : null;
      const days = d && !isNaN(d.getTime()) ? Math.floor((Date.now() - d.getTime()) / 86400000) : "?";
      parts.push(`  • #${ot.Numero_Orden} ${ot.Ciudad} — ${days}d sin respuesta ($${Math.round(parseFloat(ot.Valor_Estimado || "0") / 1000)}k) (${ot.Nombre_Arquitecto_Real || "—"})`);
    }
  }

  if (bundle.focusOT) {
    const o = bundle.focusOT;
    parts.push(`\n🔎 OT EN FOCO (#${o.Numero_Orden}):`);
    parts.push(`  Cliente: ${o.ID_Cliente} | Ciudad: ${o.Ciudad} | Estado: ${o.Estado}`);
    parts.push(`  Arquitecto: ${o.Nombre_Arquitecto_Real || "—"}`);
    parts.push(`  Valor estimado: $${parseInt(o.Valor_Estimado || "0").toLocaleString()} COP`);
    if (o.Descripcion) parts.push(`  Descripción: ${o.Descripcion.substring(0, 180)}`);
    if (o.Fecha_Limite_Solucion) parts.push(`  Deadline solución: ${o.Fecha_Limite_Solucion}`);
    if (o.Alerta_Respuesta) parts.push(`  SLA Respuesta: ${o.Alerta_Respuesta}`);
    if (o.Alerta_Solucion) parts.push(`  SLA Solución: ${o.Alerta_Solucion}`);
    if (o.Rentabilidad_Actual) parts.push(`  Rentabilidad actual: $${parseInt(o.Rentabilidad_Actual).toLocaleString()}`);
  }

  return parts.join("\n");
}
