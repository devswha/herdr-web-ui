# Native app plan

Status: planning (2026-10-18). Branch `feat/native-app`.

herdr-web-ui ships as a store app for iOS first, Android later. The goal is reach: the app is
found in the App Store and installs in one tap, where the web app needs "Add to Home Screen". It
also opens the door to features a home-screen web app cannot have.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Stack | Capacitor | The UI stays the one React client. iOS terminal apps built in Swift or React Native (Blink, Hermit, PocketTunnel, Fressh) still draw the terminal in a WebView, so a rewrite would not change the core. React Native would rewrite every screen. |
| Where the code lives | `app/` in this repo | The app and the web client change together. App builds are not a required check. |
| Who serves the UI | The PC, as today | The UI and the server ship together, so they never disagree on the wire contract. The app holds only the native shell, the connect screen and the demo. |
| Notifications | In the first release, through an APNs relay | A WKWebView app gets no Web Push, so the app needs Apple's push service, and only a key held by the project can sign for it. |
| Notification privacy | End-to-end encrypted | The relay only forwards what it cannot read, as the telemetry Worker never reads what it does not need. |
| Builds | Xcode on the macbook | See the iOS QA notes; Capacitor needs a Mac for iOS. |

## How it fits

```
PC: herdr-web-ui server ──UI, API, WebSocket──▶ app WebView (the same client as the browser)
PC: server/push.ts ──encrypted push──▶ relay (Cloudflare Worker) ──▶ APNs ──▶ app
```

### The app

- A native connect screen: scan the pairing QR or type the address, then load the PC's UI in the
  WebView. Pairing works as in a browser: the device keeps its HttpOnly cookie in the WebView's
  persistent store.
- A demo mode built from `site/demo`, for someone with no PC set up yet and for App Review,
  whose reviewers have no herdr PC.
- Native pieces the web client reaches through the Capacitor bridge: push registration first,
  then haptics, share, Face ID as needed.

### Notifications

The relay looks to `server/push.ts` like one more browser push service, so the PC keeps its
whole alert policy (the wait before an alert, no alert while a window is in use, per-device
choices) and changes little:

1. The app registers with APNs and gets a device token.
2. The app sends the token to the relay, which returns an endpoint URL holding an opaque ID for
   that token (`https://<relay>/v1/push/<id>`). The token itself never leaves the relay.
3. The app makes a P-256 key pair and an auth secret, keeps the private half in the keychain
   shared with its Notification Service Extension, and hands `{ endpoint, keys }` to the web
   client, which subscribes with it in place of `pushManager.subscribe`.
4. The PC encrypts each alert for those keys (RFC 8291, as today) and signs it with its VAPID key
   (RFC 8292). The relay pins the first VAPID key that pushes to an endpoint and refuses others,
   so knowing an endpoint is not enough to send to a phone. It also rate-limits per endpoint.
5. The relay wraps the ciphertext in a `mutable-content` APNs push. The Notification Service
   Extension (a small Swift target) decrypts it and shows the title and body. A push it cannot
   decrypt shows a generic "herdr needs you" line.
6. APNs telling the relay a token is gone becomes a 410 to the PC, which already deletes a gone
   subscription.

The relay's code lives in this repo next to `telemetry/`, open so anyone can run their own, and
keeps no logs, like the telemetry Worker. Its APNs key is a secret of the project's Cloudflare
account. Android (FCM) gets a second route in the same Worker later.

## Phase 1: first store release

1. Spike on the macbook: does a page loaded from the PC's address get the Capacitor bridge?
   Done 2026-10-19, see [Spike results](#spike-results-2026-10-19): it does, and the PC's
   page must be the WebView's first page, not one a bundled page navigates to.
2. `app/`: Capacitor project, connect screen, QR scan, demo mode.
3. Relay Worker with tests (VAPID pinning, rate limit, gone tokens).
4. `src/lib/push.ts`: subscribe through the native bridge inside the app.
5. Notification Service Extension that decrypts.
6. App Store listing, privacy answers, review notes pointing at the demo mode.

## Phase 2 and later

- Live Activity for a running agent, home-screen widgets (both need Swift, and pushes through
  the same relay).
- Android build and the FCM route.
- Speed: measure what is slow before changing anything; bundling the UI in the app is off the
  table while the PC serves it.

## Spike results (2026-10-19)

Run on the EA MacBook (macOS 27.0.1, Xcode 27.0) in an iPhone 18 Pro Simulator on iOS 27.0, with
Capacitor 8.5.3 and `@capacitor/device` 8.0.3, in a throwaway app outside the repo. The page
under test was the demo build of the client (`bun scripts/demo-build.ts`), served from this PC's
Tailscale address over `http`, and over `https` through `tailscale serve`. Each page posted its
own measurements back to that server. Times are simulator runs, not a phone.

- **The bridge reaches the PC's page.** It works for a page the bundled page reached with
  `location.replace` (its host listed in `server.allowNavigation`) and for a page set as
  `server.url`, over `http` and `https`. In both cases `Capacitor.isNativePlatform()` was true
  and `Device.getInfo()` answered. A plain `http://` address needed `NSAllowsArbitraryLoads`.
- **The app has no service worker.** In the app's WKWebView, `navigator.serviceWorker` is missing
  even on `https`, where `isSecureContext` is true. Safari on the same simulator registers one at
  the same URL. The worker does register once `ios.limitsNavigationsToAppBoundDomains` is set and
  the host is listed in `WKAppBoundDomains`. But then a host missing from that Info.plist list
  (10 at most) does not load at all: the Tailscale IP gave a blank view. Users' PC addresses are
  not known at build time, so the app runs without the worker.
- **Navigating from the bundled page costs about 1.5 s.** The PC's page loaded quickly, but its
  first script ran 1487-1514 ms after navigation start, against 42 ms in Safari. This happened
  in Debug and Release builds alike, and JavaScript speed was the same in both. Loaded as the
  WebView's first page (`server.url`), the same page ran its first script at 51-62 ms.

| Real client, from launch | First paint in the page | Launch to painted client |
|---|---|---|
| App, PC page as the first page (`server.url`) | 262-304 ms | 4.7-4.8 s |
| Safari | 284-336 ms | 4.9-5.3 s |
| App, bundled page navigating to the PC | 1629-2044 ms | 6.6-7.5 s |

The simulator starting the app or Safari takes most of the launch time. No run, Safari's
included, had the client's service worker in control, so the table compares page loads with
the browser's HTTP cache only.

What this changes:

- The connect screen must not reach the PC by navigating from JavaScript. It saves the address
  natively, and the app opens it as the WebView's first page. Capacitor 8.5.3 leaves room for
  that: `CAPBridgeViewController.instanceDescriptor()` is `open`, and the descriptor's `serverURL`
  is what `server.url` sets. A subclass can fill it from the saved address. This is the same
  path `server.url` takes, so the "live reload only" warning is about a URL fixed at build time.
  The subclass was not built in this spike; it is the next one.
- Inside the app the client has no service worker: no offline shell, and push only through the
  native route. `src/pwa.ts` already checks for `navigator.serviceWorker`. `src/lib/push.ts`
  calls `navigator.serviceWorker.getRegistration()` without a check, so step 4 has to branch
  before that call.
- Not tested here: the pairing cookie surviving an app restart, keyboard and IME in the app, and
  a physical iPhone.

To repeat it:

1. Build the demo client into a directory.
2. Serve it from a small Bun server on the Tailscale IP, plus a loopback port behind
   `tailscale serve --bg --https=<port>`.
3. Make the app with `npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/device`,
   `npx cap add ios`, then build and install it with `xcodebuild -sdk iphonesimulator` and
   `xcrun simctl install`.
4. Launch with `xcrun simctl launch` (Safari: `xcrun simctl openurl`) after recording the Mac's
   clock. The page reports `Date.now()` and its navigation timing once `#root` has painted.

## Risks and open questions

- App Review guideline 4.2 (a web wrapper): the native connect flow, push and the demo mode are
  the answer. Expect at least one round trip.
- Capacitor documents `server.url` as meant for live reload, not production. The spike found
  that a loader page costs about 1.5 s per launch, so the app sets the same `serverURL` at
  runtime through a `CAPBridgeViewController` subclass instead (not built yet).
- WKWebView keyboard and IME behaviour can differ from Safari's; the iOS keyboard regressions
  need a run inside the app.
- A plain `http://` PC address (LAN or a Tailscale IP without `tailscale serve`) needs an App
  Transport Security exception that review must accept. `https` through `tailscale serve` needs
  none.
- Several PCs: the app should list them, as the remote PCs feature does in the browser.
- Not decided: the relay's domain, the bundle ID and the app's store name.
- The macbook is shared with other sessions (a ChatGPT CUA was running on 2026-10-18): check it
  is free before booting a simulator there.
