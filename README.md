# insta-node-js

A complete **Instagram Private API** client for **Node.js**, written in **TypeScript**.

- Full mobile API coverage: login (2FA / TOTP, challenges, session reuse), users, followers, media, comments, likes, uploads (photo, video, album, Reels, IGTV, stories), downloads, stories, highlights, collections, hashtags, locations, Direct, notes, insights, notifications, search, music, Facebook/Threads cross-posting, signup and multiple accounts.
- **Realtime MQTT** (MQTToT): live Direct messages, typing, seen and presence events, and sending Direct actions over MQTT.
- **FBNS push notifications** over MQTT.
- Native MQTT/Thrift implementation (no MQTT library needed).
- Every error is a [**Boom**](https://www.npmjs.com/package/@hapi/boom) error with an HTTP-like status code.
- Typed models, async API, HTTP/SOCKS proxies, persistent sessions.

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Dependencies](#dependencies)
- [Quick start](#quick-start)
- [Conventions](#conventions)
- [Client options](#client-options)
- [Authentication](#authentication)
  - [Login with username and password](#login-with-username-and-password)
  - [Saving and reusing the session](#saving-and-reusing-the-session)
  - [Login with a sessionid](#login-with-a-sessionid)
  - [Two-factor authentication](#two-factor-authentication)
  - [Challenges (email / SMS codes)](#challenges-email--sms-codes)
  - [Captcha](#captcha)
  - [Logout](#logout)
- [Proxy](#proxy)
- [Device, locale and timezone](#device-locale-and-timezone)
- [Account](#account)
- [Users](#users)
- [Media](#media)
- [Comments](#comments)
- [Uploading](#uploading)
- [Stories](#stories)
- [Downloading](#downloading)
- [Highlights](#highlights)
- [Collections](#collections)
- [Hashtags](#hashtags)
- [Locations](#locations)
- [Search](#search)
- [Direct messages](#direct-messages)
- [Notes](#notes)
- [Insights](#insights)
- [Explore, Reels and music](#explore-reels-and-music)
- [Pagination](#pagination)
- [Realtime MQTT](#realtime-mqtt)
- [FBNS push notifications](#fbns-push-notifications)
- [Error handling (Boom)](#error-handling-boom)
- [Logging](#logging)
- [Models](#models)
- [Building and publishing](#building-and-publishing)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## Requirements

- **Node.js 18.17 or newer**
- Optional: **ffmpeg** and **ffprobe** for video processing (video, Reels, IGTV and video story uploads, `StoryBuilder`). They are installed automatically through the optional packages `ffmpeg-static` and `ffprobe-static`. A system binary also works (found on `PATH`, or set `FFMPEG_PATH` / `FFPROBE_PATH`).

## Installation

From npm:

```bash
npm install insta-node-js
```

The npm package name is lowercase (`insta-node-js`), as npm requires; the GitHub repository is `Kunboruto20/Insta-node-js`.

Latest version from GitHub (compiled automatically during install):

```bash
npm install github:Kunboruto20/Insta-node-js
```

From source:

```bash
git clone https://github.com/Kunboruto20/Insta-node-js.git
```

```bash
cd Insta-node-js && npm install
```

`npm install` also compiles the TypeScript sources into `dist/`.

## Dependencies

| Package | Purpose |
| --- | --- |
| [`undici`](https://www.npmjs.com/package/undici) | HTTP client (HTTP/1.1 and HTTP/2, keep-alive, HTTP/HTTPS proxies) |
| [`fetch-socks`](https://www.npmjs.com/package/fetch-socks) | SOCKS4 / SOCKS5 proxies for HTTP requests |
| [`socks`](https://www.npmjs.com/package/socks) | SOCKS proxies for the realtime / FBNS MQTT connections |
| [`sharp`](https://www.npmjs.com/package/sharp) | Image processing (resize, crop, JPEG conversion, thumbnails) |
| [`@hapi/boom`](https://www.npmjs.com/package/@hapi/boom) | Errors with HTTP status codes |
| `ffmpeg-static` *(optional)* | ffmpeg binary for video processing |
| `ffprobe-static` *(optional)* | ffprobe binary for video metadata |

## Quick start

```ts
import { Client } from 'insta-node-js';

async function main() {
  const cl = new Client();
  await cl.login('USERNAME', 'PASSWORD');

  const user = await cl.userInfoByUsername('instagram');
  console.log(user.pk, user.full_name, user.follower_count);

  const medias = await cl.userMedias(user.pk, 10);
  for (const media of medias) {
    console.log(media.code, media.like_count, media.caption_text);
  }
}

main().catch(console.error);
```

CommonJS:

```js
const { Client } = require('insta-node-js');
```

## Conventions

- **Methods are camelCase and async.** Every method that talks to Instagram returns a `Promise`.
- **Model fields are snake_case**, exactly as Instagram returns them: `user.full_name`, `media.like_count`, `media.taken_at`.
- **IDs are strings** (`user.pk`, `media.pk`, `media.id`), because they can exceed `Number.MAX_SAFE_INTEGER`. Methods accept strings or numbers.
- `media.pk` is the numeric media id (`3141592653589793238`). `media.id` is `"<media_pk>_<owner_pk>"`. Most media methods accept either.
- Methods with many optional arguments take an options object as the last parameter (for example `photoUpload(path, caption, { usertags, location })`).
- Errors are Boom errors (see [Error handling](#error-handling-boom)).

## Client options

```ts
import { Client } from 'insta-node-js';

const cl = new Client({
  proxy: 'http://user:pass@1.2.3.4:8080', // HTTP, HTTPS, SOCKS4 or SOCKS5 proxy
  delayRange: [1, 3],                      // random pause (seconds) before each private request
  requestTimeout: 1,                       // pause (seconds) between retried requests
  timezoneOffset: 7200,                    // seconds from UTC
  timezoneName: 'Europe/Bucharest',
  pushDisabled: false,
  tlsVerify: true,                         // or a path to a CA bundle
  privateTransport: 'http2',               // 'http1' | 'http2' | 'mobile'
  publicTransport: 'http1',                // 'http1' | 'http2'
  sessionRetryTotal: 3,
  sessionRetryBackoffFactor: 2,
  sessionRetryStatuses: [500, 502, 503, 504],
});
```

All options are optional. `settings` accepts an object previously returned by `getSettings()`; `logger` accepts a custom logger (see [Logging](#logging)).

## Authentication

### Login with username and password

```ts
const cl = new Client();
await cl.login('USERNAME', 'PASSWORD');
console.log(cl.userId, cl.username);
```

### Saving and reusing the session

Logging in every time is slow and looks suspicious to Instagram. Save the session once and reuse it:

```ts
import { existsSync } from 'fs';
import { Client, LoginRequired } from 'insta-node-js';

const SESSION_FILE = 'session.json';

async function getClient(): Promise<Client> {
  const cl = new Client();
  if (existsSync(SESSION_FILE)) {
    await cl.loadSettings(SESSION_FILE); // restores cookies, device and uuids
  }
  await cl.login('USERNAME', 'PASSWORD'); // reuses the session when it is still valid

  try {
    await cl.getTimelineFeed(); // check that the session works
  } catch (err) {
    if (err instanceof LoginRequired) {
      await cl.relogin(); // fresh login with the same device
    } else {
      throw err;
    }
  }

  await cl.dumpSettings(SESSION_FILE);
  return cl;
}
```

Settings can also be kept in memory or in a database:

```ts
const settings = cl.getSettings(); // plain JSON object
// ... store it ...
const cl2 = new Client({ settings });
// or: cl2.setSettings(settings);
```

### Login with a sessionid

Use the `sessionid` cookie from a logged-in browser or app:

```ts
await cl.loginBySessionid('1234567890%3AabcdEFGH...');
```

### Two-factor authentication

With an authenticator app (TOTP), generate the code from the seed:

```ts
const code = cl.totpGenerateCode('YOUR_TOTP_SEED');
await cl.login('USERNAME', 'PASSWORD', false, code);
```

With a code received by SMS / WhatsApp / app, pass it as `verificationCode`:

```ts
import { TwoFactorRequired } from 'insta-node-js';

try {
  await cl.login('USERNAME', 'PASSWORD');
} catch (err) {
  if (err instanceof TwoFactorRequired) {
    const smsCode = '123456'; // read it from the user
    await cl.login('USERNAME', 'PASSWORD', false, smsCode);
  } else {
    throw err;
  }
}
```

Enable TOTP on your own account:

```ts
const seed = await cl.totpGenerateSeed();             // add this seed to your authenticator app
const backupCodes = await cl.totpEnable(cl.totpGenerateCode(seed));
await cl.totpDisable();
```

### Challenges (email / SMS codes)

When Instagram asks for a security code, the client calls `challengeCodeHandler`. By default it reads the code from the terminal. Provide your own handler to read it from email, a database, a bot, etc.:

```ts
import { ChallengeChoice } from 'insta-node-js';

cl.challengeCodeHandler = async (username, choice) => {
  if (choice === ChallengeChoice.EMAIL) {
    return await readCodeFromEmail(username);
  }
  return await readCodeFromSms(username);
};

// when Instagram forces a password change during a challenge
cl.changePasswordHandler = async (username) => 'NEW_STRONG_PASSWORD';

declare function readCodeFromEmail(username: string): Promise<string>;
declare function readCodeFromSms(username: string): Promise<string>;
```

### Captcha

```ts
cl.setCaptchaHandler(async (details) => {
  // solve details (site key, url, ...) with your captcha service and return the token
  return 'CAPTCHA_TOKEN';
});
```

### Logout

```ts
await cl.logout();
```

## Proxy

```ts
cl.setProxy('http://user:pass@1.2.3.4:8080');
cl.setProxy('socks5://user:pass@1.2.3.4:1080');
cl.setProxy(null); // no proxy
```

The proxy is used for every connection the client makes: API and web requests, media downloads (including images passed to uploads as URLs) and the realtime / FBNS MQTT connections (`http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`).

## Device, locale and timezone

```ts
cl.setLocale('en_US');
cl.setCountry('US');
cl.setCountryCode(1);
cl.setTimezoneOffset(-5 * 3600, 'America/New_York');

cl.setDevice({
  manufacturer: 'samsung',
  model: 'SM-S918B',
  device: 'dm3q',
  android_version: 34,
  android_release: '14',
  dpi: '480dpi',
  resolution: '1080x2340',
  cpu: 'qcom',
});
cl.setUserAgent(); // rebuild the user agent from the device settings
```

Change these **before** the first login and keep them stable afterwards (they are saved in the settings).

## Account

```ts
const me = await cl.accountInfo();
console.log(me.username, me.email, me.phone_number);

await cl.accountSetBiography('Hello from Node.js');
await cl.accountChangePicture('./avatar.jpg');
await cl.accountEdit({ full_name: 'New Name', external_url: 'https://example.com' });
await cl.accountSetPrivate();
await cl.accountSetPublic();
await cl.changePassword('OLD_PASSWORD', 'NEW_PASSWORD');
```

## Users

```ts
const userId = await cl.userIdFromUsername('instagram');
const user = await cl.userInfo(userId);
const sameUser = await cl.userInfoByUsername('instagram');

console.log(user.username, user.follower_count, user.following_count, user.media_count, user.biography);

// followers / following are Maps keyed by user pk
const followers = await cl.userFollowers(userId, true, 100);
for (const [pk, follower] of followers) console.log(pk, follower.username);

const following = await cl.userFollowing(userId, true, 100);

await cl.userFollow(userId);
await cl.userUnfollow(userId);
await cl.userRemoveFollower(userId);
await cl.userBlock(userId);
await cl.userUnblock(userId);
await cl.closeFriendAdd(userId);

const medias = await cl.userMedias(userId, 20);
const reels = await cl.userClips(userId, 20);
const results = await cl.searchUsers('nasa');
```

## Media

```ts
const pk = cl.mediaPkFromCode('B1LbfVPlwIA');               // from a shortcode
const pkFromUrl = await cl.mediaPkFromUrl('https://www.instagram.com/p/B1LbfVPlwIA/');
const code = cl.mediaCodeFromPk(pk);

const media = await cl.mediaInfo(pk);
console.log(media.media_type, media.product_type, media.caption_text, media.like_count, media.comment_count);
// media_type: 1 photo, 2 video (product_type 'feed' | 'igtv' | 'clips'), 8 album

const owner = await cl.mediaUser(pk);
const likers = await cl.mediaLikers(media.id);

await cl.mediaLike(media.id);
await cl.mediaUnlike(media.id);
await cl.mediaSave(media.id);
await cl.mediaArchive(media.id);
await cl.mediaEdit(media.id, 'New caption #tag');
await cl.mediaDelete(media.id);
await cl.mediaSeen([media.id]);
```

## Comments

```ts
const comments = await cl.mediaComments(media.id, 50);
for (const c of comments) console.log(c.user.username, c.text);

const comment = await cl.mediaComment(media.id, 'Nice! 🔥');
await cl.mediaComment(media.id, 'Reply', comment.pk); // reply to a comment

await cl.commentLike(comment.pk);
await cl.commentLike(comment.pk, true); // unlike
await cl.commentPin(media.id, comment.pk);
await cl.commentBulkDelete(media.id, [comment.pk]);
```

## Uploading

Photos (JPG, PNG, WEBP; converted and resized automatically):

```ts
import { makeUsertag, makeLocation } from 'insta-node-js';

const someone = await cl.userInfoByUsername('instagram');

const photo = await cl.photoUpload('./photo.jpg', 'Caption #hashtag @mention', {
  usertags: [makeUsertag({ user: someone, x: 0.5, y: 0.5 })],
  location: makeLocation({ name: 'Bucharest', lat: 44.4268, lng: 26.1025 }),
});
console.log(photo.code);
```

Video, album, Reels and IGTV (video needs ffmpeg):

```ts
await cl.videoUpload('./video.mp4', 'My video', { thumbnail: './cover.jpg' });

await cl.albumUpload(['./1.jpg', './2.jpg', './3.mp4'], 'Album caption');

await cl.clipUpload('./reel.mp4', 'My reel #reels', { thumbnail: './cover.jpg' });

const [track] = await cl.searchMusic('summer');
await cl.clipUploadWithMusic('./reel.mp4', 'Reel with music', track);

await cl.igtvUpload('./long-video.mp4', 'Title', 'Description');
```

Scheduling, coauthors and cross-posting:

```ts
await cl.photoUpload('./photo.jpg', 'Scheduled post', {
  scheduleAt: new Date(Date.now() + 2 * 3600 * 1000),
  coauthorUserIds: [someone.pk],
  shareToFacebook: true,
  shareToThreads: true,
});
```

## Stories

Upload a story (photo or video) with stickers:

```ts
import { makeStoryMention, makeStoryLink, makeStoryHashtag } from 'insta-node-js';

const friend = await cl.userInfoByUsername('instagram');
const hashtag = await cl.hashtagInfo('nodejs');

const story = await cl.photoUploadToStory('./story.jpg', 'Story caption', {
  mentions: [makeStoryMention({ user: friend, x: 0.5, y: 0.5, width: 0.5, height: 0.1 })],
  links: [makeStoryLink({ webUri: 'https://example.com' })],
  hashtags: [makeStoryHashtag({ hashtag, x: 0.3, y: 0.7, width: 0.4, height: 0.1 })],
});

await cl.videoUploadToStory('./story.mp4', 'Video story');
```

Read stories:

```ts
const stories = await cl.userStories(friend.pk);
await cl.storySeen(stories.map((s) => s.pk));

const info = await cl.storyInfo(stories[0].pk);
const viewers = await cl.storyViewers(story.pk); // your own story
await cl.storyLike(stories[0].id);
await cl.storyDelete(story.pk);
```

Build a story image/video with a caption and mentions (`StoryBuilder`, needs ffmpeg):

```ts
import { StoryBuilder, makeStoryMention } from 'insta-node-js';

const mention = makeStoryMention({ user: friend, x: 0.5, y: 0.5, width: 0.5, height: 0.1 });
const built = await new StoryBuilder('./photo.jpg', 'Hello!', [mention]).photo(15);
await cl.videoUploadToStory(built.path, 'Built story', { mentions: built.mentions });
```

## Downloading

```ts
const photoPath = await cl.photoDownload(pk, './downloads');
const videoPath = await cl.videoDownload(pk, './downloads');
const albumPaths = await cl.albumDownload(pk, './downloads');
const reelPath = await cl.clipDownload(pk, './downloads');
const storyPath = await cl.storyDownload(stories[0].pk, '', './downloads');
```

## Highlights

```ts
const highlights = await cl.userHighlights(friend.pk);
const highlight = await cl.highlightInfo(highlights[0].pk);
console.log(highlight.title, highlight.items.length);

await cl.highlightCreate('My highlight', [story.pk]);
```

## Collections

```ts
const collections = await cl.collections();
const saved = await cl.collectionMedias(collections[0].id, 20);
```

## Hashtags

```ts
const tag = await cl.hashtagInfo('nodejs');
console.log(tag.media_count);

const top = await cl.hashtagMediasTop('nodejs', 9);
const recent = await cl.hashtagMediasRecent('nodejs', 20);
await cl.hashtagFollow('nodejs');
await cl.hashtagFollow('nodejs', true); // unfollow
```

## Locations

```ts
const places = await cl.fbsearchPlaces('Bucharest');
const nearby = await cl.locationSearch(44.4268, 26.1025);
const location = await cl.locationInfo(places[0].pk!);
const locationTop = await cl.locationMediasTop(places[0].pk!, 20);
```

## Search

```ts
const users = await cl.searchUsers('nasa');
const tags = await cl.searchHashtags('travel');
const music = await cl.searchMusic('summer');
const placesFound = await cl.fbsearchPlaces('Paris');
const directUsers = await cl.directSearch('john');
```

## Direct messages

```ts
const threads = await cl.directThreads(20);
const thread = await cl.directThread(threads[0].id, 50);
const messages = await cl.directMessages(thread.id, 20);
for (const m of messages) console.log(m.user_id, m.item_type, m.text);

// send to users (creates or reuses a thread) or to existing threads
await cl.directSend('Hello!', [friend.pk]);
await cl.directSend('Hello thread!', [], [thread.id]);

await cl.directSendPhoto('./photo.jpg', [friend.pk]);
await cl.directSendVideo('./video.mp4', [], [thread.id]);
await cl.directSendVoice('./voice.m4a', [], [thread.id]);
await cl.directMediaShare(media.id, [friend.pk]);
await cl.directStoryShare(story.id, [friend.pk]);
await cl.directProfileShare(friend.pk, [], [thread.id]);

await cl.directSendReaction(thread.id, messages[0].id, '❤');
await cl.directMessageDelete(thread.id, messages[0].id);

const newThreadId = await cl.directThreadCreate([friend.pk], 'Group title');
const pending = await cl.directPendingInbox(20);

console.log(thread.isSeen(cl.userId!)); // has the other side seen the last message?
```

## Notes

```ts
import { NoteAudience } from 'insta-node-js';

const note = await cl.createNote('Hello 👋', NoteAudience.MUTUAL_FOLLOWERS);
const notes = await cl.getNotes();
await cl.deleteNote(note.id);
```

## Insights

Business / creator accounts:

```ts
const account = await cl.insightsAccount();
const mediaInsights = await cl.insightsMedia(pk);
```

## Explore, Reels and music

```ts
const explore = await cl.explorePage();
const reelsFeed = await cl.reels(10);
const songs = await cl.searchMusic('lofi');
```

## Pagination

Methods named `*Chunk` return one page and the next cursor:

```ts
let cursor: string | null = null;
do {
  const [page, next]: [any[], string | null] = await cl.userMediasChunkGql(userId, 2, cursor);
  for (const m of page) console.log(m.code);
  cursor = next;
} while (cursor);
```

Methods named `iter*` are async iterators:

```ts
for await (const m of cl.iterUserMedias(userId, 100)) {
  console.log(m.code);
}

for await (const follower of cl.iterUserFollowersV1(userId, 500)) {
  console.log(follower.username);
}

for await (const m of cl.iterHashtagMedias('nodejs', 50)) {
  console.log(m.code);
}
```

## Realtime MQTT

The realtime client opens Instagram's MQTToT connection (`edge-mqtt.facebook.com`) after login and delivers live events.

```ts
import { Client } from 'insta-node-js';

async function main() {
  const cl = new Client();
  await cl.loadSettings('session.json');
  await cl.login('USERNAME', 'PASSWORD');

  cl.realtimeOn('message', (event) => {
    const msg = event.message;
    console.log(`[${msg.thread_id}] ${msg.user_id}: ${msg.text ?? msg.item_type}`);
  });
  cl.realtimeOn('typing', (event) => console.log('typing in', event.thread_id));
  cl.realtimeOn('seen', (event) => console.log('seen in', event.thread_id));
  cl.realtimeOn('presence', (event) => console.log('presence', event.value));

  const rt = await cl.realtimeConnect();
  await rt.directSubscribe(); // subscribe to Direct message sync

  // keep the connection alive
  const keepAlive = setInterval(() => cl.realtimePing().catch(console.error), 60_000);

  process.on('SIGINT', async () => {
    clearInterval(keepAlive);
    await cl.realtimeDisconnect();
    process.exit(0);
  });

  // read loop
  for (;;) {
    try {
      await cl.realtimeReadOnce();
    } catch (err: any) {
      if (err.name === 'TimeoutError') continue; // no traffic for 30s
      throw err;
    }
  }
}

main().catch(console.error);
```

Send Direct actions over MQTT (faster than HTTP):

```ts
const rt = await cl.realtimeConnect();
await rt.directSendText(threadId, 'Hello over MQTT');
await rt.directSendReaction(threadId, itemId, '❤️');
await rt.directIndicateActivity(threadId, true); // "typing..."
await rt.directMarkSeen(threadId, itemId);
await rt.sendForegroundState({ inForegroundApp: true, inForegroundDevice: true, keepAliveTimeout: 60 });
```

Low-level subscriptions and publishing:

```ts
await rt.graphQlSubscribe(['<graphql-subscription>']);
await rt.skywalkerSubscribe(['<skywalker-subscription>']);
await rt.irisSubscribe(seqId, snapshotAtMs);
await rt.publishJson('132', { action: 'send_item', thread_id: threadId, item_type: 'text', text: 'raw' });
```

Realtime events:

| Event | Payload |
| --- | --- |
| `receive` | every decoded publish packet: `{ topic, payload }` |
| `message` | Direct message-sync patches for `/direct_v2/threads/...` (`event.message` holds `path`, `op`, `thread_id` and the item) |
| `thread_update` | other message-sync patches |
| `iris` | message-sync entries that are not patches |
| `direct` | every parsed Direct event (`path`, `op`, `value`, `thread_id`) |
| `typing`, `seen`, `presence` | classified Direct events |
| `send_response` | responses to Direct commands sent over MQTT |
| `iris_sub_response` | response to the message-sync subscription |
| `realtime_sub` | GraphQL / Skywalker payloads |

Handlers can be `async`; they run in order and are awaited.

A custom transport (for tests or tunnelling) can be passed to `realtimeConnect(transport)`; it must implement `connect()`, `send(packet)`, `recvPacket()` and `disconnect()`.

## FBNS push notifications

FBNS uses a separate device-auth MQTT connection (`mqtt-mini.facebook.com`) and delivers the same push notifications as the mobile app.

```ts
cl.fbnsOn('push', (push) => console.log('push:', push.message, push.collapse_key));
cl.fbnsOn('direct_v2_message', (push) => console.log('new DM:', push.message));

await cl.fbnsConnect();                 // connects and registers the push token
await cl.dumpSettings('session.json');  // persists settings.fbns_auth for the next run

for (;;) {
  try {
    await cl.fbnsReadOnce();
  } catch (err: any) {
    if (err.name === 'TimeoutError') {
      await cl.fbnsPing();
      continue;
    }
    throw err;
  }
}
```

FBNS events: `auth`, `registered`, `reg_response`, `push`, `<collapse_key>` (e.g. `direct_v2_message`, `comment`, `like`), `message`, `logging`, `pp`, `receive`.

Disconnect with `await cl.fbnsDisconnect()`.

## Error handling (Boom)

Every error thrown by the library is a [Boom](https://www.npmjs.com/package/@hapi/boom) error:

```ts
import { Boom, LoginRequired, PleaseWaitFewMinutes, UserNotFound, ChallengeRequired } from 'insta-node-js';

try {
  await cl.userInfoByUsername('this_user_does_not_exist_123');
} catch (err) {
  if (Boom.isBoom(err)) {
    console.log(err.output.statusCode); // 404
    console.log(err.output.payload);    // { statusCode: 404, error: 'Not Found', message: '...' }
    console.log(err.data);              // extra details, when available
  }
  if (err instanceof UserNotFound) {
    // specific class checks keep working
  }
}
```

Status codes used by the library:

| Status | Errors |
| --- | --- |
| 400 | invalid arguments, `InvalidTargetUser`, `InvalidMediaId`, `AlbumUnknownFormat`, `VideoTooLongException` |
| 401 | `LoginRequired`, `ClientLoginRequired`, `BadPassword`, `BadCredentials`, `TwoFactorRequired`, `ReloginAttemptExceeded` |
| 403 | `ChallengeRequired` (and all challenge errors), `FeedbackRequired`, `SentryBlock`, `ProxyAddressIsBlocked`, `PrivateAccount`, `AccountSuspended`, `CaptchaChallengeRequired`, local files without read permission (`EACCES`) |
| 404 | `UserNotFound`, `MediaNotFound`, `StoryNotFound`, `HashtagNotFound`, `LocationNotFound`, `DirectThreadNotFound`, `CommentNotFound`, ..., and missing local files (`ENOENT`) |
| 408 | realtime / FBNS read timeout (`err.name === 'TimeoutError'`) |
| 412 | realtime / FBNS client not connected |
| 415 | unsupported file format or unreadable image |
| 422 | unexpected data from Instagram, `ModelValidationError` |
| 424 | ffmpeg / ffprobe missing |
| 429 | `PleaseWaitFewMinutes`, `RateLimitError`, `ClientThrottledError` |
| 5xx | network and transport errors (`ClientConnectionError`, `ClientJSONDecodeError`, `ClientGraphqlError`, proxy and MQTT connection errors: 503), unexpected internal errors (500) |

Errors without a fixed status use the HTTP status of Instagram's response. Errors raised by Node.js or by dependencies (file system, sockets, image decoding) are converted to Boom errors too; their original class, message and `code` (e.g. `ENOENT`) are kept.

Global handler for private API errors. If the handler returns normally, the failed request is **retried**; throw to give up:

```ts
cl.handleException = async (client, err) => {
  if (err instanceof ChallengeRequired) {
    await client.challengeResolve(client.lastJson); // then the request is retried
    return;
  }
  if (err instanceof PleaseWaitFewMinutes) {
    await new Promise((r) => setTimeout(r, 5 * 60_000)); // wait, then retry
    return;
  }
  throw err;
};
```

Retry with back-off on rate limits:

```ts
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i + 1 < attempts && Boom.isBoom(err, 429)) {
        await new Promise((r) => setTimeout(r, 60_000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

const info = await withRetry(() => cl.userInfoByUsername('instagram'));
```

The error classes are exported (`ClientError` is the base class of all Instagram errors), so `instanceof` checks work across the hierarchy: `MediaNotFound` is a `NotFoundError`, a `MediaError`, a `PrivateError` and a `ClientError`.

## Logging

The built-in logger is silent except for warnings. Set the level with an environment variable:

```bash
INSTA_NODE_LOG_LEVEL=debug node app.js
```

Levels: `debug`, `info`, `warning`, `error`, `silent`.

Or pass your own logger (any object with `debug`, `info`, `warning`, `error` and `exception` methods):

```ts
const quiet = new Client({
  logger: {
    debug: () => {},
    info: (...args: any[]) => console.info(...args),
    warning: (...args: any[]) => console.warn(...args),
    error: (...args: any[]) => console.error(...args),
    exception: (...args: any[]) => console.error(...args),
  },
});
```

## Models

All models are exported as TypeScript interfaces (`User`, `UserShort`, `Media`, `Comment`, `Story`, `Highlight`, `DirectThread`, `DirectMessage`, `Hashtag`, `Location`, `Track`, `Note`, `Account`, ...) together with a `make<Model>()` function that validates and normalizes raw data:

```ts
import { makeLocation, makeUsertag, type Media, type User } from 'insta-node-js';

const loc = makeLocation({ name: 'Eiffel Tower', lat: 48.8584, lng: 2.2945 });
```

Validation failures throw `ModelValidationError` (Boom 422, details in `err.data.errors`).

## Building and publishing

The TypeScript sources live in `src/`. The compiled package lives in `dist/`, which is generated and not committed to git.

| Command | What it does |
| --- | --- |
| `npm install` | installs dependencies and compiles `src/` into `dist/` (`prepare` script) |
| `npm run build` | compiles `src/` into `dist/` |
| `npm run clean` | deletes `dist/` |
| `npm run typecheck` | type-checks without writing files |
| `npm test` | runs the test suite |

For every file in `src/`, the build writes four files to `dist/`:

| File | Content |
| --- | --- |
| `*.js` | the compiled JavaScript |
| `*.d.ts` | the TypeScript type declarations |
| `*.js.map` | the source map, with the TypeScript source embedded |
| `*.d.ts.map` | the declaration map (go-to-definition in editors) |

Publishing to npm:

```bash
npm login
```

```bash
npm publish
```

`npm publish` first runs `prepublishOnly`: the tests, a clean build and the type check. The package contains only `dist/`, `README.md`, `LICENSE` and `package.json`; the TypeScript sources stay on GitHub. To see exactly what would be uploaded without publishing:

```bash
npm publish --dry-run
```

Before each new release, bump the version:

```bash
npm version patch
```

## Disclaimer

This is an unofficial library and is not affiliated with Instagram or Meta. Automating accounts may violate Instagram's Terms of Use. Use it responsibly, respect rate limits and use it at your own risk.

## License

[MIT](LICENSE) © Kunboruto20
