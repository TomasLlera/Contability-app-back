require('dotenv').config();
const mongoose = require('mongoose');
const { Campo, Movimiento } = require('../models');

(async () => {
  const campoId = Number(process.argv[2]);
  if (!campoId) { console.error('Usage: node scripts/del-campo.js <campoId>'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI);
  const c = await Campo.findById(campoId).lean();
  if (!c) { console.log('No existe.'); await mongoose.disconnect(); return; }
  console.log('Borrando:', c);
  // También limpio el key del nombre en campos_extra de los movimientos del rubro
  const subrubrosIds = (await mongoose.connection.db.collection('subrubros').find({ rubro_id: c.rubro_id }).project({ _id: 1 }).toArray()).map(s => s._id);
  const res = await Movimiento.updateMany(
    { subrubro_id: { $in: subrubrosIds }, [`campos_extra.${c.nombre}`]: { $exists: true } },
    { $unset: { [`campos_extra.${c.nombre}`]: '' } }
  );
  console.log(`Limpiados campos_extra.${c.nombre} en ${res.modifiedCount} movimientos.`);
  await Campo.findByIdAndDelete(campoId);
  console.log('Campo borrado.');
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
