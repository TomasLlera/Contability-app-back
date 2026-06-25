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
