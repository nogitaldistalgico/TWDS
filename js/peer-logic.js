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
            onError: () => { },
            onHeartbeatLost: () => { } // New hook
        };
    }

    init(id = null) {
        // Use a random ID if none provided (for Host)
        const peerId = id || (this.isHost ? this.generateRoomId() : null);

        // iOS / Safari Https Check
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && !location.hostname.startsWith('127.0')) {
            console.warn("⚠️ [P2P] WebRTC on iOS/Safari requires HTTPS! Connection might fail.");
            if (this.callbacks.onError) this.callbacks.onError({ type: 'warning-ssl', message: 'iOS requires HTTPS for WebRTC.' });
        }

        this.peer = new Peer(peerId, {
            debug: 2,
            secure: true, // Force secure connections if possible (PeerJS Server defaults)
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            }
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
            console.error("PeerJS Error:", err);
            // More granular error handling
            if (err.type === 'browser-incompatible') {
                alert("Browser not compatible with WebRTC (try Chrome or Safari 11+)");
            }

            if (this.callbacks.onError) {
                this.callbacks.onError(err);
            } else {
                // Fallback alert
                console.warn('Connection Error logged silently:', err.type);
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
            this.recordHeartbeat(); // Alive!

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
        this.lastPingTime = Date.now();

        // Check loop
        this.heartbeatInterval = setInterval(() => {
            if (!this.conn || !this.conn.open) return;

            // 1. Send Ping
            this.conn.send({ type: 'PING' });

            // 2. Check Timeout (Host & Client)
            // If we haven't received a message (or PONG) in 5000ms, assume dead
            if (Date.now() - this.lastPingTime > 5000) {
                console.warn("Heartbeat lost/timeout!");
                if (this.callbacks.onHeartbeatLost) this.callbacks.onHeartbeatLost();

                // Force shutdown to trigger clean reconnect
                this.stopHeartbeat();
                this.conn.close();
            }
        }, 2000); // Ping every 2s
    }

    // Call this whenever ANY data is received
    recordHeartbeat() {
        this.lastPingTime = Date.now();
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
            if (data.type !== 'PING' && data.type !== 'PONG') {
                console.log("Sending:", data.type);
            }
            this.conn.send(data);
        } else {
            console.warn(`SEND FAILED (${data.type}): Conn not open`);
            // Don't alert on heartbeat fail, just warn
            if (data.type !== 'PING' && data.type !== 'PONG') {
                // Trigger callback so UI can show "Offline"
                if (this.callbacks.onError) this.callbacks.onError({ type: 'disconnected' });
            }
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
    onConnection(cb) { this.callbacks.onConnection = cb; }
    onError(cb) { this.callbacks.onError = cb; }
    onHeartbeatLost(cb) { this.callbacks.onHeartbeatLost = cb; }

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
