import "dotenv/config";
import { AppSheetClient, TABLES, type OrdenTrabajo } from "../clients/appsheet.js";
import { ExecutionMonitor, formatDashboard, formatAlerts } from "../tracker/monitor.js";

const client = new AppSheetClient({
  appId: process.env.APPSHEET_APP_ID!,
  accessKey: process.env.APPSHEET_ACCESS_KEY!,
});

const monitor = new ExecutionMonitor(client);

async function main() {
  console.log("Connecting to Redin AppSheet...\n");

  const allOTs = await client.find<OrdenTrabajo>(TABLES.ORDENES);
  const activeOTs = allOTs.filter(
    (ot) => !["Facturado", "Pagado", "99. Perdida / Cancelada"].includes(ot.Estado)
  );

  console.log(formatDashboard(activeOTs));

  const alerts = await monitor.scan();
  console.log(formatAlerts(alerts));

  // Revenue summary
  const totalEstimado = allOTs.reduce((s, ot) => s + (parseFloat(ot.Valor_Estimado) || 0), 0);
  const totalFacturado = allOTs
    .filter((ot) => ot.Estado === "Facturado" || ot.Estado === "Pagado")
    .reduce((s, ot) => s + (parseFloat(ot.Valor_Facturado_Real) || 0), 0);
  const totalRentabilidad = allOTs
    .filter((ot) => ot.Estado === "Facturado" || ot.Estado === "Pagado")
    .reduce((s, ot) => s + (parseFloat(ot.Rentabilidad_Actual) || 0), 0);

  console.log("\n💰 RESUMEN FINANCIERO");
  console.log("═══════════════════════════════════════");
  console.log(`  Total OTs:                ${allOTs.length}`);
  console.log(`  Pipeline valor estimado:  $${(totalEstimado / 1_000_000).toFixed(1)}M COP`);
  console.log(`  Facturado + Pagado:       $${(totalFacturado / 1_000_000).toFixed(1)}M COP`);
  console.log(`  Rentabilidad acumulada:   $${(totalRentabilidad / 1_000_000).toFixed(1)}M COP`);
  if (totalFacturado > 0) {
    console.log(`  Margen promedio:          ${((totalRentabilidad / totalFacturado) * 100).toFixed(1)}%`);
  }
}

main().catch(console.error);
