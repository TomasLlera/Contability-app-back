const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');

// Subrubros de tipo 'sumatoria' (ver db.js, sección SUMATORIA). Las cargas con
// origen 'caja' mantienen su espejo en la Caja del Día desde la capa de datos, así
// que las rutas no tocan CajaMovimiento directamente.

// Lista CSV de la query ("1,2,3") → array; vacío → undefined (sin filtro).
const csv = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const arr = String(v).split(',').map(s => s.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
};
const csvNum = (v) => csv(v)?.map(Number).filter(Number.isFinite);

// Filtros comunes: mes (YYYY-MM) | desde/hasta, conceptos, origen ('todos' = sin filtro).
function filtrosDe(q) {
  return {
    mes: q.mes || undefined,
    desde: q.desde || undefined,
    hasta: q.hasta || undefined,
    conceptoIds: csvNum(q.conceptos),
    origen: q.origen && q.origen !== 'todos' ? q.origen : undefined,
  };
}

// --- Lista de subrubros sumatoria (menú lateral, filtros del resumen general) ---
router.get('/subrubros', asyncHandler(async (req, res) => {
  res.json(await db.getSubrubrosSumatoria());
}));

// --- Resumen general (todos los subrubros sumatoria) ---
// GET /api/sumatorias/resumen-general?mes|desde&hasta&subrubros=1,2&conceptos=retiro efectivo,...&origen=
router.get('/resumen-general', asyncHandler(async (req, res) => {
  const { mes, desde, hasta, origen } = filtrosDe(req.query);
  res.json(await db.getResumenGeneralSumatorias({
    mes, desde, hasta, origen,
    subrubroIds: csvNum(req.query.subrubros),
    conceptos: csv(req.query.conceptos),
  }));
}));

// --- Cargas por id ---
router.get('/movimientos/:id', asyncHandler(async (req, res) => {
  res.json(await db.getMovimientoSumatoria(req.params.id));
}));

router.put('/movimientos/:id', requireAdmin, audit('sumatoria_movimiento'), asyncHandler(async (req, res) => {
  res.json(await db.updateMovimientoSumatoria(req.params.id, req.body || {}, req.user?.usuario || null));
}));

router.delete('/movimientos/:id', requireAdmin, audit('sumatoria_movimiento'), asyncHandler(async (req, res) => {
  res.json(await db.deleteMovimientoSumatoria(req.params.id));
}));

// --- Conceptos por id ---
router.put('/conceptos/:id', requireAdmin, audit('sumatoria_concepto'), asyncHandler(async (req, res) => {
  res.json(await db.updateConceptoSumatoria(req.params.id, req.body || {}));
}));

// Con cargas → se desactiva (no se borra). La respuesta dice cuál de las dos pasó.
router.delete('/conceptos/:id', requireAdmin, audit('sumatoria_concepto'), asyncHandler(async (req, res) => {
  res.json(await db.deleteConceptoSumatoria(req.params.id));
}));

// --- Por subrubro ---
router.get('/:subrubroId/conceptos', asyncHandler(async (req, res) => {
  res.json(await db.getConceptosSumatoria(req.params.subrubroId));
}));

router.post('/:subrubroId/conceptos', requireAdmin, audit('sumatoria_concepto'), asyncHandler(async (req, res) => {
  res.json(await db.createConceptoSumatoria(req.params.subrubroId, req.body || {}));
}));

// PUT /api/sumatorias/:subrubroId/conceptos-orden  body: { ids: [3, 1, 2] }
router.put('/:subrubroId/conceptos-orden', requireAdmin, audit('sumatoria_concepto_orden'), asyncHandler(async (req, res) => {
  res.json(await db.reordenarConceptosSumatoria(req.params.subrubroId, req.body?.ids));
}));

router.get('/:subrubroId/movimientos', asyncHandler(async (req, res) => {
  res.json(await db.getMovimientosSumatoria(req.params.subrubroId, filtrosDe(req.query)));
}));

router.get('/:subrubroId/resumen', asyncHandler(async (req, res) => {
  res.json(await db.getResumenSumatoria(req.params.subrubroId, filtrosDe(req.query)));
}));

// body: { concepto_id, fecha, monto, descripcion?, origen: 'caja'|'subrubro', metodo?, idempotency_key? }
router.post('/:subrubroId/movimientos', requireAdmin, audit('sumatoria_movimiento'), asyncHandler(async (req, res) => {
  res.json(await db.createMovimientoSumatoria(req.params.subrubroId, req.body || {}, req.user?.usuario || null));
}));

module.exports = router;
