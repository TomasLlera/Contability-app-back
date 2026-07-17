const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const db = require('../db');
const { CajaMovimiento, VentaSistema, TarjetaTransaccion } = require('../models');
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
    // Pendientes (gasto sin confirmar / deuda sin cobrar) no cuentan en los flujos.
    if (m.confirmado === false) continue;
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
    // Pendientes (sin confirmar/cobrar) se listan pero no mueven el acumulado.
    const pendiente = mv.confirmado === false;
    const esIngreso = !pendiente && (mv.tipo === 'ingreso_extra' || mv.tipo === 'empleado');
    const esGasto = !pendiente && mv.tipo === 'gasto';
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

// ── S3 · Registro de Ventas Sistema y Tarjetas (rango de meses) ──────────────

// Lista de meses 'YYYY-MM' entre desde y hasta (inclusive).
function mesesRango(desde, hasta) {
  const out = [];
  let [y, m] = desde.split('-').map(Number);
  const [hy, hm] = hasta.split('-').map(Number);
  while (y < hy || (y === hy && m <= hm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// Índice de columna (1-based) → letra de Excel (para armar rangos de data bars).
const colLetter = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

// Lee desde/hasta del querystring, con defaults sanos e inversión si vienen al revés.
function rangoMeses(req) {
  let desde = esMesValido(req.query.desde) ? req.query.desde : mesActualStr();
  let hasta = esMesValido(req.query.hasta) ? req.query.hasta : desde;
  if (hasta < desde) [desde, hasta] = [hasta, desde];
  return { desde, hasta };
}

const tend = (dif) => (dif > 0.0001 ? 'sube' : dif < -0.0001 ? 'baja' : 'igual');
const colorTend = (t) => (t === 'sube' ? COLORS.green : t === 'baja' ? COLORS.red : COLORS.subtle);

// GET /api/reportes/ventas-sistema?desde=YYYY-MM&hasta=YYYY-MM
// Resumen mes a mes (total, cantidad, promedio, diferencia vs mes anterior) + detalle.
router.get('/ventas-sistema', asyncHandler(async (req, res) => {
  const { desde, hasta } = rangoMeses(req);
  const meses = mesesRango(desde, hasta);
  const base = prevMesStr(desde); // mes previo para comparar el primer mes del rango

  const ventas = await VentaSistema.find({ mes: { $gte: base, $lte: hasta } }).sort({ fecha: 1, _id: 1 }).lean();
  const porMes = {};
  for (const v of ventas) (porMes[v.mes] ||= []).push(v);
  const totalDe = (lista) => lista.reduce((s, v) => s + (v.monto || 0), 0);

  const wb = nuevoWorkbook();
  const sub = meses.length === 1 ? nombreMes(desde) : `${nombreMes(desde)} — ${nombreMes(hasta)}`;

  // ── Hoja 1: Resumen mensual ──
  const wsR = wb.addWorksheet('Resumen mensual');
  const HEAD = ['Mes', 'Total', 'Cantidad', 'Promedio diario', 'Dif. vs mes ant.', '% Cambio', 'Tendencia'];
  let r = escribirTitulo(wsR, 'Ventas por sistema — Resumen mensual', sub, HEAD.length);
  escribirHeader(wsR, r, HEAD); r++;
  const dataStart = r;
  let totGeneral = 0;
  for (const mes of meses) {
    const lista = porMes[mes] || [];
    const total = totalDe(lista);
    const totalPrev = totalDe(porMes[prevMesStr(mes)] || []);
    const dif = total - totalPrev;
    const pct = totalPrev ? dif / Math.abs(totalPrev) : null;
    const diasConVentas = new Set(lista.filter(v => (v.monto || 0) > 0).map(v => v.fecha)).size;
    const t = tend(dif);
    const row = wsR.getRow(r);
    row.getCell(1).value = nombreMes(mes);
    row.getCell(2).value = total;
    row.getCell(3).value = lista.length;
    row.getCell(4).value = diasConVentas ? total / diasConVentas : 0;
    row.getCell(5).value = dif;
    row.getCell(6).value = pct === null ? '—' : pct;
    row.getCell(7).value = flechaTendencia(t);
    [2, 4, 5].forEach(c => { row.getCell(c).numFmt = MONEDA; });
    if (pct !== null) { row.getCell(6).numFmt = '0.0%'; row.getCell(6).font = { color: { argb: dif >= 0 ? COLORS.green : COLORS.red } }; }
    colorearSigno(row.getCell(5), dif);
    row.getCell(7).font = { color: { argb: colorTend(t) }, bold: true };
    row.getCell(7).alignment = { horizontal: 'center' };
    totGeneral += total;
    r++;
  }
  const dataEnd = r - 1;
  if (meses.length > 1) {
    const tr = wsR.getRow(r);
    tr.getCell(1).value = 'TOTAL'; tr.getCell(2).value = totGeneral; tr.getCell(2).numFmt = MONEDA;
    for (let c = 1; c <= HEAD.length; c++) { tr.getCell(c).font = { bold: true }; tr.getCell(c).border = { top: { style: 'thin', color: { argb: COLORS.header } } }; }
  }
  if (dataEnd >= dataStart) { zebra(wsR, dataStart, dataEnd, HEAD.length); agregarDataBar(wsR, `B${dataStart}:B${dataEnd}`); }
  else wsR.getRow(r).getCell(1).value = 'Sin ventas en el período';
  wsR.getColumn(1).width = 18; [2, 3, 4, 5].forEach(c => { wsR.getColumn(c).width = 16; }); wsR.getColumn(6).width = 12; wsR.getColumn(7).width = 16;

  // ── Hoja 2: Detalle ──
  const wsD = wb.addWorksheet('Detalle');
  let d = escribirTitulo(wsD, 'Ventas por sistema — Detalle', sub, 4);
  escribirHeader(wsD, d, ['Fecha', 'Mes', 'Concepto', 'Monto']); d++;
  const detStart = d;
  const detalle = ventas.filter(v => v.mes >= desde); // excluye el mes base (solo para comparar)
  for (const v of detalle) {
    const row = wsD.getRow(d);
    row.getCell(1).value = v.fecha;
    row.getCell(2).value = nombreMes(v.mes);
    row.getCell(3).value = v.concepto || '—';
    row.getCell(4).value = v.monto || 0; row.getCell(4).numFmt = MONEDA;
    d++;
  }
  const detEnd = d - 1;
  if (detEnd >= detStart) { zebra(wsD, detStart, detEnd, 4); agregarDataBar(wsD, `D${detStart}:D${detEnd}`); }
  else wsD.getRow(d).getCell(1).value = 'Sin ventas en el período';
  wsD.getColumn(1).width = 12; wsD.getColumn(2).width = 16; wsD.getColumn(3).width = 34; wsD.getColumn(4).width = 16;

  const fname = meses.length === 1 ? `ventas_sistema_${desde}.xlsx` : `ventas_sistema_${desde}_a_${hasta}.xlsx`;
  await enviarWorkbook(res, wb, fname);
}));

const TARJETA_TIPOS = [
  { key: 'qr', label: 'Pagos QR' },
  { key: 'debito', label: 'Tarjeta Débito' },
  { key: 'credito', label: 'Tarjeta Crédito' },
  { key: 'prepaga', label: 'Tarjeta Prepaga' },
];

// GET /api/reportes/tarjetas?desde=YYYY-MM&hasta=YYYY-MM
// Resumen mensual por tipo (QR/débito/crédito/prepaga) + acumulado por empleado + detalle.
router.get('/tarjetas', asyncHandler(async (req, res) => {
  const { desde, hasta } = rangoMeses(req);
  const meses = mesesRango(desde, hasta);
  const base = prevMesStr(desde);

  const txs = await TarjetaTransaccion.find({ mes: { $gte: base, $lte: hasta } }).sort({ fecha: 1, _id: 1 }).lean();
  const porMes = {};
  for (const t of txs) (porMes[t.mes] ||= []).push(t);
  const sumaTipo = (lista, key) => lista.filter(t => t.tipo === key).reduce((s, t) => s + (t.monto || 0), 0);
  const sumaTotal = (lista) => lista.reduce((s, t) => s + (t.monto || 0), 0);

  const wb = nuevoWorkbook();
  const sub = meses.length === 1 ? nombreMes(desde) : `${nombreMes(desde)} — ${nombreMes(hasta)}`;
  const nTipos = TARJETA_TIPOS.length;
  const colTotal = 2 + nTipos; // columna del Total en las hojas por tipo

  // ── Hoja 1: Resumen mensual por tipo ──
  const wsR = wb.addWorksheet('Resumen por tipo');
  const HEAD = ['Mes', ...TARJETA_TIPOS.map(t => t.label), 'Total', 'Dif. vs mes ant.', '% Cambio'];
  let r = escribirTitulo(wsR, 'Tarjetas — Resumen mensual por tipo', sub, HEAD.length);
  escribirHeader(wsR, r, HEAD); r++;
  const dataStart = r;
  const totCols = TARJETA_TIPOS.map(() => 0); let totGen = 0;
  for (const mes of meses) {
    const lista = porMes[mes] || [];
    const total = sumaTotal(lista);
    const totalPrev = sumaTotal(porMes[prevMesStr(mes)] || []);
    const dif = total - totalPrev;
    const pct = totalPrev ? dif / Math.abs(totalPrev) : null;
    const row = wsR.getRow(r);
    row.getCell(1).value = nombreMes(mes);
    TARJETA_TIPOS.forEach((t, i) => { const v = sumaTipo(lista, t.key); row.getCell(2 + i).value = v; row.getCell(2 + i).numFmt = MONEDA; totCols[i] += v; });
    row.getCell(colTotal).value = total; row.getCell(colTotal).numFmt = MONEDA; row.getCell(colTotal).font = { bold: true };
    row.getCell(colTotal + 1).value = dif; row.getCell(colTotal + 1).numFmt = MONEDA; colorearSigno(row.getCell(colTotal + 1), dif);
    row.getCell(colTotal + 2).value = pct === null ? '—' : pct;
    if (pct !== null) { row.getCell(colTotal + 2).numFmt = '0.0%'; row.getCell(colTotal + 2).font = { color: { argb: dif >= 0 ? COLORS.green : COLORS.red } }; }
    totGen += total;
    r++;
  }
  const dataEnd = r - 1;
  if (meses.length > 1) {
    const tr = wsR.getRow(r);
    tr.getCell(1).value = 'TOTAL';
    TARJETA_TIPOS.forEach((t, i) => { tr.getCell(2 + i).value = totCols[i]; tr.getCell(2 + i).numFmt = MONEDA; });
    tr.getCell(colTotal).value = totGen; tr.getCell(colTotal).numFmt = MONEDA;
    for (let c = 1; c <= HEAD.length; c++) { tr.getCell(c).font = { bold: true }; tr.getCell(c).border = { top: { style: 'thin', color: { argb: COLORS.header } } }; }
  }
  if (dataEnd >= dataStart) { zebra(wsR, dataStart, dataEnd, HEAD.length); agregarDataBar(wsR, `${colLetter(colTotal)}${dataStart}:${colLetter(colTotal)}${dataEnd}`); }
  else wsR.getRow(r).getCell(1).value = 'Sin transacciones en el período';
  wsR.getColumn(1).width = 18; for (let c = 2; c <= HEAD.length; c++) wsR.getColumn(c).width = c === HEAD.length ? 12 : 16;

  // ── Hoja 2: Acumulado por empleado ──
  const detalleTxs = txs.filter(t => t.mes >= desde); // excluye el mes base
  const wsE = wb.addWorksheet('Por empleado');
  let e = escribirTitulo(wsE, 'Tarjetas — Acumulado por empleado', sub, colTotal);
  escribirHeader(wsE, e, ['Empleado', ...TARJETA_TIPOS.map(t => t.label), 'Total']); e++;
  const empMap = {};
  for (const t of detalleTxs) {
    const nom = (t.empleado || '').trim() || 'Sin asignar';
    const g = (empMap[nom] ||= { nom, total: 0, ...Object.fromEntries(TARJETA_TIPOS.map(x => [x.key, 0])) });
    if (TARJETA_TIPOS.some(x => x.key === t.tipo)) g[t.tipo] += t.monto || 0;
    g.total += t.monto || 0;
  }
  const empList = Object.values(empMap).sort((a, b) => b.total - a.total);
  const empStart = e;
  for (const g of empList) {
    const row = wsE.getRow(e);
    row.getCell(1).value = g.nom;
    TARJETA_TIPOS.forEach((t, i) => { row.getCell(2 + i).value = g[t.key]; row.getCell(2 + i).numFmt = MONEDA; });
    row.getCell(colTotal).value = g.total; row.getCell(colTotal).numFmt = MONEDA; row.getCell(colTotal).font = { bold: true };
    e++;
  }
  const empEnd = e - 1;
  if (empEnd >= empStart) { zebra(wsE, empStart, empEnd, colTotal); agregarDataBar(wsE, `${colLetter(colTotal)}${empStart}:${colLetter(colTotal)}${empEnd}`); }
  else wsE.getRow(e).getCell(1).value = 'Sin transacciones en el período';
  wsE.getColumn(1).width = 24; for (let c = 2; c <= colTotal; c++) wsE.getColumn(c).width = 16;

  // ── Hoja 3: Detalle ──
  const wsD = wb.addWorksheet('Detalle');
  let d = escribirTitulo(wsD, 'Tarjetas — Detalle', sub, 4);
  escribirHeader(wsD, d, ['Fecha', 'Tipo', 'Empleado', 'Monto']); d++;
  const detStart = d;
  const labelTipo = (k) => (TARJETA_TIPOS.find(x => x.key === k) || {}).label || k;
  for (const t of detalleTxs) {
    const row = wsD.getRow(d);
    row.getCell(1).value = t.fecha;
    row.getCell(2).value = labelTipo(t.tipo);
    row.getCell(3).value = (t.empleado || '').trim() || 'Sin asignar';
    row.getCell(4).value = t.monto || 0; row.getCell(4).numFmt = MONEDA;
    d++;
  }
  const detEnd = d - 1;
  if (detEnd >= detStart) { zebra(wsD, detStart, detEnd, 4); agregarDataBar(wsD, `D${detStart}:D${detEnd}`); }
  else wsD.getRow(d).getCell(1).value = 'Sin transacciones en el período';
  wsD.getColumn(1).width = 12; wsD.getColumn(2).width = 18; wsD.getColumn(3).width = 24; wsD.getColumn(4).width = 16;

  const fname = meses.length === 1 ? `tarjetas_${desde}.xlsx` : `tarjetas_${desde}_a_${hasta}.xlsx`;
  await enviarWorkbook(res, wb, fname);
}));

module.exports = router;
