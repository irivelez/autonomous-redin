import {
  AppSheetClient,
  TABLES,
  ESTADOS,
  type OrdenTrabajo,
  type DetalleActividad,
  type CostoEjecucion,
  type Tecnico,
} from "../clients/appsheet.js";
import { ExecutionMonitor, type TrackerAlert } from "../tracker/monitor.js";
import { appsheetDateToISO, monthInBogota, todayInBogota } from "./date-utils.js";

/**
 * Complete operational snapshot of Redin. The LLM gets the FULL OT table
 * (all states, including terminal/billed/paid) plus computed alerts. Lets
 * the agent answer any question about any OT without us pre-curating data.
 */
export interface FinancialAggregate {
  count: number;
  sumFacturadoReal: number;
  sumEstimado: number;
  sumRentabilidad: number;
  otNumbers: string[];
}

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
  aggregates: {
    facturadoHoy: FinancialAggregate;
    facturadoEsteMes: FinancialAggregate;
    pagadoHoy: FinancialAggregate;
    pagadoEsteMes: FinancialAggregate;
  };
  byArchitect: Record<string, number>;
  byClient: Record<string, number>;
  byState: Record<string, number>;
  critical: TrackerAlert[];
  high: TrackerAlert[];
  allOTs: OrdenTrabajo[];
  allActividades: DetalleActividad[];
  allCostos: CostoEjecucion[];
  allTecnicos: Tecnico[];
  /** Map OT Row-ID (UUID) → Numero_Orden ("306"). Used to cross-join child tables back to OT numbers the user recognizes. */
  otNumByRowId: Record<string, string>;
  focusOT?: OrdenTrabajo | null;
}

const CACHE_TTL_MS = 60_000;
let cache: { bundle: OpsBundle; at: number } | null = null;
// Single-flight: if 20 users miss the cache at once, they share one AppSheet fetch.
let inflight: Promise<OpsBundle> | null = null;

const QUOTE_STATES = new Set<string>([ESTADOS.COTIZACION, ESTADOS.REPLANTEO]);
const EXEC_STATES = new Set<string>([ESTADOS.COORDINAR, ESTADOS.EJECUCION, ESTADOS.POR_APROBAR]);
const TERMINAL_STATES = new Set<string>([ESTADOS.FACTURADO, ESTADOS.PAGADO, ESTADOS.PERDIDA]);

function withFocus(bundle: OpsBundle, focusOTNumber?: string | null): OpsBundle {
  const b = { ...bundle };
  b.focusOT = focusOTNumber
    ? bundle.allOTs.find((o) => o.Numero_Orden === focusOTNumber) || null
    : null;
  return b;
}

export async function buildOpsBundle(
  appsheet: AppSheetClient,
  focusOTNumber?: string | null
): Promise<OpsBundle> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return withFocus(cache.bundle, focusOTNumber);
  if (inflight) return withFocus(await inflight, focusOTNumber);

  inflight = fetchBundle(appsheet);
  try {
    const bundle = await inflight;
    return withFocus(bundle, focusOTNumber);
  } finally {
    inflight = null;
  }
}

async function fetchBundle(appsheet: AppSheetClient): Promise<OpsBundle> {
  const monitor = new ExecutionMonitor(appsheet);
  const [allOTs, allActividades, allCostos, allTecnicos, alerts] = await Promise.all([
    appsheet.find<OrdenTrabajo>(TABLES.ORDENES),
    appsheet.find<DetalleActividad>(TABLES.ACTIVIDADES).catch((e) => {
      console.error("[Bundle] Actividades fetch failed:", (e as Error).message);
      return [] as DetalleActividad[];
    }),
    appsheet.find<CostoEjecucion>(TABLES.COSTOS).catch((e) => {
      console.error("[Bundle] Costos fetch failed:", (e as Error).message);
      return [] as CostoEjecucion[];
    }),
    appsheet.find<Tecnico>(TABLES.TECNICOS).catch((e) => {
      console.error("[Bundle] Tecnicos fetch failed:", (e as Error).message);
      return [] as Tecnico[];
    }),
    monitor.scan(),
  ]);

  const otNumByRowId: Record<string, string> = {};
  for (const ot of allOTs) otNumByRowId[ot["Row ID"]] = ot.Numero_Orden;

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

  const today = todayInBogota();
  const month = monthInBogota();
  const aggregates = {
    facturadoHoy: aggregate(allOTs, (o) => {
      const d = appsheetDateToISO(o.Fecha_Facturacion);
      return (o.Estado === ESTADOS.FACTURADO || o.Estado === ESTADOS.PAGADO) && d === today;
    }),
    facturadoEsteMes: aggregate(allOTs, (o) => {
      const d = appsheetDateToISO(o.Fecha_Facturacion);
      return (o.Estado === ESTADOS.FACTURADO || o.Estado === ESTADOS.PAGADO) && d.startsWith(month);
    }),
    pagadoHoy: aggregate(allOTs, (o) => {
      const d = appsheetDateToISO(o.Fecha_Pago_Real);
      return o.Estado === ESTADOS.PAGADO && d === today;
    }),
    pagadoEsteMes: aggregate(allOTs, (o) => {
      const d = appsheetDateToISO(o.Fecha_Pago_Real);
      return o.Estado === ESTADOS.PAGADO && d.startsWith(month);
    }),
  };

  const bundle: OpsBundle = {
    generatedAt: new Date(),
    totals,
    aggregates,
    byArchitect,
    byClient,
    byState,
    critical,
    high,
    allOTs,
    allActividades,
    allCostos,
    allTecnicos,
    otNumByRowId,
    focusOT: null,
  };

  cache = { bundle, at: Date.now() };
  return bundle;
}

export function invalidateOpsCache(): void {
  cache = null;
}

// Timezone-safe AppSheet date parsing (see llm/date-utils.ts).
const isoDate = appsheetDateToISO;

function aggregate(rows: OrdenTrabajo[], pred: (o: OrdenTrabajo) => boolean): FinancialAggregate {
  let sumFact = 0;
  let sumEst = 0;
  let sumRent = 0;
  const nums: string[] = [];
  for (const o of rows) {
    if (!pred(o)) continue;
    sumFact += parseFloat(o.Valor_Facturado_Real || "0") || 0;
    sumEst += parseFloat(o.Valor_Estimado || "0") || 0;
    sumRent += parseFloat(o.Rentabilidad_Actual || "0") || 0;
    nums.push(o.Numero_Orden);
  }
  return {
    count: nums.length,
    sumFacturadoReal: Math.round(sumFact),
    sumEstimado: Math.round(sumEst),
    sumRentabilidad: Math.round(sumRent),
    otNumbers: nums,
  };
}

function fmtCOP(n: number): string {
  return `$${n.toLocaleString("es-CO")}`;
}

function renderAggregate(label: string, a: FinancialAggregate): string {
  if (a.count === 0) return `${label}: 0 OTs.`;
  const list = a.otNumbers.slice(0, 30).map((n) => `#${n}`).join(", ");
  const more = a.otNumbers.length > 30 ? ` … y ${a.otNumbers.length - 30} más` : "";
  return (
    `${label}: ${a.count} OTs | ` +
    `valor_facturado_real total = ${fmtCOP(a.sumFacturadoReal)} | ` +
    `valor_estimado total = ${fmtCOP(a.sumEstimado)} | ` +
    `rentabilidad total = ${fmtCOP(a.sumRentabilidad)} | ` +
    `OTs: ${list}${more}`
  );
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
  // Dates are computed in Colombia timezone. All OT dates in the table below
  // are also Colombia local time. So "today" / "este mes" filters compare
  // like-with-like — no TZ drift.
  const today = todayInBogota(bundle.generatedAt);
  const month = monthInBogota(bundle.generatedAt);
  const t = bundle.totals;

  parts.push(`=== BRIEFING OPERATIVO REDIN ===`);
  parts.push(`Fecha actual (Colombia / COT): ${today} (este mes = ${month})`);
  parts.push(`Generado: ${bundle.generatedAt.toLocaleString("es-CO", { timeZone: "America/Bogota" })}`);
  parts.push(``);
  parts.push(
    `TOTALES: ${t.total} OTs en histórico | Activas: ${t.active} | En ejecución: ${t.inExecution} | Por aprobar: ${t.pendingApproval} | Cotizaciones pendientes: ${t.pendingQuotes} | Facturado: ${t.facturado} | Pagado: ${t.pagado} | Cancelado: ${t.cancelado} | Inter Rapidísimo activas: ${t.interOTsActive}`
  );

  // Pre-computed financial aggregates — use these sums DIRECTLY. Do NOT re-add
  // row values yourself; LLM arithmetic across many numbers drifts.
  parts.push(`\n=== AGREGADOS FINANCIEROS (calculados en backend, usar tal cual) ===`);
  parts.push(renderAggregate(`Facturado HOY (${today})`, bundle.aggregates.facturadoHoy));
  parts.push(renderAggregate(`Facturado ESTE MES (${month})`, bundle.aggregates.facturadoEsteMes));
  parts.push(renderAggregate(`Pagado HOY (${today})`, bundle.aggregates.pagadoHoy));
  parts.push(renderAggregate(`Pagado ESTE MES (${month})`, bundle.aggregates.pagadoEsteMes));

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
  parts.push(`  - Fechas en formato ISO YYYY-MM-DD en zona horaria de Colombia; vacío = aún no ocurrió.`);
  parts.push(`  - Valores en COP (pesos colombianos), no en miles. "valor_facturado_cop" = Valor_Facturado_Real (lo que realmente se le cobró al cliente, no la estimación).`);
  parts.push(`  - sla solo aplica a Inter Rapidísimo. R=Respuesta, S=Solución. ❌=vencido, ⚠️=cerca de vencer, ✅=ok.`);
  parts.push(`  - "facturadas este mes" → filtra estado in [Facturado, Pagado] AND fecha_facturacion empieza con ${month}. Suma valor_facturado_cop.`);
  parts.push(`  - "facturadas hoy" → filtra estado in [Facturado, Pagado] AND fecha_facturacion == ${today}. Suma valor_facturado_cop.`);
  parts.push(`  - OJO: algunos rows de estado "Solicitud" traen fecha_facturacion no-vacía por artefactos de AppSheet. SIEMPRE filtra por estado también.`);
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

  renderActividades(parts, bundle);
  renderCostos(parts, bundle);
  renderTecnicos(parts, bundle);

  return parts.join("\n");
}

// ─── Related tables ──────────────────────────────────────────────────────────

function num(s: string | undefined): number {
  return parseFloat(s || "0") || 0;
}

function renderActividades(parts: string[], bundle: OpsBundle): void {
  parts.push(`\n=== TABLA DETALLE DE ACTIVIDADES (n=${bundle.allActividades.length}) ===`);
  parts.push(
    `Cada fila es una actividad/visita dentro de una OT — describe el trabajo concreto, el técnico asignado, el costo y el gasto aprobado.`
  );
  parts.push(
    `Columnas (pipe-delimited): ot_num | id_detalle | actividad | categoria | subcategoria | tecnico | costo_cop | gasto_aprobado_cop | saldo_pendiente_cop | fecha_visita`
  );
  parts.push(`Notas:`);
  parts.push(`  - "ot_num" es el #OT (usa esto para cruzar con la tabla OT arriba). Si "?" es que la actividad apunta a un ID_Orden que no existe en Ordenes_Trabajo.`);
  parts.push(`  - "saldo_pendiente_cop" = gasto_aprobado - costo cobrado. >0 implica pago pendiente al técnico.`);
  parts.push(``);
  for (const a of bundle.allActividades) {
    const otNum = bundle.otNumByRowId[a.ID_Orden] ?? "?";
    parts.push(
      [
        `#${otNum}`,
        a.ID_Detalle || "—",
        (a.Actividad_Descripcion || "").substring(0, 80),
        a.Categoria || "",
        a.Subcategoria || "",
        a.Tecnico || "—",
        `$${Math.round(num(a.Costo))}`,
        `$${Math.round(num(a.Gasto_Aprobado))}`,
        `$${Math.round(num(a.Saldo_Pendiente_Item))}`,
        appsheetDateToISO(a.Fecha_Hora_Visita),
      ].join("|")
    );
  }
}

function renderCostos(parts: string[], bundle: OpsBundle): void {
  parts.push(`\n=== TABLA COSTOS DE EJECUCIÓN (n=${bundle.allCostos.length}) ===`);
  parts.push(
    `Cada fila es un gasto/anticipo registrado contra una OT. Incluye anticipos dados a técnicos y materiales comprados. "Nombre_Visual_Anticipo" describe el anticipo en texto plano.`
  );
  parts.push(
    `Columnas (pipe-delimited): ot_num | id_detalle | fecha_gasto | categoria | valor_cop | estado | anticipo_descripcion`
  );
  parts.push(`Notas:`);
  parts.push(`  - "estado" = APROBADO | PENDIENTE | RECHAZADO (así viene de AppSheet).`);
  parts.push(`  - "anticipo_descripcion" suele contener "Anticipo # - <categoría> - <técnico> - <n>-<estado OT>-<cliente>". Útil para preguntas sobre anticipos por OT/técnico/cliente.`);
  parts.push(`  - Para "OTs con anticipo no facturado": filtra filas con estado=APROBADO, agrupa por ot_num, cruza con la tabla OT y excluye las que estén en estado Facturado o Pagado.`);
  parts.push(``);
  for (const c of bundle.allCostos) {
    const otNum = bundle.otNumByRowId[c.ID_Orden] ?? "?";
    parts.push(
      [
        `#${otNum}`,
        c.ID_Detalle || "—",
        appsheetDateToISO(c.Fecha_Gasto),
        c.Categoria || "",
        `$${Math.round(num(c.Valor_Gasto))}`,
        c.ESTADO || "",
        (c.Nombre_Visual_Anticipo || "").substring(0, 120),
      ].join("|")
    );
  }
}

function renderTecnicos(parts: string[], bundle: OpsBundle): void {
  parts.push(`\n=== TABLA TÉCNICOS (n=${bundle.allTecnicos.length}) ===`);
  parts.push(`Directorio de maestros/técnicos. Usa para preguntas de contacto ("teléfono del maestro X").`);
  parts.push(`Columnas (pipe-delimited): nombre | telefono | email | popularidad`);
  parts.push(`  - "popularidad" es un ranking interno (más alto = más usado).`);
  parts.push(``);
  for (const t of bundle.allTecnicos) {
    parts.push(
      [
        t["Nombre de Tecnico"] || "—",
        t.Telefono || "",
        t.EMAIL || "",
        t.Popularidad_Tecnico || "0",
      ].join("|")
    );
  }
}
