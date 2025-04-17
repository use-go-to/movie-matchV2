const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();

// Autorise les requêtes depuis le même domaine (utile sur Render)
app.use(cors());

// Sert les fichiers HTML/CSS/JS du dossier "public"
app.use(express.static(path.join(__dirname, 'public')));

// Route de base
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: '*', // À restreindre à ton URL Render en production
        methods: ['GET', 'POST']
    }
});

// Stockage des données de groupe
const groups = {};

io.on('connection', (socket) => {
    console.log('Nouvelle connexion:', socket.id);
    
    let currentGroup = null;
    let currentUserId = null;
    
    // Rejoindre un groupe
    socket.on('joinGroup', (groupId, userId) => {
        currentGroup = groupId;
        currentUserId = userId;
        
        if (!groups[groupId]) {
            groups[groupId] = {
                members: {},
                currentMovie: null,
                votes: {}
            };
        }
        
        groups[groupId].members[userId] = {
            id: userId,
            joinedAt: new Date()
        };
        
        socket.join(groupId);
        updateGroup(groupId);
    });
    
    // Voter pour un film
    socket.on('groupVote', (groupId, userId, movieId, vote) => {
        if (!groups[groupId]) return;
        
        groups[groupId].votes[userId] = {
            movieId,
            vote,
            timestamp: new Date()
        };
        
        checkConsensus(groupId);
        updateGroup(groupId);
    });
    
    // Déconnexion
    socket.on('disconnect', () => {
        if (currentGroup && currentUserId && groups[currentGroup]) {
            delete groups[currentGroup].members[currentUserId];
            delete groups[currentGroup].votes[currentUserId];
            
            if (Object.keys(groups[currentGroup].members).length === 0) {
                delete groups[currentGroup];
            } else {
                updateGroup(currentGroup);
            }
        }
    });
    
    // Mettre à jour les données du groupe
    function updateGroup(groupId) {
        if (!groups[groupId]) return;
        
        io.to(groupId).emit('groupUpdate', {
            members: groups[groupId].members,
            movie: groups[groupId].currentMovie,
            votes: groups[groupId].votes
        });
    }
    
    // Vérifier si un film fait l'unanimité
    function checkConsensus(groupId) {
        const group = groups[groupId];
        if (!group) return;
        
        const votes = Object.values(group.votes);
        const members = Object.keys(group.members);
        
        if (votes.length < members.length) return;
        
        const voteCounts = {};
        votes.forEach(v => {
            if (v.vote === 'like') {
                voteCounts[v.movieId] = (voteCounts[v.movieId] || 0) + 1;
            }
        });
        
        for (const movieId in voteCounts) {
            if (voteCounts[movieId] === members.length) {
                io.to(groupId).emit('consensusReached', movieId);
                return;
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur en écoute sur le port ${PORT}`);
});
