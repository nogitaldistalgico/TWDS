/* PeerJS Logic Wrapper – v3 (TURN servers + connection timeout) */

class PeerManager {
    constructor(isHost = false) {
        this.peer = null;
        this.conn = null;
        this.isHost = isHost;
        this.initialized = false;
        this.lastHostId = null;
        this.intentionalClose = false;
        this._reconnecting = false;
        this._connectTimeout = null;

        this.callbacks = {
            onOpen: () => { },
            onData: () => { },
            onClose: () => { },
            onConnectionOpen: () => { },
            onConnection: () => { },
            onError: () => { },
            onHeartbeatLost: () => { }
        };
    }

    init(id = null) {
        // Prevent double initialization
        if (this.initialized && this.peer && !this.peer.destroyed) {
            console.warn('[P2P] Already initialized, skipping.');
            // If peer is already open, fire onOpen immediately so tryConnect runs
            if (this.peer.open) {
                this.callbacks.onOpen(this.peer.id);
            }
            return;
        }

        // Cleanup old peer
        if (this.peer) {
            try { this.peer.destroy(); } catch (e) { /* ignore */ }
            this.peer = null;
        }

        const peerId = id || (this.isHost ? this.generateRoomId() : null);

        // iOS / Safari HTTPS Check
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && !location.hostname.startsWith('127.0')) {
            console.warn("⚠️ [P2P] WebRTC on iOS/Safari requires HTTPS!");
            if (this.callbacks.onError) this.callbacks.onError({ type: 'warning-ssl', message: 'iOS requires HTTPS for WebRTC.' });
        }

        this.peer = new Peer(peerId, {
            debug: 2,
            secure: true,
            config: {
                iceServers: [
                    // STUN servers (free, for direct connections)
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' }
                ]
            }
        });

        this.peer.on('open', (id) => {
            console.log('[P2P] My peer ID is: ' + id);
            this.initialized = true;
            this.callbacks.onOpen(id);
        });

        this.peer.on('connection', (conn) => {
            console.log('[P2P] Incoming connection from: ' + conn.peer);
            // Host: pass to game logic (master.js handlePlayerJoin)
            if (this.callbacks.onConnection) {
                this.callbacks.onConnection(conn);
            }
            // Client: also handle locally
            if (!this.isHost) {
                this.handleConnection(conn);
            }
        });

        this.peer.on('error', (err) => {
            console.error("[P2P] PeerJS Error:", err.type);
            if (err.type === 'browser-incompatible') {
                alert("Browser not compatible with WebRTC");
            }
            if (err.type === 'unavailable-id') {
                console.error("[P2P] Peer ID already taken! Master might already be running.");
            }
            if (this.callbacks.onError) {
                this.callbacks.onError(err);
            }
        });

        // Auto-reconnect to signaling server if disconnected
        this.peer.on('disconnected', () => {
            console.warn('[P2P] Disconnected from signaling server. Attempting reconnect...');
            const tryReconnect = () => {
                if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
                    console.log('[P2P] Reconnecting to signaling server...');
                    try { 
                        this.peer.reconnect(); 
                    } catch (e) { 
                        console.error('[P2P] Reconnect failed, retrying in 3s...', e);
                    }
                    setTimeout(tryReconnect, 3000); // Keep trying until it reconnects
                }
            };
            setTimeout(tryReconnect, 1000);
        });

        if (!this.isHost) {
            this.setupVisibilityHandler();
        }
    }

    handleConnection(conn) {
        this.conn = conn;

        // CONNECTION TIMEOUT: If 'open' doesn't fire within 8s, retry
        this._clearConnectTimeout();
        this._connectTimeout = setTimeout(() => {
            if (this.conn && !this.conn.open) {
                console.warn('[P2P] Connection timeout (8s) – no open event. Retrying...');
                try { this.conn.close(); } catch (e) { /* */ }
                this.conn = null;
                // Signal as error so player.js retry logic kicks in
                if (this.callbacks.onError) {
                    this.callbacks.onError({ type: 'connection-timeout' });
                }
            }
        }, 8000);

        conn.on('open', () => {
            console.log('[P2P] Connected!');
            this._clearConnectTimeout();
            this._reconnecting = false;
            this.startHeartbeat();
            if (this.callbacks.onConnectionOpen) this.callbacks.onConnectionOpen();
        });

        conn.on('data', (data) => {
            this.recordHeartbeat();

            if (data.type === 'PING') {
                this.send({ type: 'PONG' });
                return;
            }
            if (data.type === 'PONG') {
                return;
            }

            this.callbacks.onData(data);
        });

        conn.on('close', () => {
            console.log('[P2P] Connection closed');
            this._clearConnectTimeout();
            this.stopHeartbeat();
            this.callbacks.onClose();

            // Auto Reconnect for Client
            if (!this.isHost && !this.intentionalClose) {
                console.log("[P2P] Unexpected disconnect. Reconnecting...");
                this._scheduleReconnect(2000);
            }
        });

        conn.on('error', (err) => {
            console.error("[P2P] Connection Error:", err);
            this._clearConnectTimeout();
            this.stopHeartbeat();
        });
    }

    _clearConnectTimeout() {
        if (this._connectTimeout) {
            clearTimeout(this._connectTimeout);
            this._connectTimeout = null;
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.lastPingTime = Date.now();

        this.heartbeatInterval = setInterval(() => {
            if (!this.conn || !this.conn.open) {
                this.stopHeartbeat();
                return;
            }

            try {
                this.conn.send({ type: 'PING' });
            } catch (e) { /* ignore */ }

            // Check Timeout – 10s (more lenient for mobile)
            if (Date.now() - this.lastPingTime > 10000) {
                console.warn("[P2P] Heartbeat timeout!");
                if (this.callbacks.onHeartbeatLost) this.callbacks.onHeartbeatLost();
                this.stopHeartbeat();
                try { if (this.conn) this.conn.close(); } catch (e) { /* */ }
            }
        }, 2000); // Ping every 2s
    }

    setupVisibilityHandler() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                console.log("[P2P] Page visible -> Checking connection...");
                // Reset heartbeat timer to avoid false timeout after tab switch
                this.lastPingTime = Date.now();

                if (!this.conn || !this.conn.open) {
                    console.log("[P2P] Connection lost while hidden. Reconnecting...");
                    this._scheduleReconnect(500);
                } else {
                    try { this.conn.send({ type: 'PING' }); } catch (e) {
                        this._scheduleReconnect(500);
                    }
                }
            }
        });
    }

    recordHeartbeat() {
        this.lastPingTime = Date.now();
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    _scheduleReconnect(delay) {
        if (this._reconnecting) return;
        this._reconnecting = true;
        setTimeout(() => {
            this.reconnect();
        }, delay);
    }

    reconnect() {
        if (!this.lastHostId) {
            this._reconnecting = false;
            return;
        }

        console.log("[P2P] Reconnecting to " + this.lastHostId);

        // Ensure peer is still usable
        if (!this.peer || this.peer.destroyed) {
            console.log('[P2P] Peer destroyed, re-initializing...');
            this.initialized = false;
            this.init();
            // Wait for open, then connect
            const origOnOpen = this.callbacks.onOpen;
            this.callbacks.onOpen = (id) => {
                this.callbacks.onOpen = origOnOpen;
                origOnOpen(id);
                this.connect(this.lastHostId);
            };
        } else if (!this.peer.open) {
            this.peer.once('open', () => {
                this.connect(this.lastHostId);
            });
            try { this.peer.reconnect(); } catch (e) { /* */ }
        } else {
            this.connect(this.lastHostId);
        }
    }

    send(data) {
        if (this.conn && this.conn.open) {
            try {
                this.conn.send(data);
            } catch (e) {
                if (data.type !== 'PING' && data.type !== 'PONG') {
                    console.warn(`[P2P] Send failed (${data.type})`);
                    if (this.callbacks.onError) this.callbacks.onError({ type: 'disconnected' });
                }
            }
        } else {
            if (data.type !== 'PING' && data.type !== 'PONG') {
                console.warn(`[P2P] SEND FAILED (${data.type}): not connected`);
                if (this.callbacks.onError) this.callbacks.onError({ type: 'disconnected' });
            }
        }
    }

    generateRoomId() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
        if (!this.peer || !this.peer.open) {
            console.error("[P2P] Cannot connect, peer not ready");
            return;
        }

        console.log(`[P2P] Initiating connection to host: ${hostId}`);
        this.lastHostId = hostId;
        this.intentionalClose = false;

        // Clean up old connection
        this._clearConnectTimeout();
        if (this.conn) {
            try { this.stopHeartbeat(); this.conn.close(); } catch (e) { /* */ }
            this.conn = null;
        }

        const conn = this.peer.connect(hostId, {
            reliable: false, // Changed to false to avoid Safari SCTP bugs
            serialization: 'json'
        });
        this.handleConnection(conn);
    }
}
