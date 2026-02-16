const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});
const path = require('path');
const fs = require('fs');
const readline = require('readline');

app.use(express.static(path.join(__dirname, 'public')));

const LOG_FILE = path.join(__dirname, 'server_logs.txt');

function log(category, message) {
    const now = new Date();
    const time = now.toLocaleTimeString();
    const date = now.toLocaleDateString();

    if (category !== 'CMD_INPUT') {
        console.log(`[${time}] [${category}] ${message}`);
    }

    const fileLine = `[${date} ${time}] [${category}] ${message}\n`;
    fs.appendFile(LOG_FILE, fileLine, (err) => {
        if (err) console.error("Błąd zapisu logów:", err);
    });
}

let players = {};
let worldChanges = {}; 
let mobs = {};
let mobIdCounter = 0;
let gameTime = 0;
const DAY_DURATION = 3600; 

const SPAWN_RANGE = 800;
const DESPAWN_RANGE = 1200;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

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
            const ids = Object.keys(players);
            if (ids.length === 0) console.log("Brak graczy.");
            ids.forEach(id => {
                const p = players[id];
                console.log(`ID: ${id} | Nick: ${p.nick} | Pozycja: [${Math.floor(p.x/32)}, ${Math.floor(p.y/32)}]`);
            });
            console.log("--------------------");
            break;

case 'kick':
            const targetId = args[0];
            if (players[targetId]) {
                const targetNick = players[targetId].nick;

                const socket = io.sockets.sockets.get(targetId);
                if (socket) {
                    socket.disconnect(true);
                    console.log(`Wyrzucono gracza ${targetId}`);

                    io.emit('chatMessage', { id: 'SYSTEM', nick: 'ADMIN', text: `Gracz ${targetNick} został wyrzucony.` });
                }
            } else {
                console.log("Nie znaleziono gracza o takim ID (użyj 'list' aby sprawdzić ID).");
            }
            break;

        case 'tp':
            if (args.length < 3) {
                console.log("Użycie: tp <id_gracza> <x> <y>");
                break;
            }
            const pId = args[0];
            const tX = parseInt(args[1]);
            const tY = parseInt(args[2]);
            
            if (players[pId] && !isNaN(tX) && !isNaN(tY)) {
                players[pId].x = tX * 32;
                players[pId].y = tY * 32;

                const socket = io.sockets.sockets.get(pId);
                if (socket) {
                    socket.emit('teleport', { x: players[pId].x, y: players[pId].y });
                    socket.broadcast.emit('playerMoved', { id: pId, x: players[pId].x, y: players[pId].y });
                    console.log(`Teleportowano ${players[pId].nick} do ${tX}, ${tY}`);
                }
            } else {
                console.log("Błędne ID lub współrzędne.");
            }
            break;

        case 'stop':
            console.log("Zatrzymywanie serwera...");
            io.emit('chatMessage', { id: 'SERVER', nick: '[SERWER]', text: 'Serwer jest wyłączany...' });
            process.exit(0);
            break;

        case 'help':
            console.log("Komendy konsoli: say <txt>, list, kick <id>, tp <id> <x> <y>, stop");
            break;

        default:
            console.log("Nieznana komenda. Wpisz 'help'.");
    }
});

function getTerrainHeight(worldX) {
    const noise = Math.sin(worldX * 0.1) * 8 + Math.sin(worldX * 0.05) * 12;
    return Math.floor(30 + noise + 5);
}

function spawnCowNearPlayer() {
    const playerIds = Object.keys(players);
    if (playerIds.length === 0) return;

    const randomPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    const p = players[randomPlayerId];

    const offset = (Math.random() - 0.5) * 2 * SPAWN_RANGE;
    const spawnX = p.x + offset;
    const gridX = Math.floor(spawnX / 32);
    const groundY = getTerrainHeight(gridX) * 32;

    const id = mobIdCounter++;
    mobs[id] = {
        id: id, type: 'cow', x: spawnX, y: groundY - 28,
        width: 40, height: 28, velX: 0, velY: 0, timer: 0, facingRight: true
    };
}

setInterval(() => {
    gameTime = (gameTime + 1) % DAY_DURATION;

    const playerIds = Object.keys(players);
    const mobCount = Object.keys(mobs).length;

    if (playerIds.length > 0 && mobCount < 10) {
        if (Math.random() < 0.02) spawnCowNearPlayer(); 
    }

    for (let id in mobs) {
        let m = mobs[id];
        let minDist = Infinity;
        playerIds.forEach(pid => {
            const d = Math.sqrt((m.x - players[pid].x)**2 + (m.y - players[pid].y)**2);
            if (d < minDist) minDist = d;
        });
        if (playerIds.length > 0 && minDist > DESPAWN_RANGE) { delete mobs[id]; continue; }

        m.timer--;
        if (m.timer <= 0) {
            m.timer = Math.floor(Math.random() * 100) + 50; 
            const action = Math.random();
            if (action < 0.4) m.velX = 0;           
            else if (action < 0.7) { m.velX = 1.5; m.facingRight = true; }  
            else { m.velX = -1.5; m.facingRight = false; } 
        }

        m.x += m.velX;
        m.velY += 0.5; 
        m.y += m.velY;

        const gridX = Math.floor((m.x + m.width/2) / 32);
        const groundY = getTerrainHeight(gridX) * 32;

        if (m.y + m.height > groundY) {
            m.y = groundY - m.height;
            m.velY = 0;
            if (m.velX !== 0) m.y -= 5; 
        }
    }
    
    io.emit('gameUpdate', { mobs: mobs, time: gameTime });
}, 1000 / 60);

function handleCommand(socket, commandString) {
    const parts = commandString.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
        case 'help':
            socket.emit('chatMessage', { 
                id: 'SYSTEM', nick: 'POMOC', 
                text: 'Komendy: /nick [nazwa], /tp [x] [y], /say [tekst]' 
            });
            break;

        case 'nick':
            if (args.length > 0) {
                const newNick = args.join(' ').substring(0, 15);
                if (players[socket.id]) {
                    players[socket.id].nick = newNick;
                    io.emit('playerNickUpdate', { id: socket.id, nick: newNick });
                    socket.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `Zmieniono nick na: ${newNick}` });
                    log('CMD', `Gracz ${socket.id} zmienił nick na ${newNick}`);
                }
            }
            break;

        case 'say':
            if (args.length > 0) {
                const serverText = args.join(' ');
                io.emit('chatMessage', { id: 'SERVER', nick: '[SERWER]', text: serverText });
                log('CMD', `Admin ${socket.id} użył /say: ${serverText}`);
            }
            break;

        case 'tp':
            if (args.length >= 2) {
                const x = parseInt(args[0]);
                const y = parseInt(args[1]);
                if (!isNaN(x) && !isNaN(y)) {
                    if (players[socket.id]) {
                        players[socket.id].x = x * 32; 
                        players[socket.id].y = y * 32;
                        
                        socket.emit('teleport', { x: players[socket.id].x, y: players[socket.id].y });
                        socket.broadcast.emit('playerMoved', { id: socket.id, x: players[socket.id].x, y: players[socket.id].y });
                        
                        socket.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `Teleportowano do ${x}, ${y}` });
                        log('CMD', `Gracz ${socket.id} teleportował się do ${x},${y}`);
                    }
                } else {
                    socket.emit('chatMessage', { id: 'SYSTEM', nick: 'BŁĄD', text: 'Użycie: /tp [x] [y]' });
                }
            }
            break;

        default:
            socket.emit('chatMessage', { id: 'SYSTEM', nick: 'BŁĄD', text: 'Nieznana komenda. Wpisz /help.' });
    }
}

io.on('connection', (socket) => {
    log('CONNECT', `Gracz połączony: ${socket.id}`);

    players[socket.id] = {
        x: 0, y: -500, width: 20, height: 40,
        color: '#' + Math.floor(Math.random()*16777215).toString(16),
        nick: "Gracz" 
    };

    socket.emit('initGame', { 
        players, 
        history: worldChanges, 
        time: gameTime,
        dayDuration: DAY_DURATION 
    });
    
    socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });

    socket.on('setNick', (nick) => {
        if (players[socket.id]) {
            const cleanNick = nick.substring(0, 15); 
            players[socket.id].nick = cleanNick;
            io.emit('playerNickUpdate', { id: socket.id, nick: cleanNick });
            log('NICK', `Gracz ${socket.id} ustawił nick: ${cleanNick}`);
            io.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `${cleanNick} dołączył do gry.` });
        }
    });

    socket.on('playerMovement', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y });
        }
    });

    socket.on('chatMessage', (msg) => {
        if (!msg) return;
        const cleanMsg = msg.trim().substring(0, 100);

        if (cleanMsg.startsWith('/')) {
            handleCommand(socket, cleanMsg);
            return;
        }

        const nick = players[socket.id] ? players[socket.id].nick : "Gracz";
        log('CHAT', `<${nick}>: ${cleanMsg}`);
        io.emit('chatMessage', { id: socket.id, nick: nick, text: cleanMsg });
    });

    socket.on('blockUpdate', (data) => {
        const nick = players[socket.id] ? players[socket.id].nick : "Gracz";
        const action = data.type === 0 ? "ZNISZCZYŁ" : `POSTAWIŁ (${data.type})`;
        log('BUILD', `${nick} ${action} w [${data.x}, ${data.y}]`);
        worldChanges[`${data.x},${data.y}`] = data.type;
        socket.broadcast.emit('blockUpdate', data);
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
                io.emit('gameUpdate', { mobs: mobs, time: gameTime });
                break; 
            }
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            const nick = players[socket.id].nick;
            log('DISCONNECT', `Gracz rozłączony: ${socket.id} (${nick})`);
            io.emit('chatMessage', { id: 'SYSTEM', nick: 'INFO', text: `${nick} opuścił grę.` });
            delete players[socket.id];
            io.emit('playerDisconnected', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    log('SYSTEM', `Serwer startuje na porcie ${PORT}`);
    console.log("Wpisz 'help' w konsoli aby zobaczyć komendy.");
});