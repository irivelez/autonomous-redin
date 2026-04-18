import "dotenv/config";
import { AppSheetClient } from "../clients/appsheet.js";

const appsheet = new AppSheetClient({
  appId: process.env.APPSHEET_APP_ID!,
  accessKey: process.env.APPSHEET_ACCESS_KEY!,
});

// Name variants. AppSheet table names are case-sensitive and sometimes use
// underscores or spaces. We probe until one returns rows.
const CANDIDATES: Record<string, string[]> = {
  DETALLE_ACTIVIDADES: [
    "Detalle_Actividades",
    "DETALLE_ACTIVIDADES",
    "Detalles_Actividades",
    "Detalle de Actividades",
    "DETALLE DE ACTIVIDADES",
    "Actividades",
    "ACTIVIDADES",
    "Detalle_Actividad",
    "Detalles_Actividad",
  ],
  COSTOS_EJECUCION: [
    "Costos_Ejecucion",
    "COSTOS_EJECUCION",
    "Costos_Ejecución",
    "Costos de Ejecucion",
    "COSTOS DE EJECUCION",
    "Costos de Ejecución",
    "Costos",
  ],
  FACTURAS: [
    "Facturas",
    "FACTURAS",
    "Factura",
    "FACTURA",
    "Facturacion",
    "FACTURACION",
    "Facturación",
    "Facturas_Redin",
    "Bills",
    "Invoices",
    "Facturas_Emitidas",
    "Facturas_Clientes",
    "DETALLE_FACTURAS",
    "Detalle_Facturas",
    "Detalle de Facturas",
  ],
  TECNICOS: [
    "Tecnicos",
    "Técnicos",
    "TECNICOS",
    "TÉCNICOS",
    "Tecnico",
    "Técnico",
    "Maestros",
    "MAESTROS",
  ],
};

async function probe(label: string, names: string[]) {
  for (const name of names) {
    try {
      const rows = await appsheet.find<Record<string, string>>(name);
      if (rows.length > 0) {
        console.log(`\n--- [${label}] MATCH: "${name}" (${rows.length} rows) ---`);
        console.log("columns:", Object.keys(rows[0]));
        console.log("sample row:", JSON.stringify(rows[0], null, 2));
        return { name, rows };
      }
    } catch (err) {
      // 404/400 responses — ignore and keep probing
    }
  }
  console.log(`\n--- [${label}] NO MATCH in ${names.length} candidates ---`);
  return null;
}

async function main() {
  for (const [label, names] of Object.entries(CANDIDATES)) {
    await probe(label, names);
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
