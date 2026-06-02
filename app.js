/* ==========================================================================
  QR-SHARE LOGICAL CONTROLLER
  Pure serverless WebRTC data-channel pipeline with pako.js & jsQR.
  ========================================================================== */

(function() {
 'use strict';

 // --- STATE CONFIG & VARIABLES ---
 const STATE_IDLE = 'idle';
 const STATE_GATHERING_ICE = 'gathering-ice';
 const STATE_AWAITING_SCAN = 'awaiting-scan';
 const STATE_SCANNING = 'scanning';
 const STATE_AWAITING_RESPONSE = 'awaiting-response';
 const STATE_CONNECTING = 'connecting';
 const STATE_STREAMING = 'streaming';
 const STATE_COMPLETED = 'completed';
 const STATE_FAILED = 'failed';

 let currentAppMode = null; // 'sender' or 'receiver'
 let activeState = STATE_IDLE;

 // File Objects
 let selectedFile = null;
 let fileMetadata = null;
 let fileChunks = [];
 let receivedBytesTotal = 0;
 let transferStartTime = null;
 let speedCalculatorInterval = null;

 // WebRTC Configurations
 const WEBRTC_CONFIG = {
  iceServers: [
   { urls: 'stun:stun.l.google.com:19302' },
   { urls: 'stun:stun1.l.google.com:19302' },
   { urls: 'stun:stun2.l.google.com:19302' }
  ]
 };
 let peerConnection = null;
 let rtcDataChannel = null;

 // Streaming Parameters
 const CHUNK_SIZE = 16384; // 16KB browser boundary safety size
 const BUFFER_THRESHOLD = 65536; // 64KB backpressure threshold

 // Media Streams
 let activeWebcamStream = null;
 let scanningAnimationId = null;

 // Clipboard & Manual Signaling Buffers
 let currentCompressedOffer = '';
 let currentCompressedAnswer = '';
 let currentShareLink = '';

 // --- DOM CACHE ---
 const appEl = document.getElementById('app');
 const fileInputEl = document.getElementById('file-input');
 const dropzoneEl = document.getElementById('dropzone');
 const btnReceiveModeEl = document.getElementById('btn-receive-mode');
 const btnCancelSendEl = document.getElementById('btn-cancel-send');
 const btnCancelReceiveEl = document.getElementById('btn-cancel-receive');
 const btnCancelResponseEl = document.getElementById('btn-cancel-response');
 const btnSuccessResetEl = document.getElementById('btn-success-reset');
 const btnErrorResetEl = document.getElementById('btn-error-reset');
 const btnManualSubmitEl = document.getElementById('btn-manual-submit');
 const manualSdpOfferEl = document.getElementById('manual-sdp-offer');
 const btnCopyOfferEl = document.getElementById('btn-copy-offer');
 const btnCopyAnswerEl = document.getElementById('btn-copy-answer');
 const btnManualAnswerSubmitEl = document.getElementById('btn-manual-answer-submit');
 const manualSdpAnswerEl = document.getElementById('manual-sdp-answer');
 const btnSenderPasteConnectEl = document.getElementById('btn-sender-paste-connect');
 const btnReceiverPasteConnectEl = document.getElementById('btn-receiver-paste-connect');
 const senderTabsEl = document.getElementById('sender-tabs');
 const receiverTabsEl = document.getElementById('receiver-tabs');
 const senderViewRemoteEl = document.getElementById('sender-view-remote');
 const senderViewLocalEl = document.getElementById('sender-view-local');
 const receiverViewRemoteEl = document.getElementById('receiver-view-remote');
 const receiverViewLocalEl = document.getElementById('receiver-view-local');
 const receiverResponseTabsEl = document.getElementById('receiver-response-tabs');
 const receiverResponseViewRemoteEl = document.getElementById('receiver-response-view-remote');
 const receiverResponseViewLocalEl = document.getElementById('receiver-response-view-local');
 const btnCopyAnswerRemoteEl = document.getElementById('btn-copy-answer-remote');
 const btnCopyShareLinkEl = document.getElementById('btn-copy-share-link');

 // Text / UI Elements
 const sendFileNameEl = document.getElementById('send-file-name');
 const sendFileSizeEl = document.getElementById('send-file-size');
 const streamFileNameEl = document.getElementById('stream-file-name');
 const streamFileTransferredEl = document.getElementById('stream-file-transferred');
 const streamFileTotalEl = document.getElementById('stream-file-total');
 const streamingDirectionTxtEl = document.getElementById('streaming-direction-txt');
 const progressRingFillEl = document.getElementById('progress-ring-fill');
 const progressPercentageEl = document.getElementById('progress-percentage');
 const progressSpeedEl = document.getElementById('progress-speed');
 const timeRemainingTxtEl = document.getElementById('time-remaining-txt');
 const diagnosticLogsEl = document.getElementById('diagnostic-logs');
 const errorDetailsBoxEl = document.getElementById('error-details-box');
 const connectingStatusTxtEl = document.getElementById('connecting-status-txt');

 // Receipt Elements
 const receiptFilenameEl = document.getElementById('receipt-filename');
 const receiptSizeEl = document.getElementById('receipt-size');
 const receiptSpeedEl = document.getElementById('receipt-speed');
 const receiptDurationEl = document.getElementById('receipt-duration');

 // ==========================================================================
 // STATE MANAGEMENT ENGINE
 // ==========================================================================

 function transitionTo(state) {
  activeState = state;
  appEl.className = `state-${state}`;
  logSystem(`State Transition: ${state.toUpperCase()}`);

  // State cleanup side-effects
  if (state !== STATE_AWAITING_SCAN && state !== STATE_SCANNING) {
   stopWebcam();
  }
  if (state === STATE_IDLE) {
   resetTransfers();
  }
 }

 function logSystem(message, type = 'system') {
  console.log(`[QR-Share] [${type.toUpperCase()}] ${message}`);
  if (diagnosticLogsEl) {
   const entry = document.createElement('div');
   entry.className = `log-entry ${type}`;
   entry.innerText = `> ${message}`;
   diagnosticLogsEl.appendChild(entry);
   diagnosticLogsEl.scrollTop = diagnosticLogsEl.scrollHeight;
  }
 }

 // ==========================================================================
 // WEBRTC SIGNALING & SDP COMPRESSION PIPELINE
 // ==========================================================================

 /**
  * Strips audio/video & complex parameters to compress SDP matrix
  */
 function mungeSDP(sdp) {
  return sdp.split('\n')
   .map(line => line.trim())
   .filter(line => {
    return !line.startsWith('m=audio') &&
        !line.startsWith('m=video') &&
        !line.startsWith('a=rtpmap') &&
        !line.startsWith('a=fmtp') &&
        !line.startsWith('a=ssrc') &&
        !line.startsWith('a=msid') &&
        !line.startsWith('a=extmap') &&
        line.length > 0;
   })
   .join('\r\n') + '\r\n';
 }

 /**
  * Compresses SDP: Munge -> DEFLATE (pako) -> Base64
  */
 function compressSDP(sdp) {
  const munged = mungeSDP(sdp);
  const compressedBytes = pako.deflate(munged, { level: 9 });
  
  // Efficient binary to base64 conversion
  let binary = '';
  const len = compressedBytes.byteLength;
  for (let i = 0; i < len; i++) {
   binary += String.fromCharCode(compressedBytes[i]);
  }
  return btoa(binary);
 }

 /**
  * Decompresses SDP: Base64 -> INFLATE (pako) -> Standard String
  */
 function decompressSDP(base64Str) {
  try {
   const binaryStr = atob(base64Str.trim());
   const len = binaryStr.length;
   const bytes = new Uint8Array(len);
   for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
   }
   return pako.inflate(bytes, { to: 'string' });
  } catch (e) {
   logSystem(`SDP Decompression failed: ${e.message}`, 'error');
   throw new Error("Invalid cryptographic QR payload. Please try re-scanning.");
  }
 }

 function initializePeerConnection() {
  logSystem("Initializing RTCPeerConnection...");
  peerConnection = new RTCPeerConnection(WEBRTC_CONFIG);

  peerConnection.oniceconnectionstatechange = () => {
   const state = peerConnection.iceConnectionState;
   logSystem(`ICE connection state updated: ${state.toUpperCase()}`);
   
   if (state === 'connected') {
    transitionTo(STATE_STREAMING);
    startStreamingStats();
   } else if (state === 'failed' || state === 'disconnected') {
    handleConnectionFailure("Direct connection failed. The network route was lost or blocked by symmetric NAT.");
   }
  };

  peerConnection.onconnectionstatechange = () => {
   logSystem(`Peer connection state updated: ${peerConnection.connectionState.toUpperCase()}`);
   if (peerConnection.connectionState === 'failed') {
    handleConnectionFailure("DTLS Handshake / connection failed.");
   }
  };
 }

 function handleConnectionFailure(details) {
  errorDetailsBoxEl.innerText = details;
  transitionTo(STATE_FAILED);
 }

 // ==========================================================================
 // SENDER ENGINE (Initiator)
 // ==========================================================================

 function startSenderFlow(file) {
  currentAppMode = 'sender';
  selectedFile = file;
  
  // Bind file information to panels
  sendFileNameEl.innerText = file.name;
  sendFileSizeEl.innerText = formatBytes(file.size);
  streamFileNameEl.innerText = file.name;

  transitionTo(STATE_GATHERING_ICE);
  initializePeerConnection();

  // Create primary transfer data channel
  logSystem("Creating ordered RTCDataChannel 'file-transfer'...");
  rtcDataChannel = peerConnection.createDataChannel('file-transfer', { ordered: true });
  setupSenderDataChannel(rtcDataChannel);

  // Create local offer
  peerConnection.createOffer()
   .then(offer => {
    logSystem("Setting local SDP Offer...");
    return peerConnection.setLocalDescription(offer);
   })
   .then(() => {
    logSystem("Gathering network candidates...");
    
    let gatheringDone = false;
    const finalizeICE = () => {
     if (gatheringDone) return;
     gatheringDone = true;
     clearTimeout(iceTimeout);
     logSystem("Proceeding with gathered ICE candidates.");
     generateOfferQR();
    };

    // Safety timeout fallback (800ms) to prevent infinite hangs due to blocked STUN queries
    const iceTimeout = setTimeout(() => {
     logSystem("ICE gathering safety timeout triggered. Proceeding with current candidates.", "warning");
     finalizeICE();
    }, 800);

    peerConnection.onicecandidate = (event) => {
     if (!event.candidate) {
      logSystem("ICE Candidate gathering complete.");
      finalizeICE();
     }
    };
   })
   .catch(err => {
    logSystem(`Offer creation failed: ${err.message}`, 'error');
    handleConnectionFailure(`Failed to initialize WebRTC local handshake: ${err.message}`);
   });
 }

 function generateOfferQR() {
  try {
   const localSdp = peerConnection.localDescription.sdp;
   logSystem("Compressing local SDP...");
   const compressedStr = compressSDP(localSdp);
   currentCompressedOffer = compressedStr;
   
   logSystem(`SDP compressed down to ${compressedStr.length} chars (reduced from ${localSdp.length} chars)`);

   // Generate canvas QR Code using QRious
   new QRious({
    element: document.getElementById('qr-offer-canvas'),
    value: compressedStr,
    size: 300,
    level: 'L' // Low error correction to keep matrix dense but readable
   });

   // Automated 100x Zero Friction Share Link clipboard copy
   const shareLink = window.location.origin + window.location.pathname + '#offer=' + compressedStr;
   currentShareLink = shareLink;
   logSystem("Share Link generated successfully.", "success");

   transitionTo(STATE_AWAITING_SCAN);
  } catch (e) {
   logSystem(`QR Generation failed: ${e.message}`, 'error');
   handleConnectionFailure(`Failed to generate optical handshake matrix: ${e.message}`);
  }
 }

 function handleReceiverAnswerScan(answerBase64) {
  try {
   logSystem("Optical QR detected! Parsing receiver SDP Answer...");
   const answerSdp = decompressSDP(answerBase64);
   
   // Ensure answer SDP structure matches WebRTC protocol requirements
   let formattedSdp = answerSdp;
   if (!answerSdp.includes('v=0')) {
    // Reconstruct base metadata if munging stripped header items
    formattedSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" + answerSdp;
   }

   // Normalize all line endings to strict standard CRLF (\r\n) for standard parser safety
   const normalizedSdp = formattedSdp.split('\r\n').join('\n').split('\n').join('\r\n');

   const remoteDesc = new RTCSessionDescription({
    type: 'answer',
    sdp: normalizedSdp
   });

   transitionTo(STATE_CONNECTING);
   connectingStatusTxtEl.innerText = "Synchronizing keys with Receiver...";

   peerConnection.setRemoteDescription(remoteDesc)
    .then(() => {
     logSystem("Remote description set successfully. Peer handshake locked.", 'success');
    })
    .catch(err => {
     logSystem(`Failed to apply remote description: ${err.message}`, 'error');
     handleConnectionFailure(`Handshake sync failed: ${err.message}`);
    });
  } catch (err) {
   logSystem(`Handshake parsing error: ${err.message}`, 'error');
   alert(err.message);
  }
 }

 function setupSenderDataChannel(channel) {
  channel.binaryType = 'arraybuffer';
  
  channel.onopen = () => {
   logSystem("DataChannel opened with peer. Preparing slice stream...", 'success');
   transitionTo(STATE_STREAMING);
   streamingDirectionTxtEl.innerText = "Sending Data...";
   startStreamingStats();
   sendFileSlices();
  };

  channel.onclose = () => {
   logSystem("DataChannel closed.");
   if (activeState === STATE_STREAMING) {
    handleConnectionFailure("The receiver terminated the connection prematurely.");
   }
  };

  channel.onerror = (err) => {
   logSystem(`DataChannel error: ${err.message}`, 'error');
   handleConnectionFailure(`DataChannel transfer error: ${err.message}`);
  };
 }

 // Backpressure-aware chunked buffer delivery logic
 function sendFileSlices() {
  let offset = 0;
  rtcDataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

  // Send metadata header first as standard JSON
  const header = {
   name: selectedFile.name,
   size: selectedFile.size,
   type: selectedFile.type
  };
  logSystem(`Sending file header: ${JSON.stringify(header)}`);
  rtcDataChannel.send(JSON.stringify(header));

  function transmitNextBatch() {
   while (offset < selectedFile.size) {
    if (rtcDataChannel.bufferedAmount > rtcDataChannel.bufferedAmountLowThreshold) {
     // Internal browser queue buffer full. Pause and wait for 'bufferedamountlow' trigger
     return;
    }

    const slice = selectedFile.slice(offset, offset + CHUNK_SIZE);
    const reader = new FileReader();
    
    reader.onload = (event) => {
     if (rtcDataChannel.readyState !== 'open') return;

     rtcDataChannel.send(event.target.result);
     offset += slice.size;
     receivedBytesTotal = offset; // Sync total for stats counter
     
     if (offset >= selectedFile.size) {
      logSystem("Byte queue fully streamed.", 'success');
      // Wait slightly for browser internal stacks to flush
      setTimeout(() => {
       transitionTo(STATE_COMPLETED);
       populateReceipt(selectedFile.name, selectedFile.size);
      }, 300);
     } else {
      transmitNextBatch();
     }
    };

    reader.readAsArrayBuffer(slice);
    return; // Break standard JS thread block; wait for FileReader async resolver
   }
  }

  rtcDataChannel.onbufferedamountlow = () => {
   transmitNextBatch();
  };

  transmitNextBatch();
 }

 // ==========================================================================
 // RECEIVER ENGINE (Joiner)
 // ==========================================================================

 function startReceiverFlow() {
  currentAppMode = 'receiver';
  transitionTo(STATE_SCANNING);
 }

 function handleSenderOfferScan(offerBase64) {
  try {
   logSystem("Optical Offer QR detected! Generating Peer Connection...");
   stopWebcam();
   
   const offerSdp = decompressSDP(offerBase64);
   
   // Ensure offer SDP header alignment
   let formattedSdp = offerSdp;
   if (!offerSdp.includes('v=0')) {
    formattedSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" + offerSdp;
   }

   // Normalize all line endings to strict standard CRLF (\r\n) for standard parser safety
   const normalizedSdp = formattedSdp.split('\r\n').join('\n').split('\n').join('\r\n');

   initializePeerConnection();

   // Hook incoming data channels
   peerConnection.ondatachannel = (event) => {
    logSystem("Received remote DataChannel registration from sender.");
    setupReceiverDataChannel(event.channel);
   };

   const remoteDesc = new RTCSessionDescription({
    type: 'offer',
    sdp: normalizedSdp
   });

   peerConnection.setRemoteDescription(remoteDesc)
    .then(() => {
     logSystem("Remote description configured. Generating SDP Answer...");
     return peerConnection.createAnswer();
    })
    .then(answer => {
     logSystem("Setting local description answer...");
     return peerConnection.setLocalDescription(answer);
    })
    .then(() => {
     logSystem("Gathering local ICE routes...");
     transitionTo(STATE_GATHERING_ICE);
     
     let gatheringDone = false;
     const finalizeICE = () => {
      if (gatheringDone) return;
      gatheringDone = true;
      clearTimeout(iceTimeout);
      logSystem("ICE gathering finalized. Displaying Answer QR...");
      generateAnswerQR();
     };

     // Safety timeout fallback (800ms) to prevent infinite hangs due to blocked STUN queries
     const iceTimeout = setTimeout(() => {
      logSystem("ICE gathering safety timeout triggered. Proceeding with current candidates.", "warning");
      finalizeICE();
     }, 800);

     peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
       logSystem("ICE Candidate gathering complete.");
       finalizeICE();
      }
     };
    })
    .catch(err => {
     logSystem(`Receiver handshake failed: ${err.message}`, 'error');
     handleConnectionFailure(`Failed to establish joiner handshakes: ${err.message}`);
    });
  } catch (err) {
   logSystem(`Handshake parse error: ${err.message}`, 'error');
   alert(err.message);
   // Resume scanner if scanning fails
   startWebcamScanner('receiver-video', handleSenderOfferScan);
  }
 }

 function generateAnswerQR() {
  try {
   const localSdp = peerConnection.localDescription.sdp;
   logSystem("Compressing answer SDP...");
   const compressedStr = compressSDP(localSdp);
   currentCompressedAnswer = compressedStr;

   // Draw response QR
   new QRious({
    element: document.getElementById('qr-answer-canvas'),
    value: compressedStr,
    size: 300,
    level: 'L'
   });

   // Automated 100x Zero Friction Answer Code clipboard copy
   logSystem("Answer code generated successfully.", "success");

   transitionTo(STATE_AWAITING_RESPONSE);
  } catch (e) {
   logSystem(`Answer QR Generation failed: ${e.message}`, 'error');
   handleConnectionFailure(`Failed to generate optical handshake response: ${e.message}`);
  }
 }

 function setupReceiverDataChannel(channel) {
  rtcDataChannel = channel;
  rtcDataChannel.binaryType = 'arraybuffer';
  
  rtcDataChannel.onopen = () => {
   logSystem("DataChannel handshaking complete. Listening for byte streams...", 'success');
   transitionTo(STATE_STREAMING);
   streamingDirectionTxtEl.innerText = "Receiving Data...";
   startStreamingStats();
  };

  rtcDataChannel.onmessage = (event) => {
   if (typeof event.data === 'string') {
    // First inbound frame is file metadata
    fileMetadata = JSON.parse(event.data);
    logSystem(`Received file header metadata: ${event.data}`);
    
    streamFileNameEl.innerText = fileMetadata.name;
    streamFileTotalEl.innerText = formatBytes(fileMetadata.size);
    fileChunks = [];
    receivedBytesTotal = 0;
   } else {
    // Subsequent frames are binary buffer slices
    fileChunks.push(event.data);
    receivedBytesTotal += event.data.byteLength;
    
    if (fileMetadata && receivedBytesTotal >= fileMetadata.size) {
     logSystem("All expected bytes received! Reassembling buffer array...", 'success');
     
     const fileBlob = new Blob(fileChunks, { type: fileMetadata.type || 'application/octet-stream' });
     triggerFileDownload(fileBlob, fileMetadata.name);
     
     transitionTo(STATE_COMPLETED);
     populateReceipt(fileMetadata.name, fileMetadata.size);
    }
   }
  };

  rtcDataChannel.onclose = () => {
   logSystem("Receiver DataChannel closed.");
   if (activeState === STATE_STREAMING) {
    handleConnectionFailure("The sender disconnected before file reassembly was completed.");
   }
  };

  rtcDataChannel.onerror = (err) => {
   logSystem(`DataChannel receiver error: ${err.message}`, 'error');
   handleConnectionFailure(`DataChannel receipt error: ${err.message}`);
  };
 }

 function triggerFileDownload(blob, filename) {
  const downloadUrl = URL.createObjectURL(blob);
  const downloadAnchor = document.createElement('a');
  downloadAnchor.href = downloadUrl;
  downloadAnchor.download = filename;
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  
  // Free memory safely
  setTimeout(() => {
   document.body.removeChild(downloadAnchor);
   URL.revokeObjectURL(downloadUrl);
  }, 100);
 }

 // ==========================================================================
 // WEBCAM CAPTURE & OPTICAL SCANNER (jsQR Loop)
 // ==========================================================================

 function startWebcamScanner(videoElementId, successCallback) {
  const videoEl = document.getElementById(videoElementId);
  if (!videoEl) return;

  // Show the placeholder and reset it to initial waiting state
  const container = videoEl.parentElement;
  const placeholder = container ? container.querySelector('.camera-placeholder') : null;
  if (placeholder) {
   placeholder.style.display = 'flex';
   placeholder.innerHTML = `
    <svg class="placeholder-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
    <span>Waiting for camera permission...</span>
   `;
  }

  // Check if scanner-helper-canvas exists, create if not
  let canvasEl = document.getElementById('scanner-helper-canvas');
  if (!canvasEl) {
   canvasEl = document.createElement('canvas');
   canvasEl.id = 'scanner-helper-canvas';
   canvasEl.style.display = 'none';
   document.body.appendChild(canvasEl);
  }
  const canvasCtx = canvasEl.getContext('2d', { willReadFrequently: true });

  const mediaConstraints = {
   video: { facingMode: 'environment' }, // Default to back camera on mobile
   audio: false
  };

  navigator.mediaDevices.getUserMedia(mediaConstraints)
   .then(stream => {
    activeWebcamStream = stream;
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', true);
    
    // Hide the placeholder text overlay only once the video starts actual playback!
    videoEl.onplaying = () => {
     if (placeholder) {
      placeholder.style.display = 'none';
     }
    };
    
    videoEl.play();
    
    logSystem("Webcam stream active. Scanning frame arrays...");
    
    // QR Scanning frame loop
    function scanWebcamFrame() {
     if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
      
      canvasCtx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
      const imgData = canvasCtx.getImageData(0, 0, canvasEl.width, canvasEl.height);
      
      const qrDecoded = jsQR(imgData.data, imgData.width, imgData.height, {
       inversionAttempts: 'dontInvert'
      });

      if (qrDecoded && qrDecoded.data) {
       logSystem("Optical matrix decoded successfully.");
       successCallback(qrDecoded.data);
       return;
      }
     }
     scanningAnimationId = requestAnimationFrame(scanWebcamFrame);
    }
    
    scanningAnimationId = requestAnimationFrame(scanWebcamFrame);
   })
   .catch(err => {
    logSystem(`Webcam activation failed: ${err.message}`, 'error');
    // Render detailed permissions notice in placeholder
    if (placeholder) {
     placeholder.innerHTML = `
      <svg class="placeholder-icon" style="color: var(--accent-red);" fill="none" viewBox="0 0 24 24" stroke="currentColor">
       <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <span style="font-weight: 500; color: var(--text-primary);">Camera Blocked</span>
      <span style="font-size: 0.75rem; color: var(--text-muted); max-width: 32ch;">Enable camera permissions, or use the manual fallback console below.</span>
     `;
    }
   });
 }

 function stopWebcam() {
  if (scanningAnimationId) {
   cancelAnimationFrame(scanningAnimationId);
   scanningAnimationId = null;
  }
  if (activeWebcamStream) {
   activeWebcamStream.getTracks().forEach(track => track.stop());
   activeWebcamStream = null;
   logSystem("Webcam stream disabled.");
  }
  // Cleanly clear video feed source and restore placeholders
  document.querySelectorAll('.webcam-feed').forEach(videoEl => {
   videoEl.pause();
   videoEl.srcObject = null;
   const container = videoEl.parentElement;
   if (container) {
    const placeholder = container.querySelector('.camera-placeholder');
    if (placeholder) {
     placeholder.style.display = 'flex';
    }
   }
  });
 }

 // ==========================================================================
 // REAL-TIME STATS & PROGRESS TRACKER
 // ==========================================================================

 function startStreamingStats() {
  transferStartTime = Date.now();
  let lastBytesTransferred = 0;
  
  // Circular SVG track configurations
  const trackCircumference = 439.8; // 2 * pi * r (r=70)
  
  if (progressRingFillEl) {
   progressRingFillEl.style.strokeDashoffset = trackCircumference;
  }

  speedCalculatorInterval = setInterval(() => {
   if (activeState !== STATE_STREAMING) return;
   
   const currentTime = Date.now();
   const elapsedSec = (currentTime - transferStartTime) / 1000;
   
   // Calculate speeds
   const bytesInInterval = receivedBytesTotal - lastBytesTransferred;
   const speedBps = bytesInInterval; // Per 1 second
   lastBytesTransferred = receivedBytesTotal;

   const totalExpected = (currentAppMode === 'sender') ? selectedFile.size : fileMetadata.size;
   const progressPercent = Math.min(100, Math.floor((receivedBytesTotal / totalExpected) * 100));

   // Update Text elements
   progressPercentageEl.innerText = `${progressPercent}%`;
   progressSpeedEl.innerText = `${formatBytes(speedBps)}/s`;
   
   streamFileTransferredEl.innerText = formatBytes(receivedBytesTotal);

   // Circular Ring fill percentage calculations
   if (progressRingFillEl) {
    const fillOffset = trackCircumference - (progressPercent / 100) * trackCircumference;
    progressRingFillEl.style.strokeDashoffset = fillOffset;
   }

   // Estimate remaining duration
   if (speedBps > 0) {
    const remainingBytes = totalExpected - receivedBytesTotal;
    const remainingSec = remainingBytes / speedBps;
    timeRemainingTxtEl.innerText = formatDuration(remainingSec);
   } else {
    timeRemainingTxtEl.innerText = "Calculating...";
   }

  }, 1000);
 }

 function stopStreamingStats() {
  if (speedCalculatorInterval) {
   clearInterval(speedCalculatorInterval);
   speedCalculatorInterval = null;
  }
 }

 function populateReceipt(filename, size) {
  stopStreamingStats();
  
  const elapsedMs = Date.now() - transferStartTime;
  const elapsedSec = elapsedMs / 1000;
  const avgSpeedBytes = size / elapsedSec;

  receiptFilenameEl.innerText = filename;
  receiptSizeEl.innerText = formatBytes(size);
  receiptSpeedEl.innerText = `${formatBytes(avgSpeedBytes)}/s`;
  receiptDurationEl.innerText = formatDuration(elapsedSec);

  // Dynamic Title Updates
  document.getElementById('completed-title-txt').innerText = 
   (currentAppMode === 'sender') ? "File Sent Successfully" : "File Received Successfully";
 }

 // ==========================================================================
 // HELPER UTILITY SCHEMAS
 // ==========================================================================

 function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
 }

 function formatDuration(sec) {
  if (sec < 60) {
   return `${sec.toFixed(1)}s`;
  }
  const mins = Math.floor(sec / 60);
  const remainSec = sec % 60;
  return `${mins}m ${remainSec.toFixed(0)}s`;
 }

 function resetTransfers() {
  stopWebcam();
  stopStreamingStats();

  if (rtcDataChannel) {
   rtcDataChannel.close();
   rtcDataChannel = null;
  }
  if (peerConnection) {
   peerConnection.close();
   peerConnection = null;
  }

  selectedFile = null;
  fileMetadata = null;
  fileChunks = [];
  receivedBytesTotal = 0;
  transferStartTime = null;
  currentAppMode = null;

  if (fileInputEl) fileInputEl.value = '';
  if (manualSdpOfferEl) manualSdpOfferEl.value = '';
  if (manualSdpAnswerEl) manualSdpAnswerEl.value = '';
  if (diagnosticLogsEl) diagnosticLogsEl.innerHTML = '';
  
  // Automatically reset tab switchers back to default "Remote Link" state
  const resetSegmentedTabs = (tabsContainerEl, remoteViewEl, localViewEl) => {
   if (!tabsContainerEl) return;
   tabsContainerEl.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.getAttribute('data-tab') === 'remote') {
     btn.classList.add('active');
    } else {
     btn.classList.remove('active');
    }
   });
   if (remoteViewEl) remoteViewEl.style.display = 'block';
   if (localViewEl) localViewEl.style.display = 'none';
  };
  resetSegmentedTabs(senderTabsEl, senderViewRemoteEl, senderViewLocalEl);
  resetSegmentedTabs(receiverTabsEl, receiverViewRemoteEl, receiverViewLocalEl);
  resetSegmentedTabs(receiverResponseTabsEl, receiverResponseViewRemoteEl, receiverResponseViewLocalEl);

  currentCompressedOffer = '';
  currentCompressedAnswer = '';
  currentShareLink = '';
 }

 // ==========================================================================
 // USER INPUT EVENT HOOKS
 // ==========================================================================

 // Welcome page input handlers
 if (fileInputEl) {
  fileInputEl.addEventListener('change', (e) => {
   const file = e.target.files[0];
   if (file) startSenderFlow(file);
  });
 }

 if (dropzoneEl) {
  ['dragenter', 'dragover'].forEach(eventName => {
   dropzoneEl.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzoneEl.classList.add('dragover');
   }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
   dropzoneEl.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('dragover');
   }, false);
  });

  dropzoneEl.addEventListener('drop', (e) => {
   const file = e.dataTransfer.files[0];
   if (file) startSenderFlow(file);
  });
 }

 btnReceiveModeEl.addEventListener('click', startReceiverFlow);

 // Cancellation bindings
 [btnCancelSendEl, btnCancelReceiveEl, btnCancelResponseEl].forEach(btn => {
  if (btn) btn.addEventListener('click', () => transitionTo(STATE_IDLE));
 });

 [btnSuccessResetEl, btnErrorResetEl].forEach(btn => {
  if (btn) btn.addEventListener('click', () => transitionTo(STATE_IDLE));
 });

 // Manual fallback connect handler (Joiner)
 btnManualSubmitEl.addEventListener('click', () => {
  const rawInput = manualSdpOfferEl.value;
  if (rawInput.trim().length > 0) {
   handleSenderOfferScan(rawInput.trim());
  } else {
   alert("Please paste a valid connection payload.");
  }
 });

 // Copy SDP Offer Code Action (Sender)
 if (btnCopyOfferEl) {
  btnCopyOfferEl.addEventListener('click', () => {
   if (currentCompressedOffer) {
    navigator.clipboard.writeText(currentCompressedOffer)
     .then(() => {
      const originalHtml = btnCopyOfferEl.innerHTML;
      btnCopyOfferEl.innerHTML = `
       <svg class="btn-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
       </svg>
       Copied!
      `;
      btnCopyOfferEl.style.borderColor = 'var(--accent-emerald)';
      btnCopyOfferEl.style.color = 'var(--accent-emerald)';
      setTimeout(() => {
       btnCopyOfferEl.innerHTML = originalHtml;
       btnCopyOfferEl.style.borderColor = '';
       btnCopyOfferEl.style.color = '';
      }, 1500);
      logSystem("Offer SDP copied to clipboard.");
     })
     .catch(err => {
      logSystem(`Clipboard copy failed: ${err.message}`, 'error');
     });
   }
  });
 }

 // Copy SDP Answer Code Action (Receiver)
 function setupAnswerCopyHandler(btn) {
  if (!btn) return;
  btn.addEventListener('click', () => {
   if (currentCompressedAnswer) {
    navigator.clipboard.writeText(currentCompressedAnswer)
     .then(() => {
      const originalHtml = btn.innerHTML;
      btn.innerHTML = `
       <svg class="btn-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
       </svg>
       Copied!
      `;
      btn.style.borderColor = 'var(--accent-emerald)';
      btn.style.color = 'var(--accent-emerald)';
      if (btn.classList.contains('btn-primary')) {
       btn.style.backgroundColor = 'var(--bg-elevated)';
      }
      setTimeout(() => {
       btn.innerHTML = originalHtml;
       btn.style.borderColor = '';
       btn.style.color = '';
       if (btn.classList.contains('btn-primary')) {
        btn.style.backgroundColor = '';
       }
      }, 1500);
      logSystem("Answer SDP copied to clipboard.");
     })
     .catch(err => {
      logSystem(`Clipboard copy failed: ${err.message}`, 'error');
     });
   }
  });
 }
 setupAnswerCopyHandler(btnCopyAnswerEl);
 setupAnswerCopyHandler(btnCopyAnswerRemoteEl);

 // Connect manually on sender side (pasting receiver's answer)
 if (btnManualAnswerSubmitEl) {
  btnManualAnswerSubmitEl.addEventListener('click', () => {
   const rawInput = manualSdpAnswerEl.value;
   if (rawInput.trim().length > 0) {
    handleReceiverAnswerScan(rawInput.trim());
   } else {
    alert("Please paste a valid connection payload.");
   }
  });
 }

 // Click-to-Paste Answer Code Action (Sender)
 if (btnSenderPasteConnectEl) {
  btnSenderPasteConnectEl.addEventListener('click', () => {
   navigator.clipboard.readText()
    .then(text => {
     if (text.trim().length > 0) {
      logSystem("Clipboard Answer code ingested successfully.");
      handleReceiverAnswerScan(text.trim());
     } else {
      alert("Clipboard is empty. Copy your peer's Answer first.");
     }
    })
    .catch(err => {
     logSystem(`Clipboard read blocked: ${err.message}. Falling back to manual text input.`, "error");
     manualSdpAnswerEl.style.display = 'block';
     btnManualAnswerSubmitEl.style.display = 'block';
     btnSenderPasteConnectEl.style.display = 'none';
    });
  });
 }

 // Click-to-Paste Share Link Action (Receiver)
 if (btnReceiverPasteConnectEl) {
  btnReceiverPasteConnectEl.addEventListener('click', () => {
   navigator.clipboard.readText()
    .then(text => {
     let cleanText = text.trim();
     if (cleanText.includes('#offer=')) {
      cleanText = cleanText.split('#offer=')[1];
     }
     if (cleanText.length > 0) {
      logSystem("Clipboard Share Link ingested successfully.");
      handleSenderOfferScan(cleanText);
     } else {
      alert("Clipboard is empty. Copy the Share Link first.");
     }
    })
    .catch(err => {
     logSystem(`Clipboard read blocked: ${err.message}. Falling back to manual text input.`, "error");
     manualSdpOfferEl.style.display = 'block';
     btnManualSubmitEl.style.display = 'block';
     btnReceiverPasteConnectEl.style.display = 'none';
    });
  });
 }

 // Auto-sniff URL Offer Query Hash on DOMContentLoaded
 window.addEventListener('DOMContentLoaded', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#offer=')) {
   const offerPayload = hash.substring(7);
   logSystem("Inbound URL Share Link offer detected. Auto-connecting...", "success");
   
   // Delay initialization slightly to let CDNs and browser rendering paint
   setTimeout(() => {
    handleSenderOfferScan(offerPayload);
   }, 500);
  }
 });

 // Segmented Pill-Tab Switcher Controller (Aesthetic UX Unification)
 function setupSegmentedTabs(tabsContainerEl, remoteViewEl, localViewEl, cameraVideoId, webcamCallback) {
  if (!tabsContainerEl) return;
  
  const tabButtons = tabsContainerEl.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
   btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const selectedTab = btn.getAttribute('data-tab');
    if (selectedTab === 'remote') {
     if (remoteViewEl) remoteViewEl.style.display = 'block';
     if (localViewEl) localViewEl.style.display = 'none';
     stopWebcam();
     logSystem("Switched to Remote P2P Link. Camera shut down.");
    } else {
     if (remoteViewEl) remoteViewEl.style.display = 'none';
     if (localViewEl) localViewEl.style.display = 'block';
     if (cameraVideoId && webcamCallback) {
      logSystem("Switched to Local QR Scan. Requesting webcam feed...");
      startWebcamScanner(cameraVideoId, webcamCallback);
     } else {
      logSystem("Switched to Local QR Scan.");
     }
    }
   });
  });
 }

 // Initialize Switchers
 setupSegmentedTabs(senderTabsEl, senderViewRemoteEl, senderViewLocalEl, 'sender-video', handleReceiverAnswerScan);
 setupSegmentedTabs(receiverTabsEl, receiverViewRemoteEl, receiverViewLocalEl, 'receiver-video', handleSenderOfferScan);
 setupSegmentedTabs(receiverResponseTabsEl, receiverResponseViewRemoteEl, receiverResponseViewLocalEl, null, null);

 // Explicit Copy Share Link Button click handler (Sender)
 if (btnCopyShareLinkEl) {
  btnCopyShareLinkEl.addEventListener('click', () => {
   if (currentShareLink) {
    navigator.clipboard.writeText(currentShareLink)
     .then(() => {
      const originalHtml = btnCopyShareLinkEl.innerHTML;
      btnCopyShareLinkEl.innerHTML = `
       <svg class="btn-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
       </svg>
       Copied Link!
      `;
      btnCopyShareLinkEl.style.backgroundColor = 'var(--bg-elevated)';
      btnCopyShareLinkEl.style.borderColor = 'var(--accent-emerald)';
      btnCopyShareLinkEl.style.color = 'var(--accent-emerald)';
      setTimeout(() => {
       btnCopyShareLinkEl.innerHTML = originalHtml;
       btnCopyShareLinkEl.style.backgroundColor = '';
       btnCopyShareLinkEl.style.borderColor = '';
       btnCopyShareLinkEl.style.color = '';
      }, 1500);
      logSystem("Share Link copied to clipboard.");
     })
     .catch(err => {
      logSystem(`Clipboard copy failed: ${err.message}`, 'error');
     });
   }
  });
 }

})();
