/* PeerJS Logic Wrapper */

class PeerManager {
    constructor(isHost = false) {
        this.peer = null;
        this.conn = null;
        this.isHost = isHost;
        this.callbacks = {
            onOpen: () => { },
            onData: () => { },
            onClose: () => { },
            onConnectionOpen: () => { }
        };
    }

    init(id = null) {
        // Use a random ID if none provided (for Host)
        // Note: In a real PeerJS app, we might check for existing IDs or handle collisions.
        // For simplicity/demo: Host generates a random 4-char ID.

        const peerId = id || (this.isHost ? this.generateRoomId() : null);

        this.peer = new Peer(peerId, {
            debug: 2
        });

        this.peer.on('open', (id) => {
            console.log('My peer ID is: ' + id);
            this.callbacks.onOpen(id);
        });

        this.peer.on('connection', (conn) => {
            if (this.isHost) {
                // Host accepts connections
                this.handleConnection(conn);
            } else {
                // Client usually initiates, but if host connects back (unlikely in this flow), handle it.
                this.handleConnection(conn);
            }
        });

        this.peer.on('error', (err) => {
            console.error(err);
            alert('Connection Error: ' + err.type);
        });
    }

    connect(hostId) {
        if (this.isHost) return;

        console.log('Connecting to ' + hostId);
        this.conn = this.peer.connect(hostId);
        this.handleConnection(this.conn);
    }

    handleConnection(conn) {
        this.conn = conn; // Simple 1:1 for now, or Host stores array of conns

        conn.on('open', () => {
            console.log('Connected!');
            if (this.callbacks.onConnectionOpen) this.callbacks.onConnectionOpen();
            // Send initial ping or handshake if needed
        });

        conn.on('data', (data) => {
            console.log('Received:', data);
            this.callbacks.onData(data);
        });

        conn.on('close', () => {
            console.log('Connection closed');
            this.callbacks.onClose();
        });
    }

    send(data) {
        if (this.conn && this.conn.open) {
            this.conn.send(data);
        } else {
            console.warn('Connection not open, cannot send data');
            alert('Not connected to Host!');
        }
    }

    generateRoomId() {
        // Generate a simple 4 letter code
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 1, 0 to avoid confusion
        let result = '';
        for (let i = 0; i < 4; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // Setters for callbacks
    onOpen(cb) { this.callbacks.onOpen = cb; }
    onData(cb) { this.callbacks.onData = cb; }
    onClose(cb) { this.callbacks.onClose = cb; }
    onConnectionOpen(cb) { this.callbacks.onConnectionOpen = cb; }
}
