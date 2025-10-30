const request = require('supertest');
const { app } = require('../server');

describe('GET /health', () => {
  it('returns 200 and JSON with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(['configured', 'not-configured']).toContain(res.body.db);
  });
});
