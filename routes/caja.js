const express = require('express');
const router = express.Router();
const { CajaMovimiento, CajaConfig, Counter } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');

const now = () => new Date().toISOString();

function withId(doc) {
  if (!doc) return null;
  const o = doc._id !== undefined ? doc : doc.toObject?.() ?? doc;
  return { ...o, id: o._id };
}
function withIds(docs) { return docs.map(withId); }

// GET /api/caja/config  (antes de /:id para que no colisione)
router.get('/config', async (req, res) => {
  try {
    const cfg = await CajaConfig.findById('main').lean();
    res.json(cfg || { empleados: [], proveedores: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/caja/config
router.put('/config', requireAdmin, async (req, res) => {
  try {
    const { empleados, proveedores } = req.body;
    await CajaConfig.findByIdAndUpdate(
      'main',
      { $set: { empleados, proveedores } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/caja?fecha=YYYY-MM-DD
router.get('/', async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
    const movs = await CajaMovimiento.find({ fecha }).sort({ _id: 1 }).lean();
    res.json(withIds(movs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/caja/rango?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/rango', async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const filter = {};
    if (desde) filter.fecha = { ...filter.fecha, $gte: desde };
    if (hasta) filter.fecha = { ...filter.fecha, $lte: hasta };
    const movs = await CajaMovimiento.find(filter).sort({ fecha: 1, _id: 1 }).lean();
    res.json(withIds(movs));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/caja
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { fecha, tipo, concepto, monto, metodo, subrubro_id, es_especial } = req.body;
    if (!fecha || !tipo || !concepto || !monto) return res.status(400).json({ error: 'Faltan campos' });
    const id = await Counter.next('caja');
    const mov = await CajaMovimiento.create({
      _id: id, fecha, tipo, concepto,
      monto: Number(monto), metodo: metodo || 'efectivo',
      subrubro_id: subrubro_id || null,
      es_especial: !!es_especial,
      created_at: now(),
    });
    res.json(withId(mov.toObject()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/caja/:id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { fecha, tipo, concepto, monto, metodo, subrubro_id, es_especial } = req.body;
    const upd = {};
    if (fecha !== undefined) upd.fecha = fecha;
    if (tipo !== undefined) upd.tipo = tipo;
    if (concepto !== undefined) upd.concepto = concepto;
    if (monto !== undefined) upd.monto = Number(monto);
    if (metodo !== undefined) upd.metodo = metodo;
    if (subrubro_id !== undefined) upd.subrubro_id = subrubro_id;
    if (es_especial !== undefined) upd.es_especial = !!es_especial;
    await CajaMovimiento.findByIdAndUpdate(Number(req.params.id), upd);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/caja/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await CajaMovimiento.findByIdAndDelete(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
