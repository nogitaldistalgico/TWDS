/* Master/Host Logic */

// Debug Logger
const debugEl = document.getElementById('debug-console');
if (location.search.includes('debug=true')) {
    if (debugEl) {
        debugEl.style.display = 'block';
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;

        console.log = (...args) => {
            debugEl.innerHTML += `[LOG] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}<br>`;
            debugEl.scrollTop = debugEl.scrollHeight;
            originalLog.apply(console, args);
        };

        console.error = (...args) => {
            debugEl.innerHTML += `<span style="color:red">[ERR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}</span><br>`;
            debugEl.scrollTop = debugEl.scrollHeight;
            originalError.apply(console, args);
        };

        console.warn = (...args) => {
            debugEl.innerHTML += `<span style="color:orange">[WRN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}</span><br>`;
            debugEl.scrollTop = debugEl.scrollHeight;
            originalWarn.apply(console, args);
        };

        window.onerror = (msg, url, line) => {
            console.error(`Global: ${msg} @ ${line}`);
        };
    }
}

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
        this.loadGame(); // Restore state from storage
        this.initNetwork();
        this.initControls();
        this.updateTurnUI();
    }

    async loadQuestions() {
        try {
            const response = await fetch('questions.json');
            this.questions = await response.json();
            this.renderWall();
            this.applyLoadedState(); // Restore wall visuals
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

        this.peerManager.init('TOBIS-JGA');
    }

    handlePlayerJoin(conn) {
        conn.on('open', () => {
            console.log(`New connection from ${conn.peer}`);
            conn.send({ type: 'DEBUG', message: 'Welcome to Master' });

            // Do NOT auto-assign. Wait for 'CLAIM_TEAM'
            conn.on('data', (data) => {
                console.log('Received data:', data);
                if (data.type === 'CLAIM_TEAM') {
                    this.handleTeamClaim(conn, data.payload);
                } else {
                    // Pass other messages to general handler with CONN context
                    this.handlePlayerInput(data, conn);
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

        // Always allow claiming/reclaiming (overwrites previous connection)
        if (team.conn) {
            console.log(`Overwriting existing connection for ${team.name}`);
        }

        // Assign team
        team.conn = conn;
        console.log(`Assigned ${conn.peer} to ${team.name}`);

        // UI Update
        team.el.classList.add('joined');
        team.el.querySelector('.join-status').textContent = "CONNECTED";

        // Confirm to player
        conn.send({ type: 'TEAM_CONFIRMED', payload: teamId });
    }

    handlePlayerInput(data, conn) {
        if (data.type === 'LOGIN') {
            // Handled during connection assignment mainly
        } else if (data.type === 'ANSWER') {
            if (this.state === STATE.QUESTION) {
                // Verify if it is the correct team's turn
                const currentTeam = this.teams[this.currentTurn];

                // LOGGING FOR DEBUGGING
                console.log(`[Input Check] Turn: Team ${this.currentTurn} (${currentTeam.name})`);
                console.log(`[Input Check] Sender: ${conn.peer}`);

                // ID Checking (Reset-proof)
                if (currentTeam.conn && conn.peer === currentTeam.conn.peer) {
                    this.processAnswer(data.payload);
                } else {
                    console.warn(`Ignored answer from wrong team/connection.`);
                    if (conn) {
                        conn.send({
                            type: 'ERROR',
                            message: `Moment! Team ${currentTeam.name} ist dran!`
                        });
                    }
                }
            } else {
                console.warn('Received answer but not in QUESTION state.');
            }
        }
    }

    // Centralized Answer Processing (triggered by Network OR Keyboard)
    processAnswer(answerPayload) {
        if (this.state !== STATE.QUESTION) return;

        console.log(`Processing Answer: ${answerPayload} for Team ${this.currentTurn}`);
        this.lastPlayerAnswer = answerPayload;

        const currentTeamEl = this.teams[this.currentTurn].el;
        currentTeamEl.classList.add('answered'); // Visual feedback

        // Highlight the chosen answer card
        const ansEl = this.elAnswers[answerPayload];
        if (ansEl) {
            ansEl.classList.add('selected');
        } else {
            console.error("Critical: Could not find answer element for payload:", answerPayload);
        }

        // Check correctness immediately (but don't show yet)
        this.lastAnswerCorrect = (answerPayload === this.currentQuestion.correct);

        this.playAudio('lock-in');
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

        // ANIMATION STEP
        card.classList.add('selecting');
        // Optional: Play "Selection" sound here if we had one
        // this.playAudio('select'); 

        // Delay for Effect (Display the flash/pulse for 1.2s)
        setTimeout(() => {
            card.classList.remove('selecting');

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
            this.updateHostButton();
        }, 1200); // 1.2s delay
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
        this.updateHostButton();
    }

    saveGame() {
        const state = {
            scores: this.teams.map(t => t.score),
            currentTurn: this.currentTurn,
            playedCategories: []
        };

        const cards = document.querySelectorAll('.category-card.played');
        cards.forEach(card => {
            const index = parseInt(card.id.replace('cat-', ''));
            let result = 'lost';
            if (card.style.backgroundImage.includes('tobi')) result = 'tobi';
            if (card.style.backgroundImage.includes('lurch')) result = 'lurch';

            state.playedCategories.push({ index, result });
        });

        localStorage.setItem('wwds_gamestate', JSON.stringify(state));
    }

    loadGame() {
        const saved = localStorage.getItem('wwds_gamestate');
        if (!saved) return;

        try {
            const state = JSON.parse(saved);
            // Restore Scores
            this.teams[0].score = state.scores[0];
            this.teams[1].score = state.scores[1];
            this.teams[0].el.querySelector('.player-score').textContent = state.scores[0] + ' €';
            this.teams[1].el.querySelector('.player-score').textContent = state.scores[1] + ' €';

            // Restore Turn
            this.currentTurn = state.currentTurn;
            this.updateTurnUI();

            this.pendingLoadState = state;
        } catch (e) {
            console.error("Error loading state:", e);
        }
    }

    applyLoadedState() {
        if (!this.pendingLoadState) return;
        const state = this.pendingLoadState;

        state.playedCategories.forEach(item => {
            const card = document.getElementById(`cat-${item.index}`);
            if (card) {
                card.classList.add('played');
                card.textContent = '';

                if (item.result === 'lost') {
                    card.classList.add('lost');
                } else {
                    card.style.backgroundImage = `url('assets/${item.result}.png')`;
                    card.style.borderColor = (item.result === 'tobi') ? 'var(--color-primary)' : 'var(--color-secondary)';
                    card.style.boxShadow = `0 0 15px ${(item.result === 'tobi') ? 'var(--color-primary-glow)' : 'var(--color-secondary-glow)'}`;
                }
            }
        });
        this.pendingLoadState = null;
    }

    resetGame() {
        if (confirm("Spiel wirklich zurücksetzen? Alle Punkte gehen verloren!")) {
            localStorage.removeItem('wwds_gamestate');
            location.reload();
        }
    }

    closeQuestion() {
        // UPDATE WALL
        const card = document.getElementById(`cat-${this.selectedCategory}`);
        card.classList.add('played');

        // APPLY WIN/LOSS STATE
        if (this.lastAnswerCorrect) {
            // Team Won -> Show Face
            // Layer 1: Face Image (Top), Layer 2: Gradient (Top), Layer 3: Gradient (Bottom)
            // Show Style: Purple/Pink Gradient for Winner
            const gradient = `linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 100%), linear-gradient(to bottom, #9b287b 0%, #5c1248 100%)`;

            card.style.backgroundImage = `url('assets/${this.currentTurn === 0 ? 'tobi' : 'lurch'}.png'), ${gradient}`;

            // Reference Size: Face is LARGE (~70% of card height)
            card.style.backgroundSize = '70%, cover, cover';

            // Position: Center Bottom usually looks best for heads
            card.style.backgroundPosition = 'center bottom -10px, center, center';

            // Add Gold Border via class, but ensure JS doesn't override it poorly
            card.classList.add('border-gold'); // master.css handles border-gold styling

            card.style.backgroundRepeat = 'no-repeat, no-repeat';
            // The previous line for backgroundPosition was 'center, center', which is redundant with the more specific one above.
            // Keeping the more specific one and removing the generic one.
            // card.style.backgroundPosition = 'center, center'; // This line is removed as it's redundant/overwritten by the more specific one above.

            card.style.borderColor = this.currentTurn === 0 ? 'var(--color-primary)' : 'var(--color-secondary)';
            // The boxShadow was removed as per the instruction's implied change (it was not in the new snippet).
            card.textContent = '';

            const oldScore = this.teams[this.currentTurn].score;
            this.teams[this.currentTurn].score += 500;
            const newScore = this.teams[this.currentTurn].score;

            const scoreEl = this.teams[this.currentTurn].el.querySelector('.player-score');
            this.animateScore(scoreEl, oldScore, newScore);
        } else {
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
        this.updateHostButton();

        // SAVE STATE
        this.saveGame();
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

    animateScore(element, start, end) {
        if (start === end) return;
        const duration = 2000; // 2s animation
        const startTime = performance.now();

        const update = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Ease out quart
            const ease = 1 - Math.pow(1 - progress, 4);

            const current = Math.floor(start + (end - start) * ease);
            element.textContent = current + " €";

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                element.textContent = end + " €";
            }
        };
        requestAnimationFrame(update);
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
            const key = e.key.toLowerCase();

            // GAME LOOP CONTROLS
            if (e.key === ' ' || e.code === 'Space') {
                if (this.state === STATE.QUESTION) {
                    this.revealAnswer();
                } else if (this.state === STATE.REVEAL) {
                    this.closeQuestion();
                }
            }

            // EMERGENCY KEYBOARD INPUTS (Fallback for unstable connections)
            // T -> A
            // Z -> B (QWERTZ layout adjacent)
            // U -> C
            if (this.state === STATE.QUESTION) {
                if (key === 't') this.processAnswer('A');
                else if (key === 'z' || key === 'y') this.processAnswer('B'); // Support Z (QWERTZ) and Y (QWERTY) just in case
                else if (key === 'u') this.processAnswer('C');
            }
        });

        // Mouse/Touch Control
        this.btnHostAction = document.getElementById('btn-host-action');
        if (this.btnHostAction) {
            this.btnHostAction.addEventListener('click', () => {
                if (this.state === STATE.QUESTION) {
                    this.revealAnswer();
                } else if (this.state === STATE.REVEAL) {
                    this.closeQuestion();
                }
            });
        }
    }

    updateHostButton() {
        if (!this.btnHostAction) return;

        if (this.state === STATE.WALL) {
            this.btnHostAction.style.display = 'none'; // Select category to start
        } else if (this.state === STATE.QUESTION) {
            this.btnHostAction.style.display = 'block';
            this.btnHostAction.textContent = "AUFLÖSEN (Space)";
            this.btnHostAction.style.background = "var(--color-primary)";
        } else if (this.state === STATE.REVEAL) {
            this.btnHostAction.style.display = 'block';
            this.btnHostAction.textContent = "WEITER (Space)";
            this.btnHostAction.style.background = "var(--color-secondary)";
        }
    }

    playAudio(name) { }
}

// Start Game
document.addEventListener('DOMContentLoaded', () => {
    window.game = new MasterGame();
});
