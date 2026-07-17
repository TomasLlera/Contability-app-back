const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, CajaMovimiento, CajaConfig } = require('../models');

setupTestDb();

let adminToken, rubroId, deudaSubId, provSubId;

const hoy = () => new Date().toISOString().split('T')[0];
const addDias = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
};

async function bootstrap() {
  const ah = await bcrypt.hash('admin123', 4);
  const aid = await Counter.next('users');
  await User.create({ _id: aid, usuario: 'admin', password_hash: ah, role: 'admin', activo: true });
  adminToken = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L', icon: 'x' });
  rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'R', local_id: lid });

  // Subrubro DEUDA (dinero a cobrar) + subrubro proveedor clásico
  deudaSubId = await Counter.next('subrubros');
  await Subrubro.create({ _id: deudaSubId, rubro_id: rubroId, nombre: 'Préstamo Local A', monto_base: 0, tipo_subrubro: 'deuda' });
  provSubId = await Counter.next('subrubros');
  await Subrubro.create({ _id: provSubId, rubro_id: rubroId, nombre: 'Proveedor X', monto_base: 0 });
}

const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

describe('subrubro tipo DEUDA', () => {
  beforeEach(bootstrap);

  it('se crea vía API con tipo_subrubro=deuda y se puede editar', async () => {
    const res = await auth(request(app).post(`/api/subrubros/${rubroId}`))
      .send({ nombre: 'Otra deuda', tipo_subrubro: 'deuda' });
    expect(res.status).toBe(200);
    expect(res.body.tipo_subrubro).toBe('deuda');

    const upd = await auth(request(app).put(`/api/subrubros/${res.body.id}`))
      .send({ tipo_subrubro: 'factura' });
    expect(upd.status).toBe(200);
    const fresh = await Subrubro.findById(res.body.id).lean();
    expect(fresh.tipo_subrubro).toBe('factura');
  });

  it('rechaza un tipo_subrubro inválido', async () => {
    const res = await auth(request(app).post(`/api/subrubros/${rubroId}`))
      .send({ nombre: 'Mala', tipo_subrubro: 'prestamo' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('deuda + abono: el saldo pendiente refleja lo adeudado y el abono lo reduce', async () => {
    // Dos deudas: 10.000 + 5.000
    await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ monto: 10000, fecha: '2026-07-10', tipo: 'factura' });
    await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ monto: 5000, fecha: '2026-07-12', tipo: 'factura' });
    // Abono parcial de 3.000
    await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ pago: 3000, fecha: '2026-07-15', tipo: 'pago', metodo_pago: 'efectivo' });

    const res = await auth(request(app).get(`/api/movimientos/${deudaSubId}`));
    expect(res.status).toBe(200);
    expect(res.body.saldo_total).toBe(12000); // 15.000 − 3.000
    // La primera deuda quedó con saldo 7.000 (FIFO)
    const deuda1 = res.body.movimientos.find(m => m.monto === 10000);
    expect(deuda1.saldo).toBe(7000);
  });

  it('el abono se espeja en la Caja como INGRESO (no gasto)', async () => {
    await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ monto: 10000, fecha: '2026-07-10', tipo: 'factura' });
    const abono = await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ pago: 3000, fecha: '2026-07-15', tipo: 'pago', metodo_pago: 'transferencia' });

    const espejo = await CajaMovimiento.findOne({ pago_mov_id: abono.body.id, origen: 'subrubro' }).lean();
    expect(espejo).toBeTruthy();
    expect(espejo.tipo).toBe('ingreso_extra');
    expect(espejo.monto).toBe(3000);
    expect(espejo.metodo).toBe('transferencia');
    expect(espejo.concepto).toContain('Abono');
    // Borrar el abono elimina el espejo
    await auth(request(app).delete(`/api/movimientos/${abono.body.id}`));
    const sinEspejo = await CajaMovimiento.findOne({ pago_mov_id: abono.body.id }).lean();
    expect(sinEspejo).toBeNull();
  });

  it('un pago de proveedor clásico sigue espejándose como gasto', async () => {
    await auth(request(app).post(`/api/movimientos/${provSubId}`))
      .send({ monto: 500, fecha: '2026-07-10', tipo: 'factura' });
    const pago = await auth(request(app).post(`/api/movimientos/${provSubId}`))
      .send({ pago: 500, fecha: '2026-07-15', tipo: 'pago', metodo_pago: 'efectivo' });

    const espejo = await CajaMovimiento.findOne({ pago_mov_id: pago.body.id, origen: 'subrubro' }).lean();
    expect(espejo.tipo).toBe('gasto');
    expect(espejo.confirmado).toBe(true);
  });

  it('una deuda nunca se guarda como remito (no genera gasto en Caja)', async () => {
    const res = await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ monto: 1000, fecha: '2026-07-10', tipo: 'factura', documento: 'remito' });
    expect(res.body.documento).toBe('factura');
    const items = await CajaMovimiento.find({ movimiento_id: res.body.id }).lean();
    expect(items).toHaveLength(0);
  });

  it('vencimientos: las deudas salen con tipo=deuda y NO en el listado de facturas a pagar', async () => {
    await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ monto: 8000, fecha: hoy(), tipo: 'factura', fecha_vencimiento: addDias(3) });
    await auth(request(app).post(`/api/movimientos/${provSubId}`))
      .send({ monto: 700, fecha: hoy(), tipo: 'factura', fecha_vencimiento: addDias(3) });

    const pagar = await auth(request(app).get('/api/movimientos/vencimientos/proximos?dias=30'));
    expect(pagar.body).toHaveLength(1);
    expect(pagar.body[0].subrubro_id).toBe(provSubId);

    const cobrar = await auth(request(app).get('/api/movimientos/vencimientos/proximos?dias=30&tipo=deuda'));
    expect(cobrar.body).toHaveLength(1);
    expect(cobrar.body[0].subrubro_id).toBe(deudaSubId);
    expect(cobrar.body[0].monto).toBe(8000);
  });

  it('auto-sync de Caja: deuda por vencer → INGRESO pendiente; factura → gasto', async () => {
    await CajaConfig.findByIdAndUpdate('main',
      { $set: { rubros_sync: [rubroId], dias_anticipacion_caja: 5, empleados: [], proveedores: [] } },
      { upsert: true });
    const deuda = await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ monto: 8000, fecha: hoy(), tipo: 'factura', fecha_vencimiento: addDias(2) });
    await auth(request(app).post(`/api/movimientos/${provSubId}`))
      .send({ monto: 700, fecha: hoy(), tipo: 'factura', fecha_vencimiento: addDias(2) });

    const sync = await auth(request(app).post(`/api/caja/auto-sync?fecha=${hoy()}`));
    expect(sync.status).toBe(200);

    const gastos = await CajaMovimiento.find({ tipo: 'gasto', movimiento_id: { $ne: null } }).lean();
    expect(gastos).toHaveLength(1); // solo la factura del proveedor
    const facProv = await Movimiento.findOne({ subrubro_id: provSubId }).lean();
    expect(gastos[0].movimiento_id).toBe(facProv._id);

    // La deuda entra como ingreso pendiente de cobro (no afecta saldo hasta confirmar)
    const cobros = await CajaMovimiento.find({ tipo: 'ingreso_extra', movimiento_id: { $ne: null } }).lean();
    expect(cobros).toHaveLength(1);
    expect(cobros[0].movimiento_id).toBe(deuda.body.id);
    expect(cobros[0].monto).toBe(8000);
    expect(cobros[0].confirmado).toBe(false);
  });

  it('confirmar el cobro crea el abono vinculado y salda la deuda', async () => {
    await CajaConfig.findByIdAndUpdate('main',
      { $set: { rubros_sync: [rubroId], dias_anticipacion_caja: 5, empleados: [], proveedores: [] } },
      { upsert: true });
    const deuda = await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ monto: 8000, fecha: hoy(), tipo: 'factura', fecha_vencimiento: addDias(2) });
    await auth(request(app).post(`/api/caja/auto-sync?fecha=${hoy()}`));
    const item = await CajaMovimiento.findOne({ movimiento_id: deuda.body.id }).lean();

    // Mismo flujo que la confirmación de un gasto en CajaView:
    await auth(request(app).put(`/api/caja/${item._id}`)).send({ confirmado: true, fecha: hoy(), metodo: 'efectivo' });
    const abono = await auth(request(app).post(`/api/movimientos/${deudaSubId}`)).send({
      tipo: 'pago', pago: item.monto, fecha: hoy(), metodo_pago: 'efectivo',
      caja_mov_id: item._id, facturas_vinculadas_ids: [deuda.body.id],
      idempotency_key: `caja-confirm-${item._id}`,
    });
    expect(abono.status).toBe(200);

    // La deuda quedó saldada y NO se creó un espejo duplicado (vino de la Caja)
    const freshDeuda = await Movimiento.findById(deuda.body.id).lean();
    expect(freshDeuda.pagado).toBe(true);
    const espejos = await CajaMovimiento.find({ pago_mov_id: abono.body.id, origen: 'subrubro' }).lean();
    expect(espejos).toHaveLength(0);
  });

  it('dashboard: deudas-cobrar resume el total y getDeudaTotal las excluye', async () => {
    await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ monto: 10000, fecha: '2026-07-10', tipo: 'factura', fecha_vencimiento: addDias(4) });
    await auth(request(app).post(`/api/movimientos/${deudaSubId}`))
      .send({ pago: 3000, fecha: '2026-07-15', tipo: 'pago' });
    await auth(request(app).post(`/api/movimientos/${provSubId}`))
      .send({ monto: 500, fecha: '2026-07-10', tipo: 'factura' });

    const dc = await auth(request(app).get('/api/dashboard/deudas-cobrar'));
    expect(dc.status).toBe(200);
    expect(dc.body.total).toBe(7000);
    expect(dc.body.cantidad).toBe(1);
    expect(dc.body.subrubros[0]).toMatchObject({ id: deudaSubId, saldo: 7000 });

    // La deuda propia (resumen) solo cuenta la factura del proveedor
    const resumen = await auth(request(app).get('/api/dashboard/resumen'));
    expect(resumen.body.deudaTotal).toBe(500);
  });

  it('convertir subrubro a DEUDA re-espeja sus pagos como ingresos', async () => {
    await auth(request(app).post(`/api/movimientos/${provSubId}`))
      .send({ monto: 500, fecha: '2026-07-10', tipo: 'factura' });
    const pago = await auth(request(app).post(`/api/movimientos/${provSubId}`))
      .send({ pago: 200, fecha: '2026-07-15', tipo: 'pago', metodo_pago: 'efectivo' });

    let espejo = await CajaMovimiento.findOne({ pago_mov_id: pago.body.id }).lean();
    expect(espejo.tipo).toBe('gasto');

    await auth(request(app).put(`/api/subrubros/${provSubId}`)).send({ tipo_subrubro: 'deuda' });
    espejo = await CajaMovimiento.findOne({ pago_mov_id: pago.body.id }).lean();
    expect(espejo.tipo).toBe('ingreso_extra');
    expect(espejo.concepto).toContain('Abono');
  });

  it('convertir a DEUDA limpia los gastos remito sin confirmar y normaliza el documento', async () => {
    // Remito en subrubro proveedor → gasto pendiente en Caja
    const remito = await auth(request(app).post(`/api/movimientos/${provSubId}`))
      .send({ monto: 4365, fecha: '2026-07-10', tipo: 'factura', documento: 'remito' });
    let gasto = await CajaMovimiento.findOne({ movimiento_id: remito.body.id }).lean();
    expect(gasto).toBeTruthy();
    expect(gasto.tipo).toBe('gasto');

    // Conversión a deuda: el gasto pendiente desaparece y el remito pasa a factura
    await auth(request(app).put(`/api/subrubros/${provSubId}`)).send({ tipo_subrubro: 'deuda' });
    gasto = await CajaMovimiento.findOne({ movimiento_id: remito.body.id }).lean();
    expect(gasto).toBeNull();
    const freshMov = await Movimiento.findById(remito.body.id).lean();
    expect(freshMov.documento).toBe('factura');
  });
});
