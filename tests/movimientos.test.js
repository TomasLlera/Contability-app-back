const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, Audit } = require('../models');

setupTestDb();

let adminToken, viewerToken, subrubroId;

async function bootstrap() {
  const ah = await bcrypt.hash('admin123', 4);
  const vh = await bcrypt.hash('viewer123', 4);
  const aid = await Counter.next('users');
  const vid = await Counter.next('users');
  await User.create({ _id: aid, usuario: 'admin', password_hash: ah, role: 'admin', activo: true });
  await User.create({ _id: vid, usuario: 'viewer', password_hash: vh, role: 'viewer', activo: true });

  adminToken = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;
  viewerToken = (await request(app).post('/api/auth/login').send({ usuario: 'viewer', password: 'viewer123' })).body.token;

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'Local Test', icon: '🏠' });
  const rid = await Counter.next('rubros');
  await Rubro.create({ _id: rid, nombre: 'Rubro Test', local_id: lid });
  const sid = await Counter.next('subrubros');
  await Subrubro.create({ _id: sid, rubro_id: rid, nombre: 'Sub Test', monto_base: 0 });
  subrubroId = sid;
}

describe('Movimientos CRUD', () => {
  beforeEach(bootstrap);

  it('viewer no puede crear movimientos (403)', async () => {
    const res = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura' });
    expect(res.status).toBe(403);
  });

  it('admin crea factura y queda como no pagada', async () => {
    const res = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura' });
    expect(res.status).toBe(200);
    expect(res.body.monto).toBe(100);
    expect(res.body.pagado).toBe(false);
  });

  it('un pago libre que cubre la factura la marca pagada', async () => {
    await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura' });
    await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pago: 100, fecha: '2025-01-02', tipo: 'pago' });

    const factura = await Movimiento.findOne({ subrubro_id: subrubroId, tipo: 'factura' }).lean();
    expect(factura.pagado).toBe(true);
  });

  it('pago insuficiente NO marca la factura pagada', async () => {
    await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura' });
    await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pago: 50, fecha: '2025-01-02', tipo: 'pago' });

    const factura = await Movimiento.findOne({ subrubro_id: subrubroId, tipo: 'factura' }).lean();
    expect(factura.pagado).toBe(false);
  });

  it('crear movimiento queda registrado en audit', async () => {
    await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura' });

    const audits = await Audit.find({ recurso: 'movimiento', accion: 'create' }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0].usuario).toBe('admin');
  });

  it('no permite crear movimiento con fecha futura', async () => {
    const futuro = new Date(Date.now() + 86400000 * 30).toISOString().split('T')[0];
    const res = await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: futuro, tipo: 'factura' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Audit endpoint', () => {
  beforeEach(bootstrap);

  it('viewer no puede consultar audit', async () => {
    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it('admin recibe lista paginada', async () => {
    await request(app).post(`/api/movimientos/${subrubroId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100, fecha: '2025-01-01', tipo: 'factura' });

    const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.page).toBe(1);
  });
});
