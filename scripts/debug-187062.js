require('dotenv').config();
const mongoose = require('mongoose');
const { Movimiento, Audit } = require('../models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const mov = await Movimiento.findById(187062).lean();
  console.log('\nMovimiento 187062:', mov);

  // TODOS los audits que tocan 187062 directamente
  const byRecursoId = await Audit.find({ recurso_id: 187062 }).sort({ _id: 1 }).lean();
  console.log(`\nAudits por recurso_id=187062: ${byRecursoId.length}`);
  byRecursoId.forEach(a => console.log({ id: a._id, accion: a.accion, recurso: a.recurso, usuario: a.usuario, ip: a.ip }));

  // Buscar también si algún bulk u otro audit menciona el id
  const all = await Audit.find({ recurso: { $in: ['movimiento', 'movimientos_bulk', 'subrubro', 'rubro', 'local'] } }).sort({ _id: -1 }).limit(500).lean();
  const relevant = all.filter(a => JSON.stringify(a.diff || {}).includes('187062'));
  console.log(`\nAudits que tocan al movimiento 187062: ${relevant.length}`);
  relevant.forEach(a => console.log({
    id: a._id,
    accion: a.accion,
    recurso: a.recurso,
    recurso_id: a.recurso_id,
    usuario: a.usuario,
    fecha: a.created_at,
    diff: a.diff,
  }));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
