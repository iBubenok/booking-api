[![CI](https://github.com/iBubenok/booking-api/actions/workflows/ci.yml/badge.svg)](https://github.com/iBubenok/booking-api/actions/workflows/ci.yml)

# Booking API

Демо API бронирования мест:
- **один пользователь — одна бронь** на одно событие,
- **без овербукинга** (конкурентно-безопасно, блокировка `FOR UPDATE` + уникальный индекс).

## Живой сервис

**Base URL:** **https://booking-api-mwff.onrender.com**

Быстрые ссылки:
- Домашняя страница — `/`
- Документация (Swagger UI) — `/docs`
- Health-check (app) — `/health`
- Health-check (DB) — `/health/db`
- Основной эндпоинт — `POST /api/bookings/reserve`

---

## Проверка доступности

Откройте в браузере:
- `/health` → ожидается: `{"status":"ok","db":"configured"}`
- `/health/db` → ожидается: `{"status":"ok"}` (при живой БД) или `503 {"status":"db-down"}`
- `/docs` → откроется Swagger UI (можно тестировать API из браузера)

---

## Примеры запросов (curl)

### 1) Первая бронь (ожидаем **201 Created**)

```bash
curl -i -X POST https://booking-api-mwff.onrender.com/api/bookings/reserve \
  -H "Content-Type: application/json" \
  -d '{"event_id":1,"user_id":"user123"}'
````

Ожидается:

* статус `HTTP/1.1 201`
* JSON с полями `booking` и `seats_left`.

### 2) Повторная бронь тем же пользователем на то же событие (ожидаем **409 Conflict**)

```bash
curl -i -X POST https://booking-api-mwff.onrender.com/api/bookings/reserve \
  -H "Content-Type: application/json" \
  -d '{"event_id":1,"user_id":"user123"}'
```

Ожидается:

* статус `HTTP/1.1 409`
* JSON `{"error":"User already booked this event"}`.

### 3) Продажа всех мест и отказ «sold out» (у события `#1` всего **3** места)

```bash
# три уникальные брони (должны пройти: 201 201 201)
curl -i -X POST https://booking-api-mwff.onrender.com/api/bookings/reserve \
  -H "Content-Type: application/json" \
  -d '{"event_id":1,"user_id":"u2"}'

curl -i -X POST https://booking-api-mwff.onrender.com/api/bookings/reserve \
  -H "Content-Type: application/json" \
  -d '{"event_id":1,"user_id":"u3"}'

curl -i -X POST https://booking-api-mwff.onrender.com/api/bookings/reserve \
  -H "Content-Type: application/json" \
  -d '{"event_id":1,"user_id":"u4"}'

# четвёртая попытка (ожидаем 409 sold out)
curl -i -X POST https://booking-api-mwff.onrender.com/api/bookings/reserve \
  -H "Content-Type: application/json" \
  -d '{"event_id":1,"user_id":"u5"}'
```

Ожидается:

* первые три запроса вернут `201`,
* четвёртый — `409` и сообщение `Event is sold out`.

### 4) Тест конкуренции (быстрый)

Отправьте несколько запросов одновременно (через Swagger UI или скриптом) на одно и то же `event_id` с разными `user_id`.
Итог: число успешных бронирований **не превысит** `total_seats`, а лишние вернут `409`.

---

## Поведение API и коды ответов

* `POST /api/bookings/reserve`

  * **Вход**: JSON `{"event_id": number, "user_id": string}`

    * `event_id`: целое `> 0`
    * `user_id`: непустая строка, **≤ 128** символов, допускаются только `A–Z a–z 0–9 _ - . : @`
  * **Выход**:

    * `201 Created` — бронь создана, `{ booking, seats_left }`
    * `400 Bad Request` — неверный формат входа
    * `404 Not Found` — событие не найдено
    * `409 Conflict` — повторная бронь того же пользователя **или** мест больше нет
    * `503 Service Unavailable` — БД не настроена (`DATABASE_URL` не задан)
    * `500 Internal Error` — непредвиденная ошибка
* **Ограничение частоты**: на `POST /api/bookings/reserve` действует rate-limit **30 запросов/мин** на IP.

---

## Безопасность и сервисные возможности

* `helmet` (HTTP-заголовки безопасности, настроен `crossOriginResourcePolicy` для Swagger UI)
* `cors` (разрешены кросс-доменные запросы)
* `express.json({ limit: '32kb' })` (лимит тела запроса)
* `morgan('combined')` (логирование запросов)
* `app.set('trust proxy', 1)` (корректно определяем IP клиента за прокси/балансировщиком — важно для rate-limit)
* **Graceful shutdown** по `SIGINT`/`SIGTERM` (корректное закрытие соединений с БД)
* **Fallback 404** JSON-ответом

---

## Быстрый старт (локально)

**Требования:** Node.js 18+; доступная PostgreSQL (или облачная строка подключения).

1. Установите зависимости:

   ```bash
   npm ci
   ```
2. Создайте `.env` на основе `.env.example` и задайте переменные:

   ```dotenv
   PORT=3000
   DATABASE_URL=postgres://user:password@host:5432/dbname
   # Для облачных БД (Neon/Render) включите SSL:
   DATABASE_SSL=true
   ```
3. Запуск:

   ```bash
   npm start
   ```
4. Проверьте:

   * `GET http://localhost:3000/health`
   * `GET http://localhost:3000/docs`

### Миграции

Выполните файл `db/migrations.sql` в вашей БД (создаёт таблицы, индексы и сид-данные).
Пример через `psql`:

```bash
psql "postgresql://USER:[email protected]:PORT/DB?sslmode=require" -f db/migrations.sql
```

---

## Структура проекта

```
.
├─ db/
│  └─ migrations.sql        # таблицы, индексы, сиды
├─ __tests__/               # автотесты
├─ openapi.yaml             # спецификация OpenAPI для Swagger UI
├─ server.js                # запуск приложения, graceful shutdown
├─ package.json
├─ .env.example
└─ README.md
```

---

## CI/CD

* **CI**: GitHub Actions (`.github/workflows/ci.yml`) выполняет `npm ci` и `npm test` на каждый `push`/`PR`.
* **CD**: Render Blueprint (`render.yaml`) автодеплоит ветку `main`; `/health` используется как health-check.

---