-- Таблица игроков
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shiffer_id TEXT UNIQUE,
  nickname TEXT NOT NULL,
  photo_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Таблица турниров
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shiffer_id TEXT UNIQUE,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Таблица игр
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER,
  shiffer_game_id TEXT UNIQUE,
  game_number INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
);

-- Таблица участников игры
CREATE TABLE IF NOT EXISTS game_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 1 AND position <= 10),
  role TEXT,
  status TEXT DEFAULT 'in_game',
  exit_type TEXT,
  exit_order INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

-- Таблица событий игры (отстрелы, голосования, проверки)
CREATE TABLE IF NOT EXISTS game_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  player_id INTEGER,
  checked_player_id INTEGER,
  event_order INTEGER NOT NULL,
  result TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (checked_player_id) REFERENCES players(id)
);

-- Индексы для производительности
CREATE INDEX IF NOT EXISTS idx_players_shiffer_id ON players(shiffer_id);
CREATE INDEX IF NOT EXISTS idx_games_tournament_id ON games(tournament_id);
CREATE INDEX IF NOT EXISTS idx_game_players_game_id ON game_players(game_id);
CREATE INDEX IF NOT EXISTS idx_game_players_player_id ON game_players(player_id);
CREATE INDEX IF NOT EXISTS idx_game_events_game_id ON game_events(game_id);

-- Тестовые данные игроков
INSERT OR IGNORE INTO players (nickname, photo_url) VALUES 
  ('Игрок1', 'https://i.pravatar.cc/150?img=1'),
  ('Игрок2', 'https://i.pravatar.cc/150?img=2'),
  ('Игрок3', 'https://i.pravatar.cc/150?img=3'),
  ('Игрок4', 'https://i.pravatar.cc/150?img=4'),
  ('Игрок5', 'https://i.pravatar.cc/150?img=5'),
  ('Игрок6', 'https://i.pravatar.cc/150?img=6'),
  ('Игрок7', 'https://i.pravatar.cc/150?img=7'),
  ('Игрок8', 'https://i.pravatar.cc/150?img=8'),
  ('Игрок9', 'https://i.pravatar.cc/150?img=9'),
  ('Игрок10', 'https://i.pravatar.cc/150?img=10');
