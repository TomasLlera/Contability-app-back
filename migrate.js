require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Counter, Local, Rubro, Subrubro, Movimiento, Campo, Categoria, ImportConfig } = require('./models');

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('ERROR: MONGODB_URI no definida en .env'); process.exit(1); }

  const dataPath = path.join(__dirname, 'contability.json');
  if (!fs.existsSync(dataPath)) { console.error('ERROR: contability.json no encontrado'); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  await mongoose.connect(uri);
  console.log('MongoDB conectado');

  // Drop existing data
  await Promise.all([
    Counter.deleteMany({}),
    Local.deleteMany({}),
    Rubro.deleteMany({}),
    Subrubro.deleteMany({}),
    Movimiento.deleteMany({}),
    Campo.deleteMany({}),
    Categoria.deleteMany({}),
    ImportConfig.deleteMany({}),
  ]);
  console.log('Colecciones limpiadas');

  const locales = data.locales || [];
  const rubros = data.rubros || [];
  const subrubros = data.subrubros || [];
  const movimientos = data.movimientos || [];
  const campos = data.campos || [];
  const categorias = data.categorias || [];
  const importConfigs = data.import_configs || [];

  // Migrate Locales
  if (locales.length > 0) {
    await Local.insertMany(locales.map(l => ({
      _id: l._id, nombre: l.nombre, icon: l.icon || '🏠', created_at: l.created_at || new Date().toISOString()
    })));
    console.log(`Locales migrados: ${locales.length}`);
  }

  // Migrate Rubros
  if (rubros.length > 0) {
    await Rubro.insertMany(rubros.map(r => ({
      _id: r._id, nombre: r.nombre, local_id: r.local_id, icon: r.icon || null, created_at: r.created_at || new Date().toISOString()
    })));
    console.log(`Rubros migrados: ${rubros.length}`);
  }

  // Migrate Subrubros
  if (subrubros.length > 0) {
    await Subrubro.insertMany(subrubros.map(s => ({
      _id: s._id, rubro_id: s.rubro_id, nombre: s.nombre,
      monto_base: s.monto_base || 0, icon: s.icon || null, created_at: s.created_at || new Date().toISOString()
    })));
    console.log(`Subrubros migrados: ${subrubros.length}`);
  }

  // Migrate Movimientos in batches
  if (movimientos.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < movimientos.length; i += BATCH) {
      const batch = movimientos.slice(i, i + BATCH).map(m => ({
        _id: m._id, subrubro_id: m.subrubro_id, fecha: m.fecha || null,
        monto: m.monto || 0, pago: m.pago || 0, tipo: m.tipo || 'factura',
        facturas_vinculadas_ids: m.facturas_vinculadas_ids || [],
        pagado: m.pagado || false,
        fecha_vencimiento: m.fecha_vencimiento || null,
        campos_extra: m.campos_extra || {},
        concepto: m.concepto || '',
        _ajuste_pago_id: m._ajuste_pago_id || null,
        created_at: m.created_at || new Date().toISOString()
      }));
      await Movimiento.insertMany(batch);
      console.log(`Movimientos migrados: ${Math.min(i + BATCH, movimientos.length)} / ${movimientos.length}`);
    }
  }

  // Migrate Campos
  if (campos.length > 0) {
    await Campo.insertMany(campos.map(c => ({
      _id: c._id, rubro_id: c.rubro_id, nombre: c.nombre,
      tipo: c.tipo || 'texto', orden: c.orden || 0
    })));
    console.log(`Campos migrados: ${campos.length}`);
  }

  // Migrate Categorias
  if (categorias.length > 0) {
    await Categoria.insertMany(categorias.map(c => ({
      _id: c._id, rubro_id: c.rubro_id, nombre: c.nombre, operacion: c.operacion,
      tipo_calculo: c.tipo_calculo || 'fijo', porcentaje_default: c.porcentaje_default ?? null
    })));
    console.log(`Categorías migradas: ${categorias.length}`);
  }

  // Migrate ImportConfigs
  if (importConfigs.length > 0) {
    await ImportConfig.insertMany(importConfigs.map(ic => ({
      rubro_id: ic.rubro_id, mapping: ic.mapping || {}, mode: ic.mode || 'skip_duplicates',
      updated_at: ic.updated_at || new Date().toISOString()
    })));
    console.log(`ImportConfigs migrados: ${importConfigs.length}`);
  }

  // Set counters to max IDs
  const seq = data._seq || {};
  const counters = [
    { _id: 'locales', seq: seq.locales || (locales.length > 0 ? Math.max(...locales.map(l => l._id)) : 0) },
    { _id: 'rubros', seq: seq.rubros || (rubros.length > 0 ? Math.max(...rubros.map(r => r._id)) : 0) },
    { _id: 'subrubros', seq: seq.subrubros || (subrubros.length > 0 ? Math.max(...subrubros.map(s => s._id)) : 0) },
    { _id: 'movimientos', seq: seq.movimientos || (movimientos.length > 0 ? Math.max(...movimientos.map(m => m._id)) : 0) },
    { _id: 'campos', seq: seq.campos || (campos.length > 0 ? Math.max(...campos.map(c => c._id)) : 0) },
    { _id: 'categorias', seq: seq.categorias || (categorias.length > 0 ? Math.max(...categorias.map(c => c._id)) : 0) },
  ];
  await Counter.insertMany(counters);
  console.log('Contadores configurados:', counters.map(c => `${c._id}=${c.seq}`).join(', '));

  console.log('\n✅ Migración completa');
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Error en migración:', err);
  process.exit(1);
});
