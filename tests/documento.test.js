const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento } = require('../models');

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
