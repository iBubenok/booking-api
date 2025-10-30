// server.js
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// --- Swagger UI (/docs) ---
let openapiDoc = null;
try {
  openapiDoc = yaml.load(fs.readFileSync('./openapi.yaml', 'utf8'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));
} catch (e) {
  // Если файла нет — просто не поднимаем /docs, логируем предупреждение
  console.warn('openapi.yaml not found or invalid. /docs will be unavailable.');
}

// --- База данных ---
const hasDb = !!process.env.DATABASE_URL;
const pool = hasDb ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

// Healthcheck — Render будет пинговать этот путь
app.get('/health', async (req, res) => {
  // Лёгкий health без обращения к БД: достаточно 200 OK
  res.json({ status: 'ok', db: hasDb ? 'configured' : 'not-configured' });
});

// --- Бронирование ---
app.post('/api/bookings/reserve', async (req, res) => {
  if (!hasDb) {
    return res.status(500).json({ error: 'Database is not configured yet. Set DATABASE_URL.' });
  }

  const { event_id, user_id } = req.body || {};

  // Валидация входа
  const eid = Number(event_id);
  if (!Number.isInteger(eid) || eid <= 0 || !user_id || typeof user_id !== 'string') {
    return res.status(400).json({ error: 'Invalid payload: {event_id(int>0), user_id(string)} required' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1) Лочим событие, чтобы избежать гонок на подсчёте мест
    const ev = await client.query(
      'SELECT id, name, total_seats FROM events WHERE id = $1 FOR UPDATE',
      [eid]
    );
    if (ev.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = ev.rows[0];

    // 2) Проверяем повторную бронь этим пользователем
    const dup = await client.query(
      'SELECT 1 FROM bookings WHERE event_id = $1 AND user_id = $2',
      [eid, user_id]
    );
    if (dup.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'User already booked this event' });
    }

    // 3) Проверяем, остались ли места
    const takenRes = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM bookings WHERE event_id = $1',
      [eid]
    );
    const taken = takenRes.rows[0].cnt;
    if (taken >= event.total_seats) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Event is sold out' });
    }

    // 4) Создаём бронь
    const ins = await client.query(
      'INSERT INTO bookings (event_id, user_id, created_at) VALUES ($1, $2, NOW()) RETURNING id, event_id, user_id, created_at',
      [eid, user_id]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      booking: ins.rows[0],
      seats_left: event.total_seats - (taken + 1)
    });
  } catch (err) {
    // Пытаемся откатить транзакцию, если клиент уже взят
    try {
      if (client) await client.query('ROLLBACK');
    } catch (_) {}
    // Нарушение уникальности (если индекс на уровне БД поймал гонку)
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'User already booked this event' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  } finally {
    if (client) client.release();
  }
});

// --- Старт сервера ---
const port = process.env.PORT || 3000;
const host = '0.0.0.0';
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
