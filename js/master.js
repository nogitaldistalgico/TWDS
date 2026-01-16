/* Master/Host Logic */

window.toggleFullscreen = function () {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(() => {
            sessionStorage.setItem('wwds_fullscreen_pref', 'true');
        }).catch(err => {
            console.warn(`Error attempting to enable fullscreen: ${err.message}`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
            sessionStorage.setItem('wwds_fullscreen_pref', 'false');
        }
    }
};

// Auto-Restore Fullscreen on user interaction AND unlock Audio
document.addEventListener('click', function restoreFs() {
    // 1. Fullscreen
    if (sessionStorage.getItem('wwds_fullscreen_pref') === 'true' && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => { });
    }

    // 2. Unlock/Test Audio
    const sfx = document.getElementById('sfx-login');
    if (sfx) {
        sfx.play().then(() => {
            sfx.pause();
            sfx.currentTime = 0;
            console.log("Audio Context Unlocked (DOM)");
        }).catch(e => console.warn("Audio unlock failed", e));
    }

    // Remove after first interaction
    document.removeEventListener('click', restoreFs);
}, { once: true });

window.testSound = function () {
    const s = document.getElementById('sfx-login');
    if (!s) return alert("Audio Element not found!");

    // Diagnostic info
    const info = `ReadyState: ${s.readyState}, Error: ${s.error ? s.error.code : 'None'}, Src: ${s.currentSrc}`;
    console.log(info);

    // Attempt 1: Standard Play
    s.play().then(() => {
        console.log("Play success!");
    }).catch(e => {
        // Attempt 2: Force Load and Play
        console.warn("Play failed, retrying with load()", e);
        s.load();
        s.play().then(() => {
            console.log("Play success after load!");
        }).catch(e2 => {
            // Attempt 3: New Audio Object (Fallback)
            console.warn("Play failed again. Trying new Audio()", e2);
            const s2 = new Audio('assets/eingeloggt.mp3');
            s2.play().then(() => alert("Success with new Audio() object!")).catch(e3 => {
                alert(`ALL FAILS. ${e3.name}: ${e3.message}\n${info}`);
            });
        });
    });
}

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
    REVEAL: 'REVEAL',
    FINALE_BETTING: 'FINALE_BETTING',
    FINALE_QUESTION: 'FINALE_QUESTION',
    FINALE_REVEAL: 'FINALE_REVEAL'
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

        // Finale State
        this.finaleBets = { 0: null, 1: null }; // TeamID -> Amount
        this.finaleAnswers = { 0: null, 1: null }; // TeamID -> Answer

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

        // FINALE DOM
        this.elFinaleOverlay = document.getElementById('finale-overlay');
        this.elFinaleBetting = document.getElementById('finale-betting');
        this.elFinaleQuestion = document.getElementById('finale-question');
        this.elFinaleWinner = document.getElementById('finale-winner');

        // SOUNDS (DOM-based)
        this.sfx = {
            login: document.getElementById('sfx-login'),
            correct: document.getElementById('sfx-correct'),
            wrong: document.getElementById('sfx-wrong')
        };

        this.loadQuestions();
        this.loadGame(); // Restore state from storage
        this.initNetwork();
        this.initControls();
        this.updateTurnUI();

        // Cleanup on close to free the ID
        window.addEventListener('beforeunload', () => {
            if (this.peerManager.peer) {
                this.peerManager.peer.destroy();
            }
        });
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
                this.elRoomId.innerHTML = `<span style="color:orange; font-size:0.6em">ID belegt.<br>Warte 5s...</span>`;
                console.warn("ID taken. Retrying in 5s...");
                setTimeout(() => {
                    this.peerManager.peer.destroy();
                    this.peerManager.init('TOBIS-JGA');
                }, 5000);
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
                } else if (data.type === 'REQUEST_STATE') {
                    // NEW: Pull-based Sync (Player asks for data)
                    console.log(`Sending full state to ${conn.peer}`);
                    this.sendFullState(conn);
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

        // IMMEDIATE SYNC: Send current state
        conn.send({
            type: 'STATE_CHANGE',
            payload: this.state,
            questionsClosed: false // Optional context
        });

        // If we are in QUESTION/REVEAL, also send the last correctness info if needed
        if (this.state === STATE.REVEAL) {
            conn.send({ type: 'STATE_CHANGE', payload: 'REVEAL', correct: this.currentQuestion.correct });
        }
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
            } else if (this.state === STATE.FINALE_QUESTION) {
                const team = this.teams.find(t => t.conn === conn);
                if (team) {
                    this.processFinaleAnswer(team.id, data.payload);
                }
            } else {
                console.warn('Received answer but not in QUESTION state.');
            }
        } else if (data.type === 'BET') {
            if (this.state === STATE.FINALE_BETTING) {
                // Identify team
                const team = this.teams.find(t => t.conn === conn);
                if (team) {
                    this.processFinaleBet(team.id, data.payload);
                }
            }
        }
    }

    // Centralized Answer Processing (triggered by Network OR Keyboard)
    processAnswer(answerPayload) {
        if (this.state !== STATE.QUESTION) return;

        // PLAY SOUND IMMEDIATELY
        if (this.sfx && this.sfx.login) {
            this.sfx.login.currentTime = 0;
            this.sfx.login.play().catch(e => console.error("SFX ERROR (Login):", e));
        }

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

        // Play Lock-In Sound
        if (this.sfx && this.sfx.login) {
            this.sfx.login.currentTime = 0;
            this.sfx.login.play().catch(e => console.error("SFX ERROR (Login):", e));
        }
    }

    renderWall() {
        this.elWall.innerHTML = '';
        this.questions.forEach((q, index) => {
            const card = document.createElement('div');
            card.className = 'glass-panel category-card';
            card.textContent = q.category;
            card.id = `cat-${index}`;
            card.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.selectCategory(index);
            });
            this.elWall.appendChild(card);
        });
    }

    selectCategory(index) {
        if (this.state !== STATE.WALL) return;

        try {
            console.log("Category selected:", index);
            const card = document.getElementById(`cat-${index}`);
            if (!card || card.classList.contains('played')) return;

            // 1. MEASURE
            const rect = card.getBoundingClientRect();
            this.activeCardOriginalRect = rect; // Store for return animation

            // 2. CREATE FLYING CLONE
            const flyWrapper = document.createElement('div');
            flyWrapper.className = 'flying-card-wrapper';
            // Start at exact position of card
            flyWrapper.style.top = rect.top + 'px';
            flyWrapper.style.left = rect.left + 'px';
            flyWrapper.style.width = rect.width + 'px';
            flyWrapper.style.height = rect.height + 'px';

            const flyInner = document.createElement('div');
            flyInner.className = 'flying-card-inner';

            const faceFront = document.createElement('div');
            faceFront.className = 'card-face front';
            faceFront.textContent = this.questions[index].category;

            const faceBack = document.createElement('div');
            faceBack.className = 'card-face back';
            faceBack.textContent = this.questions[index].question;

            flyInner.appendChild(faceFront);
            flyInner.appendChild(faceBack);
            flyWrapper.appendChild(flyInner);
            document.body.appendChild(flyWrapper);

            this.elFlyingCard = flyWrapper; // Keep ref to remove later

            // 3. HIDE ORIGINAL (Invisible but takes space)
            card.style.opacity = '0';

            // DIM WALL
            this.elWall.classList.add('dimmed');

            // 4. ANIMATE (Next Frame)
            requestAnimationFrame(() => {
                // Target: Top half of screen, avoiding overlap
                const targetWidth = Math.min(window.innerWidth * 0.6, 500);
                const targetHeight = Math.min(window.innerHeight * 0.4, 300);

                // Position at top 10%
                const targetTop = window.innerHeight * 0.10;
                const targetLeft = (window.innerWidth - targetWidth) / 2;

                flyWrapper.style.top = targetTop + 'px';
                flyWrapper.style.left = targetLeft + 'px';
                flyWrapper.style.width = targetWidth + 'px';
                flyWrapper.style.height = targetHeight + 'px';

                // Trigger Flip
                flyWrapper.classList.add('flipped');
            });

            // 5. TRANSITION TO GAME STATE
            setTimeout(() => {
                try {
                    this.selectedCategory = index;
                    this.currentQuestion = this.questions[index];
                    this.state = STATE.QUESTION;

                    // POPULATE UI - Answers Only (Question text is on card)
                    this.elQuestionText.textContent = ""; // Hide text in overlay
                    this.elQuestionText.style.display = 'none'; // Ensure no black box appears
                    this.elAnswers.A.querySelector('.text').textContent = this.currentQuestion.options.A;
                    this.elAnswers.B.querySelector('.text').textContent = this.currentQuestion.options.B;
                    this.elAnswers.C.querySelector('.text').textContent = this.currentQuestion.options.C;

                    // RESET STYLES
                    Object.values(this.elAnswers).forEach(el => {
                        el.className = 'answer-card glass-panel';
                    });
                    document.querySelector('.explanation-box').classList.add('hidden');
                    this.teams.forEach(t => t.el.classList.remove('answered'));

                    // SHOW OVERLAY (Answers)
                    this.elQuestionOverlay.classList.remove('hidden');
                    // this.elQuestionOverlay.classList.add('animate-fade-in'); // Removed fade-in of container

                    // Trigger Slide Animation
                    Object.values(this.elAnswers).forEach(el => {
                        el.classList.remove('animate-in'); // Reset
                        void el.offsetWidth; // Trigger reflow
                        el.classList.add('animate-in');
                    });

                    // BROADCAST
                    this.broadcast({
                        type: 'STATE_CHANGE',
                        payload: 'QUESTION',
                        turn: this.currentTurn // Add Turn Info
                    });
                    this.updateHostButton();
                } catch (timeoutErr) {
                    console.error("Error inside selectCategory timeout:", timeoutErr);
                }
            }, 1000); // 1s sync with animation

        } catch (err) {
            console.error("Error in selectCategory:", err);
        }
    }

    revealAnswer() {
        if (this.state !== STATE.QUESTION) return;
        this.state = STATE.REVEAL;

        this.lastAnswerCorrect = (this.lastPlayerAnswer === this.currentQuestion.correct);

        // AUDIO FEEDBACK IMMEDIATELY
        if (this.sfx) {
            if (this.lastAnswerCorrect) {
                this.sfx.correct.currentTime = 0;
                this.sfx.correct.play().catch(e => console.error("SFX ERROR (Correct):", e));
            } else {
                this.sfx.wrong.currentTime = 0;
                this.sfx.wrong.play().catch(e => console.error("SFX ERROR (Wrong):", e));
            }
        }

        const correct = this.currentQuestion.correct;
        const correctEl = this.elAnswers[correct];

        // HIGHLIGHT CORRECT
        correctEl.classList.add('correct', 'reveal-highlight');

        // SCREEN PULSE
        const app = document.getElementById('app');
        if (this.lastAnswerCorrect) {
            app.classList.add('flash-green');
            setTimeout(() => app.classList.remove('flash-green'), 1000);
        } else if (this.lastPlayerAnswer) {
            // Wrong answer given
            app.classList.add('flash-red');
            setTimeout(() => app.classList.remove('flash-red'), 1000);
        }

        // HIGHLIGHT PLAYER SELECTION (if wrong)
        if (!this.lastAnswerCorrect && this.lastPlayerAnswer) {
            this.elAnswers[this.lastPlayerAnswer].classList.add('wrong');
        }

        // AUDIO FEEDBACK (Moved from closeQuestion)
        if (this.sfx) {
            if (this.lastAnswerCorrect) {
                this.sfx.correct.currentTime = 0;
                this.sfx.correct.play().catch(e => console.error("SFX ERROR (Correct):", e));
            } else {
                this.sfx.wrong.currentTime = 0;
                this.sfx.wrong.play().catch(e => console.error("SFX ERROR (Wrong):", e));
            }
        }

        // CONFETTI for Musik & Gesundheit (if correct)
        if (this.lastAnswerCorrect) {
            const cat = this.currentQuestion.category.toLowerCase();
            if (cat.includes('musik') || cat.includes('gesundheit')) {
                confetti({
                    particleCount: 150,
                    spread: 70,
                    origin: { y: 0.6 }
                });
            }
        }

        // SHOW EXPLANATION
        // const explBox = document.querySelector('.explanation-box');
        // explBox.textContent = this.currentQuestion.explanation;
        // explBox.classList.remove('hidden');
        // explBox.classList.add('animate-scale-in');

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
            // this.teams[0].el.querySelector('.player-score').textContent = state.scores[0] + ' €'; // Old dock logic
            // this.teams[1].el.querySelector('.player-score').textContent = state.scores[1] + ' €';

            // Restore Scores
            this.teams[0].score = state.scores[0];
            this.teams[1].score = state.scores[1];

            // Generic update via UI function or direct element check
            const scoreEl0 = this.teams[0].el.querySelector('.player-score');
            const scoreEl1 = this.teams[1].el.querySelector('.player-score');
            if (scoreEl0) scoreEl0.textContent = state.scores[0] + ' €';
            if (scoreEl1) scoreEl1.textContent = state.scores[1] + ' €';

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
                    const gradient = (item.result === 'tobi') ? 'var(--card-purple-top), var(--card-purple-bottom)' : 'var(--card-purple-top), var(--card-purple-bottom)';
                    // Re-construct full background property to match live logic
                    const bgSize = (item.result === 'lurch') ? '76%, cover' : 'contain, cover';

                    const isTobi = item.result === 'tobi';
                    // Tobi = Gold (#ffaa00), Lurch = Blue (#0076bf / Neon Blue)
                    const color = isTobi ? '#ffaa00' : '#0099ff';

                    card.style.background = `url('assets/${item.result}.png'), linear-gradient(to bottom, var(--card-purple-top) 0%, var(--card-purple-bottom) 100%)`;
                    card.style.backgroundSize = bgSize;
                    card.style.backgroundPosition = 'center center, center';
                    card.style.backgroundRepeat = 'no-repeat, no-repeat';

                    card.style.borderColor = color;
                    card.style.boxShadow = `0 0 20px ${color}`;
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

            // Standardize sizing: Tobi contain, Lurch zoomed 110%
            const bgSize = (this.currentTurn === 1) ? '76%, cover, cover' : 'contain, cover, cover';

            card.style.backgroundSize = bgSize;
            card.style.backgroundPosition = 'center center, center, center';
            card.style.backgroundRepeat = 'no-repeat, no-repeat';

            // COLOR LOGIC
            // Team 0 (Tobi) = Gold/Orange
            // Team 1 (Lurch) = Blue
            const color = (this.currentTurn === 0) ? '#ffaa00' : '#0099ff';

            card.style.borderColor = color;
            card.style.boxShadow = `0 0 20px ${color}`;
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

        // REMOVE DIM
        this.elWall.classList.remove('dimmed');

        // RETURN ANIMATION
        if (this.elFlyingCard && this.activeCardOriginalRect) {
            const rect = this.activeCardOriginalRect;

            // 1. Flip Back to Front (optional, or stick to back?)
            // Let's flip back to indicate "closing"
            this.elFlyingCard.classList.remove('flipped');

            // 2. Move to original coords
            this.elFlyingCard.style.top = rect.top + 'px';
            this.elFlyingCard.style.left = rect.left + 'px';
            // 3. Wait for transition, then cleanup
            setTimeout(() => {
                if (this.elFlyingCard) this.elFlyingCard.remove();
                this.elFlyingCard = null;

                // Show original card again (now with "played" style)
                const card = document.getElementById(`cat-${this.selectedCategory}`);
                if (card) {
                    card.style.opacity = '1';
                    card.classList.add('played');
                }
            }, 1000);
        } else {
            // Fallback if animation missing
            const card = document.getElementById(`cat-${this.selectedCategory}`);
            if (card) card.style.opacity = '1';
        }

        // CHECK FOR FINALE
        const unplayed = document.querySelectorAll('.category-card:not(.played)');
        if (unplayed.length === 0) {
            console.log("ALL QUESTIONS PLAYED -> STARTING FINALE");
            setTimeout(() => this.startFinale(), 2000);
        }
    }

    /* FINALE LOGIC */
    startFinale() {
        console.log("--- STARTING FINALE ---");
        this.state = STATE.FINALE_BETTING;

        // UI Transition
        this.elWall.style.display = 'none';
        this.elQuestionOverlay.classList.add('hidden');
        this.elFinaleOverlay.classList.remove('hidden');
        this.elFinaleBetting.classList.remove('hidden');

        // Reset Finale State
        this.finaleBets = { 0: null, 1: null };
        this.finaleAnswers = { 0: null, 1: null };

        // Notify Players
        this.teams.forEach(team => {
            if (team.conn) {
                // Send specific score for validation
                team.conn.send({
                    type: 'STATE_CHANGE',
                    payload: 'FINALE_BETTING',
                    maxScore: team.score
                });
            }
        });
    }

    processFinaleBet(teamId, amount) {
        teamId = parseInt(teamId);
        console.log(`Team ${teamId} bets ${amount}`);
        this.finaleBets[teamId] = amount;

        // UI Update
        const statusEl = document.getElementById(`bet-status-${teamId}`);
        if (statusEl) {
            statusEl.classList.add('ready');
            statusEl.querySelector('.status-text').textContent = "EINSATZ STEHT";
        }

        // Check if both have bet
        if (this.finaleBets[0] !== null && this.finaleBets[1] !== null) {
            setTimeout(() => this.startFinaleQuestion(), 1500);
        }
    }

    startFinaleQuestion() {
        this.state = STATE.FINALE_QUESTION;
        this.elFinaleBetting.classList.add('hidden');
        this.elFinaleQuestion.classList.remove('hidden');

        // Hardcoded Master Question (Could be moved to JSON later)
        this.currentQuestion = {
            category: "MASTERFRAGE",
            question: "Welches dieser Tiere hat als einziges 3 Herzen?",
            options: { A: "Der Krake (Oktopus)", B: "Der Blauwal", C: "Die Giraffe" },
            correct: "A",
            explanation: "Kraken haben ein Hauptherz und zwei Kiemenherzen, die das Blut durch die Kiemen pumpen."
        };

        // Render Question
        this.elFinaleQuestion.querySelector('.master-question-text').textContent = this.currentQuestion.question;

        // Render Master Cards Structured
        const renderCard = (letter, text) => {
            const el = document.getElementById('final-ans-' + letter);
            el.querySelector('.answer-letter').textContent = letter;
            el.querySelector('.text').textContent = text;
            el.className = 'answer-card master-card'; // Reset classes
        };

        renderCard('A', this.currentQuestion.options.A);
        renderCard('B', this.currentQuestion.options.B);
        renderCard('C', this.currentQuestion.options.C);

        // Broadcast
        this.broadcast({ type: 'STATE_CHANGE', payload: 'FINALE_QUESTION' });
    }

    processFinaleAnswer(teamId, answer) {
        teamId = parseInt(teamId);
        if (this.finaleAnswers[teamId] !== null) return; // Already answered

        this.finaleAnswers[teamId] = answer;
        console.log(`Team ${teamId} answers ${answer}`);

        // Visual Feedback (e.g. highlight their side of screen or waiting msg)
        // For simplicity, just log it. Maybe turn status green if we had indicators.

        // Check if both answered
        if (this.finaleAnswers[0] !== null && this.finaleAnswers[1] !== null) {
            setTimeout(() => this.resolveFinale(), 1000);
        }
    }

    resolveFinale() {
        this.state = STATE.FINALE_REVEAL;

        // 1. Reveal Correct Answer
        const correct = this.currentQuestion.correct;
        const correctEl = document.getElementById('final-ans-' + correct);
        if (correctEl) correctEl.classList.add('correct', 'reveal-highlight');

        // Audio Feedback
        if (this.sfx && this.sfx.correct) {
            this.sfx.correct.play().catch(e => { });
        }

        // STEP 2: Show Calculation Screen after delay
        setTimeout(() => {
            this.showScoreCalculation();
        }, 3000); // 3s delay to see answer
    }

    showScoreCalculation() {
        this.elFinaleQuestion.classList.add('hidden');
        const elCalc = document.getElementById('finale-calc');
        if (elCalc) elCalc.classList.remove('hidden');

        // Prepare Data
        let winnerId = null;
        this.teams.forEach(team => {
            const bet = this.finaleBets[team.id];
            const ans = this.finaleAnswers[team.id];
            const isCorrect = (ans === this.currentQuestion.correct);
            const oldScore = team.score;

            // Calculate Change
            const change = isCorrect ? bet : -bet;
            const newScore = oldScore + change;

            // Update internal score
            team.score = newScore;

            // Pre-fill UI
            const scoreEl = document.getElementById(`old-score-${team.id}`);
            const changeEl = document.getElementById(`change-${team.id}`);

            scoreEl.textContent = oldScore + ' €';
            changeEl.textContent = (change >= 0 ? '+' : '') + change;
            changeEl.className = 'calc-change ' + (isCorrect ? 'win' : 'loss'); // Color code

            // ANIMATE
            setTimeout(() => {
                this.animateScoreGeneric(scoreEl, oldScore, newScore, 2000);
            }, 1000);
        });

        // Determine Winner for Next Step
        if (this.teams[0].score > this.teams[1].score) winnerId = 0;
        else if (this.teams[1].score > this.teams[0].score) winnerId = 1;
        else winnerId = 'draw';

        // STEP 3: Show Winner after calculation
        setTimeout(() => {
            this.showWinnerScreen(winnerId);
        }, 5000); // 1s wait + 2s anim + 2s pause
    }

    animateScoreGeneric(element, start, end, duration) {
        const startTime = performance.now();
        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const ease = 1 - Math.pow(1 - progress, 4); // EaseOutQuart

            const current = Math.floor(start + (end - start) * ease);
            element.textContent = current + ' €';

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                element.textContent = end + ' €';
            }
        };
        requestAnimationFrame(animate);
    }

    showWinnerScreen(winnerId) {
        const elCalc = document.getElementById('finale-calc');
        if (elCalc) elCalc.classList.add('hidden');

        this.elFinaleWinner.classList.remove('hidden');

        const winnerHeading = this.elFinaleWinner.querySelector('.winner-title');
        const winnerName = document.getElementById('winner-name');
        const winnerImg = document.getElementById('winner-img');
        const winnerScore = document.getElementById('winner-score');

        if (winnerId === 'draw') {
            winnerHeading.textContent = "UNENTSCHIEDEN!";
            winnerName.textContent = "BEIDE TEAMS";
            winnerImg.style.backgroundImage = "none";
            winnerScore.textContent = this.teams[0].score + ' €';
        } else {
            const wTeam = this.teams[winnerId];
            winnerHeading.textContent = "GEWINNER";
            winnerName.textContent = wTeam.name;
            winnerImg.style.backgroundImage = `url('assets/${winnerId === 0 ? 'tobi' : 'lurch'}.png')`;
            winnerScore.textContent = wTeam.score + ' €';

            // Colorize
            const color = (winnerId === 0) ? '#ffaa00' : '#0099ff';
            winnerName.style.color = color;
            winnerImg.style.borderColor = color;
            winnerImg.style.boxShadow = `0 0 100px ${color}`;

            // Confetti Explosion
            if (window.confetti) {
                confetti({ particleCount: 500, spread: 100, origin: { y: 0.6 } });
            }
        }

        // Broadcast End
        this.broadcast({ type: 'STATE_CHANGE', payload: 'FINALE_REVEAL' });
    }

    updateTurnUI() {
        this.teams.forEach(t => t.el.classList.remove('active-turn'));
        this.teams[this.currentTurn].el.classList.add('active-turn');

        // Note: Score updating is removed from here to not conflict with animateScore.
        // Scores are updated via animateScore (on win) or explicitly in loadGame.

        // Update Indicator (Optional secondary)
        const indicator = document.getElementById('turn-indicator');
        if (indicator) {
            indicator.textContent = (this.currentTurn === 0) ? "TOBIS RUNDE" : "LURCHS RUNDE";
            indicator.style.color = (this.currentTurn === 0) ? "var(--color-primary)" : "var(--color-secondary)";
        }
    }

    animateScore(element, start, end) {
        if (!element) {
            console.error("animateScore: Element not found");
            return;
        }

        console.log(`Animating score from ${start} to ${end}`);

        const duration = 2000; // 2 seconds
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Ease Out Quart
            const ease = 1 - Math.pow(1 - progress, 4);

            const current = Math.floor(start + (end - start) * ease);
            element.textContent = current + ' €';

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                element.textContent = end + ' €';
                element.classList.remove('pop-score');
                void element.offsetWidth;
                element.classList.add('pop-score');
            }
        };

        requestAnimationFrame(animate);
    }


    broadcast(msg) {
        // Send to all connected teams
        this.teams.forEach(t => {
            if (t.conn && t.conn.open) {
                t.conn.send(msg);
            }
        });
    }

    sendFullState(conn) {
        // 1. Current Game State
        conn.send({
            type: 'STATE_CHANGE',
            payload: this.state,
            turn: this.currentTurn
        });

        // 2. Scores
        // (Optional, if player ever needs them)

        // 3. Last Correctness (if in Reveal)
        if (this.state === STATE.REVEAL) {
            conn.send({ type: 'STATE_CHANGE', payload: 'REVEAL', correct: this.currentQuestion.correct });
        }
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
