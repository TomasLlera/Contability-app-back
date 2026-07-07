const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const db = require('../db');
const { CajaMovimiento } = require('../models');
const {
  MONEDA, nombreMes, nuevoWorkbook, escribirTitulo, escribirHeader,
  agregarDataBar, colorearSigno, zebra, flechaTendencia, COLORS,
} = require('../utils/excelReport');

const mesActualStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const esMesValido = (m) => /^\d{4}-\d{2}$/.test(m || '');

async function enviarWorkbook(res, wb, filename) {
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
}

// GET /api/reportes/subrubros-mensual/:rubroId?mes=YYYY-MM&subrubroId=&orden=
// Excel de análisis mes-a-mes de subrubros (S1): saldo anterior/actual, diferencia,
// % cambio, tendencia, con barras de datos como gráfico de evolución.
router.get('/subrubros-mensual/:rubroId', asyncHandler(async (req, res) => {
  const mes = esMesValido(req.query.mes) ? req.query.mes : mesActualStr();
  const subrubroId = req.query.subrubroId ? Number(req.query.subrubroId) : null;
  const orden = req.query.orden || 'saldo';

  const rubro = await db.getRubro(req.params.rubroId);
  if (!rubro) return res.status(404).json({ error: 'Rubro no encontrado' });

  const { mesAnterior, subrubros } = await db.getSubrubrosMensual(req.params.rubroId, mes, subrubroId);

  const orderers = {
    subrubro: (a, b) => a.nombre.localeCompare(b.nombre),
    diferencia: (a, b) => b.diferencia - a.diferencia,
    pct: (a, b) => (b.pctCambio ?? -Infinity) - (a.pctCambio ?? -Infinity),
    saldo: (a, b) => b.saldoActual - a.saldoActual,
  };
  const filas = [...subrubros].sort(orderers[orden] || orderers.saldo);

  const wb = nuevoWorkbook();
  const ws = wb.addWorksheet('Análisis', { views: [{ state: 'frozen', ySplit: 0 }] });

  const HEADERS = ['Subrubro', 'Saldo mes anterior', 'Saldo mes actual', 'Diferencia', '% Cambio', 'Tendencia', 'Facturado (mes)', 'Pagado (mes)'];
  const ncols = HEADERS.length;

  const startRow = escribirTitulo(
    ws,
    `Análisis mensual de subrubros — ${rubro.nombre}`,
    `${nombreMes(mes)} vs ${nombreMes(mesAnterior)}${subrubroId ? ' · (subrubro filtrado)' : ''}`,
    ncols,
  );

  const headerRow = startRow;
  escribirHeader(ws, headerRow, HEADERS);

  let r = headerRow + 1;
  const dataStart = r;
  let totAnt = 0, totAct = 0, totFact = 0, totPag = 0;

  for (const s of filas) {
    const row = ws.getRow(r);
    row.getCell(1).value = s.nombre;
    row.getCell(2).value = s.saldoAnterior;
    row.getCell(3).value = s.saldoActual;
    row.getCell(4).value = s.diferencia;
    row.getCell(5).value = s.pctCambio === null ? '—' : s.pctCambio / 100;
    row.getCell(6).value = flechaTendencia(s.tendencia);
    row.getCell(7).value = s.facturadoMes;
    row.getCell(8).value = s.pagadoMes;

    [2, 3, 4, 7, 8].forEach(c => { row.getCell(c).numFmt = MONEDA; });
    if (s.pctCambio !== null) row.getCell(5).numFmt = '0.0%';

    colorearSigno(row.getCell(4), s.diferencia);
    const tCell = row.getCell(6);
    tCell.font = { color: { argb: s.tendencia === 'sube' ? COLORS.green : s.tendencia === 'baja' ? COLORS.red : COLORS.subtle }, bold: true };
    tCell.alignment = { horizontal: 'center' };
    if (s.pctCambio !== null) row.getCell(5).font = { color: { argb: s.diferencia >= 0 ? COLORS.green : COLORS.red } };

    totAnt += s.saldoAnterior; totAct += s.saldoActual; totFact += s.facturadoMes; totPag += s.pagadoMes;
    r++;
  }

  const dataEnd = r - 1;

  // Totales
  if (filas.length > 0) {
    const tr = ws.getRow(r);
    tr.getCell(1).value = 'TOTAL';
    tr.getCell(2).value = totAnt;
    tr.getCell(3).value = totAct;
    tr.getCell(4).value = totAct - totAnt;
    tr.getCell(7).value = totFact;
    tr.getCell(8).value = totPag;
    [2, 3, 4, 7, 8].forEach(c => { tr.getCell(c).numFmt = MONEDA; });
    for (let c = 1; c <= ncols; c++) {
      tr.getCell(c).font = { bold: true };
      tr.getCell(c).border = { top: { style: 'thin', color: { argb: COLORS.header } } };
    }
    colorearSigno(tr.getCell(4), totAct - totAnt);

    // Barras de datos (gráfico embebido) sobre el saldo del mes actual
    zebra(ws, dataStart, dataEnd, ncols);
    agregarDataBar(ws, `C${dataStart}:C${dataEnd}`);
  } else {
    ws.getRow(r).getCell(1).value = 'Sin subrubros con datos para este período';
  }

  ws.getColumn(1).width = 28;
  [2, 3, 4, 7, 8].forEach(c => { ws.getColumn(c).width = 18; });
  ws.getColumn(5).width = 12;
  ws.getColumn(6).width = 16;

  const safe = `${rubro.nombre}`.replace(/[^\w\-]+/g, '_').slice(0, 40);
  await enviarWorkbook(res, wb, `analisis_${safe}_${mes}.xlsx`);
}));

// ── S2 · Historial de Caja mensual ──────────────────────────────────────────
const CAJA_TIPO_LABEL = {
  saldo_inicial: 'Saldo inicial', saldo_cuenta: 'Saldo cuenta',
  ingreso_extra: 'Ingreso', empleado: 'Empleado', gasto: 'Gasto',
};
const METODO_LABEL = { efectivo: 'Efectivo', transferencia: 'Transferencia' };
const prevMesStr = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// Resume flujos de un conjunto de movimientos de caja.
function resumenCaja(movs) {
  let ingresos = 0, egresos = 0, gastosEfvo = 0, gastosTrans = 0, especiales = 0;
  for (const m of movs) {
    const monto = m.monto || 0;
    if (m.tipo === 'gasto') {
      egresos += monto;
      if (m.metodo === 'efectivo') gastosEfvo += monto; else gastosTrans += monto;
      if (m.es_especial) especiales += monto;
    } else if (m.tipo === 'ingreso_extra' || m.tipo === 'empleado') {
      ingresos += monto;
    }
  }
  return { ingresos, egresos, gastosEfvo, gastosTrans, especiales, neto: ingresos - egresos };
}

// Escribe una fila comparativa (métrica | actual | anterior | diferencia | %).
function filaComparativa(ws, r, etiqueta, actual, anterior) {
  const dif = actual - anterior;
  const pct = anterior !== 0 ? dif / Math.abs(anterior) : null;
  const row = ws.getRow(r);
  row.getCell(1).value = etiqueta;
  row.getCell(2).value = actual;
  row.getCell(3).value = anterior;
  row.getCell(4).value = dif;
  row.getCell(5).value = pct === null ? '—' : pct;
  [2, 3, 4].forEach(c => { row.getCell(c).numFmt = MONEDA; });
  if (pct !== null) { row.getCell(5).numFmt = '0.0%'; row.getCell(5).font = { color: { argb: dif >= 0 ? COLORS.green : COLORS.red } }; }
  colorearSigno(row.getCell(4), dif);
}

// GET /api/reportes/caja-mensual?mes=YYYY-MM
router.get('/caja-mensual', asyncHandler(async (req, res) => {
  const mes = esMesValido(req.query.mes) ? req.query.mes : mesActualStr();
  const mesAnterior = prevMesStr(mes);

  const [a, m] = mes.split('-').map(Number);
  const finMesActual = `${mes}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`;
  const [pa, pm] = mesAnterior.split('-').map(Number);
  const finMesAnterior = `${mesAnterior}-${String(new Date(pa, pm, 0).getDate()).padStart(2, '0')}`;

  const movsActual = await CajaMovimiento.find({ fecha: { $gte: `${mes}-01`, $lte: finMesActual } }).sort({ fecha: 1, _id: 1 }).lean();
  const movsAnterior = await CajaMovimiento.find({ fecha: { $gte: `${mesAnterior}-01`, $lte: finMesAnterior } }).lean();

  const q15Actual = movsActual.filter(x => x.fecha <= `${mes}-15`);
  const q15Anterior = movsAnterior.filter(x => x.fecha <= `${mesAnterior}-15`);

  const resActual = resumenCaja(movsActual);
  const resAnterior = resumenCaja(movsAnterior);
  const resQ15Actual = resumenCaja(q15Actual);
  const resQ15Anterior = resumenCaja(q15Anterior);

  const wb = nuevoWorkbook();

  // ── Hoja 1: Resumen ──
  const wsR = wb.addWorksheet('Resumen');
  let r = escribirTitulo(wsR, `Caja — Resumen de ${nombreMes(mes)}`, `Comparado con ${nombreMes(mesAnterior)}`, 5);
  escribirHeader(wsR, r, ['Concepto', 'Mes actual', 'Mes anterior', 'Diferencia', '% Cambio']);
  r++;
  filaComparativa(wsR, r++, 'Total ingresos', resActual.ingresos, resAnterior.ingresos);
  filaComparativa(wsR, r++, 'Total egresos (gastos)', resActual.egresos, resAnterior.egresos);
  filaComparativa(wsR, r++, 'Gastos en efectivo', resActual.gastosEfvo, resAnterior.gastosEfvo);
  filaComparativa(wsR, r++, 'Gastos por transferencia', resActual.gastosTrans, resAnterior.gastosTrans);
  filaComparativa(wsR, r++, 'Gastos especiales', resActual.especiales, resAnterior.especiales);
  filaComparativa(wsR, r++, 'Saldo neto (ingresos − egresos)', resActual.neto, resAnterior.neto);
  wsR.getColumn(1).width = 32;
  [2, 3, 4].forEach(c => { wsR.getColumn(c).width = 18; });
  wsR.getColumn(5).width = 12;

  // ── Hoja 2: Detalle día a día ──
  const wsD = wb.addWorksheet('Detalle');
  let d = escribirTitulo(wsD, `Caja — Detalle de ${nombreMes(mes)}`, 'Movimientos día a día con saldo acumulado', 6);
  escribirHeader(wsD, d, ['Fecha', 'Concepto', 'Tipo', 'Método', 'Ingreso', 'Egreso', 'Saldo acumulado']);
  d++;
  const detStart = d;
  let acum = 0;
  for (const mv of movsActual) {
    const esIngreso = mv.tipo === 'ingreso_extra' || mv.tipo === 'empleado';
    const esGasto = mv.tipo === 'gasto';
    if (esIngreso) acum += mv.monto || 0;
    if (esGasto) acum -= mv.monto || 0;
    const row = wsD.getRow(d);
    row.getCell(1).value = mv.fecha;
    row.getCell(2).value = mv.concepto || CAJA_TIPO_LABEL[mv.tipo] || mv.tipo;
    row.getCell(3).value = CAJA_TIPO_LABEL[mv.tipo] || mv.tipo;
    row.getCell(4).value = METODO_LABEL[mv.metodo] || '—';
    row.getCell(5).value = esIngreso ? mv.monto || 0 : null;
    row.getCell(6).value = esGasto ? mv.monto || 0 : null;
    row.getCell(7).value = acum;
    [5, 6, 7].forEach(c => { row.getCell(c).numFmt = MONEDA; });
    if (esGasto) row.getCell(6).font = { color: { argb: COLORS.red } };
    if (esIngreso) row.getCell(5).font = { color: { argb: COLORS.green } };
    d++;
  }
  const detEnd = d - 1;
  if (detEnd >= detStart) {
    zebra(wsD, detStart, detEnd, 7);
    agregarDataBar(wsD, `F${detStart}:F${detEnd}`, COLORS.red);
  } else {
    wsD.getRow(d).getCell(1).value = 'Sin movimientos de caja en el mes';
  }
  wsD.getColumn(1).width = 12; wsD.getColumn(2).width = 30; wsD.getColumn(3).width = 14;
  wsD.getColumn(4).width = 14; [5, 6, 7].forEach(c => { wsD.getColumn(c).width = 16; });

  // ── Hoja 3: Comparativas (quincena y mes) ──
  const wsC = wb.addWorksheet('Comparativas');
  let c = escribirTitulo(wsC, 'Caja — Comparativas', `${nombreMes(mes)} vs ${nombreMes(mesAnterior)}`, 5);

  wsC.getCell(c, 1).value = 'Primeros 15 días';
  wsC.getCell(c, 1).font = { bold: true, color: { argb: COLORS.title } };
  c++;
  escribirHeader(wsC, c, ['Métrica', 'Mes actual', 'Mes anterior', 'Diferencia', '% Cambio']); c++;
  filaComparativa(wsC, c++, 'Ingresos (1-15)', resQ15Actual.ingresos, resQ15Anterior.ingresos);
  filaComparativa(wsC, c++, 'Egresos (1-15)', resQ15Actual.egresos, resQ15Anterior.egresos);
  filaComparativa(wsC, c++, 'Saldo neto (1-15)', resQ15Actual.neto, resQ15Anterior.neto);
  c++;
  wsC.getCell(c, 1).value = 'Mes completo';
  wsC.getCell(c, 1).font = { bold: true, color: { argb: COLORS.title } };
  c++;
  escribirHeader(wsC, c, ['Métrica', 'Mes actual', 'Mes anterior', 'Diferencia', '% Cambio']); c++;
  filaComparativa(wsC, c++, 'Ingresos (mes)', resActual.ingresos, resAnterior.ingresos);
  filaComparativa(wsC, c++, 'Egresos (mes)', resActual.egresos, resAnterior.egresos);
  filaComparativa(wsC, c++, 'Saldo neto (mes)', resActual.neto, resAnterior.neto);
  wsC.getColumn(1).width = 24; [2, 3, 4].forEach(x => { wsC.getColumn(x).width = 18; }); wsC.getColumn(5).width = 12;

  await enviarWorkbook(res, wb, `caja_${mes}.xlsx`);
}));

module.exports = router;
