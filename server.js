require('dotenv').config();
const express = require('express');
const fs = require('fs');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

// Подключение к БД делаем "ленивым": без DATABASE_URL пусть будет null,
// чтобы /health и /docs работали в демо-режиме на этом шаге.
const { Pool } = require('pg');
const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

const app = express();
app.use(express.json());

// Swagger UI (/docs)
const openapiDoc = yaml.load(fs.readFileSync('./openapi.yaml', 'utf8'));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));

// Healthcheck — для Render healthCheckPath и быстрой проверки
app.get('/health', (req, res) => res.json({ status: 'ok', db: hasDb ? 'configured' : 'not-configured' }));

// Ваш эндпоинт бронирования
app.post('/api/bookings/reserve', async (req, res) => {
  if (!hasDb) {
    return res.status(500).json({ error: 'Database is not configured yet. Set DATABASE_URL.' });
  }

  const { event_id, user_id } = req.body || {};
  if (!event_id || !user_id || typeof user_id !== 'string') {
    return res.status(400).json({ error: 'Invalid payload: {event_id, user_id} required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Лочим событие (исключаем гонки при подсчёте мест)
    const ev = await client.query(
      'SELECT id, name, total_seats FROM events WHERE id = $1 FOR UPDATE',
      [event_id]
    );
    if (ev.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = ev.rows[0];

    // 2) Запрещаем повторную бронь тем же пользователем
    const dup = await client.query(
      'SELECT 1 FROM bookings WHERE event_id = $1 AND user_id = $2',
      [event_id, user_id]
    );
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'User already booked this event' });
    }

    // 3) Проверка sold out
    const taken = (await client.query(
      'SELECT COUNT(*)::int AS cnt FROM bookings WHERE event_id = $1',
      [event_id]
    )).rows[0].cnt;

    if (taken >= event.total_seats) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Event is sold out' });
    }

    // 4) Вставляем бронь
    const ins = await client.query(
      'INSERT INTO bookings (event_id, user_id, created_at) VALUES ($1, $2, NOW()) RETURNING id, event_id, user_id, created_at',
      [event_id, user_id]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      booking: ins.rows[0],
      seats_left: event.total_seats - (taken + 1)
    });
  } catch (err) {
    if (err && err.code === '23505') { // на случай гонки по уникальному индексу
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'User already booked this event' });
    }
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
