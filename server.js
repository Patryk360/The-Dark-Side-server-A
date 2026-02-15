const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let players = {};
let worldChanges = {}; 

// --- MOBY ---
let mobs = {};
let mobIdCounter = 0;
const SPAWN_RANGE = 800;
const DESPAWN_RANGE = 1200;

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
    const groundLevel = getTerrainHeight(gridX);
    const groundY = groundLevel * 32;

    const id = mobIdCounter++;
    mobs[id] = {
        id: id,
        type: 'cow',
        x: spawnX, 
        y: groundY - 28,
        width: 40,
        height: 28,
        velX: 0,
        velY: 0,
        timer: 0,       
        facingRight: true
    };
    
    // LOG: Nowa krowa
    console.log(`[WORLD] Zrespawnowano krowę ID: ${id} w pobliżu gracza ${randomPlayerId} (X: ${Math.floor(spawnX)})`);
}

// Pętla AI
setInterval(() => {
    const mobCount = Object.keys(mobs).length;
    const playerIds = Object.keys(players);

    if (playerIds.length > 0 && mobCount < 8) {
        if (Math.random() < 0.02) spawnCowNearPlayer(); 
    }

    for (let id in mobs) {
        let m = mobs[id];

        let minDist = Infinity;
        playerIds.forEach(pid => {
            const p = players[pid];
            const d = Math.sqrt((m.x - p.x)**2 + (m.y - p.y)**2);
            if (d < minDist) minDist = d;
        });

        if (playerIds.length > 0 && minDist > DESPAWN_RANGE) {
            delete mobs[id];
            console.log(`[WORLD] Despawn krowy ID: ${id} (za daleko od graczy)`);
            continue; 
        }

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
        const groundLevel = getTerrainHeight(gridX);
        const groundY = groundLevel * 32;

        if (m.y + m.height > groundY) {
            m.y = groundY - m.height;
            m.velY = 0;
            if (m.velX !== 0) m.y -= 5;
        }
    }
    io.emit('mobsUpdate', mobs);
}, 1000 / 60);

// --- SOCKET IO ---
io.on('connection', (socket) => {
    // LOG: Podłączenie
    console.log(`[NETWORK] Nowy gracz połączony: ${socket.id}`);

    players[socket.id] = {
        x: 0, y: -500, width: 20, height: 40,
        color: '#' + Math.floor(Math.random()*16777215).toString(16)
    };

    socket.emit('currentPlayers', players);
    socket.emit('worldHistory', worldChanges);
    socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });

    socket.on('playerMovement', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y });
        }
    });

    socket.on('chatMessage', (msg) => {
        if (!msg || msg.trim() === "") return;
        console.log(`[CHAT] ${socket.id}: ${msg}`); // LOG: Czat
        io.emit('chatMessage', { id: socket.id, text: msg.substring(0, 100) });
    });

    socket.on('blockUpdate', (data) => {
        worldChanges[`${data.x},${data.y}`] = data.type;
        socket.broadcast.emit('blockUpdate', data);
    });

    socket.on('shoot', (target) => {
        const shooter = players[socket.id];
        if (!shooter) return;
        
        // LOG: Strzał
        console.log(`[COMBAT] Gracz ${socket.id} strzelił w punkt (${Math.floor(target.x)}, ${Math.floor(target.y)})`);

        socket.broadcast.emit('playerShoot', { 
            x1: shooter.x + shooter.width/2, 
            y1: shooter.y + shooter.height/2, 
            x2: target.x, 
            y2: target.y 
        });

        for (let id in mobs) {
            let m = mobs[id];
            if (target.x >= m.x && target.x <= m.x + m.width &&
                target.y >= m.y && target.y <= m.y + m.height) {
                
                console.log(`[COMBAT] Krowa ID: ${id} została upieczona przez ${socket.id}!`); // LOG: Trafienie
                delete mobs[id];
                io.emit('mobsUpdate', mobs);
                break; 
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`[NETWORK] Gracz rozłączony: ${socket.id}`); // LOG: Rozłączenie
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log('--- SERWER URUCHOMIONY ---');
    console.log(`Adres: http://localhost:${PORT}`);
    console.log('--------------------------');
});