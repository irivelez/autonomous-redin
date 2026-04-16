import { AppSheetClient, TABLES, ESTADOS, type OrdenTrabajo } from "../clients/appsheet.js";
import { ExecutionMonitor, type TrackerAlert } from "../tracker/monitor.js";

/**
 * Complete operational snapshot of Redin. The LLM gets the FULL OT table
 * (all states, including terminal/billed/paid) plus computed alerts. Lets
 * the agent answer any question about any OT without us pre-curating data.
 */
export interface OpsBundle {
  generatedAt: Date;
  totals: {
    total: number;
    active: number;
    inExecution: number;
    pendingApproval: number;
    pendingQuotes: number;
    facturado: number;
    pagado: number;
    cancelado: number;
    interOTsActive: number;
  };
  byArchitect: Record<string, number>;
  byClient: Record<string, number>;
  byState: Record<string, number>;
  critical: TrackerAlert[];
  high: TrackerAlert[];
  allOTs: OrdenTrabajo[];
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
    if (focusOTNumber) b.focusOT = cache.bundle.allOTs.find((o) => o.Numero_Orden === focusOTNumber) || null;
    return b;
  }

  const monitor = new ExecutionMonitor(appsheet);
  const [allOTs, alerts] = await Promise.all([
    appsheet.find<OrdenTrabajo>(TABLES.ORDENES),
    monitor.scan(),
  ]);

  const active = allOTs.filter((o) => !TERMINAL_STATES.has(o.Estado));
  const totals = {
    total: allOTs.length,
    active: active.length,
    inExecution: active.filter((o) => EXEC_STATES.has(o.Estado)).length,
    pendingApproval: active.filter((o) => o.Estado === ESTADOS.POR_APROBAR).length,
    pendingQuotes: active.filter((o) => QUOTE_STATES.has(o.Estado)).length,
    facturado: allOTs.filter((o) => o.Estado === ESTADOS.FACTURADO).length,
    pagado: allOTs.filter((o) => o.Estado === ESTADOS.PAGADO).length,
    cancelado: allOTs.filter((o) => o.Estado === ESTADOS.PERDIDA).length,
    interOTsActive: active.filter((o) => o.ID_Cliente.toLowerCase().includes("interrapidisimo")).length,
  };

  const byArchitect: Record<string, number> = {};
  const byClient: Record<string, number> = {};
  const byState: Record<string, number> = {};
  for (const ot of allOTs) {
    const arq = ot.Nombre_Arquitecto_Real || "(sin asignar)";
    byArchitect[arq] = (byArchitect[arq] || 0) + 1;
    const cli = ot.ID_Cliente || "(sin cliente)";
    byClient[cli] = (byClient[cli] || 0) + 1;
    byState[ot.Estado] = (byState[ot.Estado] || 0) + 1;
  }

  const critical = alerts.filter((a) => a.severity === "critical");
  const high = alerts.filter((a) => a.severity === "high");

  const bundle: OpsBundle = {
    generatedAt: new Date(),
    totals,
    byArchitect,
    byClient,
    byState,
    critical,
    high,
    allOTs,
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

/** YYYY-MM-DD or empty string for invalid/missing dates. */
function isoDate(s: string): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Compact pipe-delimited dump of a single OT. Stable column order so the
 * LLM can rely on positional parsing if it wants. Header is documented in
 * the system prompt.
 */
function rowOf(ot: OrdenTrabajo): string {
  const v = Math.round((parseFloat(ot.Valor_Estimado || "0") || 0));
  const r = Math.round((parseFloat(ot.Rentabilidad_Actual || "0") || 0));
  const fact = Math.round((parseFloat(ot.Valor_Facturado_Real || "0") || 0));
  const cat = ot.Categoria || "";
  const sla = ot.Alerta_Respuesta || ot.Alerta_Solucion
    ? `R:${ot.Alerta_Respuesta || "—"}/S:${ot.Alerta_Solucion || "—"}`
    : "";
  return [
    `#${ot.Numero_Orden}`,
    ot.Estado,
    ot.ID_Cliente,
    ot.Ciudad,
    ot.Nombre_Arquitecto_Real || "—",
    `$${v}`,
    isoDate(ot.Fecha_Creacion),
    isoDate(ot.Fecha_Facturacion),
    isoDate(ot.Fecha_Pago_Real),
    `$${fact}`,
    `$${r}`,
    cat,
    sla,
  ].join("|");
}

export function renderBundleForPrompt(bundle: OpsBundle): string {
  const parts: string[] = [];
  const today = bundle.generatedAt.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const t = bundle.totals;

  parts.push(`=== BRIEFING OPERATIVO REDIN ===`);
  parts.push(`Fecha actual: ${today} (este mes = ${month})`);
  parts.push(`Generado: ${bundle.generatedAt.toLocaleString("es-CO", { timeZone: "America/Bogota" })}`);
  parts.push(``);
  parts.push(
    `TOTALES: ${t.total} OTs en histórico | Activas: ${t.active} | En ejecución: ${t.inExecution} | Por aprobar: ${t.pendingApproval} | Cotizaciones pendientes: ${t.pendingQuotes} | Facturado: ${t.facturado} | Pagado: ${t.pagado} | Cancelado: ${t.cancelado} | Inter Rapidísimo activas: ${t.interOTsActive}`
  );

  parts.push(`\nPor arquitecto (incluye históricas):`);
  for (const [name, count] of Object.entries(bundle.byArchitect).sort((a, b) => b[1] - a[1])) {
    parts.push(`  ${name}: ${count}`);
  }

  parts.push(`\nPor cliente (incluye históricas):`);
  for (const [name, count] of Object.entries(bundle.byClient).sort((a, b) => b[1] - a[1])) {
    parts.push(`  ${name}: ${count}`);
  }

  parts.push(`\nPor estado:`);
  for (const [s, c] of Object.entries(bundle.byState).sort((a, b) => b[1] - a[1])) {
    parts.push(`  ${s}: ${c}`);
  }

  if (bundle.critical.length > 0) {
    parts.push(`\n🔴 ALERTAS CRÍTICAS COMPUTADAS (${bundle.critical.length}) — surfacealas si son relevantes:`);
    for (const a of bundle.critical.slice(0, 12)) {
      parts.push(`  • OT #${a.ot.Numero_Orden} ${a.ot.Ciudad} — ${a.message}`);
    }
    if (bundle.critical.length > 12) parts.push(`  ... y ${bundle.critical.length - 12} más en la tabla.`);
  }

  if (bundle.high.length > 0) {
    parts.push(`\n🟠 ALERTAS ALTAS (${bundle.high.length}):`);
    for (const a of bundle.high.slice(0, 6)) {
      parts.push(`  • OT #${a.ot.Numero_Orden} ${a.ot.Ciudad} — ${a.message}`);
    }
  }

  if (bundle.focusOT) {
    const o = bundle.focusOT;
    parts.push(`\n🔎 OT EN FOCO (#${o.Numero_Orden}) — datos completos:`);
    parts.push(`  Cliente: ${o.ID_Cliente} | Ciudad: ${o.Ciudad} | Estado: ${o.Estado}`);
    parts.push(`  Arquitecto: ${o.Nombre_Arquitecto_Real || "—"} | Categoría: ${o.Categoria || "—"} / ${o.Subcategoria || "—"}`);
    parts.push(`  Valor estimado: $${parseInt(o.Valor_Estimado || "0").toLocaleString()} | Facturado: $${parseInt(o.Valor_Facturado_Real || "0").toLocaleString()} | Rentabilidad: $${parseInt(o.Rentabilidad_Actual || "0").toLocaleString()}`);
    parts.push(`  Fechas — creación:${isoDate(o.Fecha_Creacion)} | aprobación:${isoDate(o.TS_Aprobacion)} | terminado:${isoDate(o.TS_Terminado)} | facturación:${isoDate(o.Fecha_Facturacion)} | pago:${isoDate(o.Fecha_Pago_Real)}`);
    if (o.Descripcion) parts.push(`  Descripción: ${o.Descripcion.substring(0, 300)}`);
    if (o.Direccion_Sede) parts.push(`  Dirección: ${o.Direccion_Sede.substring(0, 200)}`);
    if (o.Fecha_Limite_Respuesta) parts.push(`  SLA Respuesta deadline: ${o.Fecha_Limite_Respuesta} (alerta: ${o.Alerta_Respuesta || "—"})`);
    if (o.Fecha_Limite_Solucion) parts.push(`  SLA Solución deadline: ${o.Fecha_Limite_Solucion} (alerta: ${o.Alerta_Solucion || "—"})`);
  }

  // === FULL DATA TABLE ===
  // Header documents the column order so the LLM can read every row reliably.
  parts.push(`\n=== TABLA COMPLETA DE OTs (n=${bundle.allOTs.length}) ===`);
  parts.push(`Columnas (pipe-delimited): num | estado | cliente | ciudad | arquitecto | valor_estimado_cop | fecha_creacion | fecha_facturacion | fecha_pago | valor_facturado_cop | rentabilidad_cop | categoria | sla`);
  parts.push(`Notas:`);
  parts.push(`  - Fechas en formato ISO YYYY-MM-DD; vacío = aún no ocurrió.`);
  parts.push(`  - Valores en COP (pesos colombianos), no en miles.`);
  parts.push(`  - sla solo aplica a Inter Rapidísimo. R=Respuesta, S=Solución. ❌=vencido, ⚠️=cerca de vencer, ✅=ok.`);
  parts.push(`  - Para "este mes facturadas" filtra fecha_facturacion que empiece con ${month}.`);
  parts.push(``);
  // Sort by state then by number desc — newest active first, terminal last
  const stateOrder: Record<string, number> = {
    [ESTADOS.SOLICITUD]: 1, [ESTADOS.VISITA]: 2, [ESTADOS.COTIZACION]: 3, [ESTADOS.REPLANTEO]: 4,
    [ESTADOS.COORDINAR]: 5, [ESTADOS.EJECUCION]: 6, [ESTADOS.POR_APROBAR]: 7,
    [ESTADOS.TERMINADO]: 8, [ESTADOS.FACTURADO]: 9, [ESTADOS.PAGADO]: 10, [ESTADOS.PERDIDA]: 11,
  };
  const sorted = [...bundle.allOTs].sort((a, b) => {
    const sa = stateOrder[a.Estado] ?? 99;
    const sb = stateOrder[b.Estado] ?? 99;
    if (sa !== sb) return sa - sb;
    return parseInt(b.Numero_Orden || "0") - parseInt(a.Numero_Orden || "0");
  });
  for (const ot of sorted) parts.push(rowOf(ot));

  return parts.join("\n");
}
