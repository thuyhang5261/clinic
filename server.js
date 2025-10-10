const NodeMediaServer = require('node-media-server');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const app = express();
const HTTP_PORT = 3000;
const HTTPS_PORT = 3443; // Changed from 443 to avoid permission issues
const RTMP_PORT = 1935;

// Ensure media directories exist
const mediaDir = path.join(__dirname, 'media');
const liveDir = path.join(mediaDir, 'live');
if (!fs.existsSync(liveDir)) {
  fs.mkdirSync(liveDir, { recursive: true });
}

// Serve static files
app.use(express.static('public'));
app.use('/hls', express.static(liveDir));

// Serve admin page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Stream status endpoint
app.get('/api/stream/status', (req, res) => {
  const streamPath = path.join(liveDir, 'stream', 'index.m3u8');
  
  if (fs.existsSync(streamPath)) {
    try {
      const content = fs.readFileSync(streamPath, 'utf8');
      const isLive = !content.includes('#EXT-X-ENDLIST') && content.includes('.ts');
      const segments = (content.match(/\.ts/g) || []).length;
      
      res.json({
        status: isLive ? 'LIVE' : 'OFFLINE',
        segments: segments,
        lastUpdate: fs.statSync(streamPath).mtime,
        content: content.substring(0, 200) + '...'
      });
    } catch (error) {
      res.json({ status: 'ERROR', error: error.message });
    }
  } else {
    res.json({ status: 'NO_STREAM', message: 'Stream file not found' });
  }
});

// Proxy for HLS files
app.use('/live', createProxyMiddleware({
  target: `http://localhost:8000`,
  changeOrigin: true,
  ws: true
}));

// Node Media Server Configuration
const config = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    mediaroot: './media',
    allow_origin: '*'
  },
  trans: {
    ffmpeg: require('@ffmpeg-installer/ffmpeg').path,
    tasks: [
      {
        app: 'live',
        hls: true,
        hlsFlags: '[hls_time=4:hls_list_size=5:hls_flags=delete_segments]',
        hlsKeep: true, // Keep segments for better playback
        dash: false
      }
    ]
  }
};

const nms = new NodeMediaServer(config);
nms.run();

// SSL Configuration
let httpsServer;
const sslPath = path.join(__dirname, 'phongkhamhongnhan.com');
const keyPath = path.join(sslPath, 'privkey.pem');
const certPath = path.join(sslPath, 'fullchain.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const sslOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  httpsServer = https.createServer(sslOptions, app);
} else {
  console.log('SSL certificates not found. Running HTTP only.');
}

// HTTP Server
const httpServer = http.createServer(app);

// WebSocket server for browser to RTMP bridge
const wss = new WebSocket.Server({ 
  server: httpsServer || httpServer,
  path: '/rtmp-bridge'
});

// Active FFmpeg processes
const ffmpegProcesses = new Map();

wss.on('connection', (ws) => {
  console.log('WebSocket client connected for RTMP bridge');
  const clientId = Date.now().toString();
  
  // Start FFmpeg to convert WebM to RTMP
  const ffmpeg = spawn(require('@ffmpeg-installer/ffmpeg').path, [
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-r', '30',
    '-g', '30',
    '-keyint_min', '30',
    '-crf', '25',
    '-pix_fmt', 'yuv420p',
    '-sc_threshold', '0',
    '-profile:v', 'main',
    '-level', '3.1',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    `rtmp://localhost:${RTMP_PORT}/live/stream`
  ]);
  
  ffmpegProcesses.set(clientId, ffmpeg);
  
  ffmpeg.on('error', (error) => {
    console.error('FFmpeg error:', error);
    ws.close();
  });
  
  ffmpeg.stderr.on('data', (data) => {
    console.log('FFmpeg:', data.toString());
  });
  
  ffmpeg.on('close', (code) => {
    console.log(`FFmpeg process exited with code ${code}`);
    ffmpegProcesses.delete(clientId);
  });
  
  ws.on('message', (data) => {
    if (ffmpeg && ffmpeg.stdin && ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(data);
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    if (ffmpeg) {
      ffmpeg.stdin.end();
      ffmpeg.kill();
      ffmpegProcesses.delete(clientId);
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    if (ffmpeg) {
      ffmpeg.kill();
      ffmpegProcesses.delete(clientId);
    }
  });
});

// API endpoints
app.get('/api/stats', (req, res) => {
  const isLive = fs.existsSync(path.join(liveDir, 'stream.m3u8'));
  res.json({ 
    viewers: isLive ? Math.floor(Math.random() * 100) + 10 : 0,
    isLive: isLive,
    activeStreams: ffmpegProcesses.size
  });
});

// Start servers
httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP Server running on http://localhost:${HTTP_PORT}`);
  console.log(`RTMP Server running on rtmp://localhost:${RTMP_PORT}/live`);
  console.log(`HLS files available at http://localhost:${HTTP_PORT}/live/stream/index.m3u8`);
});

// Start HTTPS Server with error handling
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`HTTPS Server running on https://localhost:${HTTPS_PORT}`);
    console.log(`HLS files available at https://localhost:${HTTPS_PORT}/live/stream/index.m3u8`);
  });
  
  httpsServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${HTTPS_PORT} is already in use. HTTPS server not started.`);
    } else if (err.code === 'EACCES') {
      console.error(`Permission denied. Cannot bind to port ${HTTPS_PORT}. Try running as administrator or use a different port.`);
    } else {
      console.error('HTTPS server error:', err);
    }
  });
} else {
  console.log('HTTPS server not started. Please generate SSL certificates.');
}

// Node Media Server events
nms.on('prePublish', (id, StreamPath, args) => {
  console.log('[NodeEvent on prePublish]', `id=${id} StreamPath=${StreamPath}`);
});

nms.on('postPublish', (id, StreamPath, args) => {
  console.log('[NodeEvent on postPublish]', `id=${id} StreamPath=${StreamPath}`);
});

nms.on('donePublish', (id, StreamPath, args) => {
  console.log('[NodeEvent on donePublish]', `id=${id} StreamPath=${StreamPath}`);
  // Clean up HLS files after stream ends
  setTimeout(() => {
    const files = fs.readdirSync(liveDir);
    files.forEach(file => {
      if (file.includes('stream')) {
        fs.unlinkSync(path.join(liveDir, file));
      }
    });
  }, 5000);
});
