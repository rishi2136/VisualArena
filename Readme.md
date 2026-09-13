# VisualArena - YouTube Watch Party

VisualArena is a TypeScript MERN watch-party prototype. A host creates a room, shares its six-character room code or URL, and watches a YouTube video in sync with other people. Socket.IO broadcasts each authoritative playback update; MongoDB keeps each room and its last video state durable between active sessions.

Live: https://visualarena.onrender.com

## Features

- Create a persistent MongoDB-backed room with a unique, shareable code.
- Join a room from a link or code using a display name.
- Synchronize play, pause, seek, and video changes in real time.
- Use the YouTube IFrame API with custom controls.
- Enforce roles on the **server**, not just in the UI:
  - **Host**: all controls, promote/demote, remove people, transfer host.
  - **Moderator**: play, pause, seek, and change video.
  - **Participant**: watches only.
- Keep the member list and roles live for every connected client.
- Include bonus real-time party chat.
- Save the creator credential as a hash; the raw token remains only in the creating browser's `sessionStorage`.

## Stack

| Layer     | Technology                                     |
| --------- | ---------------------------------------------- |
| Client    | React 19, TypeScript, Vite, YouTube IFrame API |
| API       | Node.js, Express 5, TypeScript, Zod            |
| Real time | Socket.IO                                      |
| Database  | MongoDB with Mongoose                          |

## Run locally

### Prerequisites

- Node.js 20+ and npm (or npm)
- MongoDB Community Server running locally, or a MongoDB Atlas connection string

### 1. Configure environment variables

Copy the examples before starting:

```powershell
Copy-Item server/.env.example server/.env
Copy-Item client/.env.example client/.env
```

Set `MONGODB_URI` in `server/.env` if using Atlas. The local default is:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/visualarena
```

### 2. Install and run

Open two terminals:

```powershell
cd server
npm install
npm dev
```

```powershell
cd client
npm install
npm dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:4000` by default and exposes `GET /api/health`.

## Verify the party flow

1. Create a room and enter a name. The browser becomes the Host.
2. Copy the room URL, open it in an incognito window or another browser, and join as a Participant.
3. In the host window, promote the second person to Moderator from the `•••` menu.
4. Play, pause, seek, or paste a different YouTube URL. Both browsers update.
5. Demote the moderator; their controls become disabled and the server rejects any control event they try to send.
6. Try chat, host transfer, and removal.

## Architecture

```text
React client ── REST POST /api/rooms ──> Express ──> MongoDB (room + last playback state)
     │                                       │
     └──────── Socket.IO events ◄────────────┘
                  RoomManager (authoritative roles + state)
```

`RoomManager` owns the active in-memory room sessions and participant socket IDs. On room creation it writes a MongoDB document. On join, it hydrates a missing active room from MongoDB. For a controller action, it first resolves the socket's participant record, verifies that its role is Host or Moderator, updates/persists playback state, and broadcasts `sync_state` to the Socket.IO room. A participant therefore cannot gain control by changing the frontend.

### Primary socket events

| Event                                                 | Direction        | Permission       |
| ----------------------------------------------------- | ---------------- | ---------------- |
| `join_room`, `leave_room`                             | client → server  | anyone           |
| `play`, `pause`, `seek`, `change_video`               | client → server  | Host / Moderator |
| `assign_role`, `remove_participant`, `transfer_host`  | client → server  | Host             |
| `sync_state`, `participants_updated`, `role_assigned` | server → clients | broadcast        |
| `send_message`, `chat_message`                        | both             | room members     |

The socket acknowledgement format is `{ ok, data?, error? }`, allowing the UI to surface rejected actions cleanly.

## Production build checks

The following checks have passed in this workspace:

```powershell
cd server; npm run build
cd ../client; npm run build
```

## Deploy to Render

Create a MongoDB Atlas database first and allow connections from Render. Then create two Render services from this repository:

1. **Web Service (server)**
   - Root directory: `server`
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Environment: `MONGODB_URI`, `PORT` (provided by Render), and `CLIENT_ORIGIN` set to the frontend URL.
2. **Static Site (client)**
   - Root directory: `client`
   - Build command: `npm install && npm run build`
   - Publish directory: `dist`
   - Environment: `VITE_API_URL` set to the server's HTTPS URL.

After both deploys, update `CLIENT_ORIGIN` on the API, redeploy it, and put the resulting frontend URL at the top of this README. Socket.IO works on Render Web Services because it keeps long-lived WebSocket connections; do not deploy this socket server as a serverless function.
