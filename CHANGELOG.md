# Changelog — Kontia backend

## 1.1.0 — 2026-09-30

Versión que sale de la auditoría del 29/09/2026. Al arrancar, el servidor migra
solo el índice de Caja y crea los índices nuevos; no hace falta ningún paso
manual.

### Caja del Día
- **Fecha real al confirmar.** Si no llega fecha, el pago se registra hoy
  (hora argentina); una fecha futura se rechaza (400). Antes el pago quedaba en
  el día que se estaba mirando o en el vencimiento del ítem.
- **Próximos vencimientos:** `GET /caja/proximos` y `GET /caja/dia` los
  devuelven para pagarlos por adelantado desde hoy (ventana mínima de 7 días).
- **Pago parcial:** `POST /caja/:id/confirmar` acepta `monto`; el resto queda
  como un pendiente nuevo de la misma factura. Una factura puede tener varios
  ítems confirmados y un solo pendiente.
- **Editar boleta:** `GET/PUT /caja/:id/boleta` corrige monto, percepción IVA e
  IIBB de la factura de un pendiente.
- Los gastos manuales sin confirmar creados desde el 29/09 se arrastran a los
  días siguientes (`CAJA_ARRASTRE_MANUAL_DESDE`).
- `PUT /caja/:id` rechaza confirmar/revertir y cambiar monto, fecha o tipo de
  ítems vinculados a una factura o a un pago.
- Editar un remito ya no pisa su pago confirmado; editar en el subrubro un pago
  nacido en Caja actualiza el ítem; borrar un pago con descuento borra su NC.
- `GET /caja/dia`: todo lo del día en una request.

### Seguridad
- Cada request confirma que el usuario siga activo y usa su rol actual;
  `/auth/refresh` no renueva usuarios desactivados; cambiar la contraseña
  cierra las sesiones abiertas (`token_version`).
- Validación de entrada en movimientos y Caja (tipos, fechas reales, montos);
  errores de validación 400 y "no encontrado" 404 en vez de 500.
- Regex con texto del usuario escapado; uploads con límite de 10 MB; login con
  datos no textuales → 400; HTML escapado en el email de alertas.

### Auditoría
- `GET /audit/inconsistencias`: verificaciones de integridad Caja ↔
  Subrubros (solo lectura).

### Datos
- Restaurar un backup recalcula los contadores de IDs en vez de copiarlos.
- Import de Excel: importes negativos entran como nota de crédito; las
  facturas sin vencimiento toman el del subrubro.
- Borrados en cascada limpian las referencias (Caja, productos,
  recordatorios, configuración).
- IVA: una "Factura de Crédito Electrónica" ya no se resta como NC.
- "Hoy" y el mes actual en hora argentina en todo el backend.

### Performance
- Proyección de campos en las lecturas masivas de movimientos, rango de fechas
  en vez de regex en el dashboard, índices nuevos.

### Otros
- `GET /api/health` informa la versión.
- Se quitan `GET /caja/vencimientos-sync` (sin uso) y scripts de debug viejos;
  `check-doc.js` pasa a `backfill-documento.js`.

## 1.0.0

Versión anterior a la auditoría.
