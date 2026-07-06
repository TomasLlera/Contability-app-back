const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro } = require('../models');

setupTestDb();

let adminToken, subrubroId;

const hoy = () => new Date().toISOString().split('T')[0];
const enDias = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];

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
  await Subrubro.create({ _id: sid, rubro_id: rid, nombre: 'Sub Test', monto_base: 0 });
  subrubroId = sid;
}

const crear = (body) =>
  request(app).post(`/api/movimientos/${subrubroId}`).set('Authorization', `Bearer ${adminToken}`).send(body);

const getVenc = (dias = 30) =>
  request(app).get(`/api/movimientos/vencimientos/proximos?dias=${dias}`).set('Authorization', `Bearer ${adminToken}`);

describe('Vencimientos: saldo (NC / pagos), no monto original', () => {
  beforeEach(bootstrap);

  it('una NC parcial deja el vencimiento con el saldo pendiente, no el monto original', async () => {
    const factura = (await crear({ monto: 1000, fecha: hoy(), fecha_vencimiento: enDias(3), tipo: 'factura' })).body;
    await crear({ pago: 300, fecha: hoy(), tipo: 'nota_credito', facturas_vinculadas_ids: [factura.id] });

    const res = await getVenc(30);
    expect(res.status).toBe(200);
    const item = res.body.find(v => v.id === factura.id);
    expect(item).toBeTruthy();
    expect(item.saldo).toBe(700);
    expect(item.monto).toBe(700);          // los consumidores muestran el saldo
    expect(item.monto_original).toBe(1000);
  });

  it('una NC que cubre el total saca la factura de los vencimientos', async () => {
    const factura = (await crear({ monto: 1000, fecha: hoy(), fecha_vencimiento: enDias(3), tipo: 'factura' })).body;
    await crear({ pago: 1000, fecha: hoy(), tipo: 'nota_credito', facturas_vinculadas_ids: [factura.id] });

    const res = await getVenc(30);
    expect(res.body.find(v => v.id === factura.id)).toBeUndefined();
  });

  it('sin pagos ni NC el saldo es igual al monto', async () => {
    const factura = (await crear({ monto: 500, fecha: hoy(), fecha_vencimiento: enDias(5), tipo: 'factura' })).body;

    const res = await getVenc(30);
    const item = res.body.find(v => v.id === factura.id);
    expect(item.saldo).toBe(500);
    expect(item.monto).toBe(500);
  });
});

describe('Modo de vencimiento "día fijo del mes" (integración)', () => {
  beforeEach(bootstrap);

  it('un subrubro con dia_mes calcula el vencimiento de la factura al día fijo del mes', async () => {
    // Subrubro con vencimiento el día 14 de cada mes
    const sub = (await request(app).post(`/api/subrubros/1`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Prov Día Fijo', modo_vencimiento: 'dia_mes', dia_mes_vencimiento: 14 })).body;
    expect(sub.modo_vencimiento).toBe('dia_mes');
    expect(sub.dia_mes_vencimiento).toBe(14);

    // Factura emitida antes del 14 → vence el 14 del mismo mes (fecha pasada, válida)
    const f1 = (await request(app).post(`/api/movimientos/${sub.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, fecha: '2026-05-10', tipo: 'factura' })).body;
    expect(f1.fecha_vencimiento).toBe('2026-05-14');

    // Factura emitida después del 14 → vence el 14 del mes siguiente
    const f2 = (await request(app).post(`/api/movimientos/${sub.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 1000, fecha: '2026-05-20', tipo: 'factura' })).body;
    expect(f2.fecha_vencimiento).toBe('2026-06-14');
  });

  it('rechaza dia_mes_vencimiento fuera de rango (1-31)', async () => {
    const res = await request(app).post(`/api/subrubros/1`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Prov Inválido', modo_vencimiento: 'dia_mes', dia_mes_vencimiento: 40 });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
