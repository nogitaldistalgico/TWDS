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
    }

    initControls() {
        this.btnJoin.addEventListener('click', () => {
            // Visual feedback immediately
            this.btnJoin.textContent = "VERBINDE...";
            this.btnJoin.disabled = true;
            this.btnJoin.style.opacity = "0.7";

            // Connect
            this.connect('TOBIS-JGA');
        });

        ['A', 'B', 'C'].forEach(key => {
            this.btns[key].addEventListener('click', () => this.sendAnswer(key));
        });
    }

    initTeamSelection() {
        document.getElementById('select-team-0').addEventListener('click', () => this.selectTeam(0));
        document.getElementById('select-team-1').addEventListener('click', () => this.selectTeam(1));
    }

    connect(roomId) {
        this.statusText.textContent = "Suche Host...";

        // Timeout check if connection takes too long
        const connectionTimeout = setTimeout(() => {
            if (!this.isConnected) {
                alert("Verbindung dauert langsam... Prüfe Internet.");
                this.resetJoinButton();
            }
        }, 10000);

        this.peerManager.onOpen((id) => {
            console.log('Player ID:', id);
            this.peerManager.connect(roomId);
        });

        this.peerManager.onConnectionOpen(() => {
            clearTimeout(connectionTimeout);
            this.isConnected = true;
            console.log('Connection Established!');
            this.peerManager.send({ type: 'LOGIN' });
            // Show Team Selection instead of Controls immediately
            this.showTeamSelection();
        });

        this.peerManager.onError((err) => {
            clearTimeout(connectionTimeout);
            console.error("Player Error:", err);
            alert("Fehler: " + err.type);
            this.resetJoinButton();
        });

        this.peerManager.onData((data) => {
            this.handleGameData(data);
        });

        this.peerManager.init();
    }

    resetJoinButton() {
        this.btnJoin.textContent = "SPIEL BEITRETEN";
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

        // Send request to master (fire and forget)
        this.peerManager.send({ type: 'CLAIM_TEAM', payload: teamId });

        // Optimistic UI: Go straight to game
        console.log("Optimistic join for team " + teamId);
        this.showControls();
    }

    showControls() {
        this.elTeamSelect.classList.add('hidden');
        this.elControls.classList.remove('hidden');
        this.elControls.classList.add('animate-fade-in');
    }

    sendAnswer(choice) {
        if (this.locked) return;

        // Highlight local button
        Object.values(this.btns).forEach(b => {
            b.classList.remove('selected');
            b.disabled = true; // Disable interaction
            b.style.pointerEvents = 'none';
        });
        this.btns[choice].classList.add('selected');
        this.locked = true;
        this.lastChoice = choice; // Store choice for feedback

        this.peerManager.send({ type: 'ANSWER', payload: choice });
    }

    handleGameData(data) {
        if (data.type === 'STATE_CHANGE') {
            if (data.payload === 'WALL') {
                this.statusText.textContent = "Waiting for Host...";
                this.resetButtons();
            } else if (data.payload === 'QUESTION') {
                this.statusText.textContent = "Make your choice!";
            } else if (data.payload === 'REVEAL') {
                this.statusText.textContent = "Check the screen!";

                // Show feedback
                const correct = data.correct;
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
            // Success! Move to controls
            this.showControls();
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

    resetButtons() {
        this.locked = false;
        this.lastChoice = null;
        Object.values(this.btns).forEach(b => {
            b.classList.remove('selected', 'correct', 'wrong');
            b.disabled = false;
            b.style.pointerEvents = 'auto';
        });
    }
}

// Start Player
document.addEventListener('DOMContentLoaded', () => {
    window.player = new PlayerController();
});
