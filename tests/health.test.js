const { setupTestDb } = require('./setup');
const request = require('supertest');
const app = require('../server');

setupTestDb();

describe('GET /api/health', () => {
  it('responde ok con mongo conectado', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
  });

  it('no requiere autenticación', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).not.toBe(401);
  });
});
