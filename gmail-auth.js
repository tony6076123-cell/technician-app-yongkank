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
  // 🦞 gmail-credentials.json 含 OAuth client_id/secret，不能推上公開repo（GitHub push protection會擋）。
  // 本機版：檔案放同資料夾即可。雲端版：改用環境變數 GMAIL_CREDENTIALS_JSON（整份json內容）。
  let credsRaw;
  if (fs.existsSync(CREDS_PATH)) credsRaw = fs.readFileSync(CREDS_PATH, 'utf8');
  else if (process.env.GMAIL_CREDENTIALS_JSON) credsRaw = process.env.GMAIL_CREDENTIALS_JSON;
  else throw new Error('找不到 gmail-credentials.json，請先到 Google Cloud Console 下載');
  const creds = JSON.parse(credsRaw);
  const c = creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(
    c.client_id, c.client_secret, `http://localhost:${REDIRECT_PORT}/oauth-callback`
  );

  // 🦞 token 同樣支援環境變數 GMAIL_TOKEN_JSON（雲端主機沒有瀏覽器可以做互動授權，
  //    要先在有瀏覽器的電腦上授權一次，再把 gmail-token.json 的內容貼進環境變數）。
  let tokenRaw = null;
  if (fs.existsSync(TOKEN_PATH)) tokenRaw = fs.readFileSync(TOKEN_PATH, 'utf8');
  else if (process.env.GMAIL_TOKEN_JSON) tokenRaw = process.env.GMAIL_TOKEN_JSON;
  if (tokenRaw) {
    oAuth2Client.setCredentials(JSON.parse(tokenRaw));
    return oAuth2Client;
  }

  if (!interactive) throw new Error('尚未授權，請先執行 設定Gmail.bat');

  // 雲端主機（Render等）沒有瀏覽器，互動授權只能在本機做
  if (process.env.RENDER || !process.stdout.isTTY) {
    throw new Error('尚未授權：雲端環境請設定 GMAIL_TOKEN_JSON 環境變數（先在本機授權一次取得 gmail-token.json）');
  }

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
