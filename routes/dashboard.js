const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { Movimiento, Subrubro } = require('../models');
const db = require('../db');

// Mes actual en formato YYYY-MM
function mesActual() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Resumen general: totales del mes actual + deuda acumulada total
router.get('/resumen', asyncHandler(async (req, res) => {
  const mes = mesActual();

  const [mesData, deudaTotal] = await Promise.all([
    // Facturado y pagado del mes actual (todos los rubros)
    Movimiento.aggregate([
      { $match: { fecha: { $regex: `^${mes}` } } },
      {
        $group: {
          _id: null,
          facturadoMes: { $sum: { $cond: [{ $eq: ['$tipo', 'factura'] }, '$monto', 0] } },
          pagadoMes: { $sum: '$pago' },
        }
      }
    ]),
    // Deuda = suma de saldos pendientes de todas las facturas (toda la historia)
    db.getDeudaTotal(),
  ]);

  const { facturadoMes = 0, pagadoMes = 0 } = mesData[0] || {};

  res.json({
    mes,
    facturadoMes,
    pagadoMes,
    diferenciaMes: facturadoMes - pagadoMes,
    deudaTotal,
  });
}));

// Tendencia mensual de un rubro específico (últimos N meses)
router.get('/tendencia/:rubroId', asyncHandler(async (req, res) => {
  const rubroId = Number(req.params.rubroId);
  const meses = Math.min(Number(req.query.meses) || 6, 24);

  const subs = await Subrubro.find({ rubro_id: rubroId }, { _id: 1 }).lean();
  const subIds = subs.map(s => s._id);

  if (subIds.length === 0) return res.json({ tendencia: [] });

  res.json({ tendencia: await db.getTendenciaDeuda(subIds, meses) });
}));

// Tendencia mensual de un subrubro específico (últimos N meses)
router.get('/tendencia-subrubro/:subrubroId', asyncHandler(async (req, res) => {
  const subrubroId = Number(req.params.subrubroId);
  const meses = Math.min(Number(req.query.meses) || 6, 24);

  res.json({ tendencia: await db.getTendenciaDeuda([subrubroId], meses) });
}));

// Comparación acumulada de todos los subrubros de un rubro
router.get('/comparacion/:rubroId', asyncHandler(async (req, res) => {
  const comparacion = await db.getComparacionSubrubros(req.params.rubroId);
  res.json({ comparacion });
}));

module.exports = router;
