const express = require('express');
const router = express.Router();
const { CajaMovimiento, CajaDescarte, CajaConfig, Counter, Subrubro, Movimiento } = require('../models');
const { computeSaldosFacturas } = require('../db');
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

  const subrubros = await Subrubro.find({ rubro_id: { $in: rubros_sync } }).lean();
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
  const autoItems = await CajaMovimiento.find({
    confirmado: false,
    movimiento_id: { $ne: null },
    $or: [{ auto_sync: true }, { metodo: null }],
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

  const subrubros = await Subrubro.find({ rubro_id: { $in: rubros_sync } }).lean();
  if (subrubros.length === 0) return res.json({ creados: 0 });

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
            tipo: 'gasto',
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
        tipo: 'gasto',
        confirmado: false,
        movimiento_id: { $ne: null },
      },
    ],
  }).sort({ fecha: 1, _id: 1 }).lean();
  res.json(withIds(movs));
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
