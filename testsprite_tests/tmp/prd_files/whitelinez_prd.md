# WHITELINEZ — AI Traffic Prediction Game: Product Requirements Document

## Overview
WHITELINEZ is a real-time AI-powered traffic monitoring platform and prediction game. A live traffic camera feed is processed by a YOLOv8 AI model that counts vehicles crossing a detection zone. Users watch the live stream and guess how many vehicles will pass in a chosen time window (1, 3, or 5 minutes). Correct guesses earn points; close guesses earn partial points; misses earn nothing.

## Core Features

### 1. Live Stream
- HLS video stream of a live Jamaican traffic camera (Molynes Boulevard East)
- Stream auto-plays on page load
- FPS badge overlay shows AI detection frame rate
- "SIGNAL LOST" offline overlay (red, broken monitor icon) if stream goes down
- Stream switching animation when user changes cameras

### 2. Real-Time Vehicle Count Widget
- Floating widget on the stream showing current vehicle count
- Updated via WebSocket (/ws/live) in real-time
- In "global mode": shows total count since round start
- In "guess mode": shows X/Y progress bar (green → yellow → red as count approaches guess)
- Mobile tap to expand/collapse

### 3. Guess Panel (Live Bet)
- Users submit a vehicle count guess for the active round
- Time window options: 1 MIN / 3 MIN / 5 MIN
- Input field for exact vehicle count
- Submit Guess button
- Scoring card shown after round resolves: EXACT (max pts) / CLOSE (partial) / MISS (0)
- Active guess receipt displayed while round is running
- Users must be logged in (or guest) to submit a guess

### 4. Leaderboard
- Public leaderboard showing top guessers
- Three tabs: 1MIN / 3MIN / 5MIN (filters by window_duration_sec)
- Shows rank, username, score
- Manual refresh button
- Lazy-loads when user clicks Leaderboard tab

### 5. Public Chat
- Real-time public chat panel
- Users type and send messages
- Messages appear instantly via Supabase Realtime
- Activity feed overlay on stream shows recent chat/guess events

### 6. Camera Switcher
- Multiple AI traffic cameras available
- Camera selection modal with list of cameras and FPS badges
- Clicking a camera switches the live stream
- Header chip updates with active camera name

### 7. Authentication
- Login with email/password
- Register new account
- Continue as Guest (anonymous Supabase auth, 48h session)
- Avatar and balance shown in nav on login
- Google OAuth supported
- Logout button

### 8. Detection Zone Overlay
- Canvas polygon drawn over the stream showing the AI counting zone
- Hover over zone: glow highlight + crosshair cursor
- Detection boxes drawn around vehicles in real-time from WebSocket data
- Zone reloads when camera is switched

### 9. Banner System
- Promotional banner tiles on the main page
- Play tile (with How It Works modal)
- Default tile (with More Info)
- Banners managed by admin; update in real-time via Supabase Realtime

### 10. How It Works Modal
- Explains the game: watch stream → guess vehicle count → earn points
- Accessible from banner tile and info icon
- Step-by-step visual guide

### 11. Account Page (/account.html)
- View current balance/points
- Guess history with outcomes (EXACT/CLOSE/MISS)
- Win/loss breakdown
- Requires authentication

### 12. Admin Dashboard (/admin.html)
- System health panel: AI loop, round resolver, bet resolver status
- Create and manage bet rounds (duration, window type, camera)
- Camera stream configuration and zone drawing
- Banner management (create/edit/delete promotional tiles)
- ML training job management
- User role assignment (admin/user)
- Runtime and night profile configuration
- Widget layout editor

## User Flows

### Guest User
1. Land on homepage → stream auto-plays
2. See vehicle count updating live
3. Click "Continue as Guest" in nav
4. Enter a guess in the guess panel
5. Watch round resolve → see score

### Registered User
1. Click LOGIN → enter credentials
2. See balance in nav
3. Submit guesses across multiple rounds
4. Check leaderboard ranking
5. Visit /account.html for history

### Admin
1. Navigate to /admin.html
2. Create a new round for the active camera
3. Monitor AI detection in real-time
4. Resolve/close rounds manually if needed
5. Manage banners and user roles

## Technical Notes
- Frontend: Vanilla JS ES Modules, Vite build, no framework
- Backend: FastAPI + YOLOv8 on Railway (Docker)
- Database: Supabase PostgreSQL + Realtime + Auth
- Language: "guess/pts" — this is a game, not gambling
- Scoring: EXACT = maximum pts, CLOSE = partial pts, MISS = 0 pts
