const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const sslDir = path.join(__dirname, 'ssl');

if (!fs.existsSync(sslDir)) {
  fs.mkdirSync(sslDir);
}

try {
  // Check if OpenSSL is available
  execSync('openssl version', { stdio: 'ignore' });
  
  // Generate self-signed certificate
  const keyPath = path.join(sslDir, 'server.key');
  const certPath = path.join(sslDir, 'server.crt');
  
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.log('Generating SSL certificates...');
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`);
    console.log('SSL certificates generated successfully!');
  } else {
    console.log('SSL certificates already exist.');
  }
} catch (error) {
  console.error('OpenSSL not found or error generating certificates.');
  console.log('Please install OpenSSL or create certificates manually.');
  console.log('\nFor Windows: Download OpenSSL from https://slproweb.com/products/Win32OpenSSL.html');
  console.log('For Mac: brew install openssl');
  console.log('For Linux: sudo apt-get install openssl');
}
