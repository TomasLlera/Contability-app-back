const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'contability.json');

const EMPTY_DB = {
  locales: [],
  rubros: [],
  campos_rubro: [],
  subrubros: [],
  movimientos: [],
  categorias_movimiento: [],
  import_configs: [],
  _seq: { locales: 0, rubros: 0, campos_rubro: 0, subrubros: 0, movimientos: 0, categorias_movimiento: 0 }
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY_DB, null, 2));
    return JSON.parse(JSON.stringify(EMPTY_DB));
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));

  if (!data.campos_rubro) data.campos_rubro = [];
  if (!data._seq.campos_rubro) data._seq.campos_rubro = 0;
  if (!data.import_configs) data.import_configs = [];

  // Migración: agregar locales si no existen
  if (!data.locales) data.locales = [];
  if (!data._seq.locales) data._seq.locales = 0;

  // Migración: asignar rubros sin local_id a un local "Principal"
  const orphans = data.rubros.filter(r => !r.local_id);
  if (orphans.length > 0) {
    let principal = data.locales.find(l => l.nombre === 'Principal');
    if (!principal) {
      data._seq.locales = (data._seq.locales || 0) + 1;
      principal = { id: data._seq.locales, nombre: 'Principal', icon: '🏠', created_at: now() };
      data.locales.push(principal);
    }
    orphans.forEach(r => { r.local_id = principal.id; });
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  }

  let needsSave = false;

  for (const m of data.movimientos) {
    // Migrar modelo viejo (categoria_id) al nuevo
    if (m.categoria_id !== undefined && m.monto === undefined) {
      const cat = (data.categorias_movimiento || []).find(c => c.id === m.categoria_id);
      if (cat?.operacion === 'aumento') {
        m.monto = m._monto_legacy || 0;
        m.pago = 0;
      } else {
        m.monto = 0;
        m.pago = m._monto_legacy || 0;
      }
      m.pagado = false;
      if (!m.campos_extra) m.campos_extra = {};
      if (m.nro_factura) m.campos_extra.nro_factura = m.nro_factura;
      if (m.descripcion) m.campos_extra.descripcion = m.descripcion;
      needsSave = true;
    }

    if (m.pagado === undefined) { m.pagado = false; needsSave = true; }
    if (!m.campos_extra) { m.campos_extra = {}; needsSave = true; }

    // Migrar al modelo con tipo
    if (!m.tipo) {
      if ((m.monto || 0) > 0) m.tipo = 'factura';
      else if ((m.pago || 0) > 0) m.tipo = 'pago';
      else m.tipo = 'factura';
      needsSave = true;
    }
    if (!m.facturas_vinculadas_ids) { m.facturas_vinculadas_ids = []; needsSave = true; }
    if (m.concepto === undefined) { m.concepto = ''; needsSave = true; }
    if (m._ajuste_pago_id === undefined) { m._ajuste_pago_id = null; needsSave = true; }
  }

  if (needsSave) fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  return data;
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function now() {
  return new Date().toLocaleString('sv').replace('T', ' ');
}

function nextId(data, table) {
  data._seq[table] = (data._seq[table] || 0) + 1;
  return data._seq[table];
}

// Recalcula el estado `pagado` de todas las facturas de un subrubro.
// 1. Links manuales: pagos/NC con facturas_vinculadas_ids marcan esas facturas como pagas.
// 2. FIFO: pagos libres (sin vinculación) se aplican a las facturas restantes más antiguas.
function recalcularPagos(data, subrubroId) {
  const iid = Number(subrubroId);
  const movs = data.movimientos
    .filter(m => m.subrubro_id === iid)
    .sort((a, b) => {
      if (!a.fecha && !b.fecha) return a.id - b.id;
      if (!a.fecha) return 1;
      if (!b.fecha) return -1;
      return a.fecha.localeCompare(b.fecha) || a.id - b.id;
    });

  // Reset pagado en facturas
  for (const m of movs) {
    if (m.tipo === 'factura') m.pagado = false;
  }

  // Paso 1: links manuales
  const idsManual = new Set();
  for (const m of movs) {
    if ((m.tipo === 'pago' || m.tipo === 'nota_credito') && m.facturas_vinculadas_ids?.length > 0) {
      for (const fid of m.facturas_vinculadas_ids) idsManual.add(Number(fid));
    }
  }
  for (const m of movs) {
    if (m.tipo === 'factura' && idsManual.has(m.id)) m.pagado = true;
  }

  // Paso 2: FIFO con pagos libres (sin vinculación)
  const pagosLibres = movs.filter(m =>
    (m.tipo === 'pago' || m.tipo === 'nota_credito') &&
    (!m.facturas_vinculadas_ids || m.facturas_vinculadas_ids.length === 0)
  );
  let libre = pagosLibres.reduce((s, m) => s + (m.pago || 0), 0);

  for (const m of movs) {
    if (m.tipo !== 'factura' || m.pagado) continue;
    if (Math.round(libre * 100) >= Math.round(m.monto * 100)) {
      m.pagado = true;
      libre -= m.monto;
    } else {
      break;
    }
  }
}

const db = {
  // --- LOCALES ---
  getLocales() {
    return load().locales.sort((a, b) => a.nombre.localeCompare(b.nombre));
  },
  createLocal(nombre, icon = '🏠') {
    const data = load();
    const id = nextId(data, 'locales');
    const local = { id, nombre, icon, created_at: now() };
    data.locales.push(local);
    save(data);
    return local;
  },
  updateLocal(id, nombre, icon) {
    const data = load();
    const l = data.locales.find(l => l.id === Number(id));
    if (l) {
      if (nombre !== undefined) l.nombre = nombre;
      if (icon !== undefined) l.icon = icon;
    }
    save(data);
  },
  deleteLocal(id) {
    const data = load();
    const iid = Number(id);
    const rubroIds = data.rubros.filter(r => r.local_id === iid).map(r => r.id);
    const subIds = data.subrubros.filter(s => rubroIds.includes(s.rubro_id)).map(s => s.id);
    data.movimientos = data.movimientos.filter(m => !subIds.includes(m.subrubro_id));
    data.subrubros = data.subrubros.filter(s => !rubroIds.includes(s.rubro_id));
    data.campos_rubro = data.campos_rubro.filter(c => !rubroIds.includes(c.rubro_id));
    data.categorias_movimiento = data.categorias_movimiento.filter(c => !rubroIds.includes(c.rubro_id));
    data.import_configs = data.import_configs.filter(c => !rubroIds.includes(c.rubro_id));
    data.rubros = data.rubros.filter(r => r.local_id !== iid);
    data.locales = data.locales.filter(l => l.id !== iid);
    save(data);
  },

  // --- RUBROS ---
  getRubros(localId) {
    const rubros = load().rubros.sort((a, b) => a.nombre.localeCompare(b.nombre));
    return localId !== undefined ? rubros.filter(r => r.local_id === Number(localId)) : rubros;
  },
  createRubro(nombre, localId) {
    const data = load();
    if (data.rubros.find(r => r.local_id === Number(localId) && r.nombre.toLowerCase() === nombre.toLowerCase()))
      throw new Error('El rubro ya existe en este local');
    const id = nextId(data, 'rubros');
    const rubro = { id, nombre, local_id: Number(localId), created_at: now() };
    data.rubros.push(rubro);
    save(data);
    return rubro;
  },
  updateRubro(id, nombre, icon) {
    const data = load();
    const r = data.rubros.find(r => r.id === Number(id));
    if (r) {
      if (nombre !== undefined) r.nombre = nombre;
      if (icon !== undefined) r.icon = icon;
    }
    save(data);
  },
  deleteRubro(id) {
    const data = load();
    const iid = Number(id);
    const subrubroIds = data.subrubros.filter(s => s.rubro_id === iid).map(s => s.id);
    data.movimientos = data.movimientos.filter(m => !subrubroIds.includes(m.subrubro_id));
    data.subrubros = data.subrubros.filter(s => s.rubro_id !== iid);
    data.campos_rubro = data.campos_rubro.filter(c => c.rubro_id !== iid);
    data.categorias_movimiento = data.categorias_movimiento.filter(c => c.rubro_id !== iid);
    data.import_configs = data.import_configs.filter(c => c.rubro_id !== iid);
    data.rubros = data.rubros.filter(r => r.id !== iid);
    save(data);
  },
  getRubro(id) {
    return load().rubros.find(r => r.id === Number(id));
  },

  // --- IMPORT CONFIGS ---
  getImportConfig(rubroId) {
    const data = load();
    return data.import_configs.find(c => c.rubro_id === Number(rubroId)) || null;
  },
  saveImportConfig(rubroId, mapping, mode) {
    const data = load();
    const idx = data.import_configs.findIndex(c => c.rubro_id === Number(rubroId));
    const cfg = { rubro_id: Number(rubroId), mapping, mode, updated_at: now() };
    if (idx >= 0) data.import_configs[idx] = cfg;
    else data.import_configs.push(cfg);
    save(data);
    return cfg;
  },

  // --- CAMPOS DE RUBRO ---
  getCampos(rubroId) {
    return load().campos_rubro
      .filter(c => c.rubro_id === Number(rubroId))
      .sort((a, b) => a.orden - b.orden);
  },
  createCampo(rubroId, nombre, tipo = 'texto', orden = 0) {
    const data = load();
    const id = nextId(data, 'campos_rubro');
    const campo = { id, rubro_id: Number(rubroId), nombre, tipo, orden: Number(orden) };
    data.campos_rubro.push(campo);
    save(data);
    return campo;
  },
  updateCampo(id, nombre, tipo, orden) {
    const data = load();
    const c = data.campos_rubro.find(c => c.id === Number(id));
    if (c) { c.nombre = nombre; c.tipo = tipo; if (orden !== undefined) c.orden = Number(orden); }
    save(data);
  },
  deleteCampo(id) {
    const data = load();
    data.campos_rubro = data.campos_rubro.filter(c => c.id !== Number(id));
    save(data);
  },

  // --- CATEGORIAS (compatibilidad) ---
  getCategorias(rubroId) {
    return load().categorias_movimiento.filter(c => c.rubro_id === Number(rubroId));
  },
  createCategoria(rubroId, nombre, operacion, tipo_calculo = 'fijo', porcentaje_default = null) {
    const data = load();
    const id = nextId(data, 'categorias_movimiento');
    const cat = { id, rubro_id: Number(rubroId), nombre, operacion, tipo_calculo, porcentaje_default: porcentaje_default ? Number(porcentaje_default) : null };
    data.categorias_movimiento.push(cat);
    save(data);
    return cat;
  },
  updateCategoria(id, nombre, operacion, tipo_calculo = 'fijo', porcentaje_default = null) {
    const data = load();
    const c = data.categorias_movimiento.find(c => c.id === Number(id));
    if (c) { c.nombre = nombre; c.operacion = operacion; c.tipo_calculo = tipo_calculo; c.porcentaje_default = porcentaje_default ? Number(porcentaje_default) : null; }
    save(data);
  },
  deleteCategoria(id) {
    const data = load();
    data.categorias_movimiento = data.categorias_movimiento.filter(c => c.id !== Number(id));
    save(data);
  },

  // --- SUBRUBROS ---
  getSubrubros(rubroId) {
    return load().subrubros.filter(s => s.rubro_id === Number(rubroId)).sort((a, b) => a.nombre.localeCompare(b.nombre));
  },
  createSubrubro(rubroId, nombre, montoBase = 0) {
    const data = load();
    const id = nextId(data, 'subrubros');
    const sub = { id, rubro_id: Number(rubroId), nombre, monto_base: Number(montoBase), created_at: now() };
    data.subrubros.push(sub);
    save(data);
    return sub;
  },
  updateSubrubro(id, nombre, montoBase, icon) {
    const data = load();
    const s = data.subrubros.find(s => s.id === Number(id));
    if (s) {
      if (nombre !== undefined) s.nombre = nombre;
      if (montoBase !== undefined) s.monto_base = Number(montoBase);
      if (icon !== undefined) s.icon = icon;
    }
    save(data);
  },
  deleteSubrubro(id) {
    const data = load();
    const iid = Number(id);
    data.movimientos = data.movimientos.filter(m => m.subrubro_id !== iid);
    data.subrubros = data.subrubros.filter(s => s.id !== iid);
    save(data);
  },
  getSubrubro(id) {
    return load().subrubros.find(s => s.id === Number(id));
  },

  // --- MOVIMIENTOS ---
  getMovimientos(subrubroId, anio, mes) {
    const data = load();
    let movs = data.movimientos.filter(m => m.subrubro_id === Number(subrubroId));
    if (anio && mes) {
      const prefix = `${anio}-${String(mes).padStart(2, '0')}`;
      movs = movs.filter(m => m.fecha?.startsWith(prefix));
    }
    return movs.sort((a, b) => {
      if (!a.fecha && !b.fecha) return a.id - b.id;
      if (!a.fecha) return 1;
      if (!b.fecha) return -1;
      return a.fecha.localeCompare(b.fecha) || a.id - b.id;
    });
  },

  createMovimiento(subrubroId, {
    monto = 0, pago = 0, fecha, fecha_vencimiento = null,
    campos_extra = {}, tipo, concepto = ''
  }) {
    const data = load();
    const sub = data.subrubros.find(s => s.id === Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');

    const tipoFinal = tipo || ((Number(monto) > 0) ? 'factura' : 'pago');

    const id = nextId(data, 'movimientos');
    const mov = {
      id,
      subrubro_id: Number(subrubroId),
      fecha,
      monto: Number(monto) || 0,
      pago: Number(pago) || 0,
      tipo: tipoFinal,
      facturas_vinculadas_ids: [],
      pagado: false,
      fecha_vencimiento: fecha_vencimiento || null,
      campos_extra: campos_extra || {},
      concepto: concepto || '',
      _ajuste_pago_id: null,
      created_at: now()
    };
    data.movimientos.push(mov);
    recalcularPagos(data, subrubroId);
    save(data);
    return mov;
  },

  updateMovimiento(id, {
    monto = 0, pago = 0, fecha, fecha_vencimiento = null,
    campos_extra = {}, tipo, concepto = ''
  }) {
    const data = load();
    const mov = data.movimientos.find(m => m.id === Number(id));
    if (!mov) throw new Error('Movimiento no encontrado');

    mov.monto = Number(monto) || 0;
    mov.pago = Number(pago) || 0;
    mov.fecha = fecha;
    mov.fecha_vencimiento = fecha_vencimiento || null;
    mov.campos_extra = campos_extra || {};
    if (tipo) mov.tipo = tipo;
    if (concepto !== undefined) mov.concepto = concepto;

    recalcularPagos(data, mov.subrubro_id);
    save(data);
    return mov;
  },

  deleteMovimiento(id) {
    const data = load();
    const mov = data.movimientos.find(m => m.id === Number(id));
    if (!mov) return;
    const subrubroId = mov.subrubro_id;
    // Si es un pago vinculado, borrar sus ajustes automáticos
    if (mov.tipo === 'pago' || mov.tipo === 'nota_credito') {
      data.movimientos = data.movimientos.filter(m => m._ajuste_pago_id !== Number(id));
    }
    data.movimientos = data.movimientos.filter(m => m.id !== Number(id));
    recalcularPagos(data, subrubroId);
    save(data);
  },

  clearMovimientos(subrubroId) {
    const data = load();
    const iid = Number(subrubroId);
    const sub = data.subrubros.find(s => s.id === iid);
    if (!sub) throw new Error('Subrubro no encontrado');
    const count = data.movimientos.filter(m => m.subrubro_id === iid).length;
    data.movimientos = data.movimientos.filter(m => m.subrubro_id !== iid);
    save(data);
    return { deleted: count };
  },

  clearAllMovimientos(rubroId) {
    const data = load();
    const rid = Number(rubroId);
    const subIds = new Set(data.subrubros.filter(s => s.rubro_id === rid).map(s => s.id));
    const count = data.movimientos.filter(m => subIds.has(m.subrubro_id)).length;
    data.movimientos = data.movimientos.filter(m => !subIds.has(m.subrubro_id));
    save(data);
    return { deleted: count };
  },

  // Crea un pago (o nota de crédito) con vinculación manual a facturas.
  // Si el monto del pago es menor al total de facturas seleccionadas,
  // genera automáticamente un registro de diferencia (ajuste).
  crearPagoVinculado(subrubroId, {
    fecha, monto_pago, tipo = 'pago',
    facturas_vinculadas_ids = [],
    concepto_diferencia = 'Diferencia',
    campos_extra = {}
  }) {
    const data = load();
    const sub = data.subrubros.find(s => s.id === Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');

    const idsNum = facturas_vinculadas_ids.map(Number);
    const facturas = data.movimientos.filter(m => idsNum.includes(m.id) && m.tipo === 'factura');
    const totalFacturas = facturas.reduce((s, f) => s + (f.monto || 0), 0);
    const diferencia = Math.round((totalFacturas - Number(monto_pago)) * 100) / 100;

    const id = nextId(data, 'movimientos');
    const pagoMov = {
      id,
      subrubro_id: Number(subrubroId),
      fecha,
      monto: 0,
      pago: Number(monto_pago),
      tipo,
      facturas_vinculadas_ids: idsNum,
      pagado: false,
      fecha_vencimiento: null,
      campos_extra: campos_extra || {},
      concepto: '',
      _ajuste_pago_id: null,
      created_at: now()
    };
    data.movimientos.push(pagoMov);

    // Si hay diferencia (pago < facturas), crear registro de ajuste automático
    if (diferencia > 0.005) {
      const ajusteId = nextId(data, 'movimientos');
      data.movimientos.push({
        id: ajusteId,
        subrubro_id: Number(subrubroId),
        fecha,
        monto: 0,
        pago: diferencia,
        tipo: 'ajuste',
        facturas_vinculadas_ids: [],
        _ajuste_pago_id: id,
        pagado: false,
        fecha_vencimiento: null,
        campos_extra: {},
        concepto: concepto_diferencia || 'Diferencia',
        created_at: now()
      });
    }

    recalcularPagos(data, subrubroId);
    save(data);
    return pagoMov;
  },

  // Actualiza un pago vinculado: borra el ajuste automático anterior y recrea si hace falta.
  actualizarPagoVinculado(movId, {
    fecha, monto_pago,
    facturas_vinculadas_ids = [],
    concepto_diferencia = 'Diferencia',
    campos_extra = {}
  }) {
    const data = load();
    const mov = data.movimientos.find(m => m.id === Number(movId));
    if (!mov) throw new Error('Movimiento no encontrado');

    // Borrar ajuste automático anterior
    data.movimientos = data.movimientos.filter(m => m._ajuste_pago_id !== Number(movId));

    const idsNum = facturas_vinculadas_ids.map(Number);
    const facturas = data.movimientos.filter(m => idsNum.includes(m.id) && m.tipo === 'factura');
    const totalFacturas = facturas.reduce((s, f) => s + (f.monto || 0), 0);
    const diferencia = Math.round((totalFacturas - Number(monto_pago)) * 100) / 100;

    mov.fecha = fecha;
    mov.pago = Number(monto_pago);
    mov.facturas_vinculadas_ids = idsNum;
    mov.campos_extra = campos_extra || {};

    if (diferencia > 0.005) {
      const ajusteId = nextId(data, 'movimientos');
      data.movimientos.push({
        id: ajusteId,
        subrubro_id: mov.subrubro_id,
        fecha,
        monto: 0,
        pago: diferencia,
        tipo: 'ajuste',
        facturas_vinculadas_ids: [],
        _ajuste_pago_id: Number(movId),
        pagado: false,
        fecha_vencimiento: null,
        campos_extra: {},
        concepto: concepto_diferencia || 'Diferencia',
        created_at: now()
      });
    }

    recalcularPagos(data, mov.subrubro_id);
    save(data);
    return mov;
  },

  getMovimientosByFechaMonto(subrubroId, fecha, monto) {
    return load().movimientos.filter(m =>
      m.subrubro_id === Number(subrubroId) &&
      m.fecha === fecha &&
      m.monto === Number(monto)
    );
  },

  getMovimientosByNroFactura(subrubroId, nroFactura) {
    return load().movimientos.filter(m =>
      m.subrubro_id === Number(subrubroId) &&
      m.campos_extra?.nro_factura === nroFactura
    );
  },

  getSaldoTotal(subrubroId) {
    const data = load();
    const sub = data.subrubros.find(s => s.id === Number(subrubroId));
    if (!sub) return null;

    const campos = data.campos_rubro.filter(c => c.rubro_id === sub.rubro_id);
    const camposSuma = new Set(campos.filter(c => c.tipo === 'suma').map(c => c.nombre));
    const camposResta = new Set(campos.filter(c => c.tipo === 'resta').map(c => c.nombre));

    const movs = data.movimientos.filter(m => m.subrubro_id === Number(subrubroId));
    let saldo = sub.monto_base || 0;
    for (const m of movs) {
      saldo += (m.monto || 0);
      saldo -= (m.pago || 0);
      const extra = m.campos_extra || {};
      for (const [k, v] of Object.entries(extra)) {
        const n = Number(v);
        if (!isNaN(n) && n !== 0) {
          if (camposSuma.has(k)) saldo += n;
          if (camposResta.has(k)) saldo -= n;
        }
      }
    }
    return saldo;
  },

  getVencimientos(diasAdelante = 30) {
    const data = load();
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    return data.movimientos
      .filter(m => m.fecha_vencimiento && m.tipo === 'factura')
      .map(m => {
        const venc = new Date(m.fecha_vencimiento + 'T00:00:00');
        const sub = data.subrubros.find(s => s.id === m.subrubro_id);
        const rubro = sub ? data.rubros.find(r => r.id === sub.rubro_id) : null;
        const diasRestantes = Math.ceil((venc - hoy) / (1000 * 60 * 60 * 24));
        return { ...m, subrubro: sub, rubro, dias_restantes: diasRestantes };
      })
      .filter(m => m.dias_restantes <= diasAdelante)
      .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));
  },

  // Versión batch: recibe el objeto data ya cargado, agrega sin guardar
  _addMovImportBatch(data, subrubroId, { monto = 0, pago = 0, fecha, fecha_vencimiento = null, campos_extra = {} }) {
    const tipo = (Number(monto) > 0) ? 'factura' : 'pago';
    const id = nextId(data, 'movimientos');
    const mov = {
      id,
      subrubro_id: Number(subrubroId),
      fecha,
      monto: Number(monto) || 0,
      pago: Number(pago) || 0,
      tipo,
      facturas_vinculadas_ids: [],
      pagado: false,
      fecha_vencimiento: fecha_vencimiento || null,
      campos_extra: campos_extra || {},
      concepto: '',
      _ajuste_pago_id: null,
      created_at: now()
    };
    data.movimientos.push(mov);
    return mov;
  },

  createMovimientoImport(subrubroId, movData) {
    const data = load();
    const sub = data.subrubros.find(s => s.id === Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');
    const mov = this._addMovImportBatch(data, subrubroId, movData);
    save(data);
    return mov;
  },

  recalcularPagosSub(subrubroId) {
    const data = load();
    recalcularPagos(data, subrubroId);
    save(data);
  },

  // Carga data una sola vez, devuelve { data, sub } para usar en import batch
  loadForBatch() {
    return load();
  },
  saveFromBatch(data, subrubroIds) {
    for (const id of subrubroIds) recalcularPagos(data, id);
    save(data);
  },

  getRawData() {
    return load();
  }
};

module.exports = db;
