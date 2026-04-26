// Mobile Debug Logger
const debugEl = document.getElementById('debug-console');
if (location.search.includes('debug=true')) {
    debugEl.style.display = 'block';
    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args) => {
        debugEl.innerHTML += `[LOG] ${args.join(' ')}<br>`;
        debugEl.scrollTop = debugEl.scrollHeight;
        originalLog.apply(console, args);
    };

    console.error = (...args) => {
        debugEl.innerHTML += `<span style="color:red">[ERR] ${args.join(' ')}</span><br>`;
        debugEl.scrollTop = debugEl.scrollHeight;
        originalError.apply(console, args);
    };

    window.onerror = (msg, url, line) => {
        console.error(`Global: ${msg} @ ${line}`);
    };
}

class PlayerController {
    constructor() {
        this.peerManager = new PeerManager(false); // Client mode
        this.isConnected = false;
        this.myScore = 0;
        this.myTeamId = null;
        this.lastChoice = null;
        this.canAnswer = false;
        this.betEventsBound = false;
        this._joinStarted = false; // Guard against double startJoinProcess

        // DOM Elements
        this.elLogin = document.getElementById('login-screen');
        this.elTeamSelect = document.getElementById('team-select-screen');
        this.statusMsg = document.getElementById('team-status-msg');
        this.connectionMsg = document.getElementById('connection-status-msg');

        // Restore missing elements
        this.elControls = document.getElementById('controls-screen');
        this.btnJoin = document.getElementById('btn-join');
        this.statusText = document.getElementById('status-text');

        this.btns = {
            A: document.getElementById('btn-A'),
            B: document.getElementById('btn-B'),
            C: document.getElementById('btn-C')
        };

        this.initControls();
        this.initTeamSelection();
        this.initUtilities();
        this.initPersistence();
    }

    initPersistence() {
        const savedTeam = localStorage.getItem('wwds_player_team');
        if (savedTeam !== null) {
            console.log("Found saved session for team: " + savedTeam);
            this.myTeamId = parseInt(savedTeam);
            // Don't call startJoinProcess again – initControls already did it
            // The auto-claim happens in onConnectionOpen when saved team is detected
        }
    }

    initUtilities() {
        // Wake Lock
        this.wakeLock = null;
        document.addEventListener('visibilitychange', async () => {
            if (this.wakeLock !== null && document.visibilityState === 'visible') {
                this.requestWakeLock();
            }
        });
    }

    async requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake Lock is active');
                this.wakeLock.addEventListener('release', () => {
                    console.log('Wake Lock released');
                });
            }
        } catch (err) {
            console.error(`${err.name}, ${err.message}`);
        }
    }

    initControls() {
        // Auto-Join once on init
        this.startJoinProcess();

        // Retry button (only visible if auto-join fails)
        this.btnJoin.addEventListener('click', () => {
            this._joinStarted = false; // Allow re-join
            this.startJoinProcess();
        });

        ['A', 'B', 'C'].forEach(key => {
            this.btns[key].addEventListener('click', () => this.sendAnswer(key));
        });
    }

    startJoinProcess() {
        // Bug #11 fix: Guard against double invocation
        if (this._joinStarted) {
            console.log('[Player] Join already started, skipping duplicate call');
            return;
        }
        this._joinStarted = true;

        // Visual feedback immediately
        this.showScreen('login');
        this.btnJoin.textContent = "VERBINDE...";
        this.btnJoin.disabled = true;
        this.btnJoin.style.opacity = "0.7";
        if (this.connectionMsg) this.connectionMsg.textContent = "Verbinde zum Studio...";

        // Connect
        this.connect('TOBIS-JGA');
        this.requestWakeLock();
    }

    initTeamSelection() {
        document.getElementById('select-team-0').addEventListener('click', () => this.selectTeam(0));
        document.getElementById('select-team-1').addEventListener('click', () => this.selectTeam(1));
    }

    connect(roomId) {
        if (this.connectionMsg) this.connectionMsg.textContent = "Suche Host...";

        // Retry logic
        const maxRetries = 5;
        let attempt = 0;

        const tryConnect = () => {
            // If peer is not ready, wait
            if (!this.peerManager.peer || !this.peerManager.peer.open) {
                console.log("Peer not ready, waiting...");
                setTimeout(tryConnect, 500);
                return;
            }

            console.log(`Attempting to connect to ${roomId} (Attempt ${attempt + 1})`);
            this.peerManager.connect(roomId);
        };

        this.peerManager.onOpen((id) => {
            console.log('Player ID:', id);
            if (this.connectionMsg) this.connectionMsg.textContent = `Suche Studio...`;
            tryConnect();
        });

        this.peerManager.onConnectionOpen(() => {
            attempt = 0; // Reset retries on success
            this.isConnected = true;
            this.updateStatusIndicator('connected');
            console.log('Connection Established!');

            // PULL-BASED SYNC: Immediately ask for state
            this.peerManager.send({ type: 'REQUEST_STATE' });
            this.peerManager.send({ type: 'LOGIN' });

            // AUTO-LOGIN Logic
            const savedTeam = localStorage.getItem('wwds_player_team');
            if (savedTeam !== null) {
                console.log("Auto-claiming team: " + savedTeam);
                this.selectTeam(parseInt(savedTeam));
            } else {
                // UI Transition
                this.showTeamSelection();
            }
        });

        this.peerManager.onError((err) => {
            console.error("Player Error:", err);

            if (err.type === 'peer-unavailable') {
                // Host ID not found yet? Retry.
                if (attempt < maxRetries) {
                    attempt++;
                    if (this.connectionMsg) this.connectionMsg.textContent = `Suche Studio... (${attempt})`;
                    setTimeout(tryConnect, 2000); // Retry after 2s
                } else {
                    // Only show manual Retry button if auto-fail completely
                    this.showManualConnect("Studio nicht gefunden. Ist der Master an?");
                }
            } else if (err.type === 'disconnected') {
                if (this.statusText) {
                    this.statusText.textContent = "Verbindung verloren... Reconnect...";
                    this.statusText.style.color = "red";
                }
                // Auto-retry indefinitely for disconnects
                setTimeout(tryConnect, 2000);
            } else if (err.type === 'warning-ssl') {
                // Non-fatal, just log
                console.warn("SSL Warning (non-fatal):", err.message);
            } else {
                this.showManualConnect("Verbindungsfehler: " + err.type);
            }
        });

        this.peerManager.onData((data) => {
            this.handleGameData(data);
        });

        this.peerManager.onHeartbeatLost(() => {
            console.warn("Lost Heartbeat - Reconnecting...");
            this.updateStatusIndicator('disconnected');
            if (this.statusText) {
                this.statusText.textContent = "Verbindung verloren...";
                this.statusText.style.color = "red";
            }
            this.isConnected = false;
            // Reconnect is handled by the PeerManager's conn.close -> auto-reconnect
        });

        // Init peer (only once!)
        this.peerManager.init();
    }

    showManualConnect(msg) {
        this.showScreen('login');
        if (this.connectionMsg) this.connectionMsg.textContent = msg;
        this.btnJoin.textContent = "NEU VERBINDEN";
        this.btnJoin.disabled = false;
        this.btnJoin.style.opacity = "1";
        this.btnJoin.style.display = "block";
    }

    // === Centralized Screen Management (Bug #8 fix) ===
    showScreen(screen) {
        // Hide all screens
        const screens = [this.elLogin, this.elTeamSelect, this.elControls, document.getElementById('betting-screen')];
        screens.forEach(el => {
            if (el) {
                el.classList.add('hidden');
                el.style.display = 'none';
            }
        });

        // Show requested screen
        switch (screen) {
            case 'login':
                this.elLogin.classList.remove('hidden');
                this.elLogin.style.display = 'flex';
                break;
            case 'team-select':
                this.elTeamSelect.classList.remove('hidden');
                this.elTeamSelect.style.display = 'grid';
                this.elTeamSelect.classList.add('animate-fade-in');
                break;
            case 'controls':
                this.elControls.classList.remove('hidden');
                this.elControls.style.display = 'flex';
                this.elControls.classList.add('animate-fade-in');
                // Ensure body doesn't scroll in controls mode
                document.body.classList.remove('betting-active');
                break;
            case 'betting':
                const betScreen = document.getElementById('betting-screen');
                if (betScreen) {
                    betScreen.classList.remove('hidden');
                    betScreen.style.display = 'flex';
                    // Allow scrolling for betting screen on mobile
                    document.body.classList.add('betting-active');
                }
                break;
        }
    }

    showTeamSelection() {
        console.log("UI: Showing Team Selection");
        this.showScreen('team-select');
    }

    selectTeam(teamId) {
        console.log(`UI: Selected Team ${teamId}`);
        this.myTeamId = teamId;
        localStorage.setItem('wwds_player_team', teamId);

        // Send request to master
        this.peerManager.send({ type: 'CLAIM_TEAM', payload: teamId });

        // Optimistic UI: Go straight to game
        console.log("Optimistic join for team " + teamId);
        this.showControls();
    }

    showControls() {
        this.showScreen('controls');
    }

    updateStatusIndicator(status) {
        let dot = document.getElementById('status-dot');
        if (!dot) {
            const header = document.querySelector('.status-header');
            if (header) {
                dot = document.createElement('span');
                dot.id = 'status-dot';
                dot.style.display = 'inline-block';
                dot.style.width = '10px';
                dot.style.height = '10px';
                dot.style.borderRadius = '50%';
                dot.style.marginRight = '8px';
                header.prepend(dot);
            }
        }

        if (dot) {
            if (status === 'connected') {
                dot.style.backgroundColor = '#0f0';
                dot.style.boxShadow = '0 0 10px #0f0';
            } else if (status === 'disconnected') {
                dot.style.backgroundColor = '#f00';
                dot.style.boxShadow = '0 0 10px #f00';
            } else {
                dot.style.backgroundColor = '#fa0';
            }
        }
    }

    sendAnswer(choice) {
        if (!this.canAnswer) return;

        // Haptic Feedback
        if (navigator.vibrate) {
            navigator.vibrate(50);
        }

        // Highlight local button
        Object.values(this.btns).forEach(b => {
            b.classList.remove('selected');
            b.disabled = true;
            b.style.pointerEvents = 'none';
        });

        this.btns[choice].classList.add('selected');

        // Lock immediately
        this.setInteraction(false);
        this.btns[choice].style.opacity = '1';
        this.btns[choice].style.filter = 'none';

        this.lastChoice = choice;

        this.peerManager.send({ type: 'ANSWER', payload: choice });
    }

    handleGameData(data) {
        if (data.type === 'STATE_CHANGE') {
            if (data.payload === 'WALL') {
                if (this.statusText) this.statusText.textContent = "Warte auf nächste Frage...";
                this.resetVisuals();
                this.setInteraction(false);
                this.lastChoice = null;

            } else if (data.payload === 'QUESTION') {
                this.resetVisuals();

                // Compare loose (string vs int)
                if (data.turn == this.myTeamId) {
                    if (this.statusText) {
                        this.statusText.textContent = "DU BIST DRAN!";
                        this.statusText.style.color = "var(--neon-green, #0f0)";
                    }
                    this.setInteraction(true);
                    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
                } else {
                    if (this.statusText) {
                        this.statusText.textContent = "Du bist nicht dran...";
                        this.statusText.style.color = "#aaa";
                    }
                    this.setInteraction(false);
                }

            } else if (data.payload === 'REVEAL') {
                if (this.statusText) this.statusText.textContent = "Check the screen!";
                this.setInteraction(false);

                const correct = data.correct;
                Object.values(this.btns).forEach(b => b.style.opacity = '1');

                if (this.lastChoice === correct) {
                    this.btns[this.lastChoice].classList.add('correct');
                    this.btns[this.lastChoice].style.filter = 'none';
                    if (this.statusText) this.statusText.textContent = "RICHTIG! 🎉";
                } else if (this.lastChoice) {
                    this.btns[this.lastChoice].classList.add('wrong');
                    this.btns[this.lastChoice].style.filter = 'none';
                    if (this.statusText) this.statusText.textContent = "LEIDER FALSCH ❌";
                }

            } else if (data.payload === 'FINALE_BETTING') {
                // Switch to betting screen
                this.showBettingScreen(data.maxScore);

            } else if (data.payload === 'FINALE_QUESTION') {
                // Switch back to controls
                this.showControls();
                if (this.statusText) this.statusText.textContent = "MASTERFRAGE!";
                this.setInteraction(true);
                this.resetVisuals();
            }

        } else if (data.type === 'TEAM_CONFIRMED') {
            console.log("Team Confirmed! Switching to Controls.");
            this.showControls();
            this.setInteraction(false); // Default to locked until SYNC arrives

        } else if (data.type === 'TEAM_TAKEN') {
            if (this.statusMsg) this.statusMsg.textContent = "Team already taken! Choose another.";
            const el = document.getElementById(`select-team-${data.payload}`);
            if (el) el.classList.add('taken');
            setTimeout(() => {
                document.querySelectorAll('.team-card').forEach(el => el.classList.remove('selected'));
            }, 500);

        } else if (data.type === 'ERROR') {
            // Don't use alert – it blocks the UI on mobile
            console.warn("Server Error:", data.message);
            if (this.statusText) {
                this.statusText.textContent = data.message;
                this.statusText.style.color = "#ff6b6b";
                setTimeout(() => {
                    if (this.statusText) this.statusText.style.color = "";
                }, 3000);
            }

        } else if (data.type === 'SCORE_UPDATE') {
            // Score sync from master
            this.myScore = data.payload;
            const scoreDisplay = document.getElementById('my-score-display');
            if (scoreDisplay) scoreDisplay.textContent = this.myScore + ' €';
            console.log(`[Score] Updated to ${this.myScore}`);
        }
    }

    resetVisuals() {
        Object.values(this.btns).forEach(b => {
            b.classList.remove('selected', 'correct', 'wrong');
        });
    }

    setInteraction(active) {
        this.canAnswer = active;
        Object.values(this.btns).forEach(b => {
            if (active) {
                b.disabled = false;
                b.style.pointerEvents = 'auto';
                b.style.opacity = '1';
                b.style.filter = 'none';
            } else {
                b.disabled = true;
                b.style.pointerEvents = 'none';
                b.style.opacity = '0.5';
                b.style.filter = 'grayscale(1)';
            }
        });
    }

    // FINALE HELPERS
    showBettingScreen(maxScore) {
        this.showScreen('betting');

        const betScreen = document.getElementById('betting-screen');
        if (!betScreen) return;

        // RESET UI STATE (Fix for reconnects)
        const betControls = betScreen.querySelector('.bet-controls');
        const successMsg = document.getElementById('bet-success-msg');
        const errorMsg = document.getElementById('bet-error-msg');

        if (betControls) betControls.style.display = 'flex';
        if (successMsg) {
            successMsg.classList.add('hidden');
            successMsg.style.display = 'none';
        }
        if (errorMsg) errorMsg.style.display = 'none';

        // Use maxScore from server, fallback to local score
        if (maxScore !== undefined && maxScore !== null) {
            this.myScore = maxScore;
        }

        const scoreDisplay = document.getElementById('my-score-display');
        if (scoreDisplay) scoreDisplay.textContent = this.myScore + ' €';

        const input = document.getElementById('bet-amount');
        if (input) {
            input.max = this.myScore;
            input.value = '';
            input.disabled = false;

            // Delay focus to avoid iOS keyboard issues
            setTimeout(() => {
                try { input.focus(); } catch (e) { /* ignore */ }
            }, 300);
        }

        // Bind events if not already
        if (!this.betEventsBound) {
            const btnAllIn = document.getElementById('btn-all-in');
            const btnSubmit = document.getElementById('btn-submit-bet');

            if (btnAllIn) {
                btnAllIn.addEventListener('click', () => {
                    if (input) input.value = this.myScore;
                });
            }

            if (btnSubmit) {
                btnSubmit.addEventListener('click', () => {
                    if (!input) return;

                    let val = parseInt(input.value);
                    if (input.value === "") val = NaN;

                    if (isNaN(val) || val < 0 || val > this.myScore) {
                        const err = document.getElementById('bet-error-msg');
                        if (err) {
                            err.style.display = 'block';
                            err.textContent = (val > this.myScore) ? "Nicht genug Guthaben!" : "Ungültiger Betrag!";
                            setTimeout(() => err.style.display = 'none', 3000);
                        }
                        // Shake animation
                        if (input) {
                            input.classList.add('shake');
                            setTimeout(() => input.classList.remove('shake'), 500);
                        }
                    } else {
                        // Send Bet
                        this.peerManager.send({ type: 'BET', payload: val });

                        // Show Success State
                        if (betControls) betControls.style.display = 'none';
                        if (successMsg) {
                            successMsg.classList.remove('hidden');
                            successMsg.style.display = 'flex';
                        }

                        // Disable Input
                        input.disabled = true;

                        // Remove keyboard focus on mobile
                        input.blur();

                        // Remove betting-active to restore overflow behavior
                        document.body.classList.remove('betting-active');
                    }
                });
            }
            this.betEventsBound = true;
        }
    }
}

// Start Player
document.addEventListener('DOMContentLoaded', () => {
    window.player = new PlayerController();
});
