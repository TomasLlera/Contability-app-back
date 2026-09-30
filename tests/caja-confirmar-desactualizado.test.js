const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, CajaMovimiento, CajaConfig } = require('../models');
const { hoyLocal } = require('../utils/tz');

setupTestDb();

// La Caja se pinta antes de que termine el auto-sync, así que un pendiente en
// pantalla puede estar desactualizado respecto de su factura. /confirmar tiene que
// rechazarlo en vez de registrar un pago de más.

let adminToken, subrubroId;
const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

beforeEach(async () => {
  const ah = await bcrypt.hash('admin123', 4);
  await User.create({ _id: await Counter.next('users'), usuario: 'admin', password_hash: ah, role: 'admin', activo: true });
  adminToken = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L', icon: 'x' });
  const rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'R', local_id: lid });
  subrubroId = await Counter.next('subrubros');
  await Subrubro.create({ _id: subrubroId, rubro_id: rubroId, nombre: 'S', monto_base: 0 });
  await CajaConfig.create({ _id: 'main', empleados: [], proveedores: [], rubros_sync: [rubroId], dias_anticipacion_caja: 3 });
});

async function facturaSincronizada(monto) {
  const hoy = hoyLocal();
  const fact = await auth(request(app).post(`/api/movimientos/${subrubroId}`))
    .send({ monto, fecha: hoy, tipo: 'factura', fecha_vencimiento: hoy });
  expect(fact.status).toBe(200);
  const sync = await auth(request(app).post('/api/caja/auto-sync')).query({ fecha: hoy });
  expect(sync.body.creados).toBe(1);
  const item = await CajaMovimiento.findOne({ movimiento_id: fact.body.id, confirmado: false }).lean();
  await CajaMovimiento.updateOne({ _id: item._id }, { $set: { metodo: 'efectivo' } });
  return { facturaId: fact.body.id, itemId: item._id };
}

const pagarDesdeSubrubro = (facturaId, monto_pago) =>
  auth(request(app).post(`/api/movimientos/${subrubroId}/pago-vinculado`))
    .send({ tipo: 'pago', monto_pago, fecha: hoyLocal(), facturas_vinculadas_ids: [facturaId] });

describe('POST /caja/:id/confirmar con un pendiente auto-sync desactualizado', () => {
  it('rechaza si la factura ya se saldó desde el subrubro', async () => {
    const { facturaId, itemId } = await facturaSincronizada(1000);
    expect((await pagarDesdeSubrubro(facturaId, 1000)).status).toBe(200);

    const r = await auth(request(app).post(`/api/caja/${itemId}/confirmar`)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/saldada/);
    expect((await CajaMovimiento.findById(itemId).lean())?.confirmado).not.toBe(true);
  });

  it('rechaza si el saldo bajó por un pago parcial, y confirma tras re-sincronizar', async () => {
    const { facturaId, itemId } = await facturaSincronizada(1000);
    expect((await pagarDesdeSubrubro(facturaId, 400)).status).toBe(200);

    const r = await auth(request(app).post(`/api/caja/${itemId}/confirmar`)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/600/);

    const sync = await auth(request(app).post('/api/caja/auto-sync')).query({ fecha: hoyLocal() });
    expect(sync.body.actualizados).toBe(1);
    const ok = await auth(request(app).post(`/api/caja/${itemId}/confirmar`)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.monto).toBe(600);
  });

  it('confirma normalmente un pendiente al día', async () => {
    const { itemId } = await facturaSincronizada(1000);
    const r = await auth(request(app).post(`/api/caja/${itemId}/confirmar`)).send({});
    expect(r.status).toBe(200);
    expect(r.body.monto).toBe(1000);
  });
});
