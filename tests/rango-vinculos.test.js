// Cubre las dos features de la vista de Subrubro:
//   1) el filtro por rango de fechas (?desde/?hasta) del GET de movimientos, y
//   2) la traza factura → pagos/NC que alimenta la vinculación visual.
const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro } = require('../models');

setupTestDb();

let adminToken, subrubroId;

// Fechas fijas y viejas: así el rango probado no depende del día en que corran
// los tests, y ninguna cae dentro de "los últimos 30 días".
const VIEJA = '2024-01-15';
const MEDIA = '2024-03-10';
const NUEVA = '2024-06-20';

async function bootstrap() {
  const ah = await bcrypt.hash('admin123', 4);
  const aid = await Counter.next('users');
  await User.create({ _id: aid, usuario: 'admin', password_hash: ah, role: 'admin', activo: true });
  adminToken = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'Local Test', icon: '🏠' });
  const rid = await Counter.next('rubros');
  await Rubro.create({ _id: rid, nombre: 'Rubro Test', local_id: lid });
  const sid = await Counter.next('subrubros');
  await Subrubro.create({ _id: sid, rubro_id: rid, nombre: 'Proveedor Test', monto_base: 0 });
  subrubroId = sid;
}

const crear = (body) =>
  request(app).post(`/api/movimientos/${subrubroId}`).set('Authorization', `Bearer ${adminToken}`).send(body);

const pagoVinculado = (body) =>
  request(app).post(`/api/movimientos/${subrubroId}/pago-vinculado`).set('Authorization', `Bearer ${adminToken}`).send(body);

const get = (query = '') =>
  request(app).get(`/api/movimientos/${subrubroId}${query}`).set('Authorization', `Bearer ${adminToken}`);

describe('GET /movimientos/:id — filtro por rango de fechas', () => {
  beforeEach(async () => {
    await bootstrap();
    await crear({ monto: 100, fecha: VIEJA, tipo: 'factura' });
    await crear({ monto: 200, fecha: MEDIA, tipo: 'factura' });
    await crear({ monto: 300, fecha: NUEVA, tipo: 'factura' });
  });

  it('sin parámetros devuelve el histórico completo', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.movimientos).toHaveLength(3);
  });

  it('acota por desde + hasta (extremos incluidos)', async () => {
    const r = await get(`?desde=${MEDIA}&hasta=${NUEVA}`);
    expect(r.body.movimientos.map(m => m.fecha)).toEqual([MEDIA, NUEVA]);
  });

  it('acepta desde sin hasta: no corta hacia adelante', async () => {
    const r = await get(`?desde=${MEDIA}`);
    expect(r.body.movimientos.map(m => m.fecha)).toEqual([MEDIA, NUEVA]);
  });

  it('acepta hasta sin desde', async () => {
    const r = await get(`?hasta=${MEDIA}`);
    expect(r.body.movimientos.map(m => m.fecha)).toEqual([VIEJA, MEDIA]);
  });

  it('saldo_anterior acumula lo previo a "desde", para que el total corrido arranque bien', async () => {
    const r = await get(`?desde=${MEDIA}`);
    expect(r.body.saldo_anterior).toBe(100); // solo la factura de VIEJA
  });

  it('saldo_total sigue siendo el del subrubro completo, no el del rango', async () => {
    const r = await get(`?desde=${NUEVA}`);
    expect(r.body.movimientos).toHaveLength(1);
    expect(r.body.saldo_total).toBe(600);
  });

  it('rechaza una fecha con formato inválido', async () => {
    expect((await get('?desde=15-01-2024')).status).toBe(400);
    expect((await get('?hasta=ayer')).status).toBe(400);
  });

  it('el filtro por mes sigue funcionando igual', async () => {
    const r = await get('?anio=2024&mes=03');
    expect(r.body.movimientos.map(m => m.fecha)).toEqual([MEDIA]);
    expect(r.body.saldo_anterior).toBe(100);
  });
});

describe('GET /movimientos/:id — traza de vinculación factura ↔ pagos/NC', () => {
  beforeEach(bootstrap);

  it('la factura expone los pagos/NC que la cubrieron, con el monto aplicado', async () => {
    const f = (await crear({ monto: 1000, fecha: VIEJA, tipo: 'factura' })).body;
    await pagoVinculado({ tipo: 'pago', monto_pago: 400, fecha: MEDIA, facturas_vinculadas_ids: [f.id] });
    await pagoVinculado({ tipo: 'nota_credito', monto_pago: 100, fecha: NUEVA, facturas_vinculadas_ids: [f.id] });

    const factura = (await get()).body.movimientos.find(m => m.id === f.id);
    expect(factura.saldo).toBe(500); // 1000 − 400 − 100: el saldo REAL, no el monto
    expect(factura.pagos_aplicados).toHaveLength(2);
    expect(factura.pagos_aplicados).toEqual(expect.arrayContaining([
      expect.objectContaining({ monto: 400, tipo: 'pago', explicito: true, fecha: MEDIA }),
      expect.objectContaining({ monto: 100, tipo: 'nota_credito', explicito: true, fecha: NUEVA }),
    ]));
  });

  it('el pago expone las facturas que cubrió (relación en el otro sentido)', async () => {
    const f1 = (await crear({ monto: 100, fecha: VIEJA, tipo: 'factura' })).body;
    const f2 = (await crear({ monto: 200, fecha: MEDIA, tipo: 'factura' })).body;
    const p = (await pagoVinculado({ tipo: 'pago', monto_pago: 250, fecha: NUEVA, facturas_vinculadas_ids: [f1.id, f2.id] })).body;

    const pago = (await get()).body.movimientos.find(m => m.id === p.id);
    expect(pago.facturas_aplicadas).toEqual(expect.arrayContaining([
      expect.objectContaining({ mov_id: f1.id, monto: 100, explicito: true }),
      expect.objectContaining({ mov_id: f2.id, monto: 150, explicito: true }),
    ]));
    expect(pago.sin_aplicar).toBe(0);
  });

  it('un pago libre queda marcado como imputación automática (FIFO), no explícita', async () => {
    const f = (await crear({ monto: 100, fecha: VIEJA, tipo: 'factura' })).body;
    await crear({ pago: 60, fecha: MEDIA, tipo: 'pago' }); // sin facturas_vinculadas_ids

    const movs = (await get()).body.movimientos;
    const factura = movs.find(m => m.id === f.id);
    expect(factura.saldo).toBe(40);
    expect(factura.pagos_aplicados).toHaveLength(1);
    expect(factura.pagos_aplicados[0]).toMatchObject({ monto: 60, explicito: false });
  });

  it('un pago que no cubre ninguna factura queda identificable vía sin_aplicar', async () => {
    const p = (await crear({ pago: 500, fecha: MEDIA, tipo: 'pago' })).body; // no hay facturas

    const pago = (await get()).body.movimientos.find(m => m.id === p.id);
    expect(pago.facturas_aplicadas).toHaveLength(0);
    expect(pago.sin_aplicar).toBe(500);
  });

  it('el excedente de un pago sobre su factura queda como crédito sin aplicar', async () => {
    const f = (await crear({ monto: 100, fecha: VIEJA, tipo: 'factura' })).body;
    const p = (await pagoVinculado({ tipo: 'pago', monto_pago: 180, fecha: MEDIA, facturas_vinculadas_ids: [f.id] })).body;

    const pago = (await get()).body.movimientos.find(m => m.id === p.id);
    expect(pago.facturas_aplicadas).toEqual([expect.objectContaining({ mov_id: f.id, monto: 100 })]);
    expect(pago.sin_aplicar).toBe(80);
  });

  it('la traza sobrevive al filtro: una factura ve su pago aunque el pago quede fuera del rango', async () => {
    const f = (await crear({ monto: 1000, fecha: VIEJA, tipo: 'factura' })).body;
    await pagoVinculado({ tipo: 'pago', monto_pago: 400, fecha: NUEVA, facturas_vinculadas_ids: [f.id] });

    // Rango que contiene solo a la factura, no al pago.
    const r = await get(`?desde=${VIEJA}&hasta=${VIEJA}`);
    expect(r.body.movimientos).toHaveLength(1);
    const factura = r.body.movimientos[0];
    expect(factura.saldo).toBe(600);
    expect(factura.pagos_aplicados).toEqual([expect.objectContaining({ monto: 400, fecha: NUEVA })]);
  });
});
