const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, CajaMovimiento, CajaConfig } = require('../models');
const { hoyLocal, sumarDias } = require('../utils/tz');

setupTestDb();

let token, viewerToken, subrubroId;
const auth = (req, t = token) => req.set('Authorization', `Bearer ${t}`);
const dia = (n) => sumarDias(hoyLocal(), n);
const inconsistencias = async (t = token) => auth(request(app).get('/api/audit/inconsistencias'), t);
const cant = (body, key) => body.checks.find(c => c.key === key).cantidad;

beforeEach(async () => {
  const hash = await bcrypt.hash('x12345', 4);
  await User.create({ _id: await Counter.next('users'), usuario: 'admin', password_hash: hash, role: 'admin', activo: true });
  await User.create({ _id: await Counter.next('users'), usuario: 'ver', password_hash: hash, role: 'viewer', activo: true });
  token = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'x12345' })).body.token;
  viewerToken = (await request(app).post('/api/auth/login').send({ usuario: 'ver', password: 'x12345' })).body.token;
  const lid = await Counter.next('locales'); await Local.create({ _id: lid, nombre: 'L' });
  const rubroId = await Counter.next('rubros'); await Rubro.create({ _id: rubroId, nombre: 'R', local_id: lid });
  subrubroId = await Counter.next('subrubros'); await Subrubro.create({ _id: subrubroId, rubro_id: rubroId, nombre: 'Prov', monto_base: 0 });
  await CajaConfig.create({ _id: 'main', rubros_sync: [rubroId], dias_anticipacion_caja: 0 });
});

async function pagoConfirmado() {
  const f = await auth(request(app).post(`/api/movimientos/${subrubroId}`))
    .send({ tipo: 'factura', monto: 1000, fecha: dia(-10), fecha_vencimiento: dia(-2), metodo_pago: 'efectivo' });
  await auth(request(app).post('/api/caja/auto-sync').query({ fecha: hoyLocal() }));
  const item = await CajaMovimiento.findOne({ movimiento_id: f.body.id }).lean();
  const r = await auth(request(app).post(`/api/caja/${item._id}/confirmar`)).send({});
  return { facturaId: f.body.id, cajaId: item._id, pagoId: r.body.pago_mov_id };
}

describe('GET /api/audit/inconsistencias', () => {
  it('con datos sanos no reporta errores', async () => {
    await pagoConfirmado();
    const r = await inconsistencias();
    expect(r.status).toBe(200);
    expect(r.body.total_errores).toBe(0);
  });

  it('detecta un ítem de Caja con monto o fecha distintos a su pago', async () => {
    const { cajaId } = await pagoConfirmado();
    await CajaMovimiento.updateOne({ _id: cajaId }, { $set: { monto: 900, fecha: dia(-1) } }); // desincronización simulada
    const r = await inconsistencias();
    expect(cant(r.body, 'caja_pago_monto')).toBe(1);
    expect(cant(r.body, 'caja_pago_fecha')).toBe(1);
    expect(r.body.checks.find(c => c.key === 'caja_pago_monto').items[0]).toMatchObject({ caja_id: cajaId });
  });

  it('detecta referencias rotas', async () => {
    const { pagoId } = await pagoConfirmado();
    await Movimiento.deleteOne({ _id: pagoId }); // borrado por fuera de la app
    const r = await inconsistencias();
    expect(cant(r.body, 'referencias_rotas')).toBeGreaterThanOrEqual(1);
  });

  it('avisa de una factura vencida con saldo que no está en la Caja', async () => {
    const f = await auth(request(app).post(`/api/movimientos/${subrubroId}`))
      .send({ tipo: 'factura', monto: 500, fecha: dia(-10), fecha_vencimiento: dia(-2) });
    const r = await inconsistencias();
    expect(r.body.checks.find(c => c.key === 'factura_sin_pendiente').items.map(i => i.factura_id)).toContain(f.body.id);
  });

  it('es solo para administradores', async () => {
    expect((await inconsistencias(viewerToken)).status).toBe(403);
  });
});
