# Booking API

Демо API для бронирования мест:
- запрет повторной брони одним пользователем на одно событие,
- защита от овербукинга.

## Быстрый старт (локально)
1) `npm ci`
2) Создайте `.env` из `.env.example` и укажите `DATABASE_URL`
3) `npm start`
4) Откройте `/docs` для Swagger UI и `/health` для healthcheck

## Эндпоинты
- `POST /api/bookings/reserve`
- `GET /health`
- `GET /docs`

## Миграции
`db/migrations.sql` (таблицы, индексы, сиды)
