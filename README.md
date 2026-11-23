# insta-node-js

Client pentru **Instagram Private API** scris în **TypeScript** pentru **Node.js**, cu suport **realtime MQTT** (Direct live, typing, seen, presence) și **FBNS push notifications**.

> 🇬🇧 *Instagram Private API client for Node.js written in TypeScript, with realtime MQTT (MQTToT) and FBNS push support. English section below.*

Acoperă tot API-ul `instagrapi`: login (inclusiv 2FA/TOTP, challenge resolver, sessionid), utilizatori, followers/following, media, comentarii, like-uri, upload foto/video/album/reels/IGTV/story, story-uri, highlights, colecții, hashtag-uri, locații, Direct (text, media, voice, reacții, thread-uri), notes, insights, notificări, căutare, track-uri muzicale, cross-posting Facebook, signup și multiple conturi.

---

## Cuprins

- [Cerințe](#cerințe)
- [Instalare](#instalare)
- [Dependențe](#dependențe)
- [Start rapid](#start-rapid)
- [Sesiuni și setări](#sesiuni-și-setări)
- [Proxy](#proxy)
- [Exemple](#exemple)
- [Realtime MQTT](#realtime-mqtt)
- [FBNS push notifications](#fbns-push-notifications)
- [Excepții](#excepții)
- [Convenții](#convenții)
- [English](#english)
- [Licență](#licență)

---

## Cerințe

- **Node.js ≥ 18.17**
- Opțional: **ffmpeg** / **ffprobe** pentru upload video, reels, IGTV, story video și `StoryBuilder`. Se instalează automat prin `ffmpeg-static` / `ffprobe-static`, sau se folosește binarul din sistem (`PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`).

## Instalare

```bash
npm install github:Kunboruto20/Insta-node-js
```

Sau local, din sursă:

```bash
git clone https://github.com/Kunboruto20/Insta-node-js.git
```

```bash
cd Insta-node-js && npm install && npm run build
```

## Dependențe

| Pachet | Rol |
| --- | --- |
| [`undici`](https://www.npmjs.com/package/undici) | client HTTP (HTTP/1.1 + HTTP/2, keep-alive, proxy HTTP/HTTPS) |
| [`fetch-socks`](https://www.npmjs.com/package/fetch-socks) | proxy SOCKS4/SOCKS5 pentru requesturile HTTP |
| [`socks`](https://www.npmjs.com/package/socks) | proxy SOCKS pentru conexiunile MQTT realtime/FBNS |
| [`sharp`](https://www.npmjs.com/package/sharp) | procesare imagini (resize, crop, conversie JPEG, thumbnail-uri) |
| `ffmpeg-static` *(opțional)* | ffmpeg pentru procesare video |
| `ffprobe-static` *(opțional)* | ffprobe pentru metadate video |

Dev: `typescript`, `tsx`, `@types/node`.

Protocolul MQTT (MQTToT + Thrift compact) este implementat nativ în bibliotecă (`net`/`tls`/`zlib`), fără bibliotecă MQTT externă.

## Start rapid

```ts
import { Client } from 'insta-node-js';

const cl = new Client();
await cl.login('USERNAME', 'PASSWORD');

const user = await cl.userInfoByUsername('instagram');
console.log(user.pk, user.full_name, user.follower_count);

const medias = await cl.userMedias(user.pk, 10);
for (const m of medias) console.log(m.code, m.like_count);
```

CommonJS:

```js
const { Client } = require('insta-node-js');
```

Toate metodele care fac request-uri sunt `async` și întorc `Promise`.

## Sesiuni și setări

Reutilizează sesiunea ca să nu te loghezi de fiecare dată (formatul JSON e compatibil cu `dump_settings()` din instagrapi):

```ts
import { existsSync } from 'fs';
import { Client, LoginRequired } from 'insta-node-js';

const cl = new Client();
if (existsSync('session.json')) {
  await cl.loadSettings('session.json');
}
await cl.login('USERNAME', 'PASSWORD');
try {
  await cl.getTimelineFeed(); // verifică dacă sesiunea e validă
} catch (e) {
  if (e instanceof LoginRequired) {
    await cl.relogin();
  } else throw e;
}
await cl.dumpSettings('session.json');
```

Alte variante de login:

```ts
await cl.loginBySessionid('SESSIONID_DIN_BROWSER');

// 2FA cu TOTP
const code = cl.totpGenerateCode('SEED_TOTP');
await cl.login('USERNAME', 'PASSWORD', false, code);
```

Challenge (cod pe email/SMS) — handler propriu:

```ts
cl.challengeCodeHandler = async (username, choice) => {
  // citește codul din email/SMS/console
  return '123456';
};
```

Opțiuni constructor:

```ts
const cl = new Client({
  proxy: 'http://user:pass@host:port',
  delayRange: [1, 3],          // pauză aleatoare (secunde) între request-uri
  requestTimeout: 30,
  timezoneOffset: 7200,
  settings: savedSettings,     // obiect din getSettings()
});
cl.setLocale('ro_RO');
cl.setCountry('RO');
```

## Proxy

```ts
cl.setProxy('http://user:pass@1.2.3.4:8080');
cl.setProxy('socks5://user:pass@1.2.3.4:1080');
cl.setProxy(null); // dezactivează
```

Proxy-ul este folosit și de conexiunile realtime MQTT / FBNS (`http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`).

## Exemple

### Utilizatori

```ts
const id = await cl.userIdFromUsername('instagram');
const info = await cl.userInfo(id);
const followers = await cl.userFollowers(id, true, 100);   // Map<pk, UserShort>
const following = await cl.userFollowing(id, true, 100);
await cl.userFollow(id);
await cl.userUnfollow(id);
const found = await cl.searchUsers('nasa');
```

### Media, like, comentarii

```ts
const pk = cl.mediaPkFromCode('B1LbfVPlwIA');
const media = await cl.mediaInfo(pk);
await cl.mediaLike(media.id);
const comment = await cl.mediaComment(media.id, 'Super! 🔥');
const comments = await cl.mediaComments(media.id, 50);
await cl.commentLike(comment.pk);
```

### Upload

```ts
await cl.photoUpload('poza.jpg', 'Descriere #tag');
await cl.videoUpload('video.mp4', 'Video nou');
await cl.albumUpload(['1.jpg', '2.jpg', '3.mp4'], 'Album');
await cl.clipUpload('reel.mp4', 'Reel nou');
await cl.photoUploadToStory('story.jpg');
await cl.videoUploadToStory('story.mp4');
```

### Download

```ts
const file = await cl.photoDownload(pk, './downloads');
await cl.videoDownload(videoPk, './downloads');
await cl.albumDownload(albumPk, './downloads');
```

### Story-uri și highlights

```ts
const stories = await cl.userStories(id);
await cl.storySeen(stories.map((s) => s.pk));
const highlights = await cl.userHighlights(id);
```

### Direct

```ts
const threads = await cl.directThreads(20);
const messages = await cl.directMessages(threads[0].id, 20);
await cl.directSend('Salut!', [userId]);
await cl.directSend('Răspuns în thread', [], [threads[0].id]);
await cl.directSendPhoto('poza.jpg', [userId]);
console.log(threads[0].isSeen(cl.userId!));
```

### Hashtag-uri și locații

```ts
const top = await cl.hashtagMediasTop('romania', 9);
const recent = await cl.hashtagMediasRecent('romania', 20);
const places = await cl.fbsearchPlaces('Bucuresti');
```

### Paginare manuală (chunk-uri)

Metodele `*Chunk` întorc `[items, cursor]`, ca în instagrapi:

```ts
let cursor: string | null = null;
do {
  const [medias, next] = await cl.userMediasChunkGql(userId, 2, cursor);
  for (const m of medias) console.log(m.code);
  cursor = next;
} while (cursor);
```

## Realtime MQTT

Conexiune MQTToT la `edge-mqtt.facebook.com` pentru evenimente live după login.

```ts
import { Client } from 'insta-node-js';

const cl = new Client();
await cl.loadSettings('session.json');
await cl.login('USERNAME', 'PASSWORD');

cl.realtimeOn('message', (payload) => {
  console.log('Mesaj nou:', JSON.stringify(payload, null, 2));
});
cl.realtimeOn('typing', (ev) => console.log('scrie...', ev.thread_id));
cl.realtimeOn('seen', (ev) => console.log('văzut', ev.thread_id));
cl.realtimeOn('presence', (ev) => console.log('presence', ev));
cl.realtimeOn('receive', ({ topic, payload }) => console.log(topic, payload));

const rt = await cl.realtimeConnect();
await rt.directSubscribe(); // sincronizare Direct (seq_id + snapshot)

// keepalive
setInterval(() => cl.realtimePing().catch(console.error), 60_000);

process.on('SIGINT', async () => {
  await cl.realtimeDisconnect();
  process.exit(0);
});

while (true) {
  try {
    await cl.realtimeReadOnce();
  } catch (e: any) {
    if (e.name === 'TimeoutError') continue; // nicio activitate în 30s
    throw e;
  }
}
```

Acțiuni Direct prin MQTT:

```ts
await rt.directSendText(threadId, 'Salut prin MQTT');
await rt.directSendReaction(threadId, itemId, '❤️');
await rt.directIndicateActivity(threadId, true); // typing
await rt.directMarkSeen(threadId, itemId);
await rt.sendForegroundState({ inForegroundApp: true, inForegroundDevice: true, keepAliveTimeout: 60 });
```

Subscripții brute:

```ts
await rt.graphQlSubscribe(['<graphql-subscription>']);
await rt.skywalkerSubscribe(['<skywalker-subscription>']);
await rt.irisSubscribe(seqId, snapshotAtMs);
await rt.publishJson('132', { action: 'send_item' /* ... */ });
```

Evenimente realtime:

| Eveniment | Când |
| --- | --- |
| `receive` | fiecare pachet publish decodat: `{ topic, payload }` |
| `message` | payload-uri message-sync din Direct (`/direct_v2/threads/...`) |
| `thread_update` | alte patch-uri message-sync |
| `iris` | elemente message-sync care nu sunt patch-uri |
| `direct` | evenimente Direct parsate (message-sync sau realtime-sub) |
| `typing`, `seen`, `presence` | evenimente Direct clasificate |
| `send_response` | răspuns la comenzile Direct trimise prin MQTT |
| `iris_sub_response` | răspuns la subscripția Iris |
| `realtime_sub` | payload-uri GraphQL/Skywalker |

Handler-ele pot fi și `async`; sunt apelate în ordine și așteptate.

## FBNS push notifications

Conexiune separată (device-auth) la `mqtt-mini.facebook.com`:

```ts
cl.fbnsOn('push', (push) => console.log('PUSH', push.message, push.collapse_key));
cl.fbnsOn('direct_v2_message', (push) => console.log('DM nou!', push));

const fbns = await cl.fbnsConnect(); // conectare + înregistrare token push
await cl.dumpSettings('session.json'); // salvează settings.fbns_auth

while (true) {
  try {
    await cl.fbnsReadOnce();
  } catch (e: any) {
    if (e.name === 'TimeoutError') {
      await cl.fbnsPing();
      continue;
    }
    throw e;
  }
}
```

Evenimente FBNS: `auth`, `registered`, `reg_response`, `push`, `<collapse_key>`, `message`, `logging`, `pp`, `receive`.

## Excepții

Toate excepțiile din instagrapi există cu același nume și aceeași ierarhie:

```ts
import {
  ClientError, LoginRequired, ChallengeRequired, TwoFactorRequired, BadPassword,
  PleaseWaitFewMinutes, RateLimitError, FeedbackRequired, UserNotFound, MediaNotFound,
} from 'insta-node-js';

cl.handleException = async (client, e) => {
  if (e instanceof ChallengeRequired) {
    // rezolvă challenge
  } else if (e instanceof PleaseWaitFewMinutes) {
    // așteaptă / schimbă proxy
  }
  throw e;
};
```

## Convenții

Diferențe față de instagrapi (Python):

- metodele sunt **camelCase** (`user_info_by_username` → `userInfoByUsername`) și **async**;
- câmpurile modelelor rămân **snake_case** (`user.full_name`, `media.like_count`), ca în răspunsurile Instagram și în instagrapi;
- ID-urile (`pk`, `id`) sunt **string** (pot depăși `Number.MAX_SAFE_INTEGER`);
- argumentele opționale numerite din Python sunt grupate în obiecte `opts` acolo unde sunt multe (ex. `photoUpload(path, caption, { usertags, location })`);
- `sharp` înlocuiește Pillow, iar `ffmpeg` înlocuiește MoviePy;
- `privateTransport: 'utls'` folosește TLS 1.3 + HTTP/2 nativ din Node (amprenta TLS uTLS din Go nu poate fi reprodusă în Node).

## English

**insta-node-js** is a complete TypeScript port of the Python `instagrapi` library for Node.js ≥ 18.17.

```ts
import { Client } from 'insta-node-js';

const cl = new Client();
await cl.login('USERNAME', 'PASSWORD');
await cl.dumpSettings('session.json');

const user = await cl.userInfoByUsername('instagram');
await cl.photoUpload('photo.jpg', 'Hello from Node.js');

// realtime MQTT
cl.realtimeOn('message', (msg) => console.log(msg));
const rt = await cl.realtimeConnect();
await rt.directSubscribe();
for (;;) await cl.realtimeReadOnce().catch((e) => { if (e.name !== 'TimeoutError') throw e; });
```

- Methods: camelCase + async; model fields: snake_case; IDs: strings.
- Settings JSON is compatible with instagrapi's `dump_settings()` / `load_settings()`.
- Dependencies: `undici`, `fetch-socks`, `socks`, `sharp`; optional `ffmpeg-static`, `ffprobe-static`.
- Scripts: `npm run build`, `npm run typecheck`, `npm test`.

> ⚠️ This is an unofficial library. Automating Instagram accounts may violate Instagram's Terms of Use. Use responsibly and at your own risk.

## Licență

MIT © Kunboruto20. Vezi [LICENSE](LICENSE) (include notițele de copyright ale proiectelor originale instagrapi și instagram_mqtt, conform licenței MIT).
