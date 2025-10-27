let localStream;
let socket;
let peerConnections = new Map(); // Store connections to viewers
let mediaRecorder = null;
let isRecording = false;

window.onload = () => {
    document.getElementById('my-button').onclick = () => {
        init();
    }
}

async function init() {
    try {
        console.log('📡 Starting broadcaster...');

        // Get user media
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        document.getElementById("video").srcObject = localStream;

        // Connect to signaling server
        socket = io();
        setupSocketListeners();

        // Join as broadcaster
        socket.emit('join-as-broadcaster');

        // Setup MediaRecorder for RTMP streaming
        setupMediaRecorder();

        // Enable RTMP buttons
        document.getElementById('start-rtmp').disabled = false;
        document.getElementById('stop-rtmp').disabled = false;

        console.log('📡 Broadcaster initialized successfully');

    } catch (error) {
        console.error('❌ Error initializing broadcaster:', error);
    }
}

function setupSocketListeners() {
    socket.on('new-viewer', (data) => {
        console.log(`👁️ New viewer connected: ${data.viewerId}`);
        // Don't create connection yet, wait for viewer's offer
    });

    socket.on('offer', async (data) => {
        console.log(`📥 Received offer from viewer: ${data.sender}`);
        await handleOfferFromViewer(data.sender, data.sdp);
    }); socket.on('answer', async (data) => {
        console.log(`📨 Received answer from viewer: ${data.sender}`);
        await handleAnswer(data.sender, data.sdp);
    });

    socket.on('ice-candidate', async (data) => {
        console.log(`🧊 Received ICE candidate from: ${data.sender}`);
        await handleIceCandidate(data.sender, data.candidate);
    });

    socket.on('force-disconnect', (data) => {
        console.log('⚠️ Forced disconnect:', data.reason);
        alert(data.reason);
        location.reload();
    });

    socket.on('rtmp-stream-started', () => {
        console.log('✅ RTMP stream started successfully');
        document.getElementById('rtmp-status').textContent = 'RTMP: Streaming';
        document.getElementById('rtmp-status').style.color = 'green';
    });

    socket.on('rtmp-stream-stopped', () => {
        console.log('⏹️ RTMP stream stopped');
        document.getElementById('rtmp-status').textContent = 'RTMP: Stopped';
        document.getElementById('rtmp-status').style.color = 'red';
    });
}

function createPeerConnection(viewerId) {
    const peer = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    // Add local stream tracks to peer connection
    localStream.getTracks().forEach(track => {
        peer.addTrack(track, localStream);
    });

    // Handle ICE candidates
    peer.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`🧊 Sending ICE candidate to ${viewerId}`);
            socket.emit('ice-candidate', {
                target: viewerId,
                candidate: event.candidate
            });
        }
    };

    // Handle connection state changes
    peer.oniceconnectionstatechange = () => {
        console.log(`� Connection to ${viewerId}: ${peer.iceConnectionState}`);
        if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
            console.log(`❌ Connection failed with viewer: ${viewerId}`);
            peerConnections.delete(viewerId);
        }
    };

    peerConnections.set(viewerId, peer);

    // Create and send offer
    createAndSendOffer(viewerId, peer);
}

async function createAndSendOffer(viewerId, peer) {
    try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);

        console.log(`📤 Sending offer to viewer: ${viewerId}`);
        socket.emit('offer', {
            target: viewerId,
            sdp: offer
        });
    } catch (error) {
        console.error(`❌ Error creating offer for ${viewerId}:`, error);
    }
}

async function handleAnswer(viewerId, answerSdp) {
    try {
        const peer = peerConnections.get(viewerId);
        if (peer) {
            await peer.setRemoteDescription(new RTCSessionDescription(answerSdp));
            console.log(`✅ Answer processed for viewer: ${viewerId}`);
        }
    } catch (error) {
        console.error(`❌ Error handling answer from ${viewerId}:`, error);
    }
}

async function handleOfferFromViewer(viewerId, offerSdp) {
    try {
        const peer = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });

        // Add local stream tracks to peer connection
        localStream.getTracks().forEach(track => {
            peer.addTrack(track, localStream);
        });

        // Handle ICE candidates
        peer.onicecandidate = (event) => {
            if (event.candidate) {
                console.log(`🧊 Sending ICE candidate to ${viewerId}`);
                socket.emit('ice-candidate', {
                    target: viewerId,
                    candidate: event.candidate
                });
            }
        };

        // Handle connection state changes
        peer.oniceconnectionstatechange = () => {
            console.log(`🔗 Connection to ${viewerId}: ${peer.iceConnectionState}`);
            if (peer.iceConnectionState === 'connected') {
                console.log(`✅ Successfully connected to viewer: ${viewerId}`);
            } else if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
                console.log(`❌ Connection failed with viewer: ${viewerId}`);
                peerConnections.delete(viewerId);
            }
        };

        peerConnections.set(viewerId, peer);

        // Set remote description (viewer's offer)
        await peer.setRemoteDescription(new RTCSessionDescription(offerSdp));

        // Create and send answer
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);

        console.log(`📤 Sending answer to viewer: ${viewerId}`);
        socket.emit('answer', {
            target: viewerId,
            sdp: answer
        });

    } catch (error) {
        console.error(`❌ Error handling offer from viewer ${viewerId}:`, error);
    }
}

async function handleIceCandidate(peerId, candidate) {
    try {
        const peer = peerConnections.get(peerId);
        if (peer) {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
        }
    } catch (error) {
        console.error(`❌ Error adding ICE candidate from ${peerId}:`, error);
    }
}

function setupMediaRecorder() {
    if (!localStream) {
        console.error('❌ No local stream available for recording');
        return;
    }

    try {
        // Create MediaRecorder with webm format
        mediaRecorder = new MediaRecorder(localStream, {
            mimeType: 'video/webm;codecs=vp8,opus'
        });

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && socket) {
                // Convert blob to array buffer and send to server
                event.data.arrayBuffer().then(buffer => {
                    const uint8Array = new Uint8Array(buffer);
                    socket.emit('stream-data', uint8Array);
                });
            }
        };

        mediaRecorder.onstart = () => {
            console.log('🎬 MediaRecorder started for RTMP streaming');
            isRecording = true;
        };

        mediaRecorder.onstop = () => {
            console.log('⏹️ MediaRecorder stopped');
            isRecording = false;
        };

        mediaRecorder.onerror = (error) => {
            console.error('❌ MediaRecorder error:', error);
        };

        console.log('✅ MediaRecorder setup complete');
    } catch (error) {
        console.error('❌ Error setting up MediaRecorder:', error);
    }
}

function startRTMPStreaming() {
    if (!mediaRecorder) {
        console.error('❌ MediaRecorder not initialized');
        return;
    }

    if (isRecording) {
        console.log('📡 Already streaming to RTMP');
        return;
    }

    console.log('🚀 Starting RTMP streaming...');
    socket.emit('start-stream-to-rtmp');

    // Start recording with 1 second chunks
    mediaRecorder.start(1000);
}

function stopRTMPStreaming() {
    if (!mediaRecorder || !isRecording) {
        console.log('⏹️ No active RTMP streaming');
        return;
    }

    console.log('⏹️ Stopping RTMP streaming...');
    mediaRecorder.stop();
    socket.emit('stop-stream-to-rtmp');
}


