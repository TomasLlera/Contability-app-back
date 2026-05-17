#!/usr/bin/env node
// Exporta todas las colecciones a un único archivo JSON.
// Uso: node scripts/backup.js [archivo_salida]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const COLLECTIONS = [
  'Counter', 'Local', 'Rubro', 'Subrubro', 'Movimiento', 'Campo', 'Categoria',
  'ImportConfig', 'CajaMovimiento', 'CajaConfig', 'AppConfig', 'User',
  'Producto', 'MovimientoStock', 'Audit',
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI no definida'); process.exit(1); }

  await mongoose.connect(uri);
  const models = require('../models');

  const out = { version: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const name of COLLECTIONS) {
    if (!models[name]) continue;
    out.data[name] = await models[name].find().lean();
    console.log(`  ${name}: ${out.data[name].length} docs`);
  }

  const fname = process.argv[2] || path.join(
    'backups',
    `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.mkdirSync(path.dirname(fname), { recursive: true });
  fs.writeFileSync(fname, JSON.stringify(out, null, 2));
  console.log(`\nBackup escrito en ${fname}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
