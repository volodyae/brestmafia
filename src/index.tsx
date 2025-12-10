import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for API
app.use('/api/*', cors())

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// ==================== API: Инициализация БД ====================

// Инициализация базы данных
app.post('/api/init-db', async (c) => {
  const { DB } = c.env;
  
  try {
    // Создание таблиц через batch
    const statements = [
      DB.prepare(`CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shiffer_id TEXT UNIQUE,
        nickname TEXT NOT NULL,
        photo_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      
      DB.prepare(`CREATE TABLE IF NOT EXISTS tournaments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shiffer_id TEXT UNIQUE,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      
      DB.prepare(`CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tournament_id INTEGER,
        shiffer_game_id TEXT UNIQUE,
        game_number INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
      )`),
      
      DB.prepare(`CREATE TABLE IF NOT EXISTS game_players (
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
      )`),
      
      DB.prepare(`CREATE TABLE IF NOT EXISTS game_events (
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
      )`),
      
      DB.prepare(`CREATE INDEX IF NOT EXISTS idx_players_shiffer_id ON players(shiffer_id)`),
      DB.prepare(`CREATE INDEX IF NOT EXISTS idx_games_tournament_id ON games(tournament_id)`),
      DB.prepare(`CREATE INDEX IF NOT EXISTS idx_game_players_game_id ON game_players(game_id)`),
      DB.prepare(`CREATE INDEX IF NOT EXISTS idx_game_players_player_id ON game_players(player_id)`),
      DB.prepare(`CREATE INDEX IF NOT EXISTS idx_game_events_game_id ON game_events(game_id)`)
    ];
    
    // Добавляем тестовых игроков
    for (let i = 1; i <= 10; i++) {
      statements.push(
        DB.prepare(`INSERT OR IGNORE INTO players (id, nickname, photo_url) VALUES (?, ?, ?)`)
          .bind(i, `Игрок${i}`, `https://i.pravatar.cc/150?img=${i}`)
      );
    }
    
    await DB.batch(statements);
    
    return c.json({ success: true, message: 'Database initialized successfully' });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
})

// ==================== API: Игроки ====================

// Получить всех игроков
app.get('/api/players', async (c) => {
  const { DB } = c.env;
  const result = await DB.prepare('SELECT * FROM players ORDER BY nickname').all();
  return c.json(result.results);
})

// Получить игрока по ID
app.get('/api/players/:id', async (c) => {
  const { DB } = c.env;
  const id = c.req.param('id');
  const result = await DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
  return c.json(result);
})

// Добавить нового игрока
app.post('/api/players', async (c) => {
  const { DB } = c.env;
  const { nickname, photo_url, shiffer_id } = await c.req.json();
  
  const result = await DB.prepare(
    'INSERT INTO players (nickname, photo_url, shiffer_id) VALUES (?, ?, ?)'
  ).bind(nickname, photo_url, shiffer_id || null).run();
  
  return c.json({ id: result.meta.last_row_id, nickname, photo_url });
})

// Обновить игрока
app.put('/api/players/:id', async (c) => {
  const { DB } = c.env;
  const id = c.req.param('id');
  const { nickname, photo_url } = await c.req.json();
  
  await DB.prepare(
    'UPDATE players SET nickname = ?, photo_url = ? WHERE id = ?'
  ).bind(nickname, photo_url, id).run();
  
  return c.json({ success: true });
})

// ==================== API: Игры ====================

// Получить текущую игру
app.get('/api/games/current', async (c) => {
  const { DB } = c.env;
  
  // Получаем последнюю активную игру
  const game = await DB.prepare(`
    SELECT * FROM games 
    WHERE status = 'active' 
    ORDER BY created_at DESC 
    LIMIT 1
  `).first();
  
  if (!game) {
    return c.json({ error: 'No active game' }, 404);
  }
  
  // Получаем игроков игры
  const players = await DB.prepare(`
    SELECT gp.*, p.nickname, p.photo_url
    FROM game_players gp
    JOIN players p ON gp.player_id = p.id
    WHERE gp.game_id = ?
    ORDER BY gp.position
  `).bind(game.id).all();
  
  // Получаем события игры
  const events = await DB.prepare(`
    SELECT ge.*, p.nickname as player_nickname, cp.nickname as checked_player_nickname
    FROM game_events ge
    LEFT JOIN players p ON ge.player_id = p.id
    LEFT JOIN players cp ON ge.checked_player_id = cp.id
    WHERE ge.game_id = ?
    ORDER BY ge.event_order
  `).bind(game.id).all();
  
  return c.json({
    game,
    players: players.results,
    events: events.results
  });
})

// Создать новую игру
app.post('/api/games', async (c) => {
  const { DB } = c.env;
  const { game_number, player_ids } = await c.req.json();
  
  if (!player_ids || player_ids.length !== 10) {
    return c.json({ error: 'Exactly 10 players required' }, 400);
  }
  
  // Деактивируем предыдущие игры
  await DB.prepare("UPDATE games SET status = 'finished' WHERE status = 'active'").run();
  
  // Создаем новую игру
  const gameResult = await DB.prepare(
    "INSERT INTO games (game_number, status) VALUES (?, 'active')"
  ).bind(game_number).run();
  
  const gameId = gameResult.meta.last_row_id;
  
  // Добавляем игроков
  for (let i = 0; i < player_ids.length; i++) {
    await DB.prepare(
      'INSERT INTO game_players (game_id, player_id, position, status) VALUES (?, ?, ?, ?)'
    ).bind(gameId, player_ids[i], i + 1, 'in_game').run();
  }
  
  return c.json({ id: gameId, game_number });
})

// Обновить роль игрока
app.post('/api/games/:gameId/players/:playerId/role', async (c) => {
  const { DB } = c.env;
  const gameId = c.req.param('gameId');
  const playerId = c.req.param('playerId');
  const { role } = await c.req.json();
  
  await DB.prepare(
    'UPDATE game_players SET role = ? WHERE game_id = ? AND player_id = ?'
  ).bind(role, gameId, playerId).run();
  
  return c.json({ success: true });
})

// Обновить статус игрока (убит/заголосован)
app.post('/api/games/:gameId/players/:playerId/status', async (c) => {
  const { DB } = c.env;
  const gameId = c.req.param('gameId');
  const playerId = c.req.param('playerId');
  const { status, exit_type } = await c.req.json();
  
  // Получаем максимальный порядок выхода
  const maxOrder = await DB.prepare(
    'SELECT MAX(exit_order) as max_order FROM game_players WHERE game_id = ?'
  ).bind(gameId).first();
  
  const exitOrder = (maxOrder?.max_order || 0) + 1;
  
  await DB.prepare(
    'UPDATE game_players SET status = ?, exit_type = ?, exit_order = ? WHERE game_id = ? AND player_id = ?'
  ).bind(status, exit_type, exitOrder, gameId, playerId).run();
  
  return c.json({ success: true, exit_order: exitOrder });
})

// Добавить событие (отстрел/голосование/проверка)
app.post('/api/games/:gameId/events', async (c) => {
  const { DB } = c.env;
  const gameId = c.req.param('gameId');
  const { event_type, player_id, checked_player_id, result } = await c.req.json();
  
  // Получаем максимальный порядок события
  const maxOrder = await DB.prepare(
    'SELECT MAX(event_order) as max_order FROM game_events WHERE game_id = ?'
  ).bind(gameId).first();
  
  const eventOrder = (maxOrder?.max_order || 0) + 1;
  
  await DB.prepare(
    'INSERT INTO game_events (game_id, event_type, player_id, checked_player_id, result, event_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(gameId, event_type, player_id || null, checked_player_id || null, result || null, eventOrder).run();
  
  return c.json({ success: true, event_order: eventOrder });
})

// Удалить последнее событие
app.delete('/api/games/:gameId/events/last', async (c) => {
  const { DB } = c.env;
  const gameId = c.req.param('gameId');
  
  await DB.prepare(`
    DELETE FROM game_events 
    WHERE game_id = ? 
    AND event_order = (SELECT MAX(event_order) FROM game_events WHERE game_id = ?)
  `).bind(gameId, gameId).run();
  
  return c.json({ success: true });
})

// ==================== Страницы ====================

// Основная страница (для OBS)
app.get('/overlay', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Mafia Stream Overlay</title>
        <link href="/static/style.css" rel="stylesheet">
        <style>
          body {
            margin: 0;
            padding: 0;
            background: transparent;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            overflow: hidden;
          }
          
          /* Карточки игроков внизу */
          .players-container {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 10px;
            width: 95%;
            justify-content: center;
          }
          
          .player-card {
            background: linear-gradient(135deg, rgba(30,30,40,0.95), rgba(20,20,30,0.95));
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 10px;
            width: 120px;
            text-align: center;
            transition: all 0.5s ease;
            position: relative;
          }
          
          .player-card.eliminated {
            opacity: 0.4;
            transform: translateY(20px);
            filter: grayscale(100%);
          }
          
          .player-card img {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            border: 3px solid rgba(255,255,255,0.2);
            margin-bottom: 8px;
            transition: all 0.3s ease;
          }
          
          .player-card.eliminated img {
            border-color: rgba(255,0,0,0.5);
          }
          
          .player-nickname {
            color: #fff;
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 5px;
          }
          
          .player-role {
            color: #ffd700;
            font-size: 12px;
            padding: 3px 8px;
            background: rgba(255,215,0,0.2);
            border-radius: 5px;
            display: inline-block;
            margin-bottom: 5px;
          }
          
          .player-status {
            color: #ff4444;
            font-size: 11px;
            font-style: italic;
          }
          
          .player-position {
            position: absolute;
            top: 5px;
            left: 5px;
            background: rgba(255,255,255,0.2);
            color: #fff;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: bold;
          }
          
          /* История событий (верхний левый угол) */
          .events-container {
            position: fixed;
            top: 20px;
            left: 20px;
            background: linear-gradient(135deg, rgba(30,30,40,0.95), rgba(20,20,30,0.95));
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 15px;
            min-width: 300px;
            max-height: 400px;
            overflow-y: auto;
          }
          
          .events-title {
            color: #ffd700;
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 10px;
            border-bottom: 2px solid rgba(255,215,0,0.3);
            padding-bottom: 5px;
          }
          
          .event-item {
            color: #fff;
            font-size: 13px;
            padding: 5px;
            margin: 5px 0;
            border-left: 3px solid;
            padding-left: 10px;
            animation: slideIn 0.5s ease;
          }
          
          .event-item.kill {
            border-color: #ff4444;
            background: rgba(255,68,68,0.1);
          }
          
          .event-item.vote {
            border-color: #4444ff;
            background: rgba(68,68,255,0.1);
          }
          
          .event-item.check {
            border-color: #44ff44;
            background: rgba(68,255,68,0.1);
          }
          
          /* Номер игры (верхний правый угол) */
          .game-number {
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, rgba(30,30,40,0.95), rgba(20,20,30,0.95));
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 15px 30px;
            color: #ffd700;
            font-size: 24px;
            font-weight: bold;
          }
          
          @keyframes slideIn {
            from {
              opacity: 0;
              transform: translateX(-20px);
            }
            to {
              opacity: 1;
              transform: translateX(0);
            }
          }
        </style>
    </head>
    <body>
        <div class="game-number" id="gameNumber">Игра #1</div>
        
        <div class="events-container" id="eventsContainer">
            <div class="events-title">История игры</div>
            <div id="eventsList"></div>
        </div>
        
        <div class="players-container" id="playersContainer"></div>
        
        <script>
          let currentGameData = null;
          
          // Загрузка данных игры
          async function loadGameData() {
            try {
              const response = await fetch('/api/games/current');
              if (!response.ok) return;
              
              const data = await response.json();
              currentGameData = data;
              updateUI();
            } catch (error) {
              console.error('Error loading game:', error);
            }
          }
          
          // Обновление UI
          function updateUI() {
            if (!currentGameData) return;
            
            // Обновляем номер игры
            document.getElementById('gameNumber').textContent = 
              \`Игра #\${currentGameData.game.game_number}\`;
            
            // Обновляем карточки игроков
            const playersHTML = currentGameData.players.map(player => \`
              <div class="player-card \${player.status !== 'in_game' ? 'eliminated' : ''}" data-player-id="\${player.player_id}">
                <div class="player-position">\${player.position}</div>
                <img src="\${player.photo_url || 'https://i.pravatar.cc/150'}" alt="\${player.nickname}">
                <div class="player-nickname">\${player.nickname}</div>
                \${player.role ? \`<div class="player-role">\${player.role}</div>\` : ''}
                \${player.status !== 'in_game' ? \`<div class="player-status">\${getStatusText(player.exit_type)}</div>\` : ''}
              </div>
            \`).join('');
            
            document.getElementById('playersContainer').innerHTML = playersHTML;
            
            // Обновляем события
            const eventsHTML = currentGameData.events.map((event, index) => {
              let eventText = '';
              let eventClass = '';
              
              if (event.event_type === 'kill') {
                eventText = \`🔫 Убит: \${event.player_nickname}\`;
                eventClass = 'kill';
              } else if (event.event_type === 'vote') {
                eventText = \`🗳️ Заголосован: \${event.player_nickname}\`;
                eventClass = 'vote';
              } else if (event.event_type === 'check_don') {
                eventText = \`🔍 Проверка Дона: \${event.checked_player_nickname} - \${event.result}\`;
                eventClass = 'check';
              } else if (event.event_type === 'check_sheriff') {
                eventText = \`👮 Проверка Шерифа: \${event.checked_player_nickname} - \${event.result}\`;
                eventClass = 'check';
              }
              
              return \`<div class="event-item \${eventClass}">\${index + 1}. \${eventText}</div>\`;
            }).join('');
            
            document.getElementById('eventsList').innerHTML = eventsHTML;
          }
          
          function getStatusText(exitType) {
            if (exitType === 'killed') return 'Убит';
            if (exitType === 'voted') return 'Заголосован';
            if (exitType === 'removed') return 'Удален';
            return 'Вне игры';
          }
          
          // Обновление каждые 2 секунды
          loadGameData();
          setInterval(loadGameData, 2000);
        </script>
    </body>
    </html>
  `)
})

// Админка
app.get('/admin', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Mafia Stream Admin</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-900 text-white p-8">
        <div class="max-w-7xl mx-auto">
            <h1 class="text-4xl font-bold mb-8 text-yellow-400">🎭 Панель управления трансляцией</h1>
            
            <!-- Секция создания игры -->
            <div class="bg-gray-800 rounded-lg p-6 mb-8">
                <h2 class="text-2xl font-bold mb-4">Создать новую игру</h2>
                <div class="mb-4">
                    <label class="block mb-2">Номер игры:</label>
                    <input type="number" id="gameNumber" class="bg-gray-700 px-4 py-2 rounded w-32" value="1">
                </div>
                <div class="mb-4">
                    <label class="block mb-2">Выберите 10 игроков:</label>
                    <div id="playerSelection" class="grid grid-cols-5 gap-4"></div>
                </div>
                <button onclick="createGame()" class="bg-green-600 hover:bg-green-700 px-6 py-3 rounded font-bold">
                    Создать игру
                </button>
            </div>
            
            <!-- Секция управления текущей игрой -->
            <div id="gameControl" class="bg-gray-800 rounded-lg p-6 hidden">
                <h2 class="text-2xl font-bold mb-4">Управление игрой #<span id="currentGameNumber"></span></h2>
                
                <div class="grid grid-cols-2 gap-6">
                    <!-- Игроки -->
                    <div>
                        <h3 class="text-xl font-bold mb-4 text-yellow-400">Игроки за столом</h3>
                        <div id="gamePlayers" class="space-y-4"></div>
                    </div>
                    
                    <!-- Действия -->
                    <div>
                        <h3 class="text-xl font-bold mb-4 text-yellow-400">Действия</h3>
                        
                        <div class="mb-6">
                            <h4 class="font-bold mb-2">Отстрелить игрока:</h4>
                            <select id="killPlayer" class="bg-gray-700 px-4 py-2 rounded w-full mb-2"></select>
                            <button onclick="killPlayer()" class="bg-red-600 hover:bg-red-700 px-4 py-2 rounded w-full">
                                🔫 Отстрелить
                            </button>
                        </div>
                        
                        <div class="mb-6">
                            <h4 class="font-bold mb-2">Заголосовать игрока:</h4>
                            <select id="votePlayer" class="bg-gray-700 px-4 py-2 rounded w-full mb-2"></select>
                            <button onclick="votePlayer()" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded w-full">
                                🗳️ Заголосовать
                            </button>
                        </div>
                        
                        <div class="mb-6">
                            <h4 class="font-bold mb-2">Проверка Дона:</h4>
                            <select id="checkDonPlayer" class="bg-gray-700 px-4 py-2 rounded w-full mb-2"></select>
                            <select id="checkDonResult" class="bg-gray-700 px-4 py-2 rounded w-full mb-2">
                                <option value="Мирный">Мирный</option>
                                <option value="Шериф">Шериф</option>
                            </select>
                            <button onclick="checkDon()" class="bg-purple-600 hover:bg-purple-700 px-4 py-2 rounded w-full">
                                🔍 Проверить (Дон)
                            </button>
                        </div>
                        
                        <div class="mb-6">
                            <h4 class="font-bold mb-2">Проверка Шерифа:</h4>
                            <select id="checkSheriffPlayer" class="bg-gray-700 px-4 py-2 rounded w-full mb-2"></select>
                            <select id="checkSheriffResult" class="bg-gray-700 px-4 py-2 rounded w-full mb-2">
                                <option value="Мирный">Мирный</option>
                                <option value="Мафия">Мафия</option>
                            </select>
                            <button onclick="checkSheriff()" class="bg-green-600 hover:bg-green-700 px-4 py-2 rounded w-full">
                                👮 Проверить (Шериф)
                            </button>
                        </div>
                        
                        <button onclick="undoLastEvent()" class="bg-yellow-600 hover:bg-yellow-700 px-4 py-2 rounded w-full">
                            ↩️ Отменить последнее действие
                        </button>
                    </div>
                </div>
            </div>
            
            <!-- Добавление игроков -->
            <div class="bg-gray-800 rounded-lg p-6 mt-8">
                <h2 class="text-2xl font-bold mb-4">Добавить нового игрока</h2>
                <div class="grid grid-cols-3 gap-4">
                    <input type="text" id="newPlayerNickname" placeholder="Ник игрока" class="bg-gray-700 px-4 py-2 rounded">
                    <input type="text" id="newPlayerPhoto" placeholder="URL фото" class="bg-gray-700 px-4 py-2 rounded">
                    <button onclick="addPlayer()" class="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded font-bold">
                        Добавить игрока
                    </button>
                </div>
            </div>
        </div>
        
        <script>
          let allPlayers = [];
          let selectedPlayers = [];
          let currentGame = null;
          
          // Загрузка всех игроков
          async function loadPlayers() {
            const response = await fetch('/api/players');
            allPlayers = await response.json();
            renderPlayerSelection();
          }
          
          // Отображение выбора игроков
          function renderPlayerSelection() {
            const html = allPlayers.map(player => \`
              <div class="text-center cursor-pointer" onclick="togglePlayer(\${player.id})">
                <div id="player-select-\${player.id}" class="border-2 border-gray-600 rounded-lg p-2 hover:border-yellow-400 transition">
                  <img src="\${player.photo_url || 'https://i.pravatar.cc/150'}" class="w-20 h-20 rounded-full mx-auto mb-2">
                  <div class="text-sm">\${player.nickname}</div>
                </div>
              </div>
            \`).join('');
            document.getElementById('playerSelection').innerHTML = html;
          }
          
          // Переключение выбора игрока
          function togglePlayer(playerId) {
            const index = selectedPlayers.indexOf(playerId);
            const element = document.getElementById(\`player-select-\${playerId}\`);
            
            if (index > -1) {
              selectedPlayers.splice(index, 1);
              element.classList.remove('border-yellow-400', 'bg-yellow-900');
              element.classList.add('border-gray-600');
            } else {
              if (selectedPlayers.length < 10) {
                selectedPlayers.push(playerId);
                element.classList.add('border-yellow-400', 'bg-yellow-900');
                element.classList.remove('border-gray-600');
              } else {
                alert('Можно выбрать только 10 игроков!');
              }
            }
          }
          
          // Создание игры
          async function createGame() {
            if (selectedPlayers.length !== 10) {
              alert('Выберите ровно 10 игроков!');
              return;
            }
            
            const gameNumber = document.getElementById('gameNumber').value;
            
            const response = await fetch('/api/games', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                game_number: gameNumber,
                player_ids: selectedPlayers
              })
            });
            
            if (response.ok) {
              alert('Игра создана!');
              selectedPlayers = [];
              renderPlayerSelection();
              loadCurrentGame();
            }
          }
          
          // Загрузка текущей игры
          async function loadCurrentGame() {
            const response = await fetch('/api/games/current');
            if (!response.ok) return;
            
            currentGame = await response.json();
            document.getElementById('gameControl').classList.remove('hidden');
            document.getElementById('currentGameNumber').textContent = currentGame.game.game_number;
            
            renderGamePlayers();
            updatePlayerSelects();
          }
          
          // Отображение игроков игры
          function renderGamePlayers() {
            const html = currentGame.players.map(player => \`
              <div class="bg-gray-700 rounded p-4 flex items-center gap-4 \${player.status !== 'in_game' ? 'opacity-50' : ''}">
                <img src="\${player.photo_url || 'https://i.pravatar.cc/150'}" class="w-16 h-16 rounded-full">
                <div class="flex-1">
                  <div class="font-bold">\${player.position}. \${player.nickname}</div>
                  <select onchange="setRole(\${player.player_id}, this.value)" class="bg-gray-600 px-2 py-1 rounded text-sm mt-1">
                    <option value="">Без роли</option>
                    <option value="Мафия" \${player.role === 'Мафия' ? 'selected' : ''}>Мафия</option>
                    <option value="Дон" \${player.role === 'Дон' ? 'selected' : ''}>Дон</option>
                    <option value="Шериф" \${player.role === 'Шериф' ? 'selected' : ''}>Шериф</option>
                    <option value="Мирный" \${player.role === 'Мирный' ? 'selected' : ''}>Мирный</option>
                  </select>
                  \${player.status !== 'in_game' ? \`<div class="text-red-400 text-sm mt-1">\${player.exit_type === 'killed' ? 'Убит' : 'Заголосован'}</div>\` : ''}
                </div>
              </div>
            \`).join('');
            document.getElementById('gamePlayers').innerHTML = html;
          }
          
          // Обновление селектов игроков
          function updatePlayerSelects() {
            const activePlayers = currentGame.players.filter(p => p.status === 'in_game');
            const options = activePlayers.map(p => 
              \`<option value="\${p.player_id}">\${p.nickname}</option>\`
            ).join('');
            
            document.getElementById('killPlayer').innerHTML = '<option value="">Выберите игрока</option>' + options;
            document.getElementById('votePlayer').innerHTML = '<option value="">Выберите игрока</option>' + options;
            document.getElementById('checkDonPlayer').innerHTML = '<option value="">Выберите игрока</option>' + options;
            document.getElementById('checkSheriffPlayer').innerHTML = '<option value="">Выберите игрока</option>' + options;
          }
          
          // Установка роли
          async function setRole(playerId, role) {
            await fetch(\`/api/games/\${currentGame.game.id}/players/\${playerId}/role\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role })
            });
            loadCurrentGame();
          }
          
          // Отстрелить игрока
          async function killPlayer() {
            const playerId = document.getElementById('killPlayer').value;
            if (!playerId) return alert('Выберите игрока');
            
            await fetch(\`/api/games/\${currentGame.game.id}/players/\${playerId}/status\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'eliminated', exit_type: 'killed' })
            });
            
            await fetch(\`/api/games/\${currentGame.game.id}/events\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event_type: 'kill', player_id: playerId })
            });
            
            loadCurrentGame();
          }
          
          // Заголосовать игрока
          async function votePlayer() {
            const playerId = document.getElementById('votePlayer').value;
            if (!playerId) return alert('Выберите игрока');
            
            await fetch(\`/api/games/\${currentGame.game.id}/players/\${playerId}/status\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'eliminated', exit_type: 'voted' })
            });
            
            await fetch(\`/api/games/\${currentGame.game.id}/events\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event_type: 'vote', player_id: playerId })
            });
            
            loadCurrentGame();
          }
          
          // Проверка Дона
          async function checkDon() {
            const playerId = document.getElementById('checkDonPlayer').value;
            const result = document.getElementById('checkDonResult').value;
            if (!playerId) return alert('Выберите игрока');
            
            await fetch(\`/api/games/\${currentGame.game.id}/events\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event_type: 'check_don', checked_player_id: playerId, result })
            });
            
            loadCurrentGame();
          }
          
          // Проверка Шерифа
          async function checkSheriff() {
            const playerId = document.getElementById('checkSheriffPlayer').value;
            const result = document.getElementById('checkSheriffResult').value;
            if (!playerId) return alert('Выберите игрока');
            
            await fetch(\`/api/games/\${currentGame.game.id}/events\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event_type: 'check_sheriff', checked_player_id: playerId, result })
            });
            
            loadCurrentGame();
          }
          
          // Отменить последнее действие
          async function undoLastEvent() {
            if (!confirm('Отменить последнее действие?')) return;
            
            await fetch(\`/api/games/\${currentGame.game.id}/events/last\`, {
              method: 'DELETE'
            });
            
            loadCurrentGame();
          }
          
          // Добавить игрока
          async function addPlayer() {
            const nickname = document.getElementById('newPlayerNickname').value;
            const photo_url = document.getElementById('newPlayerPhoto').value;
            
            if (!nickname) return alert('Введите ник игрока');
            
            await fetch('/api/players', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ nickname, photo_url: photo_url || null })
            });
            
            document.getElementById('newPlayerNickname').value = '';
            document.getElementById('newPlayerPhoto').value = '';
            loadPlayers();
          }
          
          // Инициализация
          loadPlayers();
          loadCurrentGame();
          
          // Автообновление каждые 5 секунд
          setInterval(loadCurrentGame, 5000);
        </script>
    </body>
    </html>
  `)
})

// Страница турнирной таблицы
app.get('/tournament', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Турнирная таблица</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          body {
            margin: 0;
            padding: 0;
            background: linear-gradient(135deg, #1a1a2e 0%, #0f0f1e 100%);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          }
          
          .tournament-table {
            background: linear-gradient(135deg, rgba(30,30,40,0.95), rgba(20,20,30,0.95));
            border: 3px solid rgba(255,215,0,0.3);
            border-radius: 20px;
            padding: 30px;
            animation: fadeIn 1s ease;
          }
          
          .table-row {
            display: grid;
            grid-template-columns: 80px 250px 1fr 150px;
            gap: 20px;
            padding: 15px;
            margin: 10px 0;
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            transition: all 0.3s ease;
            border-left: 4px solid transparent;
          }
          
          .table-row:hover {
            background: rgba(255,255,255,0.1);
            transform: translateX(5px);
          }
          
          .table-row.first {
            border-left-color: #ffd700;
            background: rgba(255,215,0,0.1);
          }
          
          .table-row.second {
            border-left-color: #c0c0c0;
            background: rgba(192,192,192,0.1);
          }
          
          .table-row.third {
            border-left-color: #cd7f32;
            background: rgba(205,127,50,0.1);
          }
          
          .position {
            font-size: 32px;
            font-weight: bold;
            color: #ffd700;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          
          .player-info {
            display: flex;
            align-items: center;
            gap: 15px;
          }
          
          .player-info img {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            border: 2px solid rgba(255,215,0,0.5);
          }
          
          .player-name {
            font-size: 20px;
            font-weight: bold;
            color: #fff;
          }
          
          .games-played {
            color: #aaa;
            font-size: 14px;
          }
          
          .points {
            font-size: 36px;
            font-weight: bold;
            color: #ffd700;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-20px); }
            to { opacity: 1; transform: translateY(0); }
          }
        </style>
    </head>
    <body class="p-8">
        <div class="tournament-table max-w-6xl mx-auto">
            <h1 class="text-5xl font-bold text-center mb-8 text-yellow-400">
              🏆 Турнирная таблица
            </h1>
            
            <div id="tournamentData">
              <!-- Mock данные для демонстрации -->
              <div class="table-row first">
                <div class="position">1</div>
                <div class="player-info">
                  <img src="https://i.pravatar.cc/150?img=1" alt="Игрок1">
                  <div>
                    <div class="player-name">Игрок1</div>
                    <div class="games-played">Игр: 5</div>
                  </div>
                </div>
                <div></div>
                <div class="points">125</div>
              </div>
              
              <div class="table-row second">
                <div class="position">2</div>
                <div class="player-info">
                  <img src="https://i.pravatar.cc/150?img=2" alt="Игрок2">
                  <div>
                    <div class="player-name">Игрок2</div>
                    <div class="games-played">Игр: 5</div>
                  </div>
                </div>
                <div></div>
                <div class="points">118</div>
              </div>
              
              <div class="table-row third">
                <div class="position">3</div>
                <div class="player-info">
                  <img src="https://i.pravatar.cc/150?img=3" alt="Игрок3">
                  <div>
                    <div class="player-name">Игрок3</div>
                    <div class="games-played">Игр: 5</div>
                  </div>
                </div>
                <div></div>
                <div class="points">112</div>
              </div>
              
              <div class="table-row">
                <div class="position">4</div>
                <div class="player-info">
                  <img src="https://i.pravatar.cc/150?img=4" alt="Игрок4">
                  <div>
                    <div class="player-name">Игрок4</div>
                    <div class="games-played">Игр: 4</div>
                  </div>
                </div>
                <div></div>
                <div class="points">95</div>
              </div>
              
              <div class="table-row">
                <div class="position">5</div>
                <div class="player-info">
                  <img src="https://i.pravatar.cc/150?img=5" alt="Игрок5">
                  <div>
                    <div class="player-name">Игрок5</div>
                    <div class="games-played">Игр: 5</div>
                  </div>
                </div>
                <div></div>
                <div class="points">89</div>
              </div>
            </div>
        </div>
    </body>
    </html>
  `)
})

// Страница профиля игрока
app.get('/player/:id', (c) => {
  const playerId = c.req.param('id');
  
  return c.html(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Профиль игрока</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          body {
            margin: 0;
            padding: 0;
            background: linear-gradient(135deg, #1a1a2e 0%, #0f0f1e 100%);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          }
          
          .profile-container {
            background: linear-gradient(135deg, rgba(30,30,40,0.95), rgba(20,20,30,0.95));
            border: 3px solid rgba(255,215,0,0.3);
            border-radius: 20px;
            padding: 50px;
            animation: fadeIn 1s ease;
          }
          
          .player-photo {
            width: 300px;
            height: 300px;
            border-radius: 50%;
            border: 5px solid #ffd700;
            box-shadow: 0 0 30px rgba(255,215,0,0.5);
            animation: pulse 2s infinite;
          }
          
          .stat-card {
            background: rgba(255,255,255,0.05);
            border: 2px solid rgba(255,215,0,0.2);
            border-radius: 15px;
            padding: 20px;
            text-align: center;
            transition: all 0.3s ease;
          }
          
          .stat-card:hover {
            transform: translateY(-5px);
            border-color: rgba(255,215,0,0.5);
            background: rgba(255,255,255,0.1);
          }
          
          .stat-value {
            font-size: 48px;
            font-weight: bold;
            color: #ffd700;
            margin-bottom: 10px;
          }
          
          .stat-label {
            font-size: 18px;
            color: #aaa;
          }
          
          @keyframes fadeIn {
            from { opacity: 0; transform: scale(0.9); }
            to { opacity: 1; transform: scale(1); }
          }
          
          @keyframes pulse {
            0%, 100% { box-shadow: 0 0 30px rgba(255,215,0,0.5); }
            50% { box-shadow: 0 0 50px rgba(255,215,0,0.8); }
          }
        </style>
    </head>
    <body class="p-8">
        <div class="profile-container max-w-6xl mx-auto">
            <div class="flex gap-10 mb-10">
              <div class="flex-shrink-0">
                <img id="playerPhoto" src="https://i.pravatar.cc/300?img=${playerId}" class="player-photo" alt="Player">
              </div>
              
              <div class="flex-1 flex flex-col justify-center">
                <h1 id="playerName" class="text-6xl font-bold mb-4 text-yellow-400">Игрок${playerId}</h1>
                <p class="text-2xl text-gray-400">Игровой ник</p>
              </div>
            </div>
            
            <div class="grid grid-cols-4 gap-6">
              <div class="stat-card">
                <div class="stat-value" id="gamesPlayed">25</div>
                <div class="stat-label">Игр сыграно</div>
              </div>
              
              <div class="stat-card">
                <div class="stat-value" id="totalPoints">587</div>
                <div class="stat-label">Всего очков</div>
              </div>
              
              <div class="stat-card">
                <div class="stat-value" id="winRate">68%</div>
                <div class="stat-label">Процент побед</div>
              </div>
              
              <div class="stat-card">
                <div class="stat-value" id="avgPoints">23.5</div>
                <div class="stat-label">Средний балл</div>
              </div>
            </div>
            
            <div class="mt-10 grid grid-cols-2 gap-6">
              <div class="stat-card text-left">
                <h3 class="text-2xl font-bold text-yellow-400 mb-4">Статистика по ролям</h3>
                <div class="space-y-2">
                  <div class="flex justify-between">
                    <span class="text-white">🔴 Мафия:</span>
                    <span class="text-yellow-400 font-bold">8 игр (62% побед)</span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-white">👮 Шериф:</span>
                    <span class="text-yellow-400 font-bold">5 игр (80% побед)</span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-white">👑 Дон:</span>
                    <span class="text-yellow-400 font-bold">3 игры (67% побед)</span>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-white">👤 Мирный:</span>
                    <span class="text-yellow-400 font-bold">9 игр (55% побед)</span>
                  </div>
                </div>
              </div>
              
              <div class="stat-card text-left">
                <h3 class="text-2xl font-bold text-yellow-400 mb-4">Достижения</h3>
                <div class="space-y-2">
                  <div class="text-white">🏆 Чемпион турнира x2</div>
                  <div class="text-white">🎯 Лучший шериф сезона</div>
                  <div class="text-white">🔥 Серия из 5 побед</div>
                  <div class="text-white">⭐ MVP игры x7</div>
                </div>
              </div>
            </div>
        </div>
        
        <script>
          // Загрузка данных игрока
          async function loadPlayerData() {
            try {
              const response = await fetch('/api/players/${playerId}');
              const player = await response.json();
              
              if (player) {
                document.getElementById('playerName').textContent = player.nickname;
                document.getElementById('playerPhoto').src = player.photo_url || 'https://i.pravatar.cc/300?img=${playerId}';
              }
            } catch (error) {
              console.error('Error loading player:', error);
            }
          }
          
          loadPlayerData();
        </script>
    </body>
    </html>
  `)
})

export default app
