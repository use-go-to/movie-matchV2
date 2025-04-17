const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');

const app = express();
const server = http.createServer(app);

// Configuration pour servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Route principale
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route pour le fichier TSV
app.get('/top100.tsv', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'top100.tsv'));
});

// Configuration Socket.io
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Stockage des données
const groups = {};
let moviesList = [];

// Clé API OMDB
const OMDB_API_KEY = "f7c46ef";

// Charger les films au démarrage
async function loadMovies() {
    try {
        const data = await fs.readFile(path.join(__dirname, 'public', 'top100.tsv'), 'utf8');
        const lines = data.split('\n');
        
        moviesList = lines.slice(1) // Ignorer l'en-tête
            .filter(line => line.trim())
            .map(line => {
                const [imdbID, Title, Year, Genre, Rating, Votes] = line.split('\t');
                return { imdbID, Title, Year, Genre };
            });
        
        console.log(`Chargement de ${moviesList.length} films`);
    } catch (err) {
        console.error("Erreur de chargement des films:", err);
    }
}

// Obtenir un film aléatoire
function getRandomMovie() {
    if (moviesList.length === 0) return null;
    return moviesList[Math.floor(Math.random() * moviesList.length)];
}

// Récupérer les détails d'un film via l'API OMDB
async function fetchMovieDetails(imdbID) {
    try {
        const response = await axios.get(`https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbID}`);
        if (response.data && response.data.Response === "True") {
            return response.data;
        }
        return null;
    } catch (error) {
        console.error(`Erreur lors de la récupération des détails du film ${imdbID}:`, error);
        return null;
    }
}

// Gestion des connexions Socket.io
io.on('connection', (socket) => {
    console.log('Nouvelle connexion:', socket.id);
    
    let currentGroup = null;
    let currentUserId = null;

    // Rejoindre un groupe
    socket.on('joinGroup', async (groupId, userId) => {
        currentGroup = groupId;
        currentUserId = userId;
        
        if (!groups[groupId]) {
            groups[groupId] = {
                members: {},
                currentMovie: null,
                votes: {},
                movieHistory: [],
                matchFound: false // Indique si un match a été trouvé
            };

            // Charger le premier film avec ses détails
            const firstMovie = getRandomMovie();
            if (firstMovie) {
                groups[groupId].currentMovie = await fetchMovieDetails(firstMovie.imdbID) || firstMovie;
            }
        }
        
        groups[groupId].members[userId] = {
            id: userId,
            joinedAt: new Date()
        };
        
        socket.join(groupId);
        
        // Envoyer le film courant au nouveau membre
        sendGroupUpdate(groupId);
    });

    // Voter pour un film
    socket.on('groupVote', async (groupId, userId, movieId, vote) => {
        if (!groups[groupId] || groups[groupId].matchFound) return; // Ne rien faire si un match est déjà trouvé
        
        groups[groupId].votes[userId] = {
            movieId,
            vote,
            timestamp: new Date()
        };
        
        await checkConsensus(groupId);
    });

    // Demander un nouveau film
    socket.on('requestMovie', (groupId) => {
        if (groups[groupId] && !groups[groupId].matchFound) {
            nextGroupMovie(groupId);
        }
    });

    // Déconnexion
    socket.on('disconnect', () => {
        console.log(`Déconnexion de l'utilisateur: ${socket.id}`);
        if (currentGroup && currentUserId && groups[currentGroup]) {
            // Supprimer l'utilisateur du groupe
            delete groups[currentGroup].members[currentUserId];
            delete groups[currentGroup].votes[currentUserId];
            
            // Si le groupe est vide, le supprimer
            if (Object.keys(groups[currentGroup].members).length === 0) {
                delete groups[currentGroup];
            } else {
                // Sinon, mettre à jour les membres restants
                sendGroupUpdate(currentGroup);
            }
        }
    });
});

// Passer au film suivant dans un groupe
async function nextGroupMovie(groupId) {
    if (!groups[groupId] || groups[groupId].matchFound) return; // Ne rien faire si un match est déjà trouvé
    
    // Ajouter le film actuel à l'historique
    if (groups[groupId].currentMovie) {
        groups[groupId].movieHistory.push(groups[groupId].currentMovie.imdbID);
    }
    
    // Obtenir un nouveau film (non vu)
    let newMovie;
    let attempts = 0;
    const maxAttempts = 20;
    
    do {
        newMovie = getRandomMovie();
        attempts++;
    } while (
        attempts < maxAttempts && 
        newMovie && 
        groups[groupId].movieHistory.includes(newMovie.imdbID)
    );
    
    if (newMovie) {
        const movieDetails = await fetchMovieDetails(newMovie.imdbID);
        groups[groupId].currentMovie = movieDetails || newMovie;
    } else {
        groups[groupId].currentMovie = null;
    }
    
    groups[groupId].votes = {};
    sendGroupUpdate(groupId);
}

// Vérifier si un consensus est atteint
async function checkConsensus(groupId) {
    const group = groups[groupId];
    if (!group) return;
    
    const votes = Object.values(group.votes);
    const members = Object.keys(group.members);
    
    if (votes.length < members.length) return;
    
    const likeCount = votes.filter(v => v.vote === 'like').length;
    
    if (likeCount === members.length) {
        // Arrêter le défilement et envoyer le film correspondant
        group.matchFound = true; // Marquer qu'un match a été trouvé
        io.to(groupId).emit('consensusReached', {
            message: "Match trouvé !",
            movie: group.currentMovie
        });
    } else {
        await nextGroupMovie(groupId);
    }
}

// Envoyer une mise à jour du groupe
function sendGroupUpdate(groupId) {
    const group = groups[groupId];
    if (!group) return;

    io.to(groupId).emit('groupUpdate', {
        members: group.members,
        movie: group.currentMovie,
        votes: group.votes
    });
}

// Démarrer le serveur
const PORT = process.env.PORT || 10000;
loadMovies().then(() => {
    server.listen(PORT, () => {
        console.log(`Serveur en écoute sur le port ${PORT}`);
    });
});
