const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Audit } = require('../models');

setupTestDb();

async function crearUser(usuario, password, role = 'admin') {
  const id = await Counter.next('users');
  await User.create({
    _id: id, usuario, password_hash: await bcrypt.hash(password, 4),
    role, activo: true, created_at: new Date().toISOString(),
  });
  return id;
}

describe('POST /api/auth/login', () => {
  it('rechaza credenciales inválidas y registra login_failed', async () => {
    await crearUser('tomas', 'secreta123');
    const res = await request(app).post('/api/auth/login')
      .send({ usuario: 'tomas', password: 'wrong' });
    expect(res.status).toBe(401);

    const audits = await Audit.find({ accion: 'login_failed' }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0].usuario).toBe('tomas');
  });

  it('devuelve token y rol y registra login', async () => {
    await crearUser('tomas', 'secreta123', 'admin');
    const res = await request(app).post('/api/auth/login')
      .send({ usuario: 'tomas', password: 'secreta123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.role).toBe('admin');

    const audits = await Audit.find({ accion: 'login' }).lean();
    expect(audits).toHaveLength(1);
  });

  it('usuario inexistente registra login_failed sin user_id', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ usuario: 'fantasma', password: 'x' });
    expect(res.status).toBe(401);
    const audit = await Audit.findOne({ accion: 'login_failed' }).lean();
    expect(audit.diff.motivo).toBe('usuario_no_encontrado');
  });
});

describe('Middleware JWT', () => {
  it('bloquea peticiones sin token', async () => {
    const res = await request(app).get('/api/locales');
    expect(res.status).toBe(401);
  });

  it('bloquea con token inválido', async () => {
    const res = await request(app).get('/api/locales')
      .set('Authorization', 'Bearer xx.yy.zz');
    expect(res.status).toBe(401);
  });

  it('pasa con token válido', async () => {
    await crearUser('tomas', 'secreta123');
    const login = await request(app).post('/api/auth/login')
      .send({ usuario: 'tomas', password: 'secreta123' });
    const res = await request(app).get('/api/locales')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
  });
});
