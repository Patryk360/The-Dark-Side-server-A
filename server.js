const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

app.use(express.static(path.join(__dirname, 'public')));

const TILE_SIZE = 32;
const CHUNK_SIZE = 16;
const MAP_HEIGHT = 128;
const SEA_LEVEL = 60; 
const GRAVITY = 0.5;
const DAY_DURATION = 14400; 

const MOBS_CONFIG = { cow: { width: 40, height: 28, speed: 1.2, jumpForce: -8 } };

let players = {};
let mobs = {};
let mobIdCounter = 0;
let chunks = {}; 
let worldChanges = {}; 
let gameTime = 0;
let chunkQueue = new Set(); 

const LOG_FILE = path.join(__dirname, 'server_logs.txt');

function log(category, message) {
    const now = new Date();
    const time = now.toLocaleTimeString();
    const date = now.toLocaleDateString();
    if (category !== 'CMD_INPUT') console.log(`[${time}] [${category}] ${message}`);
    const fileLine = `[${date} ${time}] [${category}] ${message}\n`;
    fs.appendFile(LOG_FILE, fileLine, (err) => { if (err) console.error("Błąd zapisu logów:", err); });
}

const db = new sqlite3.Database(path.join(__dirname, 'game.db'), (err) => {
    if (err) {
        log('BŁĄD', `Błąd połączenia z bazą SQLite: ${err.message}`);
    } else {
        log('SYSTEM', 'Połączono z bazą danych SQLite.');
        
        db.run(`CREATE TABLE IF NOT EXISTS players (
            nick TEXT PRIMARY KEY,
            x REAL,
            y REAL
        )`);
    }
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (input) => {
    const parts = input.trim().split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (!cmd) return;
    switch(cmd) {
        case 'say':
            const text = args.join(' ');
            if (text) {
                io.emit('chatMessage', { id: 'SERVER', nick: '[CONSOLE]', text: text });
                log('CMD', `Konsola: ${text}`);
            }
            break;
        case 'list':
            console.log("--- LISTA GRACZY ---");
            Object.keys(players).forEach(id => {
                console.log(`ID: ${id} | Nick: ${players[id].nick} | Poz: [${Math.floor(players[id].x/32)}, ${Math.floor(players[id].y/32)}]`);
            });
            break;
        case 'kick':
            if (players[args[0]]) {
                io.sockets.sockets.get(args[0])?.disconnect(true);
                log('CMD', `Wyrzucono gracza: ${args[0]}`);
            }
            break;
        case 'stop':
            io.emit('chatMessage', { id: 'SERVER', nick: '[SERWER]', text: 'Zamykanie serwera. Trwa zapisywanie...' });
            
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                for (let id in players) {
                    if (players[id].nick && players[id].nick !== "Gracz") {
                        db.run("INSERT OR REPLACE INTO players (nick, x, y) VALUES (?, ?, ?)", 
                        [players[id].nick, players[id].x, players[id].y]);
                    }
                }
                db.run("COMMIT", () => {
                    log('SYSTEM', 'Stan graczy zapisany. Wyłączanie.');
                    process.exit(0);
                });
            });
            break;
        default:
            console.log("Komendy: say <txt>, list, kick <id>, stop");
    }
});

function pseudoRandom(x, y) {
    let n = x * 331 + y * 439; n = Math.sin(n) * 12345.6789;
    return n - Math.floor(n);
}

function getTerrainHeight(worldX) {
    let h = 30 + Math.sin(worldX * 0.1) * 8 + Math.sin(worldX * 0.05) * 12 + 5;
    const oceanNoise = Math.sin(worldX * 0.02);
    if (oceanNoise > 0.4) h += (oceanNoise - 0.4) * 50; 
    return Math.floor(h);
}

function isCave(x, y) {
    const val = Math.sin(x / 15) * Math.cos(y / 15) + Math.sin((x + y) / 30) * 0.5;
    const depthFactor = Math.min(1, Math.max(0, (y - 30) / 70));
    const threshold = 0.65 - (depthFactor * 0.25);
    return val > threshold;
}

function createTree(chunkData, localX, groundY, worldX) {
    const hRand = pseudoRandom(worldX, groundY); 
    const treeHeight = Math.floor(hRand * 3) + 4; 
    
    for (let i = 1; i <= treeHeight; i++) {
        const trunkY = groundY - i;
        if (trunkY >= 0 && trunkY < MAP_HEIGHT) chunkData[trunkY][localX] = 3; 
    }
    
    const topY = groundY - treeHeight;
    for (let ly = topY - 2; ly <= topY + 1; ly++) {
        for (let lx = localX - 2; lx <= localX + 2; lx++) {
            const dx = Math.abs(lx - localX);
            const dy = ly - topY; 
            if (dx === 2 && dy === -2) continue; 
            if (dx === 2 && dy === 1) continue;  
            if (lx >= 0 && lx < CHUNK_SIZE && ly >= 0 && ly < MAP_HEIGHT) {
                if (chunkData[ly][lx] !== 3) chunkData[ly][lx] = 4; 
            }
        }
    }
}

function spawnVein(chunkData, centerX, centerY, oreID, worldX) {
    const positions = [{x:0,y:0}, {x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1}];
    for (let pos of positions) {
        if (pseudoRandom(worldX + pos.x, centerY + pos.y) > 0.3) {
            const tx = centerX + pos.x;
            const ty = centerY + pos.y;
            if (tx >= 0 && tx < CHUNK_SIZE && ty >= 0 && ty < MAP_HEIGHT) {
                if (chunkData[ty][tx] === 5) chunkData[ty][tx] = oreID;
            }
        }
    }
}

function generateChunk(chunkX) {
    const chunkData = [];
    for (let y = 0; y < MAP_HEIGHT; y++) chunkData[y] = new Array(CHUNK_SIZE).fill(0);

    for (let x = 0; x < CHUNK_SIZE; x++) {
        const worldX = chunkX * CHUNK_SIZE + x;
        const surfaceY = getTerrainHeight(worldX);

        for (let y = 0; y < MAP_HEIGHT; y++) {
            if (y >= MAP_HEIGHT - 3) { chunkData[y][x] = 99; continue; } 
            
            const cave = isCave(worldX, y);
            
            if (y < surfaceY) {
                if (y >= SEA_LEVEL) chunkData[y][x] = 12; 
                else chunkData[y][x] = 0; 
            } 
            else if (y === surfaceY) {
                 if (y >= SEA_LEVEL) chunkData[y][x] = 2; 
                 else {
                     if (cave) {
                         chunkData[y][x] = 0; 
                     } else {
                         chunkData[y][x] = 1; 
                         if (x >= 3 && x <= CHUNK_SIZE - 4 && pseudoRandom(worldX, surfaceY) < 0.08) {
                             createTree(chunkData, x, surfaceY, worldX);
                         }
                     }
                 }
            } 
            else {
                if (cave) {
                    if (y > 105) chunkData[y][x] = 12; 
                    else chunkData[y][x] = 0;
                }
                else {
                    chunkData[y][x] = (y < surfaceY + 8) ? 2 : 5; 
                }
            }
        }
    }

    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const worldX = chunkX * CHUNK_SIZE + x;
            if (chunkData[y][x] === 5) {
                const rand = pseudoRandom(worldX, y);
                if (rand < 0.05) { 
                    let oreID = 6; 
                    if (y > 60 && rand < 0.004) oreID = 9; 
                    else if (y > 50 && rand < 0.01) oreID = 8; 
                    else if (y > 40 && rand < 0.02) oreID = 7; 
                    spawnVein(chunkData, x, y, oreID, worldX);
                }
            }
        }
    }

    chunks[chunkX] = chunkData;
    io.emit('newChunk', { chunkX, data: chunkData });
}

function getTile(gridX, gridY) {
    if (gridY >= MAP_HEIGHT) return 99;
    if (gridY < 0) return 0;
    const key = `${gridX},${gridY}`;
    if (worldChanges[key] !== undefined) return worldChanges[key];
    const chunkX = Math.floor(gridX / CHUNK_SIZE);
    const localX = ((gridX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    
    if (!chunks[chunkX]) { chunkQueue.add(chunkX); return 99; }
    return chunks[chunkX][gridY][localX];
}

function isSolid(x, y) {
    const tile = getTile(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));
    return !(tile === 0 || tile === 3 || tile === 4 || tile === 12);
}

function applyPhysics(entity) {
    const gridX = Math.floor((entity.x + entity.width/2) / TILE_SIZE);
    const centerY = Math.floor((entity.y + entity.height/2) / TILE_SIZE);
    const feetY = Math.floor((entity.y + entity.height - 2) / TILE_SIZE);
    entity.inWater = (getTile(gridX, centerY) === 12) || (getTile(gridX, feetY) === 12);

    if (entity.inWater) { entity.velY += GRAVITY * 0.4; if (entity.velY > 4) entity.velY = 4; } 
    else { entity.velY += GRAVITY; if (entity.velY > 12) entity.velY = 12; }

    entity.y += entity.velY;
    entity.grounded = false;

    const pointsX = [entity.x + 2, entity.x + entity.width - 2];
    for (let px of pointsX) {
        if (entity.velY > 0 && isSolid(px, entity.y + entity.height)) {
            entity.y = Math.floor((entity.y + entity.height) / TILE_SIZE) * TILE_SIZE - entity.height;
            entity.velY = 0; entity.grounded = true; break;
        } else if (entity.velY < 0 && isSolid(px, entity.y)) {
            entity.y = (Math.floor(entity.y / TILE_SIZE) + 1) * TILE_SIZE;
            entity.velY = 0; break;
        }
    }

    entity.x += entity.velX;
    const pointsY = [entity.y + 2, entity.y + entity.height / 2, entity.y + entity.height - 2];
    for (let py of pointsY) {
        if (entity.velX > 0 && isSolid(entity.x + entity.width, py)) {
            entity.x = Math.floor((entity.x + entity.width) / TILE_SIZE) * TILE_SIZE - entity.width;
            entity.velX = 0; break;
        } else if (entity.velX < 0 && isSolid(entity.x, py)) {
            entity.x = (Math.floor(entity.x / TILE_SIZE) + 1) * TILE_SIZE;
            entity.velX = 0; break;
        }
    }
}

setInterval(() => {
    if (chunkQueue.size > 0) {
        const chunkToGen = chunkQueue.values().next().value; 
        if (!chunks[chunkToGen]) generateChunk(chunkToGen);
        chunkQueue.delete(chunkToGen);
    }

    gameTime++;
    if (gameTime >= DAY_DURATION) gameTime = 0;

    if (gameTime % 600 === 0) {
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            for (let id in players) {
                const p = players[id];
                if (p.nick && p.nick !== "Gracz") {
                    db.run("INSERT OR REPLACE INTO players (nick, x, y) VALUES (?, ?, ?)", [p.nick, p.x, p.y]);
                }
            }
            db.run("COMMIT");
        });
    }

    const playerIds = Object.keys(players);

    if (playerIds.length > 0 && Object.keys(mobs).length < 4) {
        if (Math.random() < 0.005) {
            const p = players[playerIds[Math.floor(Math.random() * playerIds.length)]];
            const id = mobIdCounter++;
            mobs[id] = { id: id, type: 'cow', x: p.x + (Math.random() - 0.5) * 600, y: p.y - 100, width: 40, height: 28, velX: 0, velY: 0, grounded: false, inWater: false, facingRight: true, timer: 0 };
        }
    }

    for (let id in mobs) {
        let m = mobs[id];
        const speed = m.inWater ? MOBS_CONFIG.cow.speed * 0.5 : MOBS_CONFIG.cow.speed;
        m.timer--;
        if (m.timer <= 0) {
            m.timer = Math.floor(Math.random() * 100) + 50;
            const r = Math.random();
            if (r < 0.3) m.velX = 0; else if (r < 0.6) { m.velX = speed; m.facingRight = true; } else { m.velX = -speed; m.facingRight = false; }
        }
        if (m.inWater) m.velY = -2; 
        else {
            const checkX = m.velX > 0 ? m.x + m.width + 2 : m.x - 2;
            if (m.velX !== 0 && m.grounded && isSolid(checkX, m.y + m.height - 5)) m.velY = MOBS_CONFIG.cow.jumpForce;
        }
        applyPhysics(m);
    }

    for (let id in players) {
        let p = players[id];
        const speed = p.inWater ? 2.5 : 5;
        p.velX = 0;
        if (p.inputs.left) p.velX = -speed;
        if (p.inputs.right) p.velX = speed;

        if (p.inputs.jump) {
            if (p.inWater) p.velY = -4; 
            else if (p.grounded) { p.velY = -11; p.grounded = false; }
        }
        applyPhysics(p);

        const pChunkX = Math.floor(p.x / (CHUNK_SIZE * TILE_SIZE));
        for (let i = -2; i <= 2; i++) if (!chunks[pChunkX + i]) chunkQueue.add(pChunkX + i);
    }

    io.emit('gameState', { players, mobs, time: gameTime });
}, 1000 / 60);

function handleCommand(socket, msg) {
    const parts = msg.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
        case 'nick':
            const newNick = args.join(' ').substring(0, 15);
            if (newNick && players[socket.id]) {
                const oldNick = players[socket.id].nick;

                if (oldNick !== "Gracz") {
                    db.run("INSERT OR REPLACE INTO players (nick, x, y) VALUES (?, ?, ?)", [oldNick, players[socket.id].x, players[socket.id].y]);
                }

                players[socket.id].nick = newNick;
                io.emit('playerNickUpdate', { id: socket.id, nick: newNick });
                socket.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `Zmieniłeś nick na: ${newNick}` });
            }
            break;
        case 'tp':
            if (args.length >= 2 && players[socket.id]) {
                players[socket.id].x = parseInt(args[0]) * TILE_SIZE;
                players[socket.id].y = parseInt(args[1]) * TILE_SIZE;
                socket.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `Teleportowano do ${args[0]}, ${args[1]}` });
            }
            break;
        default:
            socket.emit('chatMessage', { id: 'SYSTEM', nick: 'BŁĄD', text: 'Nieznana komenda.' });
    }
}

io.on('connection', (socket) => {
    players[socket.id] = { 
        x: 0, y: -200, width: 20, height: 40, velX: 0, velY: 0, grounded: false, inWater: false, 
        nick: "Gracz", color: '#' + Math.floor(Math.random()*16777215).toString(16),
        inputs: { left: false, right: false, jump: false }
    };

    socket.emit('initWorld', { chunks, worldChanges, dayDuration: DAY_DURATION });

    socket.on('setNick', (nick) => { 
        if (players[socket.id]) {
            const cleanNick = nick.substring(0, 15);
            players[socket.id].nick = cleanNick; 

            db.get("SELECT x, y FROM players WHERE nick = ?", [cleanNick], (err, row) => {
                if (err) {
                    console.error("Błąd zapytania DB:", err);
                    return;
                }
                if (row) {
                    players[socket.id].x = row.x;
                    players[socket.id].y = row.y;
                    socket.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `Witaj ponownie, ${cleanNick}! Wczytano Twoją pozycję.` });
                } else {
                    io.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `${cleanNick} dołączył do gry!` });
                }
            });
        }
    });

    socket.on('chatMessage', (msg) => {
        if (!msg) return;
        const cleanMsg = msg.trim().substring(0, 100);
        if (cleanMsg.startsWith('/')) {
            handleCommand(socket, cleanMsg);
        } else {
            const nick = players[socket.id] ? players[socket.id].nick : "Gracz";
            io.emit('chatMessage', { id: socket.id, nick: nick, text: cleanMsg });
        }
    });

    socket.on('input', (inputs) => {
        if (players[socket.id]) players[socket.id].inputs = inputs;
    });

    socket.on('shoot', (target) => {
        const shooter = players[socket.id];
        if (!shooter) return;
        
        socket.broadcast.emit('playerShoot', { 
            x1: shooter.x + shooter.width/2, 
            y1: shooter.y + shooter.height/2, 
            x2: target.x, y2: target.y 
        });

        for (let id in mobs) {
            let m = mobs[id];
            if (target.x >= m.x && target.x <= m.x + m.width &&
                target.y >= m.y && target.y <= m.y + m.height) {
                
                log('KILL', `${shooter.nick} zabił krowę ID ${id}`);
                delete mobs[id];
                break; 
            }
        }
    });

    socket.on('blockUpdate', (data) => {
        const { x, y, type } = data;
        const currentTile = getTile(x, y);
        if (currentTile === 99) return; 
        if (type !== 0) { 
            const isReplaceable = (currentTile === 0 || currentTile === 4 || currentTile === 12);
            if (!isReplaceable) return; 
            function isSupport(t) { return t !== 0 && t !== 12 && t !== 4 && t !== 99; }
            if (!isSupport(getTile(x, y - 1)) && !isSupport(getTile(x, y + 1)) && !isSupport(getTile(x - 1, y)) && !isSupport(getTile(x + 1, y))) return; 
        } else { if (currentTile === 0 || currentTile === 12) return; }
        
        worldChanges[`${x},${y}`] = type;
        io.emit('blockUpdate', { x, y, type }); 
    });

    socket.on('disconnect', () => { 
        if(players[socket.id]) {
            const p = players[socket.id];
            
            if (p.nick && p.nick !== "Gracz") {
                db.run("INSERT OR REPLACE INTO players (nick, x, y) VALUES (?, ?, ?)", [p.nick, p.x, p.y]);
            }

            io.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `${p.nick} wyszedł z gry.` });
            delete players[socket.id]; 
        }
    });
});

http.listen(3000, () => console.log('SERWER: Gotowy! (Baza danych SQLite aktywna)'));