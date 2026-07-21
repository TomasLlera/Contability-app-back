const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, CajaMovimiento } = require('../models');
const { computeSaldosFacturas } = require('../db');

setupTestDb();

let adminToken, rubroId, subConDesc, subSinDesc;

const hoy = () => new Date().toISOString().split('T')[0];

async function bootstrap() {
  const ah = await bcrypt.hash('admin123', 4);
  const aid = await Counter.next('users');
  await User.create({ _id: aid, usuario: 'admin', password_hash: ah, role: 'admin', activo: true });
  adminToken = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L', icon: 'x' });
  rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'R', local_id: lid });

  subConDesc = await Counter.next('subrubros');
  await Subrubro.create({ _id: subConDesc, rubro_id: rubroId, nombre: 'Proveedor XYZ', monto_base: 0, aplica_descuento: true });
  subSinDesc = await Counter.next('subrubros');
  await Subrubro.create({ _id: subSinDesc, rubro_id: rubroId, nombre: 'Proveedor ABC', monto_base: 0 });
}

const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

// Crea una factura en el subrubro y su ítem de caja pendiente enlazado.
async function facturaConItemCaja(subId, monto) {
  const fac = await auth(request(app).post(`/api/movimientos/${subId}`))
    .send({ monto, fecha: hoy(), tipo: 'factura' });
  const cajaId = await Counter.next('caja');
  await CajaMovimiento.create({
    _id: cajaId, fecha: hoy(), tipo: 'gasto', concepto: 'Proveedor',
    monto, metodo: 'efectivo', subrubro_id: subId, movimiento_id: fac.body.id,
    confirmado: false, auto_sync: true,
  });
  return { facturaId: fac.body.id, cajaId };
}

const saldoDe = async (subId, facturaId) =>
  computeSaldosFacturas(await Movimiento.find({ subrubro_id: subId }).lean()).get(facturaId);

describe('descuento por pago', () => {
  beforeEach(bootstrap);

  it('el flag aplica_descuento se persiste y se puede editar', async () => {
    const sub = await Subrubro.findById(subConDesc).lean();
    expect(sub.aplica_descuento).toBe(true);

    await auth(request(app).put(`/api/subrubros/${subSinDesc}`)).send({ aplica_descuento: true });
    expect((await Subrubro.findById(subSinDesc).lean()).aplica_descuento).toBe(true);
  });

  it('una deuda a cobrar nunca aplica descuento', async () => {
    await auth(request(app).put(`/api/subrubros/${subConDesc}`)).send({ tipo_subrubro: 'deuda' });
    expect((await Subrubro.findById(subConDesc).lean()).aplica_descuento).toBe(false);
  });

  it('confirmar con descuento genera la NC y deja el saldo en cero', async () => {
    const { facturaId, cajaId } = await facturaConItemCaja(subConDesc, 10000);

    const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento: 500 });
    expect(res.status).toBe(200);

    // El ítem de caja vale el NETO: es la plata que realmente salió de la caja.
    const item = await CajaMovimiento.findById(cajaId).lean();
    expect(item.monto).toBe(9500);
    expect(item.descuento).toBe(500);
    expect(item.monto_bruto).toBe(10000);
    expect(item.confirmado).toBe(true);

    // Pago por el neto + NC por el descuento, ambos vinculados a la factura.
    const pago = await Movimiento.findById(item.pago_mov_id).lean();
    expect(pago.tipo).toBe('pago');
    expect(pago.pago).toBe(9500);
    const nc = await Movimiento.findById(item.nc_mov_id).lean();
    expect(nc.tipo).toBe('nota_credito');
    expect(nc.pago).toBe(500);
    expect(nc.facturas_vinculadas_ids).toContain(facturaId);

    expect(await saldoDe(subConDesc, facturaId)).toBeCloseTo(0, 2);
  });

  it('confirmar sin descuento no genera NC', async () => {
    const { facturaId, cajaId } = await facturaConItemCaja(subConDesc, 10000);
    await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({});

    const item = await CajaMovimiento.findById(cajaId).lean();
    expect(item.monto).toBe(10000);
    expect(item.descuento).toBe(0);
    expect(item.nc_mov_id).toBeNull();
    expect(await saldoDe(subConDesc, facturaId)).toBeCloseTo(0, 2);
  });

  it('rechaza descuento en un subrubro que no lo admite', async () => {
    const { cajaId } = await facturaConItemCaja(subSinDesc, 10000);
    const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento: 500 });
    expect(res.status).toBe(400);
    expect((await CajaMovimiento.findById(cajaId).lean()).confirmado).toBe(false);
  });

  it('rechaza descuento mayor o igual al monto de la factura', async () => {
    const { cajaId } = await facturaConItemCaja(subConDesc, 10000);
    for (const descuento of [10000, 15000]) {
      const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento });
      expect(res.status).toBe(400);
    }
    expect((await CajaMovimiento.findById(cajaId).lean()).confirmado).toBe(false);
  });

  it('revertir borra el pago y la NC, y restaura el monto bruto', async () => {
    const { facturaId, cajaId } = await facturaConItemCaja(subConDesc, 10000);
    await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento: 500 });
    const confirmado = await CajaMovimiento.findById(cajaId).lean();

    await auth(request(app).post(`/api/caja/${cajaId}/revertir`)).send({});

    expect(await Movimiento.findById(confirmado.pago_mov_id).lean()).toBeNull();
    expect(await Movimiento.findById(confirmado.nc_mov_id).lean()).toBeNull();

    const item = await CajaMovimiento.findById(cajaId).lean();
    expect(item.confirmado).toBe(false);
    expect(item.monto).toBe(10000);      // vuelve al bruto, no queda en el neto
    expect(item.descuento).toBe(0);
    expect(await saldoDe(subConDesc, facturaId)).toBeCloseTo(10000, 2);
  });

  it('revertir y volver a confirmar no duplica movimientos (idempotency_key liberada)', async () => {
    const { cajaId } = await facturaConItemCaja(subConDesc, 10000);
    await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento: 500 });
    await auth(request(app).post(`/api/caja/${cajaId}/revertir`)).send({});
    const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento: 300 });
    expect(res.status).toBe(200);

    const item = await CajaMovimiento.findById(cajaId).lean();
    expect(item.monto).toBe(9700);
    expect(await Movimiento.countDocuments({ subrubro_id: subConDesc, tipo: 'pago' })).toBe(1);
    expect(await Movimiento.countDocuments({ subrubro_id: subConDesc, tipo: 'nota_credito' })).toBe(1);
  });

  it('descuento por porcentaje: el backend lo resuelve a pesos', async () => {
    const { facturaId, cajaId } = await facturaConItemCaja(subConDesc, 10000);
    await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento_pct: 7 });

    const item = await CajaMovimiento.findById(cajaId).lean();
    expect(item.descuento).toBe(700);        // 7% de 10.000
    expect(item.descuento_pct).toBe(7);
    expect(item.monto).toBe(9300);
    expect(await saldoDe(subConDesc, facturaId)).toBeCloseTo(0, 2);
  });

  it('el porcentaje redondea a centavos', async () => {
    const { facturaId, cajaId } = await facturaConItemCaja(subConDesc, 169058.38);
    await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento_pct: 7 });

    const item = await CajaMovimiento.findById(cajaId).lean();
    expect(item.descuento).toBe(11834.09);   // 169058.38 × 0.07 = 11834.0866 → 11834.09
    expect(item.monto).toBeCloseTo(157224.29, 2);
    expect(await saldoDe(subConDesc, facturaId)).toBeCloseTo(0, 2);
  });

  it('rechaza porcentajes fuera de rango', async () => {
    const { cajaId } = await facturaConItemCaja(subConDesc, 10000);
    for (const descuento_pct of [0, -5, 100, 150]) {
      const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento_pct });
      expect(res.status).toBe(400);
    }
  });

  it('GET /caja/descuentos agrega totales y desglosa por subrubro', async () => {
    await auth(request(app).put(`/api/subrubros/${subSinDesc}`)).send({ aplica_descuento: true });
    const a = await facturaConItemCaja(subConDesc, 10000);
    const b = await facturaConItemCaja(subSinDesc, 20000);
    await auth(request(app).post(`/api/caja/${a.cajaId}/confirmar`)).send({ descuento: 500 });
    await auth(request(app).post(`/api/caja/${b.cajaId}/confirmar`)).send({ descuento_pct: 10 });

    const res = await auth(request(app).get('/api/caja/descuentos'));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.total).toBeCloseTo(2500, 2);       // 500 + 2000
    expect(res.body.total_bruto).toBeCloseTo(30000, 2);
    expect(res.body.por_subrubro).toHaveLength(2);
    expect(res.body.por_subrubro[0].total).toBeCloseTo(2000, 2);  // ordenado desc
    expect(res.body.items[0].subrubro_nombre).toBeTruthy();

    // Filtrado por subrubro
    const soloUno = await auth(request(app).get('/api/caja/descuentos').query({ subrubro_id: subConDesc }));
    expect(soloUno.body.count).toBe(1);
    expect(soloUno.body.total).toBeCloseTo(500, 2);
  });

  it('los pagos sin descuento quedan fuera del seguimiento', async () => {
    const { cajaId } = await facturaConItemCaja(subConDesc, 10000);
    await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({});
    const res = await auth(request(app).get('/api/caja/descuentos'));
    expect(res.body.count).toBe(0);
    expect(res.body.total).toBe(0);
  });

  it('no se puede confirmar dos veces el mismo ítem', async () => {
    const { cajaId } = await facturaConItemCaja(subConDesc, 10000);
    await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento: 500 });
    const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ descuento: 500 });
    expect(res.status).toBe(409);
  });
});
