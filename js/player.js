/* Player Logic */
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

        // DOM Elements
        this.elLogin = document.getElementById('login-screen');
        this.elTeamSelect = document.getElementById('team-select-screen');
        this.statusMsg = document.getElementById('team-status-msg');

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
        if (savedTeam) {
            console.log("Found saved session for team: " + savedTeam);
            // Auto Connect
            this.startJoinProcess();
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
        // Auto-Join immediately on init (or separate initConnection)
        this.startJoinProcess();

        // Retry button (only visible if auto-join fails)
        this.btnJoin.addEventListener('click', () => {
            this.startJoinProcess();
        });

        ['A', 'B', 'C'].forEach(key => {
            this.btns[key].addEventListener('click', () => this.sendAnswer(key));
        });
    }

    startJoinProcess() {
        // Visual feedback immediately
        this.elLogin.classList.remove('hidden'); // Show loading screen initially
        this.btnJoin.textContent = "VERBINDE...";
        this.btnJoin.disabled = true;
        this.btnJoin.style.opacity = "0.7";

        // Connect
        this.connect('TOBIS-JGA');
        this.requestWakeLock();
    }

    initTeamSelection() {
        document.getElementById('select-team-0').addEventListener('click', () => this.selectTeam(0));
        document.getElementById('select-team-1').addEventListener('click', () => this.selectTeam(1));
    }

    connect(roomId) {
        this.statusText.textContent = "Suche Host...";
        this.statusText.style.color = "var(--color-text-muted)";

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
            this.statusMsg.innerHTML = `Player ID: ${id}<br>Suche Studio...`;
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
            if (savedTeam) {
                console.log("Auto-claiming team: " + savedTeam);
                // Optimistic UI for re-joiners
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
                    this.statusMsg.textContent = `Suche Studio... (${attempt})`;
                    setTimeout(tryConnect, 2000); // Retry after 2s
                } else {
                    // Only show manual Retry button if auto-fail completely
                    this.showManualConnect("Studio nicht gefunden. Ist der Master an?");
                }
            } else if (err.type === 'disconnected') {
                this.statusText.textContent = "Verbindung verloren... Reconnect...";
                this.statusText.style.color = "red";
                // Auto-retry indefinitely for disconnects
                setTimeout(tryConnect, 2000);
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
            this.statusText.textContent = "Verbindung verloren...";
            this.statusText.style.color = "red";
            this.isConnected = false;
            // Immediate retry
            tryConnect();
        });

        this.peerManager.init();
    }

    showManualConnect(msg) {
        this.elLogin.classList.remove('hidden');
        this.elLogin.querySelector('h2').textContent = "Verbindung";
        this.statusMsg.textContent = msg;
        this.btnJoin.textContent = "NEU VERBINDEN";
        this.btnJoin.disabled = false;
        this.btnJoin.style.opacity = "1";
    }

    showTeamSelection() {
        this.elLogin.classList.add('hidden');
        this.elTeamSelect.classList.remove('hidden');
        this.elTeamSelect.classList.add('animate-fade-in');
    }

    selectTeam(teamId) {
        // Store locally
        this.myTeamId = teamId;
        localStorage.setItem('wwds_player_team', teamId);

        // Send request to master (fire and forget)
        this.peerManager.send({ type: 'CLAIM_TEAM', payload: teamId });

        // Optimistic UI: Go straight to game
        console.log("Optimistic join for team " + teamId);
        this.showControls();
    }

    showControls() {
        this.elTeamSelect.classList.add('hidden');
        this.elTeamSelect.style.display = 'none'; // Ensure it hides

        this.elControls.classList.remove('hidden');
        this.elControls.style.display = 'flex'; // Override inline none
        this.elControls.classList.add('animate-fade-in');
    }

    updateStatusIndicator(status) {
        // Simple dot in the header
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
                dot.style.backgroundColor = '#fa0'; // Connecting
            }
        }
    }

    sendAnswer(choice) {
        if (!this.canAnswer) return;

        // Haptic Feedback (Vibrate) - Subtle tick (50ms)
        if (navigator.vibrate) {
            navigator.vibrate(50);
        }

        // Highlight local button
        Object.values(this.btns).forEach(b => {
            b.classList.remove('selected');
            b.disabled = true; // Disable interaction
            b.style.pointerEvents = 'none';
        });

        this.btns[choice].classList.add('selected');

        // Lock immediately to prevent spamming
        this.setInteraction(false);
        // But keep selected one fully opaque/visible
        this.btns[choice].style.opacity = '1';
        this.btns[choice].style.filter = 'none';

        this.lastChoice = choice; // Store choice for feedback

        this.peerManager.send({ type: 'ANSWER', payload: choice });
    }

    handleGameData(data) {
        if (data.type === 'STATE_CHANGE') {
            if (data.payload === 'WALL') {
                this.statusText.textContent = "Waiting for Host...";
                // RESET & LOCK
                this.resetVisuals();
                this.setInteraction(false);
                this.lastChoice = null;

            } else if (data.payload === 'QUESTION') {
                this.statusText.textContent = "Make your choice!";
                // UNLOCK
                this.resetVisuals();
                this.setInteraction(true);

            } else if (data.payload === 'REVEAL') {
                this.statusText.textContent = "Check the screen!";
                // LOCK
                this.setInteraction(false);

                // Show feedback (Visuals only, no interaction)
                const correct = data.correct;
                // Re-enable opacity for clarity, but keep disabled
                Object.values(this.btns).forEach(b => b.style.opacity = '1');

                if (this.lastChoice === correct) {
                    // Correct!
                    this.btns[this.lastChoice].classList.add('correct');
                    this.statusText.textContent = "RICHTIG! 🎉";
                } else if (this.lastChoice) {
                    // Wrong
                    this.btns[this.lastChoice].classList.add('wrong');
                    this.statusText.textContent = "LEIDER FALSCH ❌";
                }
            }
        } else if (data.type === 'TEAM_CONFIRMED') {
            console.log("Team Confirmed! Switching to Controls.");
            this.statusMsg.textContent = "Verbunden! Warte auf Start...";
            // Success! Move to controls
            this.showControls();

            // Force interface update based on potential missed state
            this.setInteraction(false); // Default to locked until SYNC arrives

        } else if (data.type === 'TEAM_TAKEN') {
            this.statusMsg.textContent = "Team already taken! Choose another.";
            document.getElementById(`select-team-${data.payload}`).classList.add('taken');
            setTimeout(() => {
                document.querySelectorAll('.team-card').forEach(el => el.classList.remove('selected'));
            }, 500);
        } else if (data.type === 'ERROR') {
            alert(data.message);
            this.resetButtons();
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
}

// Start Player
document.addEventListener('DOMContentLoaded', () => {
    window.player = new PlayerController();
});
