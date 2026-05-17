#!/usr/bin/env node
// Restaura un backup generado por backup.js.
// Uso: node scripts/restore.js <archivo.json> [--drop]
// --drop borra cada colección antes de insertar (cuidado).
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Uso: node scripts/restore.js <archivo.json> [--drop]'); process.exit(1); }
  const drop = process.argv.includes('--drop');
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI no definida'); process.exit(1); }

  const raw = fs.readFileSync(file, 'utf8');
  const dump = JSON.parse(raw);
  if (!dump.data) { console.error('Formato de backup inválido'); process.exit(1); }

  await mongoose.connect(uri);
  const models = require('../models');

  for (const [name, docs] of Object.entries(dump.data)) {
    const Model = models[name];
    if (!Model) { console.warn(`  ${name}: modelo no encontrado, salteando`); continue; }
    if (drop) await Model.deleteMany({});
    if (docs.length === 0) { console.log(`  ${name}: 0 docs`); continue; }
    await Model.insertMany(docs, { ordered: false }).catch(err => {
      console.warn(`  ${name}: algunos docs fallaron (${err.writeErrors?.length || 1} errores) — continuando`);
    });
    console.log(`  ${name}: ${docs.length} docs ${drop ? 'reemplazados' : 'insertados'}`);
  }

  await mongoose.disconnect();
  console.log('\nRestore completo');
}

main().catch(err => { console.error(err); process.exit(1); });
