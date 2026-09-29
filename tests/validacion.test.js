const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, CajaMovimiento, CajaConfig } = require('../models');
const { hoyLocal, sumarDias } = require('../utils/tz');

setupTestDb();

let token, rubroId, subrubroId;
const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const hoy = () => hoyLocal();

beforeEach(async () => {
  await User.create({ _id: await Counter.next('users'), usuario: 'jefe', password_hash: await bcrypt.hash('x12345', 4), role: 'superadmin', activo: true });
  token = (await request(app).post('/api/auth/login').send({ usuario: 'jefe', password: 'x12345' })).body.token;
  const lid = await Counter.next('locales'); await Local.create({ _id: lid, nombre: 'L' });
  rubroId = await Counter.next('rubros'); await Rubro.create({ _id: rubroId, nombre: 'Proveedores', local_id: lid });
  subrubroId = await Counter.next('subrubros');
  await Subrubro.create({ _id: subrubroId, rubro_id: rubroId, nombre: 'Frutas (A)', monto_base: 0, dia_vencimiento: 7 });
  await CajaConfig.create({ _id: 'main', rubros_sync: [rubroId], dias_anticipacion_caja: 0 });
});

describe('Validación de movimientos', () => {
  const alta = (body) => auth(request(app).post(`/api/movimientos/${subrubroId}`)).send({ fecha: hoy(), ...body });

  it('rechaza montos negativos, tipos inventados y fechas imposibles con 400', async () => {
    expect((await alta({ tipo: 'factura', monto: -500 })).status).toBe(400);
    expect((await alta({ tipo: 'pago', pago: -300 })).status).toBe(400);
    expect((await alta({ tipo: 'loquesea', monto: 5 })).status).toBe(400);
    expect((await alta({ tipo: 'factura', monto: 5, fecha: '2026-02-30' })).status).toBe(400);
    expect((await alta({ tipo: 'factura', monto: 5, fecha_vencimiento: 'mañana' })).status).toBe(400);
    expect((await alta({ tipo: 'factura', monto: 0 })).status).toBe(400);
    expect((await alta({ tipo: 'pago', pago: 'abc' })).status).toBe(400);
    expect(await Movimiento.countDocuments()).toBe(0);
  });

  it('una fecha futura responde 400 (antes 500)', async () => {
    const r = await alta({ tipo: 'factura', monto: 10, fecha: sumarDias(hoy(), 5) });
    expect(r.status).toBe(400);
  });

  it('pago vinculado con monto 0 o tipo inválido → 400', async () => {
    const f = await alta({ tipo: 'factura', monto: 100 });
    const pv = (body) => auth(request(app).post(`/api/movimientos/${subrubroId}/pago-vinculado`)).send({ fecha: hoy(), facturas_vinculadas_ids: [f.body.id], ...body });
    expect((await pv({ tipo: 'pago', monto_pago: 0 })).status).toBe(400);
    expect((await pv({ tipo: 'factura', monto_pago: 50 })).status).toBe(400);
  });

  it('subrubro inexistente → 404', async () => {
    const r = await auth(request(app).post('/api/movimientos/9999')).send({ tipo: 'factura', monto: 5, fecha: hoy() });
    expect(r.status).toBe(404);
  });
});

describe('Validación de la Caja', () => {
  const alta = (body) => auth(request(app).post('/api/caja')).send({ fecha: hoy(), tipo: 'gasto', concepto: 'x', monto: 100, metodo: 'efectivo', ...body });

  it('rechaza montos negativos o no numéricos, tipos y métodos inventados, fechas imposibles', async () => {
    expect((await alta({ monto: -100 })).status).toBe(400);
    expect((await alta({ monto: 'abc' })).status).toBe(400);
    expect((await alta({ tipo: 'otro' })).status).toBe(400);
    expect((await alta({ metodo: 'cheque' })).status).toBe(400);
    expect((await alta({ fecha: 'no-es-fecha' })).status).toBe(400);
    expect(await CajaMovimiento.countDocuments()).toBe(0);
  });

  it('el saldo en cuenta se puede editar a 0', async () => {
    const r = await alta({ tipo: 'saldo_cuenta', monto: 5000, metodo: 'transferencia' });
    const e = await auth(request(app).put(`/api/caja/${r.body.id}`)).send({ monto: 0, concepto: 'Saldo en cuenta', metodo: 'transferencia' });
    expect(e.status).toBe(200);
  });
});

describe('Regex con texto del usuario', () => {
  it('el import encuentra un subrubro con paréntesis en el nombre (no crea un duplicado)', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Fecha', 'Importe'], [sumarDias(hoy(), -3), 1000]]), 'Frutas (A)');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const r = await auth(request(app).post(`/api/movimientos/import/${rubroId}`))
      .field('mapping', JSON.stringify({ fecha: 'fecha', importe: 'monto' }))
      .attach('file', buf, 'planilla.xlsx');
    expect(r.status).toBe(200);
    expect(await Subrubro.countDocuments({ rubro_id: rubroId })).toBe(1);
  });

  it('la búsqueda con caracteres especiales no rompe', async () => {
    for (const q of ['(a+)+$', '*', 'Frutas (A']) {
      const r = await auth(request(app).get('/api/movimientos/search').query({ q }));
      expect(r.status).toBe(200);
    }
  });

  it('no se puede crear dos veces un rubro con el mismo nombre aunque tenga caracteres especiales', async () => {
    const lid = (await Local.findOne().lean())._id;
    expect((await auth(request(app).post('/api/rubros')).send({ nombre: 'Gastos (varios)', local_id: lid })).status).toBe(200);
    const dup = await auth(request(app).post('/api/rubros')).send({ nombre: 'Gastos (varios)', local_id: lid });
    expect(dup.status).toBe(400);
  });
});

describe('Import de Excel', () => {
  it('un importe negativo entra como nota de crédito y las facturas sin vencimiento toman el del subrubro', async () => {
    const f = sumarDias(hoy(), -10);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Fecha', 'Importe'], [f, 1000], [f, -200], [f, '(50)']]), 'Frutas (A)');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const r = await auth(request(app).post(`/api/movimientos/import/${rubroId}`))
      .field('mapping', JSON.stringify({ fecha: 'fecha', importe: 'monto' }))
      .attach('file', buf, 'planilla.xlsx');
    expect(r.status).toBe(200);
    const movs = await Movimiento.find({ subrubro_id: subrubroId }).lean();
    const fac = movs.filter(m => m.tipo === 'factura');
    const ncs = movs.filter(m => m.tipo === 'nota_credito');
    expect(fac).toHaveLength(1);
    expect(fac[0]).toMatchObject({ monto: 1000, fecha_vencimiento: sumarDias(f, 7) });
    expect(ncs.map(n => n.pago).sort((a, b) => a - b)).toEqual([50, 200]);
  });

  it('un archivo de más de 10 MB responde 413', async () => {
    const r = await auth(request(app).post(`/api/movimientos/import/${rubroId}`))
      .field('mapping', '{}')
      .attach('file', Buffer.alloc(11 * 1024 * 1024), 'grande.xlsx');
    expect(r.status).toBe(413);
  });
});

describe('Backup: restaurar no rompe los contadores', () => {
  it('importar un backup viejo en modo merge deja los contadores por encima de los _id existentes', async () => {
    // Backup "viejo": contadores bajos.
    const zip = new AdmZip();
    zip.addFile('backup.json', Buffer.from(JSON.stringify({ version: 1, data: { Counter: [{ _id: 'movimientos', seq: 1 }, { _id: 'audit', seq: 1 }, { _id: 'users', seq: 0 }] } })));
    // Datos actuales más nuevos que el backup.
    for (let i = 0; i < 3; i++) {
      await auth(request(app).post(`/api/movimientos/${subrubroId}`)).send({ tipo: 'factura', monto: 10 + i, fecha: hoy() });
    }
    const imp = await auth(request(app).post('/api/backup/import')).field('mode', 'merge').attach('file', zip.toBuffer(), 'viejo.zip');
    expect(imp.status).toBe(200);

    const maxMov = (await Movimiento.findOne().sort({ _id: -1 }).lean())._id;
    expect((await Counter.findById('movimientos').lean()).seq).toBeGreaterThanOrEqual(maxMov);
    // Las altas siguientes funcionan (antes chocaban con E11000).
    const alta = await auth(request(app).post(`/api/movimientos/${subrubroId}`)).send({ tipo: 'factura', monto: 99, fecha: hoy() });
    expect(alta.status).toBe(200);
    expect((await Counter.findById('users').lean()).seq).toBeGreaterThanOrEqual(1);
  });
});
