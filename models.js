const mongoose = require('mongoose');

// --- Counter (auto-increment) ---
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
counterSchema.statics.next = async function (name) {
  const r = await this.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true });
  return r.seq;
};
counterSchema.statics.nextBatch = async function (name, count) {
  if (count === 0) return 1;
  const r = await this.findByIdAndUpdate(name, { $inc: { seq: count } }, { returnDocument: 'after', upsert: true });
  return r.seq - count + 1;
};
const Counter = mongoose.model('Counter', counterSchema);

// --- Local ---
const Local = mongoose.model('Local', new mongoose.Schema({
  _id: Number, nombre: String, icon: { type: String, default: '🏠' }, created_at: String
}));

// --- Rubro ---
const Rubro = mongoose.model('Rubro', new mongoose.Schema({
  _id: Number, nombre: String, local_id: Number, icon: String, created_at: String
}));

// --- Subrubro ---
const Subrubro = mongoose.model('Subrubro', new mongoose.Schema({
  _id: Number, rubro_id: Number, nombre: String,
  monto_base: { type: Number, default: 0 }, icon: String, created_at: String
}));

// --- Movimiento ---
const Movimiento = mongoose.model('Movimiento', new mongoose.Schema({
  _id: Number,
  subrubro_id: Number,
  fecha: String,
  monto: { type: Number, default: 0 },
  pago: { type: Number, default: 0 },
  tipo: String,
  facturas_vinculadas_ids: { type: [Number], default: [] },
  pagado: { type: Boolean, default: false },
  fecha_vencimiento: String,
  campos_extra: { type: mongoose.Schema.Types.Mixed, default: {} },
  concepto: { type: String, default: '' },
  _ajuste_pago_id: { type: Number, default: null },
  created_at: String
}));

// --- Campo de Rubro ---
const Campo = mongoose.model('Campo', new mongoose.Schema({
  _id: Number, rubro_id: Number, nombre: String,
  tipo: { type: String, default: 'texto' }, orden: { type: Number, default: 0 }
}));

// --- Categoría (compatibilidad) ---
const Categoria = mongoose.model('Categoria', new mongoose.Schema({
  _id: Number, rubro_id: Number, nombre: String, operacion: String,
  tipo_calculo: { type: String, default: 'fijo' },
  porcentaje_default: { type: Number, default: null }
}));

// --- Caja ---
const CajaMovimiento = mongoose.model('CajaMovimiento', new mongoose.Schema({
  _id: Number,
  fecha: String,
  // saldo_inicial: saldo del día anterior ingresado manualmente
  // ingreso_extra: plata extra que entró (no de empleados)
  // empleado: caja de un empleado
  // gasto: gasto de proveedor u otro
  tipo: { type: String, enum: ['saldo_inicial', 'ingreso_extra', 'empleado', 'gasto'], default: 'gasto' },
  concepto: String,
  monto: { type: Number, default: 0 },
  metodo: { type: String, enum: ['efectivo', 'transferencia'], default: 'efectivo' },
  subrubro_id: { type: Number, default: null },  // link a proveedor/movimiento
  es_especial: { type: Boolean, default: false }, // para identificar en gráficos
  created_at: String,
}));

// --- Caja Config ---
const CajaConfig = mongoose.model('CajaConfig', new mongoose.Schema({
  _id: { type: String, default: 'main' },
  empleados: [{ nombre: String }],
  proveedores: [{ nombre: String, subrubro_id: { type: Number, default: null } }],
}));

// --- Import Config ---
const ImportConfig = mongoose.model('ImportConfig', new mongoose.Schema({
  rubro_id: { type: Number, unique: true },
  mapping: mongoose.Schema.Types.Mixed,
  mode: String,
  updated_at: String
}));

module.exports = { Counter, Local, Rubro, Subrubro, Movimiento, Campo, Categoria, ImportConfig, CajaMovimiento, CajaConfig };
