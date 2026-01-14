/* Player Logic */

class PlayerController {
    constructor() {
        this.peerManager = new PeerManager(false); // Client mode
        this.isConnected = false;

        // DOM Elements
        this.elLogin = document.getElementById('login-screen');
        this.elTeamSelect = document.getElementById('team-select-screen');
        this.statusMsg = document.getElementById('team-status-msg');

        this.initControls();
        this.initTeamSelection();
    }

    initControls() {
        this.btnJoin.addEventListener('click', () => {
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
        this.statusText.textContent = "Connecting to " + roomId + "...";

        this.peerManager.onOpen((id) => {
            console.log('Player ID:', id);
            this.peerManager.connect(roomId);
        });

        this.peerManager.onConnectionOpen(() => {
            console.log('Connection Established!');
            this.peerManager.send({ type: 'LOGIN' });
            // Show Team Selection instead of Controls immediately
            this.showTeamSelection();
        });

        this.peerManager.onData((data) => {
            this.handleGameData(data);
        });

        this.peerManager.init();
    }

    showTeamSelection() {
        this.elLogin.classList.add('hidden');
        this.elTeamSelect.classList.remove('hidden');
        this.elTeamSelect.classList.add('animate-fade-in');
    }

    selectTeam(teamId) {
        // Send request to master
        this.peerManager.send({ type: 'CLAIM_TEAM', payload: teamId });
        // Visual feedback
        document.querySelectorAll('.team-card').forEach(el => el.classList.remove('selected'));
        document.getElementById(`select-team-${teamId}`).classList.add('selected');
        this.statusMsg.textContent = "Requesting team...";
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
        }
    }

    resetButtons() {
        this.locked = false;
        Object.values(this.btns).forEach(b => {
            b.classList.remove('selected');
            b.disabled = false;
            b.style.pointerEvents = 'auto';
        });
    }
}

// Start Player
document.addEventListener('DOMContentLoaded', () => {
    window.player = new PlayerController();
});
