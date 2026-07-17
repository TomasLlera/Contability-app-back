const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento } = require('../models');

setupTestDb();

let adminToken, subrubroId;

const hoy = () => new Date().toISOString().split('T')[0];

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

const getMovs = async () =>
  (await request(app).get(`/api/movimientos/${subrubroId}`).set('Authorization', `Bearer ${adminToken}`)).body.movimientos;

describe('NC vinculada: se aplica al SALDO de la factura elegida', () => {
  beforeEach(bootstrap);

  it('una NC sobre una factura con saldo parcial descuenta del saldo, no del monto original', async () => {
    // Factura de $500 con pago vinculado de $400 → saldo $100 (caso del reporte)
    const factura = (await crear({ monto: 500, fecha: hoy(), fecha_vencimiento: hoy(), tipo: 'factura' })).body;
    await pagoVinculado({ tipo: 'pago', monto_pago: 400, fecha: hoy(), facturas_vinculadas_ids: [factura.id] });

    // NC de $50 aplicada a ESA factura
    const nc = await pagoVinculado({ tipo: 'nota_credito', monto_pago: 50, fecha: hoy(), facturas_vinculadas_ids: [factura.id] });
    expect(nc.status).toBe(200);

    // La respuesta detalla la aplicación: saldo $100 − $50 → $50 (auditoría)
    expect(nc.body.aplicaciones).toHaveLength(1);
    expect(nc.body.aplicaciones[0]).toMatchObject({
      factura_id: factura.id,
      monto_original: 500,
      saldo_anterior: 100,
      aplicado: 50,
      saldo_posterior: 50,
      saldada: false,
    });

    // El saldo de la factura queda en $50 y sigue pendiente
    const f = (await getMovs()).find(m => m.id === factura.id);
    expect(f.saldo).toBe(50);
    expect(f.pagado).toBe(false);
  });

  it('una NC igual al saldo deja la factura saldada', async () => {
    const factura = (await crear({ monto: 500, fecha: hoy(), fecha_vencimiento: hoy(), tipo: 'factura' })).body;
    await pagoVinculado({ tipo: 'pago', monto_pago: 400, fecha: hoy(), facturas_vinculadas_ids: [factura.id] });

    const nc = await pagoVinculado({ tipo: 'nota_credito', monto_pago: 100, fecha: hoy(), facturas_vinculadas_ids: [factura.id] });
    expect(nc.body.aplicaciones[0]).toMatchObject({ saldo_posterior: 0, saldada: true });

    const f = (await getMovs()).find(m => m.id === factura.id);
    expect(f.saldo).toBe(0);
    expect(f.pagado).toBe(true);
  });

  it('rechaza una NC mayor al saldo de la factura vinculada (pago-vinculado)', async () => {
    const factura = (await crear({ monto: 500, fecha: hoy(), fecha_vencimiento: hoy(), tipo: 'factura' })).body;
    await pagoVinculado({ tipo: 'pago', monto_pago: 400, fecha: hoy(), facturas_vinculadas_ids: [factura.id] });

    // Saldo $100, NC $150 → rechazada
    const nc = await pagoVinculado({ tipo: 'nota_credito', monto_pago: 150, fecha: hoy(), facturas_vinculadas_ids: [factura.id] });
    expect(nc.status).toBe(400);
    expect(nc.body.error).toMatch(/supera el saldo/i);
    // No quedó nada persistido
    expect(await Movimiento.countDocuments({ subrubro_id: subrubroId, tipo: 'nota_credito' })).toBe(0);
  });

  it('rechaza una NC mayor al saldo también por el POST normal de movimientos', async () => {
    const factura = (await crear({ monto: 200, fecha: hoy(), fecha_vencimiento: hoy(), tipo: 'factura' })).body;
    const nc = await crear({ pago: 300, fecha: hoy(), tipo: 'nota_credito', facturas_vinculadas_ids: [factura.id] });
    expect(nc.status).toBe(400);
    expect(nc.body.error).toMatch(/supera el saldo/i);
  });

  it('la NC elegida no toca otras facturas más viejas', async () => {
    // Factura vieja pendiente + factura nueva con saldo parcial
    const vieja = (await crear({ monto: 800, fecha: '2026-05-01', fecha_vencimiento: '2026-05-10', tipo: 'factura' })).body;
    const nueva = (await crear({ monto: 500, fecha: hoy(), fecha_vencimiento: hoy(), tipo: 'factura' })).body;
    await pagoVinculado({ tipo: 'pago', monto_pago: 400, fecha: hoy(), facturas_vinculadas_ids: [nueva.id] });

    // NC de $50 vinculada a la NUEVA: la vieja no debe cambiar
    await pagoVinculado({ tipo: 'nota_credito', monto_pago: 50, fecha: hoy(), facturas_vinculadas_ids: [nueva.id] });

    const movs = await getMovs();
    expect(movs.find(m => m.id === vieja.id).saldo).toBe(800);   // intacta
    expect(movs.find(m => m.id === nueva.id).saldo).toBe(50);    // 100 − 50
  });

  it('editar una NC permite subir el monto hasta el saldo (excluye su propia aplicación previa)', async () => {
    const factura = (await crear({ monto: 500, fecha: hoy(), fecha_vencimiento: hoy(), tipo: 'factura' })).body;
    const nc = (await pagoVinculado({ tipo: 'nota_credito', monto_pago: 300, fecha: hoy(), facturas_vinculadas_ids: [factura.id] })).body;

    // Subir la NC de 300 a 450: válido (el saldo sin esta NC es 500)
    const ok = await request(app).put(`/api/movimientos/${nc.id}/pago-vinculado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto_pago: 450, fecha: hoy(), facturas_vinculadas_ids: [factura.id] });
    expect(ok.status).toBe(200);
    expect(ok.body.aplicaciones[0].saldo_posterior).toBe(50);

    // Subirla a 600: supera el monto/saldo total → rechazada
    const mal = await request(app).put(`/api/movimientos/${nc.id}/pago-vinculado`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monto_pago: 600, fecha: hoy(), facturas_vinculadas_ids: [factura.id] });
    expect(mal.status).toBe(400);
  });
});
