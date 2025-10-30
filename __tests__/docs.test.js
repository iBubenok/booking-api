const request = require('supertest');
const { app } = require('../server');

describe('GET /docs', () => {
  it('serves Swagger UI (if openapi.yaml present)', async () => {
    const res = await request(app).get('/docs/');
    // Если openapi.yaml существует, Swagger UI отдаст HTML (200..399)
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(400);
    expect(res.text).toMatch(/Swagger UI/i);
  });
});

