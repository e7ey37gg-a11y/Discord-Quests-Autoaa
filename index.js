import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, Events
} from 'discord.js';

const env = (name) => process.env[name]?.trim();
const BOT_TOKEN = env('BOT_TOKEN');
const CLIENT_ID = env('CLIENT_ID');
const CLIENT_SECRET = env('CLIENT_SECRET');
const REDIRECT_URI = env('REDIRECT_URI');
const KEY_HEX = env('TOKEN_ENCRYPTION_KEY');
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || './data/bot.sqlite';
const API = 'https://discord.com/api/v10';

for (const [name, value] of Object.entries({
  BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, TOKEN_ENCRYPTION_KEY: KEY_HEX
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}
if (!/^[a-fA-F0-9]{64}$/.test(KEY_HEX)) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
}
const encryptionKey = Buffer.from(KEY_HEX, 'hex');
const redirect = new URL(REDIRECT_URI);
if (!['http:', 'https:'].includes(redirect.protocol)) throw new Error('Invalid REDIRECT_URI.');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS linked_accounts (
    user_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    token_data TEXT NOT NULL,
    joined_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_linked_guild ON linked_accounts(guild_id, joined_at);
`);

const q = {
  getAccount: db.prepare('SELECT * FROM linked_accounts WHERE user_id=?'),
  saveAccount: db.prepare(`INSERT INTO linked_accounts(user_id,guild_id,token_data,joined_at,updated_at)
    VALUES(?,?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET
    guild_id=excluded.guild_id, token_data=excluded.token_data,
    joined_at=NULL, updated_at=excluded.updated_at`),
  pending: db.prepare(`SELECT * FROM linked_accounts WHERE guild_id=? AND joined_at IS NULL
    ORDER BY updated_at LIMIT 50`),
  markJoined: db.prepare('UPDATE linked_accounts SET joined_at=?,updated_at=? WHERE user_id=?'),
  remove: db.prepare('DELETE FROM linked_accounts WHERE user_id=?'),
  saveState: db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?)'),
  getState: db.prepare('SELECT * FROM oauth_states WHERE state_hash=?'),
  delState: db.prepare('DELETE FROM oauth_states WHERE state_hash=?'),
  total: db.prepare('SELECT COUNT(*) AS n FROM linked_accounts WHERE guild_id=?'),
  waiting: db.prepare('SELECT COUNT(*) AS n FROM linked_accounts WHERE guild_id=? AND joined_at IS NULL')
};

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypt(value) {
  const data = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
}
async function tokenRequest(params) {
  const response = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.message || `OAuth HTTP ${response.status}`);
  return data;
}
async function revoke(refreshToken) {
  if (!refreshToken) return;
  try {
    await fetch(`${API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        token: refreshToken, token_type_hint: 'refresh_token'
      })
    });
  } catch (e) { console.error('Token revoke failed:', e.message); }
}
async function getUser(accessToken) {
  const r = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error('Could not verify the authorized Discord account.');
  return r.json();
}
async function freshTokens(account) {
  let t = decrypt(account.token_data);
  if (t.expires_at > Date.now() + 60000) return t;
  const r = await tokenRequest({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token', refresh_token: t.refresh_token
  });
  t = { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + r.expires_in * 1000 };
  q.saveAccount.run(account.user_id, account.guild_id, encrypt(t), Date.now());
  return t;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Tự liên kết tài khoản và đồng ý tham gia server')
    .addStringOption(o => o.setName('server_id').setDescription('ID server đích').setRequired(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Hủy liên kết tài khoản OAuth2'),
  new SlashCommandBuilder().setName('listlink').setDescription('Xem số tài khoản đã liên kết')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('addsv').setDescription('Thêm tài khoản đã đồng ý vào server hiện tại')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(c => c.toJSON());

async function checkBotInGuild(guildId) {
  const guild = await client.guilds.fetch(guildId);
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
    throw new Error('Bot cần quyền Create Instant Invite trong server đích.');
  }
  return guild;
}

const app = express();
app.disable('x-powered-by');
app.get('/', (_req, res) => res.send('Discord OAuth bot is running.'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send('Bạn đã từ chối hoặc hủy cấp quyền OAuth2.');
  if (typeof code !== 'string' || typeof state !== 'string') return res.status(400).send('Thiếu code/state.');
  const hash = crypto.createHash('sha256').update(state).digest('hex');
  const saved = q.getState.get(hash);
  if (!saved) return res.status(400).send('State không hợp lệ hoặc đã được sử dụng.');
  q.delState.run(hash);
  if (saved.expires_at < Date.now()) return res.status(400).send('Yêu cầu hết hạn. Hãy chạy /link lại.');

  let refreshToken;
  try {
    const t = await tokenRequest({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI
    });
    refreshToken = t.refresh_token;
    const scopes = String(t.scope || '').split(/\s+/);
    if (!scopes.includes('identify') || !scopes.includes('guilds.join')) {
      await revoke(refreshToken);
      return res.status(400).send('Bạn cần đồng ý cả quyền identify và guilds.join. Hãy chạy /link lại.');
    }
    const user = await getUser(t.access_token);
    if (user.id !== saved.user_id) {
      await revoke(refreshToken);
      return res.status(403).send('Tài khoản đăng nhập không khớp tài khoản đã chạy /link.');
    }
    const old = q.getAccount.get(user.id);
    if (old) await revoke(decrypt(old.token_data).refresh_token);
    q.saveAccount.run(user.id, saved.guild_id, encrypt({
      access_token: t.access_token, refresh_token: t.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000
    }), Date.now());
    return res.type('html').send('<meta charset="utf-8"><h2>Liên kết thành công!</h2><p>Quay lại Discord. Quản trị viên có thể chạy /addsv trong server đã chọn.</p>');
  } catch (e) {
    if (refreshToken) await revoke(refreshToken);
    console.error('OAuth callback:', e.message);
    return res.status(500).send('Không thể hoàn tất liên kết. Hãy chạy /link lại.');
  }
});

client.once(Events.ClientReady, async c => {
  console.log(`Bot online: ${c.user.tag}`);
  try {
    await new REST({ version: '10' }).setToken(BOT_TOKEN)
      .put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (e) { console.error('Command registration failed:', e.message); }
});

client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === 'link') {
      const guildId = i.options.getString('server_id', true).trim();
      if (!/^\d{17,20}$/.test(guildId)) return i.reply({ content: 'Server ID không hợp lệ.', ephemeral: true });
      await i.deferReply({ ephemeral: true });
      await checkBotInGuild(guildId);
      const state = crypto.randomBytes(32).toString('hex');
      q.saveState.run(crypto.createHash('sha256').update(state).digest('hex'),
        i.user.id, guildId, Date.now() + 10 * 60 * 1000);
      const url = new URL('https://discord.com/oauth2/authorize');
      url.search = new URLSearchParams({
        client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI,
        scope: 'identify guilds.join', state, prompt: 'consent'
      }).toString();
      return i.editReply(`Mở link để tự đăng nhập và đồng ý cấp quyền:\n${url}\nServer đích: ${guildId}\nLink hết hạn sau 10 phút.`);
    }
    if (i.commandName === 'unlink') {
      await i.deferReply({ ephemeral: true });
      const a = q.getAccount.get(i.user.id);
      if (!a) return i.editReply('Bạn chưa liên kết tài khoản.');
      q.remove.run(i.user.id);
      await revoke(decrypt(a.token_data).refresh_token);
      return i.editReply('Đã xóa liên kết và gửi yêu cầu thu hồi quyền OAuth2.');
    }
    if (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return i.reply({ content: 'Lệnh này chỉ dành cho Administrator trong server.', ephemeral: true });
    }
    if (i.commandName === 'listlink') {
      return i.reply({ content: `Đã liên kết: ${q.total.get(i.guildId).n}\nĐang chờ: ${q.waiting.get(i.guildId).n}`, ephemeral: true });
    }
    if (i.commandName === 'addsv') {
      await i.deferReply({ ephemeral: true });
      await checkBotInGuild(i.guildId);
      const accounts = q.pending.all(i.guildId);
      if (!accounts.length) return i.editReply('Không có tài khoản nào đang chờ trong server này.');
      let added = 0, failed = 0, already = 0;
      for (const a of accounts) {
        try {
          const t = await freshTokens(a);
          const result = await client.rest.put(Routes.guildMember(i.guildId, a.user_id), {
            body: { access_token: t.access_token }
          });
          q.markJoined.run(Date.now(), Date.now(), a.user_id);
          if (result == null) already++; else added++;
        } catch (e) {
          failed++;
          console.error(`Add member ${a.user_id}:`, e.message);
        }
      }
      return i.editReply(`Đã xử lý tối đa 50 tài khoản.\nThêm mới: ${added}\nĐã ở server/đã xử lý: ${already}\nThất bại: ${failed}\nCòn chờ: ${q.waiting.get(i.guildId).n}`);
    }
  } catch (e) {
    console.error('Command error:', e);
    const msg = `Có lỗi: ${e.message}`;
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
    else await i.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`HTTP server listening on ${PORT}`));
client.login(BOT_TOKEN).catch(e => {
  console.error('Discord login failed:', e.message);
  server.close();
  process.exit(1);
});
process.on('SIGTERM', () => {
  server.close();
  client.destroy();
  db.close();
});
