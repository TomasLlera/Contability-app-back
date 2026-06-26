const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, CajaMovimiento, CajaConfig } = require('../models');

setupTestDb();

let adminToken, subrubroId, rubroId;

async function bootstrap() {
  const ah = await bcrypt.hash('admin123', 4);
  const aid = await Counter.next('users');
  await User.create({ _id: aid, usuario: 'admin', password_hash: ah, role: 'admin', activo: true });
  adminToken = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L', icon: 'x' });
  rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'R', local_id: lid });
  subrubroId = await Counter.next('subrubros');
  await Subrubro.create({ _id: subrubroId, rubro_id: rubroId, nombre: 'S', monto_base: 0 });

  // Configurar rubros_sync para que autoSync agarre este rubro
  await CajaConfig.create({
    _id: 'main',
    empleados: [],
    proveedores: [],
    rubros_sync: [rubroId],
    dias_anticipacion_caja: 30,
  });
}

function addDays(fechaStr, n) {
  const d = new Date(fechaStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

describe('Flujo caja: crear factura → autoSync → confirmar pago', () => {
  beforeEach(bootstrap);

  it('confirmar gasto en caja crea pago Y mantiene la factura', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const venc = addDays(hoy, 21);

    // 1. Crear factura en subrubro con vencimiento a 21 días
    const fact = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, fecha: hoy, tipo: 'factura', fecha_vencimiento: venc });
    expect(fact.status).toBe(200);
    const facturaId = fact.body.id;
    console.log('Factura creada:', { id: facturaId, monto: fact.body.monto, fecha: fact.body.fecha, venc: fact.body.fecha_vencimiento, pagado: fact.body.pagado });

    // 2. autoSync para el día del vencimiento
    const sync = await request(app).post('/api/caja/auto-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ fecha: venc });
    expect(sync.status).toBe(200);
    console.log('autoSync resultado:', sync.body);

    // 3. Traer caja items del día del venc
    const cajaItems = await request(app).get('/api/caja')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ fecha: venc });
    const gasto = cajaItems.body.find(c => c.movimiento_id === facturaId);
    expect(gasto).toBeTruthy();
    console.log('Gasto auto-sync en caja:', { id: gasto.id, fecha: gasto.fecha, monto: gasto.monto, metodo: gasto.metodo, subrubro_id: gasto.subrubro_id, movimiento_id: gasto.movimiento_id, confirmado: gasto.confirmado });

    // 4. Simular el flujo de handleConfirmarGasto del frontend:
    //    primero update caja (metodo + confirmado + fecha cap a hoy)
    //    después crear el pago en el subrubro
    const fechaConfirm = hoy; // cap a hoy porque venc es futuro
    await request(app).put(`/api/caja/${gasto.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ metodo: 'efectivo' });
    await request(app).put(`/api/caja/${gasto.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirmado: true, fecha: fechaConfirm });

    const pago = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        tipo: 'pago',
        pago: gasto.monto,
        fecha: fechaConfirm,
        concepto: `Pago caja: ${gasto.concepto}`,
        metodo_pago: 'efectivo',
        caja_mov_id: gasto.id,
      });
    expect(pago.status).toBe(200);
    console.log('Pago creado:', { id: pago.body.id, pago: pago.body.pago, fecha: pago.body.fecha, metodo_pago: pago.body.metodo_pago, caja_mov_id: pago.body.caja_mov_id });

    // 5. Verificar estado final
    const factDespues = await Movimiento.findById(facturaId).lean();
    const todosMovs = await Movimiento.find({ subrubro_id: subrubroId }).lean();

    console.log('\n=== ESTADO FINAL ===');
    console.log('Factura sigue existiendo?', !!factDespues);
    console.log('Factura pagada?', factDespues?.pagado);
    console.log('Movimientos totales en subrubro:', todosMovs.length);
    todosMovs.forEach(m => console.log('  ', { id: m._id, tipo: m.tipo, monto: m.monto, pago: m.pago, fecha: m.fecha, pagado: m.pagado, metodo_pago: m.metodo_pago }));

    expect(factDespues).toBeTruthy();           // la factura sigue ahí
    expect(factDespues.pagado).toBe(true);      // FIFO la marcó como pagada
    expect(todosMovs).toHaveLength(2);          // factura + pago
    expect(todosMovs.find(m => m.tipo === 'pago').pago).toBe(1000);
    expect(todosMovs.find(m => m.tipo === 'pago').metodo_pago).toBe('efectivo');
  });
});
