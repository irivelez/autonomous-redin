export interface AppSheetConfig {
  appId: string;
  accessKey: string;
  baseUrl?: string;
}

export interface FindOptions {
  selector?: string;
  top?: number;
}

export class AppSheetClient {
  private appId: string;
  private accessKey: string;
  private baseUrl: string;

  constructor(config: AppSheetConfig) {
    this.appId = config.appId;
    this.accessKey = config.accessKey;
    this.baseUrl = config.baseUrl ?? "https://api.appsheet.com";
  }

  private url(table: string): string {
    return `${this.baseUrl}/api/v2/apps/${this.appId}/tables/${encodeURIComponent(table)}/Action`;
  }

  async find<T = Record<string, string>>(table: string, opts?: FindOptions): Promise<T[]> {
    const properties: Record<string, unknown> = { Locale: "en-US" };
    if (opts?.selector) properties.Selector = opts.selector;

    const res = await fetch(this.url(table), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({ Action: "Find", Properties: properties, Rows: [] }),
    });

    if (!res.ok) throw new Error(`AppSheet ${table} Find failed: ${res.status}`);
    const text = await res.text();
    if (!text) return [];
    return JSON.parse(text) as T[];
  }

  async findByIds<T = Record<string, string>>(table: string, keyField: string, ids: string[]): Promise<T[]> {
    const rows = ids.map((id) => ({ [keyField]: id }));
    const res = await fetch(this.url(table), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({ Action: "Find", Properties: { Locale: "en-US" }, Rows: rows }),
    });

    if (!res.ok) throw new Error(`AppSheet ${table} FindByIds failed: ${res.status}`);
    const text = await res.text();
    if (!text) return [];
    return JSON.parse(text) as T[];
  }

  async edit<T = Record<string, string>>(table: string, rows: Partial<T>[]): Promise<T[]> {
    const res = await fetch(this.url(table), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({ Action: "Edit", Properties: { Locale: "en-US" }, Rows: rows }),
    });

    if (!res.ok) throw new Error(`AppSheet ${table} Edit failed: ${res.status}`);
    const text = await res.text();
    if (!text) return [];
    return JSON.parse(text) as T[];
  }

  async add<T = Record<string, string>>(table: string, rows: Partial<T>[]): Promise<T[]> {
    const res = await fetch(this.url(table), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({ Action: "Add", Properties: { Locale: "en-US" }, Rows: rows }),
    });

    if (!res.ok) throw new Error(`AppSheet ${table} Add failed: ${res.status}`);
    const text = await res.text();
    if (!text) return [];
    return JSON.parse(text) as T[];
  }
}

// Known table names in Redin's AppSheet app
export const TABLES = {
  ORDENES: "Ordenes_Trabajo",
  CLIENTES: "Clientes",
  CIUDADES: "Ciudades",
  CONTACTOS: "CONTACTOS",
  USUARIOS: "Usuarios",
  ARQUITECTOS: "Arquitecto",
  DIRECCIONES: "BD_REDIN_Direcciones",
  COSTOS: "Costos_Ejecucion",
  ACTIVIDADES: "Detalle de Actividades",
  TECNICOS: "Tecnicos",
  PRESTAMOS: "PRESTAMOS",
} as const;

export interface DetalleActividad {
  "Row ID": string;
  ID_Detalle: string;
  ID_Orden: string;
  Actividad_Descripcion: string;
  Categoria: string;
  Subcategoria: string;
  Tecnico: string;
  Email_Tecnico: string;
  Costo: string;
  Gasto_Aprobado: string;
  Saldo_Pendiente_Item: string;
  Fecha_Hora_Visita: string;
}

export interface CostoEjecucion {
  "Row ID": string;
  ID_Costo: string;
  ID_Orden: string;
  ID_Detalle: string;
  Fecha_Gasto: string;
  Categoria: string;
  Valor_Gasto: string;
  ESTADO: string;
  Numero_Consecutivo: string;
  Nombre_Visual_Anticipo: string;
  Evidencia: string;
}

export interface Tecnico {
  "Row ID": string;
  "Nombre de Tecnico": string;
  EMAIL: string;
  Telefono: string;
  Popularidad_Tecnico: string;
}

// OT status values as they appear in the app
export const ESTADOS = {
  SOLICITUD: "01. Solicitud / Lead",
  VISITA: "02. Visita Realizada",
  COTIZACION: "03. Cotización Enviada",
  REPLANTEO: "03.1 Replante de cotizacion",
  COORDINAR: "4. Coordinar – Listo para ejecutar",
  EJECUCION: "En ejecución",
  POR_APROBAR: "Por aprobar",
  TERMINADO: "Terminado",
  FACTURADO: "Facturado",
  PAGADO: "Pagado",
  PERDIDA: "99. Perdida / Cancelada",
} as const;

export interface OrdenTrabajo {
  _RowNumber: string;
  "Row ID": string;
  ID_Orden: string;
  Descripcion: string;
  Direccion_Sede: string;
  Valor_Estimado: string;
  Categoria: string;
  Subcategoria: string;
  Fecha_Creacion: string;
  Estado: string;
  Numero_Orden: string;
  Numero_interno_cliente: string;
  Ciudad: string;
  ID_Cliente: string;
  ID_Arquitecto: string;
  Numero_Factura: string;
  Fecha_Facturacion: string;
  Valor_Facturado_Real: string;
  "Valor_Facturado_Real + IVA": string;
  Fecha_Pago_Real: string;
  TS_Visita_Fin: string;
  TS_Cotizacion_Envio: string;
  TS_Inicio_Replanteo: string;
  TS_Aprobacion: string;
  TS_PorAprobar: string;
  TS_Terminado: string;
  TS_Cancelacion: string;
  Contacto_Asignado: string;
  Prioridad_ANS: string;
  "Resumen Visual": string;
  Total_Orden_Calculado: string;
  Total_Ejecutado_Real: string;
  Rentabilidad_Actual: string;
  Total_Gasto_Aprobado_Global: string;
  Diferencia_Global: string;
  "Rentabilidad_Visual": string;
  Dias_En_Cartera: string;
  Mes_Anio: string;
  Nombre_Arquitecto_Real: string;
  "Dias Ejecucion - Facturado": string;
  VC_KPI_Dias_Visita: string;
  VC_KPI_Dias_Oferta: string;
  VC_KPI_Dias_Cierre: string;
  Horas_Max_Respuesta: string;
  Horas_Max_Solucion: string;
  Fecha_Limite_Respuesta: string;
  Fecha_Limite_Solucion: string;
  Alerta_Respuesta: string;
  Alerta_Solucion: string;
  Dias_Vida_Total: string;
  Dias_Ejecucion_A_Pago: string;
}

export interface Usuario {
  "Row ID": string;
  NOMBRE: string;
  EMAIL: string;
  ROL: string;
}

export interface Contacto {
  "Row ID": string;
  ID_Contacto: string;
  Nombre_Contacto: string;
  Telefono: string;
  Correo: string;
  Rol: string;
  ID_Cliente: string;
}
