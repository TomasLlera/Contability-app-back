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
  subrubroId = await Counter.next('subrubros');
  await Subrubro.create({ _id: subrubroId, rubro_id: rid, nombre: 'S', monto_base: 0 });

  // El backstop de carrera depende del índice único parcial; asegurarlo en la DB
  // en memoria (en prod lo hace server.js al arrancar).
  await Promise.all([Movimiento.createIndexes(), CajaMovimiento.createIndexes()]);
}

const auth = (r) => r.set('Authorization', `Bearer ${adminToken}`);

describe('Idempotencia: prevención de duplicados', () => {
  beforeEach(bootstrap);

  it('dos altas de factura con la misma idempotency_key crean UN solo movimiento', async () => {
    const key = 'test-key-factura-1';
    const payload = { monto: 500, fecha: '2025-01-01', tipo: 'factura', idempotency_key: key };

    const r1 = await auth(request(app).post(`/api/movimientos/${subrubroId}`).send(payload));
    const r2 = await auth(request(app).post(`/api/movimientos/${subrubroId}`).send(payload));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id); // el segundo devuelve el existente
    expect(await Movimiento.countDocuments({ subrubro_id: subrubroId })).toBe(1);
  });

  it('dos altas concurrentes con la misma clave convergen a un solo registro', async () => {
    const key = 'test-key-concurrente';
    const payload = { pago: 300, fecha: '2025-01-02', tipo: 'pago', idempotency_key: key };

    const [r1, r2] = await Promise.all([
      auth(request(app).post(`/api/movimientos/${subrubroId}`).send(payload)),
      auth(request(app).post(`/api/movimientos/${subrubroId}`).send(payload)),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await Movimiento.countDocuments({ subrubro_id: subrubroId, idempotency_key: key })).toBe(1);
  });

  it('altas SIN clave no se deduplican (el comportamiento legacy se conserva)', async () => {
    const payload = { monto: 100, fecha: '2025-01-03', tipo: 'factura' };
    await auth(request(app).post(`/api/movimientos/${subrubroId}`).send(payload));
    await auth(request(app).post(`/api/movimientos/${subrubroId}`).send(payload));
    expect(await Movimiento.countDocuments({ subrubro_id: subrubroId })).toBe(2);
  });

  it('borrar un duplicado deja el otro registro intacto', async () => {
    // Dos altas con claves distintas → dos registros legítimos
    const a = await auth(request(app).post(`/api/movimientos/${subrubroId}`).send({ monto: 100, fecha: '2025-01-04', tipo: 'factura', idempotency_key: 'k-a' }));
    const b = await auth(request(app).post(`/api/movimientos/${subrubroId}`).send({ monto: 100, fecha: '2025-01-04', tipo: 'factura', idempotency_key: 'k-b' }));

    await auth(request(app).delete(`/api/movimientos/${a.body.id}`));

    expect(await Movimiento.findById(a.body.id).lean()).toBeNull();
    expect(await Movimiento.findById(b.body.id).lean()).toBeTruthy();
  });

  it('reusar la clave tras borrar permite re-crear (la clave queda libre)', async () => {
    const key = 'caja-confirm-99';
    const payload = { pago: 200, fecha: '2025-01-05', tipo: 'pago', idempotency_key: key };

    const r1 = await auth(request(app).post(`/api/movimientos/${subrubroId}`).send(payload));
    await auth(request(app).delete(`/api/movimientos/${r1.body.id}`));
    const r2 = await auth(request(app).post(`/api/movimientos/${subrubroId}`).send(payload));

    expect(r2.status).toBe(200);
    expect(r2.body.id).not.toBe(r1.body.id); // se creó uno nuevo
    expect(await Movimiento.countDocuments({ idempotency_key: key })).toBe(1);
  });

  it('pago-vinculado respeta la idempotency_key', async () => {
    const fact = await auth(request(app).post(`/api/movimientos/${subrubroId}`).send({ monto: 400, fecha: '2025-01-06', tipo: 'factura' }));
    const payload = { tipo: 'pago', monto_pago: 400, fecha: '2025-01-07', facturas_vinculadas_ids: [fact.body.id], metodo_pago: 'efectivo', idempotency_key: 'pv-1' };

    const r1 = await auth(request(app).post(`/api/movimientos/${subrubroId}/pago-vinculado`).send(payload));
    const r2 = await auth(request(app).post(`/api/movimientos/${subrubroId}/pago-vinculado`).send(payload));

    expect(r2.body.id).toBe(r1.body.id);
    expect(await Movimiento.countDocuments({ subrubro_id: subrubroId, tipo: 'pago' })).toBe(1);
  });

  it('alta de caja con la misma clave no duplica', async () => {
    const payload = { fecha: '2025-01-08', tipo: 'gasto', concepto: 'Proveedor X', monto: 1000, metodo: 'efectivo', idempotency_key: 'caja-1' };

    const r1 = await auth(request(app).post('/api/caja').send(payload));
    const r2 = await auth(request(app).post('/api/caja').send(payload));

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    expect(await CajaMovimiento.countDocuments({ idempotency_key: 'caja-1' })).toBe(1);
  });
});
