// Verificaciones de integridad entre Caja y Subrubros (solo lectura).
//
// Son las mismas consultas que se usaron en la auditoría del 29/09/2026. No
// corrigen nada: listan los casos para revisarlos y enlazarlos con su traza de
// auditoría. La decisión fue dejar el histórico como está y evitar que vuelva a
// pasar; esto sirve para detectar si algo se escapa.
const { Movimiento, CajaMovimiento, CajaConfig, Subrubro, Audit } = require('../models');
const { computeSaldosFacturas } = require('../db');
const { hoyLocal } = require('./tz');

const MAX_ITEMS = 200;
const r2 = (n) => Math.round((n || 0) * 100) / 100;

// Día (YYYY-MM-DD) en Argentina de un instante ISO. Argentina no tiene horario de
// verano: UTC-3 fijo.
const diaAR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10);

function check(key, titulo, descripcion, severidad, items) {
  return { key, titulo, descripcion, severidad, cantidad: items.length, items: items.slice(0, MAX_ITEMS) };
}

async function buscarInconsistencias() {
  const [movs, caja, subs, cfg] = await Promise.all([
    Movimiento.find({}, { subrubro_id: 1, fecha: 1, fecha_vencimiento: 1, monto: 1, pago: 1, tipo: 1, pagado: 1, facturas_vinculadas_ids: 1, caja_mov_id: 1, concepto: 1 }).lean(),
    CajaMovimiento.find({}).lean(),
    Subrubro.find({}, { nombre: 1, rubro_id: 1 }).lean(),
    CajaConfig.findById('main').lean(),
  ]);
  const movById = new Map(movs.map(m => [m._id, m]));
  const cajaById = new Map(caja.map(c => [c._id, c]));
  const subNombre = new Map(subs.map(s => [s._id, s.nombre]));
  const nombreSub = (id) => subNombre.get(id) || null;
  const checks = [];

  // 1 y 2. Ítem confirmado con pago: fecha y monto deben coincidir con el pago.
  const confirmados = caja.filter(c => c.confirmado === true && c.pago_mov_id != null && movById.has(c.pago_mov_id));
  checks.push(check('caja_pago_fecha', 'Fecha de Caja distinta a la del pago',
    'El ítem de Caja y el pago del subrubro cuentan el mismo hecho en días distintos.', 'error',
    confirmados.filter(c => movById.get(c.pago_mov_id).fecha !== c.fecha).map(c => ({
      caja_id: c._id, pago_id: c.pago_mov_id, subrubro: nombreSub(c.subrubro_id), concepto: c.concepto,
      detalle: `Caja ${c.fecha} · pago ${movById.get(c.pago_mov_id).fecha}`,
    }))));
  checks.push(check('caja_pago_monto', 'Monto de Caja distinto al del pago',
    'El ítem de Caja y el pago del subrubro tienen importes distintos.', 'error',
    confirmados.filter(c => Math.abs((movById.get(c.pago_mov_id).pago || 0) - (c.monto || 0)) > 0.005).map(c => ({
      caja_id: c._id, pago_id: c.pago_mov_id, subrubro: nombreSub(c.subrubro_id), concepto: c.concepto,
      detalle: `Caja $${r2(c.monto)} · pago $${r2(movById.get(c.pago_mov_id).pago)} (${c.fecha})`,
    }))));

  // 3. Referencias rotas.
  const rotas = [];
  for (const c of caja) {
    if (c.movimiento_id != null && !movById.has(c.movimiento_id)) rotas.push({ caja_id: c._id, concepto: c.concepto, detalle: `Caja → factura ${c.movimiento_id} inexistente (${c.fecha})` });
    if (c.pago_mov_id != null && !movById.has(c.pago_mov_id)) rotas.push({ caja_id: c._id, concepto: c.concepto, detalle: `Caja → pago ${c.pago_mov_id} inexistente (${c.fecha})` });
    if (c.nc_mov_id != null && !movById.has(c.nc_mov_id)) rotas.push({ caja_id: c._id, concepto: c.concepto, detalle: `Caja → NC ${c.nc_mov_id} inexistente (${c.fecha})` });
  }
  for (const m of movs) {
    if (m.caja_mov_id != null && !cajaById.has(m.caja_mov_id)) rotas.push({ pago_id: m._id, subrubro: nombreSub(m.subrubro_id), detalle: `${m.tipo} ${m._id} → ítem de Caja ${m.caja_mov_id} inexistente (${m.fecha})` });
  }
  checks.push(check('referencias_rotas', 'Referencias rotas', 'Registros que apuntan a otro que ya no existe.', 'error', rotas));

  // 4. NC de descuento cuyo pago ya no existe.
  checks.push(check('nc_sin_pago', 'NC de descuento sin su pago',
    'Una nota de crédito automática quedó viva aunque el pago que la acompañaba se borró.', 'error',
    caja.filter(c => c.nc_mov_id != null && movById.has(c.nc_mov_id) && (c.pago_mov_id == null || !movById.has(c.pago_mov_id)))
      .map(c => ({ caja_id: c._id, pago_id: c.nc_mov_id, subrubro: nombreSub(c.subrubro_id), concepto: c.concepto, detalle: `NC ${c.nc_mov_id} por $${r2(c.descuento)}` }))));

  // 5. Más de un pendiente por factura (el índice lo impide; se verifica igual).
  const pendPorFactura = new Map();
  for (const c of caja) if (c.confirmado === false && c.movimiento_id != null) pendPorFactura.set(c.movimiento_id, [...(pendPorFactura.get(c.movimiento_id) || []), c]);
  checks.push(check('pendientes_duplicados', 'Factura con más de un pendiente en Caja', 'Cada factura debería tener como mucho un pago pendiente.', 'error',
    [...pendPorFactura.entries()].filter(([, l]) => l.length > 1).map(([fid, l]) => ({ caja_id: l[0]._id, detalle: `Factura ${fid}: ${l.length} pendientes (${l.map(x => x._id).join(', ')})` }))));

  // 6. Factura de un rubro sincronizado, vencida, con saldo y sin pendiente en Caja.
  const rubSync = new Set(cfg?.rubros_sync || []);
  const subSync = new Set(subs.filter(s => rubSync.has(s.rubro_id)).map(s => s._id));
  const hoy = hoyLocal();
  const porSub = new Map();
  for (const m of movs) { if (!porSub.has(m.subrubro_id)) porSub.set(m.subrubro_id, []); porSub.get(m.subrubro_id).push(m); }
  const sinPendiente = [];
  for (const [sid, lista] of porSub) {
    if (!subSync.has(sid)) continue;
    const saldos = computeSaldosFacturas(lista);
    for (const f of lista) {
      if (f.tipo !== 'factura' || !f.fecha_vencimiento || f.fecha_vencimiento > hoy) continue;
      const saldo = saldos.get(f._id) || 0;
      if (saldo > 0.005 && !pendPorFactura.has(f._id)) {
        sinPendiente.push({ factura_id: f._id, subrubro: nombreSub(sid), concepto: f.concepto || '', detalle: `Saldo $${r2(saldo)}, venció ${f.fecha_vencimiento}` });
      }
    }
  }
  checks.push(check('factura_sin_pendiente', 'Factura vencida con saldo que no está en la Caja',
    'Se corrige sola al abrir la Caja (el auto-sync crea el pendiente), salvo que se haya descartado hoy.', 'aviso', sinPendiente));

  // 7. Pagos sin ningún reflejo en Caja (ni ítem confirmado ni espejo).
  const conItem = new Set(caja.filter(c => c.pago_mov_id != null).map(c => c.pago_mov_id));
  checks.push(check('pagos_sin_caja', 'Pagos del subrubro que no figuran en la Caja',
    'Suelen ser pagos importados de Excel o cargados antes de que existiera la sincronización.', 'aviso',
    movs.filter(m => m.tipo === 'pago' && !(m.caja_mov_id != null && cajaById.has(m.caja_mov_id)) && !conItem.has(m._id))
      .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))
      .map(m => ({ pago_id: m._id, subrubro: nombreSub(m.subrubro_id), detalle: `$${r2(m.pago)} del ${m.fecha || 'sin fecha'}` }))));

  // 8. Confirmaciones registradas en un día distinto al real (histórico, informativo).
  const audits = await Audit.find(
    { recurso: 'caja', accion: 'create', 'diff.response.pago_mov_id': { $exists: true } },
    { fecha: 1, usuario: 1, recurso_id: 1, 'diff.payload.fecha': 1 },
  ).sort({ _id: -1 }).lean();
  checks.push(check('confirmado_otra_fecha', 'Pagos confirmados en un día distinto al real',
    'Se confirmaron mirando otra fecha en la Caja. Desde el 29/09/2026 ya no se puede confirmar en un día futuro y en uno pasado se pide confirmación. No se corrigen.', 'aviso',
    audits.filter(a => a.diff?.payload?.fecha && a.diff.payload.fecha !== diaAR(a.fecha)).map(a => ({
      caja_id: Number(a.recurso_id), audit_id: a._id, usuario: a.usuario,
      detalle: `Confirmado el ${diaAR(a.fecha)}, registrado el ${a.diff.payload.fecha}`,
    }))));

  return {
    generado: new Date().toISOString(),
    total_errores: checks.filter(c => c.severidad === 'error').reduce((s, c) => s + c.cantidad, 0),
    total_avisos: checks.filter(c => c.severidad === 'aviso').reduce((s, c) => s + c.cantidad, 0),
    checks,
  };
}

module.exports = { buscarInconsistencias };
