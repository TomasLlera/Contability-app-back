// Backfill one-shot (ESCRIBE en la base): pone documento='factura' a las facturas
// que no lo tienen. Antes se llamaba check-doc.js, que sugería una verificación de
// solo lectura. Uso: node scripts/backfill-documento.js
require('dotenv').config();
const mongoose = require('mongoose');
const { Movimiento } = require('../models');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const conDoc = await Movimiento.countDocuments({ tipo: 'factura', documento: { $ne: null } });
  const sinDoc = await Movimiento.countDocuments({ tipo: 'factura', documento: null });
  console.log('facturas con documento:', conDoc, 'sin documento:', sinDoc);
  if (sinDoc > 0) {
    const res = await Movimiento.updateMany({ tipo: 'factura', documento: null }, { $set: { documento: 'factura' } });
    console.log('Backfill modifiedCount:', res.modifiedCount ?? res.nModified);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
