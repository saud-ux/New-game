'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const path = require('path');
app.use(express.static('public'));

// SPA routing — serve index.html for /host and /play/:code
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/play/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// sessions: Map<code, Session>
const sessions = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastPlayers(session, obj) {
  for (const p of Object.values(session.players)) send(p.ws, obj);
}

// ─── Claude calls ────────────────────────────────────────────────────────────

async function generateClues(personName) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `أنت تدير لعبة "من أنا؟". الشخص السري هو: "${personName}"

اكتب بالعربية بالضبط ١٠ تلميحات مرتبة من الأكثر غموضاً (التلميح ١) إلى الأكثر وضوحاً (التلميح ١٠).

القواعد:
- لا تذكر اسم الشخص أو لقبه أو أي اسم مستعار في أي تلميح إطلاقاً
- كل تلميح يجب أن يكون صحيحاً بالكامل
- التلميح ١: معلومة عامة جداً (حقبة زمنية، منطقة جغرافية، مجال عام)
- التلميح ٥-٦: يضيق دائرة التخمين بشكل ملحوظ
- التلميح ١٠: واضح جداً لمن يعرف هذا الشخص
- كل تلميح جملة أو جملتان كحد أقصى
- التلميحات يجب أن تكون مثيرة للاهتمام وعادلة

أجب فقط بمصفوفة JSON صحيحة تحتوي على ١٠ نصوص بالعربية — بدون ماركداون أو شرح:
["التلميح1","التلميح2","التلميح3","التلميح4","التلميح5","التلميح6","التلميح7","التلميح8","التلميح9","التلميح10"]`
    }]
  });

  const raw = msg.content[0].text.trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('AI returned invalid clue format');
  const clues = JSON.parse(match[0]);
  if (!Array.isArray(clues) || clues.length !== 10) throw new Error('Expected 10 clues');
  return clues;
}

async function judgeAnswer(secret, answer) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 60,
    messages: [{
      role: 'user',
      content: `في لعبة "من أنا؟" الإجابة الصحيحة هي "${secret}".
اللاعب أجاب: "${answer}"

اقبل الإجابة إذا كانت: الاسم الكامل، أو اسم مختصر شائع، أو اسم العائلة فقط إذا كان واضحاً، أو خطأ إملائي بسيط، أو أي شكل لا لبس فيه.

أجب فقط بـ JSON صحيح بدون أي نص إضافي: {"correct":true} أو {"correct":false}`
    }]
  });

  try {
    const raw = msg.content[0].text.trim();
    const match = raw.match(/\{[^}]+\}/);
    return Boolean(JSON.parse(match ? match[0] : raw).correct);
  } catch {
    return false;
  }
}

// ─── State helpers ───────────────────────────────────────────────────────────

function hostStatePayload(session) {
  const players = {};
  for (const [name, p] of Object.entries(session.players)) {
    players[name] = {
      name: p.name,
      cluesSeen: p.cluesSeen,
      correctGuess: p.correctGuess,
      guessTime: p.guessTime,
      photo: p.photo || null,
      connected: p.ws != null && p.ws.readyState === WebSocket.OPEN
    };
  }
  return {
    type: 'HOST_UPDATE',
    state: {
      sessionCode: session.code,
      roundNumber: session.roundNumber,
      players,
      round: session.round ? {
        status: session.round.status,
        secret: session.round.secret,
        globalClueIndex: session.round.globalClueIndex,
        totalClues: session.round.clues.length,
        clues: session.round.clues
      } : null,
      roundHistory: session.roundHistory
    }
  };
}

function pushHostUpdate(session) {
  send(session.hostWs, hostStatePayload(session));
}

function endRound(session) {
  const round = session.round;
  if (!round || round.status === 'complete') return;
  round.status = 'complete';

  const results = Object.values(session.players).map(p => ({
    name: p.name,
    cluesSeen: p.cluesSeen,
    guessTime: p.guessTime,
    correct: p.correctGuess,
    roundScore: p.correctGuess ? Math.max(1, 11 - p.cluesSeen) : 0
  }));

  results.sort((a, b) => {
    if (a.correct !== b.correct) return a.correct ? -1 : 1;
    if (a.correct && b.correct) {
      if (a.cluesSeen !== b.cluesSeen) return a.cluesSeen - b.cluesSeen;
      return (a.guessTime || 0) - (b.guessTime || 0);
    }
    return 0;
  });

  for (const r of results) {
    const p = session.players[r.name];
    if (!p) continue;
    p.score += r.roundScore;
    p.roundResults.push({ roundNumber: session.roundNumber, ...r });
  }

  const leaderboard = Object.values(session.players)
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  session.roundHistory.push({
    roundNumber: session.roundNumber,
    secret: round.secret,
    results,
    leaderboard
  });

  const payload = {
    type: 'ROUND_COMPLETE',
    roundNumber: session.roundNumber,
    secret: round.secret,
    results,
    leaderboard
  };

  send(session.hostWs, payload);
  broadcastPlayers(session, payload);
}

// ─── WebSocket dispatch ──────────────────────────────────────────────────────

wss.on('connection', ws => {
  ws._id = makeId();
  ws._role = null;
  ws._code = null;
  ws._name = null;

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      send(ws, { type: 'ERROR', message: 'Invalid JSON' });
      return;
    }
    try {
      await dispatch(ws, msg);
    } catch (err) {
      console.error('Handler error:', err.message);
      send(ws, { type: 'ERROR', message: err.message || 'Server error' });
    }
  });

  ws.on('close', () => {
    if (ws._code && ws._role === 'player' && ws._name) {
      const session = sessions.get(ws._code);
      if (session && session.players[ws._name]) {
        const player = session.players[ws._name];
        player.ws = null;
        // Lock out from answering if they disconnect mid-round
        if (session.round?.status === 'active' && !player.correctGuess) {
          player.leftDuringRound = true;
        }
        pushHostUpdate(session);
      }
    }
    if (ws._role === 'host' && ws._code) {
      // Host disconnected — session still lives for reconnect
      const session = sessions.get(ws._code);
      if (session) session.hostWs = null;
    }
  });
});

async function dispatch(ws, msg) {
  switch (msg.type) {

    // ── CREATE_SESSION ──────────────────────────────────────────────────────
    case 'CREATE_SESSION': {
      let code;
      let attempts = 0;
      do { code = makeCode(); attempts++; } while (sessions.has(code) && attempts < 20);

      sessions.set(code, {
        code,
        hostWs: ws,
        players: {},
        round: null,
        roundNumber: 0,
        roundHistory: []
      });

      ws._role = 'host';
      ws._code = code;
      send(ws, { type: 'SESSION_CREATED', code });
      break;
    }

    // ── JOIN_SESSION ────────────────────────────────────────────────────────
    case 'JOIN_SESSION': {
      const { code, name } = msg;
      if (!code || !name) {
        send(ws, { type: 'ERROR', message: 'Code and name are required' });
        return;
      }

      const session = sessions.get(String(code).toUpperCase().trim());
      if (!session) {
        send(ws, { type: 'ERROR', message: 'Session not found — check the code' });
        return;
      }

      const trimName = String(name).trim().slice(0, 30);
      if (!trimName) {
        send(ws, { type: 'ERROR', message: 'Name cannot be empty' });
        return;
      }

      const isRejoin = Boolean(session.players[trimName]);
      if (!isRejoin && Object.keys(session.players).length >= 15) {
        send(ws, { type: 'ERROR', message: 'Session is full (max 15 players)' });
        return;
      }

      // Validate photo size (max ~150 KB base64)
      const rawPhoto = typeof msg.photo === 'string' && msg.photo.startsWith('data:image')
        ? (msg.photo.length < 200000 ? msg.photo : null)
        : null;

      if (isRejoin) {
        session.players[trimName].ws = ws;
        if (rawPhoto) session.players[trimName].photo = rawPhoto;
        const round = session.round;
        if (round && round.status === 'active') {
          const p = session.players[trimName];
          p.cluesSeen = Math.max(p.cluesSeen, round.globalClueIndex);
        }
      } else {
        session.players[trimName] = {
          ws,
          name: trimName,
          photo: rawPhoto,
          cluesSeen: 0,
          cluesSeenList: [],
          correctGuess: false,
          guessTime: null,
          leftDuringRound: false,
          score: 0,
          roundResults: []
        };
      }

      ws._role = 'player';
      ws._code = session.code;
      ws._name = trimName;

      const player = session.players[trimName];

      send(ws, {
        type: 'SESSION_JOINED',
        sessionCode: session.code,
        playerName: trimName,
        score: player.score,
        roundStatus: session.round?.status || 'waiting',
        roundNumber: session.roundNumber,
        correctGuess: player.correctGuess,
        cluesSeen: player.cluesSeen,
        leftDuringRound: player.leftDuringRound || false
      });

      // Replay clues for rejoining / active round
      if (session.round?.status === 'active' && player.cluesSeen > 0) {
        for (let i = 0; i < player.cluesSeen; i++) {
          send(ws, {
            type: i === 0 ? 'ROUND_STARTED' : 'CLUE_REVEALED',
            roundNumber: session.roundNumber,
            clue: session.round.clues[i],
            clueIndex: i,
            clueNumber: i + 1,
            totalRevealed: session.round.globalClueIndex,
            leftDuringRound: player.leftDuringRound || false
          });
        }
        if (player.correctGuess) {
          send(ws, {
            type: 'GUESS_RESULT',
            correct: true,
            cluesSeen: player.cluesSeen,
            guessTime: player.guessTime,
            roundScore: Math.max(1, 11 - player.cluesSeen)
          });
        }
      } else if (session.round?.status === 'complete') {
        // Send latest round results
        const last = session.roundHistory[session.roundHistory.length - 1];
        if (last) {
          const leaderboard = Object.values(session.players)
            .map(p => ({ name: p.name, score: p.score }))
            .sort((a, b) => b.score - a.score);
          send(ws, {
            type: 'ROUND_COMPLETE',
            roundNumber: last.roundNumber,
            secret: last.secret,
            results: last.results,
            leaderboard
          });
        }
      }

      pushHostUpdate(session);
      break;
    }

    // ── GENERATE_CLUES ──────────────────────────────────────────────────────
    case 'GENERATE_CLUES': {
      if (ws._role !== 'host') return;
      const session = sessions.get(ws._code);
      if (!session) return;

      const secret = String(msg.secret || '').trim();
      if (!secret) {
        send(ws, { type: 'ERROR', message: 'Enter a person\'s name first' });
        return;
      }

      send(ws, { type: 'GENERATING_CLUES' });
      broadcastPlayers(session, { type: 'ROUND_PREPARING' });

      const clues = await generateClues(secret);

      session.round = {
        secret,
        clues,
        globalClueIndex: 0,
        status: 'ready',
        startTime: null
      };

      for (const p of Object.values(session.players)) {
        p.cluesSeen = 0;
        p.cluesSeenList = [];
        p.correctGuess = false;
        p.guessTime = null;
        p.leftDuringRound = false;
      }

      send(ws, { type: 'CLUES_READY', totalClues: clues.length, clues });
      pushHostUpdate(session);
      break;
    }

    // ── START_ROUND ─────────────────────────────────────────────────────────
    case 'START_ROUND': {
      if (ws._role !== 'host') return;
      const session = sessions.get(ws._code);
      if (!session?.round || session.round.status !== 'ready') {
        send(ws, { type: 'ERROR', message: 'Generate clues first, then start the round' });
        return;
      }

      // Accept edited clues from host if provided
      if (Array.isArray(msg.clues) && msg.clues.length === 10) {
        session.round.clues = msg.clues.map(c => String(c).trim() || session.round.clues[0]);
      }

      session.roundNumber++;
      const round = session.round;
      round.status = 'active';
      round.startTime = Date.now();
      round.globalClueIndex = 1;

      for (const p of Object.values(session.players)) {
        p.cluesSeen = 1;
        p.cluesSeenList = [round.clues[0]];
        send(p.ws, {
          type: 'ROUND_STARTED',
          roundNumber: session.roundNumber,
          clue: round.clues[0],
          clueIndex: 0,
          clueNumber: 1,
          totalRevealed: 1
        });
      }

      pushHostUpdate(session);
      break;
    }

    // ── REVEAL_CLUE (host pushes to all) ────────────────────────────────────
    case 'REVEAL_CLUE': {
      if (ws._role !== 'host') return;
      const session = sessions.get(ws._code);
      const round = session?.round;
      if (!round || round.status !== 'active') return;

      const idx = round.globalClueIndex; // 0-based index of clue to push
      if (idx >= round.clues.length) {
        send(ws, { type: 'ERROR', message: 'No more clues to reveal' });
        return;
      }

      round.globalClueIndex++;
      const clue = round.clues[idx];

      for (const p of Object.values(session.players)) {
        if (p.correctGuess) continue;
        if (p.cluesSeen <= idx) {
          // Player is at or behind this clue — send it
          p.cluesSeen = idx + 1;
          if (!p.cluesSeenList[idx]) p.cluesSeenList[idx] = clue;
          send(p.ws, {
            type: 'CLUE_REVEALED',
            clue,
            clueIndex: idx,
            clueNumber: idx + 1,
            totalRevealed: round.globalClueIndex
          });
        }
        // Players ahead (already requested this clue) are unaffected
      }

      pushHostUpdate(session);
      break;
    }

    // ── REQUEST_CLUE (player asks for their next clue) ───────────────────────
    case 'REQUEST_CLUE': {
      if (ws._role !== 'player') return;
      const session = sessions.get(ws._code);
      const round = session?.round;
      if (!round || round.status !== 'active') return;

      const player = session.players[ws._name];
      if (!player || player.correctGuess || player.leftDuringRound) return;

      const nextIdx = player.cluesSeen; // 0-based
      if (nextIdx >= round.clues.length) {
        send(ws, { type: 'INFO', message: 'You have seen all available clues!' });
        return;
      }

      const clue = round.clues[nextIdx];
      player.cluesSeen++;
      player.cluesSeenList[nextIdx] = clue;

      // Advance global index if this player went further than any host reveal
      if (player.cluesSeen > round.globalClueIndex) {
        round.globalClueIndex = player.cluesSeen;
      }

      send(ws, {
        type: 'CLUE_REVEALED',
        clue,
        clueIndex: nextIdx,
        clueNumber: nextIdx + 1,
        totalRevealed: round.globalClueIndex
      });

      pushHostUpdate(session);
      break;
    }

    // ── SUBMIT_GUESS ────────────────────────────────────────────────────────
    case 'SUBMIT_GUESS': {
      if (ws._role !== 'player') return;
      const session = sessions.get(ws._code);
      const round = session?.round;
      if (!round || round.status !== 'active') return;

      const player = session.players[ws._name];
      if (!player || player.correctGuess) {
        send(ws, { type: 'ERROR', message: 'Already guessed correctly this round' });
        return;
      }
      if (player.leftDuringRound) {
        send(ws, { type: 'LEFT_ROUND_LOCKED' });
        return;
      }

      const guess = String(msg.guess || '').trim();
      if (!guess) return;

      const correct = await judgeAnswer(round.secret, guess);

      if (correct) {
        player.correctGuess = true;
        player.guessTime = Date.now() - round.startTime;

        send(ws, {
          type: 'GUESS_RESULT',
          correct: true,
          cluesSeen: player.cluesSeen,
          guessTime: player.guessTime,
          roundScore: Math.max(1, 11 - player.cluesSeen)
        });

        pushHostUpdate(session);

        const allDone = Object.values(session.players).every(p => p.correctGuess);
        if (allDone) endRound(session);
      } else {
        send(ws, { type: 'GUESS_RESULT', correct: false });
      }
      break;
    }

    // ── END_ROUND ───────────────────────────────────────────────────────────
    case 'END_ROUND': {
      if (ws._role !== 'host') return;
      const session = sessions.get(ws._code);
      if (!session?.round || session.round.status !== 'active') return;
      endRound(session);
      break;
    }

    // ── NEW_ROUND ───────────────────────────────────────────────────────────
    case 'NEW_ROUND': {
      if (ws._role !== 'host') return;
      const session = sessions.get(ws._code);
      if (!session) return;
      session.round = null;
      pushHostUpdate(session);
      broadcastPlayers(session, { type: 'WAITING_FOR_ROUND' });
      break;
    }

    // ── END_SESSION ─────────────────────────────────────────────────────────
    case 'END_SESSION': {
      if (ws._role !== 'host') return;
      const session = sessions.get(ws._code);
      if (!session) return;

      const finalLeaderboard = Object.values(session.players)
        .map(p => ({ name: p.name, score: p.score, roundResults: p.roundResults }))
        .sort((a, b) => b.score - a.score);

      const payload = { type: 'SESSION_ENDED', leaderboard: finalLeaderboard };
      send(ws, payload);
      broadcastPlayers(session, payload);
      sessions.delete(ws._code);
      break;
    }

    // ── RECONNECT_HOST ──────────────────────────────────────────────────────
    case 'RECONNECT_HOST': {
      const { code } = msg;
      const session = sessions.get(String(code || '').toUpperCase());
      if (!session) {
        send(ws, { type: 'ERROR', message: 'Session not found' });
        return;
      }
      session.hostWs = ws;
      ws._role = 'host';
      ws._code = session.code;
      send(ws, { type: 'SESSION_CREATED', code: session.code, rejoined: true });
      pushHostUpdate(session);
      break;
    }

    default:
      send(ws, { type: 'ERROR', message: `Unknown message type: ${msg.type}` });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Who Am I? running at http://localhost:${PORT}\n`);
});
