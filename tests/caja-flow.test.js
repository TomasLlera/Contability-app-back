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

describe('Reconciliación auto-sync: cambios en la factura se reflejan en caja', () => {
  beforeEach(bootstrap);

  async function syncEl(fecha) {
    return request(app).post('/api/caja/auto-sync')
      .set('Authorization', `Bearer ${adminToken}`).query({ fecha });
  }
  async function cajaDe(fecha) {
    const r = await request(app).get('/api/caja')
      .set('Authorization', `Bearer ${adminToken}`).query({ fecha });
    return r.body;
  }
  async function crearFactura(monto, fecha, venc) {
    const r = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto, fecha, tipo: 'factura', fecha_vencimiento: venc });
    return r.body.id;
  }

  it('editar el monto de la factura actualiza el ítem de caja pendiente', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const venc = addDays(hoy, 5);
    const facturaId = await crearFactura(1000, hoy, venc);

    await syncEl(venc);
    let gasto = (await cajaDe(venc)).find(c => c.movimiento_id === facturaId);
    expect(gasto.monto).toBe(1000);

    // Editar el monto de la factura
    await request(app).put(`/api/movimientos/${facturaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1500, fecha: hoy, tipo: 'factura', fecha_vencimiento: venc });

    // Re-sync (lo que hace la Caja al recargar) → el ítem refleja el nuevo monto
    await syncEl(venc);
    gasto = (await cajaDe(venc)).find(c => c.movimiento_id === facturaId);
    expect(gasto.monto).toBe(1500);
  });

  it('borrar la factura elimina el ítem de caja pendiente (no se arrastra)', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const venc = addDays(hoy, 5);
    const facturaId = await crearFactura(800, hoy, venc);

    await syncEl(venc);
    expect((await cajaDe(venc)).some(c => c.movimiento_id === facturaId)).toBe(true);

    // Borrar la factura → cleanup inmediato en deleteMovimiento
    await request(app).delete(`/api/movimientos/${facturaId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect((await cajaDe(venc)).some(c => c.movimiento_id === facturaId)).toBe(false);
    expect(await CajaMovimiento.countDocuments({ movimiento_id: facturaId })).toBe(0);
  });

  it('pagar la factura por fuera de caja elimina el pendiente al reconciliar', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const venc = addDays(hoy, 5);
    const facturaId = await crearFactura(500, hoy, venc);

    await syncEl(venc);
    expect((await cajaDe(venc)).some(c => c.movimiento_id === facturaId)).toBe(true);

    // Pago directo en el subrubro (no desde caja) que salda la factura
    await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'pago', pago: 500, fecha: hoy, metodo_pago: 'efectivo' });

    // Al reconciliar, el pendiente sobra y se elimina
    await syncEl(venc);
    expect((await cajaDe(venc)).some(c => c.movimiento_id === facturaId)).toBe(false);
  });
});

describe('Método de pago: sincronización subrubro ↔ Caja del Día', () => {
  beforeEach(bootstrap);

  async function syncEl(fecha) {
    return request(app).post('/api/caja/auto-sync')
      .set('Authorization', `Bearer ${adminToken}`).query({ fecha });
  }
  async function cajaDe(fecha) {
    const r = await request(app).get('/api/caja')
      .set('Authorization', `Bearer ${adminToken}`).query({ fecha });
    return r.body;
  }

  it('el método cargado en la factura viaja al ítem de Caja al vencer', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const venc = addDays(hoy, 5);
    const fact = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, fecha: hoy, tipo: 'factura', fecha_vencimiento: venc, metodo_pago: 'transferencia' });
    const facturaId = fact.body.id;

    await syncEl(venc);
    const gasto = (await cajaDe(venc)).find(c => c.movimiento_id === facturaId);
    expect(gasto.metodo).toBe('transferencia');
  });

  it('factura sin método → ítem de Caja sin definir (null)', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const venc = addDays(hoy, 5);
    const fact = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, fecha: hoy, tipo: 'factura', fecha_vencimiento: venc });
    const facturaId = fact.body.id;

    await syncEl(venc);
    const gasto = (await cajaDe(venc)).find(c => c.movimiento_id === facturaId);
    expect(gasto.metodo == null).toBe(true);
  });

  it('cambiar el método en la factura se refleja en el ítem de Caja al reconciliar', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const venc = addDays(hoy, 5);
    const fact = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, fecha: hoy, tipo: 'factura', fecha_vencimiento: venc, metodo_pago: 'efectivo' });
    const facturaId = fact.body.id;
    await syncEl(venc);

    await request(app).put(`/api/movimientos/${facturaId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, fecha: hoy, tipo: 'factura', fecha_vencimiento: venc, metodo_pago: 'transferencia' });
    await syncEl(venc);
    const gasto = (await cajaDe(venc)).find(c => c.movimiento_id === facturaId);
    expect(gasto.metodo).toBe('transferencia');
  });

  it('poner el método en la Caja lo escribe de vuelta en la factura (Caja → subrubro)', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const venc = addDays(hoy, 5);
    const fact = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, fecha: hoy, tipo: 'factura', fecha_vencimiento: venc });
    const facturaId = fact.body.id;
    await syncEl(venc);
    const gasto = (await cajaDe(venc)).find(c => c.movimiento_id === facturaId);

    await request(app).put(`/api/caja/${gasto.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ metodo: 'transferencia' });

    const fresh = await Movimiento.findById(facturaId).lean();
    expect(fresh.metodo_pago).toBe('transferencia');
  });
});

describe('Sincronización Subrubro → Caja: un pago en el subrubro aparece en la Caja del Día', () => {
  beforeEach(bootstrap);

  async function cajaDe(fecha) {
    const r = await request(app).get('/api/caja')
      .set('Authorization', `Bearer ${adminToken}`).query({ fecha });
    return r.body;
  }

  it('un pago suelto registrado en el subrubro crea un gasto confirmado en la Caja del mismo día', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const pago = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'pago', pago: 700, fecha: hoy, metodo_pago: 'efectivo' });
    expect(pago.status).toBe(200);

    const caja = await cajaDe(hoy);
    const espejo = caja.find(c => c.pago_mov_id === pago.body.id);
    expect(espejo).toBeTruthy();
    expect(espejo.tipo).toBe('gasto');
    expect(espejo.monto).toBe(700);
    expect(espejo.metodo).toBe('efectivo');
    expect(espejo.confirmado).toBe(true);
    expect(espejo.origen).toBe('subrubro');
    expect(espejo.fecha).toBe(hoy);
  });

  it('un pago vinculado a una factura también aparece en la Caja', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const fact = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 500, fecha: hoy, tipo: 'factura' });
    const pago = await request(app).post(`/api/movimientos/${subrubroId}/pago-vinculado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'pago', fecha: hoy, monto_pago: 500, facturas_vinculadas_ids: [fact.body.id], metodo_pago: 'transferencia' });
    expect(pago.status).toBe(200);

    const espejo = (await cajaDe(hoy)).find(c => c.pago_mov_id === pago.body.id);
    expect(espejo).toBeTruthy();
    expect(espejo.monto).toBe(500);
    expect(espejo.metodo).toBe('transferencia');
  });

  it('el pago se registra en la fecha real, no en el vencimiento de la factura', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const vencPasado = addDays(hoy, -2); // factura vencida hace 2 días
    const fact = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 900, fecha: addDays(hoy, -10), tipo: 'factura', fecha_vencimiento: vencPasado });

    // Se paga HOY, vinculando a la factura vencida
    const pago = await request(app).post(`/api/movimientos/${subrubroId}/pago-vinculado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'pago', fecha: hoy, monto_pago: 900, facturas_vinculadas_ids: [fact.body.id], metodo_pago: 'efectivo' });

    const espejo = (await cajaDe(hoy)).find(c => c.pago_mov_id === pago.body.id);
    expect(espejo.fecha).toBe(hoy);          // fecha real del pago, no el vencimiento
    expect(espejo.fecha).not.toBe(vencPasado);
  });

  it('borrar el pago en el subrubro elimina el espejo de la Caja', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const pago = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'pago', pago: 300, fecha: hoy, metodo_pago: 'efectivo' });
    expect((await cajaDe(hoy)).some(c => c.pago_mov_id === pago.body.id)).toBe(true);

    await request(app).delete(`/api/movimientos/${pago.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect((await cajaDe(hoy)).some(c => c.pago_mov_id === pago.body.id)).toBe(false);
    expect(await CajaMovimiento.countDocuments({ pago_mov_id: pago.body.id, origen: 'subrubro' })).toBe(0);
  });

  it('editar el pago (monto/fecha) actualiza el espejo de la Caja', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    const pago = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'pago', pago: 400, fecha: hoy, metodo_pago: 'efectivo' });

    await request(app).put(`/api/movimientos/${pago.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'pago', pago: 650, fecha: hoy, metodo_pago: 'transferencia' });

    const espejo = (await cajaDe(hoy)).find(c => c.pago_mov_id === pago.body.id);
    expect(espejo.monto).toBe(650);
    expect(espejo.metodo).toBe('transferencia');
  });

  it('un pago originado en la Caja NO genera un espejo duplicado', async () => {
    const hoy = new Date().toISOString().split('T')[0];
    // Simula el pago que crea la Caja al confirmar: trae caja_mov_id.
    const cajaItem = await request(app).post('/api/caja')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fecha: hoy, tipo: 'gasto', concepto: 'Gasto manual', monto: 200, metodo: 'efectivo', subrubro_id: subrubroId });
    const pago = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'pago', pago: 200, fecha: hoy, metodo_pago: 'efectivo', caja_mov_id: cajaItem.body.id });

    // No debe existir un espejo origen:'subrubro' para este pago (ya vino de Caja).
    expect(await CajaMovimiento.countDocuments({ pago_mov_id: pago.body.id, origen: 'subrubro' })).toBe(0);
  });
});
