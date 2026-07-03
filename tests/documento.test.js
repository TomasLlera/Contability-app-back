const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, CajaMovimiento } = require('../models');

setupTestDb();

let adminToken, subrubroId;

async function bootstrap() {
  const ah = await bcrypt.hash('admin123', 4);
  const aid = await Counter.next('users');
  await User.create({ _id: aid, usuario: 'admin', password_hash: ah, role: 'admin', activo: true });
  adminToken = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L', icon: 'x' });
  const rid = await Counter.next('rubros');
  await Rubro.create({ _id: rid, nombre: 'R', local_id: lid });
  const sid = await Counter.next('subrubros');
  await Subrubro.create({ _id: sid, rubro_id: rid, nombre: 'S', monto_base: 0 });
  subrubroId = sid;
}

describe('documento (factura/remito)', () => {
  beforeEach(bootstrap);

  it('crear factura con documento=remito guarda remito', async () => {
    const res = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'remito' });
    expect(res.status).toBe(200);
    expect(res.body.documento).toBe('remito');
  });

  it('actualizar factura de remito → factura', async () => {
    const create = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'remito' });
    const id = create.body.id;

    const upd = await request(app).put(`/api/movimientos/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'factura' });
    expect(upd.status).toBe(200);
    expect(upd.body.documento).toBe('factura');

    const fresh = await Movimiento.findById(id).lean();
    expect(fresh.documento).toBe('factura');
  });

  it('actualizar factura de factura → remito', async () => {
    const create = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'factura' });
    const id = create.body.id;

    const upd = await request(app).put(`/api/movimientos/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'remito' });
    expect(upd.status).toBe(200);
    expect(upd.body.documento).toBe('remito');

    const fresh = await Movimiento.findById(id).lean();
    expect(fresh.documento).toBe('remito');
  });
});

describe('remito → efectivo automático + Caja del Día', () => {
  beforeEach(bootstrap);

  const crearRemito = (extra = {}) => request(app).post(`/api/movimientos/${subrubroId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'remito', ...extra });

  it('un remito se guarda con metodo_pago=efectivo', async () => {
    const res = await crearRemito();
    expect(res.status).toBe(200);
    const fresh = await Movimiento.findById(res.body.id).lean();
    expect(fresh.metodo_pago).toBe('efectivo');
  });

  it('un remito nunca guarda percepciones (se fuerzan a 0)', async () => {
    const res = await crearRemito({ percepcion_iva: 50, ingresos_brutos: 30 });
    const fresh = await Movimiento.findById(res.body.id).lean();
    expect(fresh.percepcion_iva).toBe(0);
    expect(fresh.ingresos_brutos).toBe(0);
  });

  it('crear un remito genera un gasto de caja en efectivo, sin confirmar', async () => {
    const res = await crearRemito();
    const caja = await CajaMovimiento.findOne({ movimiento_id: res.body.id }).lean();
    expect(caja).not.toBeNull();
    expect(caja.tipo).toBe('gasto');
    expect(caja.metodo).toBe('efectivo');
    expect(caja.confirmado).toBe(false);   // pendiente: aparece pero no descuenta aún
    expect(caja.auto_sync).toBe(false);    // fuera del reconciliador de vencimientos
    expect(caja.monto).toBe(100);
    expect(caja.fecha).toBe('2025-01-01');
    expect(caja.subrubro_id).toBe(subrubroId);
  });

  it('el gasto de caja aparece en GET /api/caja de esa fecha', async () => {
    await crearRemito();
    const caja = await request(app).get('/api/caja?fecha=2025-01-01')
      .set('Authorization', `Bearer ${adminToken}`);
    const gasto = caja.body.find(m => m.tipo === 'gasto' && m.metodo === 'efectivo');
    expect(gasto).toBeTruthy();
    expect(gasto.monto).toBe(100);
  });

  it('editar el monto del remito actualiza el gasto de caja', async () => {
    const res = await crearRemito();
    await request(app).put(`/api/movimientos/${res.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 250, fecha: '2025-01-01', tipo: 'factura', documento: 'remito' });
    const caja = await CajaMovimiento.findOne({ movimiento_id: res.body.id }).lean();
    expect(caja.monto).toBe(250);
  });

  it('borrar un remito elimina su gasto de caja', async () => {
    const res = await crearRemito();
    expect(await CajaMovimiento.countDocuments({ movimiento_id: res.body.id })).toBe(1);
    const del = await request(app).delete(`/api/movimientos/${res.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(await CajaMovimiento.countDocuments({ movimiento_id: res.body.id })).toBe(0);
  });

  it('cambiar remito → factura elimina el gasto de caja', async () => {
    const res = await crearRemito();
    expect(await CajaMovimiento.countDocuments({ movimiento_id: res.body.id })).toBe(1);
    await request(app).put(`/api/movimientos/${res.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'factura' });
    expect(await CajaMovimiento.countDocuments({ movimiento_id: res.body.id })).toBe(0);
  });

  it('cambiar factura → remito crea el gasto de caja', async () => {
    const create = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'factura' });
    expect(await CajaMovimiento.countDocuments({ movimiento_id: create.body.id })).toBe(0);
    await request(app).put(`/api/movimientos/${create.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura', documento: 'remito' });
    const caja = await CajaMovimiento.findOne({ movimiento_id: create.body.id }).lean();
    expect(caja).not.toBeNull();
    expect(caja.metodo).toBe('efectivo');
  });

  it('el gasto de caja se agenda en la fecha de vencimiento del remito, no la de emisión', async () => {
    const res = await crearRemito({ fecha_vencimiento: '2025-01-15' });
    const caja = await CajaMovimiento.findOne({ movimiento_id: res.body.id }).lean();
    expect(caja.fecha).toBe('2025-01-15');   // vencimiento, no emisión (2025-01-01)
  });

  it('editar el vencimiento del remito reagenda el gasto de caja', async () => {
    const res = await crearRemito({ fecha_vencimiento: '2025-01-15' });
    await request(app).put(`/api/movimientos/${res.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', fecha_vencimiento: '2025-01-20', tipo: 'factura', documento: 'remito' });
    const caja = await CajaMovimiento.findOne({ movimiento_id: res.body.id }).lean();
    expect(caja.fecha).toBe('2025-01-20');
  });

  it('un remito sin vencimiento cae a la fecha de emisión', async () => {
    const res = await crearRemito();   // sin fecha_vencimiento y subrubro sin criterio
    const caja = await CajaMovimiento.findOne({ movimiento_id: res.body.id }).lean();
    expect(caja.fecha).toBe('2025-01-01');
  });
});
