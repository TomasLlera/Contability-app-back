#!/usr/bin/env node
// Limpia CajaMovimiento duplicados creados por el auto-sync viejo
// (uno por día para la misma factura). Conserva el más antiguo (menor _id)
// y borra el resto. Solo toca items NO confirmados con movimiento_id != null.
//
// Uso:
//   node scripts/dedupe-caja-vencimientos.js          # aplica
//   node scripts/dedupe-caja-vencimientos.js --dry    # solo lista
require('dotenv').config();
const mongoose = require('mongoose');
const { CajaMovimiento } = require('../models');

async function main() {
  const dry = process.argv.includes('--dry');
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI no definida'); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`Conectado a Mongo${dry ? ' (DRY RUN)' : ''}`);

  const items = await CajaMovimiento.find({
    movimiento_id: { $ne: null },
    confirmado: { $ne: true },
    tipo: 'gasto',
  }).sort({ _id: 1 }).lean();

  console.log(`Caja items sin confirmar con movimiento_id: ${items.length}`);

  const porMov = new Map();
  for (const it of items) {
    if (!porMov.has(it.movimiento_id)) porMov.set(it.movimiento_id, []);
    porMov.get(it.movimiento_id).push(it);
  }

  const aBorrar = [];
  for (const [movId, group] of porMov) {
    if (group.length <= 1) continue;
    const [keep, ...dupes] = group;
    console.log(`  mov #${movId}: ${group.length} copias → conservar caja #${keep._id} (${keep.fecha}), borrar ${dupes.map(d => `#${d._id}(${d.fecha})`).join(', ')}`);
    aBorrar.push(...dupes.map(d => d._id));
  }

  console.log(`Total a borrar: ${aBorrar.length}`);

  if (!dry && aBorrar.length) {
    const res = await CajaMovimiento.deleteMany({ _id: { $in: aBorrar } });
    console.log(`Borrados: ${res.deletedCount}`);
  } else if (dry) {
    console.log('DRY RUN: no se borró nada.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
