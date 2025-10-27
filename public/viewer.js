let socket;
let broadcasterPeer;
let otherViewerPeers = new Map();

window.onload = () => {
    document.getElementById('my-button').onclick = () => {
        console.log('👁️ Starting viewer...');
        init();
    }
}

async function init() {
    try {
        console.log('�️ Connecting to signaling server...');

        // Connect to signaling server
        socket = io();
        setupSocketListeners();

        // Join as viewer
        socket.emit('join-as-viewer');

        console.log('👁️ Viewer initialized successfully');

    } catch (error) {
        console.error('❌ Error initializing viewer:', error);
    }
}

function setupSocketListeners() {
    socket.on('broadcaster-available', () => {
        console.log('📡 Broadcaster is available, requesting stream...');
        createBroadcasterConnection();
    });

    socket.on('no-broadcaster', () => {
        console.log('⚠️ No broadcaster available');
        displayStatus('Waiting for broadcaster...');
    });

    socket.on('broadcaster-left', () => {
        console.log('📡 Broadcaster disconnected');
        displayStatus('Broadcaster disconnected. Waiting for new broadcaster...');
        if (broadcasterPeer) {
            broadcasterPeer.close();
            broadcasterPeer = null;
        }
        clearVideo();
    });

    socket.on('offer', async (data) => {
        console.log(`📥 Received offer from: ${data.sender}`);
        await handleOffer(data.sender, data.sdp);
    });

    socket.on('answer', async (data) => {
        console.log(`📨 Received answer from: ${data.sender}`);
        await handleAnswer(data.sender, data.sdp);
    });

    socket.on('ice-candidate', async (data) => {
        console.log(`🧊 Received ICE candidate from: ${data.sender}`);
        await handleIceCandidate(data.sender, data.candidate);
    });

    socket.on('new-peer', (data) => {
        console.log(`👥 New peer viewer connected: ${data.peerId}`);
        // Could establish P2P connections with other viewers here if needed
    });

    socket.on('peer-left', (data) => {
        console.log(`👥 Peer viewer left: ${data.peerId}`);
        if (otherViewerPeers.has(data.peerId)) {
            otherViewerPeers.get(data.peerId).close();
            otherViewerPeers.delete(data.peerId);
        }
    });
}

function createBroadcasterConnection() {
    broadcasterPeer = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    // Handle incoming stream from broadcaster
    broadcasterPeer.ontrack = (event) => {
        console.log('📺 Received stream from broadcaster');
        const video = document.getElementById('video');
        if (video) {
            video.srcObject = event.streams[0];
            displayStatus('Connected to broadcaster');
        }
    };

    // Handle ICE candidates
    broadcasterPeer.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('🧊 Sending ICE candidate to broadcaster');
            socket.emit('ice-candidate', {
                target: 'broadcast',
                candidate: event.candidate
            });
        }
    };

    // Handle connection state
    broadcasterPeer.oniceconnectionstatechange = () => {
        console.log(`🔗 Broadcaster connection: ${broadcasterPeer.iceConnectionState}`);
        if (broadcasterPeer.iceConnectionState === 'connected') {
            displayStatus('Streaming live from broadcaster');
        } else if (broadcasterPeer.iceConnectionState === 'failed') {
            displayStatus('Connection failed. Retrying...');
        }
    };

    // Add transceivers for receiving video/audio
    broadcasterPeer.addTransceiver('video', { direction: 'recvonly' });
    broadcasterPeer.addTransceiver('audio', { direction: 'recvonly' });

    // Viewer initiates by creating offer to broadcaster
    createOfferToBroadcaster();
}

async function createOfferToBroadcaster() {
    try {
        const offer = await broadcasterPeer.createOffer();
        await broadcasterPeer.setLocalDescription(offer);

        console.log('📤 Sending offer to broadcaster');
        socket.emit('offer', {
            target: 'broadcast',
            sdp: offer
        });

        displayStatus('Requesting stream from broadcaster...');
    } catch (error) {
        console.error('❌ Error creating offer to broadcaster:', error);
        displayStatus('Failed to connect to broadcaster');
    }
} async function handleOffer(senderId, offerSdp) {
    try {
        if (senderId === 'broadcast' || !broadcasterPeer) {
            // This is an offer from broadcaster, but we should be requesting the stream
            // In P2P model, viewer creates offer to broadcaster
            return;
        }

        // Handle offer from other peer (if implementing viewer-to-viewer connections)
        const peer = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });

        otherViewerPeers.set(senderId, peer);

        await peer.setRemoteDescription(new RTCSessionDescription(offerSdp));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);

        socket.emit('answer', {
            target: senderId,
            sdp: answer
        });

    } catch (error) {
        console.error(`❌ Error handling offer from ${senderId}:`, error);
    }
}

async function handleAnswer(senderId, answerSdp) {
    try {
        const peer = otherViewerPeers.get(senderId) || broadcasterPeer;
        if (peer) {
            await peer.setRemoteDescription(new RTCSessionDescription(answerSdp));
            console.log(`✅ Answer processed from: ${senderId}`);
        }
    } catch (error) {
        console.error(`❌ Error handling answer from ${senderId}:`, error);
    }
}

async function handleIceCandidate(senderId, candidate) {
    try {
        const peer = otherViewerPeers.get(senderId) || broadcasterPeer;
        if (peer) {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
        }
    } catch (error) {
        console.error(`❌ Error adding ICE candidate from ${senderId}:`, error);
    }
}

function displayStatus(message) {
    const statusDiv = document.getElementById('status') || createStatusDiv();
    statusDiv.textContent = message;
}

function createStatusDiv() {
    const statusDiv = document.createElement('div');
    statusDiv.id = 'status';
    statusDiv.style.cssText = 'padding: 10px; background: #f0f0f0; margin: 10px 0; border-radius: 4px;';
    document.body.insertBefore(statusDiv, document.body.firstChild);
    return statusDiv;
}

function clearVideo() {
    const video = document.getElementById('video');
    if (video) {
        video.srcObject = null;
    }
}