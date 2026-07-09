// 🦞 Gmail OAuth 認證模組
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const { exec } = require('child_process');

const CREDS_PATH = path.join(__dirname, 'gmail-credentials.json');
const TOKEN_PATH = path.join(__dirname, 'gmail-token.json');
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const REDIRECT_PORT = 3456;

async function authenticate(interactive = false) {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error('找不到 gmail-credentials.json，請先到 Google Cloud Console 下載');
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const c = creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(
    c.client_id, c.client_secret, `http://localhost:${REDIRECT_PORT}/oauth-callback`
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  if (!interactive) throw new Error('尚未授權，請先執行 設定Gmail.bat');

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  console.log('\n📧 開啟瀏覽器授權中...');
  console.log('如果沒自動開啟，手動打開：');
  console.log(authUrl + '\n');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const q = url.parse(req.url, true).query;
        if (q.code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>🦞 授權成功！</h1><p>請關閉這個視窗，回到 cmd 視窗。</p>');
          server.close();
          const { tokens } = await oAuth2Client.getToken(q.code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          console.log('✅ Token 已存到 gmail-token.json');
          resolve(oAuth2Client);
        }
      } catch (e) { reject(e); }
    });
    server.listen(REDIRECT_PORT, () => {
      exec(`start "" "${authUrl}"`);
    });
  });
}

module.exports = { authenticate };
