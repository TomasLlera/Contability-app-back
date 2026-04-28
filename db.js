const { Counter, Local, Rubro, Subrubro, Movimiento, Campo, Categoria, ImportConfig } = require('./models');

function now() {
  return new Date().toLocaleString('sv').replace('T', ' ');
}

async function recalcularPagos(subrubroId) {
  const iid = Number(subrubroId);
  const movs = await Movimiento.find({ subrubro_id: iid }).lean();

  movs.sort((a, b) => {
    if (!a.fecha && !b.fecha) return a._id - b._id;
    if (!a.fecha) return 1;
    if (!b.fecha) return -1;
    return a.fecha.localeCompare(b.fecha) || a._id - b._id;
  });

  const pagadoNuevo = {};
  for (const m of movs) {
    if (m.tipo === 'factura') pagadoNuevo[m._id] = false;
  }

  const idsManual = new Set();
  for (const m of movs) {
    if ((m.tipo === 'pago' || m.tipo === 'nota_credito') && m.facturas_vinculadas_ids?.length > 0) {
      for (const fid of m.facturas_vinculadas_ids) idsManual.add(Number(fid));
    }
  }
  for (const m of movs) {
    if (m.tipo === 'factura' && idsManual.has(m._id)) pagadoNuevo[m._id] = true;
  }

  const pagosLibres = movs.filter(m =>
    (m.tipo === 'pago' || m.tipo === 'nota_credito') &&
    (!m.facturas_vinculadas_ids || m.facturas_vinculadas_ids.length === 0)
  );
  let libre = pagosLibres.reduce((s, m) => s + (m.pago || 0), 0);

  for (const m of movs) {
    if (m.tipo !== 'factura' || pagadoNuevo[m._id]) continue;
    if (Math.round(libre * 100) >= Math.round(m.monto * 100)) {
      pagadoNuevo[m._id] = true;
      libre -= m.monto;
    } else {
      break;
    }
  }

  const bulkOps = Object.entries(pagadoNuevo).map(([id, pagado]) => ({
    updateOne: { filter: { _id: Number(id) }, update: { $set: { pagado } } }
  }));
  if (bulkOps.length > 0) await Movimiento.bulkWrite(bulkOps);
}

const db = {
  // --- LOCALES ---
  async getLocales() {
    return Local.find().sort({ nombre: 1 }).lean();
  },
  async createLocal(nombre, icon = '🏠') {
    const id = await Counter.next('locales');
    return Local.create({ _id: id, nombre, icon, created_at: now() });
  },
  async updateLocal(id, nombre, icon) {
    const upd = {};
    if (nombre !== undefined) upd.nombre = nombre;
    if (icon !== undefined) upd.icon = icon;
    await Local.findByIdAndUpdate(Number(id), upd);
  },
  async deleteLocal(id) {
    const iid = Number(id);
    const rubros = await Rubro.find({ local_id: iid }, { _id: 1 }).lean();
    const rubroIds = rubros.map(r => r._id);
    const subs = await Subrubro.find({ rubro_id: { $in: rubroIds } }, { _id: 1 }).lean();
    const subIds = subs.map(s => s._id);
    await Movimiento.deleteMany({ subrubro_id: { $in: subIds } });
    await Subrubro.deleteMany({ rubro_id: { $in: rubroIds } });
    await Campo.deleteMany({ rubro_id: { $in: rubroIds } });
    await Categoria.deleteMany({ rubro_id: { $in: rubroIds } });
    await ImportConfig.deleteMany({ rubro_id: { $in: rubroIds } });
    await Rubro.deleteMany({ local_id: iid });
    await Local.findByIdAndDelete(iid);
  },

  // --- RUBROS ---
  async getRubros(localId) {
    const filter = localId !== undefined ? { local_id: Number(localId) } : {};
    return Rubro.find(filter).sort({ nombre: 1 }).lean();
  },
  async createRubro(nombre, localId) {
    const existing = await Rubro.findOne({ local_id: Number(localId), nombre: { $regex: new RegExp(`^${nombre}$`, 'i') } });
    if (existing) throw new Error('El rubro ya existe en este local');
    const id = await Counter.next('rubros');
    return Rubro.create({ _id: id, nombre, local_id: Number(localId), created_at: now() });
  },
  async updateRubro(id, nombre, icon) {
    const upd = {};
    if (nombre !== undefined) upd.nombre = nombre;
    if (icon !== undefined) upd.icon = icon;
    await Rubro.findByIdAndUpdate(Number(id), upd);
  },
  async deleteRubro(id) {
    const iid = Number(id);
    const subs = await Subrubro.find({ rubro_id: iid }, { _id: 1 }).lean();
    const subIds = subs.map(s => s._id);
    await Movimiento.deleteMany({ subrubro_id: { $in: subIds } });
    await Subrubro.deleteMany({ rubro_id: iid });
    await Campo.deleteMany({ rubro_id: iid });
    await Categoria.deleteMany({ rubro_id: iid });
    await ImportConfig.deleteMany({ rubro_id: iid });
    await Rubro.findByIdAndDelete(iid);
  },
  async getRubro(id) {
    return Rubro.findById(Number(id)).lean();
  },

  // --- IMPORT CONFIGS ---
  async getImportConfig(rubroId) {
    return ImportConfig.findOne({ rubro_id: Number(rubroId) }).lean();
  },
  async saveImportConfig(rubroId, mapping, mode) {
    const cfg = { rubro_id: Number(rubroId), mapping, mode, updated_at: now() };
    await ImportConfig.findOneAndUpdate({ rubro_id: Number(rubroId) }, cfg, { upsert: true });
    return cfg;
  },

  // --- CAMPOS ---
  async getCampos(rubroId) {
    return Campo.find({ rubro_id: Number(rubroId) }).sort({ orden: 1 }).lean();
  },
  async createCampo(rubroId, nombre, tipo = 'texto', orden = 0) {
    const id = await Counter.next('campos_rubro');
    return Campo.create({ _id: id, rubro_id: Number(rubroId), nombre, tipo, orden: Number(orden) });
  },
  async updateCampo(id, nombre, tipo, orden) {
    const upd = { nombre, tipo };
    if (orden !== undefined) upd.orden = Number(orden);
    await Campo.findByIdAndUpdate(Number(id), upd);
  },
  async deleteCampo(id) {
    await Campo.findByIdAndDelete(Number(id));
  },

  // --- CATEGORIAS ---
  async getCategorias(rubroId) {
    return Categoria.find({ rubro_id: Number(rubroId) }).lean();
  },
  async createCategoria(rubroId, nombre, operacion, tipo_calculo = 'fijo', porcentaje_default = null) {
    const id = await Counter.next('categorias_movimiento');
    return Categoria.create({ _id: id, rubro_id: Number(rubroId), nombre, operacion, tipo_calculo, porcentaje_default: porcentaje_default ? Number(porcentaje_default) : null });
  },
  async updateCategoria(id, nombre, operacion, tipo_calculo = 'fijo', porcentaje_default = null) {
    await Categoria.findByIdAndUpdate(Number(id), { nombre, operacion, tipo_calculo, porcentaje_default: porcentaje_default ? Number(porcentaje_default) : null });
  },
  async deleteCategoria(id) {
    await Categoria.findByIdAndDelete(Number(id));
  },

  // --- SUBRUBROS ---
  async getSubrubros(rubroId) {
    return Subrubro.find({ rubro_id: Number(rubroId) }).sort({ nombre: 1 }).lean();
  },
  async createSubrubro(rubroId, nombre, montoBase = 0) {
    const id = await Counter.next('subrubros');
    return Subrubro.create({ _id: id, rubro_id: Number(rubroId), nombre, monto_base: Number(montoBase), created_at: now() });
  },
  async updateSubrubro(id, nombre, montoBase, icon) {
    const upd = {};
    if (nombre !== undefined) upd.nombre = nombre;
    if (montoBase !== undefined) upd.monto_base = Number(montoBase);
    if (icon !== undefined) upd.icon = icon;
    await Subrubro.findByIdAndUpdate(Number(id), upd);
  },
  async deleteSubrubro(id) {
    const iid = Number(id);
    await Movimiento.deleteMany({ subrubro_id: iid });
    await Subrubro.findByIdAndDelete(iid);
  },
  async getSubrubro(id) {
    return Subrubro.findById(Number(id)).lean();
  },

  // --- MOVIMIENTOS ---
  async getMovimientos(subrubroId, anio, mes) {
    const filter = { subrubro_id: Number(subrubroId) };
    if (anio && mes) {
      const prefix = `${anio}-${String(mes).padStart(2, '0')}`;
      filter.fecha = { $regex: `^${prefix}` };
    }
    const movs = await Movimiento.find(filter).lean();
    return movs.sort((a, b) => {
      if (!a.fecha && !b.fecha) return a._id - b._id;
      if (!a.fecha) return 1;
      if (!b.fecha) return -1;
      return a.fecha.localeCompare(b.fecha) || a._id - b._id;
    });
  },

  async createMovimiento(subrubroId, { monto = 0, pago = 0, fecha, fecha_vencimiento = null, campos_extra = {}, tipo, concepto = '' }) {
    const sub = await Subrubro.findById(Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');
    const tipoFinal = tipo || (Number(monto) > 0 ? 'factura' : 'pago');
    const id = await Counter.next('movimientos');
    await Movimiento.create({
      _id: id, subrubro_id: Number(subrubroId), fecha,
      monto: Number(monto) || 0, pago: Number(pago) || 0,
      tipo: tipoFinal, facturas_vinculadas_ids: [], pagado: false,
      fecha_vencimiento: fecha_vencimiento || null,
      campos_extra: campos_extra || {}, concepto: concepto || '',
      _ajuste_pago_id: null, created_at: now()
    });
    await recalcularPagos(subrubroId);
    return Movimiento.findById(id).lean();
  },

  async updateMovimiento(id, { monto = 0, pago = 0, fecha, fecha_vencimiento = null, campos_extra = {}, tipo, concepto = '' }) {
    const mov = await Movimiento.findById(Number(id));
    if (!mov) throw new Error('Movimiento no encontrado');
    mov.monto = Number(monto) || 0;
    mov.pago = Number(pago) || 0;
    mov.fecha = fecha;
    mov.fecha_vencimiento = fecha_vencimiento || null;
    mov.campos_extra = campos_extra || {};
    if (tipo) mov.tipo = tipo;
    if (concepto !== undefined) mov.concepto = concepto;
    await mov.save();
    await recalcularPagos(mov.subrubro_id);
    return mov.toObject();
  },

  async deleteMovimiento(id) {
    const mov = await Movimiento.findById(Number(id));
    if (!mov) return;
    const subrubroId = mov.subrubro_id;
    if (mov.tipo === 'pago' || mov.tipo === 'nota_credito') {
      await Movimiento.deleteMany({ _ajuste_pago_id: Number(id) });
    }
    await Movimiento.findByIdAndDelete(Number(id));
    await recalcularPagos(subrubroId);
  },

  async clearMovimientos(subrubroId) {
    const iid = Number(subrubroId);
    const sub = await Subrubro.findById(iid);
    if (!sub) throw new Error('Subrubro no encontrado');
    const { deletedCount } = await Movimiento.deleteMany({ subrubro_id: iid });
    return { deleted: deletedCount };
  },

  async clearAllMovimientos(rubroId) {
    const rid = Number(rubroId);
    const subs = await Subrubro.find({ rubro_id: rid }, { _id: 1 }).lean();
    const subIds = subs.map(s => s._id);
    const { deletedCount } = await Movimiento.deleteMany({ subrubro_id: { $in: subIds } });
    return { deleted: deletedCount };
  },

  async crearPagoVinculado(subrubroId, { fecha, monto_pago, tipo = 'pago', facturas_vinculadas_ids = [], concepto_diferencia = 'Diferencia', campos_extra = {} }) {
    const sub = await Subrubro.findById(Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');
    const idsNum = facturas_vinculadas_ids.map(Number);
    const facturas = await Movimiento.find({ _id: { $in: idsNum }, tipo: 'factura' }).lean();
    const totalFacturas = facturas.reduce((s, f) => s + (f.monto || 0), 0);
    const diferencia = Math.round((totalFacturas - Number(monto_pago)) * 100) / 100;

    const id = await Counter.next('movimientos');
    await Movimiento.create({
      _id: id, subrubro_id: Number(subrubroId), fecha,
      monto: 0, pago: Number(monto_pago), tipo,
      facturas_vinculadas_ids: idsNum, pagado: false,
      fecha_vencimiento: null, campos_extra: campos_extra || {},
      concepto: '', _ajuste_pago_id: null, created_at: now()
    });

    if (diferencia > 0.005) {
      const ajusteId = await Counter.next('movimientos');
      await Movimiento.create({
        _id: ajusteId, subrubro_id: Number(subrubroId), fecha,
        monto: 0, pago: diferencia, tipo: 'ajuste',
        facturas_vinculadas_ids: [], _ajuste_pago_id: id,
        pagado: false, fecha_vencimiento: null, campos_extra: {},
        concepto: concepto_diferencia || 'Diferencia', created_at: now()
      });
    }

    await recalcularPagos(subrubroId);
    return Movimiento.findById(id).lean();
  },

  async actualizarPagoVinculado(movId, { fecha, monto_pago, facturas_vinculadas_ids = [], concepto_diferencia = 'Diferencia', campos_extra = {} }) {
    const mov = await Movimiento.findById(Number(movId));
    if (!mov) throw new Error('Movimiento no encontrado');
    await Movimiento.deleteMany({ _ajuste_pago_id: Number(movId) });

    const idsNum = facturas_vinculadas_ids.map(Number);
    const facturas = await Movimiento.find({ _id: { $in: idsNum }, tipo: 'factura' }).lean();
    const totalFacturas = facturas.reduce((s, f) => s + (f.monto || 0), 0);
    const diferencia = Math.round((totalFacturas - Number(monto_pago)) * 100) / 100;

    mov.fecha = fecha;
    mov.pago = Number(monto_pago);
    mov.facturas_vinculadas_ids = idsNum;
    mov.campos_extra = campos_extra || {};
    await mov.save();

    if (diferencia > 0.005) {
      const ajusteId = await Counter.next('movimientos');
      await Movimiento.create({
        _id: ajusteId, subrubro_id: mov.subrubro_id, fecha,
        monto: 0, pago: diferencia, tipo: 'ajuste',
        facturas_vinculadas_ids: [], _ajuste_pago_id: Number(movId),
        pagado: false, fecha_vencimiento: null, campos_extra: {},
        concepto: concepto_diferencia || 'Diferencia', created_at: now()
      });
    }

    await recalcularPagos(mov.subrubro_id);
    return mov.toObject();
  },

  async getSaldoTotal(subrubroId) {
    const sub = await Subrubro.findById(Number(subrubroId)).lean();
    if (!sub) return null;
    const campos = await Campo.find({ rubro_id: sub.rubro_id }).lean();
    const camposSuma = new Set(campos.filter(c => c.tipo === 'suma').map(c => c.nombre));
    const camposResta = new Set(campos.filter(c => c.tipo === 'resta').map(c => c.nombre));
    const movs = await Movimiento.find({ subrubro_id: Number(subrubroId) }).lean();
    let saldo = sub.monto_base || 0;
    for (const m of movs) {
      saldo += (m.monto || 0);
      saldo -= (m.pago || 0);
      for (const [k, v] of Object.entries(m.campos_extra || {})) {
        const n = Number(v);
        if (!isNaN(n) && n !== 0) {
          if (camposSuma.has(k)) saldo += n;
          if (camposResta.has(k)) saldo -= n;
        }
      }
    }
    return saldo;
  },

  async getVencimientos(diasAdelante = 30) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const movs = await Movimiento.find({ fecha_vencimiento: { $exists: true, $ne: null }, tipo: 'factura' }).lean();
    const subIds = [...new Set(movs.map(m => m.subrubro_id))];
    const subs = await Subrubro.find({ _id: { $in: subIds } }).lean();
    const rubroIds = [...new Set(subs.map(s => s.rubro_id))];
    const rubros = await Rubro.find({ _id: { $in: rubroIds } }).lean();
    const subMap = Object.fromEntries(subs.map(s => [s._id, s]));
    const rubroMap = Object.fromEntries(rubros.map(r => [r._id, r]));
    return movs
      .map(m => {
        const venc = new Date(m.fecha_vencimiento + 'T00:00:00');
        const diasRestantes = Math.ceil((venc - hoy) / (1000 * 60 * 60 * 24));
        const sub = subMap[m.subrubro_id];
        const rubro = sub ? rubroMap[sub.rubro_id] : null;
        return { ...m, subrubro: sub, rubro, dias_restantes: diasRestantes };
      })
      .filter(m => m.dias_restantes <= diasAdelante)
      .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));
  },

  // --- IMPORT BATCH ---
  async findOrCreateSubrubroForImport(rubroId, nombre) {
    const n = nombre.trim();
    let sub = await Subrubro.findOne({ rubro_id: Number(rubroId), nombre: { $regex: new RegExp(`^${n}$`, 'i') } }).lean();
    if (!sub) {
      const id = await Counter.next('subrubros');
      sub = await Subrubro.create({ _id: id, rubro_id: Number(rubroId), nombre: n, monto_base: 0, created_at: now() });
      sub = sub.toObject();
    }
    return sub;
  },

  async getMovsForDedup(subrubroId) {
    const movs = await Movimiento.find({ subrubro_id: Number(subrubroId) }, { fecha: 1, monto: 1, campos_extra: 1 }).lean();
    const nros = new Set(movs.map(m => m.campos_extra?.nro_factura).filter(Boolean));
    const fechaMontos = new Set(movs.filter(m => m.fecha).map(m => `${m.fecha}|${m.monto}`));
    return { nros, fechaMontos };
  },

  async bulkInsertMovimientos(movsList) {
    if (movsList.length === 0) return;
    const startId = await Counter.nextBatch('movimientos', movsList.length);
    const docs = movsList.map((m, i) => ({ ...m, _id: startId + i, created_at: now() }));
    await Movimiento.insertMany(docs);
  },

  async recalcularPagosSub(subrubroId) {
    await recalcularPagos(subrubroId);
  },

  async recalcularPagosMultiple(subrubroIds) {
    for (const id of subrubroIds) await recalcularPagos(id);
  },
};

module.exports = db;
