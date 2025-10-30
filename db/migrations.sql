-- Таблицы
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  name VARCHAR NOT NULL,
  total_seats INT NOT NULL CHECK (total_seats >= 0)
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Один пользователь — одна бронь на событие
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_event_user
  ON bookings(event_id, user_id);

-- Быстрый подсчёт мест
CREATE INDEX IF NOT EXISTS idx_bookings_event_id
  ON bookings(event_id);

-- Сиды: два события для демонстрации
INSERT INTO events (id, name, total_seats)
VALUES (1, 'Demo Event (3 seats)', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO events (id, name, total_seats)
VALUES (2, 'SoldOut Demo (2 seats)', 2)
ON CONFLICT (id) DO NOTHING;
