const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro } = require('../models');

setupTestDb();

let adminToken, subrubroId;

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

const crearMov = (body) => request(app).post(`/api/movimientos/${subrubroId}`)
  .set('Authorization', `Bearer ${adminToken}`).send(body);

const resumen = () => request(app).get('/api/iva/resumen').set('Authorization', `Bearer ${adminToken}`);
const mesResumen = async (mes) => (await resumen()).body.meses.find(m => m.mes === mes);

describe('Movimientos — Percepción IVA / Ingresos Brutos → resumen IVA', () => {
  beforeEach(bootstrap);

  it('guarda las percepciones en el movimiento sin tocar el monto', async () => {
    const res = await crearMov({ monto: 100000, fecha: '2026-05-10', tipo: 'factura', percepcion_iva: 500, ingresos_brutos: 300 });
    expect(res.status).toBe(200);
    expect(res.body.monto).toBe(100000);          // el monto no cambia
    expect(res.body.percepcion_iva).toBe(500);
    expect(res.body.ingresos_brutos).toBe(300);
  });

  it('una factura suma sus percepciones al acumulado del mes en el resumen', async () => {
    await crearMov({ monto: 100000, fecha: '2026-05-10', tipo: 'factura', percepcion_iva: 500, ingresos_brutos: 300 });

    const mayo = await mesResumen('2026-05');
    expect(mayo.compras.percepcion_iva).toBe(500);
    expect(mayo.compras.ingresos_brutos).toBe(300);
    // No afecta imp_total ni la diferencia (no hay IvaCompra ni ventas ese mes)
    expect(mayo.compras.imp_total).toBe(0);
    expect(mayo.diferencia).toBe(0);
  });

  it('una nota de crédito resta sus percepciones (neto factura - NC)', async () => {
    await crearMov({ monto: 100000, fecha: '2026-05-10', tipo: 'factura', percepcion_iva: 500, ingresos_brutos: 300 });
    await crearMov({ pago: 40000, fecha: '2026-05-15', tipo: 'nota_credito', percepcion_iva: 200, ingresos_brutos: 100 });

    const mayo = await mesResumen('2026-05');
    expect(mayo.compras.percepcion_iva).toBe(300);   // 500 - 200
    expect(mayo.compras.ingresos_brutos).toBe(200);  // 300 - 100
  });

  it('borrar el movimiento revierte el acumulado', async () => {
    const f = await crearMov({ monto: 100000, fecha: '2026-05-10', tipo: 'factura', percepcion_iva: 500, ingresos_brutos: 300 });

    let mayo = await mesResumen('2026-05');
    expect(mayo.compras.percepcion_iva).toBe(500);

    const del = await request(app).delete(`/api/movimientos/${f.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);

    mayo = await mesResumen('2026-05');
    // Sin movimientos ni IvaCompra ese mes, el mes ya no aparece en el resumen
    expect(mayo).toBeUndefined();
  });

  it('editar el movimiento actualiza el acumulado', async () => {
    const f = await crearMov({ monto: 100000, fecha: '2026-05-10', tipo: 'factura', percepcion_iva: 500, ingresos_brutos: 300 });

    await request(app).put(`/api/movimientos/${f.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto: 100000, fecha: '2026-05-10', tipo: 'factura', percepcion_iva: 900, ingresos_brutos: 100 });

    const mayo = await mesResumen('2026-05');
    expect(mayo.compras.percepcion_iva).toBe(900);
    expect(mayo.compras.ingresos_brutos).toBe(100);
  });

  it('un pago normal no aporta percepciones aunque se envíen', async () => {
    await crearMov({ pago: 5000, fecha: '2026-05-20', tipo: 'pago', percepcion_iva: 999, ingresos_brutos: 999 });
    const mayo = await mesResumen('2026-05');
    expect(mayo).toBeUndefined(); // no hay facturas/NC con percepciones → mes ausente
  });
});
