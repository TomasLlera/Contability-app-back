require('dotenv').config();
const mongoose = require('mongoose');
const { Movimiento, CajaMovimiento } = require('../models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const facturas1000 = await Movimiento.find({ tipo: 'factura', monto: 1000 }).lean();
  console.log(`\nFacturas con monto=1000 en TODO el subrubro: ${facturas1000.length}`);
  facturas1000.forEach(f => console.log('  ', { id: f._id, subrubro_id: f.subrubro_id, fecha: f.fecha, venc: f.fecha_vencimiento, pagado: f.pagado, caja_mov_id: f.caja_mov_id }));

  const pagos1000 = await Movimiento.find({ tipo: 'pago', pago: 1000 }).sort({ _id: -1 }).limit(5).lean();
  console.log(`\nÚltimos 5 pagos con pago=1000:`);
  pagos1000.forEach(p => console.log('  ', { id: p._id, subrubro_id: p.subrubro_id, fecha: p.fecha, metodo_pago: p.metodo_pago, caja_mov_id: p.caja_mov_id }));

  const cajaItems1000 = await CajaMovimiento.find({ monto: 1000 }).sort({ _id: -1 }).limit(5).lean();
  console.log(`\nÚltimos 5 caja items con monto=1000:`);
  cajaItems1000.forEach(c => console.log('  ', { id: c._id, fecha: c.fecha, tipo: c.tipo, metodo: c.metodo, subrubro_id: c.subrubro_id, movimiento_id: c.movimiento_id, confirmado: c.confirmado, pago_mov_id: c.pago_mov_id }));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
