/* Player Logic */

class PlayerController {
    constructor() {
        this.peerManager = new PeerManager(false); // Client mode
        this.isConnected = false;

        // DOM Elements
        this.elLogin = document.getElementById('login-screen');
        this.elControls = document.getElementById('controls-screen');
        this.inputRoomId = document.getElementById('room-id-input');
        this.btnJoin = document.getElementById('btn-join');
        this.statusText = document.getElementById('status-text');

        this.btns = {
            A: document.getElementById('btn-A'),
            B: document.getElementById('btn-B'),
            C: document.getElementById('btn-C')
        };

        this.initControls();
    }

    initControls() {
        this.btnJoin.addEventListener('click', () => {
            const roomId = this.inputRoomId.value.toUpperCase();
            if (roomId.length >= 4) {
                this.connect(roomId);
            } else {
                alert('Please enter a valid Room ID');
            }
        });

        ['A', 'B', 'C'].forEach(key => {
            this.btns[key].addEventListener('click', () => this.sendAnswer(key));
        });
    }

    connect(roomId) {
        this.peerManager.onOpen((id) => {
            console.log('Player ID:', id);
            this.peerManager.connect(roomId);
        });

        this.peerManager.onData((data) => {
            this.handleGameData(data);
        });

        this.peerManager.init(); // Just init peer, then connect via callback or immediately after?
        // Actually PeerJS client needs to wait for its own ID before connecting to another.
        // The onOpen above handles that.

        // Wait for connection confirmation to host could be handled in 'onData' or 'conn.on(open)' in manager
        // We'll simulate successful UI switch for now, but ideally we wait for handshake.
        setTimeout(() => {
            this.peerManager.send({ type: 'LOGIN' });
            this.showControls();
        }, 1500); // Give it a sec to establish
    }

    showControls() {
        this.elLogin.classList.add('hidden');
        this.elControls.classList.remove('hidden');
        this.elControls.classList.add('animate-fade-in');
    }

    sendAnswer(choice) {
        // Highlight local button
        Object.values(this.btns).forEach(b => b.classList.remove('selected'));
        this.btns[choice].classList.add('selected');

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
        }
    }

    resetButtons() {
        Object.values(this.btns).forEach(b => b.classList.remove('selected'));
    }
}

// Start Player
document.addEventListener('DOMContentLoaded', () => {
    window.player = new PlayerController();
});
