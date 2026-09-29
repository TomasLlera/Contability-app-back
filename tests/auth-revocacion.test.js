const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = require('../server');
const { User, Counter } = require('../models');

setupTestDb();

async function crearUser(usuario, role) {
  const id = await Counter.next('users');
  await User.create({ _id: id, usuario, password_hash: await bcrypt.hash('clave123', 4), role, activo: true });
  return id;
}
const login = async (usuario) => (await request(app).post('/api/auth/login').send({ usuario, password: 'clave123' })).body.token;
const get = (url, token) => request(app).get(url).set('Authorization', `Bearer ${token}`);

describe('Sesiones: el estado del usuario manda sobre el token', () => {
  let superToken, adminId, adminToken;
  beforeEach(async () => {
    await crearUser('jefe', 'superadmin');
    adminId = await crearUser('ana', 'admin');
    superToken = await login('jefe');
    adminToken = await login('ana');
  });

  it('desactivar un usuario corta su sesión de inmediato, y no puede renovar el token', async () => {
    expect((await get('/api/locales', adminToken)).status).toBe(200);
    const r = await request(app).put(`/api/users/${adminId}`).set('Authorization', `Bearer ${superToken}`).send({ activo: false });
    expect(r.status).toBe(200);

    expect((await get('/api/locales', adminToken)).status).toBe(401);
    const ref = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${adminToken}`);
    expect(ref.status).toBe(401);
  });

  it('bajar el rol rige desde la próxima request (el token viejo ya no da permisos de admin)', async () => {
    const crear = () => request(app).post('/api/locales').set('Authorization', `Bearer ${adminToken}`).send({ nombre: 'X' });
    expect((await crear()).status).toBe(200);
    await request(app).put(`/api/users/${adminId}`).set('Authorization', `Bearer ${superToken}`).send({ role: 'viewer' });
    expect((await crear()).status).toBe(403);
    // El refresh devuelve el rol nuevo.
    const ref = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${adminToken}`);
    expect(ref.status).toBe(200);
    expect(ref.body.role).toBe('viewer');
  });

  it('cambiar la contraseña invalida los tokens anteriores', async () => {
    await request(app).put(`/api/users/${adminId}/password`).set('Authorization', `Bearer ${superToken}`).send({ password: 'nueva123' });
    expect((await get('/api/locales', adminToken)).status).toBe(401);
    const nuevo = (await request(app).post('/api/auth/login').send({ usuario: 'ana', password: 'nueva123' })).body.token;
    expect((await get('/api/locales', nuevo)).status).toBe(200);
  });

  it('borrar un usuario corta su sesión', async () => {
    await request(app).delete(`/api/users/${adminId}`).set('Authorization', `Bearer ${superToken}`);
    expect((await get('/api/locales', adminToken)).status).toBe(401);
  });

  it('un token firmado para un usuario inexistente no entra', async () => {
    const falso = jwt.sign({ usuario: 'nadie', role: 'superadmin', userId: 999 }, process.env.JWT_SECRET);
    expect((await get('/api/users', falso)).status).toBe(401);
  });

  it('un token con rol inflado no da más permisos que los reales', async () => {
    const inflado = jwt.sign({ usuario: 'ana', role: 'superadmin', userId: adminId }, process.env.JWT_SECRET);
    expect((await get('/api/backup/export', inflado)).status).toBe(403);
  });
});

describe('Login: validación de entrada', () => {
  it('usuario o contraseña que no son texto → 400 (antes 500 con mensaje interno)', async () => {
    for (const body of [{ usuario: { $ne: null }, password: 'x' }, { usuario: 'a', password: { $gt: '' } }, {}]) {
      const r = await request(app).post('/api/auth/login').send(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('Usuario y contraseña requeridos');
    }
  });
});
