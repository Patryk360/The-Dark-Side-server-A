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
// --- NOWOŚĆ: PAMIĘĆ ŚWIATA ---
// Przechowujemy tylko zmiany (gdzie gracz coś postawił/zniszczył)
// Format klucza: "x,y", Wartość: type
let worldChanges = {}; 

io.on('connection', (socket) => {
    console.log('Nowy gracz:', socket.id);

    players[socket.id] = {
        x: 0, y: -500, width: 20, height: 40,
        color: '#' + Math.floor(Math.random()*16777215).toString(16)
    };

    // 1. Wyślij graczowi listę obecnych graczy
    socket.emit('currentPlayers', players);

    // 2. --- NOWOŚĆ: Wyślij graczowi historię zmian w świecie ---
    socket.emit('worldHistory', worldChanges);

    // 3. Poinformuj innych o nowym graczu
    socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });

    socket.on('chatMessage', (msg) => {
        // Zabezpieczenie przed pustymi wiadomościami
        if (!msg || msg.trim() === "") return;

        // Skracamy zbyt długie wiadomości
        const cleanMsg = msg.substring(0, 100);

        // Wysyłamy do wszystkich: { id: kto, text: treść }
        io.emit('chatMessage', { 
            id: socket.id, 
            text: cleanMsg 
        });
    });

    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: players[socket.id].x,
                y: players[socket.id].y
            });
        }
    });

    // 4. --- NOWOŚĆ: Zapisywanie zmian ---
    socket.on('blockUpdate', (data) => {
        // data = { x, y, type }
        const key = `${data.x},${data.y}`;
        worldChanges[key] = data.type; // Zapisz w pamięci serwera
        
        // Wyślij do innych
        socket.broadcast.emit('blockUpdate', data);
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Serwer działa na http://localhost:${PORT}`);
});