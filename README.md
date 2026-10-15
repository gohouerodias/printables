# Распечатай-это — three paid printable apps (199 ₽ / month each)

| App                            | Address               | What it does                                                                             |
| ------------------------------ | --------------------- | ---------------------------------------------------------------------------------------- |
| Справки о важном | `/app/spravki`      | Joke certificates, diplomas, "fines", passes with a stamp (fictional organisations only) |
| Книжка купонов    | `/app/kupony`       | Tear-off coupon books: couple, friend, parents, 8 March, 23 February, New Year, birthday |
| Родословная         | `/app/rodoslovnaya` | Family tree with funny titles and a generated coat of arms                               |

Each app is a separate 199 ₽ / 30 days subscription. Payment goes through **YooKassa** with automatic renewal.
Users' data is saved to their account, so they can open it on any device.

## Step 1 — Try it on your computer (free, no payment)

1. Install Node.js 22 or newer (https://nodejs.org).
2. In this folder run: `npm install`
3. Copy `.env.example` to `.env` and set `DEV_FREE_ACCESS=1` (leave the rest empty).
4. Run: `npm start` and open http://localhost:3000
5. Register, go to "Личный кабинет", press "Оформить" — with `DEV_FREE_ACCESS=1` you get 30 days free.
6. Automatic tests: `npm test`

## Step 2 — Get a Russian server

1. Rent a small Ubuntu 22.04/24.04 VPS in Russia (Timeweb, Selectel, Beget, REG.RU...). 1 CPU / 1 GB RAM is enough.
   Use a Russian host: personal data of Russian users must be stored in Russia (152-FZ).
2. Buy a domain and point its **A record** to the server's IP address.

## Step 3 — Install on the server

Connect with `ssh root@SERVER_IP`, then:

```bash
# 1. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs nginx certbot python3-certbot-nginx

# 2. Upload this project to /opt/printables (scp, or git clone), then:
cd /opt/printables
npm install --omit=dev
cp .env.example .env
nano .env      # set BASE_URL, YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY. Keep DEV_FREE_ACCESS=0 !
```

Create `/etc/systemd/system/printables.service`:

```ini
[Unit]
Description=Printables
After=network.target

[Service]
WorkingDirectory=/opt/printables
ExecStart=/usr/bin/node --no-warnings server.js
Restart=always
User=www-data
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
chown -R www-data:www-data /opt/printables
systemctl daemon-reload && systemctl enable --now printables
```

Create `/etc/nginx/sites-available/printables` (replace `your-domain.ru`):

```nginx
server {
  server_name your-domain.ru;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
ln -s /etc/nginx/sites-available/printables /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d your-domain.ru     # free HTTPS
```

## Step 4 — Connect YooKassa (payments)

1. Register at https://yookassa.ru and create a shop. You can work as self-employed (самозанятый), IP or a company.
2. In the shop: **Интеграция → Ключи API** → copy *shopId* and a *secret key* into `.env`, then `systemctl restart printables`.
3. **Интеграция → HTTP-уведомления**: add `https://your-domain.ru/api/yookassa/webhook`
   and tick the events `payment.succeeded` and `payment.canceled`.
4. Automatic renewals (saving the card and charging it later) must be enabled for your shop by YooKassa.
   Ask YooKassa support to enable **автоплатежи / recurring payments**. Until then the first payment works,
   but renewals will not be charged.
5. Receipts: self-employed issue them in "Мой налог". If you use YooKassa's online cash register, set `YOOKASSA_RECEIPT=1`.
6. Test with YooKassa's **test shop** first (separate test keys and test cards), then switch to live keys.

## Step 5 — Before you take real money

1. Edit `public/offer.html` and `public/privacy.html`: fill the `[square brackets]` with your details and refund terms.
   They are templates. Have a lawyer read them.
2. Check the print preview of each app in Chrome (Ctrl+P): set margins to "None" and tick "Background graphics".
3. Make a test purchase with your own card and refund it.

## How it works

- `/app/<name>` is served only if the logged-in user has an active subscription for that app. Without it, they are redirected to the account page.
- YooKassa tells the server about a payment through the webhook; the server asks YooKassa directly to confirm the payment before giving access, so fake webhooks cannot grant free access.
- Every hour the server tries to charge the saved card for subscriptions that end within 24 hours. If the charge fails, access simply ends on the expiry date.
- Users can turn off auto-renewal in their account; access stays until the paid period ends.
- Data: SQLite file `data/app.db`. **Back it up** (copy the `data` folder daily).

## Safety rules built into the apps

- «Справки о важном» refuses to print if the issuing organisation looks like a real government body or bank (МВД, ФНС, Сбербанк...). Every sheet carries a permanent line "Шуточный документ · не имеет юридической силы".
