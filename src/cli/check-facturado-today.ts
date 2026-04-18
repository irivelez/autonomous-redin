/**
 * Ground-truth check: what OTs are facturadas HOY (today) vs this month?
 * Compares what the bot should have answered against what the LLM said.
 */
import "dotenv/config";
import { AppSheetClient, TABLES, ESTADOS, type OrdenTrabajo } from "../clients/appsheet.js";

function isoDate(s: string): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

async function main() {
  const appsheet = new AppSheetClient({
    appId: process.env.APPSHEET_APP_ID!,
    accessKey: process.env.APPSHEET_ACCESS_KEY!,
  });

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  console.log(`Today (UTC ISO): ${today}`);
  console.log(`Month: ${month}`);

  const all = await appsheet.find<OrdenTrabajo>(TABLES.ORDENES);
  console.log(`\nTotal OTs: ${all.length}`);

  const facturado = all.filter((o) => o.Estado === ESTADOS.FACTURADO || o.Estado === ESTADOS.PAGADO);
  console.log(`Facturado OR Pagado state rows: ${facturado.length}`);

  const thisMonth = all.filter((o) => {
    const iso = isoDate(o.Fecha_Facturacion);
    return iso.startsWith(month);
  });

  const todayExact = all.filter((o) => {
    const iso = isoDate(o.Fecha_Facturacion);
    return iso === today;
  });

  console.log(`\n=== Facturadas ESTE MES (fecha_facturacion starts with ${month}) ===`);
  console.log(`Count: ${thisMonth.length}`);
  let monthValorReal = 0;
  let monthValorEstimado = 0;
  for (const ot of thisMonth) {
    const real = parseFloat(ot.Valor_Facturado_Real || "0") || 0;
    const est = parseFloat(ot.Valor_Estimado || "0") || 0;
    monthValorReal += real;
    monthValorEstimado += est;
  }
  console.log(`Valor_Facturado_Real total: $${monthValorReal.toLocaleString()}`);
  console.log(`Valor_Estimado total: $${monthValorEstimado.toLocaleString()}`);

  console.log(`\n=== Facturadas HOY (fecha_facturacion == ${today}) ===`);
  console.log(`Count: ${todayExact.length}`);
  let todayValorReal = 0;
  let todayValorEstimado = 0;
  for (const ot of todayExact) {
    const real = parseFloat(ot.Valor_Facturado_Real || "0") || 0;
    const est = parseFloat(ot.Valor_Estimado || "0") || 0;
    todayValorReal += real;
    todayValorEstimado += est;
    console.log(
      `  #${ot.Numero_Orden} | ${ot.Estado} | ${ot.ID_Cliente} | ${ot.Ciudad} | ${ot.Nombre_Arquitecto_Real} | ` +
        `fact_date="${ot.Fecha_Facturacion}" iso=${isoDate(ot.Fecha_Facturacion)} | ` +
        `real=$${real.toLocaleString()} estimado=$${est.toLocaleString()}`
    );
  }
  console.log(`\nValor_Facturado_Real total HOY: $${todayValorReal.toLocaleString()}`);
  console.log(`Valor_Estimado total HOY: $${todayValorEstimado.toLocaleString()}`);

  console.log(`\n=== Sample raw Fecha_Facturacion values from the table ===`);
  const seen = new Set<string>();
  for (const ot of all) {
    if (ot.Fecha_Facturacion && !seen.has(ot.Fecha_Facturacion)) {
      seen.add(ot.Fecha_Facturacion);
      console.log(`  raw="${ot.Fecha_Facturacion}"  -> iso=${isoDate(ot.Fecha_Facturacion)}`);
      if (seen.size >= 10) break;
    }
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
