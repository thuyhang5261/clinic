const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const app = express();

// Use HTTPS if certificates are available, otherwise fall back to HTTP
let server;
try {
    const certPath = path.join(__dirname, 'cert.pem');
    const keyPath = path.join(__dirname, 'key.pem');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        const options = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        server = https.createServer(options, app);
        console.log('🔒 Using HTTPS server');
    } else {
        server = http.createServer(app);
        console.log('⚠️  Using HTTP server (getUserMedia requires HTTPS or localhost)');
    }
} catch (error) {
    server = http.createServer(app);
    console.log('⚠️  Using HTTP server (getUserMedia requires HTTPS or localhost)');
}
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// RTMP streaming variables
let ffmpegProcess = null;
let isStreaming = false;

// Store connected peers
const peers = new Map();
let broadcaster = null;

// RTMP Streaming Functions
function startRTMPStream() {
    if (ffmpegProcess) {
        console.log('📡 RTMP stream already running');
        return;
    }

    console.log('🚀 Starting RTMP stream...');

    ffmpegProcess = ffmpeg()
        .input('pipe:0') // Read from stdin
        .inputFormat('webm') // Input format from MediaRecorder
        .videoCodec('libx264')
        .audioCodec('aac')
        .format('flv') // RTMP requires FLV format
        .outputOptions([
            '-preset veryfast',
            '-tune zerolatency',
            '-b:v 1000k', // Video bitrate
            '-b:a 128k',  // Audio bitrate
            '-f flv'      // Force FLV format
        ])
        .output('rtmp://localhost:1935/live/stream')
        .on('start', (commandLine) => {
            console.log('✅ FFmpeg started with command:', commandLine);
            isStreaming = true;
        })
        .on('error', (err, stdout, stderr) => {
            console.error('❌ FFmpeg error:', err.message);
            console.error('FFmpeg stderr:', stderr);
            isStreaming = false;
            ffmpegProcess = null;
        })
        .on('end', () => {
            console.log('⏹️ FFmpeg process ended');
            isStreaming = false;
            ffmpegProcess = null;
        });

    ffmpegProcess.run();
}

function stopRTMPStream() {
    if (ffmpegProcess) {
        console.log('⏹️ Stopping RTMP stream...');
        ffmpegProcess.kill('SIGTERM');
        ffmpegProcess = null;
        isStreaming = false;
    }
}

function writeToFFmpeg(data) {
    if (ffmpegProcess && isStreaming) {
        try {
            ffmpegProcess.process.stdin.write(data);
        } catch (error) {
            console.error('❌ Error writing to FFmpeg:', error.message);
        }
    }
}

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

app.use(express.static('public'));

// Favicon endpoint to prevent 404 errors
app.get('/favicon.ico', (req, res) => {
    res.status(204).send();
});

// WebSocket signaling for P2P connections
io.on('connection', (socket) => {
    console.log(`🔗 New connection: ${socket.id}`);

    // Join as broadcaster
    socket.on('join-as-broadcaster', () => {
        if (broadcaster && broadcaster.id !== socket.id) {
            // Disconnect existing broadcaster
            broadcaster.emit('force-disconnect', { reason: 'New broadcaster connected' });
            broadcaster.disconnect();
            stopRTMPStream(); // Stop existing stream
        }
        broadcaster = socket;
        socket.role = 'broadcaster';
        console.log(`📡 Broadcaster connected: ${socket.id}`);

        // Notify all viewers about new broadcaster
        socket.broadcast.emit('broadcaster-connected');
    });

    // Handle stream data for RTMP
    socket.on('stream-data', (data) => {
        if (socket.role === 'broadcaster') {
            // Start RTMP stream if not already running
            if (!isStreaming) {
                startRTMPStream();
            }

            // Write stream data to FFmpeg
            if (data && data.length > 0) {
                writeToFFmpeg(Buffer.from(data));
            }
        }
    });

    // Handle stream start
    socket.on('start-stream-to-rtmp', () => {
        if (socket.role === 'broadcaster') {
            console.log('🎬 Starting stream to RTMP...');
            startRTMPStream();
            socket.emit('rtmp-stream-started');
        }
    });

    // Handle stream stop
    socket.on('stop-stream-to-rtmp', () => {
        if (socket.role === 'broadcaster') {
            console.log('⏹️ Stopping stream to RTMP...');
            stopRTMPStream();
            socket.emit('rtmp-stream-stopped');
        }
    });    // Join as viewer
    socket.on('join-as-viewer', () => {
        peers.set(socket.id, socket);
        socket.role = 'viewer';
        console.log(`👁️ Viewer connected: ${socket.id}`);

        // Check if broadcaster is available
        if (broadcaster) {
            socket.emit('broadcaster-available');
            // Notify broadcaster about new viewer
            broadcaster.emit('new-viewer', { viewerId: socket.id });
        } else {
            socket.emit('no-broadcaster');
        }

        // Send list of other viewers for P2P mesh connections
        const otherViewers = Array.from(peers.entries())
            .filter(([id, peer]) => peer.role === 'viewer' && id !== socket.id)
            .map(([id, peer]) => id);
        socket.emit('other-viewers', otherViewers);

        // Notify other viewers about this new viewer
        socket.broadcast.emit('new-peer', { peerId: socket.id });
    });

    // WebRTC signaling messages
    socket.on('offer', (data) => {
        console.log(`📤 Offer from ${socket.id} to ${data.target}`);
        const targetSocket = data.target === 'broadcast' ? broadcaster : peers.get(data.target) || io.sockets.sockets.get(data.target);
        if (targetSocket) {
            targetSocket.emit('offer', {
                sdp: data.sdp,
                sender: socket.id
            });
        }
    });

    socket.on('answer', (data) => {
        console.log(`📥 Answer from ${socket.id} to ${data.target}`);
        const targetSocket = peers.get(data.target) || io.sockets.sockets.get(data.target);
        if (targetSocket) {
            targetSocket.emit('answer', {
                sdp: data.sdp,
                sender: socket.id
            });
        }
    });

    socket.on('ice-candidate', (data) => {
        console.log(`🧊 ICE candidate from ${socket.id} to ${data.target}`);
        const targetSocket = data.target === 'broadcast' ? broadcaster : peers.get(data.target) || io.sockets.sockets.get(data.target);
        if (targetSocket) {
            targetSocket.emit('ice-candidate', {
                candidate: data.candidate,
                sender: socket.id
            });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`❌ Disconnected: ${socket.id}`);

        if (socket === broadcaster) {
            broadcaster = null;
            console.log('📡 Broadcaster disconnected');
            stopRTMPStream(); // Stop RTMP stream when broadcaster disconnects
            // Notify all viewers that broadcaster is gone
            socket.broadcast.emit('broadcaster-left');
        } else {
            peers.delete(socket.id);
            console.log(`👁️ Viewer disconnected: ${socket.id}`);
            // Notify remaining peers about disconnection
            socket.broadcast.emit('peer-left', { peerId: socket.id });
        }
    });
});

// Status endpoint
app.get('/status', (req, res) => {
    res.json({
        broadcasterConnected: !!broadcaster,
        viewerCount: Array.from(peers.values()).filter(p => p.role === 'viewer').length,
        totalConnections: peers.size + (broadcaster ? 1 : 0)
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 P2P WebRTC Signaling Server started on port ${PORT}`);
    console.log('📡 Ready for broadcaster and viewer connections...');
});

app.post('/broadcast', async ({ body }, res) => {
    try {
        if (!body.sdp) {
            return res.status(400).json({ error: 'SDP is required' });
        }

        const peer = new webrtc.RTCPeerConnection({
            iceServers: [
                {
                    urls: ["stun:stun.l.google.com:19302"]
                }
            ]
        });
        peer.ontrack = (e) => handleTrackEvent(e, peer);

        // ICE connection state logging
        peer.oniceconnectionstatechange = () => {
            console.log(`[1;34m Broadcaster ICE state: ${peer.iceConnectionState}`);
        };

        // Log server-side ICE candidates for broadcaster
        peer.onicecandidate = (event) => {
            if (event && event.candidate) {
                console.log('Broadcaster peer icecandidate:', event.candidate.candidate);
            } else {
                console.log('Broadcaster peer ICE gathering finished (null candidate)');
            }
        };

        const desc = new webrtc.RTCSessionDescription(body.sdp);
        await peer.setRemoteDescription(desc);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);

        // wait for ICE gathering to finish (non-trickle)
        await waitForIceGatheringComplete(peer, 5000);

        const payload = {
            sdp: peer.localDescription
        };

        console.log('Broadcast stream started');
        res.json(payload);
    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function handleTrackEvent(e, peer) {
    senderStream = e.streams[0];
    console.log('Stream received from broadcaster:', senderStream.id);
    console.log('Stream tracks:', senderStream.getTracks().length);

    // Log track info
    senderStream.getTracks().forEach((track, index) => {
        console.log(`Track ${index}: ${track.kind} - ${track.label}`);
    });
};


// Middleware để log tất cả requests
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// 404 handler
app.use('*', (req, res) => {
    console.log(`404: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Endpoint not found', path: req.originalUrl });
});