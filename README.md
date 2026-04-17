# ⚽ SoccerCast

A simple real-time multiplayer football game designed to be displayed on a **Chromecast** (or any TV browser) while players use their **phones as controllers** via a virtual joystick.

---

## Architecture

```
┌──────────────┐     Socket.io     ┌──────────────────┐
│  Player Phone │ ←──────────────→ │   Game Server    │
│ (controller) │                   │  (Node.js /      │
└──────────────┘                   │   Express /      │
                                   │   Socket.io)     │
┌──────────────┐     Socket.io     │                  │
│   TV / Cast  │ ←──────────────→ │  30 fps physics  │
│  (receiver)  │                   │  loop server-side│
└──────────────┘                   └──────────────────┘
```

| URL            | Description |
|----------------|-------------|
| `/`            | Landing page (links to receiver & controller) |
| `/receiver`    | Game display — open on TV or Chromecast browser |
| `/controller`  | Joystick controller — open on each player's phone |

---

## Quick Start

### Prerequisites
- Node.js 18+ and npm

### Install & Run

```bash
npm install
npm start
```

The server starts on port **3000** by default.  
Set `PORT` env var to override (e.g. `PORT=8080 npm start`).

### Play

1. Open `http://<your-ip>:3000/receiver` in a browser on the **TV** (or cast a Chrome tab).
2. Each player opens `http://<your-ip>:3000/controller` on their **phone**.
3. Enter a name, pick **Red 🔴** or **Blue 🔵**, then tap **Join Game**.
4. Drag the **joystick** to move your player — run into the ball to kick it!
5. Score in the opponent's goal to win. 🏆

---

## Chromecast Setup (optional)

To use a real Chromecast device instead of casting a browser tab:

1. **Register** as a Cast developer at <https://cast.google.com/publish> (one-time $5 fee).
2. Add a **Custom Receiver** pointing to your hosted `/receiver` URL (must be HTTPS).
3. Copy the generated **App ID** (e.g. `ABCD1234`).
4. In `public/controller.html`, replace `'YOUR_CAST_APP_ID'` with your App ID.
5. Uncomment the Cast sender and receiver SDK `<script>` tags in both HTML files.
6. The Cast button will appear automatically in Chrome browsers with Cast support.

For local development without HTTPS you can use [ngrok](https://ngrok.com/) to tunnel your server:
```bash
ngrok http 3000
```

---

## Game Rules

- **Red team** spawns on the left, attacks the right goal.
- **Blue team** spawns on the right, attacks the left goal.
- A goal is scored when the ball fully crosses the opponent's end line through the goal.
- After each goal, all players reset to their starting positions.
- Scores reset when all players disconnect.

---

## Tech Stack

| Layer      | Technology |
|------------|------------|
| Server     | Node.js · Express · Socket.io |
| Game logic | Server-side physics at 30 fps |
| Receiver   | HTML5 Canvas (no framework) |
| Controller | Vanilla JS touch joystick |
| Casting    | Google Cast SDK (optional) |
