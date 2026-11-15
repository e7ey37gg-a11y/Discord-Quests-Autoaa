# Discord OAuth2 Link Bot — Render

## Chức năng
- `/link server_id:<ID>`: người dùng tự đăng nhập Discord và đồng ý cấp quyền `identify guilds.join`.
- `/addsv`: Administrator chạy trong server đích; bot chỉ yêu cầu Discord thêm những người đã tự đồng ý.
- `/listlink`: xem số liên kết và số đang chờ trong server hiện tại.
- `/unlink`: người dùng xóa liên kết và yêu cầu thu hồi refresh token.

Không dùng self-bot hoặc user token.

## 1. Discord Developer Portal
Mở https://discord.com/developers/applications, chọn Application:
- OAuth2 > General: lấy Client ID và Client Secret.
- OAuth2 > General > Redirects: thêm chính xác `https://TEN-SERVICE.onrender.com/oauth/callback`.
- Bot: lấy Bot Token.
- Mời bot vào server đích với scopes `bot` và `applications.commands`. Cấp quyền `Create Instant Invite` cho bot trong server đích.

## 2. Đưa lên GitHub
Upload toàn bộ file trong thư mục này lên repository. Không upload `.env`, token, secret hoặc khóa mã hóa.

## 3. Render
- New > Web Service > kết nối repository.
- Runtime: Docker.
- Dockerfile Path: `./Dockerfile`.
- Tạo Persistent Disk, Mount Path `/data` (nếu muốn giữ dữ liệu SQLite qua deploy/restart).
- Environment Variables:
  - `BOT_TOKEN` = Bot Token
  - `CLIENT_ID` = Application ID
  - `CLIENT_SECRET` = OAuth2 Client Secret
  - `REDIRECT_URI` = `https://TEN-SERVICE.onrender.com/oauth/callback`
  - `TOKEN_ENCRYPTION_KEY` = chuỗi hex 64 ký tự
  - `DB_PATH` = `/data/bot.sqlite`
- Để Render tự cấp `PORT`; không cần đặt thủ công.
- Deploy. Health check URL: `/health`.

Tạo khóa bằng Node:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 4. Chạy local (tùy chọn)
Sao chép `.env.example` thành `.env`, điền giá trị, đặt `REDIRECT_URI=http://localhost:8080/oauth/callback` và `DB_PATH=./data/bot.sqlite`, sau đó:
`npm install`
`npm start`

Dockerfile cài Python/make/g++ trong Linux build image để biên dịch better-sqlite3; không cần Visual Studio trên Windows khi deploy Render bằng Docker.

## Bảo mật và giới hạn
- Không bao giờ commit `.env` hoặc chia sẻ Bot Token, Client Secret, TOKEN_ENCRYPTION_KEY.
- Giữ nguyên `TOKEN_ENCRYPTION_KEY`; đổi khóa sẽ không giải mã được token đã lưu.
- Persistent Disk cần gói Render hỗ trợ disk; không có lưu trữ bền vững thì SQLite có thể mất khi instance bị thay thế.
- Người dùng có thể thu hồi quyền tại Discord User Settings > Authorized Apps.
- `/addsv` xử lý tối đa 50 tài khoản mỗi lần.
