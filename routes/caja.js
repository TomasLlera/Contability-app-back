const express = require('express');
const router = express.Router();
const { CajaMovimiento, CajaConfig, Counter, Subrubro, Movimiento } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');
const { asyncHandler } = require('../middleware/errorHandler');

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

  const movimientos = await Movimiento.find({
    subrubro_id: { $in: subrubroIds },
    tipo: 'factura',
    pagado: false,
    fecha_vencimiento: { $gte: fecha, $lte: hasta },
  }).sort({ fecha_vencimiento: 1 }).lean();

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
        monto: m.monto,
        fecha_vencimiento: m.fecha_vencimiento,
        concepto: m.concepto || '',
      }))
  );
}));

// POST /api/caja/auto-sync?fecha=YYYY-MM-DD
// Idempotente: crea CajaMovimiento (tipo='gasto', confirmado=false, metodo=null)
// por cada factura que vence el día indicado en alguno de los rubros sincronizados,
// siempre que no exista ya un caja item para ese movimiento_id en esa fecha.
router.post('/auto-sync', requireAdmin, asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });

  const cfg = await CajaConfig.findById('main').lean();
  const rubros_sync = cfg?.rubros_sync || [];
  if (rubros_sync.length === 0) return res.json({ creados: 0 });

  const dias = cfg?.dias_anticipacion_caja ?? 3;
  const hasta = addDaysToStr(fecha, dias);

  const subrubros = await Subrubro.find({ rubro_id: { $in: rubros_sync } }).lean();
  if (subrubros.length === 0) return res.json({ creados: 0 });

  const subIds = subrubros.map(s => s._id);
  const subMap = Object.fromEntries(subrubros.map(s => [s._id, s]));

  // Incluye también vencidas (fecha_vencimiento <= hasta): si una factura venció
  // hace 5 días y no se pagó, queremos verla hoy en caja, no perderla.
  const vencimientos = await Movimiento.find({
    subrubro_id: { $in: subIds },
    tipo: 'factura',
    pagado: false,
    fecha_vencimiento: { $ne: null, $lte: hasta },
  }).sort({ fecha_vencimiento: 1 }).lean();

  if (vencimientos.length === 0) return res.json({ creados: 0 });

  // Dedupe global: si ya existe un caja item (en cualquier fecha) para ese
  // movimiento_id, no crear otro. Sino, una factura vencida no pagada generaría
  // un caja item nuevo cada día que el usuario abra la caja.
  const yaCreados = await CajaMovimiento.find({
    movimiento_id: { $in: vencimientos.map(v => v._id) },
  }, { movimiento_id: 1 }).lean();
  const yaSet = new Set(yaCreados.map(c => c.movimiento_id));

  const pendientes = vencimientos.filter(v => !yaSet.has(v._id));
  if (pendientes.length === 0) return res.json({ creados: 0 });

  // Reservar IDs en bloque
  const startId = await Counter.nextBatch
    ? await Counter.nextBatch('caja', pendientes.length)
    : null;

  const docs = pendientes.map((v, i) => {
    const sub = subMap[v.subrubro_id];
    const baseConcepto = sub?.nombre || 'Vencimiento';
    const concepto = v.concepto ? `${baseConcepto} — ${v.concepto}` : baseConcepto;
    return {
      _id: startId != null ? startId + i : undefined,
      // El caja item vive en la fecha de vencimiento. Si no se paga, el GET
      // lo arrastra hacia adelante mediante el lookback de fechas anteriores.
      fecha: v.fecha_vencimiento,
      tipo: 'gasto',
      concepto,
      monto: Number(v.monto) || 0,
      metodo: null,
      subrubro_id: v.subrubro_id,
      movimiento_id: v._id,
      confirmado: false,
      es_especial: false,
      created_at: now(),
    };
  });

  // Fallback: si nextBatch no estuviera disponible, generar IDs uno por uno.
  if (startId == null) {
    for (const d of docs) d._id = await Counter.next('caja');
  }

  await CajaMovimiento.insertMany(docs);
  res.json({ creados: docs.length });
}));

// GET /api/caja/facturas-pendientes?subrubro_id=X
router.get('/facturas-pendientes', asyncHandler(async (req, res) => {
  const { subrubro_id } = req.query;
  if (!subrubro_id) return res.status(400).json({ error: 'subrubro_id requerido' });

  const movimientos = await Movimiento.find({
    subrubro_id: Number(subrubro_id),
    tipo: 'factura',
    pagado: false,
  }).sort({ fecha: 1 }).lean();

  res.json(movimientos.map(m => ({
    id: m._id,
    monto: m.monto,
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
  const { fecha, tipo, concepto, monto, metodo, subrubro_id, es_especial, movimiento_id, confirmado } = req.body;
  if (!fecha || !tipo || !concepto || !monto) return res.status(400).json({ error: 'Faltan campos' });
  const id = await Counter.next('caja');
  const confirmar = tipo === 'gasto'
    ? (confirmado !== undefined ? confirmado : false)
    : null;
  const mov = await CajaMovimiento.create({
    _id: id, fecha, tipo, concepto,
    monto: Number(monto),
    // Sólo aplica default si el cliente no mandó el campo; null explícito significa "sin definir".
    metodo: metodo === undefined ? 'efectivo' : metodo,
    subrubro_id: subrubro_id || null,
    movimiento_id: movimiento_id || null,
    confirmado: confirmar,
    es_especial: !!es_especial,
    created_at: now(),
  });
  res.json(withId(mov.toObject()));
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
  res.json({ ok: true });
}));

// DELETE /api/caja/:id
router.delete('/:id', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  await CajaMovimiento.findByIdAndDelete(Number(req.params.id));
  res.json({ ok: true });
}));

module.exports = router;
