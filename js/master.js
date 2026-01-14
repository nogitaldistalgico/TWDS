/* Master/Host Logic */

/* State Machine */
const STATE = {
    WALL: 'WALL',
    QUESTION: 'QUESTION',
    REVEAL: 'REVEAL'
};

class MasterGame {
    constructor() {
        this.questions = [];
        this.currentQuestion = null;
        this.state = STATE.WALL;
        this.peerManager = new PeerManager(true); // Host mode
        this.selectedCategory = null;

        // Multiplayer State
        this.teams = [
            { id: 0, name: 'Team Tobi', conn: null, score: 0, el: document.getElementById('team-0') },
            { id: 1, name: 'Team Lurch', conn: null, score: 0, el: document.getElementById('team-1') }
        ];
        this.currentTurn = 0; // 0 = Tobi starts
        this.lastPlayerAnswer = null; // Store which choice was made
        this.lastAnswerCorrect = false;

        // DOM Elements
        this.elWall = document.querySelector('.category-wall');
        this.elQuestionOverlay = document.querySelector('.question-overlay');
        this.elRoomId = document.querySelector('.room-id');
        this.elQuestionText = document.querySelector('.question-text');
        this.elAnswers = {
            A: document.getElementById('ans-A'),
            B: document.getElementById('ans-B'),
            C: document.getElementById('ans-C')
        };

        this.loadQuestions();
        this.initNetwork();
        this.initControls();
        this.updateTurnUI();
    }

    async loadQuestions() {
        try {
            const response = await fetch('questions.json');
            this.questions = await response.json();
            this.renderWall();
        } catch (e) {
            console.error("Failed to load questions", e);
        }
    }

    initNetwork() {
        this.elRoomId.textContent = "Connecting...";

        this.peerManager.onOpen((id) => {
            this.elRoomId.textContent = id;
        });

        // Error handling
        this.peerManager.onError((err) => {
            console.error("PeerJS Error:", err);

            // Handle ID Taken (e.g. previous session didn't close properly)
            if (err.type === 'unavailable-id') {
                this.elRoomId.innerHTML = `<span style="color:orange; font-size:0.6em">ID belegt. <br>Warte kurz...</span>`;
                // Optional: Retry after 2 seconds? Or just tell user to refresh
                setTimeout(() => location.reload(), 2000);
            } else {
                this.elRoomId.innerHTML = `<span style="color:red; font-size:0.8em">Error: ${err.type}</span>`;
            }
        });

        // Use the proper callback hook instead of accessing null peer
        this.peerManager.onConnection((conn) => {
            this.handlePlayerJoin(conn);
        });

        // We handle data in specific connection listeners now to intercept CLAIM_TEAM
        // this.peerManager.onData((data) => {
        //     this.handlePlayerInput(data); 
        // });

        this.peerManager.init('TOBIS-JGA');
    }

    handlePlayerJoin(conn) {
        conn.on('open', () => {
            console.log(`New connection from ${conn.peer}`);

            // Do NOT auto-assign. Wait for 'CLAIM_TEAM'
            conn.on('data', (data) => {
                if (data.type === 'CLAIM_TEAM') {
                    this.handleTeamClaim(conn, data.payload);
                } else {
                    // Pass other messages to general handler
                    this.handlePlayerInput(data);
                }
            });

            conn.on('close', () => {
                // Find if this conn was assigned to a team
                const team = this.teams.find(t => t.conn === conn);
                if (team) {
                    console.log(`${team.name} disconnected`);
                    team.conn = null;
                    team.el.classList.remove('joined');
                    team.el.querySelector('.join-status').textContent = "Waiting...";
                }
            });
        });
    }

    handleTeamClaim(conn, teamId) {
        const team = this.teams.find(t => t.id === teamId);
        if (!team) return; // Invalid team ID

        if (team.conn) {
            // Team already taken
            conn.send({ type: 'TEAM_TAKEN', payload: teamId });
        } else {
            // Assign team
            team.conn = conn;
            console.log(`Assigned ${conn.peer} to ${team.name}`);

            // UI Update
            team.el.classList.add('joined');
            team.el.querySelector('.join-status').textContent = "CONNECTED";

            // Confirm to player
            conn.send({ type: 'TEAM_CONFIRMED', payload: teamId });
        }
    }

    handlePlayerInput(data) {
        if (data.type === 'LOGIN') {
            // Handled during connection assignment mainly
        } else if (data.type === 'ANSWER') {
            if (this.state === STATE.QUESTION) {
                // Ideally check if it's the right player's turn (data.peer vs this.teams[this.currentTurn].conn.peer)
                // For simplicity, we accept the input and attribute it to the current turn team

                console.log(`Team ${this.currentTurn} answered: ${data.payload}`);
                this.lastPlayerAnswer = data.payload;

                const currentTeamEl = this.teams[this.currentTurn].el;
                currentTeamEl.classList.add('answered'); // Visual feedback

                // Check correctness immediately (but don't show yet)
                this.lastAnswerCorrect = (data.payload === this.currentQuestion.correct);

                this.playAudio('lock-in');
            }
        }
    }

    renderWall() {
        this.elWall.innerHTML = '';
        this.questions.forEach((q, index) => {
            const card = document.createElement('div');
            card.className = 'glass-panel category-card';
            card.textContent = q.category;
            card.id = `cat-${index}`;
            card.addEventListener('click', () => this.selectCategory(index));
            this.elWall.appendChild(card);
        });
    }

    selectCategory(index) {
        if (this.state !== STATE.WALL) return;
        // Verify if category is already played
        const card = document.getElementById(`cat-${index}`);
        if (card.classList.contains('played')) return;

        this.selectedCategory = index;
        this.currentQuestion = this.questions[index];
        this.state = STATE.QUESTION;

        // POPULATE UI
        this.elQuestionText.textContent = this.currentQuestion.question;
        this.elAnswers.A.querySelector('.text').textContent = this.currentQuestion.options.A;
        this.elAnswers.B.querySelector('.text').textContent = this.currentQuestion.options.B;
        this.elAnswers.C.querySelector('.text').textContent = this.currentQuestion.options.C;

        // RESET STYLES
        Object.values(this.elAnswers).forEach(el => {
            el.className = 'answer-card glass-panel';
        });
        document.querySelector('.explanation-box').classList.add('hidden');
        this.teams.forEach(t => t.el.classList.remove('answered'));

        // SHOW
        this.elQuestionOverlay.classList.remove('hidden');
        this.elQuestionOverlay.classList.add('animate-fade-in');

        // NOTIFY ALL
        this.broadcast({ type: 'STATE_CHANGE', payload: 'QUESTION' });
    }

    revealAnswer() {
        if (this.state !== STATE.QUESTION) return;
        this.state = STATE.REVEAL;

        const correct = this.currentQuestion.correct;
        const correctEl = this.elAnswers[correct];

        // HIGHLIGHT CORRECT
        correctEl.classList.add('correct', 'reveal-highlight');

        // HIGHLIGHT PLAYER SELECTION (if wrong)
        if (!this.lastAnswerCorrect && this.lastPlayerAnswer) {
            this.elAnswers[this.lastPlayerAnswer].classList.add('wrong');
        }

        // SHOW EXPLANATION
        const explBox = document.querySelector('.explanation-box');
        explBox.textContent = this.currentQuestion.explanation;
        explBox.classList.remove('hidden');
        explBox.classList.add('animate-scale-in');

        // NOTIFY
        this.broadcast({ type: 'STATE_CHANGE', payload: 'REVEAL', correct: correct });
    }

    closeQuestion() {
        // UPDATE WALL
        const card = document.getElementById(`cat-${this.selectedCategory}`);
        card.classList.add('played');

        // APPLY WIN/LOSS STATE
        if (this.lastAnswerCorrect) {
            // Team Won -> Show Face
            // card.classList.add(`team-${this.teams[this.currentTurn].id}`);  <-- OLD

            // NEW LOGIC: Show Face of the team that just played
            // BUT: Requirements say "Replace logo on the question field" which usually implies the wall card.
            // AND: "if answered correctly... team logo is set".

            card.style.backgroundImage = `url('assets/${this.currentTurn === 0 ? 'tobi' : 'lurch'}.png')`;
            card.style.borderColor = this.currentTurn === 0 ? 'var(--color-primary)' : 'var(--color-secondary)';
            card.style.boxShadow = `0 0 15px ${this.currentTurn === 0 ? 'var(--color-primary-glow)' : 'var(--color-secondary-glow)'}`;
            card.textContent = ''; // Hide text

            // Add Score (e.g. 500)
            this.teams[this.currentTurn].score += 500;
            this.teams[this.currentTurn].el.querySelector('.player-score').textContent = this.teams[this.currentTurn].score + ' €';
        } else {
            // Team Lost -> Show X (Grey)
            card.classList.add('lost');
        }

        // SWITCH TURN
        this.currentTurn = (this.currentTurn + 1) % 2;
        this.updateTurnUI();

        // HIDE OVERLAY
        this.elQuestionOverlay.classList.add('hidden');
        this.state = STATE.WALL;

        // RESET STATE
        this.lastPlayerAnswer = null;
        this.lastAnswerCorrect = false;

        // NOTIFY
        this.broadcast({ type: 'STATE_CHANGE', payload: 'WALL' });
    }

    updateTurnUI() {
        this.teams.forEach(t => t.el.classList.remove('active-turn'));
        this.teams[this.currentTurn].el.classList.add('active-turn');

        // Update Indicator
        const indicator = document.getElementById('turn-indicator');
        if (indicator) {
            indicator.textContent = (this.currentTurn === 0) ? "TOBIS RUNDE" : "LURCHS RUNDE";
            indicator.style.color = (this.currentTurn === 0) ? "var(--color-primary)" : "var(--color-secondary)";
        }
    }

    broadcast(msg) {
        // Send to all connected teams
        this.teams.forEach(t => {
            if (t.conn && t.conn.open) {
                t.conn.send(msg);
            }
        });
    }

    initControls() {
        document.addEventListener('keydown', (e) => {
            if (e.key === ' ') {
                if (this.state === STATE.QUESTION) {
                    this.revealAnswer();
                } else if (this.state === STATE.REVEAL) {
                    this.closeQuestion();
                }
            }
        });
    }

    playAudio(name) { }
}

// Start Game
document.addEventListener('DOMContentLoaded', () => {
    window.game = new MasterGame();
});
