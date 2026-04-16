import "dotenv/config";
import { AppSheetClient, TABLES, type OrdenTrabajo, ESTADOS } from "../clients/appsheet.js";
import { ExecutionMonitor, formatAlerts } from "../tracker/monitor.js";

const client = new AppSheetClient({
  appId: process.env.APPSHEET_APP_ID!,
  accessKey: process.env.APPSHEET_ACCESS_KEY!,
});

const monitor = new ExecutionMonitor(client);

async function main() {
  const arg = process.argv[2] || "alerts";

  switch (arg) {
    case "alerts": {
      console.log("🔍 Scanning for alerts...\n");
      const alerts = await monitor.scan();
      console.log(formatAlerts(alerts));
      break;
    }

    case "execution": {
      console.log("⚡ OTs en ejecución:\n");
      const ots = await monitor.getExecutionOTs();
      for (const ot of ots) {
        console.log(`  #${ot.Numero_Orden.padEnd(4)} | ${ot.Ciudad.padEnd(18)} | ${ot.ID_Cliente.padEnd(30)} | ${ot.Estado}`);
        console.log(`         Arq: ${ot.Nombre_Arquitecto_Real} | Valor: $${parseInt(ot.Valor_Estimado || "0").toLocaleString()} | ${ot.Rentabilidad_Visual}`);
      }
      console.log(`\n  Total: ${ots.length} OTs en estados de ejecución`);
      break;
    }

    case "quotes": {
      console.log("💬 Cotizaciones pendientes:\n");
      const ots = await monitor.getQuotePendingOTs();
      for (const ot of ots) {
        const sent = ot.TS_Cotizacion_Envio ? new Date(ot.TS_Cotizacion_Envio) : null;
        const days = sent ? Math.floor((Date.now() - sent.getTime()) / 86400000) : "?";
        console.log(`  #${ot.Numero_Orden.padEnd(4)} | ${ot.Ciudad.padEnd(18)} | ${ot.ID_Cliente.padEnd(30)} | ${days} días`);
        console.log(`         Arq: ${ot.Nombre_Arquitecto_Real} | Valor: $${parseInt(ot.Valor_Estimado || "0").toLocaleString()}`);
      }
      console.log(`\n  Total: ${ots.length} cotizaciones sin respuesta`);
      break;
    }

    case "inter": {
      console.log("🚨 Inter Rapidísimo — SLA Monitor:\n");
      const allOTs = await client.find<OrdenTrabajo>(TABLES.ORDENES);
      const interOTs = allOTs.filter(
        (ot) => ot.ID_Cliente.toLowerCase().includes("interrapidisimo") &&
          !["Facturado", "Pagado", "99. Perdida / Cancelada"].includes(ot.Estado)
      );
      for (const ot of interOTs) {
        const resp = ot.Alerta_Respuesta || "—";
        const sol = ot.Alerta_Solucion || "—";
        console.log(`  #${ot.Numero_Orden.padEnd(4)} | ${ot.Ciudad.padEnd(18)} | ${ot.Estado.padEnd(25)} | Resp: ${resp} | Sol: ${sol}`);
      }
      console.log(`\n  Total: ${interOTs.length} OTs activas de Inter Rapidísimo`);
      break;
    }

    default:
      console.log("Usage: npm run monitor -- [alerts|execution|quotes|inter]");
  }
}

main().catch(console.error);
