const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ============ Game Constants ============
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const RANK_ORDER = {};
RANKS.forEach((r,i) => RANK_ORDER[r]=i);

function getNextRankIdx(idx) { return (idx+1) % RANKS.length; }

// ============ Card Helpers ============
function createDeck() {
  const deck=[];
  for (const s of SUITS) for (const r of RANKS) deck.push({suit:s, rank:r});
  return deck;
}
function shuffle(arr) {
  for (let i=arr.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr;
}
function sortHand(h) {
  h.sort((a,b)=>(RANK_ORDER[a.rank]-RANK_ORDER[b.rank])||(SUITS.indexOf(a.suit)-SUITS.indexOf(b.suit)));
}

// ============ Room & Game State ============
const rooms = {}; // code -> room object

function generateCode() {
  const digits='0123456789';
  let code;
  do { code=''; for(let i=0;i<4;i++) code+=digits[Math.floor(Math.random()*10)]; }
  while (rooms[code]);
  return code;
}

function createRoom(playerCount) {
  const code = generateCode();
  const room = {
    code,
    playerCount,
    players: [],        // { id, name, ws, hand, connected }
    gameState: null,
    hostId: null
  };
  rooms[code] = room;
  return room;
}

// ============ Game Logic ============
function initGameForRoom(room) {
  const deck = shuffle(createDeck());
  const n = room.playerCount;
  const totalCards = 52;
  const perPlayer = Math.floor(totalCards/n);
  const extra = totalCards % n;
  let offset = 0;

  room.players.forEach((p, i) => {
    const sz = i < extra ? perPlayer+1 : perPlayer;
    p.hand = deck.slice(offset, offset+sz);
    sortHand(p.hand);
    offset += sz;
  });

  // Find who has 3♠
  let startIdx=0, hasThree=false;
  for (let i=0;i<n;i++) {
    if (room.players[i].hand.some(c=>c.suit==='♠'&&c.rank==='3')) { startIdx=i; hasThree=true; break; }
  }

  room.gameState = {
    currentPlayer: startIdx,
    currentRankIdx: 0,
    discardPile: [],
    lastPlayedCards: [],
    lastDeclaredRank: null,
    lastDeclaredCount: 0,
    lastPlayerIdx: -1,
    canChallenge: false,
    gameOver: false,
    winner: -1,
    mustPlayThreeOfSpades: hasThree && startIdx === 0,
    logs: []
  };
}

function addRoomLog(room, msg, type) {
  room.gameState.logs.unshift({msg,type,time:Date.now()});
}

function executePlayRoom(room, playerIdx, cards, declaredRank) {
  const gs = room.gameState;
  const p = room.players[playerIdx];

  // Remove cards
  for (const c of cards) {
    const idx = p.hand.findIndex(h=>h.suit===c.suit&&h.rank===c.rank);
    if (idx>=0) p.hand.splice(idx,1);
  }

  const allMatch = cards.every(c=>c.rank===declaredRank);

  gs.lastPlayedCards = cards;
  gs.lastDeclaredRank = declaredRank;
  gs.lastDeclaredCount = cards.length;
  gs.lastPlayerIdx = playerIdx;
  gs.discardPile.push(...cards);

  if (p.hand.length === 0) {
    gs.gameOver = true;
    gs.winner = playerIdx;
    addRoomLog(room, `🏆 ${p.name} 出完了所有牌！`, 'result');
    return;
  }

  gs.currentPlayer = (playerIdx+1) % room.playerCount;
  gs.canChallenge = true;
  gs.mustPlayThreeOfSpades = false;

  const bluffText = allMatch ? '' : ' 🤫(虚张声势!)';
  addRoomLog(room, `${p.name} 出了 ${cards.length} 张【${declaredRank}】${bluffText}`, 'play');
}

function executeChallengeRoom(room, challengerIdx) {
  const gs = room.gameState;
  const challenger = room.players[challengerIdx];
  const challenged = room.players[gs.lastPlayerIdx];
  const declaredRank = gs.lastDeclaredRank;
  const playedCards = gs.lastPlayedCards;

  const allMatch = playedCards.every(c=>c.rank===declaredRank);
  const loserIdx = allMatch ? challengerIdx : gs.lastPlayerIdx;
  const loser = room.players[loserIdx];

  // Loser takes all discard
  const allDiscard = [...gs.discardPile];
  loser.hand.push(...allDiscard);
  sortHand(loser.hand);
  gs.discardPile = [];
  gs.lastPlayedCards = [];
  gs.lastDeclaredRank = null;
  gs.lastDeclaredCount = 0;

  const playedDesc = playedCards.map(c=>`${c.suit}${c.rank}`).join(' ');
  if (allMatch) {
    addRoomLog(room, `🔍 质疑失败! 真的是${declaredRank}(${playedDesc}) → ${challenger.name}收走弃牌`, 'challenge');
  } else {
    addRoomLog(room, `🔥 吹牛成功! 声称${declaredRank}实际(${playedDesc}) → ${challenged.name}收走弃牌`, 'challenge');
  }

  gs.currentPlayer = loserIdx;
  gs.currentRankIdx = getNextRankIdx(RANK_ORDER[declaredRank]);
  gs.canChallenge = false;
  gs.lastPlayerIdx = -1;
}

// ============ Broadcast ============
function broadcastState(room) {
  const state = buildClientState(room);
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ type:'state', ...state }));
    }
  });
}

function buildClientState(room) {
  const gs = room.gameState;
  if (!gs) return { gameStarted:false, playerCount:room.playerCount };
  return {
    gameStarted: true,
    playerCount: room.playerCount,
    currentPlayer: gs.currentPlayer,
    canChallenge: gs.canChallenge,
    lastDeclaredRank: gs.lastDeclaredRank,
    lastDeclaredCount: gs.lastDeclaredCount,
    lastPlayerIdx: gs.lastPlayerIdx,
    currentRankIdx: gs.currentRankIdx,
    mustPlayThreeOfSpades: gs.mustPlayThreeOfSpades || false,
    gameOver: gs.gameOver,
    winner: gs.winner,
    discardCount: gs.discardPile.length,
    logs: gs.logs.slice(0, 40)
  };
}

function broadcastPlayers(room) {
  const players = room.players.map((p,i)=>({
    id: p.id, name: p.name, idx: i,
    cardCount: p.hand ? p.hand.length : 0
  }));
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ type:'players', players,
        myCards: p.hand ? p.hand.map(c=>({suit:c.suit,rank:c.rank,isRed:c.suit==='♥'||c.suit==='♦'})) : []
      }));
    }
  });
}

function broadcastAll(room) {
  broadcastState(room);
  broadcastPlayers(room);
}

function broadcastRoomInfo(room) {
  const info = {
    type: 'roomInfo',
    code: room.code,
    playerCount: room.playerCount,
    players: room.players.map(p=>({id:p.id,name:p.name,connected:p.ws&&p.ws.readyState===1})),
    allConnected: room.players.length === room.playerCount && room.players.every(p=>p.ws&&p.ws.readyState===1)
  };
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(info));
    }
  });
}

// ============ HTTP Server ============
const server = http.createServer((req, res) => {
  console.log(req.socket.remoteAddress, req.method, req.url);
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentTypes = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png' };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
    } else {
      res.writeHead(200, {
        'Content-Type': contentTypes[ext] || 'text/plain',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      });
      res.end(data);
    }
  });
});

// ============ WebSocket Server ============
const wss = new WebSocketServer({ server });

let playerIdCounter = 0;

wss.on('connection', (ws, req) => {
  const playerId = 'p' + (++playerIdCounter);
  let currentRoom = null;
  let currentPlayerIdx = -1;
  console.log('🔗 新连接:', playerId, req.socket.remoteAddress);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    console.log('📩', playerId, msg.type, msg.code||'');

    switch (msg.type) {

      // --- Room Management ---
      case 'createRoom': {
        const room = createRoom(msg.playerCount);
        currentRoom = room;
        room.hostId = playerId;
        // Host is first player
        room.players.push({ id: playerId, name: msg.name || '房主', ws, hand: null });
        currentPlayerIdx = 0;
        ws.send(JSON.stringify({ type:'roomCreated', code: room.code, playerIdx: 0 }));
        broadcastRoomInfo(room);
        break;
      }

      case 'joinRoom': {
        const room = rooms[msg.code];
        if (!room) {
          ws.send(JSON.stringify({ type:'error', msg:'房间不存在' }));
          return;
        }
        if (room.gameState) {
          ws.send(JSON.stringify({ type:'error', msg:'游戏已开始' }));
          return;
        }
        if (room.players.length >= room.playerCount) {
          ws.send(JSON.stringify({ type:'error', msg:'房间已满' }));
          return;
        }
        currentRoom = room;
        currentPlayerIdx = room.players.length;
        room.players.push({ id: playerId, name: msg.name || ('玩家'+(currentPlayerIdx+1)), ws, hand: null });
        ws.send(JSON.stringify({ type:'roomJoined', code: room.code, playerIdx: currentPlayerIdx }));
        broadcastRoomInfo(room);

        // Auto-start when full
        if (room.players.length === room.playerCount) {
          startRoomGame(room);
        }
        break;
      }

      // --- Game Actions ---
      case 'playCards': {
        if (!currentRoom || !currentRoom.gameState) return;
        const gs = currentRoom.gameState;
        if (gs.gameOver || gs.currentPlayer !== currentPlayerIdx) return;
        if (!msg.cards || msg.cards.length === 0 || msg.cards.length > 4) return;

        const declaredRank = gs.canChallenge ? gs.lastDeclaredRank : msg.declaredRank;
        if (!declaredRank) return;
        if (gs.canChallenge && declaredRank !== gs.lastDeclaredRank) return;

        executePlayRoom(currentRoom, currentPlayerIdx, msg.cards, declaredRank);
        broadcastAll(currentRoom);
        break;
      }

      case 'challenge': {
        if (!currentRoom || !currentRoom.gameState) return;
        const gs = currentRoom.gameState;
        if (gs.gameOver || gs.currentPlayer !== currentPlayerIdx || !gs.canChallenge) return;

        executeChallengeRoom(currentRoom, currentPlayerIdx);
        broadcastAll(currentRoom);
        break;
      }

      case 'restart': {
        if (!currentRoom) return;
        startRoomGame(currentRoom);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      // Mark player as disconnected
      const player = currentRoom.players.find(p => p.id === playerId);
      if (player) player.ws = null;
      broadcastRoomInfo(currentRoom);

      // Clean up empty rooms
      if (currentRoom.players.every(p => !p.ws || p.ws.readyState !== 1)) {
        delete rooms[currentRoom.code];
      }
    }
  });
});

function startRoomGame(room) {
  initGameForRoom(room);
  addRoomLog(room, '🎬 游戏开始！', 'play');
  broadcastAll(room);
  broadcastRoomInfo(room);
}

// ============ Start ============
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 唬牌服务器已启动: http://localhost:${PORT}`);
});
