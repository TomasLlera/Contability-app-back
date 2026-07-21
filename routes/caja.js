const express = require('express');
const router = express.Router();
const { CajaMovimiento, CajaDescarte, CajaConfig, Counter, Subrubro, Movimiento } = require('../models');
const db = require('../db');
const { computeSaldosFacturas } = db;
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../logger');

const now = () => new Date().toISOString();

function withId(doc) {
  if (!doc) return null;
  const o = doc._id !== undefined ? doc : doc.toObject?.() ?? doc;
  return { ...o, id: o._id };
}
function withIds(docs) { return docs.map(withId); }

function addDaysToStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// GET /api/caja/config
router.get('/config', asyncHandler(async (req, res) => {
  const cfg = await CajaConfig.findById('main').lean();
  res.json(cfg || { empleados: [], proveedores: [], rubros_sync: [], dias_anticipacion_caja: 3 });
}));

// PUT /api/caja/config
router.put('/config', requireAdmin, audit('caja_config'), asyncHandler(async (req, res) => {
  const { empleados, proveedores, rubros_sync, dias_anticipacion_caja } = req.body;
  const upd = { empleados, proveedores };
  if (rubros_sync !== undefined) upd.rubros_sync = rubros_sync;
  if (dias_anticipacion_caja !== undefined) upd.dias_anticipacion_caja = Number(dias_anticipacion_caja);
  await CajaConfig.findByIdAndUpdate('main', { $set: upd }, { upsert: true });
  res.json({ ok: true });
}));

// GET /api/caja/vencimientos-sync?fecha=YYYY-MM-DD
router.get('/vencimientos-sync', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });

  const cfg = await CajaConfig.findById('main').lean();
  const rubros_sync = cfg?.rubros_sync || [];
  if (rubros_sync.length === 0) return res.json([]);

  const dias = cfg?.dias_anticipacion_caja ?? 3;
  const hasta = addDaysToStr(fecha, dias);

  // Los subrubros DEUDA (dinero a cobrar) no generan gastos en la Caja: sus
  // vencimientos se muestran aparte como informativos (GET /movimientos/vencimientos
  // con tipo=deuda) y sus abonos entran como ingresos.
  const subrubros = (await Subrubro.find({ rubro_id: { $in: rubros_sync } }).lean())
    .filter(s => (s.tipo_subrubro || 'factura') !== 'deuda');
  if (subrubros.length === 0) return res.json([]);

  const subrubroIds = subrubros.map(s => s._id);
  const subrubroMap = Object.fromEntries(subrubros.map(s => [s._id, s]));

  // Saldo por factura = monto − pagos − NC (FIFO). Requiere TODOS los movimientos del
  // subrubro (NC/pagos pueden estar en otro mes), no solo las facturas de la ventana.
  const todos = await Movimiento.find({ subrubro_id: { $in: subrubroIds } }).lean();
  const porSub = new Map();
  for (const m of todos) {
    if (!porSub.has(m.subrubro_id)) porSub.set(m.subrubro_id, []);
    porSub.get(m.subrubro_id).push(m);
  }
  const saldosPorSub = new Map();
  for (const [sid, lista] of porSub) saldosPorSub.set(sid, computeSaldosFacturas(lista));
  const saldoDe = (m) => saldosPorSub.get(m.subrubro_id)?.get(m._id) ?? m.monto;

  const movimientos = todos
    .filter(m =>
      m.tipo === 'factura' && !m.pagado &&
      m.fecha_vencimiento && m.fecha_vencimiento >= fecha && m.fecha_vencimiento <= hasta &&
      saldoDe(m) > 0.005   // descarta facturas ya saldadas por pagos/NC aunque pagado === false
    )
    .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));

  if (movimientos.length === 0) return res.json([]);

  const confirmed = await CajaMovimiento.find({
    fecha,
    movimiento_id: { $in: movimientos.map(m => m._id) },
  }).lean();
  const confirmedSet = new Set(confirmed.map(c => c.movimiento_id));

  res.json(
    movimientos
      .filter(m => !confirmedSet.has(m._id))
      .map(m => ({
        movimiento_id: m._id,
        subrubro_id: m.subrubro_id,
        subrubro_nombre: subrubroMap[m.subrubro_id]?.nombre || '',
        monto: saldoDe(m),   // saldo actual, no monto original
        fecha_vencimiento: m.fecha_vencimiento,
        concepto: m.concepto || '',
      }))
  );
}));

// Reconciliación: trae al día los ítems de caja auto-sincronizados (no confirmados)
// con el estado actual de su factura de origen. Corre SIEMPRE (incluso sin rubros
// sincronizados) para limpiar restos cuando se desactiva el sync.
//   • factura borrada / pagada / saldada → elimina el ítem de caja pendiente.
//   • cambió el saldo, el vencimiento o el concepto → actualiza el ítem.
// Sólo toca ítems auto-sync (auto_sync:true) o legacy con la firma del auto-sync
// (metodo null + movimiento_id), nunca gastos cargados a mano por el usuario.
async function reconciliarAutoSync() {
  // Trae TODOS los pendientes enlazados a una factura; el loop decide cuáles tocar:
  // los auto-sync (auto_sync:true o firma legacy metodo:null) y, además, cualquiera
  // cuya factura viva en un subrubro DEUDA (p. ej. gastos de remito que quedaron de
  // antes de convertir el subrubro: su signo ya no corresponde).
  const autoItems = await CajaMovimiento.find({
    confirmado: false,
    movimiento_id: { $ne: null },
  }).lean();
  if (autoItems.length === 0) return { actualizados: 0, eliminados: 0 };

  const facturas = await Movimiento.find({
    _id: { $in: autoItems.map(c => c.movimiento_id) },
  }).lean();
  const facturaMap = new Map(facturas.map(f => [f._id, f]));

  // Saldo actual por factura: requiere todos los movimientos de los subrubros
  // referenciados (pagos/NC pueden estar en otro mes).
  const subIds = [...new Set(facturas.map(f => f.subrubro_id))];
  const todos = await Movimiento.find({ subrubro_id: { $in: subIds } }).lean();
  const porSub = new Map();
  for (const m of todos) {
    if (!porSub.has(m.subrubro_id)) porSub.set(m.subrubro_id, []);
    porSub.get(m.subrubro_id).push(m);
  }
  const saldosPorSub = new Map();
  for (const [sid, lista] of porSub) saldosPorSub.set(sid, computeSaldosFacturas(lista));
  const saldoDe = (f) => saldosPorSub.get(f.subrubro_id)?.get(f._id) ?? f.monto;

  const subs = await Subrubro.find({ _id: { $in: subIds } }).lean();
  const subMap = Object.fromEntries(subs.map(s => [s._id, s]));

  const toDelete = [];
  const updateOps = [];
  for (const item of autoItems) {
    const f = facturaMap.get(item.movimiento_id);
    const subDe = f ? subMap[f.subrubro_id] : null;
    // Solo se tocan los ítems auto-generados (auto_sync / firma legacy) o los que
    // pertenecen a un subrubro DEUDA (restos con el signo viejo). Un gasto manual
    // vinculado a una factura de proveedor queda intacto.
    const esAuto = item.auto_sync || item.metodo == null;
    if (!esAuto && subDe?.tipo_subrubro !== 'deuda') continue;
    // Factura inexistente, ya no es factura, pagada o saldada → el pendiente sobra.
    if (!f || f.tipo !== 'factura' || f.pagado || saldoDe(f) <= 0.005) {
      toDelete.push(item._id);
      continue;
    }
    const sub = subMap[f.subrubro_id];
    const baseConcepto = sub?.nombre || 'Vencimiento';
    const concepto = f.concepto ? `${baseConcepto} — ${f.concepto}` : baseConcepto;
    const nuevoMonto = Number(saldoDe(f)) || 0;
    const nuevaFecha = f.fecha_vencimiento || item.fecha;
    const set = {};
    // El tipo del subrubro manda: deuda → ingreso pendiente de cobro; proveedor →
    // gasto. Si el subrubro cambió de tipo, el ítem pendiente corrige su signo.
    const tipoEsperado = sub?.tipo_subrubro === 'deuda' ? 'ingreso_extra' : 'gasto';
    if (item.tipo !== tipoEsperado) set.tipo = tipoEsperado;
    if (Math.abs((item.monto || 0) - nuevoMonto) > 0.005) set.monto = nuevoMonto;
    if (item.fecha !== nuevaFecha) set.fecha = nuevaFecha;
    if (item.concepto !== concepto) set.concepto = concepto;
    if (item.subrubro_id !== f.subrubro_id) set.subrubro_id = f.subrubro_id;
    // Método de pago: el subrubro manda. Si la factura tiene un método cargado y difiere
    // del ítem de Caja, se actualiza. Si la factura no tiene método (null), se respeta el
    // que el usuario haya puesto en la Caja (no se pisa).
    const metFactura = f.metodo_pago || null;
    if (metFactura && (item.metodo || null) !== metFactura) set.metodo = metFactura;
    if (!item.auto_sync) set.auto_sync = true; // backfill de la firma legacy
    if (Object.keys(set).length) {
      updateOps.push({ updateOne: { filter: { _id: item._id }, update: { $set: set } } });
    }
  }

  let eliminados = 0, actualizados = 0;
  if (toDelete.length) {
    const r = await CajaMovimiento.deleteMany({ _id: { $in: toDelete } });
    eliminados = r.deletedCount || 0;
  }
  if (updateOps.length) {
    const r = await CajaMovimiento.bulkWrite(updateOps, { ordered: false });
    actualizados = r.modifiedCount || 0;
  }
  return { actualizados, eliminados };
}

// POST /api/caja/auto-sync?fecha=YYYY-MM-DD
// Reconcilia los ítems existentes con su factura y crea los faltantes.
// Idempotente: crea CajaMovimiento (tipo='gasto', confirmado=false, metodo=null)
// por cada factura que vence dentro de la ventana en algún rubro sincronizado,
// siempre que no exista ya un caja item para ese movimiento_id.
router.post('/auto-sync', requireAdmin, asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });

  // Reconciliar primero: refleja borrados/pagos/cambios de monto y vencimiento.
  const { actualizados, eliminados } = await reconciliarAutoSync();

  const cfg = await CajaConfig.findById('main').lean();
  const rubros_sync = cfg?.rubros_sync || [];
  if (rubros_sync.length === 0) return res.json({ creados: 0, actualizados, eliminados });

  const dias = cfg?.dias_anticipacion_caja ?? 3;
  const hasta = addDaysToStr(fecha, dias);

  // Incluye también los subrubros DEUDA: sus vencimientos entran a la Caja como
  // INGRESOS pendientes de cobro (tipo ingreso_extra, confirmado:false) en vez de
  // gastos. Al confirmarlos se registra el abono en el subrubro y suman al día.
  const subrubros = await Subrubro.find({ rubro_id: { $in: rubros_sync } }).lean();
  if (subrubros.length === 0) return res.json({ creados: 0, actualizados, eliminados });

  const subIds = subrubros.map(s => s._id);
  const subMap = Object.fromEntries(subrubros.map(s => [s._id, s]));

  // Saldo por factura = monto − pagos − NC (FIFO). Requiere TODOS los movimientos del
  // subrubro (NC/pagos pueden estar en otro mes), no solo las facturas vencidas.
  const todos = await Movimiento.find({ subrubro_id: { $in: subIds } }).lean();
  const porSub = new Map();
  for (const m of todos) {
    if (!porSub.has(m.subrubro_id)) porSub.set(m.subrubro_id, []);
    porSub.get(m.subrubro_id).push(m);
  }
  const saldosPorSub = new Map();
  for (const [sid, lista] of porSub) saldosPorSub.set(sid, computeSaldosFacturas(lista));
  const saldoDe = (m) => saldosPorSub.get(m.subrubro_id)?.get(m._id) ?? m.monto;

  // Incluye también vencidas (fecha_vencimiento <= hasta): si una factura venció
  // hace 5 días y no se pagó, queremos verla hoy en caja, no perderla. Se descartan
  // las que ya están saldadas por pagos/NC aunque conserven pagado === false.
  const vencimientos = todos
    .filter(m =>
      m.tipo === 'factura' && !m.pagado &&
      m.fecha_vencimiento != null && m.fecha_vencimiento <= hasta &&
      saldoDe(m) > 0.005
    )
    .sort((a, b) => (a.fecha_vencimiento || '').localeCompare(b.fecha_vencimiento || ''));

  if (vencimientos.length === 0) return res.json({ creados: 0 });

  // Dedupe global: si ya existe un caja item (en cualquier fecha) para ese
  // movimiento_id, no crear otro. Sino, una factura vencida no pagada generaría
  // un caja item nuevo cada día que el usuario abra la caja.
  const yaCreados = await CajaMovimiento.find({
    movimiento_id: { $in: vencimientos.map(v => v._id) },
  }, { movimiento_id: 1 }).lean();
  const yaSet = new Set(yaCreados.map(c => c.movimiento_id));

  // Descartes del usuario para ESTA fecha: si borró el ítem hoy, no recrearlo hoy.
  // Al otro día (otra fecha, sin descarte) el vencimiento impago vuelve a aparecer.
  const descartados = await CajaDescarte.find({
    fecha,
    movimiento_id: { $in: vencimientos.map(v => v._id) },
  }, { movimiento_id: 1 }).lean();
  const descartadoSet = new Set(descartados.map(d => d.movimiento_id));

  const pendientes = vencimientos.filter(v => !yaSet.has(v._id) && !descartadoSet.has(v._id));
  if (pendientes.length === 0) return res.json({ creados: 0 });

  // Reservar IDs en bloque (solo se consumen si el upsert inserta).
  const startId = Counter.nextBatch
    ? await Counter.nextBatch('caja', pendientes.length)
    : null;

  // Upsert por movimiento_id: si dos llamadas al auto-sync corren en paralelo
  // (p. ej. el doble disparo de efectos de React en dev), ambas convergen al
  // mismo documento en vez de crear duplicados. El _id solo se fija al insertar.
  const ops = await Promise.all(pendientes.map(async (v, i) => {
    const sub = subMap[v.subrubro_id];
    const baseConcepto = sub?.nombre || 'Vencimiento';
    const concepto = v.concepto ? `${baseConcepto} — ${v.concepto}` : baseConcepto;
    // Deuda a cobrar → ingreso pendiente de cobro; factura de proveedor → gasto.
    const esDeuda = sub?.tipo_subrubro === 'deuda';
    const _id = startId != null ? startId + i : await Counter.next('caja');
    return {
      updateOne: {
        filter: { movimiento_id: v._id },
        update: {
          $setOnInsert: {
            _id,
            // El caja item vive en la fecha de vencimiento. Si no se paga, el GET
            // lo arrastra hacia adelante mediante el lookback de fechas anteriores.
            fecha: v.fecha_vencimiento,
            tipo: esDeuda ? 'ingreso_extra' : 'gasto',
            concepto,
            monto: Number(saldoDe(v)) || 0,   // saldo actual, no monto original
            // Método heredado de la factura: si se cargó con efectivo/transferencia en
            // el subrubro, el ítem de Caja aparece ya con ese método (si no, sin definir).
            metodo: v.metodo_pago || null,
            subrubro_id: v.subrubro_id,
            movimiento_id: v._id,
            confirmado: false,
            auto_sync: true,
            es_especial: false,
            created_at: now(),
          },
        },
        upsert: true,
      },
    };
  }));

  // ordered:false + tolerancia a E11000: el índice único sobre movimiento_id es la
  // garantía final ante una carrera exacta; el duplicado perdedor se ignora.
  let creados = 0;
  try {
    const r = await CajaMovimiento.bulkWrite(ops, { ordered: false });
    creados = r.upsertedCount || 0;
  } catch (err) {
    if (err.code !== 11000 && !(err.writeErrors || []).every(e => e.code === 11000)) throw err;
    creados = err.result?.nUpserted ?? err.result?.result?.nUpserted ?? 0;
  }
  res.json({ creados, actualizados, eliminados });
}));

// GET /api/caja/facturas-pendientes?subrubro_id=X
router.get('/facturas-pendientes', asyncHandler(async (req, res) => {
  const { subrubro_id } = req.query;
  if (!subrubro_id) return res.status(400).json({ error: 'subrubro_id requerido' });

  // Saldo por factura: requiere TODOS los movimientos del subrubro (NC/pagos
  // pueden estar en otro mes). Así una 2da NC ve el saldo restante, no el original.
  const sid = Number(subrubro_id);
  const todos = await Movimiento.find({ subrubro_id: sid }).lean();
  const saldos = computeSaldosFacturas(todos);
  const movimientos = todos
    .filter(m => m.tipo === 'factura' && !m.pagado)
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  res.json(movimientos.map(m => ({
    id: m._id,
    monto: m.monto,
    saldo: saldos.get(m._id) ?? m.monto,
    fecha: m.fecha,
    fecha_vencimiento: m.fecha_vencimiento,
    concepto: m.concepto || '',
  })));
}));

// Adjunta el tipo de comprobante de origen ('factura' | 'remito' | null) a cada
// ítem de caja enlazado a un movimiento. Es un campo DERIVADO de solo lectura: el
// dato vive en Movimiento.documento y la Caja lo muestra como badge. Los ítems
// manuales (movimiento_id null) quedan con documento null.
async function attachDocumento(movs) {
  const ids = [...new Set(movs.map(m => m.movimiento_id).filter(id => id != null))];
  if (ids.length === 0) return movs.map(m => ({ ...m, documento: null }));
  const facturas = await Movimiento.find({ _id: { $in: ids } }, { documento: 1 }).lean();
  const docMap = new Map(facturas.map(f => [f._id, f.documento || null]));
  return movs.map(m => ({ ...m, documento: docMap.get(m.movimiento_id) ?? null }));
}

// GET /api/caja/descuentos?desde=&hasta=&subrubro_id=
// Seguimiento de descuentos por pago aplicados en un rango. Alimenta el card del
// dashboard, el historial del subrubro y el filtro del historial de caja.
// Devuelve el detalle y los totales ya agregados (total descontado, cantidad de
// pagos y desglose por subrubro) para no recalcularlos en cada consumidor.
router.get('/descuentos', asyncHandler(async (req, res) => {
  const { desde, hasta, subrubro_id } = req.query;
  const filter = { descuento: { $gt: 0 } };
  if (desde) filter.fecha = { ...filter.fecha, $gte: desde };
  if (hasta) filter.fecha = { ...filter.fecha, $lte: hasta };
  if (subrubro_id) filter.subrubro_id = Number(subrubro_id);

  const items = await CajaMovimiento.find(filter).sort({ fecha: -1, _id: -1 }).lean();

  const subIds = [...new Set(items.map(i => i.subrubro_id).filter(id => id != null))];
  const subs = subIds.length ? await Subrubro.find({ _id: { $in: subIds } }, { nombre: 1 }).lean() : [];
  const nombreSub = new Map(subs.map(s => [s._id, s.nombre]));

  const porSubrubro = new Map();
  for (const i of items) {
    const k = i.subrubro_id ?? 0;
    const acc = porSubrubro.get(k) || { subrubro_id: i.subrubro_id ?? null, nombre: nombreSub.get(i.subrubro_id) || 'Sin subrubro', total: 0, count: 0 };
    acc.total += i.descuento || 0;
    acc.count += 1;
    porSubrubro.set(k, acc);
  }

  res.json({
    total: items.reduce((s, i) => s + (i.descuento || 0), 0),
    count: items.length,
    // Base bruta sobre la que se descontó — permite mostrar el % efectivo del período.
    total_bruto: items.reduce((s, i) => s + (Number(i.monto_bruto ?? i.monto) || 0), 0),
    por_subrubro: [...porSubrubro.values()].sort((a, b) => b.total - a.total),
    items: withIds(items).map(i => ({
      ...i,
      subrubro_nombre: nombreSub.get(i.subrubro_id) || null,
    })),
  });
}));

// GET /api/caja?fecha=YYYY-MM-DD
// Incluye vencimientos sincronizados de días anteriores que aún no fueron
// pagados ni confirmados — siguen pendientes hasta abonarse.
router.get('/', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
  const movs = await CajaMovimiento.find({
    $or: [
      { fecha },
      {
        fecha: { $lt: fecha },
        // gasto = factura por pagar · ingreso_extra = deuda por cobrar: ambos se
        // arrastran hacia adelante mientras sigan sin confirmar.
        tipo: { $in: ['gasto', 'ingreso_extra'] },
        confirmado: false,
        movimiento_id: { $ne: null },
      },
    ],
  }).sort({ fecha: 1, _id: 1 }).lean();
  res.json(await attachDocumento(withIds(movs)));
}));

// GET /api/caja/rango?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&page=&limit=
router.get('/rango', asyncHandler(async (req, res) => {
  const { desde, hasta } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = req.query.limit ? Math.min(2000, Math.max(1, Number(req.query.limit))) : null;

  const filter = {};
  if (desde) filter.fecha = { ...filter.fecha, $gte: desde };
  if (hasta) filter.fecha = { ...filter.fecha, $lte: hasta };

  let q = CajaMovimiento.find(filter).sort({ fecha: 1, _id: 1 });
  if (limit) q = q.skip((page - 1) * limit).limit(limit);
  const movs = await q.lean();

  if (limit) {
    const total = await CajaMovimiento.countDocuments(filter);
    return res.json({ items: withIds(movs), total, page, limit });
  }
  res.json(withIds(movs));
}));

// POST /api/caja
router.post('/', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const { fecha, tipo, concepto, monto, metodo, subrubro_id, es_especial, movimiento_id, confirmado, idempotency_key } = req.body;
  if (!fecha || !tipo || !concepto || !monto) return res.status(400).json({ error: 'Faltan campos' });
  // Guarda de idempotencia: una misma alta reintentada (doble clic / reenvío)
  // devuelve la entrada ya creada en lugar de duplicarla.
  if (idempotency_key) {
    const existente = await CajaMovimiento.findOne({ idempotency_key: String(idempotency_key) }).lean();
    if (existente) {
      logger.warn({ idempotency_key, caja_id: existente._id }, 'Alta de caja duplicada evitada (idempotency_key)');
      return res.json(withId(existente));
    }
  }
  const id = await Counter.next('caja');
  const confirmar = tipo === 'gasto'
    ? (confirmado !== undefined ? confirmado : false)
    : null;
  try {
    const mov = await CajaMovimiento.create({
      _id: id, fecha, tipo, concepto,
      monto: Number(monto),
      // Sólo aplica default si el cliente no mandó el campo; null explícito significa "sin definir".
      metodo: metodo === undefined ? 'efectivo' : metodo,
      subrubro_id: subrubro_id || null,
      movimiento_id: movimiento_id || null,
      confirmado: confirmar,
      es_especial: !!es_especial,
      idempotency_key: idempotency_key ? String(idempotency_key) : null,
      created_at: now(),
    });
    res.json(withId(mov.toObject()));
  } catch (err) {
    // Backstop de carrera ante el índice único.
    if (err.code === 11000 && idempotency_key) {
      const existente = await CajaMovimiento.findOne({ idempotency_key: String(idempotency_key) }).lean();
      if (existente) {
        logger.warn({ idempotency_key, caja_id: existente._id }, 'Alta de caja duplicada evitada por índice único (carrera)');
        return res.json(withId(existente));
      }
    }
    throw err;
  }
}));

// POST /api/caja/:id/confirmar   body: { descuento?: number, fecha?: 'YYYY-MM-DD' }
//
// Confirma un ítem de Caja como pagado/cobrado en UNA sola operación del servidor:
// registra el pago (o abono) en el subrubro de origen y, si se aplicó un descuento
// por pago, genera además la Nota de Crédito que lo respalda. Antes esto lo
// orquestaba el frontend con dos llamadas sueltas; centralizarlo acá es lo que
// permite que el pago y su NC no puedan quedar desparejos, y que la auditoría
// registre la operación completa (incluido quién descontó y cuánto).
//
// Semántica del descuento: el ítem de Caja pasa a valer el NETO efectivamente
// pagado (lo que sale de la caja), y el descuento se refleja en el subrubro como
// una NC vinculada a la factura. Saldo factura = monto − pago neto − NC = 0.
router.post('/:id/confirmar', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const item = await CajaMovimiento.findById(id).lean();
  if (!item) return res.status(404).json({ error: 'Movimiento de caja no encontrado' });
  if (item.confirmado === true) return res.status(409).json({ error: 'El movimiento ya está confirmado' });
  if (!item.metodo) return res.status(400).json({ error: 'Definí el método de pago antes de confirmar' });

  const fecha = req.body.fecha || item.fecha;
  // El bruto es el monto que la Caja muestra hoy; si por un reintento el ítem ya
  // tuviera monto_bruto, ese manda (no se descuenta dos veces sobre el neto).
  const bruto = Number(item.monto_bruto ?? item.monto) || 0;

  const sub = item.subrubro_id ? await Subrubro.findById(Number(item.subrubro_id)).lean() : null;

  // El descuento se puede cargar como monto fijo o como porcentaje. El % se resuelve
  // a pesos ACÁ (no en el cliente) para que el importe que termina en la NC sea el que
  // el servidor calculó, con un único criterio de redondeo a centavos.
  const pct = req.body.descuento_pct != null && req.body.descuento_pct !== ''
    ? Number(req.body.descuento_pct)
    : null;
  if (pct != null && (!Number.isFinite(pct) || pct <= 0 || pct >= 100)) {
    return res.status(400).json({ error: 'El porcentaje de descuento debe estar entre 0 y 100' });
  }
  const descuento = pct != null
    ? Math.round(bruto * (pct / 100) * 100) / 100
    : Number(req.body.descuento) || 0;

  if (descuento) {
    if (!sub?.aplica_descuento) return res.status(400).json({ error: 'El subrubro no admite descuentos por pago' });
    if (!item.movimiento_id)   return res.status(400).json({ error: 'Solo se puede descontar sobre un pago vinculado a una factura' });
    if (descuento < 0)         return res.status(400).json({ error: 'El descuento no puede ser negativo' });
    if (descuento >= bruto)    return res.status(400).json({ error: 'El descuento no puede ser mayor o igual al monto de la factura' });
  }
  const neto = bruto - descuento;

  const esCobro = item.tipo === 'ingreso_extra';
  let pagoId = null;
  let ncId = null;

  if (item.subrubro_id) {
    // NC primero: si fallara, todavía no se registró el pago y el ítem queda sin
    // confirmar, en un estado reintentable. Al revés dejaría un pago sin su NC.
    if (descuento) {
      const nc = await db.createMovimiento(item.subrubro_id, {
        tipo: 'nota_credito',
        pago: descuento,
        fecha,
        concepto: `Descuento por pago${pct != null ? ` (${pct}%)` : ''}: ${item.concepto}`,
        facturas_vinculadas_ids: [Number(item.movimiento_id)],
        caja_mov_id: id,
        // Determinística: una entrada de caja genera como mucho UNA NC de descuento.
        idempotency_key: `caja-descuento-${id}`,
      });
      ncId = nc?.id ?? null;
    }
    const pago = await db.createMovimiento(item.subrubro_id, {
      tipo: 'pago',
      pago: neto,
      fecha,
      concepto: `${esCobro ? 'Abono caja' : 'Pago caja'}: ${item.concepto}`,
      metodo_pago: item.metodo,
      caja_mov_id: id,
      facturas_vinculadas_ids: item.movimiento_id ? [Number(item.movimiento_id)] : [],
      idempotency_key: `caja-confirm-${id}`,
    });
    pagoId = pago?.id ?? null;
  }

  await CajaMovimiento.findByIdAndUpdate(id, {
    $set: {
      confirmado: true,
      fecha,
      monto: neto,
      descuento,
      descuento_pct: descuento ? pct : null,
      monto_bruto: descuento ? bruto : null,
      pago_mov_id: pagoId,
      nc_mov_id: ncId,
    },
  });

  // Enriquece el diff de auditoría: deja explícito el descuento aplicado y la NC
  // generada, que es información que no se deduce del body de la request.
  res.json({ ok: true, id, monto: neto, monto_bruto: bruto, descuento, descuento_pct: pct, pago_mov_id: pagoId, nc_mov_id: ncId });
}));

// POST /api/caja/:id/revertir
// Deshace una confirmación: borra el pago y la NC de descuento generados en el
// subrubro y devuelve el ítem de Caja a su monto bruto, sin descuento.
router.post('/:id/revertir', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const item = await CajaMovimiento.findById(id).lean();
  if (!item) return res.status(404).json({ error: 'Movimiento de caja no encontrado' });

  // Borrar el pago y la NC es lo que libera sus idempotency_key, de modo que el
  // ítem pueda volver a confirmarse después.
  for (const movId of [item.pago_mov_id, item.nc_mov_id]) {
    if (movId != null) {
      try { await db.deleteMovimiento(movId); }
      catch (e) { logger.warn({ err: e, movimiento_id: movId, caja_id: id }, 'No se pudo borrar el movimiento al revertir la confirmación'); }
    }
  }

  await CajaMovimiento.findByIdAndUpdate(id, {
    $set: {
      confirmado: false,
      monto: Number(item.monto_bruto ?? item.monto) || 0,
      descuento: 0,
      descuento_pct: null,
      monto_bruto: null,
      pago_mov_id: null,
      nc_mov_id: null,
    },
  });
  res.json({ ok: true, id });
}));

// PUT /api/caja/:id
router.put('/:id', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const { fecha, tipo, concepto, monto, metodo, subrubro_id, es_especial, confirmado, pago_mov_id } = req.body;
  const upd = {};
  if (fecha !== undefined) upd.fecha = fecha;
  if (tipo !== undefined) upd.tipo = tipo;
  if (concepto !== undefined) upd.concepto = concepto;
  if (monto !== undefined) upd.monto = Number(monto);
  if (metodo !== undefined) upd.metodo = metodo;
  if (subrubro_id !== undefined) upd.subrubro_id = subrubro_id;
  if (es_especial !== undefined) upd.es_especial = !!es_especial;
  if (confirmado !== undefined) upd.confirmado = confirmado;
  if (pago_mov_id !== undefined) upd.pago_mov_id = pago_mov_id !== null ? Number(pago_mov_id) : null;
  await CajaMovimiento.findByIdAndUpdate(Number(req.params.id), upd);
  // Sync inverso del método (Caja → subrubro): si se cambió el método de un ítem
  // pendiente que representa una factura por vencer, se escribe también en la factura
  // para que ambos lados queden consistentes. No toca remitos (siempre efectivo) ni
  // ítems ya confirmados.
  if (metodo !== undefined) {
    const item = await CajaMovimiento.findById(Number(req.params.id)).lean();
    if (item?.movimiento_id && item.confirmado === false) {
      const fac = await Movimiento.findById(Number(item.movimiento_id));
      if (fac && fac.tipo === 'factura' && fac.documento !== 'remito' && (fac.metodo_pago || null) !== (metodo || null)) {
        fac.metodo_pago = metodo || null;
        await fac.save();
      }
    }
  }
  res.json({ ok: true });
}));

// DELETE /api/caja/:id?fecha=YYYY-MM-DD
router.delete('/:id', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const item = await CajaMovimiento.findById(Number(req.params.id)).lean();
  // Sólo los pendientes auto-generados (movimiento_id + no confirmados) dejan
  // "memoria" de descarte: si el usuario borra el vencimiento hoy, no debe volver a
  // recrearse hoy vía auto-sync. Se registra contra la fecha VISTA en la Caja (no la
  // del ítem, que vive en fecha_vencimiento y el GET arrastra hacia adelante).
  if (item?.movimiento_id && item.confirmado === false) {
    const fecha = req.query.fecha || item.fecha;
    await CajaDescarte.updateOne(
      { movimiento_id: item.movimiento_id, fecha },
      { $setOnInsert: { movimiento_id: item.movimiento_id, fecha, created_at: now() } },
      { upsert: true }
    );
  }
  await CajaMovimiento.findByIdAndDelete(Number(req.params.id));
  res.json({ ok: true });
}));

module.exports = router;
