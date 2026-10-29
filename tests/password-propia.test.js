const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Audit } = require('../models');
// Los ids se repiten entre tests (la base se vacía): se limpia la caché de sesiones.
const { invalidarUsuario } = require('../middleware/authJwt');

setupTestDb();

async function crear(usuario, role, password = 'clave123') {
  const id = await Counter.next('users');
  await User.create({ _id: id, usuario, password_hash: await bcrypt.hash(password, 4), role, activo: true });
  invalidarUsuario(id);
  return id;
}
const login = async (usuario, password = 'clave123') =>
  (await request(app).post('/api/auth/login').send({ usuario, password }));
const cambiar = (token, body) =>
  request(app).put('/api/users/me/password').set('Authorization', `Bearer ${token}`).send(body);

describe('cambio de la propia contraseña', () => {
  it('un admin cambia la suya: pide la actual, devuelve un token nuevo y la vieja deja de servir', async () => {
    await crear('ana', 'admin');
    const { token } = (await login('ana')).body;
    const r = await cambiar(token, { password_actual: 'clave123', password_nueva: 'nueva456' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    // El token viejo queda invalidado (token_version), el nuevo sigue adentro.
    expect((await request(app).get('/api/users').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get('/api/users').set('Authorization', `Bearer ${r.body.token}`)).status).toBe(200);
    expect((await login('ana')).status).toBe(401);
    expect((await login('ana', 'nueva456')).status).toBe(200);
  });

  it('rechaza la actual incorrecta, una nueva corta o igual a la actual', async () => {
    await crear('ana', 'admin');
    const { token } = (await login('ana')).body;
    expect((await cambiar(token, { password_actual: 'mal', password_nueva: 'nueva456' })).status).toBe(400);
    expect((await cambiar(token, { password_actual: 'clave123', password_nueva: '123' })).status).toBe(400);
    expect((await cambiar(token, { password_actual: 'clave123', password_nueva: 'clave123' })).status).toBe(400);
  });

  it('un viewer no puede cambiar la suya (la cambia el superadmin)', async () => {
    const vid = await crear('vero', 'viewer');
    const { token } = (await login('vero')).body;
    expect((await cambiar(token, { password_actual: 'clave123', password_nueva: 'nueva456' })).status).toBe(403);
    await crear('root', 'superadmin');
    const sup = (await login('root')).body.token;
    const r = await request(app).put(`/api/users/${vid}/password`).set('Authorization', `Bearer ${sup}`).send({ password: 'otra789' });
    expect(r.status).toBe(200);
    expect((await login('vero', 'otra789')).status).toBe(200);
  });

  it('un admin no puede cambiar la de otro usuario', async () => {
    await crear('ana', 'admin');
    const otro = await crear('beto', 'viewer');
    const { token } = (await login('ana')).body;
    const r = await request(app).put(`/api/users/${otro}/password`).set('Authorization', `Bearer ${token}`).send({ password: 'otra789' });
    expect(r.status).toBe(403);
  });

  it('la auditoría registra el cambio sin guardar las contraseñas', async () => {
    await crear('ana', 'admin');
    const { token } = (await login('ana')).body;
    await cambiar(token, { password_actual: 'clave123', password_nueva: 'nueva456' });
    const a = await Audit.findOne({ recurso: 'user_password_propia' }).lean();
    expect(a).toBeTruthy();
    const txt = JSON.stringify(a.diff);
    expect(txt).not.toContain('clave123');
    expect(txt).not.toContain('nueva456');
  });
});
