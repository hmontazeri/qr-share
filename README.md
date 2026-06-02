# QR-Share (Serverless P2P Filesharing)

QR-Share is a privacy-first, 100% serverless, zero-dependency, peer-to-peer filesharing application operating entirely within the browser. It executes a WebRTC Session Description Protocol (SDP) handshake optically using QR codes, bypassing the need for a centralized intermediate signaling server (like WebSockets) to pair devices or log metadata.

---

##  Key Value Propositions

* **True Serverless Execution:** Runs directly out of a single static `index.html` file. Can be deployed on GitHub Pages, Vercel, or run completely offline from the local filesystem (`file://`).
* **Absolute Privacy:** Zero metadata, zero telemetry, and zero file content ever hit an intermediate server. Your file never touches the cloud.
* **Network Agnostic:** Works in highly restrictive enterprise networks or local environments where cross-device mDNS/UDP discovery is blocked by the router.
* **Design Excellence:** Styled with a premium **Tactical Cyber-Obsidian** theme using OKLCH custom properties, crisp system typography, custom animations, and layout grids.

---

##  Visual System & Register
* **Register:** Product (App UI, high utility, task-focused, zero fluff).
* **Base Color:** Obsidian base `oklch(13% 0.006 145)` paired with elevated panel frames `oklch(16% 0.008 145)`.
* **Primary Accent:** Vivid Emerald-Green `oklch(76% 0.155 142)` for active signaling, loader pulses, and secure success confirmation.
* **Typography:** System Sans-Serif (`Outfit`, `-apple-system`, `BlinkMacSystemFont`, `sans-serif`) carrying clean typographic measures (65–75ch) and a tighter, noise-reduced scale ratio.

---

##  Architectural Handshake Sequence

```
+-----------------------------------+               +-----------------------------------+
|          Device A (Sender)        |               |        Device B (Receiver)        |
+-----------------------------------+               +-----------------------------------+
| 1. Drops File                     |               |                                   |
| 2. Generates Local SDP Offer      |               |                                   |
| 3. Munges & Compresses SDP        |               |                                   |
| 4. Displays QR Offer              | ------------> | 5. Scans QR Code (Camera Stream)  |
|                                   |  (Optical)    | 6. Applies Remote SDP Offer       |
|                                   |               | 7. Generates Local SDP Answer     |
|                                   |               | 8. Compresses Answer SDP          |
| 10. Scans QR Answer (Camera Feed) | <------------ | 9. Displays QR Answer             |
| 11. Applies Remote SDP Answer     |  (Optical)    |                                   |
|                                   |               |                                   |
| ===================================================================================== |
|                         DIRECT WEBRTC P2P DATA CHANNEL ESTABLISHED                     |
| ===================================================================================== |
| 12. Slices file into 16KB chunks  |               | 13. Reassembles binary chunks     |
| 13. Streams over DataChannel      | ------------> | 14. Triggers native file download |
+-----------------------------------+               +-----------------------------------+
```

---

##  Compression Pipeline (SDP Munging)

Standard WebRTC session descriptions exceed 2,000 characters, creating dense QR codes that low-resolution webcams struggle to parse. QR-Share implements a multi-stage munging and compression pipeline to optimize scanning:

1. **Codec Stripping (Munging):** Audio/Video formats, media line parameters (`m=audio`, `m=video`), crypto keys, and secondary descriptors are stripped from the SDP string before compression.
2. **Candidate Aggregation:** The connection waits until `iceGatheringState === 'complete'` before rendering, baking local STUN candidates directly into the initial SDP.
3. **Deflate Compression:** The munged string is compressed using `pako.js` (lightweight zlib browser port):
   `Munged SDP -> pako.deflate (Level 9) -> Uint8Array -> btoa (Base64) -> Scan-Ready String`
   This crushes the SDP payload from **~2,500 characters to < 400 characters**, rendering low-density, highly-scannable QR matrices.

---

## ️ Data Streaming & Queue Management

To prevent browser crashes and frame drops during large file transfers:
* **Byte Chunking:** Files are sliced into **16KB binary chunks** (`FileReader.readAsArrayBuffer`).
* **Backpressure Safety:** The datachannel checks `bufferedAmount` before transmitting new slices. If the buffer exceeds `64KB`, streaming halts until the datachannel fires a `onbufferedamountlow` event.

---

##  Local Execution & Development

Since QR-Share relies on standard client-side features with CDN-loaded scripts, you can run and test it immediately:

### Option A: Local Filesystem (Zero Configuration)
Simply double-click the **`index.html`** file in your explorer to run the application in your browser (`file://`).

### Option B: Local Web Server (Recommended for Camera Access)
Mobile browsers block camera access on non-secure connections (`http`), requiring either `https` or `localhost`. To test locally:
1. Start a simple static local server in the project directory using Node's `npx` (requires no installation):
   ```bash
   npx live-server
   ```
2. Or use Python's built-in module:
   ```bash
   python3 -m http.server 8080
   ```
3. Open `http://localhost:8080` on your desktop computer, drop a file, and scan the QR code using your phone!
