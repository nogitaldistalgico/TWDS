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
            onOpen: () => { },
            onData: () => { },
            onClose: () => { },
            onConnectionOpen: () => { },
            onError: () => { }
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
            if (this.callbacks.onConnection) {
                this.callbacks.onConnection(conn);
            }
            // Always handle basic data updates
            this.handleConnection(conn);
        });

        this.peer.on('error', (err) => {
            console.error(err);
            if (this.callbacks.onError) {
                this.callbacks.onError(err);
            } else {
                alert('Connection Error: ' + err.type);
            }
        });
    }

    handleConnection(conn) {
        this.conn = conn;

        conn.on('open', () => {
            console.log('Connected!');
            this.startHeartbeat();
            if (this.callbacks.onConnectionOpen) this.callbacks.onConnectionOpen();
        });

        conn.on('data', (data) => {
            // Heartbeat check
            if (data.type === 'PING') {
                // Respond with PONG
                this.send({ type: 'PONG' });
                return;
            }
            if (data.type === 'PONG') {
                // Connection is alive
                return;
            }

            console.log('Received:', data);
            this.callbacks.onData(data);
        });

        conn.on('close', () => {
            console.log('Connection closed');
            this.stopHeartbeat();
            this.callbacks.onClose();

            // Auto Reconnect implementation for Client (not host)
            if (!this.isHost && !this.intentionalClose) {
                console.log("Unexpected disconnect. Attempting reconnect...");
                setTimeout(() => {
                    this.reconnect();
                }, 2000);
            }
        });

        conn.on('error', (err) => {
            console.error("Connection Error:", err);
            this.stopHeartbeat();
        });
    }

    startHeartbeat() {
        this.stopHeartbeat();
        // Send a PING every 3 seconds to keep connection alive
        this.heartbeatInterval = setInterval(() => {
            if (this.conn && this.conn.open) {
                this.conn.send({ type: 'PING' });
            }
        }, 3000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    reconnect() {
        if (this.lastHostId) {
            console.log("Reconnecting to " + this.lastHostId);
            this.connect(this.lastHostId);
        }
    }

    send(data) {
        if (this.conn && this.conn.open) {
            this.conn.send(data);
        } else {
            console.warn('Connection not open, cannot send data');
            // Don't alert on heartbeat fail, just warn
            if (data.type !== 'PING' && data.type !== 'PONG') {
                // Trigger callback so UI can show "Offline"
                if (this.callbacks.onError) this.callbacks.onError({ type: 'disconnected' });
            }
        }
    }

    // ... (rest of class)

    connect(hostId) {
        if (this.isHost) return;
        this.lastHostId = hostId; // Save for reconnect
        this.intentionalClose = false;

        console.log('Connecting to ' + hostId);
        // connection options for reliability
        this.conn = this.peer.connect(hostId, {
            reliable: true,
            serialization: 'json'
        });
        this.handleConnection(this.conn);
    }
}
