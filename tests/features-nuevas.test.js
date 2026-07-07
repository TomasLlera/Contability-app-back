const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, Audit, CajaMovimiento } = require('../models');

setupTestDb();

let superToken, adminToken, rubroId, subId;

// Firma el token localmente (mismo payload que /auth/login) para no gatillar el
// rate-limiter de login al reseedear en cada test.
async function mkUser(usuario, role) {
  const id = await Counter.next('users');
  await User.create({ _id: id, usuario, password_hash: await bcrypt.hash('clave123', 4), role, activo: true });
  const token = jwt.sign({ usuario, role, userId: id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  return { id, token };
}

async function bootstrap() {
  ({ token: superToken } = await mkUser('jefe', 'superadmin'));
  ({ token: adminToken } = await mkUser('empleado', 'admin'));

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'Local', icon: '🏠' });
  rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'Proveedores', local_id: lid });
  subId = await Counter.next('subrubros');
  await Subrubro.create({ _id: subId, rubro_id: rubroId, nombre: 'Proveedor A', monto_base: 0 });

  // Facturas en dos meses para tener saldo anterior y actual
  await request(app).post(`/api/movimientos/${subId}`).set('Authorization', `Bearer ${superToken}`)
    .send({ monto: 10000, fecha: '2026-06-10', tipo: 'factura' });
  await request(app).post(`/api/movimientos/${subId}`).set('Authorization', `Bearer ${superToken}`)
    .send({ monto: 2000, fecha: '2026-07-05', tipo: 'factura' });
}

describe('S1 · Reporte mensual de subrubros', () => {
  beforeEach(bootstrap);

  it('genera un Excel válido (xlsx) para el mes', async () => {
    const res = await request(app)
      .get(`/api/reportes/subrubros-mensual/${rubroId}`)
      .query({ mes: '2026-07' })
      .set('Authorization', `Bearer ${superToken}`)
      .buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.body.slice(0, 2).toString()).toBe('PK'); // firma zip/xlsx
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it('404 si el rubro no existe', async () => {
    const res = await request(app)
      .get('/api/reportes/subrubros-mensual/99999')
      .query({ mes: '2026-07' })
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(404);
  });
});

describe('S1 · cálculo getSubrubrosMensual', () => {
  beforeEach(bootstrap);
  it('calcula saldo anterior/actual, diferencia y tendencia', async () => {
    const db = require('../db');
    const { subrubros, mesAnterior } = await db.getSubrubrosMensual(rubroId, '2026-07');
    expect(mesAnterior).toBe('2026-06');
    const a = subrubros.find(s => s.id === subId);
    expect(a.saldoAnterior).toBe(10000); // solo la factura de junio
    expect(a.saldoActual).toBe(12000);   // junio + julio impagas
    expect(a.diferencia).toBe(2000);
    expect(a.tendencia).toBe('sube');
    expect(a.facturadoMes).toBe(2000);
  });
});

describe('S6 · gestión de usuarios por rol', () => {
  beforeEach(bootstrap);

  it('admin (no superadmin) no puede crear usuarios (403)', async () => {
    const res = await request(app).post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ usuario: 'nuevo', password: 'clave123', role: 'viewer' });
    expect(res.status).toBe(403);
  });

  it('superadmin crea, edita rol y protege al último superadmin', async () => {
    const crear = await request(app).post('/api/users')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ usuario: 'nuevo', password: 'clave123', role: 'viewer' });
    expect(crear.status).toBe(200);

    const edit = await request(app).put(`/api/users/${crear.body.id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ role: 'admin' });
    expect(edit.status).toBe(200);
    expect(edit.body.role).toBe('admin');

    // No se puede quitar el último superadmin (jefe)
    const jefe = await User.findOne({ usuario: 'jefe' }).lean();
    const demote = await request(app).put(`/api/users/${jefe._id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ role: 'viewer' });
    expect(demote.status).toBe(400);
  });

  it('admin puede listar usuarios (GET permitido)', async () => {
    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('S2 · Reporte mensual de caja', () => {
  beforeEach(async () => {
    await bootstrap();
    const mk = async (fecha, tipo, monto, metodo) => {
      const id = await Counter.next('caja');
      await CajaMovimiento.create({ _id: id, fecha, tipo, monto, metodo, concepto: `${tipo} ${fecha}` });
    };
    await mk('2026-07-03', 'gasto', 1500, 'efectivo');
    await mk('2026-07-12', 'ingreso_extra', 5000, 'efectivo');
    await mk('2026-07-20', 'gasto', 800, 'transferencia');
    await mk('2026-06-10', 'gasto', 1000, 'efectivo');
  });

  it('genera un Excel válido con las 3 hojas', async () => {
    const res = await request(app)
      .get('/api/reportes/caja-mensual')
      .query({ mes: '2026-07' })
      .set('Authorization', `Bearer ${superToken}`)
      .buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.body.slice(0, 2).toString()).toBe('PK');
    expect(res.body.length).toBeGreaterThan(1000);
  });
});

describe('S8 · Backup export/import', () => {
  beforeEach(bootstrap);

  it('exporta un ZIP y lo reimporta restaurando datos', async () => {
    // Export
    const exp = await request(app)
      .get('/api/backup/export')
      .set('Authorization', `Bearer ${superToken}`)
      .buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toContain('zip');
    expect(exp.body.slice(0, 2).toString()).toBe('PK');
    const zipBuf = exp.body;

    // Borramos un subrubro y lo restauramos por import (merge)
    await Subrubro.deleteMany({});
    expect(await Subrubro.countDocuments()).toBe(0);

    const imp = await request(app)
      .post('/api/backup/import')
      .set('Authorization', `Bearer ${superToken}`)
      .field('mode', 'merge')
      .attach('file', zipBuf, 'backup.zip');
    expect(imp.status).toBe(200);
    expect(imp.body.ok).toBe(true);
    expect(imp.body.saltados).toContain('User'); // no toca usuarios
    expect(await Subrubro.countDocuments()).toBeGreaterThan(0);
  });

  it('admin (no superadmin) no puede exportar (403)', async () => {
    const res = await request(app).get('/api/backup/export').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('rechaza un archivo inválido', async () => {
    const res = await request(app)
      .post('/api/backup/import')
      .set('Authorization', `Bearer ${superToken}`)
      .field('mode', 'merge')
      .attach('file', Buffer.from('no soy un backup'), 'malo.json');
    expect(res.status).toBe(400);
  });
});

describe('S7 · auditoría captura estado previo', () => {
  beforeEach(bootstrap);

  it('un update de movimiento registra diff.before', async () => {
    const factura = await Movimiento.findOne({ subrubro_id: subId, monto: 2000 }).lean();
    await request(app).put(`/api/movimientos/${factura._id}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ monto: 2500, fecha: '2026-07-05', tipo: 'factura' });

    const audit = await Audit.findOne({ recurso: 'movimiento', accion: 'update' }).lean();
    expect(audit).toBeTruthy();
    expect(audit.diff.before).toBeTruthy();
    expect(audit.diff.before.monto).toBe(2000);
  });
});
