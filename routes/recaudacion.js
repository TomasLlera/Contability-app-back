const express = require('express');
const router = express.Router();
const { Recaudacion } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const { asyncHandler } = require('../middleware/errorHandler');

// GET /api/recaudacion?fecha=YYYY-MM-DD
router.get('/', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
  const rec = await Recaudacion.findById(fecha).lean();
  res.json(rec || { _id: fecha, qr: 0, debito: 0, credito: 0, prepagas: 0 });
}));

// GET /api/recaudacion/rango?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/rango', asyncHandler(async (req, res) => {
  const { desde, hasta } = req.query;
  const filter = {};
  if (desde) filter._id = { ...filter._id, $gte: desde };
  if (hasta) filter._id = { ...filter._id, $lte: hasta };
  const recs = await Recaudacion.find(filter).sort({ _id: 1 }).lean();
  res.json(recs);
}));

// PUT /api/recaudacion/:fecha
router.put('/:fecha', requireAdmin, asyncHandler(async (req, res) => {
  const { fecha } = req.params;
  const { qr = 0, debito = 0, credito = 0, prepagas = 0 } = req.body;
  await Recaudacion.findByIdAndUpdate(
    fecha,
    { qr: Number(qr), debito: Number(debito), credito: Number(credito), prepagas: Number(prepagas) },
    { upsert: true }
  );
  res.json({ ok: true });
}));

module.exports = router;
