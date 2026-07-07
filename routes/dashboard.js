const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { Movimiento, Subrubro, CajaMovimiento } = require('../models');
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

const p2 = (n) => String(n).padStart(2, '0');

// Suma facturado/pagado/deuda en un rango de fechas inclusivo [desde, hasta] (YYYY-MM-DD).
// La comparación de strings ISO equivale a la comparación cronológica.
async function aggRango(desde, hasta) {
  const r = await Movimiento.aggregate([
    { $match: { fecha: { $gte: desde, $lte: hasta } } },
    {
      $group: {
        _id: null,
        facturado: { $sum: { $cond: [{ $eq: ['$tipo', 'factura'] }, '$monto', 0] } },
        pagado: { $sum: '$pago' },
      }
    }
  ]);
  const { facturado = 0, pagado = 0 } = r[0] || {};
  return { facturado, pagado, deuda: facturado - pagado };
}

// Comparativas de dashboard: quincena (días 1-15) y mes a la fecha vs mes anterior.
// Alimenta las alertas del dashboard (S3).
router.get('/comparativa', asyncHandler(async (req, res) => {
  const now = new Date();
  const cy = now.getFullYear();
  const cm = now.getMonth() + 1;          // 1-12
  const dd = now.getDate();               // día del mes actual

  // Mes anterior
  const pm = cm === 1 ? 12 : cm - 1;
  const py = cm === 1 ? cy - 1 : cy;

  const diasEnMesActual = new Date(cy, cm, 0).getDate();
  const diasEnMesAnterior = new Date(py, pm, 0).getDate();

  const cMes = `${cy}-${p2(cm)}`;
  const pMes = `${py}-${p2(pm)}`;
  const hoy = `${cMes}-${p2(dd)}`;

  // Quincena: días 01-15 de cada mes
  const [qActual, qAnterior] = await Promise.all([
    aggRango(`${cMes}-01`, `${cMes}-15`),
    aggRango(`${pMes}-01`, `${pMes}-15`),
  ]);

  // Mes a la fecha (01..hoy) vs mes anterior completo, y mes anterior al mismo día (ritmo justo)
  const diaEquivAnterior = Math.min(dd, diasEnMesAnterior);
  const [mActual, mAnteriorFull, mAnteriorMismoDia] = await Promise.all([
    aggRango(`${cMes}-01`, hoy),
    aggRango(`${pMes}-01`, `${pMes}-${p2(diasEnMesAnterior)}`),
    aggRango(`${pMes}-01`, `${pMes}-${p2(diaEquivAnterior)}`),
  ]);

  // Proyección lineal del mes actual completo según el ritmo hasta hoy
  const factor = dd > 0 ? diasEnMesActual / dd : 1;
  const proyeccion = {
    facturado: Math.round(mActual.facturado * factor),
    pagado: Math.round(mActual.pagado * factor),
    deuda: Math.round(mActual.deuda * factor),
  };

  res.json({
    meta: { mesActual: cMes, mesAnterior: pMes, hoy, diaActual: dd, diasEnMesActual, diasEnMesAnterior },
    quincena: { actual: qActual, anterior: qAnterior },
    mes: { actual: mActual, anterior: mAnteriorFull, anteriorMismoDia: mAnteriorMismoDia, proyeccion },
  });
}));

// Suma ingresos/egresos/neto de caja en un rango de fechas inclusivo.
async function resumenCajaRango(desde, hasta) {
  const movs = await CajaMovimiento.find({ fecha: { $gte: desde, $lte: hasta } }).lean();
  let ingresos = 0, egresos = 0;
  for (const m of movs) {
    const monto = m.monto || 0;
    if (m.tipo === 'gasto') egresos += monto;
    else if (m.tipo === 'ingreso_extra' || m.tipo === 'empleado') ingresos += monto;
  }
  return { ingresos, egresos, neto: ingresos - egresos };
}

// Igual que /comparativa pero con métricas de caja (ingresos/egresos/neto).
router.get('/comparativa-caja', asyncHandler(async (req, res) => {
  const now = new Date();
  const cy = now.getFullYear();
  const cm = now.getMonth() + 1;
  const dd = now.getDate();
  const pm = cm === 1 ? 12 : cm - 1;
  const py = cm === 1 ? cy - 1 : cy;

  const diasEnMesActual = new Date(cy, cm, 0).getDate();
  const diasEnMesAnterior = new Date(py, pm, 0).getDate();
  const cMes = `${cy}-${p2(cm)}`;
  const pMes = `${py}-${p2(pm)}`;
  const hoy = `${cMes}-${p2(dd)}`;

  const [qActual, qAnterior, mActual, mAnteriorFull] = await Promise.all([
    resumenCajaRango(`${cMes}-01`, `${cMes}-15`),
    resumenCajaRango(`${pMes}-01`, `${pMes}-15`),
    resumenCajaRango(`${cMes}-01`, hoy),
    resumenCajaRango(`${pMes}-01`, `${pMes}-${p2(diasEnMesAnterior)}`),
  ]);

  const factor = dd > 0 ? diasEnMesActual / dd : 1;
  const proyeccion = {
    ingresos: Math.round(mActual.ingresos * factor),
    egresos: Math.round(mActual.egresos * factor),
    neto: Math.round(mActual.neto * factor),
  };

  res.json({
    meta: { mesActual: cMes, mesAnterior: pMes, hoy, diaActual: dd, diasEnMesActual, diasEnMesAnterior },
    quincena: { actual: qActual, anterior: qAnterior },
    mes: { actual: mActual, anterior: mAnteriorFull, proyeccion },
  });
}));

module.exports = router;
