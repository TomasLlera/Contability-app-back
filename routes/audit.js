const express = require('express');
const router = express.Router();
const { Audit } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const { asyncHandler } = require('../middleware/errorHandler');

// GET /api/audit?recurso=&recurso_id=&usuario=&desde=&hasta=&page=1&limit=50
router.get('/', requireAdmin, asyncHandler(async (req, res) => {
  const { recurso, recurso_id, usuario, desde, hasta } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  const filter = {};
  if (recurso) filter.recurso = recurso;
  if (recurso_id !== undefined && recurso_id !== '') filter.recurso_id = isNaN(Number(recurso_id)) ? recurso_id : Number(recurso_id);
  if (usuario) filter.usuario = usuario;
  if (desde || hasta) {
    filter.fecha = {};
    if (desde) filter.fecha.$gte = desde;
    if (hasta) filter.fecha.$lte = hasta;
  }

  const [items, total] = await Promise.all([
    Audit.find(filter).sort({ fecha: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Audit.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
}));

// GET /api/audit/:id — detalle completo de un registro (incluye diff before/after)
router.get('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const item = await Audit.findById(req.params.id).lean();
  if (!item) return res.status(404).json({ error: 'Registro de auditoría no encontrado' });
  res.json(item);
}));

module.exports = router;
