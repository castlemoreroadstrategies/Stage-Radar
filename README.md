# Stage Analysis Desk

A single-page, fully client-side dashboard that applies **Stan Weinstein's Stage Analysis** to a configurable watchlist. Drop-in deployable on GitHub Pages — no build step, no backend.

## Features
- 30-Week Simple Moving Average with slope detection (Up / Flat / Down)
- Price vs. 30W SMA bullish/bearish classification
- Relative Strength line vs. a configurable benchmark (default **SPY**)
- Breakout volume detector (configurable multiplier of the trailing 10-week average)
- Auto-classified stage (1 Basing, 2 Advancing, 3 Top, 4 Declining)
- Weekly price + SMA chart with a lower weekly volume panel (Chart.js)
- Watchlist persisted to `localStorage`; per-ticker add/remove
- Dark "trading desk" UI, responsive from mobile to ultra-wide

## Default watchlist
`SPY, XOM, BTC-USD, RY, RY.TO, FIE.TO, SIXY.TO`

For Canadian listings use the `.TO` (TSX) or `.NE` (NEO/Cboe Canada) Yahoo suffix.

## Deploy on GitHub Pages
1. Copy the contents of this folder to the root of a public repo (or to `/docs`).
2. Settings → Pages → deploy from the chosen branch/folder.
3. Open the site. No API key required.

## Data source
Uses Yahoo Finance public chart endpoints (`query1.finance.yahoo.com/v8/finance/chart/...`) routed through a CORS proxy. The proxy is configurable in the Settings modal. Default: `https://corsproxy.io/?`. If you're rate-limited, swap in your own proxy or self-host `cors-anywhere`.

## Disclaimer
Educational tool. Not investment advice. Yahoo's endpoints are unofficial and can change without notice.
