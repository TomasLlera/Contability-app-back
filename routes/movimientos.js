const express = require('express');
const router = express.Router();
const db = require('../db');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// GET vencimientos proximos
router.get('/vencimientos/proximos', (req, res) => {
  const dias = Number(req.query.dias) || 30;
  res.json(db.getVencimientos(dias));
});

// GET movimientos de un subrubro
router.get('/:subrubroId', (req, res) => {
  const { anio, mes } = req.query;
  const movs = db.getMovimientos(req.params.subrubroId, anio, mes);
  const sub = db.getSubrubro(req.params.subrubroId);
  const saldo_total = db.getSaldoTotal(req.params.subrubroId);
  res.json({ movimientos: movs, monto_base: sub?.monto_base ?? 0, saldo_total });
});

router.post('/:subrubroId', (req, res) => {
  try {
    const mov = db.createMovimiento(req.params.subrubroId, req.body);
    res.json(mov);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST pago vinculado a facturas específicas (con auto-ajuste si hay diferencia)
router.post('/:subrubroId/pago-vinculado', (req, res) => {
  try {
    const mov = db.crearPagoVinculado(req.params.subrubroId, req.body);
    res.json(mov);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const mov = db.updateMovimiento(req.params.id, req.body);
    res.json(mov);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT pago vinculado existente (borra ajuste anterior y recrea si hace falta)
router.put('/:id/pago-vinculado', (req, res) => {
  try {
    const mov = db.actualizarPagoVinculado(req.params.id, req.body);
    res.json(mov);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  db.deleteMovimiento(req.params.id);
  res.json({ ok: true });
});

// DELETE todos los movimientos de un subrubro
router.delete('/:subrubroId/movimientos', (req, res) => {
  try {
    const result = db.clearMovimientos(req.params.subrubroId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Export Excel de un subrubro
router.get('/export/:subrubroId', (req, res) => {
  const sub = db.getSubrubro(req.params.subrubroId);
  if (!sub) return res.status(404).json({ error: 'No encontrado' });

  const rubro = db.getRubro(sub.rubro_id);
  const campos = rubro ? db.getCampos(rubro.id) : [];
  const movs = db.getMovimientos(req.params.subrubroId);
  const wb = XLSX.utils.book_new();

  const porMes = {};
  for (const m of movs) {
    const key = m.fecha.substring(0, 7);
    if (!porMes[key]) porMes[key] = [];
    porMes[key].push(m);
  }

  for (const [mes, movsMes] of Object.entries(porMes).sort()) {
    let saldoAcum = sub.monto_base || 0;
    const rows = movsMes.map(m => {
      const camposSuma = new Set(campos.filter(c => c.tipo === 'suma').map(c => c.nombre));
      const camposResta = new Set(campos.filter(c => c.tipo === 'resta').map(c => c.nombre));
      const extra = m.campos_extra || {};
      let extraEfecto = 0;
      for (const [k, v] of Object.entries(extra)) {
        const n = Number(v);
        if (!isNaN(n)) {
          if (camposSuma.has(k)) extraEfecto += n;
          if (camposResta.has(k)) extraEfecto -= n;
        }
      }
      saldoAcum += (m.monto || 0) - (m.pago || 0) + extraEfecto;

      const tipoLabel = { factura: 'Factura', pago: 'Pago', nota_credito: 'Nota de Crédito', ajuste: 'Ajuste' }[m.tipo] || m.tipo;
      const row = {
        Fecha: m.fecha,
        Tipo: tipoLabel,
        Monto: m.monto || '',
        Pago: m.pago || '',
        Estado: m.tipo === 'factura' ? (m.pagado ? 'Pagada' : 'Pendiente') : '',
        Concepto: m.concepto || '',
        Total: saldoAcum,
      };
      for (const c of campos) {
        row[c.nombre] = extra[c.nombre] ?? '';
      }
      if (m.fecha_vencimiento) row['Vencimiento'] = m.fecha_vencimiento;
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, mes.substring(0, 31));
  }

  // Si no hay movimientos, agregar una hoja vacía con encabezados
  if (wb.SheetNames.length === 0) {
    const headers = ['Fecha', 'Tipo', 'Monto', 'Pago', 'Estado', 'Concepto', 'Total',
      ...campos.map(c => c.nombre)];
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sin movimientos');
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${sub.nombre}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// POST /import/:rubroId
router.post('/import/:rubroId', upload.single('file'), (req, res) => {
  try {
    const rubroId = Number(req.params.rubroId);
    const mapping = JSON.parse(req.body.mapping || '{}');
    const mode = req.body.mode || 'skip_duplicates';
    const sheetsFilter = req.body.sheets ? new Set(JSON.parse(req.body.sheets)) : null;

    // Agrupar todas las columnas por rol (varias hojas pueden tener distintos nombres para el mismo dato)
    // Las claves se normalizan a minúsculas+trim para hacer match independiente de mayúsculas
    const roleCols = {};   // role → [col_normalizada, ...]
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

    // Devuelve el primer valor no-nulo entre las columnas candidatas para un rol
    function getCol(row, role) {
      for (const c of (roleCols[role] || [])) {
        if (row[c] !== undefined && row[c] !== null) return row[c];
      }
      return null;
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const results = { sheets: [], totalCreated: 0, totalSkipped: 0 };

    // Cargar la base de datos UNA SOLA VEZ para todo el import
    const data = db.loadForBatch();
    const subrubroIdsAfectados = new Set();

    for (const sheetName of workbook.SheetNames.filter(n => !sheetsFilter || sheetsFilter.has(n))) {
      const sheet = workbook.Sheets[sheetName];
      // Normalizar claves de cada fila a minúsculas+trim para que coincidan con roleCols
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null })
        .map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v])));
      // Inferir años para fechas que solo tienen día y mes (prueba todas las columnas de fecha)
      const rows = inferirAniosSheet(rawRows, roleCols.fecha || []);

      if (rows.length === 0) {
        results.sheets.push({ name: sheetName, created: 0, skipped: 0, duplicates: 0 });
        continue;
      }

      // Buscar o crear subrubro dentro del data en memoria
      let subrubro = data.subrubros.find(
        s => s.rubro_id === rubroId && s.nombre.toLowerCase().trim() === sheetName.toLowerCase().trim()
      );
      if (!subrubro) {
        data._seq.subrubros = (data._seq.subrubros || 0) + 1;
        subrubro = {
          id: data._seq.subrubros,
          rubro_id: rubroId,
          nombre: sheetName.trim(),
          monto_base: 0,
          created_at: new Date().toLocaleString('sv').replace('T', ' ')
        };
        data.subrubros.push(subrubro);
      }

      if (mode === 'replace') {
        data.movimientos = data.movimientos.filter(m => m.subrubro_id !== subrubro.id);
      }

      // Índice rápido para detección de duplicados (sin releer archivo)
      const movsDelSub = data.movimientos.filter(m => m.subrubro_id === subrubro.id);
      const nrosExistentes = new Set(movsDelSub.map(m => m.campos_extra?.nro_factura).filter(Boolean));
      const fechaMontoExistentes = new Set(movsDelSub.filter(m => m.fecha).map(m => `${m.fecha}|${m.monto}`));

      let created = 0, skipped = 0, duplicates = 0;

      for (const row of rows) {
        const fecha = parseDate(getCol(row, 'fecha')) ?? null;
        const fecha_vencimiento = parseDate(getCol(row, 'fecha_vencimiento'));
        const pago = parseMonto(getCol(row, 'pago')) || 0;

        const montos = montoCols
          .map(col => ({ col, monto: parseMonto(row[col]) }))
          .filter(({ monto }) => monto !== null && monto > 0);

        const campos_extra = {};
        for (const { colName, campoNombre } of campoCols) {
          const v = row[colName];
          if (v !== null && v !== undefined && v !== '') {
            campos_extra[campoNombre] = toStr(v) || v;
          }
        }

        if (montos.length === 0 && pago === 0) { skipped++; continue; }

        if (montos.length > 0) {
          for (const { monto } of montos) {
            if (mode === 'skip_duplicates') {
              const nro = campos_extra.nro_factura;
              const isDup = nro
                ? nrosExistentes.has(nro)
                : (fecha ? fechaMontoExistentes.has(`${fecha}|${monto}`) : false);
              if (isDup) { duplicates++; continue; }
            }
            db._addMovImportBatch(data, subrubro.id, { monto, pago: 0, fecha, fecha_vencimiento, campos_extra });
            if (campos_extra.nro_factura) nrosExistentes.add(campos_extra.nro_factura);
            else if (fecha) fechaMontoExistentes.add(`${fecha}|${monto}`);
            created++;
          }
        }

        // Crear movimiento de pago SIEMPRE que pago > 0, aunque la fila también tenga monto
        if (pago > 0) {
          db._addMovImportBatch(data, subrubro.id, { monto: 0, pago, fecha, fecha_vencimiento, campos_extra: {} });
          created++;
        }
      }

      subrubroIdsAfectados.add(subrubro.id);
      results.sheets.push({ name: sheetName, created, skipped, duplicates });
      results.totalCreated += created;
      results.totalSkipped += duplicates;
    }

    // Guardar TODO de una sola vez al final
    db.saveFromBatch(data, [...subrubroIdsAfectados]);

    res.json(results);
  } catch (e) {
    console.error('Import error:', e);
    res.status(400).json({ error: e.message });
  }
});

function toStr(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s || null;
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val.toISOString().split('T')[0];
  }
  const str = String(val).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Nombres de meses en español para fechas tipo "17-ene", "26-may", etc.
const MESES_ES = {
  ene:1, feb:2, mar:3, abr:4, may:5, jun:6,
  jul:7, ago:8, sep:9, oct:10, nov:11, dic:12,
  jan:1, apr:4, aug:8, sep:9, oct:10, nov:11, dec:12
};

// Extrae { month, day } de un valor de fecha sin año ("17-ene", "17/1", "17/01").
// Devuelve null si ya tiene año o no se puede parsear.
function parsePartialDate(val) {
  if (!val || val instanceof Date) return null;
  const s = String(val).trim().toLowerCase();
  // Formato "17-ene", "17/may", "17 jul"
  const m1 = s.match(/^(\d{1,2})[-\/\s]([a-záéíóú]+)/);
  if (m1) {
    const month = MESES_ES[m1[2].substring(0, 3)];
    if (month) return { day: parseInt(m1[1]), month };
  }
  // Formato "17/01" o "17-01" (sin año)
  const m2 = s.match(/^(\d{1,2})[-\/](\d{1,2})$/);
  if (m2) return { day: parseInt(m2[1]), month: parseInt(m2[2]) };
  return null;
}

// Infiere el año para cada fila de un sheet cuando las fechas solo tienen día y mes.
// Algoritmo: la última fila con fecha = año actual. Subiendo fila a fila,
// si el mes "retrocede" respecto a la fila siguiente (más reciente), se asigna año - 1.
function inferirAniosSheet(rows, dateCols) {
  // Acepta string o array; encuentra la primera columna que tenga fechas parciales
  const candidates = Array.isArray(dateCols) ? dateCols : (dateCols ? [dateCols] : []);
  let dateCol = null;
  let parciales = null;
  for (const col of candidates) {
    const p = rows.map(r => parsePartialDate(r[col]));
    if (!p.every(x => x === null)) { dateCol = col; parciales = p; break; }
  }
  if (!dateCol) return rows;

  const aniosAsignados = new Array(rows.length).fill(null);
  const anioActual = new Date().getFullYear();

  // Último índice con fecha parcial → año actual
  let ultimoIdx = -1;
  for (let i = parciales.length - 1; i >= 0; i--) {
    if (parciales[i]) { ultimoIdx = i; break; }
  }
  if (ultimoIdx === -1) return rows;

  let anio = anioActual;
  aniosAsignados[ultimoIdx] = anio;

  // Recorrer hacia atrás desde ultimoIdx
  for (let i = ultimoIdx - 1; i >= 0; i--) {
    if (!parciales[i]) {
      aniosAsignados[i] = anio; // hereda el año de la fila siguiente
      continue;
    }
    // Buscar la fila siguiente más cercana con fecha parcial
    let mesSiguiente = null;
    for (let j = i + 1; j <= ultimoIdx; j++) {
      if (parciales[j]) { mesSiguiente = parciales[j].month; break; }
    }
    // Si el mes actual es mayor que el siguiente (más reciente), cruzamos año
    if (mesSiguiente !== null && parciales[i].month > mesSiguiente) {
      anio--;
    }
    aniosAsignados[i] = anio;
  }

  // Construir filas con fechas completas
  return rows.map((row, i) => {
    const p = parciales[i];
    if (!p) return row;
    const y = aniosAsignados[i] ?? anioActual;
    const fechaCompleta = `${y}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    return { ...row, [dateCol]: fechaCompleta };
  });
}

function parseMonto(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Math.abs(val);
  const str = String(val).replace(/[$\s]/g, '');
  const normalized = str.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(normalized);
  return isNaN(n) ? null : Math.abs(n);
}

module.exports = router;
