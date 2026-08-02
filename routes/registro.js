const express = require('express');
const router = express.Router();
const { VentaSistema, TarjetaTransaccion, Counter } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');

const nowTs = () => new Date().toISOString();
const withId = doc => doc ? { ...doc, id: doc._id } : doc;

// Tipos de pago con tarjeta. El orden es el que usa el front para las 4 columnas.
const TIPOS = ['qr', 'debito', 'credito', 'prepaga'];

// Tipos de venta del sistema. El orden es el que usa el front para las 2 columnas.
const TIPOS_VENTA = ['ticket', 'facturado'];

const round2 = (n) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;

// IVA débito fiscal: se aplica directo sobre el total facturado (total × 0,21), no se
// despeja de un precio final (total ÷ 1,21 × 0,21) — es el criterio con el que se
// cargan los totales. Solo lo facturado lo genera; el ticket no.
const IVA_ALICUOTA = 0.21;
const ivaDe = (total) => round2((total || 0) * IVA_ALICUOTA);

// Umbral por debajo del cual dos totales se consideran iguales. Los totales salen de
// sumar decimales, así que exigir igualdad exacta marcaría diferencias que no
// existen: un peso es ruido de redondeo, no una venta sin registrar.
const TOLERANCIA = 1;

// --- Helpers de parseo/fechas ---------------------------------------------

// Normaliza a YYYY-MM-DD. Acepta 'YYYY-MM-DD' o DD/MM/AAAA. null si es inválida.
function parseFecha(value) {
  if (!value) return null;
  const s = value.toString().trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isNaN(new Date(`${s}T00:00:00Z`)) ? null : s;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// 'YYYY-MM' válido, o null.
const parseMes = (value) => (/^\d{4}-\d{2}$/.test(value || '') ? value : null);

function parseMonto(value) {
  if (value === undefined || value === null || value === '') return NaN;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return isNaN(n) ? NaN : n;
}

// Mes anterior a 'YYYY-MM'.
function mesAnterior(mes) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const diasDelMes = (mes) => {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const diaDe = (fecha) => Number(fecha.slice(8, 10));

const hoyStr = () => new Date().toISOString().slice(0, 10);

// Día en el que conviene abrir la carga: el SIGUIENTE al último que ya tiene datos,
// para retomar donde se dejó en vez de abrir siempre en hoy. Si se carga el 3 y lo
// último cargado es el 31, abre el 1.
// Topes: nunca un día futuro (se cae a hoy) y, si nunca se cargó nada, hoy.
function proximoDiaDeCarga(ultimaFecha) {
  if (!ultimaFecha) return hoyStr();
  const d = new Date(`${ultimaFecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const siguiente = d.toISOString().slice(0, 10);
  const hoy = hoyStr();
  return siguiente > hoy ? hoy : siguiente;
}

// Construye el handler de /proximo-dia para un modelo con campo `fecha`.
const proximoDiaHandler = (Model) => async (req, res, next) => {
  try {
    const ultimo = await Model.findOne({}, { fecha: 1 }).sort({ fecha: -1 }).lean();
    const fecha = proximoDiaDeCarga(ultimo?.fecha);
    res.json({ fecha, ultima_carga: ultimo?.fecha || null, hoy: hoyStr() });
  } catch (err) { next(err); }
};

// Diferencia absoluta + porcentual contra el mes anterior.
// pct = null cuando el mes anterior fue 0 (no existe variación porcentual sobre cero).
function comparar(actual, anterior) {
  const diferencia = actual - anterior;
  const pct = anterior ? (diferencia / anterior) * 100 : null;
  return { diferencia, porcentaje: pct };
}

// Cruce del total cobrado con tarjeta contra el total FACTURADO en Venta Sistema (el
// ticket queda afuera: no es facturación). La diferencia se lee SIEMPRE como
// tarjetas − facturado, así el signo dice de qué lado falta la carga.
//
// Que lo facturado supere a las tarjetas no siempre es un error (se puede facturar
// contra efectivo o transferencia), por eso la sugerencia de ese caso lo aclara en vez
// de dar por hecho que falta cargar algo.
function compararTotales(total_tarjetas, total_facturado) {
  const diferencia = round2(total_tarjetas - total_facturado);
  const base = Math.max(total_tarjetas, total_facturado);
  const porcentaje = base ? round2((diferencia / base) * 100) : null;

  if (total_tarjetas === 0 && total_facturado === 0) {
    return {
      diferencia: 0, porcentaje: null, alerta: false, estado: 'sin_datos',
      mensaje: 'Todavía no hay datos cargados en este mes',
      sugerencia: null,
    };
  }
  if (Math.abs(diferencia) <= TOLERANCIA) {
    return {
      diferencia, porcentaje, alerta: false, estado: 'coincide',
      mensaje: 'Coincide: lo cobrado con tarjeta está facturado',
      sugerencia: null,
    };
  }
  if (diferencia > 0) {
    return {
      diferencia, porcentaje, alerta: true, estado: 'faltan_en_sistema',
      mensaje: 'Hay ventas cobradas por tarjeta que no están facturadas',
      sugerencia: 'Revisá los cierres del mes: puede haber ventas cargadas como ticket que en realidad se facturaron, o facturación sin cargar en Registro → Venta Sistema.',
    };
  }
  return {
    diferencia, porcentaje, alerta: true, estado: 'faltan_en_tarjetas',
    mensaje: 'Hay ventas facturadas que no entraron por tarjeta',
    sugerencia: 'Puede ser facturación cobrada en efectivo o por transferencia (no pasa por tarjeta), o cargas de tarjeta pendientes.',
  };
}

// Semanas calendario del mes en bloques fijos de 7 días desde el día 1
// (S1 = 1-7, S2 = 8-14, …). Elegimos bloques fijos y no semanas ISO para que la
// comparación entre meses sea siempre contra el mismo rango de días.
function bloquesSemana(dias) {
  const out = [];
  for (let inicio = 1; inicio <= dias; inicio += 7) {
    out.push({ label: `S${out.length + 1}`, desde: inicio, hasta: Math.min(inicio + 6, dias) });
  }
  return out;
}

// =========================================================================
// VENTA SISTEMA
// =========================================================================

// Las ventas cargadas antes de que existiera el tipo no lo tienen guardado, y .lean()
// devuelve el documento crudo (no aplica los defaults de mongoose): se leen como
// 'ticket', el criterio conservador — no inventa IVA sobre facturación que nunca se
// declaró como tal. Se reclasifican editando la fila.
const tipoVenta = (v) => (TIPOS_VENTA.includes(v.tipo) ? v.tipo : 'ticket');

// Totales por tipo de venta. Siempre devuelve las 2 claves (aunque estén en 0) para
// que el front pueda renderizar las 2 columnas fijas.
function agruparVentasPorTipo(ventas) {
  const base = Object.fromEntries(TIPOS_VENTA.map(t => [t, { tipo: t, total: 0, cantidad: 0 }]));
  for (const v of ventas) {
    const g = base[tipoVenta(v)];
    g.total += v.monto || 0;
    g.cantidad += 1;
  }
  for (const t of TIPOS_VENTA) base[t].total = round2(base[t].total);
  return base;
}

// El total del mes/día es SIEMPRE ticket + facturado.
const totalVentasDe = (porTipo) => round2(TIPOS_VENTA.reduce((s, t) => s + porTipo[t].total, 0));

// Toda venta sale con `tipo` resuelto, así el front nunca tiene que adivinarlo.
const ventaOut = (v) => ({ ...withId(v), tipo: tipoVenta(v) });

// Acumulados de un conjunto de ventas: los 2 subtotales, el total (su suma) y el IVA
// 21% del facturado. Es la forma que consumen el día, el mes y el mes anterior.
function acumuladoVentas(ventas) {
  const por_tipo = agruparVentasPorTipo(ventas);
  const total_facturado = por_tipo.facturado.total;
  return {
    por_tipo,
    total: totalVentasDe(por_tipo),
    total_ticket: por_tipo.ticket.total,
    total_facturado,
    iva_21: ivaDe(total_facturado),
    alicuota: IVA_ALICUOTA,
  };
}

// GET /api/registro/ventas-sistema?mes=YYYY-MM — listado plano (sin mes = todas)
router.get('/ventas-sistema', async (req, res, next) => {
  try {
    const filtro = parseMes(req.query.mes) ? { mes: req.query.mes } : {};
    const ventas = await VentaSistema.find(filtro).sort({ fecha: -1, _id: -1 }).lean();
    res.json(ventas.map(ventaOut));
  } catch (err) { next(err); }
});

// GET /api/registro/ventas-sistema/dia/:fecha — 2 columnas (ticket/facturado), total
// consolidado, IVA del facturado y detalle.
// GET /api/registro/ventas-sistema/proximo-dia — día donde retomar la carga.
// Va ANTES de /dia/:fecha para que no lo capture ninguna ruta paramétrica.
router.get('/ventas-sistema/proximo-dia', proximoDiaHandler(VentaSistema));

router.get('/ventas-sistema/dia/:fecha', async (req, res, next) => {
  try {
    const fecha = parseFecha(req.params.fecha);
    if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
    const ventas = await VentaSistema.find({ fecha }).sort({ _id: -1 }).lean();
    res.json({
      fecha, ...acumuladoVentas(ventas),
      cantidad: ventas.length, ventas: ventas.map(ventaOut),
    });
  } catch (err) { next(err); }
});

// GET /api/registro/ventas-sistema/mes/:mes — acumulados, comparativa con el mes
// anterior, evolución diaria, quincenas, semanas y estadísticas.
router.get('/ventas-sistema/mes/:mes', async (req, res, next) => {
  try {
    const mes = parseMes(req.params.mes);
    if (!mes) return res.status(400).json({ error: 'Mes inválido (formato YYYY-MM)' });
    const prev = mesAnterior(mes);

    const [ventas, ventasPrev] = await Promise.all([
      VentaSistema.find({ mes }).sort({ fecha: 1, _id: 1 }).lean(),
      VentaSistema.find({ mes: prev }).lean(),
    ]);

    const acum = acumuladoVentas(ventas);
    const acumPrev = acumuladoVentas(ventasPrev);
    const total = acum.total;
    const totalPrev = acumPrev.total;

    // Serie diaria completa (días sin ventas van en 0) para que el gráfico no tenga
    // huecos. Cada día trae los 2 tipos por separado además del total, para poder
    // apilarlos en la evolución diaria.
    const dias = diasDelMes(mes);
    const serie = Array.from({ length: dias }, (_, i) => ({
      dia: i + 1, fecha: `${mes}-${String(i + 1).padStart(2, '0')}`,
      ...Object.fromEntries(TIPOS_VENTA.map(t => [t, 0])), total: 0,
    }));
    for (const v of ventas) {
      const d = serie[diaDe(v.fecha) - 1];
      d[tipoVenta(v)] += v.monto || 0;
      d.total += v.monto || 0;
    }

    const diasPrev = diasDelMes(prev);
    const seriePrev = Array.from({ length: diasPrev }, (_, i) => ({ dia: i + 1, total: 0 }));
    for (const v of ventasPrev) seriePrev[diaDe(v.fecha) - 1].total += v.monto || 0;

    const rango = (desde, hasta) => serie.slice(desde - 1, hasta).reduce((s, d) => s + d.total, 0);

    const quincenas = [
      { label: '1ª quincena', desde: 1, hasta: Math.min(15, dias), total: rango(1, Math.min(15, dias)) },
      { label: '2ª quincena', desde: 16, hasta: dias, total: dias > 15 ? rango(16, dias) : 0 },
    ];
    const semanas = bloquesSemana(dias).map(b => ({ ...b, total: rango(b.desde, b.hasta) }));

    const conVentas = serie.filter(d => d.total > 0);
    const stats = {
      dias_con_ventas: conVentas.length,
      // Promedio sobre los días que efectivamente tuvieron ventas (no sobre los 30/31
      // del mes): un mes a mitad de curso no queda diluido por los días futuros.
      promedio_diario: conVentas.length ? total / conVentas.length : 0,
      maximo: conVentas.length ? conVentas.reduce((a, b) => (b.total > a.total ? b : a)) : null,
      minimo: conVentas.length ? conVentas.reduce((a, b) => (b.total < a.total ? b : a)) : null,
      cantidad: ventas.length,
    };

    res.json({
      mes, cantidad: ventas.length,
      // total, total_ticket, total_facturado, iva_21 (21% del facturado), alicuota, por_tipo
      ...acum,
      mes_anterior: {
        mes: prev, total: totalPrev,
        total_ticket: acumPrev.total_ticket, total_facturado: acumPrev.total_facturado,
        iva_21: acumPrev.iva_21, serie: seriePrev,
      },
      comparativa: comparar(total, totalPrev),
      // Cada tipo contra el mismo tipo del mes anterior.
      comparativa_tipos: Object.fromEntries(TIPOS_VENTA.map(t => [
        t, {
          actual: acum.por_tipo[t].total, anterior: acumPrev.por_tipo[t].total,
          ...comparar(acum.por_tipo[t].total, acumPrev.por_tipo[t].total),
        },
      ])),
      serie, quincenas, semanas, stats,
      ventas: ventas.map(ventaOut),
    });
  } catch (err) { next(err); }
});

// POST /api/registro/ventas-sistema
router.post('/ventas-sistema', requireAdmin, audit('venta_sistema'), async (req, res, next) => {
  try {
    const fecha = parseFecha(req.body.fecha);
    const monto = parseMonto(req.body.monto);
    // Sin tipo explícito cae en 'ticket': es lo que no genera IVA, así que el default
    // nunca inventa débito fiscal.
    const tipo = (req.body.tipo || 'ticket').toString().trim().toLowerCase();
    if (!TIPOS_VENTA.includes(tipo)) return res.status(400).json({ error: `Tipo inválido (${TIPOS_VENTA.join(', ')})` });
    if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
    if (isNaN(monto) || monto <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });

    const id = await Counter.next('ventas_sistema');
    const venta = await VentaSistema.create({
      _id: id, tipo, fecha, mes: fecha.slice(0, 7), monto,
      concepto: (req.body.concepto || '').toString().trim(),
      user_id: req.user?.userId ?? null,
      created_at: nowTs(), updated_at: nowTs(),
    });
    res.json(ventaOut(venta.toObject()));
  } catch (err) { next(err); }
});

// PUT /api/registro/ventas-sistema/:id
router.put('/ventas-sistema/:id', requireAdmin, audit('venta_sistema'), async (req, res, next) => {
  try {
    const upd = { updated_at: nowTs() };
    if (req.body.tipo !== undefined) {
      const tipo = (req.body.tipo || '').toString().trim().toLowerCase();
      if (!TIPOS_VENTA.includes(tipo)) return res.status(400).json({ error: `Tipo inválido (${TIPOS_VENTA.join(', ')})` });
      upd.tipo = tipo;
    }
    if (req.body.fecha !== undefined) {
      const fecha = parseFecha(req.body.fecha);
      if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
      upd.fecha = fecha; upd.mes = fecha.slice(0, 7);
    }
    if (req.body.monto !== undefined) {
      const monto = parseMonto(req.body.monto);
      if (isNaN(monto) || monto <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
      upd.monto = monto;
    }
    if (req.body.concepto !== undefined) upd.concepto = (req.body.concepto || '').toString().trim();

    const venta = await VentaSistema.findByIdAndUpdate(Number(req.params.id), upd, { new: true }).lean();
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
    res.json(ventaOut(venta));
  } catch (err) { next(err); }
});

// DELETE /api/registro/ventas-sistema/:id
router.delete('/ventas-sistema/:id', requireAdmin, audit('venta_sistema'), async (req, res, next) => {
  try {
    const venta = await VentaSistema.findByIdAndDelete(Number(req.params.id));
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =========================================================================
// TARJETAS
// =========================================================================

// Totales por tipo a partir de una lista de transacciones. Siempre devuelve las 4
// claves (aunque estén en 0) para que el front pueda renderizar las 4 columnas fijas.
function agruparPorTipo(txs) {
  const base = Object.fromEntries(TIPOS.map(t => [t, { tipo: t, total: 0, transacciones: 0 }]));
  for (const t of txs) {
    const g = base[t.tipo];
    if (!g) continue;
    g.total += t.monto || 0;
    g.transacciones += 1;
  }
  return base;
}

// Totales por empleado (para saber de quién fue cada ingreso). Los registros sin
// empleado cargado caen en 'Sin asignar'.
function agruparPorEmpleado(txs) {
  const map = {};
  for (const t of txs) {
    const nombre = (t.empleado || '').trim() || 'Sin asignar';
    const g = (map[nombre] ||= { empleado: nombre, total: 0, transacciones: 0, ...Object.fromEntries(TIPOS.map(x => [x, 0])) });
    g.total += t.monto || 0;
    g.transacciones += 1;
    if (TIPOS.includes(t.tipo)) g[t.tipo] += t.monto || 0;
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
}

const totalDe = (porTipo) => TIPOS.reduce((s, t) => s + porTipo[t].total, 0);

// GET /api/registro/tarjetas?mes=YYYY-MM — listado plano
router.get('/tarjetas', async (req, res, next) => {
  try {
    const filtro = parseMes(req.query.mes) ? { mes: req.query.mes } : {};
    const txs = await TarjetaTransaccion.find(filtro).sort({ fecha: -1, _id: -1 }).lean();
    res.json(txs.map(withId));
  } catch (err) { next(err); }
});

// GET /api/registro/tarjetas/dia/:fecha — 4 columnas + total consolidado + detalle
// GET /api/registro/tarjetas/proximo-dia — día donde retomar la carga.
router.get('/tarjetas/proximo-dia', proximoDiaHandler(TarjetaTransaccion));

router.get('/tarjetas/dia/:fecha', async (req, res, next) => {
  try {
    const fecha = parseFecha(req.params.fecha);
    if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
    const txs = await TarjetaTransaccion.find({ fecha }).sort({ _id: -1 }).lean();
    const por_tipo = agruparPorTipo(txs);
    const total = totalDe(por_tipo);
    res.json({
      fecha, por_tipo, total,
      por_empleado: agruparPorEmpleado(txs),
      transacciones: txs.map(withId),
    });
  } catch (err) { next(err); }
});

// GET /api/registro/tarjetas/mes/:mes — acumulado por tipo, comparativa con el mes
// anterior y serie diaria apilada (una entrada por día con las 4 categorías).
router.get('/tarjetas/mes/:mes', async (req, res, next) => {
  try {
    const mes = parseMes(req.params.mes);
    if (!mes) return res.status(400).json({ error: 'Mes inválido (formato YYYY-MM)' });
    const prev = mesAnterior(mes);

    const [txs, txsPrev] = await Promise.all([
      TarjetaTransaccion.find({ mes }).sort({ fecha: 1, _id: 1 }).lean(),
      TarjetaTransaccion.find({ mes: prev }).lean(),
    ]);

    const por_tipo = agruparPorTipo(txs);
    const por_tipo_prev = agruparPorTipo(txsPrev);
    const total = totalDe(por_tipo);
    const totalPrev = totalDe(por_tipo_prev);

    const dias = diasDelMes(mes);
    const serie = Array.from({ length: dias }, (_, i) => ({
      dia: i + 1, fecha: `${mes}-${String(i + 1).padStart(2, '0')}`,
      ...Object.fromEntries(TIPOS.map(t => [t, 0])), total: 0,
    }));
    for (const t of txs) {
      const d = serie[diaDe(t.fecha) - 1];
      if (!d || !TIPOS.includes(t.tipo)) continue;
      d[t.tipo] += t.monto || 0;
      d.total += t.monto || 0;
    }

    // Comparativa por tipo: cada tipo contra el mismo tipo del mes anterior.
    const comparativa_tipos = Object.fromEntries(TIPOS.map(t => [
      t, { actual: por_tipo[t].total, anterior: por_tipo_prev[t].total, ...comparar(por_tipo[t].total, por_tipo_prev[t].total) },
    ]));

    res.json({
      mes, total, por_tipo,
      mes_anterior: { mes: prev, total: totalPrev, por_tipo: por_tipo_prev },
      comparativa: comparar(total, totalPrev),
      comparativa_tipos,
      por_empleado: agruparPorEmpleado(txs),
      serie,
      transacciones: txs.map(withId),
    });
  } catch (err) { next(err); }
});

// POST /api/registro/tarjetas
router.post('/tarjetas', requireAdmin, audit('tarjeta'), async (req, res, next) => {
  try {
    const tipo = (req.body.tipo || '').toString().trim().toLowerCase();
    const fecha = parseFecha(req.body.fecha);
    const monto = parseMonto(req.body.monto);
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: `Tipo inválido (${TIPOS.join(', ')})` });
    if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
    if (isNaN(monto) || monto <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });

    const id = await Counter.next('tarjetas');
    const tx = await TarjetaTransaccion.create({
      _id: id, tipo, fecha, mes: fecha.slice(0, 7), monto,
      empleado: (req.body.empleado || '').toString().trim(),
      user_id: req.user?.userId ?? null,
      // retencion_pct / monto_neto / fecha_acreditacion quedan en null a propósito:
      // la infraestructura está lista pero la lógica todavía no se activó (ver models.js).
      created_at: nowTs(), updated_at: nowTs(),
    });
    res.json(withId(tx.toObject()));
  } catch (err) { next(err); }
});

// PUT /api/registro/tarjetas/:id
router.put('/tarjetas/:id', requireAdmin, audit('tarjeta'), async (req, res, next) => {
  try {
    const upd = { updated_at: nowTs() };
    if (req.body.tipo !== undefined) {
      const tipo = (req.body.tipo || '').toString().trim().toLowerCase();
      if (!TIPOS.includes(tipo)) return res.status(400).json({ error: `Tipo inválido (${TIPOS.join(', ')})` });
      upd.tipo = tipo;
    }
    if (req.body.fecha !== undefined) {
      const fecha = parseFecha(req.body.fecha);
      if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
      upd.fecha = fecha; upd.mes = fecha.slice(0, 7);
    }
    if (req.body.monto !== undefined) {
      const monto = parseMonto(req.body.monto);
      if (isNaN(monto) || monto <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
      upd.monto = monto;
    }
    if (req.body.empleado !== undefined) upd.empleado = (req.body.empleado || '').toString().trim();

    const tx = await TarjetaTransaccion.findByIdAndUpdate(Number(req.params.id), upd, { new: true }).lean();
    if (!tx) return res.status(404).json({ error: 'Transacción no encontrada' });
    res.json(withId(tx));
  } catch (err) { next(err); }
});

// DELETE /api/registro/tarjetas/:id
router.delete('/tarjetas/:id', requireAdmin, audit('tarjeta'), async (req, res, next) => {
  try {
    const tx = await TarjetaTransaccion.findByIdAndDelete(Number(req.params.id));
    if (!tx) return res.status(404).json({ error: 'Transacción no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =========================================================================
// COMPARATIVA MENSUAL — Facturado vs Tarjetas
// =========================================================================

// GET /api/registro/comparativa-ventas/:mes  (mes = 'YYYY-MM')
//
// Cruza el total FACTURADO del mes en Venta Sistema contra el total cobrado con
// tarjeta, para verificar si lo que se facturó se condice con lo que efectivamente
// entró por tarjeta. El ticket queda fuera del cruce (no es facturación) pero se
// informa aparte, porque una diferencia suele explicarse justo ahí: ventas cobradas
// con tarjeta que quedaron cargadas como ticket.
//
// Incluye el detalle por día: una diferencia mensual grande suele concentrarse en
// pocas jornadas, y el desglose es lo que permite ubicarlas.
router.get('/comparativa-ventas/:mes', async (req, res, next) => {
  try {
    const mes = parseMes(req.params.mes);
    if (!mes) return res.status(400).json({ error: 'Mes inválido (formato YYYY-MM)' });

    const [txs, ventas] = await Promise.all([
      TarjetaTransaccion.find({ mes }, { monto: 1, tipo: 1, fecha: 1 }).lean(),
      VentaSistema.find({ mes }, { monto: 1, tipo: 1, fecha: 1 }).lean(),
    ]);

    const por_tipo = agruparPorTipo(txs);
    const total_tarjetas = round2(totalDe(por_tipo));
    const acum = acumuladoVentas(ventas);
    const total_facturado = acum.total_facturado;

    // Serie diaria completa (los días sin movimiento van en 0) para que el desglose
    // acompañe al calendario del mes y no salte días.
    const dias = diasDelMes(mes);
    const por_dia = Array.from({ length: dias }, (_, i) => ({
      dia: i + 1, fecha: `${mes}-${String(i + 1).padStart(2, '0')}`,
      total_facturado: 0, total_ticket: 0, total_tarjetas: 0,
    }));
    for (const t of txs) por_dia[diaDe(t.fecha) - 1].total_tarjetas += t.monto || 0;
    for (const v of ventas) {
      const d = por_dia[diaDe(v.fecha) - 1];
      if (tipoVenta(v) === 'facturado') d.total_facturado += v.monto || 0;
      else d.total_ticket += v.monto || 0;
    }
    for (const d of por_dia) {
      d.total_facturado = round2(d.total_facturado);
      d.total_ticket = round2(d.total_ticket);
      d.total_tarjetas = round2(d.total_tarjetas);
      d.diferencia = round2(d.total_tarjetas - d.total_facturado);
    }

    res.json({
      mes, anio: Number(mes.slice(0, 4)), tolerancia: TOLERANCIA,
      // Los dos números del cruce.
      total_facturado, total_tarjetas,
      venta_sistema: {
        total: acum.total, total_ticket: acum.total_ticket, total_facturado,
        iva_21: acum.iva_21, cantidad: ventas.length,
      },
      tarjetas: { total: total_tarjetas, transacciones: txs.length, por_tipo },
      ...compararTotales(total_tarjetas, total_facturado),
      por_dia,
    });
  } catch (err) { next(err); }
});

module.exports = router;
