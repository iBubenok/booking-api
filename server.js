// server.js
"use strict";

require('dotenv').config({ quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { Pool } = require('pg');

const app = express();

// Если приложение работает за прокси (например, Render),
// эта настройка позволит корректно определять IP клиента (для rate limit и логов).
app.set('trust proxy', 1);

// ---------- Security & DX middleware ----------
app.disable('x-powered-by');
app.use(
  helmet({
    // чтобы Swagger UI корректно грузил ассеты
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(morgan('combined'));

// ---------- Swagger UI (/docs) ----------
const openapiPath = path.resolve(__dirname, './openapi.yaml');
try {
  const openapiDoc = yaml.load(fs.readFileSync(openapiPath, 'utf8'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));
} catch {
  // Если файла нет — просто не поднимаем /docs, логируем предупреждение
  console.warn('openapi.yaml not found or invalid. /docs will be unavailable.');
}

// ---------- Database ----------
const hasDb = !!process.env.DATABASE_URL;
let pool = null;
if (hasDb) {
  const pgConfig = { connectionString: process.env.DATABASE_URL };
  // Включаем SSL при необходимости (например, Neon/облачные БД)
  if ((process.env.DATABASE_SSL || '').toLowerCase() === 'true') {
    pgConfig.ssl = { rejectUnauthorized: false };
  }
  pool = new Pool(pgConfig);
}

// ---------- Health checks ----------
app.get('/health', (req, res) => {
  // Лёгкий health без запроса к БД — достаточно 200 OK для Render
  res.json({ status: 'ok', db: hasDb ? 'configured' : 'not-configured' });
});

app.get('/health/db', async (req, res) => {
  if (!hasDb) return res.status(503).json({ status: 'no-db' });
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'db-down' });
  }
});

// ---------- Home ----------
app.get('/', (req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html lang="ru">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Booking API</title>
      <style>
        body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; line-height: 1.5; }
        code, pre { background: #f5f5f5; padding: 0.2rem 0.4rem; border-radius: 6px; }
        .links a { display: inline-block; margin-right: 1rem; }
        .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 1rem 1.25rem; max-width: 760px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Booking API</h1>
        <p>Демо-сервис для бронирования места на событие: один пользователь — одна бронь, без овербукинга.</p>
        <p class="links">
          <a href="/docs">➡ Swagger UI (/docs)</a>
          <a href="/health">❤️ Health (/health)</a>
          <a href="/health/db">🧡 Health DB (/health/db)</a>
        </p>
        <p>Основной эндпоинт: <code>POST /api/bookings/reserve</code></p>
      </div>
    </body>
    </html>
  `);
});

// ---------- Rate limiters ----------
const reserveLimiter = rateLimit({
  windowMs: 60_000, // 1 минута
  max: 30,          // не более 30 попыток бронирования с одного IP в минуту
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------- Booking ----------
app.post('/api/bookings/reserve', reserveLimiter, async (req, res) => {
  if (!hasDb) {
    return res.status(503).json({ error: 'Database is not configured yet. Set DATABASE_URL.' });
  }

  const { event_id, user_id } = req.body || {};

  // Валидация входа
  const eid = Number(event_id);
  const uid = String(user_id || '').trim();

  if (!Number.isInteger(eid) || eid <= 0 || uid.length === 0) {
    return res
      .status(400)
      .json({ error: 'Invalid payload: {event_id(int>0), user_id(non-empty string)} required' });
  }
  // Базовая нормализация user_id, чтобы исключить мусор/слишком длинные строки
  if (uid.length > 128 || !/^[\w\-.:@]+$/.test(uid)) {
    return res
      .status(400)
      .json({ error: 'Invalid user_id format (max 128, allowed: letters/digits/_ - . : @)' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1) Лочим событие — сериализуем конкурирующие операции по одному event_id
    const ev = await client.query(
      'SELECT id, name, total_seats FROM events WHERE id = $1 FOR UPDATE',
      [eid]
    );
    if (ev.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }
    const event = ev.rows[0];
    const totalSeats = Number(event.total_seats);

    // 2) Проверяем, не бронировал ли уже этот пользователь
    const dup = await client.query(
      'SELECT 1 FROM bookings WHERE event_id = $1 AND user_id = $2',
      [eid, uid]
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
    const taken = Number(takenRes.rows[0].cnt);
    if (taken >= totalSeats) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Event is sold out' });
    }

    // 4) Вставляем бронь
    const ins = await client.query(
      'INSERT INTO bookings (event_id, user_id, created_at) VALUES ($1, $2, NOW()) RETURNING id, event_id, user_id, created_at',
      [eid, uid]
    );

    await client.query('COMMIT');

    // (опционально можно добавить Location-заголовок на /api/bookings/:id)
    res.status(201).json({
      booking: ins.rows[0],
      seats_left: totalSeats - (taken + 1),
    });
  } catch (err) {
    // Безопасно пытаемся откатить
    try {
      if (client) await client.query('ROLLBACK');
    } catch {}
    // Нарушение уникальности (если в БД есть UNIQUE (event_id, user_id) и случилась гонка)
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'User already booked this event' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  } finally {
    if (client) client.release();
  }
});

// ---------- Fallback 404 ----------
app.use((req, res, next) => {
  if (req.path === '/') return next();
  res.status(404).json({ error: 'Not found' });
});

// ---------- Start & Graceful shutdown ----------
const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';

let server = null;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(port, host, () => {
    console.log(`Server listening on http://${host}:${port}`);
  });
}

async function shutdown(signal) {
  console.log(`\n${signal}: shutting down...`);
  try {
    await pool?.end();
  } catch {}
  if (server) {
    server.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));

// Логирование неожиданных ошибок — чтобы не падать молча
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Экспортируем для тестов (и при необходимости — для интеграции)
module.exports = { app, server };
