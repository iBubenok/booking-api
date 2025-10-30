const request = require('supertest');
const { app } = require('../server');

describe('POST /api/bookings/reserve without DB', () => {
  it('returns 503 when DATABASE_URL is not set', async () => {
    const res = await request(app)
      .post('/api/bookings/reserve')
      .send({ event_id: 1, user_id: 'user123' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('error');
  });
});
