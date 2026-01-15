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
