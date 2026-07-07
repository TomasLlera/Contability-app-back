// Helpers compartidos para generar reportes Excel con ExcelJS: estilos coherentes
// con la app (encabezados azules, moneda, celdas con color según signo, y barras de
// datos nativas de Excel como "gráfico" embebido de evolución).
const ExcelJS = require('exceljs');

const COLORS = {
  header: 'FF2563EB',      // blue-600
  headerText: 'FFFFFFFF',
  title: 'FF1E293B',       // slate-800
  subtle: 'FF64748B',      // slate-500
  green: 'FF16A34A',
  red: 'FFDC2626',
  greenBg: 'FFDCFCE7',
  redBg: 'FFFEE2E2',
  zebra: 'FFF8FAFC',       // slate-50
  bar: 'FF60A5FA',         // blue-400
};

const MONEDA = '"$"#,##0.00';
const MESES_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function nombreMes(ym) {
  if (!ym || !ym.includes('-')) return ym || '';
  const [a, m] = ym.split('-').map(Number);
  return `${MESES_ES[m - 1]} ${a}`;
}

function nuevoWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CA-Gestión';
  wb.created = new Date();
  return wb;
}

// Título grande + subtítulo en las primeras filas de una hoja. Devuelve la fila
// donde debería empezar la tabla.
function escribirTitulo(ws, titulo, subtitulo, ncols = 6) {
  ws.mergeCells(1, 1, 1, ncols);
  const t = ws.getCell(1, 1);
  t.value = titulo;
  t.font = { bold: true, size: 15, color: { argb: COLORS.title } };
  t.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;

  let fila = 2;
  if (subtitulo) {
    ws.mergeCells(2, 1, 2, ncols);
    const s = ws.getCell(2, 1);
    s.value = subtitulo;
    s.font = { size: 10, color: { argb: COLORS.subtle } };
    fila = 3;
  }
  return fila + 1; // deja una fila en blanco antes de la tabla
}

// Escribe una fila de encabezado con estilo (azul, texto blanco, negrita).
function escribirHeader(ws, filaIdx, headers) {
  const row = ws.getRow(filaIdx);
  headers.forEach((h, i) => {
    const cell = row.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: COLORS.headerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.header } };
    cell.alignment = { vertical: 'middle', horizontal: i === 0 ? 'left' : 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: COLORS.header } } };
  });
  row.height = 22;
  return row;
}

// Aplica barras de datos nativas de Excel a un rango (columna) → "gráfico" embebido.
function agregarDataBar(ws, ref, color = COLORS.bar) {
  ws.addConditionalFormatting({
    ref,
    rules: [{
      type: 'dataBar',
      cfvo: [{ type: 'min' }, { type: 'max' }],
      color: { argb: color },
      gradient: false,
    }],
  });
}

// Colorea una celda según el signo (verde positivo / rojo negativo).
function colorearSigno(cell, valor) {
  if (valor > 0.0001) {
    cell.font = { color: { argb: COLORS.green }, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.greenBg } };
  } else if (valor < -0.0001) {
    cell.font = { color: { argb: COLORS.red }, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.redBg } };
  }
}

// Zebra en las filas de datos [desde, hasta].
function zebra(ws, desde, hasta, ncols) {
  for (let r = desde; r <= hasta; r++) {
    if ((r - desde) % 2 === 1) {
      for (let c = 1; c <= ncols; c++) {
        const cell = ws.getCell(r, c);
        if (!cell.fill || cell.fill.type !== 'pattern') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
        }
      }
    }
  }
}

const flechaTendencia = (t) => (t === 'sube' ? '↑ Crecimiento' : t === 'baja' ? '↓ Caída' : '= Sin cambio');

module.exports = {
  ExcelJS, COLORS, MONEDA, nombreMes,
  nuevoWorkbook, escribirTitulo, escribirHeader,
  agregarDataBar, colorearSigno, zebra, flechaTendencia,
};
