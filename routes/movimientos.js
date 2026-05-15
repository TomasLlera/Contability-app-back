const express = require('express');
const router = express.Router();
const db = require('../db');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { asyncHandler } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/vencimientos/proximos', asyncHandler(async (req, res) => {
  const dias = Number(req.query.dias) || 30;
  res.json(await db.getVencimientos(dias));
}));

router.get('/search', asyncHandler(async (req, res) => {
  const { q, limit } = req.query;
  if (!q || String(q).trim().length < 2) return res.json([]);
  res.json(await db.searchMovimientos(q, limit));
}));

router.get('/:subrubroId', asyncHandler(async (req, res) => {
  const { anio, mes } = req.query;
  const [movs, sub, saldo_total] = await Promise.all([
    db.getMovimientos(req.params.subrubroId, anio, mes),
    db.getSubrubro(req.params.subrubroId),
    db.getSaldoTotal(req.params.subrubroId),
  ]);
  const saldo_anterior = (anio && mes)
    ? await db.getSaldoAnterior(req.params.subrubroId, anio, mes)
    : (sub?.monto_base ?? 0);
  res.json({ movimientos: movs, monto_base: sub?.monto_base ?? 0, saldo_total, saldo_anterior });
}));

router.post('/:subrubroId', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await db.createMovimiento(req.params.subrubroId, req.body));
}));

router.post('/:subrubroId/pago-vinculado', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await db.crearPagoVinculado(req.params.subrubroId, req.body));
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await db.updateMovimiento(req.params.id, req.body));
}));

router.put('/:id/pago-vinculado', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await db.actualizarPagoVinculado(req.params.id, req.body));
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.deleteMovimiento(req.params.id);
  res.json({ ok: true });
}));

router.delete('/:subrubroId/movimientos', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await db.clearMovimientos(req.params.subrubroId));
}));

// Export Excel
router.get('/export/:subrubroId', async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const sub = await db.getSubrubro(req.params.subrubroId);
    if (!sub) return res.status(404).json({ error: 'No encontrado' });
    const rubro = await db.getRubro(sub.rubro_id);
    const campos = rubro ? await db.getCampos(rubro._id) : [];
    const camposSuma = new Set(campos.filter(c => c.tipo === 'suma').map(c => c.nombre));
    const camposResta = new Set(campos.filter(c => c.tipo === 'resta').map(c => c.nombre));

    const todosMovs = await db.getMovimientos(req.params.subrubroId);

    // Saldo acumulado hasta el día anterior a "desde" (punto de partida del running total)
    let saldoInicial = sub.monto_base || 0;
    if (desde) {
      for (const m of todosMovs) {
        if (!m.fecha || m.fecha >= desde) continue;
        saldoInicial += (m.monto || 0) - (m.pago || 0);
        for (const [k, v] of Object.entries(m.campos_extra || {})) {
          const n = Number(v);
          if (!isNaN(n) && n !== 0) {
            if (camposSuma.has(k)) saldoInicial += n;
            if (camposResta.has(k)) saldoInicial -= n;
          }
        }
      }
    }

    // Filtrar por rango
    const movs = todosMovs.filter(m => {
      if (!m.fecha) return !desde && !hasta;
      if (desde && m.fecha < desde) return false;
      if (hasta && m.fecha > hasta) return false;
      return true;
    });

    const wb = XLSX.utils.book_new();
    const porMes = {};
    for (const m of movs) {
      const key = m.fecha ? m.fecha.substring(0, 7) : 'Sin fecha';
      if (!porMes[key]) porMes[key] = [];
      porMes[key].push(m);
    }

    let saldoAcum = saldoInicial;
    for (const [mes, movsMes] of Object.entries(porMes).sort()) {
      const rows = movsMes.map(m => {
        const extra = m.campos_extra || {};
        let extraEfecto = 0;
        for (const [k, v] of Object.entries(extra)) {
          const n = Number(v);
          if (!isNaN(n) && n !== 0) {
            if (camposSuma.has(k)) extraEfecto += n;
            if (camposResta.has(k)) extraEfecto -= n;
          }
        }
        saldoAcum += (m.monto || 0) - (m.pago || 0) + extraEfecto;
        const tipoLabel = { factura: 'Factura', pago: 'Pago', nota_credito: 'Nota de Crédito', ajuste: 'Ajuste' }[m.tipo] || m.tipo;
        const row = { Fecha: m.fecha || '', Tipo: tipoLabel, Monto: m.monto || '', Pago: m.pago || '', Estado: m.tipo === 'factura' ? (m.pagado ? 'Pagada' : 'Pendiente') : '', Concepto: m.concepto || '', Total: saldoAcum };
        for (const c of campos) row[c.nombre] = extra[c.nombre] ?? '';
        if (m.fecha_vencimiento) row['Vencimiento'] = m.fecha_vencimiento;
        return row;
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, mes.substring(0, 31));
    }

    if (wb.SheetNames.length === 0) {
      const headers = ['Fecha', 'Tipo', 'Monto', 'Pago', 'Estado', 'Concepto', 'Total', ...campos.map(c => c.nombre)];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers]), 'Sin movimientos');
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${sub.nombre}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import Excel
router.post('/import/:rubroId', upload.single('file'), async (req, res) => {
  try {
    const rubroId = Number(req.params.rubroId);
    const mapping = JSON.parse(req.body.mapping || '{}');
    const mode = req.body.mode || 'skip_duplicates';
    const sheetsFilter = req.body.sheets ? new Set(JSON.parse(req.body.sheets)) : null;
    const skipRows = Number(req.body.skipRows) || 0;
    const fechaDesde = req.body.fechaDesde || null;
    const fechaHasta = req.body.fechaHasta || null;

    const roleCols = {};
    const montoCols = [];
    const campoCols = [];

    for (const [col, role] of Object.entries(mapping)) {
      const nc = col.toLowerCase().trim();
      if (!nc || !role || role === 'ignore') continue;
      if (role === 'monto') { if (!montoCols.includes(nc)) montoCols.push(nc); }
      else if (role.startsWith('campo:')) campoCols.push({ colName: nc, campoNombre: role.replace('campo:', '') });
      else {
        if (!roleCols[role]) roleCols[role] = [];
        if (!roleCols[role].includes(nc)) roleCols[role].push(nc);
      }
    }

    function getCol(row, role) {
      for (const c of (roleCols[role] || [])) {
        if (row[c] !== undefined && row[c] !== null) return row[c];
      }
      return null;
    }

    const fechaHoy = new Date().toISOString().split('T')[0];
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const results = { sheets: [], totalCreated: 0, totalSkipped: 0 };
    const allMovsToInsert = [];
    const subrubroIdsAfectados = new Set();

    for (const sheetName of workbook.SheetNames.filter(n => !sheetsFilter || sheetsFilter.has(n))) {
      const sheet = expandirCeldasFusionadas(workbook.Sheets[sheetName]);
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null, range: skipRows })
        .map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v])));
      const rows = inferirAniosSheet(rawRows, roleCols.fecha || []);

      if (rows.length === 0) {
        results.sheets.push({ name: sheetName, created: 0, skipped: 0, duplicates: 0 });
        continue;
      }

      const subrubro = await db.findOrCreateSubrubroForImport(rubroId, sheetName);

      if (mode === 'replace') {
        await db.clearMovimientos(subrubro._id);
      }

      const { nros: nrosExistentes, fechaMontos: fechaMontoExistentes } = await db.getMovsForDedup(subrubro._id);

      // Resolver fechas: fill-forward + corrección de picos atípicos
      const fechasBase = rows.map(r => parseDate(getCol(r, 'fecha')) ?? null);
      let last = null;
      for (let i = 0; i < fechasBase.length; i++) {
        if (fechasBase[i]) last = fechasBase[i];
        else if (last) fechasBase[i] = last;
      }
      const fechasResueltas = corregirPicos(fechasBase);

      let created = 0, skipped = 0, duplicates = 0;

      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        let fecha = fechasResueltas[rowIdx];
        const fecha_vencimiento = parseDate(getCol(row, 'fecha_vencimiento'));
        const pago = parseMonto(getCol(row, 'pago')) || 0;

        const montos = montoCols
          .map(col => ({ col, monto: parseMonto(row[col]) }))
          .filter(({ monto }) => monto !== null && monto > 0);

        const campos_extra = {};
        for (const { colName, campoNombre } of campoCols) {
          const v = row[colName];
          if (v !== null && v !== undefined && v !== '') campos_extra[campoNombre] = toStr(v) || v;
        }

        if (montos.length === 0 && pago === 0) { skipped++; continue; }

        // Fecha futura → corregir restando años hasta que no sea futura
        if (fecha && fecha > fechaHoy) {
          const [y, m, d] = fecha.split('-');
          let yr = parseInt(y);
          while (yr > 1900 && `${yr}-${m}-${d}` > fechaHoy) yr--;
          fecha = `${yr}-${m}-${d}`;
        }

        // Filtro de rango de fechas
        if (fecha) {
          if (fechaDesde && fecha < fechaDesde) { skipped++; continue; }
          if (fechaHasta && fecha > fechaHasta) { skipped++; continue; }
        } else if (fechaDesde || fechaHasta) {
          // Sin fecha y hay filtro activo → omitir
          skipped++; continue;
        }

        if (montos.length > 0) {
          for (const { monto } of montos) {
            if (mode === 'skip_duplicates') {
              const nro = campos_extra.nro_factura;
              const isDup = nro
                ? nrosExistentes.has(nro)
                : (fecha ? fechaMontoExistentes.has(`${fecha}|${monto}`) : false);
              if (isDup) { duplicates++; continue; }
            }
            allMovsToInsert.push({ subrubro_id: subrubro._id, monto, pago: 0, fecha, fecha_vencimiento: fecha_vencimiento || null, campos_extra, tipo: 'factura', facturas_vinculadas_ids: [], pagado: false, concepto: '', _ajuste_pago_id: null });
            if (campos_extra.nro_factura) nrosExistentes.add(campos_extra.nro_factura);
            else if (fecha) fechaMontoExistentes.add(`${fecha}|${monto}`);
            created++;
          }
        }

        if (pago > 0) {
          allMovsToInsert.push({ subrubro_id: subrubro._id, monto: 0, pago, fecha, fecha_vencimiento: fecha_vencimiento || null, campos_extra: {}, tipo: 'pago', facturas_vinculadas_ids: [], pagado: false, concepto: '', _ajuste_pago_id: null });
          created++;
        }
      }

      subrubroIdsAfectados.add(subrubro._id);
      results.sheets.push({ name: sheetName, created, skipped, duplicates });
      results.totalCreated += created;
      results.totalSkipped += duplicates;
    }

    await db.bulkInsertMovimientos(allMovsToInsert);
    await db.recalcularPagosMultiple([...subrubroIdsAfectados]);

    res.json(results);
  } catch (e) {
    console.error('Import error:', e);
    res.status(400).json({ error: e.message });
  }
});

// --- Helpers ---
function expandirCeldasFusionadas(sheet) {
  const merges = sheet['!merges'] || [];
  for (const merge of merges) {
    const origen = XLSX.utils.encode_cell(merge.s);
    const valorOrigen = sheet[origen];
    if (!valorOrigen) continue;
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        const celda = XLSX.utils.encode_cell({ r, c });
        if (!sheet[celda]) sheet[celda] = { ...valorOrigen };
      }
    }
  }
  return sheet;
}

function toStr(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s || null;
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val.toISOString().split('T')[0];
  const str = String(val).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);
  // DD/MM/AAAA o DD-MM-AAAA
  const m4 = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m4) return `${m4[3]}-${m4[2].padStart(2, '0')}-${m4[1].padStart(2, '0')}`;
  // DD/MM/AA o DD-MM-AA (año 2 dígitos)
  const m2 = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m2) return `${2000 + parseInt(m2[3])}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  // DD-MON-AAAA o DD-MON-AA  (ej: "15-mar-25", "5/abr/2025")
  const mMon = str.match(/^(\d{1,2})[-\/\s]([a-záéíóúA-ZÁÉÍÓÚ]+)[-\/\s](\d{2,4})$/);
  if (mMon) {
    const month = MESES_ES[mMon[2].toLowerCase().substring(0, 3)];
    if (month) {
      const yr = parseInt(mMon[3]);
      return `${yr < 100 ? 2000 + yr : yr}-${String(month).padStart(2, '0')}-${mMon[1].padStart(2, '0')}`;
    }
  }
  return null;
}

const MESES_ES = { ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12,jan:1,apr:4,aug:8,dec:12 };

function parsePartialDate(val) {
  if (!val || val instanceof Date) return null;
  const s = String(val).trim().toLowerCase();
  // Primero intentar parseDate: si tiene año completo, no es fecha parcial
  if (parseDate(val)) return null;
  // DD-MON sin año: "15-mar", "5/abr"
  const m1 = s.match(/^(\d{1,2})[-\/\s]([a-záéíóú]+)\s*$/);
  if (m1) { const month = MESES_ES[m1[2].substring(0, 3)]; if (month) return { day: parseInt(m1[1]), month }; }
  // DD/MM sin año: "15/03" o "15-03"
  const m2 = s.match(/^(\d{1,2})[-\/](\d{1,2})$/);
  if (m2) return { day: parseInt(m2[1]), month: parseInt(m2[2]) };
  return null;
}

function inferirAniosSheet(rows, dateCols) {
  const candidates = Array.isArray(dateCols) ? dateCols : (dateCols ? [dateCols] : []);
  let dateCol = null, parciales = null;
  for (const col of candidates) {
    const p = rows.map(r => parsePartialDate(r[col]));
    if (!p.every(x => x === null)) { dateCol = col; parciales = p; break; }
  }
  if (!dateCol) return rows;

  const aniosAsignados = new Array(rows.length).fill(null);
  const anioActual = new Date().getFullYear();
  let ultimoIdx = -1;
  for (let i = parciales.length - 1; i >= 0; i--) { if (parciales[i]) { ultimoIdx = i; break; } }
  if (ultimoIdx === -1) return rows;

  let anio = anioActual;
  // Si asignar el año actual al último registro generaría una fecha futura, retroceder un año
  const ultimoParcial = parciales[ultimoIdx];
  if (ultimoParcial) {
    const tentativa = `${anio}-${String(ultimoParcial.month).padStart(2,'0')}-${String(ultimoParcial.day).padStart(2,'0')}`;
    if (tentativa > new Date().toISOString().split('T')[0]) anio--;
  }
  aniosAsignados[ultimoIdx] = anio;
  for (let i = ultimoIdx - 1; i >= 0; i--) {
    if (!parciales[i]) { aniosAsignados[i] = anio; continue; }
    let mesSiguiente = null;
    for (let j = i + 1; j <= ultimoIdx; j++) { if (parciales[j]) { mesSiguiente = parciales[j].month; break; } }
    if (mesSiguiente !== null && parciales[i].month > mesSiguiente) anio--;
    aniosAsignados[i] = anio;
  }

  return rows.map((row, i) => {
    const p = parciales[i];
    if (!p) return row;
    const y = aniosAsignados[i] ?? anioActual;
    return { ...row, [dateCol]: `${y}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` };
  });
}

// Detecta fechas que "saltan adelante" más de 60 días y luego retroceden (pico atípico)
// Ej: (2025-03, 2025-04, 2026-12, 2025-05) → anula 2026-12
function corregirPicos(fechas) {
  const res = [...fechas];
  for (let i = 0; i < res.length; i++) {
    if (!res[i]) continue;
    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) { if (res[j]) { prev = res[j]; break; } }
    for (let j = i + 1; j < res.length; j++) { if (res[j]) { next = res[j]; break; } }
    if (!prev || !next) continue;
    const diasDesdePrev = (new Date(res[i]) - new Date(prev)) / 86400000;
    if (diasDesdePrev > 60 && res[i] > next) res[i] = null;
  }
  return res;
}

function parseMonto(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Math.abs(val);
  const str = String(val).replace(/[$\s]/g, '');
  const n = parseFloat(str.replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : Math.abs(n);
}

module.exports = router;
