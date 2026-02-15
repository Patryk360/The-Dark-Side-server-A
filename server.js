const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// Przechowujemy graczy: { id: { x, y, color, anim } }
let players = {};

io.on('connection', (socket) => {
    console.log('Nowy gracz:', socket.id);

    // 1. Tworzymy gracza (pozycja startowa tymczasowa, klient ją poprawi)
    players[socket.id] = {
        x: 0,
        y: -500,
        color: '#' + Math.floor(Math.random()*16777215).toString(16), // Losowy kolor
        width: 20,
        height: 40
    };

    // 2. Wysyłamy nowemu graczowi listę obecnych
    socket.emit('currentPlayers', players);

    // 3. Wysyłamy innym, że ktoś doszedł
    socket.broadcast.emit('newPlayer', { 
        id: socket.id, 
        player: players[socket.id] 
    });

    // 4. Odbieramy ruch
    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            // Przekazujemy info innym
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: players[socket.id].x,
                y: players[socket.id].y
            });
        }
    });

    // 5. Odbieramy budowanie/niszczenie
    socket.on('blockUpdate', (data) => {
        // data = { x, y, type }
        socket.broadcast.emit('blockUpdate', data);
    });

    // 6. Wyjście
    socket.on('disconnect', () => {
        console.log('Gracz wyszedł:', socket.id);
        delete players[socket.id];
        io.emit('disconnect', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Serwer działa na http://localhost:${PORT}`);
});