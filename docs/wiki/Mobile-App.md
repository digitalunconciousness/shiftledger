# Mobile App

ShiftLedger includes a React Native companion app built with **Expo 50**, targeting iOS and Android. It connects to the same Express backend as the web frontend.

---

## Overview

The mobile app provides a streamlined interface for the most common operations:

- Log in / sign up
- View your shift list
- Add a new shift
- Edit an existing shift

More advanced features (dashboard analytics, goals, tax config, household management, exports) are available through the web frontend.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React Native (Expo 50) |
| Navigation | React Navigation (native stack) |
| State | Zustand |
| HTTP | Axios |
| Auth storage | AsyncStorage |
| Gestures | React Native Gesture Handler |

---

## Project Structure

```
mobile/
├── App.js                    # Root: navigation container, auth gate
├── package.json              # Mobile dependencies
├── eas.json                  # Expo Application Services config
├── babel.config.js           # Babel/Expo preset
└── app/
    ├── api/
    │   └── client.js         # Axios instance + Bearer token interceptor + auth helpers
    ├── screens/
    │   ├── LoginScreen.js    # Username/password login
    │   ├── SignupScreen.js   # Self-registration (creates account via /api/auth/signup)
    │   ├── HomeScreen.js     # Shift list with pull-to-refresh and delete
    │   ├── AddShiftScreen.js # New shift form (date, rate, hours, tips, job)
    │   └── EditShiftScreen.js # Edit existing shift
    └── store/
        ├── authStore.js      # Zustand: user, token, login/signup/logout, hydration
        └── shiftStore.js     # Zustand: shift list, CRUD actions
```

---

## Authentication

The mobile app uses **Bearer tokens** instead of cookies:

1. User logs in via `POST /api/auth/login` or signs up via `POST /api/auth/signup`
2. The backend returns `{ token, user }` in the JSON response body
3. The token and user object are persisted to `AsyncStorage`
4. Every subsequent API request includes `Authorization: Bearer <token>`
5. On 401 responses, the Axios interceptor automatically clears stored credentials so the auth store redirects to the login screen
6. Token rotation is available via `POST /api/auth/refresh` (issues a new token, invalidates the old one)

The `authStore` hydrates from `AsyncStorage` on app start, so users stay logged in between sessions.

---

## Configuration

### API URL

The mobile app needs to know where your ShiftLedger backend is running. Set the `EXPO_PUBLIC_API_URL` environment variable before building:

```bash
EXPO_PUBLIC_API_URL=https://shiftledger.example.com npx expo start
```

For development, use your local machine's LAN IP (not `localhost`, which won't work on a physical device):

```
EXPO_PUBLIC_API_URL=http://192.168.1.100:3000
```

If `EXPO_PUBLIC_API_URL` is not set, the app defaults to `http://localhost:3000`.

### Production

For production use, always point the app at an **HTTPS URL** to protect authentication tokens in transit. See [[Deployment Guide]] for setting up TLS via nginx or Cloudflare Tunnel.

---

## Development Setup

### Prerequisites

- Node.js 20+
- [Expo CLI](https://docs.expo.dev/get-started/installation/)
- iOS Simulator (macOS only) or Android emulator, or the [Expo Go](https://expo.dev/go) app on a physical device

### Install dependencies

```bash
cd mobile
npm install
```

### Start the development server

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.100:3000 npx expo start
```

Scan the QR code with Expo Go, or press `i` for iOS Simulator, `a` for Android emulator.

---

## Building for Distribution

ShiftLedger uses [Expo Application Services (EAS)](https://docs.expo.dev/eas/) for building distributable binaries.

### Configure EAS

```bash
cd mobile
npx eas build:configure
```

Edit `eas.json` to set your app identifier and build profiles.

### Build

```bash
# iOS (requires Apple Developer account)
npx eas build --platform ios --profile production

# Android
npx eas build --platform android --profile production
```

### Submit to stores

```bash
npx eas submit --platform ios
npx eas submit --platform android
```

---

## Navigation Flow

```
App Start
  └── hydrate() — restore token from AsyncStorage
        ├── token found → AppStack
        │     ├── HomeScreen (shift list)
        │     ├── AddShiftScreen
        │     └── EditShiftScreen
        └── no token → AuthStack
              ├── LoginScreen
              └── SignupScreen
```

The navigation container automatically switches between stacks when `token` changes in the auth store.

---

## API Endpoints Used

| Action | Endpoint |
|---|---|
| Login | `POST /api/auth/login` |
| Signup | `POST /api/auth/signup` |
| Logout | `POST /api/auth/logout` |
| Refresh token | `POST /api/auth/refresh` |
| Auth status | `GET /api/auth/status` |
| List shifts | `GET /api/shifts` |
| Create shift | `POST /api/shifts` |
| Update shift | `PUT /api/shifts/:id` |
| Delete shift | `DELETE /api/shifts/:id` |
| List jobs | `GET /api/jobs` |
