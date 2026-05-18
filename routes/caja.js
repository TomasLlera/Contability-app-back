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
  res.json(cfg || { empleados: [], proveedores: [], rubros_sync: [], dias_anticipacion_caja: 3, retencion_debito: 0, retencion_credito: 0, retencion_prepagas: 0 });
}));

// PUT /api/caja/config
router.put('/config', requireAdmin, audit('caja_config'), asyncHandler(async (req, res) => {
  const { empleados, proveedores, rubros_sync, dias_anticipacion_caja, retencion_debito, retencion_credito, retencion_prepagas } = req.body;
  const upd = { empleados, proveedores };
  if (rubros_sync !== undefined) upd.rubros_sync = rubros_sync;
  if (dias_anticipacion_caja !== undefined) upd.dias_anticipacion_caja = Number(dias_anticipacion_caja);
  if (retencion_debito  !== undefined) upd.retencion_debito  = Number(retencion_debito);
  if (retencion_credito !== undefined) upd.retencion_credito = Number(retencion_credito);
  if (retencion_prepagas !== undefined) upd.retencion_prepagas = Number(retencion_prepagas);
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

// GET /api/caja/pendientes?hasta=YYYY-MM-DD
router.get('/pendientes', asyncHandler(async (req, res) => {
  const { hasta } = req.query;
  if (!hasta) return res.status(400).json({ error: 'hasta requerida' });
  const movs = await CajaMovimiento.find({
    tipo: 'gasto',
    confirmado: false,
    fecha: { $lt: hasta },
  }).sort({ fecha: 1, _id: 1 }).lean();
  res.json(withIds(movs));
}));

// GET /api/caja?fecha=YYYY-MM-DD
router.get('/', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
  const movs = await CajaMovimiento.find({ fecha }).sort({ _id: 1 }).lean();
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
    monto: Number(monto), metodo: metodo || 'efectivo',
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
