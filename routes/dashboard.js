const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { Movimiento, Subrubro } = require('../models');

// Mes actual en formato YYYY-MM
function mesActual() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Resumen general: totales del mes actual + deuda acumulada total
router.get('/resumen', asyncHandler(async (req, res) => {
  const mes = mesActual();

  const [mesData, totalData] = await Promise.all([
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
    // Deuda total acumulada (toda la historia)
    Movimiento.aggregate([
      {
        $group: {
          _id: null,
          totalFacturado: { $sum: { $cond: [{ $eq: ['$tipo', 'factura'] }, '$monto', 0] } },
          totalPagado: { $sum: '$pago' },
        }
      }
    ]),
  ]);

  const { facturadoMes = 0, pagadoMes = 0 } = mesData[0] || {};
  const { totalFacturado = 0, totalPagado = 0 } = totalData[0] || {};

  res.json({
    mes,
    facturadoMes,
    pagadoMes,
    diferenciaMes: facturadoMes - pagadoMes,
    deudaTotal: totalFacturado - totalPagado,
  });
}));

// Tendencia mensual de un rubro específico (últimos N meses)
router.get('/tendencia/:rubroId', asyncHandler(async (req, res) => {
  const rubroId = Number(req.params.rubroId);
  const meses = Math.min(Number(req.query.meses) || 6, 24);

  const subs = await Subrubro.find({ rubro_id: rubroId }, { _id: 1 }).lean();
  const subIds = subs.map(s => s._id);

  if (subIds.length === 0) return res.json({ tendencia: [] });

  const tendencia = await Movimiento.aggregate([
    {
      $match: {
        subrubro_id: { $in: subIds },
        fecha: { $exists: true, $type: 'string', $ne: '' },
      }
    },
    {
      $group: {
        _id: { $substr: ['$fecha', 0, 7] },
        facturado: { $sum: { $cond: [{ $eq: ['$tipo', 'factura'] }, '$monto', 0] } },
        pagado: { $sum: '$pago' },
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        mes: '$_id',
        facturado: 1,
        pagado: 1,
        diferencia: { $subtract: ['$facturado', '$pagado'] },
      }
    }
  ]).then(data => data.slice(-meses));

  res.json({ tendencia });
}));

// Tendencia mensual de un subrubro específico (últimos N meses)
router.get('/tendencia-subrubro/:subrubroId', asyncHandler(async (req, res) => {
  const subrubroId = Number(req.params.subrubroId);
  const meses = Math.min(Number(req.query.meses) || 6, 24);

  const tendencia = await Movimiento.aggregate([
    {
      $match: {
        subrubro_id: subrubroId,
        fecha: { $exists: true, $type: 'string', $ne: '' },
      }
    },
    {
      $group: {
        _id: { $substr: ['$fecha', 0, 7] },
        facturado: { $sum: { $cond: [{ $eq: ['$tipo', 'factura'] }, '$monto', 0] } },
        pagado: { $sum: '$pago' },
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        mes: '$_id',
        facturado: 1,
        pagado: 1,
        diferencia: { $subtract: ['$facturado', '$pagado'] },
      }
    }
  ]).then(data => data.slice(-meses));

  res.json({ tendencia });
}));

module.exports = router;
