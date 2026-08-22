// Bumped on every push to this repo — shown in the header next to the
// subtitle. Simple incrementing build number, not semver: there's no
// meaningful "breaking change" concept for a single-page kid tool.
const APP_VERSION = 'v2.25';

window.__ovl = window.__ovl || { t:null };

// EARLY ZOOM VALIDATION - prevents tiny render on page load
(function() {
  try {
    // Check for reset parameter
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reset_zoom') === '1' || urlParams.get('reset') === '1') {
      localStorage.removeItem('app_zoom');
      localStorage.removeItem('build_zoom');
      localStorage.removeItem('play_zoom');
    }
    
    // Validate saved zoom immediately
    const savedZoom = localStorage.getItem('app_zoom');
    if (savedZoom) {
      const z = parseFloat(savedZoom);
      if (isNaN(z) || z < 0.5 || z > 3) {
        console.warn('[Zoom] Invalid saved zoom detected on load:', savedZoom, '- removing');
        localStorage.removeItem('app_zoom');
      }
    }
  } catch(e) {}
})();

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// ========================================
// BLUETOOTH FLASHING (Partial Flashing Service)
// ========================================
const PFS_SERVICE = 'e97dd91d-251d-470a-a062-fa1922dfa9a8';
const PFS_CHAR = 'e97d3b10-251d-470a-a062-fa1922dfa9a8';

// Partial Flashing commands
const PFS_CMD = {
  REGION_INFO: 0x00,
  FLASH_DATA: 0x01,
  END_OF_TX: 0x02,
  STATUS: 0xEE,
  RESET: 0xFF
};

// Flash state
const flashState = {
  device: null,
  server: null,
  pfsChar: null,
  hexData: null,
  isFlashing: false,
  progress: 0,
  packetNum: 0,
  resolve: null,
  reject: null
};

// Update flash UI
function updateFlashUI(status, progress) {
  const statusEl = document.getElementById('flashStatus');
  const barEl = document.getElementById('flashBar');
  const progressEl = document.getElementById('flashProgress');
  const flashBtn = document.getElementById('flashBtn');
  
  if (status) {
    progressEl.style.display = 'block';
    statusEl.textContent = status;
  }
  if (progress !== undefined) {
    barEl.style.width = progress + '%';
  }
  if (flashBtn) {
    flashBtn.disabled = flashState.isFlashing;
    flashBtn.classList.toggle('flashing', flashState.isFlashing);
    flashBtn.textContent = flashState.isFlashing ? '⏳ Flashing...' : '⚡ Flash to micro:bit';
  }
}

// MakeCode compilation via iframe messaging
const MakeCodeCompiler = {
  iframe: null,
  pendingCompile: null,
  isReady: false,
  
  init() {
    this.iframe = document.getElementById('makecodeFrame');
    if (!this.iframe) return;
    
    // Listen for messages from MakeCode
    window.addEventListener('message', (e) => this.handleMessage(e));
  },
  
  handleMessage(e) {
    // Accept messages from MakeCode domains
    if (!e.origin.includes('makecode.microbit.org') && !e.origin.includes('makecode.com')) return;
    
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    
    console.log('[MakeCode] Message:', data.type || data.action);
    
    if (data.type === 'pxthost') {
      if (data.action === 'workspacesync') {
        // MakeCode is ready
        this.isReady = true;
        console.log('[MakeCode] Editor ready');
      }
    }
    
    // Handle compiled hex response
    if (data.type === 'pxthost' && data.action === 'workspacesave') {
      if (this.pendingCompile && data.project && data.project.text) {
        // Find the hex file in the response
        const hexFile = Object.keys(data.project.text).find(k => k.endsWith('.hex'));
        if (hexFile) {
          this.pendingCompile.resolve(data.project.text[hexFile]);
          this.pendingCompile = null;
        }
      }
    }
  },
  
  // Compile TypeScript code to hex using MakeCode's compile endpoint
  async compile(tsCode) {
    updateFlashUI('Compiling code...', 5);
    
    // Use MakeCode's cloud compile API
    try {
      const response = await fetch('https://makecode.microbit.org/api/compile/v3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            name: 'Keyes 4WD Mecanum Remote',
            dependencies: {
              bluetooth: '*',
              core: '*',
              microphone: '*',
              'pxt-mecanum-robot-v2': 'github:keyestudio2019/mecanum_robot_v2'
            },
            files: ['main.ts'],
            supportedTargets: ['microbit']
          },
          files: {
            'main.ts': tsCode
          }
        })
      });
      
      if (!response.ok) throw new Error('Compile request failed');
      
      const result = await response.json();
      if (result.hex) {
        return result.hex;
      } else if (result.hexurl) {
        // Fetch the hex from the URL
        const hexResponse = await fetch(result.hexurl);
        return await hexResponse.text();
      }
      throw new Error('No hex in compile response');
    } catch (err) {
      console.error('[MakeCode] Compile error:', err);
      throw err;
    }
  }
};

// Parse Intel HEX format
function parseIntelHex(hexString) {
  const lines = hexString.split('\n').filter(l => l.startsWith(':'));
  const data = [];
  let extendedAddr = 0;
  
  for (const line of lines) {
    const bytes = line.slice(1).match(/.{2}/g).map(h => parseInt(h, 16));
    const byteCount = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];
    const payload = bytes.slice(4, 4 + byteCount);
    
    if (recordType === 0x00) { // Data record
      const fullAddr = extendedAddr + address;
      for (let i = 0; i < payload.length; i++) {
        data.push({ addr: fullAddr + i, byte: payload[i] });
      }
    } else if (recordType === 0x02) { // Extended segment address
      extendedAddr = ((payload[0] << 8) | payload[1]) << 4;
    } else if (recordType === 0x04) { // Extended linear address
      extendedAddr = ((payload[0] << 8) | payload[1]) << 16;
    }
  }
  
  return data;
}

// Connect to micro:bit for flashing
async function connectForFlash() {
  updateFlashUI('Connecting to micro:bit...', 10);
  
  try {
    // Request device with Partial Flashing Service
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [PFS_SERVICE, UART_SERVICE]
    });
    
    flashState.device = device;
    device.addEventListener('gattserverdisconnected', onFlashDisconnect);
    
    updateFlashUI('Connecting to GATT...', 15);
    const server = await device.gatt.connect();
    flashState.server = server;
    
    updateFlashUI('Finding Partial Flash Service...', 20);
    
    try {
      const pfsService = await server.getPrimaryService(PFS_SERVICE);
      flashState.pfsChar = await pfsService.getCharacteristic(PFS_CHAR);
      
      // Enable notifications
      await flashState.pfsChar.startNotifications();
      flashState.pfsChar.addEventListener('characteristicvaluechanged', onPfsNotification);
      
      console.log('[Flash] Partial Flashing Service connected');
      return true;
    } catch (e) {
      console.warn('[Flash] PFS not available:', e.message);
      throw new Error('Partial Flashing Service not available. Please flash a MakeCode program to your micro:bit first via USB, then try again.');
    }
  } catch (err) {
    console.error('[Flash] Connection error:', err);
    throw err;
  }
}

function onFlashDisconnect() {
  console.log('[Flash] Disconnected');
  flashState.device = null;
  flashState.server = null;
  flashState.pfsChar = null;
  if (flashState.isFlashing) {
    flashState.isFlashing = false;
    updateFlashUI('Disconnected during flash', 0);
  }
}

function onPfsNotification(event) {
  const value = new Uint8Array(event.target.value.buffer);
  console.log('[Flash] PFS notification:', Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' '));
  
  // Handle flash acknowledgments
  if (flashState.resolve) {
    flashState.resolve(value);
  }
}

// Flash hex data to micro:bit
async function flashHexToDevice(hexString) {
  if (!flashState.pfsChar) {
    throw new Error('Not connected to Partial Flashing Service');
  }
  
  updateFlashUI('Parsing hex file...', 25);
  
  // Parse the hex file
  const hexData = parseIntelHex(hexString);
  if (hexData.length === 0) {
    throw new Error('Invalid or empty hex file');
  }
  
  console.log('[Flash] Hex parsed:', hexData.length, 'bytes');
  
  // Put micro:bit into flash mode
  updateFlashUI('Entering flash mode...', 30);
  await sendPfsCommand(PFS_CMD.RESET, [0x00]); // Reset to BLE mode
  await sleep(500);
  
  // Get region info
  updateFlashUI('Reading memory map...', 35);
  await sendPfsCommand(PFS_CMD.REGION_INFO, [0x00]);
  await sleep(100);
  
  // Start flashing
  updateFlashUI('Flashing...', 40);
  flashState.isFlashing = true;
  
  // Group data into 16-byte chunks (4 packets per block)
  const chunkSize = 16;
  const totalChunks = Math.ceil(hexData.length / chunkSize);
  let currentChunk = 0;
  
  for (let i = 0; i < hexData.length; i += chunkSize) {
    const chunk = hexData.slice(i, Math.min(i + chunkSize, hexData.length));
    const addr = chunk[0].addr;
    
    // Build flash packet: [0x01, packetNum, addr(4 bytes), data(16 bytes)]
    const packet = new Uint8Array(20);
    packet[0] = PFS_CMD.FLASH_DATA;
    packet[1] = flashState.packetNum % 4;
    packet[2] = (addr >> 0) & 0xFF;
    packet[3] = (addr >> 8) & 0xFF;
    
    for (let j = 0; j < chunk.length && j < 16; j++) {
      packet[4 + j] = chunk[j].byte;
    }
    
    try {
      await flashState.pfsChar.writeValueWithoutResponse(packet);
    } catch (e) {
      console.error('[Flash] Write error:', e);
    }
    
    flashState.packetNum++;
    currentChunk++;
    
    // Update progress every 4 packets (1 block)
    if (flashState.packetNum % 4 === 0) {
      const progress = 40 + Math.floor((currentChunk / totalChunks) * 50);
      updateFlashUI(`Flashing... ${Math.floor((currentChunk / totalChunks) * 100)}%`, progress);
      await sleep(5); // Small delay between blocks
    }
  }
  
  // End of transmission
  updateFlashUI('Finalizing...', 95);
  await sendPfsCommand(PFS_CMD.END_OF_TX, []);
  await sleep(100);
  
  // Reset to application mode
  await sendPfsCommand(PFS_CMD.RESET, [0x01]);
  
  flashState.isFlashing = false;
  updateFlashUI('Flash complete! ✓', 100);
}

async function sendPfsCommand(cmd, data) {
  if (!flashState.pfsChar) return;
  
  const packet = new Uint8Array(1 + data.length);
  packet[0] = cmd;
  for (let i = 0; i < data.length; i++) {
    packet[1 + i] = data[i];
  }
  
  await flashState.pfsChar.writeValueWithoutResponse(packet);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main flash function
async function flashToMicrobit() {
  if (flashState.isFlashing) {
    toast(tr('toast.flashInProgress'), 'warning');
    return;
  }

  // Check Web Bluetooth support
  if (!navigator.bluetooth) {
    toast(tr('toast.webBtNotSupported'), 'error');
    return;
  }
  
  const flashBtn = document.getElementById('flashBtn');
  const progressEl = document.getElementById('flashProgress');
  
  try {
    flashState.isFlashing = true;
    updateFlashUI('Starting...', 0);
    
    // Get the current code from the modal
    const code = document.getElementById('modalCode').textContent;
    if (!code) {
      throw new Error('No code to flash');
    }
    
    // Compile the code
    updateFlashUI('Compiling with MakeCode...', 5);
    
    // For now, we'll use a simplified approach - download the hex and let user flash via USB
    // Full BLE partial flashing requires the micro:bit to already have a compatible runtime
    
    // Try MakeCode compile API
    let hexString;
    try {
      hexString = await MakeCodeCompiler.compile(code);
      console.log('[Flash] Got hex:', hexString.length, 'bytes');
    } catch (compileErr) {
      console.error('[Flash] Compile failed:', compileErr);
      // Fallback: offer to open MakeCode
      toast(tr('toast.couldNotCompile'), 'warning');
      
      // Create a MakeCode share URL with the code
      const encoded = encodeURIComponent(code);
      window.open(`https://makecode.microbit.org/#pub:`, '_blank');
      
      flashState.isFlashing = false;
      updateFlashUI('', 0);
      progressEl.style.display = 'none';
      return;
    }
    
    // Connect and flash
    await connectForFlash();
    await flashHexToDevice(hexString);
    
    toast(tr('toast.flashComplete'), 'success');
    beepSuccess && beepSuccess();
    
    // Close modal after success
    setTimeout(() => {
      document.getElementById('modalBg').classList.remove('show');
      progressEl.style.display = 'none';
    }, 2000);
    
  } catch (err) {
    console.error('[Flash] Error:', err);
    toast(tr('toast.flashFailed', {err: err.message}), 'error');
    updateFlashUI('Error: ' + err.message, 0);
  } finally {
    flashState.isFlashing = false;
    updateFlashUI(null, undefined);
  }
}

// Alternative: Direct USB flashing via WebUSB
async function flashViaUSB() {
  if (!navigator.usb) {
    toast(tr('toast.webUsbNotSupported'), 'error');
    return;
  }
  
  try {
    updateFlashUI('Requesting USB device...', 5);
    
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: 0x0D28 }] // ARM DAPLink
    });
    
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);
    
    // Get the code and compile
    const code = document.getElementById('modalCode').textContent;
    updateFlashUI('Compiling...', 10);
    
    const hexString = await MakeCodeCompiler.compile(code);
    
    // For WebUSB DAPLink flashing, we need the DAP.js library
    // This is complex, so for now we'll download the hex
    updateFlashUI('WebUSB flashing coming soon! Downloading hex instead...', 50);
    
    // Download the hex file
    const blob = new Blob([hexString], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'microbit-remote.hex';
    a.click();
    URL.revokeObjectURL(url);
    
    toast(tr('toast.hexDownloaded'), 'success');
    
  } catch (err) {
    console.error('[USB Flash] Error:', err);
    toast(tr('toast.usbFlashError', {err: err.message}), 'error');
  }
}

// Initialize MakeCode compiler
document.addEventListener('DOMContentLoaded', () => {
  MakeCodeCompiler.init();
});

// ========================================
// END BLUETOOTH FLASHING
// ========================================

const encoder = new TextEncoder();
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ---- Build canvas viewport / zoom / pan ----
// v2.3 separates the *logical design size* from the editor viewport.
// A 1372x776 imported CFG stays 1372x776 for layout/export, while Build may
// display it at 55%, 80%, etc. This avoids clipping large designs and avoids
// corrupting their x/y/w/h coordinates just to make them fit the browser.
function findCanvasDropzone(){
  return document.getElementById('canvas');
}

function getBuildLogicalSize(){
  if (state.buildCanvasSize && Number(state.buildCanvasSize.w) > 0 && Number(state.buildCanvasSize.h) > 0) {
    return { w: Math.round(Number(state.buildCanvasSize.w)), h: Math.round(Number(state.buildCanvasSize.h)) };
  }
  let maxX = 400, maxY = 300;
  (state.widgets || []).forEach(w => {
    maxX = Math.max(maxX, Number(w.x || 0) + Number(w.w || 0) + 20);
    maxY = Math.max(maxY, Number(w.y || 0) + Number(w.h || 0) + 20);
  });
  return { w: maxX, h: maxY };
}

function ensureBuildCanvasViewport(){
  const canvas = document.getElementById('canvas');
  if (!canvas) return null;
  let viewport = canvas.closest('.build-canvas-viewport');
  if (!viewport) {
    viewport = document.createElement('div');
    viewport.className = 'build-canvas-viewport';
    const stage = document.createElement('div');
    stage.className = 'build-canvas-stage';
    const parent = canvas.parentElement;
    parent.insertBefore(viewport, canvas);
    viewport.appendChild(stage);
    stage.appendChild(canvas);

    const badge = document.createElement('div');
    badge.className = 'canvas-size-badge build-canvas-badge';
    badge.id = 'buildCanvasBadge';
    viewport.appendChild(badge);

    // Alt/Option + drag (or middle mouse) pans without touching widgets.
    let panning = false, sx = 0, sy = 0, sl = 0, st = 0;
    viewport.addEventListener('pointerdown', e => {
      if (!(e.button === 1 || e.altKey)) return;
      e.preventDefault();
      panning = true; sx = e.clientX; sy = e.clientY; sl = viewport.scrollLeft; st = viewport.scrollTop;
      viewport.classList.add('is-panning');
      try { viewport.setPointerCapture(e.pointerId); } catch(_) {}
    });
    viewport.addEventListener('pointermove', e => {
      if (!panning) return;
      viewport.scrollLeft = sl - (e.clientX - sx);
      viewport.scrollTop = st - (e.clientY - sy);
    });
    const endPan = () => { panning = false; viewport.classList.remove('is-panning'); };
    viewport.addEventListener('pointerup', endPan);
    viewport.addEventListener('pointercancel', endPan);
  }
  return viewport;
}

function updateBuildCanvasBadge(){
  const badge = document.getElementById('buildCanvasBadge');
  if (!badge) return;
  const s = getBuildLogicalSize();
  badge.textContent = `${s.w} × ${s.h}  •  ${Math.round((state.buildZoom || 1) * 100)}%`;
}

function applyBuildCanvasView(){
  const canvas = document.getElementById('canvas');
  const viewport = ensureBuildCanvasViewport();
  if (!canvas || !viewport) return;
  const stage = canvas.parentElement;
  const s = getBuildLogicalSize();
  const z = Math.max(0.15, Math.min(2.5, Number(state.buildZoom || 1)));
  state.buildZoom = z;

  // Strong inline sizing wins over the legacy flexible-canvas CSS rules.
  canvas.style.setProperty('width', s.w + 'px', 'important');
  canvas.style.setProperty('height', s.h + 'px', 'important');
  canvas.style.setProperty('min-width', s.w + 'px', 'important');
  canvas.style.setProperty('min-height', s.h + 'px', 'important');
  canvas.style.setProperty('max-width', 'none', 'important');
  canvas.style.transform = `scale(${z})`;
  canvas.style.transformOrigin = 'top left';

  stage.style.width = Math.max(1, Math.ceil(s.w * z)) + 'px';
  stage.style.height = Math.max(1, Math.ceil(s.h * z)) + 'px';

  const level = document.getElementById('buildZoomLevel');
  if (level) level.textContent = Math.round(z * 100) + '%';
  updateBuildCanvasBadge();
}

function setBuildZoom(z, keepCenter = true){
  state.buildFitActive = false;
  const viewport = ensureBuildCanvasViewport();
  if (!viewport) return;
  const old = Math.max(0.15, Number(state.buildZoom || 1));
  const next = Math.max(0.15, Math.min(2.5, Number(z || 1)));
  let logicalCx = 0, logicalCy = 0;
  if (keepCenter) {
    logicalCx = (viewport.scrollLeft + viewport.clientWidth / 2) / old;
    logicalCy = (viewport.scrollTop + viewport.clientHeight / 2) / old;
  }
  state.buildZoom = next;
  try { localStorage.setItem('build_zoom', String(next)); } catch (_) {}
  applyBuildCanvasView();
  if (keepCenter) {
    viewport.scrollLeft = Math.max(0, logicalCx * next - viewport.clientWidth / 2);
    viewport.scrollTop = Math.max(0, logicalCy * next - viewport.clientHeight / 2);
  }
}

function fitBuildCanvas(){
  state.buildFitActive = true;
  const viewport = ensureBuildCanvasViewport();
  if (!viewport) return;
  const s = getBuildLogicalSize();
  // clientWidth/Height are the real editor viewport, independent of canvas size.
  const pad = 30;
  const availW = Math.max(120, viewport.clientWidth - pad);
  const availH = Math.max(120, viewport.clientHeight - pad);
  const fit = Math.min(availW / s.w, availH / s.h, 1.25);
  state.buildZoom = Math.max(0.15, fit);
  applyBuildCanvasView();
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
}

function centerBuildCanvas(){
  const viewport = ensureBuildCanvasViewport();
  if (!viewport) return;
  const stage = viewport.querySelector('.build-canvas-stage');
  viewport.scrollLeft = Math.max(0, ((stage?.offsetWidth || 0) - viewport.clientWidth) / 2);
  viewport.scrollTop = Math.max(0, ((stage?.offsetHeight || 0) - viewport.clientHeight) / 2);
}

// v2.11: explicitly crop the *logical* Build canvas to the design.
// Fit/zoom are view-only; Trim Canvas is the deliberate geometry operation
// that removes authoring space from exported JSON/CFG and from Play.
function getBuildOccupiedBounds(){
  const widgets = Array.isArray(state.widgets) ? state.widgets.filter(Boolean) : [];
  if (!widgets.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  widgets.forEach(w => {
    const x = Number(w.x) || 0, y = Number(w.y) || 0;
    const ww = Math.max(1, Number(w.w) || 1), hh = Math.max(1, Number(w.h) || 1);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + ww); maxY = Math.max(maxY, y + hh);
  });
  return { minX, minY, maxX, maxY, w: Math.max(1, maxX-minX), h: Math.max(1, maxY-minY) };
}

function trimBuildCanvasToContent(){
  const bounds = getBuildOccupiedBounds();
  if (!bounds) {
    try { toast('Nothing to trim', 'error'); } catch (_) {}
    return;
  }

  const PAD = 24;
  const MIN_W = 320, MIN_H = 240;
  // Snapshot BEFORE changing either widget coordinates or canvas dimensions.
  saveUndoState();

  const dx = PAD - bounds.minX;
  const dy = PAD - bounds.minY;
  state.widgets.forEach(w => {
    w.x = Math.round((Number(w.x) || 0) + dx);
    w.y = Math.round((Number(w.y) || 0) + dy);
  });

  const newW = Math.max(MIN_W, Math.ceil(bounds.w + PAD * 2));
  const newH = Math.max(MIN_H, Math.ceil(bounds.h + PAD * 2));
  state.buildCanvasSize = { w: newW, h: newH };
  // Any Play snapshot/canvas derived from the former geometry is stale now.
  state.config = null;
  state.runtimeCanvasSize = null;

  // Update the existing Build DOM directly. Re-rendering here would run legacy
  // overlap resolution and could change the user's arrangement, which Trim
  // must never do. Children of groups use absolute coordinates, so every
  // widget is shifted exactly once.
  state.widgets.forEach(w => {
    const el = document.querySelector(`.widget[data-id="${CSS.escape(String(w.id))}"]`);
    if (el) { el.style.left = w.x + 'px'; el.style.top = w.y + 'px'; }
  });
  applyBuildCanvasView();
  updateMinimap();
  saveUndoState();
  try { scheduleAutoSave(); } catch (_) {}
  requestAnimationFrame(() => fitBuildCanvas());
  try { toast(`✂ Canvas trimmed to ${newW} × ${newH}`, 'success'); } catch (_) {}
}

// Legacy entry point retained because older code calls it after imports.
function makeCanvasResizable(){
  ensureBuildCanvasViewport();
  applyBuildCanvasView();
}

function setupBuildCanvasViewControls(){
  const byId = id => document.getElementById(id);
  const fit = byId('buildZoomFitBtn');
  const zin = byId('buildZoomInBtn');
  const zout = byId('buildZoomOutBtn');
  const one = byId('buildZoom100Btn');
  const trim = byId('trimCanvasBtn');
  const focus = byId('buildFocusBtn');
  if (fit && !fit.dataset.bound) { fit.dataset.bound='1'; fit.onclick = () => fitBuildCanvas(); }
  if (zin && !zin.dataset.bound) { zin.dataset.bound='1'; zin.onclick = () => setBuildZoom((state.buildZoom || 1) + 0.1); }
  if (zout && !zout.dataset.bound) { zout.dataset.bound='1'; zout.onclick = () => setBuildZoom((state.buildZoom || 1) - 0.1); }
  if (one && !one.dataset.bound) { one.dataset.bound='1'; one.onclick = () => setBuildZoom(1); }
  if (trim && !trim.dataset.bound) { trim.dataset.bound='1'; trim.onclick = () => trimBuildCanvasToContent(); }
  if (focus && !focus.dataset.bound) {
    focus.dataset.bound='1';
    focus.onclick = () => {
      document.body.classList.toggle('build-canvas-focus');
      focus.classList.toggle('active', document.body.classList.contains('build-canvas-focus'));
      requestAnimationFrame(() => fitBuildCanvas());
    };
  }
}

window.addEventListener('resize', () => {
  if (document.querySelector('.builder-view.active')) applyBuildCanvasView();
});

document.addEventListener('keydown', e => {
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
  if (e.key === 'Escape' && document.body.classList.contains('build-canvas-focus')) {
    document.body.classList.remove('build-canvas-focus');
    document.getElementById('buildFocusBtn')?.classList.remove('active');
    requestAnimationFrame(() => fitBuildCanvas());
    return;
  }
  if (document.querySelector('.builder-view.active') && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    fitBuildCanvas();
  }
});

// ===============================
// Kid-friendly i18n + JSON templates
// ===============================
const I18N = {
  en: {
    build: "✏️ Build", play: "▶️ Play",
    subtitle: "Build your own controller",
    soundOn: "Sound On", soundOff: "Sound Off",
    chooseTpl: "🎨 Choose a Template!",
    pickTpl: "Pick one to start building your remote",
    templates: { gamepad:"Game Pad", robot:"Robot", mixer:"DJ Mixer", racing:"Race Car", lights:"Lights", blank:"Start Fresh" },
    buttons: { demo:"🎮 Try All Widgets!", export:"📦 Layout JSON", exportMakeCode:"🧠 MakeCode CFG", import:"📂 Import", templates:"🎨 Templates", code:"📄 Code" },
    hint: "👆 Tap a widget below, then tap the board to place it!",
    titlePlaceholder: "🏷️ Name your remote...",
    toolbar: {
      history: "History", layout: "Layout", theme: "Theme",
      undo: "Undo", undoTitle: "Undo (Ctrl+Z)",
      redo: "Redo", redoTitle: "Redo (Ctrl+Y)",
      tidy: "Tidy", tidyTitle: "Auto-arrange widgets",
      trim: "Trim Canvas", trimTitle: "Crop the logical canvas to the occupied widgets while preserving their relative layout"
    },
    themeNames: { dark:"Dark", ocean:"Ocean", space:"Space", candy:"Fire", forest:"Forest" },
    themeTitles: { dark:"Dark theme", ocean:"Ocean theme", space:"Space theme", candy:"Fire theme", forest:"Forest theme" },
    widgets: { button:"Button", slider:"Slider", toggle:"Switch", joystick:"Joystick", dpad:"D-Pad", dpad_leftright:"Turn Pad", xypad:"XY Pad", led:"Light", label:"Label", group:"Group", separator:"Line", gauge:"Gauge", graph:"Graph", battery:"Battery", timer:"Timer" },
    propsTitle: "🛠️ Widget Properties",
    propsCollapseTitle: "Collapse",
    propsEmptyTitle: "Nothing selected",
    propsEmptyHint: "Tap any widget on the canvas to change its color, label, and size.",
    backToBuild: "← Back to Build",
    arrange: "📐 Arrange", arrangeDone: "✓ Done",
    reloadConfig: "↻ Reload Config",
    reloadConfigTitle: "Clear this device's cached config and fetch it again from the micro:bit",
    share: "⧉ Share",
    shareTitleBtn: "Show a QR code so someone else can open this app",
    shareHeading: "Share this app",
    shareHint: "Scan to open the controller on another phone or tablet.",
    shareClose: "Tap anywhere to close",
    fullscreen: "⛶ Fullscreen",
    fullscreenExit: "⛶ Exit Fullscreen",
    arrangeHint: '👆 Drag widgets to rearrange • Tap "Done" when finished',
    connect: "Tap to Connect!", connected: "Connected! 🎉",
    runtimeConnectText: "Connect your micro:bit!",
    runtimeConnectBtn: "🔗 Connect",
    quickActions: { duplicate:"Duplicate", color:"Random Color", lock:"Lock/Unlock", front:"Bring Front", back:"Send Back", delete:"Delete" },
    quickActionsTitles: { duplicate:"Duplicate", color:"Change color", lock:"Lock/Unlock", front:"Bring to front", back:"Send to back", delete:"Delete" },
    tutorial: {
      steps: [
        { title:"Welcome!", text:"Let's build your first micro:bit remote control! It's easy and fun!" },
        { title:"Pick a Widget", text:"Tap any widget below (like Button or Slider) to select it." },
        { title:"Place It", text:"Then tap on the canvas to place your widget. You can drag it around!" },
        { title:"Connect & Play!", text:"When ready, go to Play mode and connect your micro:bit. Have fun!" }
      ],
      next: "Next →", start: "Start Building! 🚀", skip: "Skip Tutorial"
    },
    loadingTitle: "🧩 Loading your remote...",
    loadingSub: "Getting layout from micro:bit",
    loadingRequesting: "Checking layout version…",
    loadingReceiving: "Receiving layout…", loadingOf: "of", loadingSec: "s",
    loadingDecoding: "Decoding layout…",
    loadingReady: "Ready!",
    codeModal: {
      copy:"📋 Copy", save:"💾 Save", flash:"⚡ Flash to micro:bit", close:"✖️ Close",
      titleDefault:"📄 Your micro:bit Code",
      titleSub:"Copy to MakeCode or click ⚡Flash to send directly to micro:bit via Bluetooth",
      titleDemo:"Demo Ready! Copy this code to MakeCode:"
    },
    toastExport: "📦 Exported JSON!",
    toastImport: "📂 Imported!",
    toastImportFail: "❌ Import failed",
    toast: {
      addWidgetsFirst: "👆 Add some widgets first!",
      demoLoaded: "Demo loaded with all widget examples!",
      widgetSelected: "✅ {icon} selected! Tap canvas to place",
      widgetAdded: "✨ {icon} added!",
      deletedWidgets: "🗑️ Deleted widgets",
      selectedAll: "Selected all {n} widgets",
      restoredProject: "📂 Restored your last project!",
      copied: "📋 Copied!",
      widgetsArranged: "✨ Widgets arranged!",
      nothingToArrange: "No widgets to arrange!",
      themeChanged: "🎨 Theme: {theme}",
      templateLoaded: "✅ Template loaded!",
      canvasReady: "✨ Canvas ready! Pick a widget below",
      nothingToUndo: "Nothing to undo",
      undoDone: "↩️ Undo",
      nothingToRedo: "Nothing to redo",
      redoDone: "↪️ Redo",
      downloaded: "💾 Downloaded!",
      layoutJsonExported: "📦 Layout JSON exported!",
      makeCodeCfgExported: "🧠 MakeCode CFG exported!",
      idMustBeUnique: "❌ ID must be unique",
      idUpdated: "✅ ID updated",
      modelUpdated: "✅ Model updated",
      modelAppliedAll: "✨ Applied model to all {type}s",
      imageUploaded: "🖼️ Image uploaded",
      selectWidgetFirst: "👆 Select a widget first!",
      deleted: "🗑️ Deleted!",
      orientationSwapped: "🔄 Orientation swapped!",
      sizeReset: "↩️ Size reset to default!",
      sizeSet: "📐 Size set to {w}×{h}",
      flashInProgress: "Flash already in progress",
      webBtNotSupported: "Web Bluetooth not supported. Use Chrome or Edge on desktop/Android.",
      iosNoBluetooth: 'iOS Safari can\'t do Bluetooth — get the free "Bluefy" app from the App Store and open this page there instead.',
      couldNotCompile: "Could not compile. Opening MakeCode to compile manually...",
      flashComplete: "✅ Flash complete!",
      flashFailed: "Flash failed: {err}",
      webUsbNotSupported: "WebUSB not supported. Use Chrome or Edge.",
      hexDownloaded: "Hex downloaded! Drag it to your micro:bit drive.",
      usbFlashError: "USB flash error: {err}",
      connected: "Connected!",
      connectionFailed: "Connection failed",
      disconnected: "Disconnected",
      remoteLoaded: "Remote loaded!",
      configReloading: "Reloading fresh config from micro:bit…",
      configCacheCleared: "Device config cache cleared. Connect to fetch it again.",
      configError: "Config error",
      editInBuildOffer: "📥 Edit this layout in Build?",
      editInBuildBtn: "Edit in Build",
      editInBuildConfirm: "This will replace your current Build layout with the one from this device. Continue?",
      editInBuildDone: "Layout loaded into Build!",
      arrangeModeOn: "📐 Arrange mode ON - drag widgets to move",
      layoutSaved: "✅ Layout saved!",
      duplicated: "📋 Duplicated!",
      newColor: "🎨 New color!",
      broughtFront: "⬆️ Brought to front",
      sentBack: "⬇️ Sent to back",
      locked: "🔒 Locked",
      unlocked: "🔓 Unlocked"
    }
  },
  fr: {
    build: "✏️ Construire", play: "▶️ Jouer",
    subtitle: "Crée ta propre télécommande",
    soundOn: "Son activé", soundOff: "Son coupé",
    chooseTpl: "🎨 Choisis un modèle !",
    pickTpl: "Prends-en un pour commencer",
    templates: { gamepad:"Manette", robot:"Robot", mixer:"DJ Mixer", racing:"Course", lights:"Lumières", blank:"Nouveau" },
    buttons: { demo:"🎮 Démo widgets !", export:"📦 JSON disposition", exportMakeCode:"🧠 CFG MakeCode", import:"📂 Import", templates:"🎨 Modèles", code:"📄 Code" },
    hint: "👆 Choisis un widget, puis tape sur le tableau pour le placer !",
    titlePlaceholder: "🏷️ Nomme ta télécommande...",
    toolbar: {
      history: "Historique", layout: "Disposition", theme: "Thème",
      undo: "Annuler", undoTitle: "Annuler (Ctrl+Z)",
      redo: "Rétablir", redoTitle: "Rétablir (Ctrl+Y)",
      tidy: "Ranger", tidyTitle: "Ranger automatiquement les widgets",
      trim: "Rogner le canevas", trimTitle: "Ajuster le canevas aux widgets sans modifier leur disposition relative"
    },
    themeNames: { dark:"Sombre", ocean:"Océan", space:"Espace", candy:"Feu", forest:"Forêt" },
    themeTitles: { dark:"Thème sombre", ocean:"Thème océan", space:"Thème espace", candy:"Thème feu", forest:"Thème forêt" },
    widgets: { button:"Bouton", slider:"Curseur", toggle:"Interrupteur", joystick:"Joystick", dpad:"Croix directionnelle", dpad_leftright:"Pavé rotation", xypad:"Pavé XY", led:"Lumière", label:"Texte", group:"Groupe", separator:"Ligne", gauge:"Jauge", graph:"Graphique", battery:"Batterie", timer:"Minuteur" },
    propsTitle: "🛠️ Propriétés",
    propsCollapseTitle: "Réduire",
    propsEmptyTitle: "Rien de sélectionné",
    propsEmptyHint: "Touche un widget sur le tableau pour changer sa couleur, son texte et sa taille.",
    backToBuild: "← Retour à la Construction",
    arrange: "📐 Organiser", arrangeDone: "✓ Terminé",
    share: "⧉ Partager",
    shareTitleBtn: "Afficher un QR code pour ouvrir l'app sur un autre appareil",
    shareHeading: "Partager cette app",
    shareHint: "Scanne pour ouvrir la télécommande sur un autre téléphone ou une tablette.",
    shareClose: "Touche l'écran pour fermer",
    reloadConfig: "↻ Recharger config",
    reloadConfigTitle: "Effacer la configuration en cache de cet appareil et la relire depuis le micro:bit",
    fullscreen: "⛶ Plein écran",
    fullscreenExit: "⛶ Quitter le plein écran",
    arrangeHint: '👆 Glisse les widgets pour les réorganiser • Appuie sur « Terminé » à la fin',
    connect: "Connecter!", connected: "Connecté! 🎉",
    runtimeConnectText: "Connecte ton micro:bit !",
    runtimeConnectBtn: "🔗 Connecter",
    quickActions: { duplicate:"Dupliquer", color:"Couleur aléatoire", lock:"Verrouiller/Déverrouiller", front:"Mettre devant", back:"Mettre derrière", delete:"Supprimer" },
    quickActionsTitles: { duplicate:"Dupliquer", color:"Changer la couleur", lock:"Verrouiller/Déverrouiller", front:"Mettre devant", back:"Mettre derrière", delete:"Supprimer" },
    tutorial: {
      steps: [
        { title:"Bienvenue !", text:"Construisons ta première télécommande micro:bit ! C'est facile et amusant !" },
        { title:"Choisis un widget", text:"Touche un widget ci-dessous (comme Bouton ou Curseur) pour le sélectionner." },
        { title:"Place-le", text:"Puis touche le tableau pour placer ton widget. Tu peux le déplacer !" },
        { title:"Connecte et joue !", text:"Quand tu es prêt, va en mode Jouer et connecte ton micro:bit. Amuse-toi bien !" }
      ],
      next: "Suivant →", start: "Commence à construire ! 🚀", skip: "Passer le tutoriel"
    },
    loadingTitle: "🧩 Chargement de ta télécommande...",
    loadingSub: "Récupération depuis le micro:bit",
    loadingRequesting: "Vérification de la version de la disposition…",
    loadingReceiving: "Réception de la disposition…", loadingOf: "sur", loadingSec: "s",
    loadingDecoding: "Décodage de la disposition…",
    loadingReady: "Prêt !",
    codeModal: {
      copy:"📋 Copier", save:"💾 Enregistrer", flash:"⚡ Flasher le micro:bit", close:"✖️ Fermer",
      titleDefault:"📄 Ton code micro:bit",
      titleSub:"Copie dans MakeCode ou clique sur ⚡Flasher pour envoyer directement au micro:bit via Bluetooth",
      titleDemo:"Démo prête ! Copie ce code dans MakeCode :"
    },
    toastExport: "📦 JSON exporté !",
    toastImport: "📂 Importé !",
    toastImportFail: "❌ Import impossible",
    toast: {
      addWidgetsFirst: "👆 Ajoute d'abord des widgets !",
      demoLoaded: "Démo chargée avec les 12 widgets !",
      widgetSelected: "✅ {icon} sélectionné ! Touche le tableau pour le placer",
      widgetAdded: "✨ {icon} ajouté !",
      deletedWidgets: "🗑️ Widgets supprimés",
      selectedAll: "{n} widgets sélectionnés",
      restoredProject: "📂 Ton dernier projet a été restauré !",
      copied: "📋 Copié !",
      widgetsArranged: "✨ Widgets organisés !",
      nothingToArrange: "Aucun widget à organiser !",
      themeChanged: "🎨 Thème : {theme}",
      templateLoaded: "✅ Modèle chargé !",
      canvasReady: "✨ Tableau prêt ! Choisis un widget ci-dessous",
      nothingToUndo: "Rien à annuler",
      undoDone: "↩️ Annulé",
      nothingToRedo: "Rien à rétablir",
      redoDone: "↪️ Rétabli",
      downloaded: "💾 Téléchargé !",
      layoutJsonExported: "📦 JSON de disposition exporté !",
      makeCodeCfgExported: "🧠 CFG MakeCode exporté !",
      idMustBeUnique: "❌ L'ID doit être unique",
      idUpdated: "✅ ID mis à jour",
      modelUpdated: "✅ Modèle mis à jour",
      modelAppliedAll: "✨ Modèle appliqué à tous les {type}",
      imageUploaded: "🖼️ Image téléchargée",
      selectWidgetFirst: "👆 Sélectionne d'abord un widget !",
      deleted: "🗑️ Supprimé !",
      orientationSwapped: "🔄 Orientation inversée !",
      sizeReset: "↩️ Taille réinitialisée !",
      sizeSet: "📐 Taille réglée sur {w}×{h}",
      flashInProgress: "Flash déjà en cours",
      webBtNotSupported: "Web Bluetooth non supporté. Utilise Chrome ou Edge sur ordinateur/Android.",
      iosNoBluetooth: 'iOS Safari ne gère pas le Bluetooth — installe l\'appli gratuite "Bluefy" depuis l\'App Store et ouvre cette page avec.',
      couldNotCompile: "Compilation impossible. Ouverture de MakeCode pour compiler manuellement...",
      flashComplete: "✅ Flash terminé !",
      flashFailed: "Échec du flash : {err}",
      webUsbNotSupported: "WebUSB non supporté. Utilise Chrome ou Edge.",
      hexDownloaded: "Fichier téléchargé ! Glisse-le sur le lecteur micro:bit.",
      usbFlashError: "Erreur USB : {err}",
      connected: "Connecté !",
      connectionFailed: "Échec de connexion",
      disconnected: "Déconnecté",
      remoteLoaded: "Télécommande chargée !",
      configReloading: "Rechargement de la configuration depuis le micro:bit…",
      configCacheCleared: "Cache de configuration effacé. Connecte-toi pour la recharger.",
      configError: "Erreur de configuration",
      editInBuildOffer: "📥 Modifier cette disposition dans Construire ?",
      editInBuildBtn: "Modifier",
      editInBuildConfirm: "Cela va remplacer ta disposition actuelle dans Construire par celle de cet appareil. Continuer ?",
      editInBuildDone: "Disposition chargée dans Construire !",
      arrangeModeOn: "📐 Mode organisation activé - glisse les widgets",
      layoutSaved: "✅ Disposition enregistrée !",
      duplicated: "📋 Dupliqué !",
      newColor: "🎨 Nouvelle couleur !",
      broughtFront: "⬆️ Mis devant",
      sentBack: "⬇️ Mis derrière",
      locked: "🔒 Verrouillé",
      unlocked: "🔓 Déverrouillé"
    }
  },
  ar: {
    build: "✏️ بناء", play: "▶️ تشغيل",
    subtitle: "اصنع جهاز التحكم الخاص بك",
    soundOn: "الصوت مفعّل", soundOff: "الصوت متوقف",
    chooseTpl: "🎨 اختر قالبًا!",
    pickTpl: "اختر واحدًا للبدء",
    templates: { gamepad:"ذراع تحكم", robot:"روبوت", mixer:"موسيقى", racing:"سباق", lights:"أضواء", blank:"ابدأ" },
    buttons: { demo:"🎮 عرض كل الأدوات!", export:"📦 JSON التخطيط", exportMakeCode:"🧠 إعداد MakeCode", import:"📂 استيراد", templates:"🎨 قوالب", code:"📄 الكود" },
    hint: "👆 اختر أداة، ثم اضغط على اللوحة لوضعها!",
    titlePlaceholder: "🏷️ اسمِّ جهاز التحكم...",
    toolbar: {
      history: "السجل", layout: "التخطيط", theme: "السمة",
      undo: "تراجع", undoTitle: "تراجع (Ctrl+Z)",
      redo: "إعادة", redoTitle: "إعادة (Ctrl+Y)",
      tidy: "ترتيب", tidyTitle: "ترتيب الأدوات تلقائيًا",
      trim: "قص اللوحة", trimTitle: "قص مساحة اللوحة حول الأدوات مع الحفاظ على مواضعها النسبية"
    },
    themeNames: { dark:"داكن", ocean:"المحيط", space:"الفضاء", candy:"النار", forest:"الغابة" },
    themeTitles: { dark:"السمة الداكنة", ocean:"سمة المحيط", space:"سمة الفضاء", candy:"سمة النار", forest:"سمة الغابة" },
    widgets: { button:"زر", slider:"منزلق", toggle:"مفتاح", joystick:"عصا التحكم", dpad:"لوحة اتجاه", dpad_leftright:"لوحة الدوران", xypad:"لوحة XY", led:"ضوء", label:"تسمية", group:"مجموعة", separator:"خط فاصل", gauge:"مقياس", graph:"رسم بياني", battery:"بطارية", timer:"مؤقت" },
    propsTitle: "🛠️ خصائص الأداة",
    propsCollapseTitle: "طي",
    propsEmptyTitle: "لم يتم اختيار شيء",
    propsEmptyHint: "اضغط على أي أداة في اللوحة لتغيير لونها ونصها وحجمها.",
    backToBuild: "→ العودة للبناء",
    arrange: "📐 ترتيب", arrangeDone: "✓ تم",
    share: "⧉ مشاركة",
    shareTitleBtn: "إظهار رمز QR لفتح التطبيق على جهاز آخر",
    shareHeading: "شارك هذا التطبيق",
    shareHint: "امسح الرمز لفتح جهاز التحكم على هاتف أو جهاز لوحي آخر.",
    shareClose: "المس أي مكان للإغلاق",
    reloadConfig: "↻ إعادة تحميل الإعداد",
    reloadConfigTitle: "مسح إعداد هذا الجهاز من الذاكرة المؤقتة وقراءته من micro:bit من جديد",
    fullscreen: "⛶ ملء الشاشة",
    fullscreenExit: "⛶ الخروج من ملء الشاشة",
    arrangeHint: '👆 اسحب الأدوات لإعادة ترتيبها • اضغط "تم" عند الانتهاء',
    connect: "اضغط للاتصال!", connected: "متصل! 🎉",
    runtimeConnectText: "اتصل بالـ micro:bit!",
    runtimeConnectBtn: "🔗 اتصال",
    quickActions: { duplicate:"تكرار", color:"لون عشوائي", lock:"قفل/إلغاء القفل", front:"إحضار للأمام", back:"إرسال للخلف", delete:"حذف" },
    quickActionsTitles: { duplicate:"تكرار", color:"تغيير اللون", lock:"قفل/إلغاء القفل", front:"إحضار للأمام", back:"إرسال للخلف", delete:"حذف" },
    tutorial: {
      steps: [
        { title:"أهلاً بك!", text:"لنصنع أول جهاز تحكم micro:bit خاص بك! الأمر سهل وممتع!" },
        { title:"اختر أداة", text:"اضغط على أي أداة أدناه (مثل الزر أو المنزلق) لاختيارها." },
        { title:"ضعها", text:"ثم اضغط على اللوحة لوضع أداتك. يمكنك سحبها لتحريكها!" },
        { title:"اتصل والعب!", text:"عندما تكون جاهزًا، اذهب لوضع التشغيل واتصل بالـ micro:bit. استمتع!" }
      ],
      next: "→ التالي", start: "🚀 ابدأ البناء!", skip: "تخطي البرنامج التعليمي"
    },
    loadingTitle: "🧩 جارٍ تحميل جهاز التحكم...",
    loadingSub: "الحصول على التخطيط من micro:bit",
    loadingRequesting: "جارٍ التحقق من إصدار التخطيط…",
    loadingReceiving: "جارٍ استقبال التخطيط…", loadingOf: "من", loadingSec: "ث",
    loadingDecoding: "جارٍ فك ترميز التخطيط…",
    loadingReady: "جاهز!",
    codeModal: {
      copy:"📋 نسخ", save:"💾 حفظ", flash:"⚡ تحميل إلى micro:bit", close:"✖️ إغلاق",
      titleDefault:"📄 كود الـ micro:bit الخاص بك",
      titleSub:"انسخ إلى MakeCode أو اضغط ⚡تحميل لإرساله مباشرة إلى micro:bit عبر البلوتوث",
      titleDemo:"العرض التجريبي جاهز! انسخ هذا الكود إلى MakeCode:"
    },
    toastExport: "📦 تم التصدير!",
    toastImport: "📂 تم الاستيراد!",
    toastImportFail: "❌ فشل الاستيراد",
    toast: {
      addWidgetsFirst: "👆 أضف بعض الأدوات أولاً!",
      demoLoaded: "تم تحميل عرض بجميع الأدوات الـ12!",
      widgetSelected: "✅ تم اختيار {icon}! اضغط على اللوحة لوضعها",
      widgetAdded: "✨ تمت إضافة {icon}!",
      deletedWidgets: "🗑️ تم حذف الأدوات",
      selectedAll: "تم اختيار جميع الأدوات ({n})",
      restoredProject: "📂 تم استعادة مشروعك الأخير!",
      copied: "📋 تم النسخ!",
      widgetsArranged: "✨ تم ترتيب الأدوات!",
      nothingToArrange: "لا توجد أدوات للترتيب!",
      themeChanged: "🎨 السمة: {theme}",
      templateLoaded: "✅ تم تحميل القالب!",
      canvasReady: "✨ اللوحة جاهزة! اختر أداة أدناه",
      nothingToUndo: "لا يوجد ما يمكن التراجع عنه",
      undoDone: "↩️ تم التراجع",
      nothingToRedo: "لا يوجد ما يمكن إعادته",
      redoDone: "↪️ تمت الإعادة",
      downloaded: "💾 تم التنزيل!",
      layoutJsonExported: "📦 تم تصدير JSON التخطيط!",
      makeCodeCfgExported: "🧠 تم تصدير إعداد MakeCode!",
      idMustBeUnique: "❌ المعرف يجب أن يكون فريدًا",
      idUpdated: "✅ تم تحديث المعرف",
      modelUpdated: "✅ تم تحديث النموذج",
      modelAppliedAll: "✨ تم تطبيق النموذج على جميع {type}",
      imageUploaded: "🖼️ تم رفع الصورة",
      selectWidgetFirst: "👆 اختر أداة أولاً!",
      deleted: "🗑️ تم الحذف!",
      orientationSwapped: "🔄 تم تبديل الاتجاه!",
      sizeReset: "↩️ تمت إعادة الحجم الافتراضي!",
      sizeSet: "📐 تم ضبط الحجم على {w}×{h}",
      flashInProgress: "التحميل قيد التنفيذ بالفعل",
      webBtNotSupported: "المتصفح لا يدعم البلوتوث. استخدم Chrome أو Edge على الكمبيوتر أو أندرويد.",
      iosNoBluetooth: 'متصفح Safari على iOS لا يدعم البلوتوث — حمّل تطبيق "Bluefy" المجاني من App Store وافتح هذه الصفحة منه.',
      couldNotCompile: "تعذّرت البرمجة. جارٍ فتح MakeCode للبرمجة يدويًا...",
      flashComplete: "✅ اكتمل التحميل!",
      flashFailed: "فشل التحميل: {err}",
      webUsbNotSupported: "المتصفح لا يدعم WebUSB. استخدم Chrome أو Edge.",
      hexDownloaded: "تم تنزيل الملف! اسحبه إلى قرص micro:bit.",
      usbFlashError: "خطأ في USB: {err}",
      connected: "تم الاتصال!",
      connectionFailed: "فشل الاتصال",
      disconnected: "تم قطع الاتصال",
      remoteLoaded: "تم تحميل جهاز التحكم!",
      configReloading: "جارٍ إعادة تحميل الإعداد من micro:bit…",
      configCacheCleared: "تم مسح إعداد الجهاز من الذاكرة المؤقتة. اتصل لتحميله من جديد.",
      configError: "خطأ في الإعدادات",
      editInBuildOffer: "📥 تعديل هذا التخطيط في وضع البناء؟",
      editInBuildBtn: "تعديل",
      editInBuildConfirm: "سيؤدي هذا إلى استبدال تخطيطك الحالي في وضع البناء بالتخطيط من هذا الجهاز. هل تريد المتابعة؟",
      editInBuildDone: "تم تحميل التخطيط في وضع البناء!",
      arrangeModeOn: "📐 تفعيل وضع الترتيب - اسحب الأدوات لتحريكها",
      layoutSaved: "✅ تم حفظ التخطيط!",
      duplicated: "📋 تم التكرار!",
      newColor: "🎨 لون جديد!",
      broughtFront: "⬆️ تم الإحضار للأمام",
      sentBack: "⬇️ تم الإرسال للخلف",
      locked: "🔒 مقفل",
      unlocked: "🔓 غير مقفل"
    }
  }
};

// tr(key.path, {vars}) — dotted-path lookup with {placeholder} interpolation
function tr(path, vars) {
  const t = I18N[state.lang] || I18N.en;
  const fallback = I18N.en;
  let node = t, fb = fallback;
  for (const part of path.split('.')) {
    node = node && node[part];
    fb = fb && fb[part];
  }
  let str = (node !== undefined ? node : fb);
  if (typeof str !== 'string') return str;
  if (vars) {
    for (const k in vars) str = str.split('{' + k + '}').join(vars[k]);
  }
  return str;
}

const LANGS = ["en","fr","ar"];

function saveLang() { try { localStorage.setItem("kid_lang", state.lang); } catch(e){} }
function loadLang() { try { return localStorage.getItem("kid_lang"); } catch(e){ return null; } }

function setLang(lang){
  state.lang = LANGS.includes(lang) ? lang : "fr";
  saveLang();
  const t = I18N[state.lang] || I18N.en;

  document.documentElement.lang = state.lang;
  const rtl = (state.lang === "ar");
  document.documentElement.dir = rtl ? "rtl" : "ltr";
  document.body.classList.toggle("rtl", rtl);

  // Tabs
  const tabs = $$(".tab");
  if (tabs[0]) tabs[0].textContent = t.build;
  if (tabs[1]) tabs[1].textContent = t.play;

  // Top buttons
  $$(".lang-flag-btn[data-lang]").forEach(b => b.classList.toggle("active", b.dataset.lang === state.lang));

  const bleBtn = $("#bleBtn");
  if (bleBtn){
    const s = bleBtn.querySelector("span:last-child");
    if (s) s.textContent = (state.ble && state.ble.connected) ? t.connected : t.connect;
  }

  // Builder header buttons
  const demoBtn = $("#demoBtn"); if (demoBtn) demoBtn.textContent = t.buttons.demo;
  const exportBtn = $("#exportJsonBtn"); if (exportBtn) exportBtn.textContent = t.buttons.export;
  const exportMakeCodeBtn = $("#exportMakeCodeCfgBtn"); if (exportMakeCodeBtn) exportMakeCodeBtn.textContent = t.buttons.exportMakeCode || "🧠 MakeCode CFG";
  const importBtn = $("#importJsonBtn"); if (importBtn) importBtn.textContent = t.buttons.import;
  const codeBtn = $("#codeBtn"); if (codeBtn) codeBtn.textContent = t.buttons.code;

  // Hint
  const hint = document.querySelector(".canvas-hint");
  if (hint) hint.textContent = t.hint;

  // Props panel
  const pt = document.querySelector(".props-title-text"); if (pt) pt.textContent = t.propsTitle;

  // Template modal
  const tm = $("#templateModal");
  if (tm){
    const h2 = tm.querySelector("h2"); if (h2) h2.textContent = t.chooseTpl;
    const p = tm.querySelector("p"); if (p) p.textContent = t.pickTpl;
    tm.querySelectorAll(".template-card").forEach(card=>{
      const key = card.dataset.tpl;
      const nameEl = card.querySelector(".template-name");
      if (nameEl && t.templates[key]) nameEl.textContent = t.templates[key];
    });
  }

  // Runtime connect screen
  const ct = document.querySelector(".connect-text"); if (ct) ct.textContent = t.runtimeConnectText;
  const cb = $("#connectBtn"); if (cb) cb.textContent = t.runtimeConnectBtn;
  const shb = $("#shareBtn");
  if (shb) {
    shb.textContent = t.share || "⧉ Share";
    shb.title = t.shareTitleBtn || "Show a QR code so someone else can open this app";
  }
  const setTxt = (sel, val) => { const el = $(sel); if (el && val) el.textContent = val; };
  setTxt("#shareTitle", t.shareHeading);
  setTxt("#shareHint", t.shareHint);
  setTxt("#shareClose", t.shareClose);

  const rcb = $("#reloadConfigBtn");
  if (rcb) {
    rcb.textContent = t.reloadConfig || "↻ Reload Config";
    rcb.title = t.reloadConfigTitle || "Clear cached device config and reload it from the micro:bit";
  }

  // Subtitle (not the whole .hero-subtitle — that would wipe out the
  // version badge span sitting next to it)
  const sub = document.getElementById("heroSubtitleText"); if (sub) sub.textContent = t.subtitle;

  // Sound button
  if (typeof updateSoundUI === "function") updateSoundUI();

  // Title input placeholder
  const titleInput = $("#titleInput"); if (titleInput) titleInput.placeholder = t.titlePlaceholder;

  // Actions card
  const templateBtn = $("#templateBtn"); if (templateBtn) templateBtn.textContent = t.buttons.templates;

  // Widget palette names
  document.querySelectorAll(".palette-item[data-type]").forEach(item => {
    const nameEl = item.querySelector(".palette-name");
    // A preset entry (data-model) shares its type with the plain one, so the
    // type name would overwrite its label and leave two identical "D-Pad"
    // tiles. Those carry their own key instead.
    const key = item.dataset.model ? `${item.dataset.type}_${item.dataset.model}` : item.dataset.type;
    if (nameEl && t.widgets[key]) nameEl.textContent = t.widgets[key];
  });

  // Build toolbar
  const historyGroup = document.querySelector('.build-toolbar-group[aria-label="History"]');
  if (historyGroup) historyGroup.setAttribute("aria-label", t.toolbar.history);
  const layoutGroup = document.querySelector('.build-toolbar-group[aria-label="Layout"]');
  if (layoutGroup) layoutGroup.setAttribute("aria-label", t.toolbar.layout);
  const themeLabel = document.querySelector(".build-toolbar-group-label"); if (themeLabel) themeLabel.textContent = t.toolbar.theme;
  const undoBtn = $("#undoBtn");
  if (undoBtn) { undoBtn.title = t.toolbar.undoTitle; const l = undoBtn.querySelector(".btn-label"); if (l) l.textContent = t.toolbar.undo; }
  const redoBtn = $("#redoBtn");
  if (redoBtn) { redoBtn.title = t.toolbar.redoTitle; const l = redoBtn.querySelector(".btn-label"); if (l) l.textContent = t.toolbar.redo; }
  const tidyBtn = $("#autoArrangeBtn");
  if (tidyBtn) { tidyBtn.title = t.toolbar.tidyTitle; const l = tidyBtn.querySelector(".btn-label"); if (l) l.textContent = t.toolbar.tidy; }
  const trimBtn = $("#trimCanvasBtn");
  if (trimBtn) { trimBtn.title = t.toolbar.trimTitle || "Trim canvas to content"; const l = trimBtn.querySelector(".btn-label"); if (l) l.textContent = t.toolbar.trim || "Trim Canvas"; }
  document.querySelectorAll(".theme-dot[data-theme]").forEach(dot => {
    const key = dot.dataset.theme;
    if (t.themeTitles[key]) dot.title = t.themeTitles[key];
  });

  // Props panel empty state + collapse title
  const propsCollapseBtn = $("#propsCollapseBtn"); if (propsCollapseBtn) propsCollapseBtn.title = t.propsCollapseTitle;
  const propsEmptyTitle = document.querySelector(".props-empty-title"); if (propsEmptyTitle) propsEmptyTitle.textContent = t.propsEmptyTitle;
  const propsEmptyHint = document.querySelector(".props-empty-hint"); if (propsEmptyHint) propsEmptyHint.textContent = t.propsEmptyHint;

  // Runtime view
  const backBtn = $("#backToBuildBtn"); if (backBtn) backBtn.textContent = t.backToBuild;
  const arrangeBtn = $("#arrangeModeBtn"); if (arrangeBtn) arrangeBtn.textContent = state.arrangeMode ? t.arrangeDone : t.arrange;
  const fsBtn = $("#fullscreenBtn"); if (fsBtn) fsBtn.textContent = document.body.classList.contains("runtime-fullscreen") ? (t.fullscreenExit || "⛶ Exit Fullscreen") : t.fullscreen;
  const arrangeHint = $("#arrangeHint"); if (arrangeHint) arrangeHint.textContent = t.arrangeHint;
  const rtJsonBtn = $("#runtimeExportJsonBtn"); if (rtJsonBtn) rtJsonBtn.title = t.buttons.export;
  const rtCfgBtn = $("#runtimeExportMakeCodeBtn"); if (rtCfgBtn) rtCfgBtn.title = t.buttons.exportMakeCode || "MakeCode CFG";

  // Quick actions menu (runtime/arrange context menu)
  const quickMenu = $("#quickActionsMenu");
  if (quickMenu) {
    quickMenu.querySelectorAll(".quick-action-btn[data-action]").forEach(btn => {
      const key = btn.dataset.action;
      if (t.quickActions[key]) {
        const icon = btn.textContent.trim().split(" ")[0];
        btn.textContent = icon + " " + t.quickActions[key];
      }
    });
  }

  // Tutorial (re-render current step if visible)
  if (typeof updateTutorialStep === "function") updateTutorialStep();
  const tutorialSkip = $("#tutorialSkipBtn"); if (tutorialSkip) tutorialSkip.textContent = t.tutorial.skip;

  // Loading overlay
  const loadingTitle = document.querySelector(".loading-title"); if (loadingTitle) loadingTitle.textContent = t.loadingTitle;
  const loadingSub = $("#loadingSub"); if (loadingSub) loadingSub.textContent = t.loadingSub;

  // Code modal buttons
  const copyBtn = $("#copyBtn"); if (copyBtn) copyBtn.textContent = t.codeModal.copy;
  const downloadBtn = $("#downloadBtn"); if (downloadBtn) downloadBtn.textContent = t.codeModal.save;
  const flashBtn = $("#flashBtn"); if (flashBtn) flashBtn.textContent = t.codeModal.flash;
  const modalClose = $("#modalClose"); if (modalClose) modalClose.textContent = t.codeModal.close;
}

// ---- Export / Import JSON layout ----
// v2.1: a layout export is now a complete, self-describing design artifact.
// It contains the exact widget geometry, reference canvas size and a deterministic
// revision. The same arranged design can therefore be imported back into Build or
// embedded into MakeCode without manually copying x/y/w/h values.
function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

// v2.5: same lightweight revision algorithm as firmware v52.
// It fingerprints the exact Base64 CFG string, so the revision is derived
// from what is really flashed rather than from a hand-maintained constant.
function cfgRevisionFromBase64(text) {
  let hash = 5381 >>> 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    hash = ((((hash << 5) + hash) ^ s.charCodeAt(i)) >>> 0);
  }
  return 'd' + String(hash >>> 0);
}

function getBuildCanvasSizeForExport() {
  // v2.3: export the logical design size, never the zoomed viewport rectangle.
  const s = getBuildLogicalSize();
  return { w: Math.max(300, Math.round(s.w)), h: Math.max(200, Math.round(s.h)) };
}

function makeExportConfig(source = 'build') {
  let title = 'My Remote';
  let widgets = [];
  let canvas = null;

  if (source === 'runtime') {
    if (!state.config || !Array.isArray(state.config.widgets) || state.config.widgets.length === 0) return null;
    title = state.config.title || ($('#titleInput')?.value || 'My Remote');
    widgets = cloneSerializable(state.config.widgets);
    const grid = $('#runtimeGrid');
    canvas = state.runtimeCanvasSize ? cloneSerializable(state.runtimeCanvasSize) : null;
    if (!canvas && grid) {
      canvas = {
        w: Math.max(300, parseInt(grid.style.width, 10) || Math.round(grid.getBoundingClientRect().width)),
        h: Math.max(200, parseInt(grid.style.height, 10) || Math.round(grid.getBoundingClientRect().height))
      };
    }
    if (!canvas && state.config.canvas) canvas = cloneSerializable(state.config.canvas);
  } else {
    if (!state.widgets || state.widgets.length === 0) return null;
    title = $('#titleInput')?.value || 'My Remote';
    widgets = cloneSerializable(state.widgets);
    canvas = getBuildCanvasSizeForExport();
  }

  const core = {
    title,
    widgets,
    canvas: canvas || { w: 400, h: 320 }
  };
  // Hash exactly what firmware will embed; do not include the hash inside itself.
  const configRevision = cfgRevisionFromBase64(unicodeBase64(JSON.stringify(core)));
  return {
    schemaVersion: 2,
    ...core,
    configRevision
  };
}

function safeProjectName(title) {
  return String(title || 'my-remote').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-remote';
}

function downloadTextFile(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportLayoutJson(source = 'build') {
  const cfg = makeExportConfig(source);
  if (!cfg) {
    if (typeof toast === 'function') toast(tr('toast.addWidgetsFirst'), 'error');
    return;
  }
  const safe = safeProjectName(cfg.title);
  downloadTextFile(`${safe}-layout-${cfg.configRevision}.json`, JSON.stringify(cfg, null, 2), 'application/json');
  if (typeof toast === 'function') toast(tr('toast.layoutJsonExported'), 'success');
}

function unicodeBase64(text) {
  const bytes = encoder.encode(String(text));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function makeMakeCodeCfgSnippet(cfg) {
  // Firmware reads only title/widgets/canvas. schemaVersion/configRevision are
  // export metadata, so keep the BLE payload lean and put the revision in its
  // dedicated constant (same protocol used by v47+ firmware).
  const payload = { title: cfg.title, widgets: cfg.widgets, canvas: cfg.canvas };
  const json = JSON.stringify(payload);
  const b64 = unicodeBase64(json);
  const readable = JSON.stringify(payload, null, 2).split('\n').map(line => '// ' + line).join('\n');
  return `/**
 * Layout exported by Micro:bit Remote Builder ${APP_VERSION}
 * Expected runtime revision: ${cfg.configRevision}
 * Canvas: ${cfg.canvas.w} x ${cfg.canvas.h}
 *
 * HOW TO USE WITH FIRMWARE v52+:
 * Replace only the existing CFG constant with the one below.
 * Firmware computes CFG_REV directly from CFG at boot, so changing CFG can
 * never leave an old revision behind and accidentally reopen stale cache.
 */

// Human-readable reference:
${readable}

const CFG = "${b64}"
`;
}

function exportMakeCodeCfg(source = 'build') {
  const cfg = makeExportConfig(source);
  if (!cfg) {
    if (typeof toast === 'function') toast(tr('toast.addWidgetsFirst'), 'error');
    return;
  }
  const safe = safeProjectName(cfg.title);
  const ts = makeMakeCodeCfgSnippet(cfg);
  downloadTextFile(`${safe}-makecode-layout-${cfg.configRevision}.ts`, ts, 'text/plain');
  if (typeof toast === 'function') toast(tr('toast.makeCodeCfgExported'), 'success');
}

// Shared by importLayoutJsonFile() and loadCfgIntoBuild() (the "edit this
// device's layout" offer) — both feed a {title, widgets} object into the
// Build tab's state the same way.
function applyCfgToBuildState(cfg){
  // v2.4: Build is the authoritative editable layout. Importing a design
  // must invalidate any stale Play snapshot so a later mode switch can never
  // resurrect older geometry.
  state.config = null;
  state.runtimeCanvasSize = null;
  state.widgets = cloneSerializable(cfg.widgets).map(w => ({...w}));
  // Recompute nextId safely
  let maxNum = 0;
  state.widgets.forEach(w=>{
    const m = String(w.id||"").match(/(\d+)$/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1],10));
  });
  state.nextId = Math.max(10, maxNum + 1);
  if ($("#titleInput")) $("#titleInput").value = cfg.title || "My Remote";
  if (cfg.canvas && Number.isFinite(Number(cfg.canvas.w)) && Number.isFinite(Number(cfg.canvas.h))) {
    state.buildCanvasSize = { w: Math.round(Number(cfg.canvas.w)), h: Math.round(Number(cfg.canvas.h)) };
  } else {
    // Legacy JSON without canvas metadata derives its size from its own widgets;
    // never inherit the dimensions of the project that happened to be open.
    state.buildCanvasSize = null;
  }
  if (typeof applyWidgetDefaults === "function") state.widgets.forEach(applyWidgetDefaults);
  normalizeGroupMembership(state.widgets);
  state.selected = null;
  if (typeof renderWidgets === "function") renderWidgets();
  try{ makeCanvasResizable(); setupBuildCanvasViewControls(); }catch(e){}
  // Imports should always start with the complete design visible. The user can
  // switch to 1:1 or zoom in afterwards without changing layout coordinates.
  requestAnimationFrame(() => { try { fitBuildCanvas(); } catch(e){} });
  try{ ensureCanvasToolbar(); }catch(e){}
  try{ placeToolbarWhereHintWas(); }catch(e){}
  try{ updateToolbarForMode('builder'); }catch(e){}
  try{ placeToolbarWhereHintWas(); }catch(e){}
  try{ moveBuildPlayNameTopRight(); }catch(e){}
  if (typeof renderPropsPanel === "function") renderPropsPanel();
  // Persist imported geometry immediately; mode switches are not a save point.
  try { scheduleAutoSave(); } catch(e) {}
}

// Small floating banner shown after a device's CFG finishes loading in
// Play mode, offering to load that same layout into the Build tab for
// editing — handy when there's no source JSON file for an already-
// flashed device. Reappears on every connect (not just the first).
function offerLoadCfgIntoBuild(cfg){
  if (!cfg || !Array.isArray(cfg.widgets)) return;
  let el = document.getElementById('cfgBuildOffer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cfgBuildOffer';
    el.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);'
      + 'background:#1b2a3a;color:#fff;padding:10px 14px;border-radius:10px;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;'
      + 'gap:10px;z-index:9999;font-size:14px;max-width:90vw;';
    document.body.appendChild(el);
  }
  el.innerHTML = '';

  const label = document.createElement('span');
  label.textContent = tr('toast.editInBuildOffer');
  el.appendChild(label);

  const btn = document.createElement('button');
  btn.textContent = tr('toast.editInBuildBtn');
  btn.style.cssText = 'background:#00c2ff;color:#04202c;border:none;border-radius:6px;'
    + 'padding:6px 10px;font-weight:600;cursor:pointer;white-space:nowrap;';
  btn.onclick = () => loadCfgIntoBuild(cfg);
  el.appendChild(btn);

  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText = 'background:transparent;color:#9fb3c8;border:none;'
    + 'cursor:pointer;font-size:14px;padding:2px 4px;';
  close.onclick = () => el.remove();
  el.appendChild(close);

  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.remove(), 8000);
}

function loadCfgIntoBuild(cfg){
  if (state.widgets && state.widgets.length > 0) {
    if (!confirm(tr('toast.editInBuildConfirm'))) return;
  }
  applyCfgToBuildState(cfg);
  switchTab('builder');
  const el = document.getElementById('cfgBuildOffer');
  if (el) el.remove();
  if (typeof toast === "function") toast(tr('toast.editInBuildDone'), "success");
}

function importLayoutJsonFile(file){
  const t = I18N[state.lang] || I18N.en;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const cfg = JSON.parse(String(reader.result || "{}"));
      if (!cfg || !Array.isArray(cfg.widgets)) throw new Error("Bad format");
      applyCfgToBuildState(cfg);
      if (typeof toast === "function") toast(t.toastImport, "success");
    } catch(e){
      console.error(e);
      if (typeof toast === "function") toast(t.toastImportFail, "error");
    }
  };
  reader.readAsText(file);
}


const ICONS = { button:'👆', slider:'🎚️', toggle:'🔘', joystick:'🕹️', led:'💡', label:'🏷️', group:'▣', separator:'━', graph:'📈', gauge:'🧭', dpad:'✛', xypad:'📍', battery:'🔋', timer:'⏱️', image:'🖼️', select:'🔽', editfield:'⌨️', sound:'🔊', notification:'🔔' };
const SIZES = { button:[100,100], slider:[90,180], toggle:[100,100], joystick:[140,140], led:[80,80], label:[200,50], group:[320,220], separator:[240,40], graph:[300,150], gauge:[140,160], dpad:[140,140], xypad:[150,150], battery:[80,100], timer:[120,80], image:[100,100], select:[160,70], editfield:[200,70], sound:[90,90], notification:[90,90] };

// Themes
const THEMES = {
  dark: { bg:'#1a1a2e', surface:'#16213e', card:'#1f3460', accent:'#00d4ff', text:'#ffffff' },
  light: { bg:'#f0f4f8', surface:'#ffffff', card:'#e2e8f0', accent:'#3b82f6', text:'#1e293b' },
  neon: { bg:'#0a0a0a', surface:'#1a1a1a', card:'#2a2a2a', accent:'#ff00ff', text:'#00ffff' },
  nature: { bg:'#1a2f1a', surface:'#2d4a2d', card:'#3d5a3d', accent:'#4ade80', text:'#ecfdf5' },
  sunset: { bg:'#2d1b2d', surface:'#4a2c4a', card:'#6b3a6b', accent:'#f97316', text:'#fef3c7' }
};

const templates = {
  gamepad: [
    { t:'joystick', x:20, y:30, w:120, h:120, label:'Move' },
    { t:'button', x:180, y:40, w:90, h:90, label:'Jump' },
    { t:'button', x:290, y:40, w:90, h:90, label:'Fire' },
    { t:'toggle', x:180, y:160, w:90, h:90, label:'Turbo' }
  ],
  robot: [
    { t:'slider', x:20, y:20, w:90, h:180, label:'Arm 1' },
    { t:'slider', x:130, y:20, w:90, h:180, label:'Arm 2' },
    { t:'slider', x:240, y:20, w:90, h:180, label:'Arm 3' },
    { t:'toggle', x:350, y:80, w:90, h:90, label:'Grip' }
  ],
  mixer: [
    { t:'slider', x:20, y:20, w:80, h:200, label:'Bass' },
    { t:'slider', x:120, y:20, w:80, h:200, label:'Mid' },
    { t:'slider', x:220, y:20, w:80, h:200, label:'High' },
    { t:'toggle', x:320, y:80, w:90, h:90, label:'FX' },
    { t:'led', x:320, y:20, w:90, h:50, label:'Beat' }
  ],
  racing: [
    { t:'joystick', x:150, y:20, w:130, h:130, label:'Steer' },
    { t:'slider', x:20, y:170, w:80, h:140, label:'Gas' },
    { t:'slider', x:330, y:170, w:80, h:140, label:'Brake' },
    { t:'button', x:150, y:180, w:130, h:80, label:'Nitro!' }
  ],
  lights: [
    { t:'toggle', x:30, y:30, w:100, h:100, label:'Red' },
    { t:'toggle', x:160, y:30, w:100, h:100, label:'Green' },
    { t:'toggle', x:290, y:30, w:100, h:100, label:'Blue' },
    { t:'led', x:90, y:160, w:100, h:100, label:'Status' },
    { t:'led', x:230, y:160, w:100, h:100, label:'Alert' }
  ],
  blank: []
};

const state = {
  widgets: [], selected: null, nextId: 1, selectedType: null,
  ble: { device:null, server:null, service:null, notifyChar:null, writeChar:null, connected:false },
  config: null, deviceConfig: null, values: {}, rxBuffer: '',
  justDragged: false, _dragT: null,
  // New features
  multiSelect: [], clipboard: [], undoStack: [], maxUndo: 50, redoStack: [],
  zoom: 1, gridSnap: true, gridSize: 20, showGuides: true,
  // More features
  theme: 'dark',
  groups: {}, // groupId -> [widgetIds]
  widgetTemplates: [], // saved widget groups
  showLayers: false,
  showRuler: false,
  livePreview: true,
  canvasBg: null, // background image
  history: [], // visual history
  arrangeMode: false, // runtime arrange mode
  buildCanvasSize: null, // logical Build canvas size used for portable layout export
  buildZoom: 1, // editor-only zoom; never changes exported geometry
  buildFitActive: false, // recompute Fit on viewport resize until user chooses manual zoom
  playZoom: 1, // runtime-only zoom; never changes widget geometry
  playFitActive: false, // occupied-content Fit follows viewport/fullscreen changes
  playViewRequestToken: 0, // cancels a queued auto-Fit if the user chooses a manual view first
  runtimeSource: null, // 'build' | 'device' | 'demo'; controls Arrange→Build sync
  runtimeBindingCleanups: [] // document listeners/timers owned by current Play DOM
};
state._allowLoadingOverlay = false;

// === AUTO-SAVE / LOAD PROJECT ===
const PROJECT_STORAGE_KEY = 'microbit_remote_project';

function saveProject() {
  try {
    const titleEl = document.querySelector('#titleInput');
    const projectData = {
      widgets: state.widgets,
      nextId: state.nextId,
      title: titleEl ? titleEl.value : '',
      canvasBg: state.canvasBg,
      theme: state.theme,
      buildCanvasSize: state.buildCanvasSize,
      savedAt: Date.now()
    };
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(projectData));
  } catch (e) {
    console.warn('Failed to save project:', e);
  }
}

function loadSavedProject() {
  try {
    const saved = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!saved) return false;
    
    const projectData = JSON.parse(saved);
    if (!projectData.widgets || projectData.widgets.length === 0) return false;
    
    // Restore state
    state.widgets = projectData.widgets.map(w => {
      if (typeof applyWidgetDefaults === 'function') return applyWidgetDefaults({...w});
      return {...w};
    });
    state.nextId = projectData.nextId || (state.widgets.length + 1);
    state.canvasBg = projectData.canvasBg || null;
    if (projectData.theme) state.theme = projectData.theme;
    if (projectData.buildCanvasSize?.w && projectData.buildCanvasSize?.h) state.buildCanvasSize = {...projectData.buildCanvasSize};
    
    // Restore title after DOM is ready
    setTimeout(() => {
      const titleEl = document.querySelector('#titleInput');
      if (titleEl && projectData.title) titleEl.value = projectData.title;
      
      // Apply canvas background if saved
      if (state.canvasBg) {
        const canvas = document.querySelector('#canvas');
        if (canvas) {
          canvas.style.backgroundImage = `url(${state.canvasBg})`;
          canvas.style.backgroundSize = 'cover';
          canvas.style.backgroundPosition = 'center';
        }
      }
    }, 50);
    
    return true;
  } catch (e) {
    console.warn('Failed to load project:', e);
    return false;
  }
}

function clearSavedProject() {
  try {
    localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch (e) {}
}

// Auto-save with debounce
let _autoSaveTimer = null;
function scheduleAutoSave() {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    saveProject();
  }, 500);
}

// ---- Kid-friendly sound engine (WebAudio) ----
state.soundOn = true;
state._audio = { ctx: null, unlocked: false };
state._gaugeLast = state._gaugeLast || {};

function ensureAudio() {
  if (!state.soundOn) return null;
  if (state._audio.ctx) return state._audio.ctx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state._audio.ctx = new Ctx();
    return state._audio.ctx;
  } catch (e) { return null; }
}

function unlockAudioOnce() {
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
  state._audio.unlocked = true;
}

document.addEventListener('pointerdown', () => unlockAudioOnce(), { once: true });

function beep(freq=880, dur=0.06, vol=0.05, type='sine') {
  if (!state.soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.value = vol;
  o.connect(g); g.connect(ctx.destination);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t);
  o.stop(t + dur + 0.02);
}
// Sound patterns
function beepClick(){ beep(880, 0.05, 0.05, 'sine'); }
function beepToggle(on){ beep(on?1046:659, 0.06, 0.05, 'square'); }
function beepWarn(){ beep(523, 0.09, 0.06, 'triangle'); setTimeout(()=>beep(659,0.09,0.05,'triangle'), 110); }
function beepDanger(){ beep(330, 0.10, 0.07, 'sawtooth'); setTimeout(()=>beep(330,0.10,0.07,'sawtooth'), 130); }
function beepSuccess(){ beep(523, 0.08, 0.05, 'sine'); setTimeout(()=>beep(659,0.08,0.05,'sine'), 100); setTimeout(()=>beep(784,0.12,0.05,'sine'), 200); }

// Plays one of the named effects above for a "sound" widget's incoming
// UPD value. Named strings and RemoteXY-style numeric IDs both map to the
// same small effect set (there's no audio-file library here, just tones).
function playSoundEffect(val){
  const v = String(val || '').trim().toLowerCase();
  if (v === 'success' || v === '1004') beepSuccess();
  else if (v === 'warn' || v === 'warning' || v === '1012') beepWarn();
  else if (v === 'danger' || v === 'error' || v === '1003') beepDanger();
  else if (v === 'toggle' || v === '1002') beepToggle(true);
  else beepClick(); // "beep" and anything unrecognized
}

// Sound UI
function updateSoundUI(){
  const b = $('#soundBtn');
  if (!b) return;
  b.classList.toggle('connected', state.soundOn);
  b.querySelector('span:last-child').textContent = state.soundOn ? tr('soundOn') : tr('soundOff');
  b.style.opacity = state.soundOn ? '1' : '0.7';
}



// Ensure older configs/templates still look good when new properties are added
function applyWidgetDefaults(w){
  if (!w || !w.t) return w;

  // Normalize geometry at the config boundary. This prevents NaN/string values
  // from destabilizing Build/Play calculations while preserving exact coordinates.
  const num = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  w.x = Math.max(0, num(w.x, 0));
  w.y = Math.max(0, num(w.y, 0));
  w.w = Math.max(1, num(w.w, (SIZES[w.t]?.[0] || 100)));
  w.h = Math.max(1, num(w.h, (SIZES[w.t]?.[1] || 100)));

  // Default models (3 per widget type)
  if (!w.model){
    if (w.t === 'button') w.model = 'neo';
    if (w.t === 'slider') w.model = 'track';
    if (w.t === 'toggle') w.model = 'square';
    if (w.t === 'led') w.model = 'dot';
    if (w.t === 'joystick') w.model = 'classic';
    if (w.t === 'label') w.model = 'plain';
    if (w.t === 'gauge') w.model = 'classic';
    if (w.t === 'graph') w.model = 'grid';
  }

  // Existing per-type defaults
  if (w.t === 'led'){
    if (!w.colorOn) w.colorOn = '#ff5252';
    if (!w.colorOff) w.colorOff = '#2a2a3a';
  }
  if (w.t === 'slider'){
    if (w.min == null) w.min = 0;
    if (w.max == null) w.max = 100;
    if (w.step == null) w.step = 1;
  }

  // Gauge defaults
  if (w.t === 'gauge'){
    if (w.min == null) w.min = 0;
    if (w.max == null) w.max = 100;
    if (w.decimals == null) w.decimals = 1;
    if (w.units == null) w.units = '';
    if (w.warn == null) w.warn = null;   // optional threshold
    if (w.danger == null) w.danger = null;
  }

  // Graph defaults (comma-separated multi-series values: "23.4,2.1")
  if (w.t === 'graph'){
    if (w.series == null) w.series = 1;      // 1..10
    if (w.windowSec == null) w.windowSec = 30; // visible time window
    if (w.autoScale == null) w.autoScale = true;
    if (w.min == null) w.min = 0;
    if (w.max == null) w.max = 100;
    if (w.showLegend == null) w.showLegend = true;
  }

  // Select defaults — options stored as a comma-separated string, same
  // convention as graph's seriesNames (no dedicated list-editor UI).
  if (w.t === 'select'){
    if (!w.options) w.options = 'Option 1,Option 2,Option 3';
  }

  // Edit field defaults
  if (w.t === 'editfield'){
    if (w.placeholder == null) w.placeholder = 'Type here...';
  }

  // v2.2 structural widgets. Groups are visual/organizational containers;
  // their children remain ordinary top-level CFG widgets so older clients can
  // safely ignore the grouping metadata. Separators are also visual-only.
  if (w.t === 'group'){
    if (!w.model) w.model = 'panel';
    if (!Array.isArray(w.children)) {
      w.children = String(w.children || '').split(',').map(x => x.trim()).filter(Boolean);
    }
    if (w.padding == null) w.padding = 18;
    if (w.label == null) w.label = 'Group';
  }
  if (w.t === 'separator'){
    if (!w.model) w.model = 'subtle';
    if (!w.orientation) w.orientation = (Number(w.h || 0) > Number(w.w || 0)) ? 'vertical' : 'horizontal';
    if (w.thickness == null) w.thickness = 1;
    w.thickness = Math.max(1, Math.min(6, Number(w.thickness) || 1));
  }

  return w;
}

function modelOptionsForType(t){
  switch(t){
    case 'button': return [
      { v:'neo',   name:'Neo (gradient)' },
      { v:'flat',  name:'Flat' },
      { v:'glass', name:'Glass' }
    ];
    case 'slider': return [
      { v:'track', name:'Track' },
      { v:'neon',  name:'Neon' },
      { v:'min',   name:'Minimal' }
    ];
    case 'toggle': return [
      { v:'square', name:'Square' },
      { v:'pill',   name:'Pill' },
      { v:'icon',   name:'Icon' }
    ];
    case 'led': return [
      { v:'dot',  name:'Dot' },
      { v:'bar',  name:'Bar' },
      { v:'ring', name:'Ring' }
    ];
    case 'dpad': return [
      { v:'classic',   name:'Classic (4 way)' },
      { v:'leftright', name:'Left / Right only' },
      { v:'mecanum',   name:'Mecanum (8 way + stop)' }
    ];
    case 'joystick': return [
      { v:'classic', name:'Classic' },
      { v:'neon',    name:'Neon' },
      { v:'min',     name:'Minimal' }
    ];
    case 'label': return [
      { v:'plain', name:'Plain' },
      { v:'card',  name:'Card' },
      { v:'glow',  name:'Glow' }
    ];
    case 'gauge': return [
      { v:'classic', name:'Classic' },
      { v:'neon',    name:'Neon' },
      { v:'min',     name:'Minimal' }
    ];
    case 'graph': return [
      { v:'grid',    name:'Grid' },
      { v:'dark',    name:'Dark' },
      { v:'min',     name:'Minimal' }
    ];
    case 'group': return [
      { v:'panel',       name:'Panel' },
      { v:'minimal',     name:'Minimal' },
      { v:'transparent', name:'Transparent' }
    ];
    case 'separator': return [
      { v:'subtle', name:'Subtle' },
      { v:'solid',  name:'Solid' },
      { v:'dashed', name:'Dashed' }
    ];
    default: return null;
  }
}

// BLE Write Queue - ensures only ONE GATT operation at a time
// This prevents "GATT operation failed" errors from concurrent writes
const bleSend = {
  isWriting: false,     // Lock: true while a write is in progress
  pendingMsg: null,     // Latest message waiting to be sent (replaces previous)
  // Deviation from stock bit-rxy: a small FIFO for discrete,
  // must-not-drop messages (dpad press/release). pendingMsg's "latest
  // wins" coalescing is correct for continuous controls (joystick/
  // sliders) but wrong for a dpad sharing ONE widget id across 4
  // directions — a quick direction change could overwrite an unflushed
  // press/release from another direction before it ever reached the
  // radio (confirmed root cause of the original dpad bug: only one
  // direction ever arrived). queue is drained ahead of pendingMsg.
  queue: [],
  // Minimum ms between writes. Was 200, which was the single biggest
  // source of control latency: EVERY message waits behind the previous
  // one, and there is constant background traffic (the 1s link PING, the
  // 300ms D-pad keepalive) occupying those slots — so a button press
  // could sit here up to 200ms before it was even transmitted, on top of
  // the radio's own latency.
  //
  // That 200ms was chosen defensively while writes were mysteriously
  // failing, and the real cause of those failures turned out to be the
  // 20-byte MTU truncation, which is fixed. A BLE connection interval is
  // typically 7.5-30ms, so 60ms still leaves ample headroom while making
  // the D-pad feel immediate. Raise it again if writes start failing.
  minInterval: 0,
  lastSendTime: 0,      // Timestamp of last successful send
  retryCount: 0,        // Track consecutive failures
  maxRetries: 3         // Max retries before giving up on a message
};

// The actual low-level BLE write - MUST be awaited and serialized
async function bleWrite(msg) {
  if (!state.ble.writeChar || !state.ble.device?.gatt?.connected) {
    console.log('[BLE] Not connected, skipping:', msg);
    return false;
  }
  
  try {
    const data = encoder.encode(msg + '\n');

    // Split into <=20-byte packets. The micro:bit's BLE connection uses
    // the default ATT MTU of 23, which leaves exactly 20 bytes of
    // payload per write. A longer write does NOT error — it is silently
    // truncated, so the trailing '\n' never arrives and the firmware's
    // uartReadUntil(NewLine) waits forever for a line that never
    // completes. The command vanishes with no error on either side.
    //
    // This is why only "up" ever worked on the D-pad:
    //   SET dpad_move up 1     = 19 bytes -> fits, worked
    //   SET dpad_move down 1   = 21 bytes -> lost
    //   SET dpad_move left 1   = 21 bytes -> lost
    //   SET dpad_move right 1  = 22 bytes -> lost
    // Every command previously confirmed working (STOP, Buzz, LED
    // toggles, servo sliders, GETCFG) is <=20 bytes; every one that
    // "did nothing" is over.
    //
    // The reverse direction already handled this: notifications arrive
    // pre-split (observed live as "UPD lbl_heartbeat 14" + "7") and are
    // reassembled by state.rxBuffer in onNotify(). The firmware side
    // needs no change — the UART service buffers incoming bytes, so
    // uartReadUntil() reassembles these chunks the same way.
    const MAX_PACKET = 20;
    for (let off = 0; off < data.length; off += MAX_PACKET) {
      const chunk = data.subarray(off, off + MAX_PACKET);
      // Use writeValueWithoutResponse (faster, but still must be serialized!)
      if (state.ble.writeChar.writeValueWithoutResponse) {
        await state.ble.writeChar.writeValueWithoutResponse(chunk);
      } else {
        await state.ble.writeChar.writeValue(chunk);
      }
    }

    console.log('[BLE] Sent:', msg);
    bleSend.retryCount = 0; // Reset on success
    return true;
  } catch (err) {
    console.error('[BLE] Write failed:', err.message);
    
    // Check if it's a disconnect error
    if (err.message?.includes('disconnected') || err.message?.includes('GATT Server')) {
      onDisconnect();
      return false;
    }
    
    // For GATT operation errors, we can retry
    bleSend.retryCount++;
    if (bleSend.retryCount >= bleSend.maxRetries) {
      console.warn('[BLE] Max retries reached, dropping message');
      bleSend.retryCount = 0;
    }
    return false;
  }
}

// Process the write queue - ensures serialized GATT operations
async function processWriteQueue() {
  // Web Bluetooth permits only one GATT operation at a time. The v43
  // dedicated motor writer had a separate lock, so a mode/slider/PING
  // write could collide with a motor write and be dropped with
  // "GATT operation already in progress". Motor traffic stays priority;
  // ordinary traffic waits until the motor write is finished.
  if (motorWriteBusy) {
    setTimeout(processWriteQueue, 1);
    return;
  }
  // If already writing, exit - the current write will pick up pending
  if (bleSend.isWriting) return;

  // Nothing to send
  if (bleSend.queue.length === 0 && !bleSend.pendingMsg) return;

  // Check minimum interval
  const now = Date.now();
  const timeSinceLastSend = now - bleSend.lastSendTime;
  if (timeSinceLastSend < bleSend.minInterval) {
    // Schedule next attempt
    setTimeout(processWriteQueue, bleSend.minInterval - timeSinceLastSend + 5);
    return;
  }

  // Lock, grab message, clear pending. FIFO queue (discrete/critical
  // messages like dpad press/release) always drains before the
  // latest-wins slot (continuous controls), so a burst of dpad presses
  // can't get coalesced away by each other.
  bleSend.isWriting = true;
  let msg;
  if (bleSend.queue.length > 0) {
    msg = bleSend.queue.shift();
  } else {
    msg = bleSend.pendingMsg;
    bleSend.pendingMsg = null;
  }

  try {
    const success = await bleWrite(msg);
    if (success) {
      bleSend.lastSendTime = Date.now();
    }
  } finally {
    // Always unlock
    bleSend.isWriting = false;

    // If new message arrived while we were writing, process it
    if (bleSend.queue.length > 0 || bleSend.pendingMsg) {
      // Small delay to respect minimum interval
      bleSend.minInterval > 0 ? setTimeout(processWriteQueue, bleSend.minInterval) : queueMicrotask(processWriteQueue);
    }
  }
}

// ── REMEMBERED CONTROL VALUES ────────────────────────────────────────────
// Some robots have nowhere to keep a setting. A micro:bit has no writable
// storage a MakeCode program can reach, so a calibration like wheel trim dies
// with the battery. The app remembers it instead and plays it back on connect.
//
// Opt-in from the ROBOT, never guessed here: only widgets whose CFG entry
// carries `restore` are saved and replayed. That matters for safety as much as
// tidiness -- replaying a Mode select could put a robot into a self-driving
// mode the moment it connects, and replaying a Level select would swap the
// layout out from under the restore itself. The robot owns its layout, so the
// robot decides what is safe to bring back.
//
// Keyed per robot, so two identical ones keep their own trim.
//
// By NAME first, id second -- the reverse of what looks natural.
// BluetoothDevice.id is an opaque per-origin handle the browser is free to
// mint fresh for a new document, and on a file:// page it does exactly that:
// an id-keyed record is lost by the very reload it exists to survive. A
// micro:bit's name is derived from its MAC, so it is both stable across
// reloads and still different for two robots on the bench. Falls back to the
// id for a peripheral that advertises no name at all.
const CTRL_STORE_PREFIX = 'rxy_ctrl_v1:';

function ctrlStoreKey() {
  const d = state.ble?.device;
  if (!d) return null;
  const name = String(d.name || '').trim();
  const tag = name || d.id;
  return tag ? CTRL_STORE_PREFIX + tag : null;
}

function ctrlRestorable(id) {
  const w = (state.config?.widgets || []).find(x => x.id === id);
  return !!(w && w.restore);
}

function ctrlSave(id, val) {
  const key = ctrlStoreKey();
  if (!key || !ctrlRestorable(id)) return;
  try {
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    all[id] = val;
    localStorage.setItem(key, JSON.stringify(all));
  } catch (e) { /* storage full or blocked: remembering is a convenience */ }
}

function ctrlRestoreAll() {
  const key = ctrlStoreKey();
  if (!key) return;
  let all;
  try { all = JSON.parse(localStorage.getItem(key) || '{}'); }
  catch (e) { return; }
  const widgets = (state.config?.widgets || []).filter(w => w.restore && all[w.id] != null);
  if (!widgets.length) return;
  // Spaced out rather than blasted: these go over the same link the layout
  // just used, and a burst of writes straight after CFGEND is what used to
  // wedge the BLE stack on reconnect.
  let i = 0;
  const step = () => {
    if (i >= widgets.length || !state.ble.connected) return;
    const w = widgets[i++];
    const val = all[w.id];
    updateRuntimeWidget(w.id, val);   // move the control itself
    state.values[w.id] = val;
    send(`SET ${w.id} ${val}`);       // and tell the robot
    setTimeout(step, 60);
  };
  console.log('[BLE] Restoring', widgets.length, 'remembered control values');
  setTimeout(step, 300);
}

// Public send function - queues message and triggers processing
function send(msg) {
  if (!state.ble.connected) return;

  // Sanitize
  msg = String(msg || '').replace(/[\r\n]+/g, '').trim();
  if (!msg) return;

  // One choke point for every control: catching it here means each widget type
  // does not need its own save call, and a type added later is covered free.
  const m = /^SET (\S+) (.+)$/.exec(msg);
  if (m) ctrlSave(m[1], m[2]);

  // Always update pending (latest value wins for continuous controls like joystick)
  bleSend.pendingMsg = msg;

  // Trigger queue processing (will respect lock and interval)
  processWriteQueue();
}

// Reliable send — for discrete, must-not-drop messages (dpad press/
// release) where losing one to "latest wins" coalescing is a real bug,
// not just a missed intermediate frame. See bleSend.queue comment above.
function sendReliable(msg) {
  if (!state.ble.connected) return;
  msg = String(msg || '').replace(/[\r\n]+/g, '').trim();
  if (!msg) return;
  // Same remember-this choke point as send(). Without it a control that
  // switched to this path would quietly stop being restored on connect.
  const m = /^SET (\S+) (.+)$/.exec(msg);
  if (m) ctrlSave(m[1], m[2]);
  bleSend.queue.push(msg);
  processWriteQueue();
}

// Motor-state send: unlike ordinary reliable button events, motion should
// NEVER replay stale history. Each packet carries the complete current
// D-pad state, so replace any older queued motor packet and put the newest
// one at the front of the queue. At most the write already in progress can
// be ahead of it.
function sendMotorState(msg) {
  if (!state.ble.connected) return;
  msg = String(msg || '').replace(/[\r\n]+/g, '').trim();
  if (!msg) return;
  bleSend.queue = bleSend.queue.filter(m => !String(m).startsWith('M '));
  if (bleSend.pendingMsg === 'PING') bleSend.pendingMsg = null;
  bleSend.queue.unshift(msg);
  processWriteQueue();
}

// Complete D-pad state bitmask: U=1, D=2, L=4, R=8.
//
// LATENCY PATH: D-pad traffic no longer goes through the generic BLE queue
// at all. Each state is encoded as ONE ASCII byte 'a'..'p' (mask 0..15)
// plus '\n', so a complete motor command is exactly 2 bytes.
let dpadMotionMask = 0;
let motorWriteBusy = false;
let motorPendingMask = null;
let lastDpadEventAt = 0;

async function flushMotorWrite() {
  if (motorWriteBusy || motorPendingMask === null) return;
  if (!state.ble.connected || !state.ble.writeChar || !state.ble.device?.gatt?.connected) return;
  // Never overlap GATT operations. An ordinary write already in progress
  // is allowed to finish; the pending motor mask remains latest-state-wins
  // and is flushed immediately afterward.
  if (bleSend.isWriting) {
    setTimeout(flushMotorWrite, 1);
    return;
  }

  motorWriteBusy = true;
  try {
    while (motorPendingMask !== null && state.ble.connected) {
      const mask = motorPendingMask & 15;
      motorPendingMask = null;
      const packet = new Uint8Array([97 + mask, 10]); // 'a'+mask, newline
      const ch = state.ble.writeChar;
      if (ch.writeValueWithoutResponse) {
        await ch.writeValueWithoutResponse(packet);
      } else {
        await ch.writeValue(packet);
      }
    }
  } catch (err) {
    console.error('[DPAD] Direct motor write failed:', err?.message || err);
  } finally {
    motorWriteBusy = false;
    if (motorPendingMask !== null) queueMicrotask(flushMotorWrite);
  }
}

function sendMotorMaskNow(mask) {
  if (!state.ble.connected) return;
  lastDpadEventAt = performance.now();
  motorPendingMask = mask & 15; // latest state wins
  flushMotorWrite();
}
// Diagonals are not a new wire concept: a corner is just the two cardinal
// bits set at once, which handleDpadMask() already sums into nx/ny.
const DPAD_BITS = { up: 1, down: 2, left: 4, right: 8, upleft: 1 | 4, upright: 1 | 8, downleft: 2 | 4, downright: 2 | 8 };
function dpadBit(dir) {
  return DPAD_BITS[dir] || 0;
}
function setDpadMotion(dir, pressed) {
  // The centre STOP is not a direction. It clears every held bit outright,
  // so releasing it cannot re-assert a cardinal that is still physically
  // down — which is exactly what toggling a single bit would do here.
  if (dir === 'stop') {
    if (!pressed) return;
    dpadMotionMask = 0;
    sendMotorMaskNow(0);
    return;
  }
  const bit = dpadBit(dir);
  dpadMotionMask = pressed ? (dpadMotionMask | bit) : (dpadMotionMask & ~bit);
  sendMotorMaskNow(dpadMotionMask);
}

// Registry of live D-pad keepalive intervals (see the dpad binding).
// These are setInterval timers that are NOT tied to the lifetime of the
// button element, so they survive both a disconnect while a direction
// is held AND a renderRuntime() that replaces the widget DOM. A leaked
// timer is silent while disconnected (send() no-ops), then resumes
// firing every 300ms on the next connect — overwriting bleSend's
// latest-wins slot, which is how a stale keepalive could clobber the
// GETCFG handshake and leave the loader stuck at 0%.
const dpadKeepalives = new Set();
function clearAllDpadKeepalives(sendStop = false) {
  dpadKeepalives.forEach(id => clearInterval(id));
  dpadKeepalives.clear();
  const shouldStop = !!sendStop && state.ble.connected && (dpadMotionMask !== 0 || motorPendingMask !== null);
  dpadMotionMask = 0;
  // For a live view transition, latest-state-wins must finish with mask 0.
  // On a real disconnect there is no writable link, so just discard pending work.
  motorPendingMask = shouldStop ? 0 : null;
  bleSend.queue = bleSend.queue.filter(m => !String(m).startsWith('M '));
  if (shouldStop) flushMotorWrite();
}

// Link-liveness ping. The micro:bit's bluetooth.onBluetoothDisconnected
// event does NOT fire on this hardware — verified by an explicit
// gatt.disconnect() from here never producing the firmware's ✗ — so the
// robot had no way to know the link had gone. Its motors would keep
// running on the last command after a closed tab, a reload, a crash, or
// walking out of range.
//
// The firmware now judges the link by traffic instead, so this keeps a
// trickle flowing while nobody is driving. Sent through the coalescing
// slot rather than the FIFO: a dropped ping is harmless, the next one is
// a second away, and it must never delay a real command.
let pingTimer = null;
const PING_INTERVAL_MS = 3000;
function startLinkPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (!state.ble.connected) { clearInterval(pingTimer); pingTimer = null; return; }
    if (dpadMotionMask === 0 && performance.now() - lastDpadEventAt > 1500) send('PING');
  }, PING_INTERVAL_MS);
}
function stopLinkPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}

// One-click Demo - creates full showcase with ALL widgets
function showDemo() {
  // Create a demo showcasing control, display, and structural widget types.
  state.widgets = [
    // Row 1: Buttons + Sliders
    { id: 'btn_jump', t: 'button', x: 20, y: 20, w: 100, h: 100, label: 'Jump!', model:'neo' },
    { id: 'btn_fire', t: 'button', x: 140, y: 20, w: 100, h: 100, label: 'Fire!', model:'glass' },
    { id: 'slider_speed', t: 'slider', x: 260, y: 20, w: 80, h: 160, label: 'Speed', model:'track', min:0, max:100, step:1 },
    { id: 'slider_power', t: 'slider', x: 360, y: 20, w: 80, h: 160, label: 'Power', model:'neon', min:0, max:100, step:1 },
    
    // Row 2: Toggles + LEDs
    { id: 'toggle_turbo', t: 'toggle', x: 20, y: 140, w: 100, h: 80, label: 'Turbo', model:'pill' },
    { id: 'toggle_shield', t: 'toggle', x: 140, y: 140, w: 100, h: 80, label: 'Shield', model:'icon' },
    { id: 'led_status', t: 'led', x: 260, y: 200, w: 70, h: 70, label: 'Status', model:'dot', colorOn:'#00e676', colorOff:'#1b2a3a' },
    { id: 'led_alert', t: 'led', x: 350, y: 200, w: 70, h: 70, label: 'Alert', model:'ring', colorOn:'#ff5252', colorOff:'#1b2a3a' },
    
    // Row 3: Joystick + D-Pad side by side
    { id: 'joy_move', t: 'joystick', x: 20, y: 240, w: 140, h: 140, label: 'Move', model:'ring' },
    { id: 'dpad_nav', t: 'dpad', x: 180, y: 240, w: 140, h: 140, label: 'Navigate', model:'classic' },
    
    // Row 3: Label
    { id: 'label_score', t: 'label', x: 340, y: 290, w: 180, h: 50, label: 'Score: 0', model:'chip' },
    
    // Row 4: XY Pad + Battery + Timer
    { id: 'xypad_aim', t: 'xypad', x: 20, y: 400, w: 140, h: 140, label: 'Aim', model:'grid' },
    { id: 'battery_level', t: 'battery', x: 180, y: 400, w: 70, h: 100, label: 'Power', model:'vertical' },
    { id: 'timer_game', t: 'timer', x: 270, y: 400, w: 120, h: 70, label: 'Game Time', model:'digital', autoStart: false },

    // Row 5: Gauges
    { id: 'gauge_temp', t: 'gauge', x: 20, y: 560, w: 140, h: 160, label: 'Temp', min: 0, max: 50, units: '°C', decimals: 1, model:'classic' },
    { id: 'gauge_level', t: 'gauge', x: 180, y: 560, w: 140, h: 160, label: 'Level', min: 0, max: 100, units: '%', decimals: 0, model:'neon' },
    
    // Row 6: Graph
    { id: 'graph_env', t: 'graph', x: 20, y: 740, w: 420, h: 150, label: 'Live Data', series: 2, windowSec: 30, autoScale: true, model:'grid' },

    // Row 7: Select + Edit Field + Sound + Notification
    { id: 'select_mode', t: 'select', x: 460, y: 400, w: 160, h: 70, label: 'Mode', options: 'Slow,Medium,Fast' },
    { id: 'editfield_name', t: 'editfield', x: 460, y: 480, w: 200, h: 70, label: 'Name' },
    { id: 'sound_fx', t: 'sound', x: 460, y: 560, w: 90, h: 90, label: 'Sound' },
    { id: 'alert_box', t: 'notification', x: 560, y: 560, w: 90, h: 90, label: 'Alert' }
  ];
  state.widgets = state.widgets.map(applyWidgetDefaults);
  state.nextId = 30;
  state.selected = null;
  $('#titleInput').value = 'Super Demo Remote';
  renderWidgets();
  // Reflow demo widgets to whatever canvas size we actually have so nothing
  // bleeds off-screen on narrow viewports
  try { autoArrangeWidgets(); } catch (e) {}
  renderPropsPanel();
  
  // Show the code modal with demo code
  const cfg = { title: 'Super Demo Remote', widgets: state.widgets };
  // Load demo into runtime immediately (no micro:bit required)
  state.config = cloneSerializable(cfg);
  state.runtimeSource = 'build';
  state.values = state.values || {};
  renderRuntime();
  startDemoSim();
  
  // Show arrange button in demo mode
  const arrangeBtn = $('#arrangeModeBtn');
  if (arrangeBtn) arrangeBtn.classList.add('visible');
  
  // Show fullscreen button in demo mode
  const fullscreenBtn = $('#fullscreenBtn');
  const reloadConfigBtn = $('#reloadConfigBtn');
  if (reloadConfigBtn) reloadConfigBtn.classList.add('visible');
  if (fullscreenBtn) fullscreenBtn.classList.add('visible');
  
  // Show runtime content
  $('#connectPrompt').style.display = 'none';
  $('#runtimeContent').style.display = 'flex';
  
  $('#modalTitle').textContent = tr('codeModal.titleDemo');
  $('#modalCode').textContent = generateDemoCode(cfg);
  $('#modalBg').classList.add('show');

  toast(tr('toast.demoLoaded'), 'success');
}

function generateDemoCode(cfg) {
  // Unicode-safe base64 encoding (handles emojis!)
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
  
  // Group widgets by type
  const buttons = cfg.widgets.filter(w => w.t === 'button');
  const sliders = cfg.widgets.filter(w => w.t === 'slider');
  const toggles = cfg.widgets.filter(w => w.t === 'toggle');
  const joysticks = cfg.widgets.filter(w => w.t === 'joystick');
  const dpads = cfg.widgets.filter(w => w.t === 'dpad');
  const xypads = cfg.widgets.filter(w => w.t === 'xypad');
  const timers = cfg.widgets.filter(w => w.t === 'timer');
  const leds = cfg.widgets.filter(w => w.t === 'led');
  const labels = cfg.widgets.filter(w => w.t === 'label');
  const gauges = cfg.widgets.filter(w => w.t === 'gauge');
  const graphs = cfg.widgets.filter(w => w.t === 'graph');
  const batteries = cfg.widgets.filter(w => w.t === 'battery');
  const selects = cfg.widgets.filter(w => w.t === 'select');
  const editfields = cfg.widgets.filter(w => w.t === 'editfield');
  const sounds = cfg.widgets.filter(w => w.t === 'sound');
  const notifications = cfg.widgets.filter(w => w.t === 'notification');

  // Generate handler code for each widget
  let buttonCode = buttons.map(w => `    // Button: ${w.label || w.id}
    if (id == "${w.id}" && val == "1") {
        basic.showIcon(IconNames.Heart)
        // Add your code here!
    }`).join('\n');
  
  let sliderCode = sliders.map(w => `    // Slider: ${w.label || w.id} (val = 0-100)
    if (id == "${w.id}") {
        let value = parseInt(val)
        led.plotBarGraph(value, 100)
        // Use value for motors, sounds, etc!
    }`).join('\n');
  
  let toggleCode = toggles.map(w => `    // Toggle: ${w.label || w.id} (val = "1" or "0")
    if (id == "${w.id}") {
        if (val == "1") {
            basic.showIcon(IconNames.Yes)
        } else {
            basic.showIcon(IconNames.No)
        }
    }`).join('\n');
  
  let joystickCode = joysticks.map(w => `    // Joystick: ${w.label || w.id} (val = "angle distance", angle 0-360, distance 0-100)
    if (id == "${w.id}") {
        let parts = val.split(" ")
        let angle = parseInt(parts[0])  // 0-360 degrees (0=right, 90=down, 180=left, 270=up)
        let dist = parseInt(parts[1])   // 0-100 (0=center, 100=edge)
        // Use for steering, movement, etc!
        if (dist > 10) {
            if (angle < 45 || angle >= 315) basic.showArrow(ArrowNames.East)
            else if (angle < 135) basic.showArrow(ArrowNames.South)
            else if (angle < 225) basic.showArrow(ArrowNames.West)
            else basic.showArrow(ArrowNames.North)
        } else {
            basic.showIcon(IconNames.SmallDiamond)
        }
    }`).join('\n');

  let dpadCode = dpads.map(w => `    // D-Pad: ${w.label || w.id} (val = "direction state", direction: ${w.model === 'mecanum' ? 'up/down/left/right/upleft/upright/downleft/downright/stop' : w.model === 'leftright' ? 'left/right' : 'up/down/left/right'}, state: 1=pressed, 0=released)
    if (id == "${w.id}") {
        let parts = val.split(" ")
        let dir = parts[0]
        let pressed = parts[1] == "1"
        serial.writeLine("DPAD dir=[" + dir + "] pressed=" + pressed)
        if (pressed) {
            basic.clearScreen()
            if (dir == "up") {
                basic.showArrow(ArrowNames.North)
            } else if (dir == "down") {
                basic.showArrow(ArrowNames.South)
            } else if (dir == "left") {
                basic.showArrow(ArrowNames.West)
            } else if (dir == "right") {
                basic.showArrow(ArrowNames.East)
            } else {
                serial.writeLine("DPAD unknown dir: [" + dir + "]")
                basic.showString(dir.charAt(0))
            }
        } else {
            basic.clearScreen()
        }
    }`).join('\n');

  let xypadCode = xypads.map(w => `    // XY Pad: ${w.label || w.id} (val = "x y", both 0-100)
    if (id == "${w.id}") {
        let parts = val.split(" ")
        let x = parseInt(parts[0])  // 0-100 (0=left, 100=right)
        let y = parseInt(parts[1])  // 0-100 (0=top, 100=bottom)
        // Plot position on LED matrix
        led.plot(Math.floor(x / 25), Math.floor(y / 25))
        basic.pause(100)
        basic.clearScreen()
    }`).join('\n');

  let timerCode = timers.map(w => `    // Timer: ${w.label || w.id} (val = seconds elapsed)
    if (id == "${w.id}") {
        let secs = parseInt(val)
        // Do something with timer value
        serial.writeLine("Timer: " + secs + "s")
    }`).join('\n');

  let selectCode = selects.map(w => `    // Select: ${w.label || w.id} (val = the chosen option's text)
    if (id == "${w.id}") {
        serial.writeLine("Chose: " + val)
        // Compare val to your option strings, e.g.:
        // if (val == "Fast") { ... }
    }`).join('\n');

  let editfieldCode = editfields.map(w => `    // Edit Field: ${w.label || w.id} (val = whatever text was typed)
    if (id == "${w.id}") {
        basic.showString(val)
    }`).join('\n');

  let ledList = leds.map(w => `//   sendValue("${w.id}", "1")  // Turn ON ${w.label || 'LED'}
//   sendValue("${w.id}", "0")  // Turn OFF`).join('\n');

  let labelList = labels.map(w => `//   sendValue("${w.id}", "Hello!")  // Update ${w.label || 'label'}`).join('\n');

  // Calculate stats
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const cfgSize = b64.length;
  const nbChunks = Math.ceil(cfgSize / 18);
  // Readable copy of the layout, so the base64 blob below isn't opaque —
  // handy for editing CFG by hand or diffing layouts without decoding first.
  const cfgJsonComment = JSON.stringify(cfg, null, 2).split('\n').map(l => '// ' + l).join('\n');
  const totalWidgets = cfg.widgets.length;
  
  // Count widget types
  const inputWidgets = buttons.length + sliders.length + toggles.length + joysticks.length + dpads.length + xypads.length + selects.length + editfields.length;
  const outputWidgets = leds.length + labels.length + gauges.length + graphs.length + batteries.length + sounds.length + notifications.length;

  // Build header
  const header = `/**
 * ╔════════════════════════════════════════════════════════════════╗
 * ║            🎮 Micro:bit Remote Builder (bit-rxy) 🎮            ║
 * ║                                                                ║
 * ║   Powered by Workshop-DIY.org                                  ║
 * ║   Build your own Bluetooth remote controller!                  ║
 * ╚════════════════════════════════════════════════════════════════╝
 * 
 * 📋 PROJECT: ${cfg.title}
 * 📅 Generated: ${dateStr} at ${timeStr}
 * 
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ 📊 CONFIGURATION STATS                                         │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  • Config size: ${String(cfgSize).padEnd(6)} bytes (Base64 encoded)            │
 * │  • Chunks: ${String(nbChunks).padEnd(10)} (18 bytes each for BLE transfer)    │
 * │  • Total widgets: ${String(totalWidgets).padEnd(4)}                                       │
 * │    ├─ Input:  ${String(inputWidgets).padEnd(4)} (buttons, sliders, toggles, etc.)       │
 * │    └─ Output: ${String(outputWidgets).padEnd(4)} (LEDs, labels, gauges, graphs)         │
 * └─────────────────────────────────────────────────────────────────┘
 * 
 * 🔧 WIDGET BREAKDOWN:
 *    Buttons: ${buttons.length}  |  Sliders: ${sliders.length}  |  Toggles: ${toggles.length}
 *    Joysticks: ${joysticks.length}  |  D-Pads: ${dpads.length}  |  XY Pads: ${xypads.length}
 *    Selects: ${selects.length}  |  Edit Fields: ${editfields.length}
 *    LEDs: ${leds.length}  |  Labels: ${labels.length}  |  Gauges: ${gauges.length}
 *    Graphs: ${graphs.length}  |  Batteries: ${batteries.length}  |  Timers: ${timers.length}
 *    Sounds: ${sounds.length}  |  Notifications: ${notifications.length}
 * 
 * 🚀 HOW TO USE:
 *    1. Copy this entire code
 *    2. Go to https://makecode.microbit.org
 *    3. Create new project → Switch to JavaScript mode
 *    4. Paste this code → Download to micro:bit
 *    5. Open the app and connect!
 * 
 * 💡 TIPS:
 *    • Edit handleWidget() to customize behavior
 *    • Use sendValue() to update LEDs, labels, gauges
 *    • Check serial monitor for debug output
 * 
 * 🌐 More info: https://workshop-diy.org
 */

`;

  return header + `// ═══════════════════════════════════════════════════════════════
// 🔌 BLUETOOTH SETUP
// ═══════════════════════════════════════════════════════════════

bluetooth.startUartService()
let cfgSent = false
let blinkState = false
let loopTick = 0

// 📦 Remote layout config (Base64 encoded, ${cfgSize} bytes, ${nbChunks} chunks)
// Decoded below for reference (not read by the code — edit the layout in
// the Build tab and re-export to regenerate the base64 line under it):
${cfgJsonComment}
const CFG = "${b64}"

// ═══════════════════════════════════════════════════════════════
// 📡 BLUETOOTH COMMUNICATION
// ═══════════════════════════════════════════════════════════════

// This sends the remote layout to the app
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function() {
    let cmd = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    
    if (cmd == "GETCFG") {
        bluetooth.uartWriteLine("CFGBEGIN")
        for (let i = 0; i < CFG.length; i += 18) {
            bluetooth.uartWriteLine("CFG " + CFG.substr(i, 18))
        }
        bluetooth.uartWriteLine("CFGEND")
        cfgSent = true
        basic.showIcon(IconNames.Yes)
    } 
    else if (cmd.indexOf("SET ") == 0) {
        let parts = cmd.substr(4).split(" ")
        let id = parts[0]
        let val = parts.slice(1).join(" ")
        handleWidget(id, val)
    }
})

// ═══════════════════════════════════════════════════════════════
// 🎮 WIDGET HANDLERS - CUSTOMIZE YOUR BEHAVIOR HERE!
// ═══════════════════════════════════════════════════════════════

function handleWidget(id: string, val: string) {
    serial.writeLine(id + " = " + val)
    
${buttonCode || '    // No buttons in this remote'}

${sliderCode || '    // No sliders in this remote'}

${toggleCode || '    // No toggles in this remote'}

${joystickCode || '    // No joysticks in this remote'}

${dpadCode || '    // No D-Pads in this remote'}

${xypadCode || '    // No XY Pads in this remote'}

${timerCode || '    // No timers in this remote'}

${selectCode || '    // No selects in this remote'}

${editfieldCode || '    // No edit fields in this remote'}
}

// ═══════════════════════════════════════════════════════════════
// 📤 SEND VALUES TO APP (LEDs, Labels, Gauges, Graphs)
// ═══════════════════════════════════════════════════════════════

function sendValue(id: string, val: string) {
    if (cfgSent) bluetooth.uartWriteLine("UPD " + id + " " + val)
}

// ═══════════════════════════════════════════════════════════════
// 🚀 STARTUP
// ═══════════════════════════════════════════════════════════════

// Show we are ready!
basic.showIcon(IconNames.Heart)

// ═══════════════════════════════════════════════════════════════
// 🔄 MAIN LOOP - Demo animations (customize or remove!)
// ═══════════════════════════════════════════════════════════════

basic.forever(function() {
    if (cfgSent) {
        blinkState = !blinkState
        ${leds.length > 0 ? leds.map(l => `sendValue("${l.id}", blinkState ? "1" : "0")`).join('\n        ') : '// No LEDs to blink'}
        ${labels.length > 0 ? `sendValue("${labels[0].id}", blinkState ? "ON!" : "OFF")` : ''}
        // Demo updates for Gauges (single value) and Graphs (comma-separated)
        let t = input.runningTime()
        ${gauges.length > 0 ? gauges.map((g,i)=>`sendValue("${g.id}", "" + (Math.round((Math.sin((t/1000)+${i}) + 1) * 25)))`).join("\n        ") : "// No gauges to update"}
        ${graphs.length > 0 ? graphs.map((g,i)=>`sendValue("${g.id}", "" + (Math.round((Math.sin((t/900)+${i}) + 1) * 50)) + "," + (Math.round((Math.cos((t/1100)+${i}) + 1) * 50)))`).join("\n        ") : "// No graphs to update"}
        ${batteries.length > 0 ? batteries.map((b,i)=>`sendValue("${b.id}", "" + (Math.round((Math.sin((t/2000)+${i}) + 1) * 50)))`).join("\n        ") : "// No batteries to update"}
        // Sound/Notification demo: fire once every ~5s (25 ticks * 200ms) so
        // it doesn't spam — trigger these for real from your own game logic!
        loopTick += 1
        if (loopTick % 25 == 0) {
            ${sounds.length > 0 ? sounds.map(s=>`sendValue("${s.id}", "beep")  // beep | success | warn | danger | toggle`).join("\n            ") : "// No sounds to trigger"}
            ${notifications.length > 0 ? notifications.map(n=>`sendValue("${n.id}", "Hello from micro:bit!")`).join("\n            ") : "// No notifications to trigger"}
        }
    }
    basic.pause(200)
})

// ═══════════════════════════════════════════════════════════════
// 🔘 MICRO:BIT BUTTONS - Use hardware buttons too!
// ═══════════════════════════════════════════════════════════════

input.onButtonPressed(Button.A, function() {
    basic.showString("A")
    ${leds.length > 0 ? `sendValue("${leds[0].id}", "1")` : '// Add an LED to control it here!'}
})
input.onButtonPressed(Button.B, function() {
    basic.showString("B")
    ${leds.length > 0 ? `sendValue("${leds[0].id}", "0")` : '// Add an LED to control it here!'}
})

// ═══════════════════════════════════════════════════════════════
// 🎉 END OF CODE - Have fun building!
// ═══════════════════════════════════════════════════════════════
// 
// 💡 IDEAS TO TRY:
//    • Add motors: pins.servoWritePin(AnalogPin.P0, angle)
//    • Add sounds: music.playTone(Note.C, music.beat(BeatFraction.Whole))
//    • Add NeoPixels: neopixel.create(DigitalPin.P1, 8, NeoPixelMode.RGB)
//    • Read sensors: input.temperature(), input.lightLevel()
//
// 🌐 Share your projects: https://workshop-diy.org
// ═══════════════════════════════════════════════════════════════`;
}

function init() {
  const versionEl = document.getElementById('appVersion');
  if (versionEl) versionEl.textContent = APP_VERSION;

  try{ ensureCanvasToolbar(); }catch(e){}

  try{ placeToolbarWhereHintWas(); }catch(e){}
try{ placeToolbarWhereHintWas(); }catch(e){}
// keep controls at top-right
  try{ moveBuildPlayNameTopRight(); }catch(e){}

  const builderHeader = document.querySelector('.builder-header');
  if (builderHeader && builderHeader.children.length === 0) {
    builderHeader.style.display = 'none';
  }

  state._allowLoadingOverlay = false;
  if (typeof hideLoading === 'function') hideLoading();
  
  // Mobile props panel handling
  const propsPanel = $('#propsPanel');
  const propsPanelClose = $('#propsPanelClose');
  const isMobile = () => window.innerWidth <= 600;
  
  window.showMobilePropsPanel = function() {
    if (isMobile() && propsPanel) {
      propsPanel.classList.add('show-mobile');
    }
  };
  window.hideMobilePropsPanel = function() {
    if (propsPanel) {
      propsPanel.classList.remove('show-mobile');
    }
  };
  
  if (propsPanelClose) {
    propsPanelClose.onclick = (e) => {
      e.stopPropagation();
      hideMobilePropsPanel();
      state.selected = null;
      state.multiSelect = [];
      renderWidgets();
    };
  }
  
  // Tabs
  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  
  // Templates
  $$('.template-card').forEach(c => c.onclick = () => selectTemplate(c.dataset.tpl));
  
  // Palette - tap to select
  $$('.palette-item').forEach(p => {
    p.onclick = () => {
      $$('.palette-item').forEach(x => x.classList.remove('selected'));
      p.classList.add('selected');
      state.selectedType = p.dataset.type;
      // A palette entry may pin a model, so one widget type can appear more
      // than once with different presets -- "Turn Pad" is a dpad locked to the
      // two-button model. Empty for the plain entries, which keep the default.
      state.selectedModel = p.dataset.model || '';
      toast(tr('toast.widgetSelected', {icon: ICONS[state.selectedType]}), 'success');
    };
  });

  // Collapsible cards
  function setupCollapsibleCard(cardSel, toggleSel, bodySel, storageKey, opts = {}) {
    const card = $(cardSel);
    const toggle = $(toggleSel);
    const body = $(bodySel);
    if (!card || !toggle || !body) return;

    const setCollapsed = (collapsed) => {
      card.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      body.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    };

    let collapsed = !!opts.defaultCollapsed;
    try{
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) collapsed = saved === '1';
    }catch(e){}
    setCollapsed(collapsed);

    toggle.onclick = () => {
      if (opts.disableOnMobile && window.innerWidth <= 600) return;
      const next = !card.classList.contains('collapsed');
      setCollapsed(next);
      try{ localStorage.setItem(storageKey, next ? '1' : '0'); }catch(e){}
    };
  }

  setupCollapsibleCard('#actionsCard', '#actionsToggle', '#actionsBody', 'actionsCollapsed');
  setupCollapsibleCard('#paletteCard', '#paletteToggle', '#paletteBody', 'paletteCollapsed');

  // Properties panel collapse (desktop)
  const propsCollapseBtn = $('#propsCollapseBtn');
  if (propsPanel && propsCollapseBtn) {
    const setPropsCollapsed = (collapsed) => {
      propsPanel.classList.toggle('collapsed', collapsed);
      propsCollapseBtn.textContent = collapsed ? '+' : '–';
      propsCollapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    };
    try{
      const saved = localStorage.getItem('propsCollapsed');
      if (saved !== null) setPropsCollapsed(saved === '1');
    }catch(e){}
    propsCollapseBtn.onclick = () => {
      const next = !propsPanel.classList.contains('collapsed');
      setPropsCollapsed(next);
      try{ localStorage.setItem('propsCollapsed', next ? '1' : '0'); }catch(e){}
    };
  }
  
  // Canvas - tap to place + selection box
  const canvas = $('#canvas');
  let isDrawingSelBox = false;
  
  canvas.onmousedown = e => {
    if (e.target.closest('.widget') || e.target.closest('.canvas-tool-btn') || e.target.closest('.zoom-btn')) return;
    if (e.shiftKey) {
      isDrawingSelBox = true;
      startSelectionBox(e);
    }
  };
  
  canvas.onmousemove = e => {
    if (isDrawingSelBox) updateSelectionBox(e);
  };
  
  canvas.onmouseup = e => {
    if (isDrawingSelBox) {
      endSelectionBox();
      isDrawingSelBox = false;
    }
  };
  
  canvas.onclick = e => {
    if (e.target.closest('.widget') || e.target.closest('.canvas-tool-btn') || e.target.closest('.zoom-btn') || e.target.closest('.minimap')) return;
    if (state.selectedType) {
      saveUndoState();
      const rect = canvas.getBoundingClientRect();
      const z = Math.max(0.15, Number(state.buildZoom || 1));
      const logicalW = canvas.offsetWidth || (rect.width / z);
      const logicalH = canvas.offsetHeight || (rect.height / z);
      const [w, h] = SIZES[state.selectedType];
      let x = Math.max(0, Math.min((e.clientX - rect.left) / z - w/2, logicalW - w));
      let y = Math.max(0, Math.min((e.clientY - rect.top) / z - h/2, logicalH - h));
      if (state.gridSnap) { x = snapToGrid(x); y = snapToGrid(y); }
      const seed = { id: `${state.selectedType}${state.nextId++}`, t: state.selectedType, x, y, w, h, label: '' };
      if (state.selectedModel) seed.model = state.selectedModel;
      const base = applyWidgetDefaults(seed);
      state.widgets.push(base);
      renderWidgets();
      toast(tr('toast.widgetAdded', {icon: ICONS[state.selectedType]}), 'success');
    } else {
      state.selected = null;
      state.multiSelect = [];
      renderWidgets();
      renderPropsPanel();
    }
  };
  
  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return;
    // Build/editor shortcuts must never mutate the hidden project while the
    // user is driving in Play. Play owns its own view/control shortcuts.
    if (!document.querySelector('.builder-view.active')) return;
    
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    
    // Undo: Ctrl+Z
    if (ctrl && e.key === 'z' && !shift) { e.preventDefault(); undo(); return; }
    // Redo: Ctrl+Shift+Z or Ctrl+Y
    if ((ctrl && shift && e.key === 'z') || (ctrl && e.key === 'y')) { e.preventDefault(); redo(); return; }
    // Copy: Ctrl+C
    if (ctrl && e.key === 'c') { e.preventDefault(); copySelected(); return; }
    // Paste: Ctrl+V
    if (ctrl && e.key === 'v') { e.preventDefault(); pasteWidgets(); return; }
    // Duplicate: Ctrl+D
    if (ctrl && e.key === 'd') { e.preventDefault(); duplicateSelected(); return; }
    // Group: Ctrl+G
    if (ctrl && e.key === 'g') { e.preventDefault(); groupSelected(); return; }
    // Save template: Ctrl+S
    if (ctrl && e.key === 's') { e.preventDefault(); saveWidgetTemplate(); return; }
    // Toggle grid: G
    if (e.key === 'g' && !ctrl) { 
      state.gridSnap = !state.gridSnap;
      const btn = $('#gridToggle');
      if (btn) btn.classList.toggle('active', state.gridSnap);
      $('#canvas')?.classList.toggle('show-grid', state.gridSnap);
      toast(state.gridSnap ? '⊞ Grid ON' : '⊞ Grid OFF', 'success');
      return;
    }
    // Toggle layers: L
    if (e.key === 'l' && !ctrl) { toggleLayers(); return; }
    // Theme cycle: T
    if (e.key === 't' && !ctrl) { cycleTheme(); return; }
    // Delete: Delete or Backspace
    if (e.key === 'Delete' || e.key === 'Backspace') { 
      e.preventDefault(); 
      if (state.multiSelect.length) {
        saveUndoState();
        const deletingIds = new Set(state.multiSelect);
        state.widgets.filter(w => deletingIds.has(w.id) && w.t === 'group').forEach(g => detachGroup(g, state.widgets));
        state.widgets = state.widgets.filter(w => !deletingIds.has(w.id));
        state.multiSelect = [];
        state.selected = null;
        renderWidgets();
        renderPropsPanel();
        toast(tr('toast.deletedWidgets'), 'success');
      } else {
        deleteSelected(); 
      }
      return; 
    }
    // Select all: Ctrl+A
    if (ctrl && e.key === 'a') { 
      e.preventDefault(); 
      state.multiSelect = state.widgets.map(w => w.id);
      updateSelectionUI();
      toast(tr('toast.selectedAll', {n: state.widgets.length}), 'success');
      return; 
    }
    // Arrow keys: nudge
    const nudgeAmount = shift ? 10 : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeSelected(-nudgeAmount, 0); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(nudgeAmount, 0); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); nudgeSelected(0, -nudgeAmount); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); nudgeSelected(0, nudgeAmount); return; }
    // Escape: deselect
    if (e.key === 'Escape') {
      state.selected = null;
      state.multiSelect = [];
      state.selectedType = null;
      $$('.palette-item').forEach(p => p.classList.remove('selected'));
      updateSelectionUI();
      renderPropsPanel();
    }
    // Help: ?
    if (e.key === '?' || (shift && e.key === '/')) { showHelp(); return; }
  });
  
  // Buttons
  $('#soundBtn').onclick = () => { state.soundOn = !state.soundOn; updateSoundUI(); if (state.soundOn) beepClick(); };
  updateSoundUI();
  // The header pill toggles: connect when idle, disconnect when live.
  // It used to call connectBle() unconditionally, so clicking it while
  // connected re-opened the device picker instead of disconnecting —
  // there was no way to hang up from the app at all. (The red ✕ in the
  // runtime is #fullscreenExitBtn; it only leaves fullscreen and never
  // touches BLE, which is why the micro:bit kept showing ✓.)
  $('#bleBtn').onclick = toggleBle;
  $('#connectBtn').onclick = connectBle;
  $('#demoBtn').onclick = showDemo;
  
  // Back to Build button
  const backBtn = $('#backToBuildBtn');
  if (backBtn) backBtn.onclick = () => {
    // Exit arrange mode if active
    if (state.arrangeMode) {
      toggleArrangeMode();
    }
    switchTab('builder');
  };
  
  // Arrange mode button
  const arrangeBtn = $('#arrangeModeBtn');
  if (arrangeBtn) arrangeBtn.onclick = toggleArrangeMode;

  const reloadConfigBtn = $('#reloadConfigBtn');
  if (reloadConfigBtn) reloadConfigBtn.onclick = forceReloadRemoteConfig;
  
  // Auto-save on title change
  const titleInput = $('#titleInput');
  if (titleInput) {
    titleInput.addEventListener('input', scheduleAutoSave);
    titleInput.addEventListener('change', scheduleAutoSave);
  }
  
    // Templates
  $('#templateBtn').onclick = () => $('#templateModal').classList.remove('hidden');
  // Language on first load — defaults to French (matches bit-bot/talking-robot/
  // bit-playground) unless the user has already picked a language before.
  var savedLang = loadLang();
  setLang(savedLang || "fr");
  
  // Try to load saved project first; only show templates if nothing saved
  const hasProject = loadSavedProject();
  if (hasProject) {
    $('#templateModal').classList.add('hidden');
    renderWidgets();
    renderPropsPanel();
    toast(tr('toast.restoredProject'), 'success');
  } else {
    $('#templateModal').classList.remove('hidden');
  }
  
  var _ov=$('#loadingOverlay');
  if (_ov) _ov.onclick = () => { state._allowLoadingOverlay=false; hideLoading(); };
  if (typeof hideLoadOverlay==='function') hideLoadOverlay();
  $('#codeBtn').onclick = showCode;
  $('#deleteBtn').onclick = deleteSelected;
  $('#clearCacheBtn').onclick = () => {
    if(confirm('Clear all cached data (localStorage)? This will reset settings and saved layouts.')){
      try{ localStorage.clear(); }catch(e){}
      alert('Cache cleared. Reloading...');
      setTimeout(()=>location.reload(), 300);
    }
  };

  // JSON Export / Import + Language
  const jsonIn = $('#jsonFileInput');
  if (jsonIn){
    jsonIn.onchange = e => {
      const f = e.target.files && e.target.files[0];
      if (f) importLayoutJsonFile(f);
      e.target.value = '';
    };
  }
  const exp = $('#exportJsonBtn'); if (exp) exp.addEventListener('click', () => exportLayoutJson('build'));
  const expCfg = $('#exportMakeCodeCfgBtn'); if (expCfg) expCfg.addEventListener('click', () => exportMakeCodeCfg('build'));
  const rtExpJson = $('#runtimeExportJsonBtn'); if (rtExpJson) rtExpJson.addEventListener('click', () => exportLayoutJson('runtime'));
  const rtExpCfg = $('#runtimeExportMakeCodeBtn'); if (rtExpCfg) rtExpCfg.addEventListener('click', () => exportMakeCodeCfg('runtime'));
  const imp = $('#importJsonBtn'); if (imp) imp.addEventListener('click', () => $('#jsonFileInput').click());
  $('#modalClose').onclick = () => $('#modalBg').classList.remove('show');
  $('#modalBg').onclick = e => { if (e.target === $('#modalBg')) $('#modalBg').classList.remove('show'); };
  $('#copyBtn').onclick = () => { navigator.clipboard.writeText($('#modalCode').textContent); toast(tr('toast.copied'), 'success'); };
  $('#downloadBtn').onclick = downloadCode;
  
  // Flash button - Bluetooth flashing to micro:bit
  const flashBtn = $('#flashBtn');
  if (flashBtn) {
    flashBtn.onclick = flashToMicrobit;
    // Check if Web Bluetooth is supported
    if (!navigator.bluetooth) {
      flashBtn.title = 'Web Bluetooth not supported in this browser';
      flashBtn.style.opacity = '0.5';
    }
  }
  
  // Load saved theme
  try {
    const savedTheme = localStorage.getItem('app_theme');
    if (savedTheme && THEMES[savedTheme]) setTheme(savedTheme);
  } catch(e) {}
  
  // Load high contrast preference
  loadHighContrastPref();
  
  // Load widget templates from localStorage
  loadWidgetTemplates();
  
  // Check for URL layout parameter
  loadURLLayout();
  
  // === NEW FEATURES ===
  
  // Build toolbar buttons
  const undoBtn = $('#undoBtn');
  const redoBtn = $('#redoBtn');
  const autoArrangeBtn = $('#autoArrangeBtn');
  const magicBtn = $('#magicBtn');
  
  if (undoBtn) undoBtn.onclick = undo;
  if (redoBtn) redoBtn.onclick = redo;
  if (autoArrangeBtn) autoArrangeBtn.onclick = autoArrangeWidgets;
  if (magicBtn) magicBtn.onclick = magicStyleWidgets;
  
  // Theme dots
  $$('.theme-dot').forEach(dot => {
    dot.onclick = () => setTheme(dot.dataset.theme);
  });
  
  // Fullscreen buttons
  const fullscreenBtn = $('#fullscreenBtn');
  const fullscreenExitBtn = $('#fullscreenExitBtn');
  if (fullscreenBtn) fullscreenBtn.onclick = toggleFullscreen;
  if (fullscreenExitBtn) fullscreenExitBtn.onclick = toggleFullscreen;
  
  // Quick actions menu
  const quickMenu = $('#quickActionsMenu');
  if (quickMenu) {
    quickMenu.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.onclick = () => handleQuickAction(btn.dataset.action);
    });
  }
  
  // Long-press for quick actions on widgets
  let longPressTimer = null;
  document.addEventListener('pointerdown', e => {
    const widget = e.target.closest('.widget');
    if (!widget) return;
    longPressTimer = setTimeout(() => {
      showQuickActions(widget.dataset.id, e.clientX, e.clientY);
    }, 500);
  });
  document.addEventListener('pointerup', () => { clearTimeout(longPressTimer); });
  document.addEventListener('pointermove', () => { clearTimeout(longPressTimer); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.quick-actions-menu')) hideQuickActions();
  });
  
  // Tutorial
  const tutorialNextBtn = $('#tutorialNextBtn');
  const tutorialSkipBtn = $('#tutorialSkipBtn');
  if (tutorialNextBtn) tutorialNextBtn.onclick = nextTutorialStep;
  if (tutorialSkipBtn) tutorialSkipBtn.onclick = closeTutorial;
  
  // Show tutorial on first visit
  try {
    if (!localStorage.getItem('tutorial_done')) {
      setTimeout(showTutorial, 500);
    }
  } catch(e) {}
  
  // Setup shake detection and swipe gestures
  setupShakeDetection();
  setupSwipeGestures();
  
  // Update toolbar state
  updateBuildToolbar();
}

// === CELEBRATION ANIMATION ===
function celebrate(message = '🎉 Connected!') {
  const overlay = document.createElement('div');
  overlay.className = 'celebration-overlay';
  
  // Create confetti
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#00e676', '#ff9100'];
  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.left = Math.random() * 100 + '%';
    confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
    confetti.style.animationDelay = Math.random() * 0.5 + 's';
    confetti.style.transform = `rotate(${Math.random() * 360}deg)`;
    overlay.appendChild(confetti);
  }
  
  // Create text
  const text = document.createElement('div');
  text.className = 'celebration-text';
  text.textContent = message;
  overlay.appendChild(text);
  
  document.body.appendChild(overlay);
  
  // Play celebration sound
  if (state.soundOn) {
    beep(523, 0.1, 0.06); // C
    setTimeout(() => beep(659, 0.1, 0.06), 100); // E
    setTimeout(() => beep(784, 0.15, 0.06), 200); // G
    setTimeout(() => beep(1047, 0.2, 0.08), 300); // High C
  }
  
  // Remove after animation
  setTimeout(() => overlay.remove(), 3000);
}

// === FULLSCREEN MODE ===
function toggleFullscreen() {
  const btn = $('#fullscreenBtn');
  const exitBtn = $('#fullscreenExitBtn');
  const grid = $('#runtimeGrid');
  const isFullscreen = document.body.classList.contains('runtime-fullscreen');
  
  if (isFullscreen) {
    // Exit fullscreen
    document.body.classList.remove('runtime-fullscreen');
    if (btn) {
      const t = I18N[state.lang] || I18N.en;
      btn.textContent = t.fullscreen || '⛶ Fullscreen';
      btn.classList.add('visible');
      btn.style.display = '';
      btn.setAttribute('aria-pressed', 'false');
      btn.title = t.fullscreen || 'Fullscreen';
    }
    
    // Keep the Play viewport geometry intact. The old code cleared the grid
    // transform here, which broke the explicit v2.12 frame until another
    // zoom click. Re-fit after the browser leaves fullscreen instead.
    setTimeout(() => {
      try { window.appZoom?.zoomFit?.(); } catch (e) {}
    }, 80);
    
    // Exit native fullscreen API
    if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      }
    }
  } else {
    // Enter fullscreen
    document.body.classList.add('runtime-fullscreen');
    if (btn) {
      const t = I18N[state.lang] || I18N.en;
      btn.textContent = t.fullscreenExit || '⛶ Exit Fullscreen';
      btn.classList.add('visible');
      btn.style.display = '';
      btn.setAttribute('aria-pressed', 'true');
      btn.title = t.fullscreenExit || 'Exit Fullscreen';
    }
    
    // Request native fullscreen API
    const elem = document.documentElement;
    if (elem.requestFullscreen) {
      elem.requestFullscreen().catch(() => {});
    } else if (elem.webkitRequestFullscreen) {
      elem.webkitRequestFullscreen();
    } else if (elem.mozRequestFullScreen) {
      elem.mozRequestFullScreen();
    }
    
    // Apply zoom to fit
    setTimeout(() => {
      zoomToFitScreen();
    }, 150);
  }
}

// Exit fullscreen on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('runtime-fullscreen')) {
    toggleFullscreen();
  }
});

// Handle native fullscreen API changes (e.g., ESC key pressed)
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('runtime-fullscreen')) {
    toggleFullscreen();
  } else if (document.fullscreenElement && document.body.classList.contains('runtime-fullscreen')) {
    requestAnimationFrame(() => { try { window.appZoom?.zoomFit?.(); } catch (_) {} });
  }
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement && document.body.classList.contains('runtime-fullscreen')) {
    toggleFullscreen();
  }
});
document.addEventListener('mozfullscreenchange', () => {
  if (!document.mozFullScreenElement && document.body.classList.contains('runtime-fullscreen')) {
    toggleFullscreen();
  }
});

// === AUTO ARRANGE WIDGETS ===
function autoArrangeWidgets() {
  if (!state.widgets.length) {
    toast(tr('toast.nothingToArrange'), 'error');
    return;
  }
  
  saveUndoState();
  
  // 40px (not 15px) so glow/box-shadow effects (LED pulse, neon slider/joystick,
  // pressed-button glow — some reach 80-120px blur radius) have room to fade
  // before reaching the neighboring widget instead of visually bleeding onto it.
  const padding = 40;
  const canvas = $('#canvas');
  const canvasW = canvas?.offsetWidth || 500;
  
  // Arrange only top-level items. Group members keep their positions relative
  // to the group frame and move with it as one functional section.
  const sorted = [...layoutRootWidgets(state.widgets)].sort((a, b) => (b.w * b.h) - (a.w * a.h));
  
  let currentX = padding;
  let currentY = padding;
  let rowHeight = 0;
  
  sorted.forEach(w => {
    // Check if widget fits in current row
    if (currentX + w.w + padding > canvasW) {
      // Move to next row
      currentX = padding;
      currentY += rowHeight + padding;
      rowHeight = 0;
    }
    
    moveWidgetKeepingGroup(w, currentX, currentY, state.widgets, '.widget');
    currentX += w.w + padding;
    rowHeight = Math.max(rowHeight, w.h);
  });
  
  renderWidgets();
  toast(tr('toast.widgetsArranged'), 'success');
  if (state.soundOn) beepClick();
}

// === THEME SELECTOR ===
function showThemeSelector() {
  // Remove existing selector
  const existing = document.querySelector('.theme-modal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.className = 'modal-bg show theme-modal';
  modal.innerHTML = `
    <div class="modal" style="max-width: 400px;">
      <div class="modal-title">🎨 Choose Theme</div>
      <div class="theme-selector">
        <div class="theme-chip dark ${state.theme === 'dark' ? 'active' : ''}" data-theme="dark">🌙 Dark</div>
        <div class="theme-chip ocean ${state.theme === 'ocean' ? 'active' : ''}" data-theme="ocean">🌊 Ocean</div>
        <div class="theme-chip space ${state.theme === 'space' ? 'active' : ''}" data-theme="space">🚀 Space</div>
        <div class="theme-chip candy ${state.theme === 'candy' ? 'active' : ''}" data-theme="candy">🍬 Candy</div>
        <div class="theme-chip forest ${state.theme === 'forest' ? 'active' : ''}" data-theme="forest">🌲 Forest</div>
        <div class="theme-chip sunset ${state.theme === 'sunset' ? 'active' : ''}" data-theme="sunset">🌅 Sunset</div>
      </div>
      <div style="margin-top: 16px;">
        <button class="modal-btn secondary" onclick="this.closest('.modal-bg').remove()">✕ Close</button>
      </div>
    </div>
  `;
  
  modal.querySelectorAll('.theme-chip').forEach(chip => {
    chip.onclick = () => {
      const theme = chip.dataset.theme;
      setAppTheme(theme);
      modal.querySelectorAll('.theme-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      if (state.soundOn) beepClick();
    };
  });
  
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

function setAppTheme(theme) {
  // Remove all theme classes
  document.body.classList.remove('theme-dark', 'theme-ocean', 'theme-space', 'theme-candy', 'theme-forest', 'theme-sunset', 'theme-light', 'theme-neon', 'theme-nature');
  
  if (theme && theme !== 'dark') {
    document.body.classList.add('theme-' + theme);
  }
  
  state.theme = theme;
  try { localStorage.setItem('app_theme', theme); } catch(e) {}
  const themeName = tr('themeNames.' + theme) || (theme.charAt(0).toUpperCase() + theme.slice(1));
  toast(tr('toast.themeChanged', {theme: themeName}), 'success');
}

// Load saved theme on startup
try {
  const savedTheme = localStorage.getItem('app_theme');
  if (savedTheme) setAppTheme(savedTheme);
} catch(e) {}

// === SHARE VIA QR CODE ===
function showShareQR() {
  const titleEl = $('#titleInput');
  const data = {
    title: titleEl?.value || 'My Remote',
    widgets: state.widgets
  };
  
  // Create simple URL-safe layout string
  const layoutStr = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  const url = location.origin + location.pathname + '?layout=' + layoutStr;
  
  // Create QR modal
  const modal = document.createElement('div');
  modal.className = 'modal-bg show';
  modal.innerHTML = `
    <div class="modal qr-modal" style="max-width: 350px;">
      <div class="modal-title">📱 Share Your Remote</div>
      <div class="qr-code-container">
        <canvas id="qrCanvas"></canvas>
      </div>
      <p style="color: var(--text-dim); font-size: 0.85rem; margin-bottom: 16px;">Scan this code to load your layout!</p>
      <div class="modal-buttons">
        <button class="modal-btn primary" onclick="navigator.clipboard.writeText('${url}'); toast('📋 Link copied!', 'success');">📋 Copy Link</button>
        <button class="modal-btn secondary" onclick="this.closest('.modal-bg').remove()">✕ Close</button>
      </div>
    </div>
  `;
  
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  
  // Generate QR code
  generateQRCode('qrCanvas', url);
}

// Simple QR code generator (basic version)
function generateQRCode(canvasId, text) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const size = 200;
  canvas.width = size;
  canvas.height = size;
  
  // Simple placeholder - in production you'd use a QR library
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  
  ctx.fillStyle = '#000';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('QR Code', size/2, size/2 - 20);
  ctx.font = '11px sans-serif';
  ctx.fillText('(Add qrcode.js library', size/2, size/2 + 10);
  ctx.fillText('for real QR codes)', size/2, size/2 + 25);
  
  // Draw simple pattern to indicate it's a QR placeholder
  ctx.fillStyle = '#000';
  const patternSize = 30;
  // Top-left corner
  ctx.fillRect(10, 10, patternSize, patternSize);
  ctx.fillStyle = '#fff';
  ctx.fillRect(15, 15, patternSize - 10, patternSize - 10);
  ctx.fillStyle = '#000';
  ctx.fillRect(20, 20, patternSize - 20, patternSize - 20);
  
  // Top-right corner
  ctx.fillStyle = '#000';
  ctx.fillRect(size - 10 - patternSize, 10, patternSize, patternSize);
  ctx.fillStyle = '#fff';
  ctx.fillRect(size - 15 - patternSize + 5, 15, patternSize - 10, patternSize - 10);
  ctx.fillStyle = '#000';
  ctx.fillRect(size - 20 - patternSize + 10, 20, patternSize - 20, patternSize - 20);
  
  // Bottom-left corner
  ctx.fillStyle = '#000';
  ctx.fillRect(10, size - 10 - patternSize, patternSize, patternSize);
  ctx.fillStyle = '#fff';
  ctx.fillRect(15, size - 15 - patternSize + 5, patternSize - 10, patternSize - 10);
  ctx.fillStyle = '#000';
  ctx.fillRect(20, size - 20 - patternSize + 10, patternSize - 20, patternSize - 20);
}

// === SCREENSHOT ===
function takeScreenshot() {
  const canvas = $('#canvas') || $('#runtimeGrid');
  if (!canvas) {
    toast('Nothing to capture!', 'error');
    return;
  }
  
  // Use html2canvas if available
  if (typeof html2canvas !== 'undefined') {
    html2canvas(canvas).then(c => {
      const link = document.createElement('a');
      link.download = 'my-remote.png';
      link.href = c.toDataURL();
      link.click();
      toast('📸 Screenshot saved!', 'success');
    }).catch(() => toast('Screenshot failed', 'error'));
  } else {
    toast('📸 Screenshot requires html2canvas library', 'error');
  }
}

// === LONG PRESS QUICK ACTIONS ===
function setupLongPressActions() {
  let longPressTimer = null;
  let longPressTarget = null;
  
  const showQuickMenu = (widget, x, y) => {
    // Remove existing menu
    document.querySelectorAll('.quick-action-menu').forEach(m => m.remove());
    
    const menu = document.createElement('div');
    menu.className = 'quick-action-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.innerHTML = `
      <button class="quick-action-btn" data-action="duplicate" title="Duplicate">📋</button>
      <button class="quick-action-btn" data-action="color" title="Change color">🎨</button>
      <button class="quick-action-btn" data-action="lock" title="Lock/Unlock">🔒</button>
      <button class="quick-action-btn" data-action="front" title="Bring to front">⬆️</button>
      <button class="quick-action-btn" data-action="back" title="Send to back">⬇️</button>
      <button class="quick-action-btn danger" data-action="delete" title="Delete">🗑️</button>
    `;
    
    menu.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const w = state.widgets.find(w => w.id === widget.dataset.id);
        
        if (action === 'duplicate') {
          duplicateWidget(w);
        } else if (action === 'color') {
          randomizeWidgetColor(w);
        } else if (action === 'lock') {
          w.locked = !w.locked;
          toast(w.locked ? tr('toast.locked') : tr('toast.unlocked'), 'success');
          renderWidgets();
        } else if (action === 'front') {
          bringToFront(w);
        } else if (action === 'back') {
          sendToBack(w);
        } else if (action === 'delete') {
          saveUndoState();
          state.widgets = state.widgets.filter(x => x.id !== w.id);
          state.selected = null;
          renderWidgets();
          renderPropsPanel();
          toast(tr('toast.deleted'), 'success');
        }
        
        menu.remove();
        if (state.soundOn) beepClick();
      };
    });
    
    document.body.appendChild(menu);
    
    // Close menu on click elsewhere
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 10);
  };
  
  document.addEventListener('pointerdown', e => {
    const widget = e.target.closest('.widget');
    if (!widget) return;
    
    longPressTarget = widget;
    longPressTimer = setTimeout(() => {
      // Vibrate if supported
      if (navigator.vibrate) navigator.vibrate(50);
      showQuickMenu(widget, e.clientX, e.clientY);
    }, 500);
  });
  
  document.addEventListener('pointerup', () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });
  
  document.addEventListener('pointermove', e => {
    if (longPressTimer && longPressTarget) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });
}

function duplicateWidget(w) {
  if (!w) return;
  saveUndoState();
  const newW = { ...w, id: `${w.t}${state.nextId++}`, x: w.x + 20, y: w.y + 20 };
  if (newW.t === 'group') newW.children = [];
  delete newW.groupId;
  state.widgets.push(newW);
  state.selected = newW.id;
  renderWidgets();
  toast(tr('toast.duplicated'), 'success');
}

function randomizeWidgetColor(w) {
  if (!w) return;
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#00e676', '#ff9100', '#b388ff'];
  w.color = colors[Math.floor(Math.random() * colors.length)];
  renderWidgets();
  renderPropsPanel();
  toast(tr('toast.newColor'), 'success');
}

function bringToFront(w) {
  if (!w) return;
  const idx = state.widgets.findIndex(x => x.id === w.id);
  if (idx >= 0) {
    state.widgets.splice(idx, 1);
    state.widgets.push(w);
    renderWidgets();
    toast(tr('toast.broughtFront'), 'success');
  }
}

function sendToBack(w) {
  if (!w) return;
  const idx = state.widgets.findIndex(x => x.id === w.id);
  if (idx >= 0) {
    state.widgets.splice(idx, 1);
    state.widgets.unshift(w);
    renderWidgets();
    toast(tr('toast.sentBack'), 'success');
  }
}

// === UPDATE BUILD TOOLBAR STATE ===
function updateBuildToolbar() {
  const undoBtn = $('#undoBtn');
  const redoBtn = $('#redoBtn');
  
  if (undoBtn) undoBtn.disabled = !state.undoStack.length;
  if (redoBtn) redoBtn.disabled = !state.redoStack.length;
}

// === HAPTIC FEEDBACK ===
function vibrate(pattern = 10) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// === PARTICLE EFFECTS ON BUTTON PRESS ===
function createParticles(x, y, count = 8) {
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff'];
  
  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';
    const size = 4 + Math.random() * 8;
    const angle = (Math.PI * 2 / count) * i;
    const distance = 20 + Math.random() * 30;
    
    particle.style.width = size + 'px';
    particle.style.height = size + 'px';
    particle.style.background = colors[Math.floor(Math.random() * colors.length)];
    particle.style.left = x + 'px';
    particle.style.top = y + 'px';
    particle.style.transform = `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px)`;
    
    document.body.appendChild(particle);
    setTimeout(() => particle.remove(), 600);
  }
}

function selectTemplate(name) {
  const t = templates[name];
  if (!t) return;

  // Kids-friendly loading overlay while building a template
  if (typeof showLoadOverlay === 'function') {
    const titles = {
      gamepad: '🎮 Building Game Pad...',
      robot: '🤖 Building Robot Remote...',
      mixer: '🎵 Building DJ Mixer...',
      racing: '🏎️ Building Race Car...',
      lights: '💡 Building Lights Panel...',
      blank: '✨ Preparing Blank Canvas...'
    };
    showBuildOverlay(titles[name] || '✨ Building...');
  }

  // Small delay so the overlay is visible and feels animated
  setTimeout(() => {
    try { saveUndoState(); } catch (_) {}
    state.widgets = t.map((w, i) => ({ id: `${w.t}${state.nextId + i}`, ...w }));
    state.nextId += t.length || 1;
    // A template is a new design. Do not inherit an oversized logical canvas
    // or a stale Play snapshot from the previous project.
    state.buildCanvasSize = null;
    state.config = null;
    state.runtimeCanvasSize = null;
    state.runtimeSource = null;

    // Apply defaults for new widget types / models
    if (typeof applyWidgetDefaults === 'function') {
      state.widgets.forEach(applyWidgetDefaults);
    }

    state.selected = null;
    $('#templateModal').classList.add('hidden');
    renderWidgets();
    renderPropsPanel();

    if (typeof hideLoadOverlay === 'function') hideLoadOverlay();

    if (name === 'blank') toast(tr('toast.canvasReady'), 'success');
    else toast(tr('toast.templateLoaded'), 'success');
  }, 250);
}

// (Duplicate definitions of toggleFullscreen and celebrate were removed —
// originals live above at the FULLSCREEN MODE / CELEBRATION sections.)

// === QUICK ACTIONS MENU ===
function showQuickActions(widgetId, x, y) {
  const menu = $('#quickActionsMenu');
  if (!menu) return;
  
  state._quickActionTarget = widgetId;
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 250) + 'px';
  menu.classList.add('show');
  
  if (navigator.vibrate) navigator.vibrate(30);
}

function hideQuickActions() {
  const menu = $('#quickActionsMenu');
  if (menu) menu.classList.remove('show');
}

function handleQuickAction(action) {
  const w = state.widgets.find(w => w.id === state._quickActionTarget);
  if (!w) return;
  
  switch(action) {
    case 'duplicate':
      saveUndoState();
      const newW = { ...w, id: `${w.t}${state.nextId++}`, x: w.x + 20, y: w.y + 20 };
      if (newW.t === 'group') newW.children = [];
      delete newW.groupId;
      state.widgets.push(newW);
      state.selected = newW.id;
      renderWidgets();
      toast(tr('toast.duplicated'), 'success');
      break;
    case 'color':
      const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#00e676', '#ff9100', '#b388ff'];
      w.color = colors[Math.floor(Math.random() * colors.length)];
      renderWidgets();
      toast(tr('toast.newColor'), 'success');
      break;
    case 'lock':
      w.locked = !w.locked;
      renderWidgets();
      toast(w.locked ? tr('toast.locked') : tr('toast.unlocked'), 'success');
      break;
    case 'front':
      const idx = state.widgets.indexOf(w);
      state.widgets.splice(idx, 1);
      state.widgets.push(w);
      renderWidgets();
      toast(tr('toast.broughtFront'), 'success');
      break;
    case 'back':
      const idx2 = state.widgets.indexOf(w);
      state.widgets.splice(idx2, 1);
      state.widgets.unshift(w);
      renderWidgets();
      toast(tr('toast.sentBack'), 'success');
      break;
    case 'delete':
      saveUndoState();
      if (w.t === 'group') detachGroup(w, state.widgets);
      state.widgets = state.widgets.filter(x => x.id !== w.id);
      state.selected = null;
      renderWidgets();
      renderPropsPanel();
      toast(tr('toast.deleted'), 'success');
      break;
  }
  
  hideQuickActions();
  if (state.soundOn) beepClick();
}

// === TUTORIAL ===
const tutorialIcons = ['👋', '👆', '📱', '🔗'];
let tutorialStep = 0;

function showTutorial() {
  tutorialStep = 0;
  updateTutorialStep();
  $('#tutorialOverlay')?.classList.remove('hidden');
}

function updateTutorialStep() {
  if (!$('#tutorialOverlay')) return;
  const steps = tr('tutorial.steps');
  const step = steps && steps[tutorialStep];
  if (!step) {
    closeTutorial();
    return;
  }

  $('#tutorialIcon').textContent = tutorialIcons[tutorialStep] || '👋';
  $('#tutorialTitle').textContent = step.title;
  $('#tutorialText').textContent = step.text;

  const btn = $('#tutorialNextBtn');
  btn.textContent = tutorialStep === steps.length - 1 ? tr('tutorial.start') : tr('tutorial.next');

  $$('.tutorial-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === tutorialStep);
  });
}

function nextTutorialStep() {
  tutorialStep++;
  const steps = tr('tutorial.steps');
  if (tutorialStep >= steps.length) {
    closeTutorial();
  } else {
    updateTutorialStep();
  }
  if (state.soundOn) beepClick();
}

function closeTutorial() {
  $('#tutorialOverlay')?.classList.add('hidden');
  try { localStorage.setItem('tutorial_done', '1'); } catch(e) {}
}

// === THEME SWITCHING ===
function setTheme(theme) {
  document.body.classList.remove('theme-dark', 'theme-ocean', 'theme-space', 'theme-candy', 'theme-forest', 'theme-neon');
  if (theme !== 'dark') {
    document.body.classList.add('theme-' + theme);
  }
  state.theme = theme;
  
  $$('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.theme === theme));
  
  try { localStorage.setItem('app_theme', theme); } catch(e) {}
  const themeName = tr('themeNames.' + theme) || (theme.charAt(0).toUpperCase() + theme.slice(1));
  toast(tr('toast.themeChanged', {theme: themeName}), 'success');
  if (state.soundOn) beepClick();
}

// (Duplicate definition of autoArrangeWidgets removed — see earlier definition.)

// === MAGIC WAND - Random Style All Widgets ===
function magicStyleWidgets() {
  if (!state.widgets.length) {
    toast('Add some widgets first!', 'error');
    return;
  }
  
  saveUndoState();
  
  const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#54a0ff', '#00e676', '#ff9100', '#b388ff', '#00d4ff'];
  const models = {
    button: ['neo', 'glass', 'pill', 'flat'],
    slider: ['track', 'neon', 'min'],
    toggle: ['square', 'pill', 'icon'],
    joystick: ['classic', 'ring', 'min'],
    gauge: ['classic', 'neon', 'minimal'],
    led: ['dot', 'ring', 'bar']
  };
  
  state.widgets.forEach(w => {
    w.color = colors[Math.floor(Math.random() * colors.length)];
    if (models[w.t]) {
      w.model = models[w.t][Math.floor(Math.random() * models[w.t].length)];
    }
  });
  
  renderWidgets();
  renderPropsPanel();
  
  // Fun particle explosion
  const canvas = $('#canvas');
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    createParticles(rect.left + rect.width/2, rect.top + rect.height/2, 20);
  }
  
  toast('🪄 Magic applied!', 'success');
  if (state.soundOn) {
    beep(440, 0.1, 0.05);
    setTimeout(() => beep(554, 0.1, 0.05), 80);
    setTimeout(() => beep(659, 0.1, 0.05), 160);
    setTimeout(() => beep(880, 0.15, 0.05), 240);
  }
}

// === SHAKE TO RANDOMIZE ===
let lastShakeTime = 0;
function setupShakeDetection() {
  if (!window.DeviceMotionEvent) return;
  
  let shakeThreshold = 15;
  let lastX = 0, lastY = 0, lastZ = 0;
  
  window.addEventListener('devicemotion', (e) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;
    
    const deltaX = Math.abs(acc.x - lastX);
    const deltaY = Math.abs(acc.y - lastY);
    const deltaZ = Math.abs(acc.z - lastZ);
    
    if ((deltaX > shakeThreshold || deltaY > shakeThreshold || deltaZ > shakeThreshold)) {
      const now = Date.now();
      if (now - lastShakeTime > 1000) { // Debounce 1 second
        lastShakeTime = now;
        onShake();
      }
    }
    
    lastX = acc.x;
    lastY = acc.y;
    lastZ = acc.z;
  });
}

function onShake() {
  // Shake is an editor toy, not a runtime command. Never restyle/mutate the
  // hidden Build project while Play is active.
  if (!document.querySelector('.builder-view.active')) return;
  if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
  magicStyleWidgets();
}

// === SWIPE GESTURES ===
function setupSwipeGestures() {
  let touchStartY = 0;
  let touchStartX = 0;
  let touchStartedOnControl = false;
  
  document.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    // A vertical slider/joystick gesture must never be mistaken for the old
    // swipe-to-fullscreen shortcut. Only empty Play background can swipe.
    touchStartedOnControl = !!e.target.closest?.('.rt-widget, button, input, select, textarea, .play-view-controls, .runtime-top-btns');
  }, { passive: true });
  
  document.addEventListener('touchend', e => {
    if (touchStartedOnControl || state.arrangeMode) { touchStartedOnControl = false; return; }
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;
    
    // Only trigger if swipe is significant and more vertical than horizontal
    if (Math.abs(deltaY) > 100 && Math.abs(deltaY) > Math.abs(deltaX)) {
      const runtimeView = $('.runtime-view.active');
      if (runtimeView) {
        if (deltaY < -100) { // Swipe up
          if (!document.body.classList.contains('runtime-fullscreen')) {
            toggleFullscreen();
          }
        } else if (deltaY > 100) { // Swipe down
          if (document.body.classList.contains('runtime-fullscreen')) {
            toggleFullscreen();
          }
        }
      }
    }
    touchStartedOnControl = false;
  }, { passive: true });
}

function switchTab(tab, opts = {}) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.remove('active'));
  
  const builderView = $('.builder-view');
  const runtimeView = $('.runtime-view');
  const fullscreenBtn = $('#fullscreenBtn');
  
  if (tab === 'builder') {
    builderView.classList.add('active');
    document.getElementById('playViewControls')?.classList.remove('visible');
    runtimeView.classList.remove('active');
    stopDemoSim();
    // Leaving Play is also a safety boundary: stop any held manual D-pad
    // state and remove document-level joystick/XY/timer bindings.
    clearAllDpadKeepalives(true);
    cleanupRuntimeBindings();
    
    // Hide fullscreen button
    if (fullscreenBtn) fullscreenBtn.classList.remove('visible');
    
    // Exit fullscreen mode if active
    if (document.body.classList.contains('runtime-fullscreen')) {
      document.body.classList.remove('runtime-fullscreen');
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
    
    // Exit arrange mode when switching to build
    if (state.arrangeMode) {
      // Finish Arrange through the same path as the Done button so document-
      // level drag/resize listeners are always removed and geometry is synced once.
      try { toggleArrangeMode(); } catch (e) {
        state.arrangeMode = false;
        try { teardownArrangeMode(); } catch (_) {}
      }
    }

    // v2.4: returning to Build is a pure view transition. Re-render from the
    // authoritative Build model, then re-apply the editor zoom. No Tidy, no
    // overlap resolution, no coordinate normalization.
    try { renderWidgets(); } catch(e) {}
    requestAnimationFrame(() => {
      try { applyBuildCanvasView(); updateBuildCanvasBadge(); } catch(e) {}
    });
  } else {
    // Runtime tab
    builderView.classList.remove('active');
    runtimeView.classList.add('active');
    
    // IMPORTANT: Build config from current widgets and render before starting demo.
    // Skipped when we just loaded a live config from a connected device (see the
    // CFGEND handler in processLine()) — otherwise this clobbers the device's config
    // with whatever's sitting in the Build tab's canvas.
    if (!opts.skipConfigRebuild) {
      if (state.ble.connected) {
        if (state.deviceConfig?.widgets?.length) {
          // While BLE is live, Play must represent the firmware we are actually
          // controlling. A local Build draft may have different IDs/properties and
          // must not silently replace the device CFG merely because the tab changed.
          state.config = cloneSerializable(state.deviceConfig);
          state.runtimeSource = 'device';
          state.runtimeCanvasSize = state.config.canvas?.w && state.config.canvas?.h
            ? { w:Number(state.config.canvas.w), h:Number(state.config.canvas.h) }
            : null;
          renderRuntime();
        } else {
          // Connected but CFG is not verified yet. Showing the Build preview here
          // would create live controls with potentially wrong firmware IDs.
          cleanupRuntimeBindings();
          state.config = null;
          state.runtimeCanvasSize = null;
          state.runtimeSource = null;
        }
      } else if (state.widgets && state.widgets.length > 0) {
        // Disconnected Play is a preview snapshot of Build, never shared references.
        state.config = {
          title: $('#titleInput')?.value || 'My Remote',
          widgets: cloneSerializable(state.widgets),
          canvas: getBuildCanvasSizeForExport()
        };
        state.runtimeCanvasSize = null;
        state.runtimeSource = 'build';
        renderRuntime();
      }
    }
    
    // renderRuntime() seeds the frame from the stored Play zoom. If a controller
    // is available below, the queued Fit becomes the first authoritative view
    // operation; avoid a competing setZoom() RAF that could overwrite/cancel it.
    startDemoSim();

    // Play is a normal view transition. Fullscreen is always an explicit user
    // action; entering Play must never unexpectedly hide browser/app chrome.
    if (state.config && state.config.widgets && state.config.widgets.length > 0) {
      $('#connectPrompt').style.display = 'none';
      $('#runtimeContent').style.display = 'flex';
      const arrangeBtn = $('#arrangeModeBtn');
      if (arrangeBtn) arrangeBtn.classList.add('visible');
      if (fullscreenBtn) fullscreenBtn.classList.add('visible');
      document.getElementById('playViewControls')?.classList.add('visible');
      const fitToken = ++state.playViewRequestToken;
      requestAnimationFrame(() => {
        if (state.playViewRequestToken !== fitToken) return;
        try { window.appZoom?.zoomFit?.(); } catch (e) {}
      });
    }
    // Otherwise show connect prompt for kids
    else {
      $('#connectPrompt').style.display = 'block';
      $('#runtimeContent').style.display = 'none';
      const arrangeBtn = $('#arrangeModeBtn');
      if (arrangeBtn) arrangeBtn.classList.remove('visible');
      if (fullscreenBtn) fullscreenBtn.classList.remove('visible');
      document.getElementById('playViewControls')?.classList.remove('visible');
    }
  }
}

// Auto-enter fullscreen and zoom to fit the runtime grid
function enterFullscreenAndFit() {
  const btn = $('#fullscreenBtn');
  const exitBtn = $('#fullscreenExitBtn');
  const grid = $('#runtimeGrid');
  
  if (!grid) return;
  
  // Enter fullscreen mode. Keep the toolbar control visible so it can be
  // used to exit without covering or hiding the other Play controls.
  document.body.classList.add('runtime-fullscreen');
  if (btn) {
    const t = I18N[state.lang] || I18N.en;
    btn.textContent = t.fullscreenExit || '⛶ Exit Fullscreen';
    btn.classList.add('visible');
    btn.style.display = '';
    btn.setAttribute('aria-pressed', 'true');
  }
  
  // Request native fullscreen API
  const elem = document.documentElement;
  if (elem.requestFullscreen) {
    elem.requestFullscreen().catch(() => {});
  } else if (elem.webkitRequestFullscreen) {
    elem.webkitRequestFullscreen();
  } else if (elem.mozRequestFullScreen) {
    elem.mozRequestFullScreen();
  }
  
  // Calculate and apply zoom to fit
  setTimeout(() => {
    zoomToFitScreen();
  }, 150);
}

// Calculate zoom to make runtime grid fill the screen
function zoomToFitScreen() {
  // v2.9: use the same layout-aware Fit path as the Play toolbar so native
  // fullscreen and normal Play cannot disagree about scale or centering.
  if (window.appZoom && typeof window.appZoom.zoomFit === 'function') {
    window.appZoom.zoomFit();
    return;
  }
  const grid = $('#runtimeGrid');
  if (!grid) return;
  grid.style.transform = 'none';
  grid.style.zoom = '1';
}

// Exact-layout policy: Build never performs implicit collision resolution.
// Overlap handling is intentionally left to the explicit Tidy command.

// Undo/Redo system
// v2.11 snapshots include the logical canvas as well as widgets, so Trim Canvas
// is fully undoable. Older snapshots that contain only the widget array remain
// readable for compatibility.
function makeUndoSnapshot() {
  return JSON.stringify({
    v: 2,
    widgets: state.widgets,
    canvas: state.buildCanvasSize ? { w:Number(state.buildCanvasSize.w), h:Number(state.buildCanvasSize.h) } : null
  });
}

function restoreUndoSnapshot(snapshot) {
  const parsed = JSON.parse(snapshot);
  if (Array.isArray(parsed)) {
    state.widgets = parsed;
  } else {
    state.widgets = Array.isArray(parsed?.widgets) ? parsed.widgets : [];
    state.buildCanvasSize = parsed?.canvas?.w && parsed?.canvas?.h
      ? { w:Math.round(Number(parsed.canvas.w)), h:Math.round(Number(parsed.canvas.h)) }
      : null;
  }
  state.config = null;
  state.runtimeCanvasSize = null;
}

function saveUndoState() {
  const snapshot = makeUndoSnapshot();
  if (state.undoStack.length && state.undoStack[state.undoStack.length-1] === snapshot) return;
  state.undoStack.push(snapshot);
  if (state.undoStack.length > state.maxUndo) state.undoStack.shift();
  state.redoStack = [];
}

function undo() {
  if (state.undoStack.length < 2) { toast(tr('toast.nothingToUndo'), 'error'); return; }
  state.redoStack.push(state.undoStack.pop());
  restoreUndoSnapshot(state.undoStack[state.undoStack.length-1]);
  state.selected = null;
  state.multiSelect = [];
  renderWidgets();
  applyBuildCanvasView();
  renderPropsPanel();
  toast(tr('toast.undoDone'), 'success');
}

function redo() {
  if (!state.redoStack.length) { toast(tr('toast.nothingToRedo'), 'error'); return; }
  const snapshot = state.redoStack.pop();
  state.undoStack.push(snapshot);
  restoreUndoSnapshot(snapshot);
  state.selected = null;
  state.multiSelect = [];
  renderWidgets();
  applyBuildCanvasView();
  renderPropsPanel();
  toast(tr('toast.redoDone'), 'success');
}

// Copy/Paste/Duplicate
function copySelected() {
  const ids = state.multiSelect.length ? state.multiSelect : (state.selected ? [state.selected] : []);
  if (!ids.length) { toast('Select widgets first', 'error'); return; }
  state.clipboard = state.widgets.filter(w => ids.includes(w.id)).map(w => ({...w}));
  toast(`📋 Copied ${state.clipboard.length} widget(s)`, 'success');
}

function pasteWidgets() {
  if (!state.clipboard.length) { toast('Nothing to paste', 'error'); return; }
  saveUndoState();
  const offset = 20;
  state.clipboard.forEach(w => {
    const newW = {...w, id: `${w.t}${state.nextId++}`, x: w.x + offset, y: w.y + offset};
    if (newW.t === 'group') newW.children = [];
    delete newW.groupId;
    state.widgets.push(newW);
  });
  renderWidgets();
  toast(`📋 Pasted ${state.clipboard.length} widget(s)`, 'success');
  saveUndoState();
}

function duplicateSelected() {
  const ids = state.multiSelect.length ? state.multiSelect : (state.selected ? [state.selected] : []);
  if (!ids.length) { toast('Select widgets first', 'error'); return; }
  saveUndoState();
  const toDupe = state.widgets.filter(w => ids.includes(w.id));
  toDupe.forEach(w => {
    const newW = {...w, id: `${w.t}${state.nextId++}`, x: w.x + 20, y: w.y + 20};
    if (newW.t === 'group') newW.children = [];
    delete newW.groupId;
    state.widgets.push(newW);
  });
  renderWidgets();
  toast(`✨ Duplicated ${toDupe.length} widget(s)`, 'success');
  saveUndoState();
}

// === SMART LAYOUT FUNCTIONS ===

// Auto-arrange in grid
function autoArrangeGrid() {
  if (!state.widgets.length) return;
  saveUndoState();
  const roots = layoutRootWidgets(state.widgets);
  const cols = Math.ceil(Math.sqrt(roots.length));
  const gap = 10;
  let maxW = 0, maxH = 0;
  roots.forEach(w => { maxW = Math.max(maxW, w.w); maxH = Math.max(maxH, w.h); });
  roots.forEach((w, i) => {
    moveWidgetKeepingGroup(w, (i % cols) * (maxW + gap) + gap, Math.floor(i / cols) * (maxH + gap) + gap, state.widgets, '.widget');
  });
  renderWidgets();
  toast('⊞ Arranged in grid', 'success');
  saveUndoState();
}

// Auto-arrange in rows
function autoArrangeRows() {
  if (!state.widgets.length) return;
  saveUndoState();
  const gap = 10;
  let y = gap;
  layoutRootWidgets(state.widgets).forEach(w => {
    moveWidgetKeepingGroup(w, gap, y, state.widgets, '.widget');
    y += w.h + gap;
  });
  renderWidgets();
  toast('≡ Arranged in rows', 'success');
  saveUndoState();
}

// Auto-arrange in columns
function autoArrangeCols() {
  if (!state.widgets.length) return;
  saveUndoState();
  const gap = 10;
  let x = gap;
  layoutRootWidgets(state.widgets).forEach(w => {
    moveWidgetKeepingGroup(w, x, gap, state.widgets, '.widget');
    x += w.w + gap;
  });
  renderWidgets();
  toast('⫾ Arranged in columns', 'success');
  saveUndoState();
}

// Distribute horizontally
function distributeH() {
  const ids = state.multiSelect.length ? state.multiSelect : state.widgets.map(w => w.id);
  const ws = state.widgets.filter(w => ids.includes(w.id)).sort((a,b) => a.x - b.x);
  if (ws.length < 3) { toast('Need 3+ widgets', 'error'); return; }
  saveUndoState();
  const first = ws[0], last = ws[ws.length-1];
  const totalSpace = last.x - first.x - first.w;
  const gap = totalSpace / (ws.length - 1);
  let x = first.x + first.w;
  ws.slice(1, -1).forEach(w => { w.x = x + gap - w.w/2 + first.w/2; x += gap; });
  renderWidgets();
  toast('↔ Distributed horizontally', 'success');
  saveUndoState();
}

// Distribute vertically
function distributeV() {
  const ids = state.multiSelect.length ? state.multiSelect : state.widgets.map(w => w.id);
  const ws = state.widgets.filter(w => ids.includes(w.id)).sort((a,b) => a.y - b.y);
  if (ws.length < 3) { toast('Need 3+ widgets', 'error'); return; }
  saveUndoState();
  const first = ws[0], last = ws[ws.length-1];
  const totalSpace = last.y - first.y - first.h;
  const gap = totalSpace / (ws.length - 1);
  let y = first.y + first.h;
  ws.slice(1, -1).forEach(w => { w.y = y + gap - w.h/2 + first.h/2; y += gap; });
  renderWidgets();
  toast('↕ Distributed vertically', 'success');
  saveUndoState();
}

// Align functions
function alignLeft() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const minX = Math.min(...ws.map(w => w.x));
  ws.forEach(w => w.x = minX);
  renderWidgets();
  toast('⫷ Aligned left', 'success');
}

function alignRight() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const maxX = Math.max(...ws.map(w => w.x + w.w));
  ws.forEach(w => w.x = maxX - w.w);
  renderWidgets();
  toast('⫸ Aligned right', 'success');
}

function alignTop() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const minY = Math.min(...ws.map(w => w.y));
  ws.forEach(w => w.y = minY);
  renderWidgets();
  toast('⫠ Aligned top', 'success');
}

function alignBottom() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const maxY = Math.max(...ws.map(w => w.y + w.h));
  ws.forEach(w => w.y = maxY - w.h);
  renderWidgets();
  toast('⫟ Aligned bottom', 'success');
}

function alignCenterH() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const avgX = ws.reduce((s, w) => s + w.x + w.w/2, 0) / ws.length;
  ws.forEach(w => w.x = avgX - w.w/2);
  renderWidgets();
  toast('⫿ Aligned center H', 'success');
}

function alignCenterV() {
  const ids = state.multiSelect.length ? state.multiSelect : [state.selected];
  const ws = state.widgets.filter(w => ids.includes(w.id));
  if (ws.length < 2) return;
  saveUndoState();
  const avgY = ws.reduce((s, w) => s + w.y + w.h/2, 0) / ws.length;
  ws.forEach(w => w.y = avgY - w.h/2);
  renderWidgets();
  toast('⫿ Aligned center V', 'success');
}

function cycleTheme() {
  const themes = Object.keys(THEMES);
  const idx = (themes.indexOf(state.theme) + 1) % themes.length;
  setTheme(themes[idx]);
}

// === GROUPING ===
// v2.2: Ctrl+G now creates a real CFG `group` widget around the selected
// controls instead of an editor-only invisible grouping record.
function groupSelected() {
  if (state.multiSelect.length < 2) { toast('Select 2+ widgets', 'error'); return; }
  const members = state.widgets.filter(w => state.multiSelect.includes(w.id) && w.t !== 'group');
  if (members.length < 2) { toast('Select 2+ non-group widgets', 'error'); return; }
  saveUndoState();
  const pad = 24;
  const minX = Math.max(0, Math.min(...members.map(w => w.x)) - pad);
  const minY = Math.max(0, Math.min(...members.map(w => w.y)) - pad - 16);
  const maxX = Math.max(...members.map(w => w.x + w.w)) + pad;
  const maxY = Math.max(...members.map(w => w.y + w.h)) + pad;
  const group = applyWidgetDefaults({
    id: `group${state.nextId++}`, t: 'group', label: 'Group',
    x: minX, y: minY, w: Math.max(160, maxX - minX), h: Math.max(120, maxY - minY),
    color: '#00d4ff', model: 'panel', children: members.map(w => w.id)
  });
  members.forEach(w => w.groupId = group.id);
  state.widgets.unshift(group); // structural frame behind controls
  state.selected = group.id;
  state.multiSelect = [];
  renderWidgets();
  toast(`▣ Grouped ${members.length} widgets`, 'success');
}

function ungroupSelected() {
  const w = getSelectedWidget();
  const group = w?.t === 'group' ? w : state.widgets.find(g => g.t === 'group' && g.id === w?.groupId);
  if (!group) { toast('Select a group or grouped widget', 'error'); return; }
  saveUndoState();
  detachGroup(group, state.widgets);
  state.widgets = state.widgets.filter(x => x.id !== group.id);
  state.selected = null;
  renderWidgets();
  toast('⚯ Ungrouped', 'success');
}

// === LAYERS ===
function toggleLayers() {
  state.showLayers = !state.showLayers;
  let panel = $('#layersPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'layersPanel';
    panel.className = 'layers-panel';
    document.body.appendChild(panel);
  }
  panel.classList.toggle('show', state.showLayers);
  if (state.showLayers) renderLayersPanel();
}

function renderLayersPanel() {
  const panel = $('#layersPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="layers-header">Layers <button onclick="toggleLayers()" style="background:none;border:none;color:white;cursor:pointer">✕</button></div>
    <div class="layers-list">${state.widgets.map((w, i) => `
      <div class="layer-item ${w.id === state.selected ? 'selected' : ''}" onclick="state.selected='${w.id}';updateSelectionUI();renderLayersPanel()">
        <span class="layer-icon">${ICONS[w.t]}</span>
        <span>${esc(w.label) || w.id}</span>
        <span class="layer-vis visible" onclick="event.stopPropagation();toggleWidgetVis('${w.id}')">👁</span>
      </div>
    `).reverse().join('')}</div>
  `;
}

function toggleWidgetVis(id) {
  const w = state.widgets.find(x => x.id === id);
  if (w) { w.hidden = !w.hidden; renderWidgets(); renderLayersPanel(); }
}

function moveLayerUp() {
  if (!state.selected) return;
  const idx = state.widgets.findIndex(w => w.id === state.selected);
  if (idx < state.widgets.length - 1) {
    [state.widgets[idx], state.widgets[idx+1]] = [state.widgets[idx+1], state.widgets[idx]];
    renderWidgets();
  }
}

function moveLayerDown() {
  if (!state.selected) return;
  const idx = state.widgets.findIndex(w => w.id === state.selected);
  if (idx > 0) {
    [state.widgets[idx], state.widgets[idx-1]] = [state.widgets[idx-1], state.widgets[idx]];
    renderWidgets();
  }
}

// === SHARE/EXPORT ===
function shareURL() {
  const data = { title: $('#titleInput')?.value || 'Remote', widgets: state.widgets };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  const url = location.origin + location.pathname + '?layout=' + encoded;
  navigator.clipboard.writeText(url).then(() => toast('🔗 Link copied!', 'success'));
}

function generateQR() {
  const data = { title: $('#titleInput')?.value || 'Remote', widgets: state.widgets };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  const url = location.origin + location.pathname + '?layout=' + encoded;
  // Using QR code API
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  
  let modal = $('#shareModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'shareModal';
    modal.className = 'share-modal';
    modal.innerHTML = `<div class="share-content">
      <h3>📱 Scan to Share</h3>
      <img class="share-qr" src="" alt="QR Code">
      <input class="share-link" readonly>
      <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value);toast('Copied!','success')" style="padding:10px 20px;border:none;border-radius:8px;background:var(--accent);cursor:pointer">📋 Copy Link</button>
      <button onclick="this.closest('.share-modal').classList.remove('show')" style="padding:10px 20px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:white;cursor:pointer;margin-left:8px">Close</button>
    </div>`;
    document.body.appendChild(modal);
  }
  modal.querySelector('.share-qr').src = qrUrl;
  modal.querySelector('.share-link').value = url;
  modal.classList.add('show');
}

function exportScreenshot() {
  const canvas = $('#canvas');
  if (!canvas) return;
  // Use html2canvas if available, otherwise simple approach
  toast('📸 Preparing screenshot...', 'success');
  import('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.esm.min.js')
    .then(mod => mod.default(canvas))
    .then(c => {
      const link = document.createElement('a');
      link.download = 'remote-layout.png';
      link.href = c.toDataURL();
      link.click();
      toast('📸 Screenshot saved!', 'success');
    })
    .catch(() => toast('Screenshot requires html2canvas', 'error'));
}

// === WIDGET TEMPLATES ===
function saveWidgetTemplate() {
  const ids = state.multiSelect.length ? state.multiSelect : (state.selected ? [state.selected] : []);
  if (!ids.length) { toast('Select widgets first', 'error'); return; }
  const name = prompt('Template name:');
  if (!name) return;
  const widgets = state.widgets.filter(w => ids.includes(w.id)).map(w => ({...w}));
  // Normalize positions
  const minX = Math.min(...widgets.map(w => w.x));
  const minY = Math.min(...widgets.map(w => w.y));
  widgets.forEach(w => { w.x -= minX; w.y -= minY; delete w.id; });
  state.widgetTemplates.push({ name, widgets });
  try { localStorage.setItem('widget_templates', JSON.stringify(state.widgetTemplates)); } catch(e) {}
  toast(`💾 Template "${name}" saved`, 'success');
}

function loadWidgetTemplates() {
  try {
    state.widgetTemplates = JSON.parse(localStorage.getItem('widget_templates') || '[]');
  } catch(e) { state.widgetTemplates = []; }
}

function showTemplateMenu() {
  if (!state.widgetTemplates.length) { toast('No saved templates', 'error'); return; }
  const name = prompt('Templates:\n' + state.widgetTemplates.map((t,i) => `${i+1}. ${t.name}`).join('\n') + '\n\nEnter number:');
  const idx = parseInt(name) - 1;
  if (isNaN(idx) || !state.widgetTemplates[idx]) return;
  saveUndoState();
  const tpl = state.widgetTemplates[idx];
  tpl.widgets.forEach(w => {
    state.widgets.push({ ...w, id: `${w.t}${state.nextId++}`, x: w.x + 20, y: w.y + 20 });
  });
  renderWidgets();
  toast(`📂 Loaded "${tpl.name}"`, 'success');
}

// === RULER ===
function toggleRuler() {
  state.showRuler = !state.showRuler;
  const canvas = $('#canvas');
  let rulerH = canvas.querySelector('.ruler-h');
  let rulerV = canvas.querySelector('.ruler-v');
  
  if (state.showRuler) {
    if (!rulerH) {
      rulerH = document.createElement('div');
      rulerH.className = 'ruler ruler-h';
      canvas.appendChild(rulerH);
    }
    if (!rulerV) {
      rulerV = document.createElement('div');
      rulerV.className = 'ruler ruler-v';
      canvas.appendChild(rulerV);
    }
    // Add marks
    for (let i = 0; i <= 1000; i += 50) {
      const mh = document.createElement('span');
      mh.className = 'ruler-mark';
      mh.style.left = i + 'px';
      mh.textContent = i;
      rulerH.appendChild(mh);
      const mv = document.createElement('span');
      mv.className = 'ruler-mark';
      mv.style.top = i + 'px';
      mv.textContent = i;
      rulerV.appendChild(mv);
    }
    toast('📏 Ruler ON', 'success');
  } else {
    if (rulerH) rulerH.remove();
    if (rulerV) rulerV.remove();
    toast('📏 Ruler OFF', 'success');
  }
}

// === SENSOR SIMULATOR ===
function toggleSensorSim() {
  let sim = $('#sensorSim');
  if (!sim) {
    sim = document.createElement('div');
    sim.id = 'sensorSim';
    sim.className = 'sensor-sim';
    sim.innerHTML = `
      <div class="sensor-group">
        <div class="sensor-label">Accel X</div>
        <input type="range" class="sensor-slider" min="-1024" max="1024" value="0" oninput="simSensor('accelX', this.value)">
        <div class="sensor-value" id="simAccelX">0</div>
      </div>
      <div class="sensor-group">
        <div class="sensor-label">Accel Y</div>
        <input type="range" class="sensor-slider" min="-1024" max="1024" value="0" oninput="simSensor('accelY', this.value)">
        <div class="sensor-value" id="simAccelY">0</div>
      </div>
      <div class="sensor-group">
        <div class="sensor-label">Light</div>
        <input type="range" class="sensor-slider" min="0" max="255" value="128" oninput="simSensor('light', this.value)">
        <div class="sensor-value" id="simLight">128</div>
      </div>
      <div class="sensor-group">
        <div class="sensor-label">Temp</div>
        <input type="range" class="sensor-slider" min="-10" max="50" value="25" oninput="simSensor('temp', this.value)">
        <div class="sensor-value" id="simTemp">25°</div>
      </div>
      <button onclick="$('#sensorSim').classList.remove('show')" style="padding:8px;border:none;border-radius:8px;background:rgba(255,255,255,0.1);color:white;cursor:pointer">✕</button>
    `;
    document.body.appendChild(sim);
  }
  sim.classList.toggle('show');
}

function simSensor(type, value) {
  const el = $(`#sim${type.charAt(0).toUpperCase() + type.slice(1)}`);
  if (el) el.textContent = value + (type === 'temp' ? '°' : '');
  // Could send to widgets that listen to sensors
}

// === LOAD URL LAYOUT ===
function loadURLLayout() {
  const params = new URLSearchParams(location.search);
  const layout = params.get('layout');
  if (layout) {
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(layout))));
      if (data.widgets) {
        // URL imports obey the exact same state/canvas rules as file imports.
        // This avoids inheriting a previous canvas or leaving a stale Play snapshot.
        data.widgets = data.widgets.map(w => ({ ...w, id: w.id || `${w.t}${state.nextId++}` }));
        applyCfgToBuildState(data);
        toast('📂 Layout loaded from URL', 'success');
      }
    } catch(e) { console.error('Failed to load URL layout', e); }
  }
}

// === CANVAS BACKGROUND ===
function setCanvasBackground() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = e => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = ev => {
        state.canvasBg = ev.target.result;
        const canvas = $('#canvas');
        if (canvas) {
          canvas.style.backgroundImage = `url(${state.canvasBg})`;
          canvas.style.backgroundSize = 'cover';
          canvas.style.backgroundPosition = 'center';
        }
        toast('🖼️ Background set', 'success');
      };
      reader.readAsDataURL(file);
    }
  };
  input.click();
}

function clearCanvasBackground() {
  state.canvasBg = null;
  const canvas = $('#canvas');
  if (canvas) {
    canvas.style.backgroundImage = '';
  }
  toast('🖼️ Background cleared', 'success');
}

// === HIGH CONTRAST MODE ===
function toggleHighContrast() {
  document.body.classList.toggle('high-contrast');
  const isHC = document.body.classList.contains('high-contrast');
  toast(isHC ? '◐ High Contrast ON' : '◐ High Contrast OFF', 'success');
  try { localStorage.setItem('high_contrast', isHC ? '1' : '0'); } catch(e) {}
}

// Load high contrast preference
function loadHighContrastPref() {
  try {
    if (localStorage.getItem('high_contrast') === '1') {
      document.body.classList.add('high-contrast');
    }
  } catch(e) {}
}

// === HELP/SHORTCUTS MODAL ===
function showHelp() {
  let modal = $('#helpModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'helpModal';
    modal.className = 'share-modal';
    modal.innerHTML = `<div class="share-content" style="max-width:500px;text-align:left;">
      <h3>⌨️ Keyboard Shortcuts</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;margin:16px 0;">
        <div><kbd>Ctrl+Z</kbd> Undo</div>
        <div><kbd>Ctrl+Shift+Z</kbd> Redo</div>
        <div><kbd>Ctrl+C</kbd> Copy</div>
        <div><kbd>Ctrl+V</kbd> Paste</div>
        <div><kbd>Ctrl+D</kbd> Duplicate</div>
        <div><kbd>Ctrl+G</kbd> Group</div>
        <div><kbd>Ctrl+S</kbd> Save Template</div>
        <div><kbd>Ctrl+A</kbd> Select All</div>
        <div><kbd>Delete</kbd> Delete</div>
        <div><kbd>Escape</kbd> Deselect</div>
        <div><kbd>G</kbd> Toggle Grid</div>
        <div><kbd>L</kbd> Toggle Layers</div>
        <div><kbd>T</kbd> Cycle Theme</div>
        <div><kbd>Arrow Keys</kbd> Nudge 1px</div>
        <div><kbd>Shift+Arrow</kbd> Nudge 10px</div>
        <div><kbd>Shift+Click</kbd> Multi-select</div>
      </div>
      <h3>🖱️ Mouse Actions</h3>
      <div style="font-size:13px;margin:16px 0;">
        <div>• Shift+Drag on canvas: Selection box</div>
        <div>• Drag widget corner: Resize</div>
        <div>• Click canvas: Place selected widget type</div>
      </div>
      <button onclick="this.closest('.share-modal').classList.remove('show')" style="padding:10px 20px;border:none;border-radius:8px;background:var(--accent);cursor:pointer;width:100%">Got it!</button>
    </div>`;
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
}

// === PIN MAPPING HELPER ===
function showPinMapping() {
  let modal = $('#pinModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pinModal';
    modal.className = 'share-modal';
    modal.innerHTML = `<div class="share-content" style="max-width:450px;text-align:left;">
      <h3>📌 micro:bit Pin Reference</h3>
      <div style="font-size:13px;margin:16px 0;line-height:1.6;">
        <div><b>P0, P1, P2</b> - Large pins (touch, analog, digital)</div>
        <div><b>P3-P10</b> - LED matrix (shared)</div>
        <div><b>P11</b> - Button B (shared)</div>
        <div><b>P12</b> - Reserved</div>
        <div><b>P13-P15</b> - SPI (SCK, MISO, MOSI)</div>
        <div><b>P16</b> - General purpose</div>
        <div><b>P19, P20</b> - I2C (SCL, SDA)</div>
      </div>
      <h4>Common Uses:</h4>
      <div style="font-size:12px;margin:8px 0;opacity:0.8;">
        • Servo: P0, P1, P2 (PWM)<br>
        • LED Strip: P0 (NeoPixels)<br>
        • Sensor: P0-P2 (analog read)<br>
        • Motor: P0+P8 or P1+P12 (H-bridge)
      </div>
      <button onclick="this.closest('.share-modal').classList.remove('show')" style="padding:10px 20px;border:none;border-radius:8px;background:var(--accent);cursor:pointer;width:100%">Close</button>
    </div>`;
    document.body.appendChild(modal);
  }
  modal.classList.add('show');
}

// Grid snapping
function snapToGrid(val) {
  if (!state.gridSnap) return val;
  return Math.round(val / state.gridSize) * state.gridSize;
}

// Alignment guides
function showAlignGuides(w) {
  removeAlignGuides();
  if (!state.showGuides) return;
  const canvas = $('#canvas');
  const guides = [];
  const SNAP_DIST = 5;
  
  state.widgets.forEach(other => {
    if (other.id === w.id) return;
    // Vertical guides (left, center, right alignment)
    if (Math.abs(w.x - other.x) < SNAP_DIST) guides.push({type:'v', pos: other.x});
    if (Math.abs(w.x + w.w - other.x - other.w) < SNAP_DIST) guides.push({type:'v', pos: other.x + other.w});
    if (Math.abs(w.x + w.w/2 - other.x - other.w/2) < SNAP_DIST) guides.push({type:'v', pos: other.x + other.w/2});
    // Horizontal guides
    if (Math.abs(w.y - other.y) < SNAP_DIST) guides.push({type:'h', pos: other.y});
    if (Math.abs(w.y + w.h - other.y - other.h) < SNAP_DIST) guides.push({type:'h', pos: other.y + other.h});
    if (Math.abs(w.y + w.h/2 - other.y - other.h/2) < SNAP_DIST) guides.push({type:'h', pos: other.y + other.h/2});
  });
  
  guides.forEach(g => {
    const el = document.createElement('div');
    el.className = 'align-guide ' + (g.type === 'h' ? 'horizontal' : 'vertical');
    el.style[g.type === 'h' ? 'top' : 'left'] = g.pos + 'px';
    canvas.appendChild(el);
  });
}

function removeAlignGuides() {
  $$('.align-guide').forEach(el => el.remove());
}

// Canvas auto-expand
function updateCanvasSize() {
  autoResizeCanvas();
}

// Minimap
function updateMinimap() {
  const minimap = $('#minimap');
  if (!minimap) return;
  const canvas = $('#canvas');
  if (!canvas) return;
  
  const scale = 0.1;
  minimap.innerHTML = '';
  
  state.widgets.forEach(w => {
    const el = document.createElement('div');
    el.className = 'minimap-widget';
    el.style.cssText = `left:${w.x*scale}px;top:${w.y*scale}px;width:${Math.max(4,w.w*scale)}px;height:${Math.max(4,w.h*scale)}px;background:${w.color || 'var(--accent)'}`;
    minimap.appendChild(el);
  });
}

// Zoom
function setZoom(z) {
  setBuildZoom(z);
}

// Nudge with arrow keys
function nudgeSelected(dx, dy) {
  const ids = state.multiSelect.length ? state.multiSelect : (state.selected ? [state.selected] : []);
  if (!ids.length) return;
  saveUndoState();
  const idSet = new Set(ids);
  state.widgets.filter(w => idSet.has(w.id) && !w.locked).forEach(w => {
    // If both a group and one of its children are selected, the child will be
    // moved by the group. Skip the direct move to avoid applying the nudge twice.
    if (w.groupId && idSet.has(w.groupId)) return;
    const oldX = w.x, oldY = w.y;
    w.x = Math.max(0, w.x + dx);
    w.y = Math.max(0, w.y + dy);
    if (w.t === 'group') moveGroupChildren(w, w.x - oldX, w.y - oldY, state.widgets, '.widget');
  });
  renderWidgets();
}

// Setup canvas tools UI
function setupCanvasTools() {
  const canvas = $('#canvas');
  if (!canvas) return;

  // Our helper tools live in the draggable Helper Panel UI
  try { ensureHelperUI(); } catch(e) {}
}

function startSelectionBox(e) {
  const canvas = $('#canvas');
  const rect = canvas.getBoundingClientRect();
  const z = Math.max(0.15, Number(state.buildZoom || 1));
  selBoxStart = { x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z };
  selectionBox = document.createElement('div');
  selectionBox.className = 'selection-box';
  canvas.appendChild(selectionBox);
}

function updateSelectionBox(e) {
  if (!selectionBox || !selBoxStart) return;
  const canvas = $('#canvas');
  const rect = canvas.getBoundingClientRect();
  const z = Math.max(0.15, Number(state.buildZoom || 1));
  const x = (e.clientX - rect.left) / z;
  const y = (e.clientY - rect.top) / z;
  const left = Math.min(x, selBoxStart.x);
  const top = Math.min(y, selBoxStart.y);
  const width = Math.abs(x - selBoxStart.x);
  const height = Math.abs(y - selBoxStart.y);
  selectionBox.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
}

function endSelectionBox() {
  if (!selectionBox || !selBoxStart) return;
  const boxLeft = parseFloat(selectionBox.style.left) || 0;
  const boxTop = parseFloat(selectionBox.style.top) || 0;
  const boxRight = boxLeft + (parseFloat(selectionBox.style.width) || 0);
  const boxBottom = boxTop + (parseFloat(selectionBox.style.height) || 0);
  
  state.multiSelect = state.widgets.filter(w => {
    return w.x < boxRight && w.x + w.w > boxLeft && w.y < boxBottom && w.y + w.h > boxTop;
  }).map(w => w.id);
  
  selectionBox.remove();
  selectionBox = null;
  selBoxStart = null;
  updateSelectionUI();
  if (state.multiSelect.length) toast(tr('toast.selectedAll', {n: state.multiSelect.length}), 'success');
}

// Auto-resize canvas based on widget positions
function autoResizeCanvas() {
  const canvas = $('#canvas');
  if (!canvas || !state.widgets.length) return;
  let maxX = 400, maxY = 300;
  state.widgets.forEach(w => {
    maxX = Math.max(maxX, Number(w.x || 0) + Number(w.w || 0) + 20);
    maxY = Math.max(maxY, Number(w.y || 0) + Number(w.h || 0) + 20);
  });
  const cur = getBuildLogicalSize();
  const nextW = Math.max(cur.w, maxX);
  const nextH = Math.max(cur.h, maxY);
  if (!state.buildCanvasSize || nextW !== cur.w || nextH !== cur.h) {
    state.buildCanvasSize = { w: Math.round(nextW), h: Math.round(nextH) };
  }
  applyBuildCanvasView();
}

// === v2.2 GROUP + SEPARATOR HELPERS ===
function widgetChildren(group, widgets = state.widgets) {
  if (!group || group.t !== 'group') return [];
  const ids = Array.isArray(group.children) ? group.children : [];
  return ids.map(id => widgets.find(w => w.id === id)).filter(Boolean);
}

// Restored. These were added in 0b15820 and removed by 3cb894b, which left all
// seven call sites intact -- so dragging a group, or deleting one, threw a
// ReferenceError in Build mode. That is exactly the 'a zone drags as one unit'
// behaviour the K4-v18 layout commit advertised.

function moveGroupChildren(group, dx, dy, widgets = state.widgets, rootSelector = '.widget') {
  if (!group || group.t !== 'group' || (!dx && !dy)) return;
  widgetChildren(group, widgets).forEach(child => {
    child.x = Math.max(0, Number(child.x || 0) + dx);
    child.y = Math.max(0, Number(child.y || 0) + dy);
    const el = document.querySelector(`${rootSelector}[data-id="${CSS.escape(child.id)}"]`);
    if (el) {
      el.style.left = child.x + 'px';
      el.style.top = child.y + 'px';
    }
  });
}

function detachGroup(group, widgets = state.widgets) {
  if (!group || group.t !== 'group') return;
  widgetChildren(group, widgets).forEach(child => {
    if (child.groupId === group.id) delete child.groupId;
  });
  group.children = [];
}

function normalizeGroupMembership(widgets = state.widgets) {
  const groups = widgets.filter(w => w.t === 'group');
  const byId = new Map(widgets.map(w => [w.id, w]));
  groups.forEach(g => {
    applyWidgetDefaults(g);
    g.children = [...new Set((g.children || []).filter(id => id !== g.id && byId.has(id) && byId.get(id)?.t !== 'group'))];
  });

  // A widget can belong to exactly one group. Prefer its explicit groupId when
  // valid; otherwise the first group's children list that claims it wins.
  const owner = new Map();
  widgets.forEach(w => {
    if (!w.groupId || w.t === 'group') return;
    const g = byId.get(w.groupId);
    if (g?.t === 'group') owner.set(w.id, g.id);
  });
  groups.forEach(g => g.children.forEach(id => {
    if (!owner.has(id)) owner.set(id, g.id);
  }));
  groups.forEach(g => {
    g.children = g.children.filter(id => owner.get(id) === g.id);
  });
  widgets.forEach(w => {
    if (w.t === 'group') return;
    const gid = owner.get(w.id);
    if (gid) w.groupId = gid;
    else delete w.groupId;
  });
}

function layoutRootWidgets(widgets = state.widgets) {
  normalizeGroupMembership(widgets);
  return widgets.filter(w => !w.groupId);
}

function moveWidgetKeepingGroup(w, x, y, widgets = state.widgets, rootSelector = '.widget') {
  const oldX = Number(w.x || 0), oldY = Number(w.y || 0);
  w.x = Math.max(0, Number(x || 0));
  w.y = Math.max(0, Number(y || 0));
  if (w.t === 'group') moveGroupChildren(w, w.x - oldX, w.y - oldY, widgets, rootSelector);
}

function groupPreviewMarkup(w) {
  const count = Array.isArray(w.children) ? w.children.length : 0;
  return `<div class="build-group-preview model-${esc(w.model || 'panel')}" style="--group-accent:${esc(w.color || '#00d4ff')}">
    <span class="build-group-title">${esc(w.label || 'Group')}</span>
    <span class="build-group-count">${count} item${count === 1 ? '' : 's'}</span>
  </div>`;
}

function separatorPreviewMarkup(w) {
  const orientation = w.orientation || ((w.h || 0) > (w.w || 0) ? 'vertical' : 'horizontal');
  const thickness = Math.max(1, Math.min(6, Number(w.thickness) || 1));
  const label = esc(w.label || '');
  return `<div class="build-separator-preview ${orientation} model-${esc(w.model || 'subtle')}" style="--sep-color:${esc(w.color || '#94a3b8')};--sep-thickness:${thickness}px">
    <span class="build-separator-line"></span>${label ? `<span class="build-separator-label">${label}</span>` : ''}
  </div>`;
}

function renderWidgets() {
  try { makeCanvasResizable(); setupBuildCanvasViewControls(); } catch(e) {}
  const layer = $('#widgetsLayer');
  layer.innerHTML = '';
  
  setupCanvasTools();
  normalizeGroupMembership(state.widgets);
  
  state.widgets.forEach(w => {
    const el = document.createElement('div');
    const isMulti = state.multiSelect.includes(w.id);
    el.className = 'widget' + (state.selected === w.id ? ' selected' : '') + (isMulti ? ' multi-selected' : '') + (w.locked ? ' locked' : '') + (w.hidden ? ' hidden' : '') + (w.groupId ? ' grouped' : '') + (w.t === 'group' ? ' widget-group' : '') + (w.t === 'separator' ? ' widget-separator' : '');
    el.dataset.id = w.id;
    el.dataset.type = w.t;
    
    // Build style with all properties
    let styles = `left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px`;
    if (w.borderStyle) styles += `;border-style:${w.borderStyle}`;
    if (w.borderRadius !== undefined) styles += `;border-radius:${w.borderRadius}px`;
    if (w.shadow === 'soft') styles += `;box-shadow:0 10px 30px rgba(0,0,0,0.3)`;
    else if (w.shadow === 'glow') styles += `;box-shadow:0 0 30px ${w.color || 'var(--accent)'}`;
    else if (w.shadow === 'neon') styles += `;box-shadow:0 0 20px ${w.color || '#ff00ff'}, 0 0 40px ${w.color || '#ff00ff'}`;
    if (w.hidden) styles += `;display:none`;
    if (w.t === 'group') styles += `;z-index:0`;
    else styles += `;z-index:1`;
    el.style.cssText = styles;
    
    let colorDot = w.color ? `<div class="widget-color-dot" style="background:${w.color}"></div>` : '';
    // Add orientation indicator for sliders
    let orientIndicator = '';
    if (w.t === 'slider') {
      const isVertical = (w.h || 100) > (w.w || 100);
      orientIndicator = `<div class="widget-orient-badge">${isVertical ? '↕' : '↔'}</div>`;
    }
    const resizeHandles = `
      <div class="resize-handle handle-n"></div>
      <div class="resize-handle handle-s"></div>
      <div class="resize-handle handle-e"></div>
      <div class="resize-handle handle-w"></div>
      <div class="resize-handle handle-ne"></div>
      <div class="resize-handle handle-nw"></div>
      <div class="resize-handle handle-se"></div>
      <div class="resize-handle handle-sw"></div>
    `;
    if (w.t === 'group') {
      el.innerHTML = `${groupPreviewMarkup(w)}${resizeHandles}`;
    } else if (w.t === 'separator') {
      el.innerHTML = `${separatorPreviewMarkup(w)}${resizeHandles}`;
    } else {
      el.innerHTML = `${colorDot}<div class="widget-icon">${ICONS[w.t]}</div><div class="widget-label">${esc(w.label) || w.t}</div>${orientIndicator}${resizeHandles}`;
    }
    layer.appendChild(el);
    
    if (!w.locked) {
      interact(el).draggable({
        inertia: false,
        listeners: {
          start() { 
            saveUndoState();
            state.selected = w.id; 
            updateSelectionUI(); 
          },
          move(e) {
            state.justDragged = true;
            clearTimeout(state._dragT);
            state._dragT = setTimeout(() => state.justDragged = false, 50);
            
            const buildScale = Math.max(0.15, Number(state.buildZoom || 1));
            let newX = w.x + e.dx / buildScale;
            let newY = w.y + e.dy / buildScale;
            
            if (state.gridSnap) {
              newX = snapToGrid(newX);
              newY = snapToGrid(newY);
            }
            
            // Clamp to canvas bounds
            const canvas = $('#canvas');
            const maxX = (canvas?.offsetWidth || 500) - w.w - 10;
            const maxY = (canvas?.offsetHeight || 400) - w.h - 10;
            
            const oldX = w.x;
            const oldY = w.y;
            w.x = Math.max(0, Math.min(maxX, newX));
            w.y = Math.max(0, Math.min(maxY, newY));
            const movedDx = w.x - oldX;
            const movedDy = w.y - oldY;
            e.target.style.left = w.x + 'px';
            e.target.style.top = w.y + 'px';
            if (w.t === 'group') moveGroupChildren(w, movedDx, movedDy, state.widgets, '.widget');
            
            showAlignGuides(w);
            autoResizeCanvas();
          },
          end() {
            removeAlignGuides();
            autoResizeCanvas();
            saveUndoState();
            scheduleAutoSave();
          }
        }
      }).resizable({
        edges: { 
          top: '.handle-n, .handle-ne, .handle-nw',
          bottom: '.handle-s, .handle-se, .handle-sw',
          left: '.handle-w, .handle-nw, .handle-sw',
          right: '.handle-e, .handle-ne, .handle-se'
        },
        modifiers: [interact.modifiers.restrictSize({ min: { width: w.t === 'separator' ? 8 : 60, height: w.t === 'separator' ? 8 : 60 } })],
        listeners: {
          start() { saveUndoState(); },
          move(e) {
            // Handle position changes from top/left edges
            const buildScale = Math.max(0.15, Number(state.buildZoom || 1));
            let newX = w.x + (e.deltaRect.left || 0) / buildScale;
            let newY = w.y + (e.deltaRect.top || 0) / buildScale;
            const logicalRectW = e.rect.width / buildScale;
            const logicalRectH = e.rect.height / buildScale;
            let newW = state.gridSnap ? snapToGrid(logicalRectW) : logicalRectW;
            let newH = state.gridSnap ? snapToGrid(logicalRectH) : logicalRectH;
            
            // Clamp to canvas
            const canvas = $('#canvas');
            const canvasW = canvas?.offsetWidth || 500;
            const canvasH = canvas?.offsetHeight || 400;
            
            // Ensure widget stays in bounds. Separators are allowed to be thin.
            const minDim = w.t === 'separator' ? 8 : 60;
            newX = Math.max(0, Math.min(canvasW - minDim, newX));
            newY = Math.max(0, Math.min(canvasH - minDim, newY));
            newW = Math.max(minDim, Math.min(canvasW - newX - 5, newW));
            newH = Math.max(minDim, Math.min(canvasH - newY - 5, newH));
            
            w.x = newX;
            w.y = newY;
            w.w = newW;
            w.h = newH;
            
            e.target.style.left = w.x + 'px';
            e.target.style.top = w.y + 'px';
            e.target.style.width = w.w + 'px';
            e.target.style.height = w.h + 'px';
          },
          end() { autoResizeCanvas(); saveUndoState(); scheduleAutoSave(); }
        }
      });
    }
    
    el.onclick = e => { 
      e.stopPropagation(); 
      if (e.shiftKey) {
        // Multi-select with shift
        if (state.multiSelect.includes(w.id)) {
          state.multiSelect = state.multiSelect.filter(id => id !== w.id);
        } else {
          state.multiSelect.push(w.id);
        }
      } else {
        state.multiSelect = [];
        state.selected = w.id; 
      }
      updateSelectionUI(); 
    };
  });
  
  // Rendering is view-only. Exact imported/arranged geometry must never be
  // repacked merely because Build is redrawn or a mode is switched.
  updateMinimap();
  saveUndoState();
  
  // Auto-save project
  scheduleAutoSave();
}


function updateSelectionUI() {
  $$('.widget').forEach(el => {
    const id = el.dataset.id;
    el.classList.toggle('selected', id === state.selected);
    el.classList.toggle('multi-selected', state.multiSelect.includes(id));
  });
  renderPropsPanel();
}

function getSelectedWidget(){
  return state.widgets.find(w => w.id === state.selected);
}

function renderPropsPanel(){
  const form = $('#propsForm');
  const empty = $('#propsEmpty');
  const w = getSelectedWidget();

  if (!form || !empty) return;

  if (!w){
    empty.style.display = 'block';
    form.style.display = 'none';
    form.innerHTML = '';
    // Hide mobile panel when no widget selected
    if (typeof hideMobilePropsPanel === 'function') hideMobilePropsPanel();
    return;
  }

  empty.style.display = 'none';
  form.style.display = 'block';
  
  // Show mobile panel when widget is selected
  if (typeof showMobilePropsPanel === 'function') showMobilePropsPanel();

  // Common fields
  let html = `
    <label>Widget ID</label>
    <input id="prop_id" value="${esc(w.id)}" />

    <label>Label</label>
    <input id="prop_label" value="${esc(w.label || '')}" />

    <label>Widget Color</label>
    <input id="prop_color" type="color" value="${w.color || '#00d4ff'}" />

    <label>Lock Position</label>
    <select id="prop_locked">
      <option value="0" ${!w.locked ? 'selected' : ''}>Unlocked</option>
      <option value="1" ${w.locked ? 'selected' : ''}>Locked 🔒</option>
    </select>

    <label>Border Style</label>
    <select id="prop_borderStyle">
      <option value="solid" ${(w.borderStyle || 'solid') === 'solid' ? 'selected' : ''}>Solid</option>
      <option value="dashed" ${w.borderStyle === 'dashed' ? 'selected' : ''}>Dashed</option>
      <option value="dotted" ${w.borderStyle === 'dotted' ? 'selected' : ''}>Dotted</option>
      <option value="none" ${w.borderStyle === 'none' ? 'selected' : ''}>None</option>
    </select>

    <label>Shadow/Glow</label>
    <select id="prop_shadow">
      <option value="none" ${!w.shadow ? 'selected' : ''}>None</option>
      <option value="soft" ${w.shadow === 'soft' ? 'selected' : ''}>Soft Shadow</option>
      <option value="glow" ${w.shadow === 'glow' ? 'selected' : ''}>Glow ✨</option>
      <option value="neon" ${w.shadow === 'neon' ? 'selected' : ''}>Neon 🌈</option>
    </select>

    <label>Border Radius</label>
    <input id="prop_radius" type="range" min="0" max="50" value="${w.borderRadius ?? 16}" />

    <label>📐 Size & Orientation</label>
    <div class="props-row" style="gap:8px; margin-top:6px;">
      <div style="flex:1;">
        <label style="font-size:0.7rem; margin:0;">Width</label>
        <input id="prop_width" type="number" min="40" max="600" value="${w.w || 100}" style="width:100%;" />
      </div>
      <div style="flex:1;">
        <label style="font-size:0.7rem; margin:0;">Height</label>
        <input id="prop_height" type="number" min="40" max="600" value="${w.h || 100}" style="width:100%;" />
      </div>
    </div>
    <div class="props-row" style="gap:8px; margin-top:8px;">
      <button class="props-apply" id="prop_swapOrientation" style="flex:1; margin:0;">🔄 Swap W↔H</button>
      <button class="props-apply" id="prop_resetSize" style="flex:1; margin:0;">↩️ Reset</button>
    </div>
    <div class="props-row" style="gap:4px; margin-top:8px; flex-wrap:wrap;">
      <button class="props-apply prop-preset-size" data-w="80" data-h="80" style="flex:1; margin:0; min-width:60px; padding:8px 4px; font-size:0.75rem;">S</button>
      <button class="props-apply prop-preset-size" data-w="120" data-h="120" style="flex:1; margin:0; min-width:60px; padding:8px 4px; font-size:0.75rem;">M</button>
      <button class="props-apply prop-preset-size" data-w="180" data-h="180" style="flex:1; margin:0; min-width:60px; padding:8px 4px; font-size:0.75rem;">L</button>
      <button class="props-apply prop-preset-size" data-w="250" data-h="250" style="flex:1; margin:0; min-width:60px; padding:8px 4px; font-size:0.75rem;">XL</button>
    </div>
  `;

  // Model selector (3 presets per widget type)
  const opts = modelOptionsForType(w.t);
  if (opts){
    html += `
      <label>Model</label>
      <select id="prop_model">
        ${opts.map(o => `<option value="${o.v}" ${w.model === o.v ? 'selected' : ''}>${o.name}</option>`).join('')}
      </select>
      <button class="props-apply" id="prop_applyAll">Apply this model to ALL ${w.t}s</button>
    `;
  }

  // Type-specific fields
  if (w.t === 'led'){
    html += `
      <label>LED On Color</label>
      <input id="prop_colorOn" type="color" value="${w.colorOn || '#ff5252'}" />

      <label>LED Off Color</label>
      <input id="prop_colorOff" type="color" value="${w.colorOff || '#2a2a3a'}" />
    `;
  }

  if (w.t === 'slider'){
    const isVertical = (w.h || 100) > (w.w || 100);
    html += `
      <label>🔄 Orientation</label>
      <select id="prop_sliderOrient">
        <option value="horizontal" ${!isVertical ? 'selected' : ''}>↔ Horizontal</option>
        <option value="vertical" ${isVertical ? 'selected' : ''}>↕ Vertical</option>
      </select>

      <label>Min</label>
      <input id="prop_min" type="number" value="${w.min ?? 0}" />

      <label>Max</label>
      <input id="prop_max" type="number" value="${w.max ?? 100}" />

      <label>Step</label>
      <input id="prop_step" type="number" value="${w.step ?? 1}" />
    `;
  }


  if (w.t === 'group'){
    html += `
      <label>Group members</label>
      <input id="prop_groupChildren" value="${esc((w.children || []).join(','))}" placeholder="widget1,widget2,..." />
      <button class="props-apply" id="prop_captureGroup">▣ Capture widgets inside group</button>
      <p class="props-hint">Moving this group moves its captured members. Children stay normal CFG widgets for compatibility.</p>
    `;
  }

  if (w.t === 'separator'){
    html += `
      <label>Orientation</label>
      <select id="prop_sepOrientation">
        <option value="horizontal" ${(w.orientation || 'horizontal') === 'horizontal' ? 'selected' : ''}>↔ Horizontal</option>
        <option value="vertical" ${w.orientation === 'vertical' ? 'selected' : ''}>↕ Vertical</option>
      </select>
      <label>Thickness</label>
      <input id="prop_sepThickness" type="range" min="1" max="6" value="${w.thickness ?? 1}" />
      <p class="props-hint">The widget keeps a comfortable hit area; only the visible line uses this thickness.</p>
    `;
  }

  if (w.t === 'gauge'){
    html += `
      <label>Min</label>
      <input id="prop_gmin" type="number" value="${w.min ?? 0}" />

      <label>Max</label>
      <input id="prop_gmax" type="number" value="${w.max ?? 100}" />

      <label>Decimals</label>
      <input id="prop_gdec" type="number" value="${w.decimals ?? 0}" />

      <label>Units (optional)</label>
      <input id="prop_gunits" value="${esc(w.units || '')}" />

      <label>Warn (optional)</label>
      <input id="prop_gwarn" type="number" value="${w.warn ?? ''}" />

      <label>Danger (optional)</label>
      <input id="prop_gdanger" type="number" value="${w.danger ?? ''}" />
    `;
  }

  if (w.t === 'graph'){
    html += `
      <label>Series (1-10)</label>
      <input id="prop_series" type="number" min="1" max="10" value="${w.series ?? 1}" />

      <label>Window (seconds)</label>
      <input id="prop_window" type="number" min="5" max="120" value="${w.windowSec ?? 30}" />

      <label>Auto scale</label>
      <select id="prop_autoscale">
        <option value="1" ${w.autoScale !== false ? 'selected' : ''}>Yes</option>
        <option value="0" ${w.autoScale === false ? 'selected' : ''}>No</option>
      </select>

      <label>Fixed Min (when auto off)</label>
      <input id="prop_ymin" type="number" value="${w.yMin ?? 0}" />

      <label>Fixed Max (when auto off)</label>
      <input id="prop_ymax" type="number" value="${w.yMax ?? 100}" />

      <label>Series Names (comma separated)</label>
      <input id="prop_names" value="${esc((w.seriesNames || '').toString())}" placeholder="Temp,Level,Power" />

      <label>Y Axis Label (optional)</label>
      <input id="prop_ylabel" value="${esc(w.yLabel || '')}" placeholder="°C / % / rpm" />
    `;
  }

  if (w.t === 'image'){
    html += `
      <label>Image URL</label>
      <input id="prop_imageSrc" value="${esc(w.imageSrc || '')}" placeholder="https://..." />
      <button class="props-apply" id="prop_uploadImg">📁 Upload Image</button>
    `;
  }

  if (w.t === 'battery'){
    html += `
      <label>Initial Level (%)</label>
      <input id="prop_batteryLevel" type="number" min="0" max="100" value="${w.level ?? 100}" />
    `;
  }

  if (w.t === 'timer'){
    html += `
      <label>Count Direction</label>
      <select id="prop_timerDir">
        <option value="up" ${(w.timerDir || 'up') === 'up' ? 'selected' : ''}>Count Up ⏱️</option>
        <option value="down" ${w.timerDir === 'down' ? 'selected' : ''}>Countdown ⏳</option>
      </select>
      <label>Initial Seconds (for countdown)</label>
      <input id="prop_timerStart" type="number" min="0" value="${w.timerStart ?? 60}" />
    `;
  }

  if (w.t === 'select'){
    html += `
      <label>Choices (comma separated)</label>
      <input id="prop_options" value="${esc(w.options || '')}" placeholder="Slow,Medium,Fast" />
    `;
  }

  if (w.t === 'editfield'){
    html += `
      <label>Placeholder text</label>
      <input id="prop_placeholder" value="${esc(w.placeholder || '')}" placeholder="Type here..." />
    `;
  }

  if (w.t === 'sound'){
    const effects = [
      ['beep', '🔉 Beep'], ['success', '✅ Success'], ['warn', '⚠️ Warn'],
      ['danger', '🚨 Danger'], ['toggle', '🔀 Toggle'],
    ];
    html += `
      <p class="props-hint">Device sends <code>UPD ${esc(w.id)} &lt;effect&gt;</code> to play a sound on the phone.</p>
      <label>Effect</label>
      <select id="prop_soundEffect">
        ${effects.map(([v,n]) => `<option value="${v}" ${(w.testEffect||'beep')===v?'selected':''}>${n}</option>`).join('')}
      </select>
      <button class="props-apply" id="prop_testSound">🔊 Test Sound</button>
    `;
  }

  if (w.t === 'notification'){
    html += `
      <p class="props-hint">Device sends <code>UPD ${esc(w.id)} &lt;message&gt;</code> to show a banner on the phone.</p>
      <button class="props-apply" id="prop_testNotification">🔔 Test Notification</button>
    `;
  }

form.innerHTML = html;

  // Wire events
  $('#prop_label').oninput = e => {
    w.label = e.target.value;
    const el = $(`.widget[data-id="${w.id}"] .widget-label`);
    if (el) el.textContent = w.label || w.t;
    else if (w.t === 'group' || w.t === 'separator') renderWidgets();
  };

  $('#prop_color').oninput = e => {
    w.color = e.target.value;
    const dot = $(`.widget[data-id="${w.id}"] .widget-color-dot`);
    if (dot) dot.style.background = w.color;
    else renderWidgets();
    updateMinimap();
  };

  $('#prop_locked').onchange = e => {
    w.locked = e.target.value === '1';
    renderWidgets();
    toast(w.locked ? '🔒 Widget locked' : '🔓 Widget unlocked', 'success');
  };

  $('#prop_borderStyle').onchange = e => {
    w.borderStyle = e.target.value;
    const el = $(`.widget[data-id="${w.id}"]`);
    if (el) el.style.borderStyle = w.borderStyle;
  };

  $('#prop_shadow').onchange = e => {
    w.shadow = e.target.value;
    const el = $(`.widget[data-id="${w.id}"]`);
    if (el) {
      if (w.shadow === 'soft') el.style.boxShadow = '0 10px 30px rgba(0,0,0,0.3)';
      else if (w.shadow === 'glow') el.style.boxShadow = `0 0 30px ${w.color || 'var(--accent)'}`;
      else if (w.shadow === 'neon') el.style.boxShadow = `0 0 20px ${w.color || '#ff00ff'}, 0 0 40px ${w.color || '#ff00ff'}`;
      else el.style.boxShadow = '';
    }
  };

  $('#prop_radius').oninput = e => {
    w.borderRadius = parseInt(e.target.value);
    const el = $(`.widget[data-id="${w.id}"]`);
    if (el) el.style.borderRadius = w.borderRadius + 'px';
  };

  // Size and orientation controls
  const widthInput = $('#prop_width');
  const heightInput = $('#prop_height');
  
  if (widthInput) {
    widthInput.oninput = e => {
      const minW = w.t === 'separator' ? 8 : 40;
      const newW = Math.max(minW, Math.min(600, parseInt(e.target.value) || 100));
      w.w = newW;
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) el.style.width = w.w + 'px';
      autoResizeCanvas();
      updateMinimap();
    };
  }
  
  if (heightInput) {
    heightInput.oninput = e => {
      const minH = w.t === 'separator' ? 8 : 40;
      const newH = Math.max(minH, Math.min(600, parseInt(e.target.value) || 100));
      w.h = newH;
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) el.style.height = w.h + 'px';
      autoResizeCanvas();
      updateMinimap();
    };
  }
  
  const swapBtn = $('#prop_swapOrientation');
  if (swapBtn) {
    swapBtn.onclick = () => {
      saveUndoState();
      const oldW = w.w;
      const oldH = w.h;
      w.w = oldH;
      w.h = oldW;
      // Update inputs
      if (widthInput) widthInput.value = w.w;
      if (heightInput) heightInput.value = w.h;
      // Update widget visual
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) {
        el.style.width = w.w + 'px';
        el.style.height = w.h + 'px';
      }
      autoResizeCanvas();
      updateMinimap();
      toast(tr('toast.orientationSwapped'), 'success');
    };
  }
  
  const resetBtn = $('#prop_resetSize');
  if (resetBtn) {
    resetBtn.onclick = () => {
      saveUndoState();
      const defaults = SIZES[w.t] || [100, 100];
      w.w = defaults[0];
      w.h = defaults[1];
      // Update inputs
      if (widthInput) widthInput.value = w.w;
      if (heightInput) heightInput.value = w.h;
      // Update widget visual
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) {
        el.style.width = w.w + 'px';
        el.style.height = w.h + 'px';
      }
      autoResizeCanvas();
      updateMinimap();
      toast(tr('toast.sizeReset'), 'success');
    };
  }
  
  // Preset size buttons
  $$('.prop-preset-size').forEach(btn => {
    btn.onclick = () => {
      saveUndoState();
      const presetW = parseInt(btn.dataset.w) || 100;
      const presetH = parseInt(btn.dataset.h) || 100;
      w.w = presetW;
      w.h = presetH;
      // Update inputs
      if (widthInput) widthInput.value = w.w;
      if (heightInput) heightInput.value = w.h;
      // Update widget visual
      const el = $(`.widget[data-id="${w.id}"]`);
      if (el) {
        el.style.width = w.w + 'px';
        el.style.height = w.h + 'px';
      }
      autoResizeCanvas();
      updateMinimap();
      toast(tr('toast.sizeSet', {w: presetW, h: presetH}), 'success');
    };
  });

  $('#prop_id').onchange = e => {
    const newId = e.target.value.trim();
    if (!newId || state.widgets.some(x => x.id === newId && x !== w)){
      toast(tr('toast.idMustBeUnique'), 'error');
      e.target.value = w.id;
      return;
    }
    const oldId = w.id;
    w.id = newId;

    const root = $(`.widget[data-id="${oldId}"]`);
    if (root) root.dataset.id = newId;

    if (state.values[oldId] != null){
      state.values[newId] = state.values[oldId];
      delete state.values[oldId];
    }

    state.selected = newId;
    updateSelectionUI();
    toast(tr('toast.idUpdated'), 'success');
  };

  // Model wiring (and quick apply to all widgets of same type)
  const modelSel = $('#prop_model');
  if (modelSel){
    modelSel.onchange = e => {
      w.model = e.target.value;
      renderWidgets();
      if (state.config?.widgets?.some(x => x.id === w.id)) renderRuntime();
      toast(tr('toast.modelUpdated'), 'success');
    };
  }
  const applyBtn = $('#prop_applyAll');
  if (applyBtn){
    applyBtn.onclick = () => {
      const val = w.model;
      state.widgets.forEach(x => { if (x.t === w.t) x.model = val; });
      if (state.config?.widgets) state.config.widgets.forEach(x => { if (x.t === w.t) x.model = val; });
      renderWidgets();
      if (state.config) renderRuntime();
      toast(tr('toast.modelAppliedAll', {type: tr('widgets.' + w.t) || w.t}), 'success');
    };
  }


  if (w.t === 'led'){
    $('#prop_colorOn').oninput = e => { w.colorOn = e.target.value; };
    $('#prop_colorOff').oninput = e => { w.colorOff = e.target.value; };
  }

  if (w.t === 'slider'){
    const orientSel = $('#prop_sliderOrient');
    if (orientSel) {
      orientSel.onchange = e => {
        saveUndoState();
        const isVertical = e.target.value === 'vertical';
        const currentW = w.w || 100;
        const currentH = w.h || 100;
        
        // If orientation doesn't match current dimensions, swap them
        const currentIsVertical = currentH > currentW;
        if (isVertical !== currentIsVertical) {
          w.w = currentH;
          w.h = currentW;
          // Update the width/height inputs
          const widthInput = $('#prop_width');
          const heightInput = $('#prop_height');
          if (widthInput) widthInput.value = w.w;
          if (heightInput) heightInput.value = w.h;
        }
        
        renderWidgets();
        updateMinimap();
        toast(isVertical ? '↕ Slider set to vertical' : '↔ Slider set to horizontal', 'success');
      };
    }
    $('#prop_min').oninput = e => { w.min = parseFloat(e.target.value); };
    $('#prop_max').oninput = e => { w.max = parseFloat(e.target.value); };
    $('#prop_step').oninput = e => { w.step = parseFloat(e.target.value); };
  }

  if (w.t === 'group'){
    const members = $('#prop_groupChildren');
    if (members) members.onchange = e => {
      const ids = String(e.target.value || '').split(',').map(x => x.trim()).filter(Boolean);
      setGroupChildren(w, ids, state.widgets);
      renderWidgets();
      renderPropsPanel();
    };
    const capture = $('#prop_captureGroup');
    if (capture) capture.onclick = () => {
      saveUndoState();
      const ids = captureWidgetsInGroup(w, state.widgets);
      renderWidgets();
      renderPropsPanel();
      toast(`▣ Captured ${ids.length} widget${ids.length === 1 ? '' : 's'}`, 'success');
    };
  }

  if (w.t === 'separator'){
    const orient = $('#prop_sepOrientation');
    if (orient) orient.onchange = e => {
      saveUndoState();
      w.orientation = e.target.value;
      const shouldVertical = w.orientation === 'vertical';
      const isVertical = Number(w.h || 0) > Number(w.w || 0);
      if (shouldVertical !== isVertical) [w.w, w.h] = [w.h, w.w];
      renderWidgets();
      renderPropsPanel();
    };
    const thick = $('#prop_sepThickness');
    if (thick) thick.oninput = e => {
      w.thickness = Math.max(1, Math.min(6, parseInt(e.target.value, 10) || 1));
      renderWidgets();
    };
  }

  if (w.t === 'gauge'){
    $('#prop_gmin').oninput = e => { w.min = parseFloat(e.target.value); if (state.config) renderRuntime(); };
    $('#prop_gmax').oninput = e => { w.max = parseFloat(e.target.value); if (state.config) renderRuntime(); };
    $('#prop_gdec').oninput = e => { w.decimals = parseInt(e.target.value, 10); if (state.config) renderRuntime(); };
    $('#prop_gunits').oninput = e => { w.units = e.target.value; if (state.config) renderRuntime(); };
    $('#prop_gwarn').oninput = e => { w.warn = e.target.value === '' ? null : parseFloat(e.target.value); };
    $('#prop_gdanger').oninput = e => { w.danger = e.target.value === '' ? null : parseFloat(e.target.value); };
  }

  if (w.t === 'graph'){
    $('#prop_series').oninput = e => { w.series = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)); if (state.config) renderRuntime(); };
    $('#prop_window').oninput = e => { w.windowSec = Math.max(5, parseInt(e.target.value, 10) || 30); };
    $('#prop_autoscale').onchange = e => { w.autoScale = (e.target.value === '1'); };
    $('#prop_ymin').oninput = e => { w.yMin = parseFloat(e.target.value); };
    $('#prop_ymax').oninput = e => { w.yMax = parseFloat(e.target.value); };
    $('#prop_names').oninput = e => { w.seriesNames = e.target.value; if (state.config) renderRuntime(); };
    $('#prop_ylabel').oninput = e => { w.yLabel = e.target.value; };
  }

  if (w.t === 'image'){
    $('#prop_imageSrc').oninput = e => { w.imageSrc = e.target.value; renderWidgets(); };
    const uploadBtn = $('#prop_uploadImg');
    if (uploadBtn) {
      uploadBtn.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = e => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = ev => {
              w.imageSrc = ev.target.result;
              $('#prop_imageSrc').value = '[Uploaded Image]';
              renderWidgets();
              toast(tr('toast.imageUploaded'), 'success');
            };
            reader.readAsDataURL(file);
          }
        };
        input.click();
      };
    }
  }

  if (w.t === 'battery'){
    const battInput = $('#prop_batteryLevel');
    if (battInput) battInput.oninput = e => { w.level = parseInt(e.target.value); };
  }

  if (w.t === 'timer'){
    const timerDir = $('#prop_timerDir');
    if (timerDir) timerDir.onchange = e => { w.timerDir = e.target.value; };
    const timerStart = $('#prop_timerStart');
    if (timerStart) timerStart.oninput = e => { w.timerStart = parseInt(e.target.value); };
  }

  if (w.t === 'select'){
    const optsInput = $('#prop_options');
    if (optsInput) optsInput.oninput = e => { w.options = e.target.value; if (state.config) renderRuntime(); };
  }

  if (w.t === 'editfield'){
    const ph = $('#prop_placeholder');
    if (ph) ph.oninput = e => { w.placeholder = e.target.value; if (state.config) renderRuntime(); };
  }

  if (w.t === 'sound'){
    const effectSel = $('#prop_soundEffect');
    if (effectSel) effectSel.onchange = e => { w.testEffect = e.target.value; };
    const testBtn = $('#prop_testSound');
    if (testBtn) testBtn.onclick = () => playSoundEffect(w.testEffect || 'beep');
  }

  if (w.t === 'notification'){
    const testBtn = $('#prop_testNotification');
    if (testBtn) testBtn.onclick = () => showRuntimeNotification(w, 'Test notification!');
  }

  // Property edits are part of the same Build history model as drag/resize.
  // Live input can update visuals continuously; commit once on change.
  form.oninput = () => { try { scheduleAutoSave(); } catch (_) {} };
  form.onchange = () => {
    try { saveUndoState(); } catch (_) {}
    try { autoResizeCanvas(); } catch (_) {}
    try { scheduleAutoSave(); } catch (_) {}
  };
}


function deleteSelected() {
  if (!state.selected) { toast(tr('toast.selectWidgetFirst'), 'error'); return; }
  saveUndoState();
  const deleting = state.widgets.find(w => w.id === state.selected);
  if (deleting?.t === 'group') detachGroup(deleting, state.widgets);
  state.widgets = state.widgets.filter(w => w.id !== state.selected);
  state.selected = null;
  renderWidgets();
  renderPropsPanel();
  toast(tr('toast.deleted'), 'success');
  saveUndoState();
}

function showCode() {
  if (state.widgets.length === 0) {
    toast(tr('toast.addWidgetsFirst'), 'error');
    return;
  }
  const cfg = { title: $('#titleInput').value || 'My Remote', widgets: state.widgets };
  $('#modalTitle').innerHTML = esc(tr('codeModal.titleDefault')) + ' <small style="display:block;font-size:0.7rem;font-weight:400;opacity:0.7;margin-top:4px;">' + esc(tr('codeModal.titleSub')) + '</small>';
  $('#modalCode').textContent = generateDemoCode(cfg);
  // Reset flash progress
  const progressEl = $('#flashProgress');
  if (progressEl) progressEl.style.display = 'none';
  $('#modalBg').classList.add('show');
}

function downloadCode() {
  const blob = new Blob([$('#modalCode').textContent], { type: 'text/plain' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'microbit-remote.ts'; a.click();
  toast(tr('toast.downloaded'), 'success');
}

function toast(msg, type = '', duration = 2500) {
  const t = $('#toast'); t.textContent = msg;
  t.className = `toast ${type} show`;
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// Bigger/longer-lived banner for a "notification" widget's incoming UPD
// value — deliberately more prominent than a regular toast() since the
// device is explicitly asking for the user's attention.
function showRuntimeNotification(w, msg){
  let el = document.getElementById('runtimeNotification');
  if (!el) {
    el = document.createElement('div');
    el.id = 'runtimeNotification';
    el.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);'
      + 'background:linear-gradient(135deg,#ff9f1c,#ff5252);color:#fff;padding:12px 20px;'
      + 'border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.4);display:flex;align-items:center;'
      + 'gap:10px;z-index:9999;font-weight:700;font-size:15px;max-width:90vw;';
    document.body.appendChild(el);
  }
  el.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = '🔔 ' + (msg || (w && w.label) || 'Notification');
  el.appendChild(label);
  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText = 'background:transparent;color:#fff;border:none;cursor:pointer;font-size:14px;padding:2px 4px;';
  close.onclick = () => el.remove();
  el.appendChild(close);
  beepWarn();
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.remove(), 5000);
}

// iOS (incl. iPadOS reporting as MacIntel) never implements Web Bluetooth,
// in Safari or any other iOS browser, since they all run on WebKit.
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}



function showBuildOverlay(sub='✨ Building...'){
  const ov = $('#loadingOverlay');
  if (!ov) return;
  ov.classList.add('show');
  ov.setAttribute('aria-hidden','false');
  const subEl = $('#loadingSub'); if (subEl) subEl.textContent = sub;
  const pctEl = $('#loadingPct'); if (pctEl) pctEl.textContent = '';
  const bar = $('#loadingBarFill'); if (bar) bar.style.width = '100%';
}

// Loading overlay helpers
let _loadingIndeterminate = null;
// Elapsed-time clock for the loading overlay. The chunk counter already says
// how far along the transfer is, but at 35ms per chunk a 262-chunk layout takes
// ~9s, and without a moving clock a stalled link looks the same as a slow one.
let _loadingClock = null;
let _loadingStartedAt = 0;
// Stamped when the layout transfer actually begins. Separate from
// _loadingStartedAt because the overlay is already up during connect and
// service discovery, and counting that dead time as transfer time would
// understate the throughput.
let _cfgTransferStartedAt = 0;

function tickLoadingClock(){
  const el = $('#loadingTime');
  if (el) el.textContent = Math.floor((Date.now() - _loadingStartedAt) / 1000) + tr('loadingSec');
  updateLoadingRate();
}

function fmtBytes(n){
  return n < 1024 ? `${Math.round(n)} B` : `${(n / 1024).toFixed(1)} kB`;
}

// Bytes transferred and throughput. Called from the 1s tick as well as on each
// chunk, so the rate keeps updating during a gap instead of freezing on the
// last chunk's value.
function updateLoadingRate(){
  const el = $('#loadingRate');
  if (!el) return;
  const got = (typeof configBuffer === 'string') ? configBuffer.length : 0;
  if (!got || !_cfgTransferStartedAt){ el.textContent = ''; return; }
  // The expected total is derived from the average chunk actually received,
  // not from a hardcoded chunk size: this firmware uses fixed 18-char chunks
  // but the ESP32 sizes its chunks to the negotiated MTU, so any constant here
  // would be wrong on one robot or the other.
  const parts = [];
  if (configTotal > 0 && configChunks > 0) {
    const expected = Math.round((got / configChunks) * configTotal);
    parts.push(`${fmtBytes(got)} ${tr('loadingOf')} ${fmtBytes(expected)}`);
  } else {
    parts.push(fmtBytes(got));
  }
  const secs = (Date.now() - _cfgTransferStartedAt) / 1000;
  if (secs >= 0.5) parts.push(`${fmtBytes(got / secs)}/s`);
  el.textContent = parts.join('  ·  ');
}

function showLoading(title = tr('loadingTitle'), sub = tr('loadingSub')){
  if (!state._allowLoadingOverlay) return;
  const ov = $('#loadingOverlay');
  if (!ov) return;
  ov.classList.add('show');
  ov.setAttribute('aria-hidden','false');
  const subEl = $('#loadingSub'); if (subEl) subEl.textContent = sub;
  const pctEl = $('#loadingPct'); if (pctEl) pctEl.textContent = '0%';
  const bar = $('#loadingBarFill'); if (bar) bar.style.width = '8%';

  _loadingStartedAt = Date.now();
  _cfgTransferStartedAt = 0;
  const rateEl = $('#loadingRate'); if (rateEl) rateEl.textContent = '';
  clearInterval(_loadingClock);
  tickLoadingClock();
  _loadingClock = setInterval(tickLoadingClock, 1000);

  clearInterval(_loadingIndeterminate);
  // fun, kid-friendly "wiggle" while chunks arrive
  let p = 8; let dir = 1;
  _loadingIndeterminate = setInterval(() => {
    p += dir * 3;
    if (p > 22) { p = 22; dir = -1; }
    if (p < 8)  { p = 8;  dir = 1; }
    if (bar) bar.style.width = p + '%';
  }, 220);
}

function setLoadingProgress(pct, sub){
  const bar = $('#loadingBarFill');
  const pctEl = $('#loadingPct');
  const subEl = $('#loadingSub');
  if (subEl && sub) subEl.textContent = sub;
  const clamped = Math.max(0, Math.min(100, pct));
  if (bar) bar.style.width = clamped + '%';
  if (pctEl) pctEl.textContent = Math.round(clamped) + '%';
}

function hideLoading(){
  const ov = $('#loadingOverlay');
  if (!ov) return;
  clearInterval(_loadingIndeterminate);
  _loadingIndeterminate = null;
  clearInterval(_loadingClock);
  _loadingClock = null;
  ov.classList.remove('show');
  ov.setAttribute('aria-hidden','true');
}

// BLE Connection
async function connectBle() {
  console.log('[BLE] Starting connection...');
  if (!navigator.bluetooth) {
    if (isIOS()) {
      toast(tr('toast.iosNoBluetooth'), 'error', 7000);
    } else {
      toast(tr('toast.webBtNotSupported'), 'error', 5000);
    }
    return;
  }
  state._allowLoadingOverlay = true;
  // Declared out here so the catch block can tear down a half-open
  // connection; it is assigned from requestDevice() inside the try.
  let device = null;
  try {
    // Clean up any previous connection before starting a new one. Web
    // Bluetooth's getCharacteristic() returns a fresh wrapper object on
    // every call, even for the same physical characteristic — so the
    // characteristicvaluechanged listener added below is never a no-op
    // duplicate, it's a genuinely new listener stacking on top of any
    // old one still attached to a still-referenced wrapper. Repeated
    // Connect clicks in the same tab (e.g. after a firmware re-upload
    // drops the link) were silently accumulating listeners, so a single
    // real BLE notification fired onNotify() once per stale connection
    // — corrupting the CFG stream with duplicated chunks.
    if (state.ble.notifyChar) {
      state.ble.notifyChar.removeEventListener('characteristicvaluechanged', onNotify);
    }
    if (state.ble.device?.gatt?.connected) {
      state.ble.device.gatt.disconnect();
      // Web Bluetooth needs a moment to actually release the previous
      // connection before a new requestDevice() chooser can reliably
      // open. Calling requestDevice() immediately after disconnect()
      // can silently fail to show the picker (no error, dialog just
      // never appears), which is why reconnecting sometimes takes
      // several clicks — the first click's disconnect hadn't settled
      // by the time it tried to open the next picker.
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Same settle requirement after an EXPLICIT disconnect, where the
    // branch above is skipped because state.ble was already cleared.
    // Reconnecting straight away produced "GATT connected" immediately
    // followed by "NetworkError: GATT Server is disconnected" on the
    // very next call — the stack had not finished tearing the old link
    // down before we asked it to build a new one.
    const sinceDisconnect = Date.now() - lastDisconnectAt;
    if (sinceDisconnect < BLE_SETTLE_MS) {
      await new Promise(resolve => setTimeout(resolve, BLE_SETTLE_MS - sinceDisconnect));
    }

    console.log('[BLE] Requesting device...');
    // Accept ALL devices in the chooser (matches face-tracking app).
    // Filtering by namePrefix 'BBC micro:bit' here was hiding compatible
    // peripherals on some BLE stacks (notably macOS Chrome, where
    // ESP32-impersonator devices that advertise correct UUIDs but a
    // slightly different name-packet shape are silently dropped).
    // We still gate functionality post-connect by trying to acquire
    // UART_SERVICE — non-compatible devices simply fail on getPrimaryService.
    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [UART_SERVICE]
    });
    console.log('[BLE] Device selected:', device.name);
    
    // Claim this device as the live one BEFORE gatt.connect(). The guard
    // below must not key off state.ble.device — that is only assigned
    // after every characteristic lookup succeeds, so during setup it is
    // still null, and a GENUINE disconnect of the device we are actively
    // connecting to would be dismissed as "stale". That is exactly what
    // happened: the drop was swallowed here and then resurfaced several
    // calls later as "NetworkError: GATT Server is disconnected".
    currentDevice = device;
    disconnectHandled = false;

    // Chrome returns the SAME BluetoothDevice object for a given device,
    // so addEventListener here accumulates one listener per connect
    // attempt — that is why a single disconnect logged "Disconnected!"
    // twice. Drop the previous listener before attaching a new one.
    if (device._mqDisconnectListener) {
      device.removeEventListener('gattserverdisconnected', device._mqDisconnectListener);
    }
    const onGattDisconnected = () => {
      if (currentDevice !== device) {
        console.log('[BLE] Ignoring stale disconnect from a previous device');
        return;
      }
      console.log('[BLE] GATT server disconnected event');
      onDisconnect();
    };
    device._mqDisconnectListener = onGattDisconnected;
    device.addEventListener('gattserverdisconnected', onGattDisconnected);
    
    console.log('[BLE] Connecting to GATT server...');
    const server = await withBleTimeout(device.gatt.connect(), 'gatt.connect');
    console.log('[BLE] GATT connected');

    console.log('[BLE] Getting UART service...');
    const service = await withBleTimeout(server.getPrimaryService(UART_SERVICE), 'getPrimaryService');
    console.log('[BLE] UART service found');

    console.log('[BLE] Getting TX characteristic...');
    const notifyChar = await withBleTimeout(service.getCharacteristic(UART_TX_CHAR), 'getCharacteristic TX');
    console.log('[BLE] TX characteristic found');

    console.log('[BLE] Getting RX characteristic...');
    const writeChar = await withBleTimeout(service.getCharacteristic(UART_RX_CHAR), 'getCharacteristic RX');
    console.log('[BLE] RX characteristic found');

    console.log('[BLE] Starting notifications...');
    await withBleTimeout(notifyChar.startNotifications(), 'startNotifications');
    notifyChar.addEventListener('characteristicvaluechanged', onNotify);
    console.log('[BLE] Notifications started');
    
    state.ble = { device, server, service, notifyChar, writeChar, connected: true };
    state.rxBuffer = '';
    // A new live link is not allowed to inherit controls from the previous device
    // or from a disconnected Build preview. Wait for CFGVER/cache validation first.
    clearAllDpadKeepalives(false);
    cleanupRuntimeBindings();
    // A demo simulation started from the Build preview must not survive into a
    // live session, or it keeps writing sine waves over real device telemetry.
    stopDemoSim();
    state.deviceConfig = null;
    state.config = null;
    state.runtimeCanvasSize = null;
    state.runtimeSource = null;
    updateBleUI();
    toast(tr('toast.connected'), 'success');
    
    // v47: do NOT download the same ~2 KB layout on every reconnect.
    // First ask for a tiny config revision. If it matches the cached layout
    // for this exact BluetoothDevice, the app is ready after one short line.
    // Only a missing/mismatched revision falls back to the full GETCFG stream.
    console.log('[BLE] Checking config version...');
    showLoading(tr('loadingTitle'), tr('loadingRequesting'));
    cfgAttempts = 0;
    cfgVersionAttempts = 0;
    pendingCfgVersion = '';
    setTimeout(requestConfigVersion, 150);
    // Keeps the firmware's link-loss timeout fed while nobody is driving.
    startLinkPing();
  } catch (err) {
    console.error('[BLE] Connection error:', err);
    // Tear the half-built connection down. Without this the GATT server
    // stays open on a connection we never finished setting up, and the
    // next attempt inherits exactly the wedged state that made service
    // discovery hang in the first place — which is why retrying by
    // clicking Connect again kept failing at the same step.
    try {
      if (device && device.gatt && device.gatt.connected) {
        console.log('[BLE] Cleaning up half-open GATT connection');
        device.gatt.disconnect();
      }
    } catch (cleanupErr) {
      console.warn('[BLE] Cleanup failed:', cleanupErr.message);
    }
    currentDevice = null;
    lastDisconnectAt = Date.now();
    state._allowLoadingOverlay = false;
    if (typeof hideLoading === 'function') hideLoading();
    toast(tr('toast.connectionFailed'), 'error');
  }
}

// Web Bluetooth's setup calls can hang FOREVER instead of rejecting.
// Observed live: "GATT connected" followed by "Getting UART service..."
// and then nothing at all — getPrimaryService() never resolved and never
// threw, so connectBle() sat inside an await with no error, no timeout
// and no way back. The UI just looked frozen, and clicking Connect again
// only started a second attempt that hung in the same place.
//
// This happens when the peripheral's GATT server is still holding the
// previous session (e.g. the micro:bit never processed the last
// disconnect), so service discovery never completes. Wrapping every
// setup step turns an invisible hang into a real rejection that the
// existing catch block can report and clean up after.
const BLE_OP_TIMEOUT_MS = 8000;
function withBleTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('BLE timeout after ' + BLE_OP_TIMEOUT_MS + 'ms during ' + label));
    }, BLE_OP_TIMEOUT_MS);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err   => { clearTimeout(timer); reject(err); }
    );
  });
}

// The device we are currently connecting to or connected to. Set as
// soon as requestDevice() resolves — before gatt.connect() — so the
// disconnect listener can tell a real drop from a stale one during the
// whole setup window, not just once state.ble has been populated.
let currentDevice = null;
// Guards against onDisconnect() running twice for a single drop: an
// explicit hang-up calls it directly AND the 'gattserverdisconnected'
// event calls it, and previously both got through.
let disconnectHandled = false;
// When the last teardown happened, so a reconnect can wait for the BLE
// stack to settle instead of racing it.
let lastDisconnectAt = 0;
// v46 firmware software-resets its BLE stack after a disconnect. Give the
// peripheral time to reboot/advertise cleanly before opening the next GATT.
const BLE_SETTLE_MS = 1800;

// Explicit hang-up from the app. Dropping the GATT link makes the
// firmware's onBluetoothDisconnected() fire, which stops the motors and
// paints ✗ on the LED matrix. onDisconnect() is called directly rather
// than waiting for the event so the UI updates immediately; whichever
// path arrives second is absorbed by the disconnectHandled guard.
async function disconnectBle() {
  console.log('[BLE] Disconnect requested by user');
  // v46: tell firmware we are intentionally leaving BEFORE dropping GATT.
  // Firmware stops the motors, shows X, and software-resets its BLE stack so
  // the next connection does not require a physical micro:bit reset.
  const device = state.ble.device;
  stopLinkPing();
  clearAllDpadKeepalives();
  try {
    if (device?.gatt?.connected && state.ble.writeChar) {
      await bleWrite('BYE');
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  } catch (err) {
    console.warn('[BLE] BYE handshake failed:', err?.message || err);
  }
  try {
    if (device?.gatt?.connected) device.gatt.disconnect();
  } catch (err) {
    console.warn('[BLE] disconnect() threw:', err.message);
  }
  onDisconnect();
}

function toggleBle() {
  if (state.ble.connected) disconnectBle();
  else connectBle();
}

function onDisconnect() {
  // One drop = one teardown. Both the explicit hang-up and the
  // 'gattserverdisconnected' event route here, and previously both ran,
  // which is why a single disconnect logged "Disconnected!" twice and
  // fired two toasts/beeps.
  if (disconnectHandled) {
    console.log('[BLE] Disconnect already handled, ignoring duplicate');
    return;
  }
  disconnectHandled = true;
  currentDevice = null;
  lastDisconnectAt = Date.now();
  console.log('[BLE] Disconnected!');
  state._allowLoadingOverlay = false;
  if (typeof hideLoading==='function') hideLoading();
  if (state.ble.notifyChar) {
    state.ble.notifyChar.removeEventListener('characteristicvaluechanged', onNotify);
  }
  state.ble = { device:null, server:null, service:null, notifyChar:null, writeChar:null, connected:false };
  forceFullConfigAfterVersion = false;
  // A held direction at drop time would otherwise leave its keepalive
  // running and resume clobbering the send slot on the next connect.
  clearAllDpadKeepalives();
  stopLinkPing();
  cancelConfigRetry();
  cancelConfigVersionRetry();
  pendingCfgVersion = '';
  bleSend.queue.length = 0;
  bleSend.pendingMsg = null;
  updateBleUI();
  hideLoading();
  beepDanger();
  toast(tr('toast.disconnected'), 'error');
}

function updateBleUI() {
  const btn = $('#bleBtn');
  const arrangeBtn = $('#arrangeModeBtn');
  const fullscreenBtn = $('#fullscreenBtn');
  const reloadConfigBtn = $('#reloadConfigBtn');
  // Keep this utility available in Play mode even while disconnected:
  // disconnected click clears remote-layout caches so the next connect
  // cannot take the CFGVER/CFGOK cache-hit path.
  if (reloadConfigBtn) reloadConfigBtn.classList.add('visible');
  if (state.ble.connected) {
    btn.classList.add('connected');
    btn.querySelector('span:last-child').textContent = (I18N[state.lang]||I18N.en).connected;
    const runtimeActive = !!document.querySelector('.runtime-view.active');
    const hasVerifiedRuntime = !!(state.config?.widgets?.length && state.runtimeSource === 'device');
    $('#connectPrompt').style.display = runtimeActive && !hasVerifiedRuntime ? 'block' : 'none';
    $('#runtimeContent').style.display = hasVerifiedRuntime ? 'flex' : 'none';
    if (arrangeBtn) arrangeBtn.classList.toggle('visible', runtimeActive && hasVerifiedRuntime);
    if (fullscreenBtn) fullscreenBtn.classList.toggle('visible', runtimeActive && hasVerifiedRuntime);
    
    // Celebrate connection!
    if (!state._celebrated) {
      state._celebrated = true;
      celebrate('🎉 Connected!');
    }
    
    // Fullscreen is always user-controlled; connecting must not change view mode.
  } else {
    btn.classList.remove('connected');
    btn.querySelector('span:last-child').textContent = (I18N[state.lang]||I18N.en).connect;
    const runtimeActive = !!document.querySelector('.runtime-view.active');
    const hasPreview = !!(state.config?.widgets?.length);
    if (runtimeActive && hasPreview) {
      $('#connectPrompt').style.display = 'none';
      $('#runtimeContent').style.display = 'flex';
    } else {
      $('#connectPrompt').style.display = 'block';
      $('#runtimeContent').style.display = 'none';
    }
    state._celebrated = false;
    if (state.arrangeMode) {
      if (state.runtimeSource === 'build') { try { syncRuntimeToBuild(); } catch (_) {} }
      state.arrangeMode = false;
      try { teardownArrangeMode(); } catch (_) {}
      const grid = $('#runtimeGrid');
      if (grid) grid.classList.remove('arrange-mode');
      const hint = $('#arrangeHint');
      if (hint) hint.style.display = 'none';
    }
    if (arrangeBtn) {
      arrangeBtn.classList.toggle('visible', runtimeActive && hasPreview);
      arrangeBtn.classList.remove('active');
      arrangeBtn.textContent = tr('arrange');
    }
    if (fullscreenBtn) fullscreenBtn.classList.toggle('visible', runtimeActive && hasPreview);
    const rtJson = $('#runtimeExportJsonBtn'); if (rtJson) rtJson.classList.remove('visible');
    const rtCfg = $('#runtimeExportMakeCodeBtn'); if (rtCfg) rtCfg.classList.remove('visible');
  }
}

let configBuffer = '';
var configChunks = 0;
// Total chunk count announced by "CFGBEGIN <n>". 0 means the firmware did not
// say (older builds, or the micro:bit), in which case the progress bar falls
// back to the old open-ended guess.
var configTotal = 0;

// ═══════════════════════════════════════════════════════════════
// ⚡ v47 CONFIG REVISION CACHE
// ═══════════════════════════════════════════════════════════════
//
// v46 made reconnect reliable, but every session still paid for the exact
// same CFGBEGIN + ~125 CFG chunks + CFGEND transfer. That is unnecessary:
// the remote layout changes rarely, while reconnecting happens often.
//
// New handshake:
//   App -> robot     GETCFGVER
//   Robot -> app     CFGVER 56caff8f        (tiny, one notification)
//   cache matches -> App -> robot CFGOK 56caff8f
//   cache differs  -> App -> robot GETCFG   (full transfer only then)
//
// The cache is keyed by BluetoothDevice.id, not just the display name, so two
// robots named "BBC micro:bit" do not accidentally share layouts. The robot
// remains the source of truth: a different revision automatically invalidates
// the cache. If localStorage is unavailable/corrupt, we simply fall back to
// GETCFG — correctness first, speed second.
// Cache key is robot-neutral: this app serves every rxy robot, and each one's
// entry is already namespaced by its own config revision.
const REMOTE_CFG_CACHE_PREFIX = 'rxy_cfg_v1:';
let pendingCfgVersion = '';

function remoteCfgCacheKey() {
  const d = state.ble.device;
  if (!d) return null;
  return REMOTE_CFG_CACHE_PREFIX + String(d.id || d.name || 'unknown');
}

function loadCachedRemoteConfig(version) {
  if (!version) return null;
  const key = remoteCfgCacheKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || rec.version !== version || !rec.config || !Array.isArray(rec.config.widgets)) {
      return null;
    }
    // v52 auto-derived revisions start with "d". Recompute the cached payload
    // fingerprint before trusting it, so corrupt/stale localStorage is rejected.
    if (String(version).startsWith('d')) {
      const expected = cfgRevisionFromBase64(unicodeBase64(JSON.stringify(rec.config)));
      if (expected !== version) {
        console.warn('[BLE] Cached config fingerprint mismatch; discarding stale cache');
        localStorage.removeItem(key);
        return null;
      }
    }
    return rec.config;
  } catch (e) {
    console.warn('[BLE] Config cache read failed:', e);
    return null;
  }
}

function saveCachedRemoteConfig(version, config) {
  if (!version || !config || !Array.isArray(config.widgets)) return;
  const key = remoteCfgCacheKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      version,
      config,
      savedAt: Date.now()
    }));
    console.log('[BLE] Cached remote config revision', version);
  } catch (e) {
    console.warn('[BLE] Config cache write failed:', e);
  }
}

// v48.3: explicit cache bypass / hard config refresh, always visible in header.
// The robot remains the source of truth; this clears only the remote-layout
// cache, not language/theme/projects or any other browser settings.
function clearCurrentRemoteConfigCache() {
  const key = remoteCfgCacheKey();
  if (!key) return false;
  try {
    localStorage.removeItem(key);
    console.log('[BLE] Cleared remote config cache:', key);
    return true;
  } catch (e) {
    console.warn('[BLE] Config cache clear failed:', e);
    return false;
  }
}

function clearAllRemoteConfigCaches() {
  let removed = 0;
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(REMOTE_CFG_CACHE_PREFIX)) keys.push(key);
    }
    keys.forEach(key => { localStorage.removeItem(key); removed++; });
    console.log('[BLE] Cleared', removed, 'remote config cache record(s)');
  } catch (e) {
    console.warn('[BLE] Remote config cache clear failed:', e);
  }
  return removed;
}

// Set only when we must learn CFGVER first but still want a full GETCFG.
let forceFullConfigAfterVersion = false;

function forceReloadRemoteConfig() {
  // When disconnected there is no BluetoothDevice.id in state. Clear only
  // remote-layout cache records; the next connection must therefore GETCFG.
  if (!state.ble.connected) {
    // v48.3: this button is a real one-step hard refresh. Clearing the cache
    // while disconnected used to leave the user staring at an empty Build
    // screen with no obvious next action. Because this function runs directly
    // from the button click, requestDevice() still has browser user activation.
    // After the user selects the micro:bit there can be no CFGVER cache hit, so
    // the normal connect handshake must fall through to a full GETCFG.
    clearAllRemoteConfigCaches();
    toast(tr('toast.configCacheCleared'), 'success');
    return connectBle();
  }

  // Preserve the revision we already learned this session so the freshly
  // downloaded CFG can immediately be cached again under the same revision.
  // If revision is unknown (e.g. older/odd firmware), force the version probe
  // first and bypass its normal cache-hit path exactly once.
  clearCurrentRemoteConfigCache();
  cancelConfigVersionRetry();
  cancelConfigRetry();

  // A hard refresh explicitly says the current device CFG may be stale. Do not
  // leave those old controls live while the replacement is downloading: a moved
  // or renamed widget could otherwise send the wrong command. Treat reload like
  // the connect verification boundary and reveal Play again only after CFGEND.
  clearAllDpadKeepalives(true);
  cleanupRuntimeBindings();
  state.deviceConfig = null;
  state.config = null;
  state.runtimeCanvasSize = null;
  state.runtimeSource = null;
  updateBleUI();

  state.rxBuffer = '';
  configBuffer = '';
  configChunks = 0;
  cfgAttempts = 0;
  cfgVersionAttempts = 0;

  state._allowLoadingOverlay = true;
  showLoading(tr('loadingTitle'), tr('loadingReceiving'));
  setLoadingProgress(5, tr('loadingRequesting'));
  toast(tr('toast.configReloading'), 'success');

  if (pendingCfgVersion) {
    // True hard refresh: bypass cache/version decision and ask the firmware
    // for CFGBEGIN/CFG/CFGEND immediately.
    forceFullConfigAfterVersion = false;
    requestConfig();
  } else {
    forceFullConfigAfterVersion = true;
    requestConfigVersion();
  }
}

// Shared success path for a freshly downloaded config and a cache hit.
// Cache hits deliberately skip the "Edit in Build" banner: reconnecting should
// feel instant and quiet, not repeat UI meant for a newly discovered layout.
function activateRemoteConfig(config, fromCache = false) {
  state.deviceConfig = cloneSerializable(config);
  state.config = cloneSerializable(config);
  state.runtimeSource = 'device';

  // v51: the MakeCode CFG may define the reference canvas geometry too.
  // This keeps widget positions/sizes reproducible across compatible apps
  // instead of letting each client infer a different canvas from max extents.
  if (config?.canvas &&
      Number.isFinite(Number(config.canvas.w)) &&
      Number.isFinite(Number(config.canvas.h))) {
    state.runtimeCanvasSize = {
      w: Math.max(300, Number(config.canvas.w)),
      h: Math.max(200, Number(config.canvas.h))
    };
  } else {
    state.runtimeCanvasSize = null;
  }

  if (state.config?.widgets) state.config.widgets.forEach(applyWidgetDefaults);
  state.deviceConfig = cloneSerializable(state.config);
  console.log(fromCache ? '[BLE] Config restored from cache:' : '[BLE] Config decoded:', state.config);
  renderRuntime();
  // Both paths land here -- a fresh transfer and a cache hit alike -- so the
  // remembered values are replayed exactly once per connection, after the
  // controls they belong to actually exist.
  ctrlRestoreAll();
  setLoadingProgress(100, tr('loadingReady'));
  state._allowLoadingOverlay = false;
  hideLoading();
  toast(tr('toast.remoteLoaded'), 'success');
  switchTab('runtime', { skipFullscreen: true, skipConfigRebuild: true });
  if (!fromCache) offerLoadCfgIntoBuild(state.config);
}

// Fast revision probe. Three short retries cover a lost first UART packet.
// If the firmware is older than v47 and never understands GETCFGVER, fall back
// to the existing GETCFG path so the app remains backwards-compatible.
let cfgVersionRetryTimer = null;
let cfgVersionAttempts = 0;
const CFGVER_RETRY_MS = 900;
const CFGVER_MAX_ATTEMPTS = 3;

function requestConfigVersion() {
  if (!state.ble.connected) {
    console.warn('[BLE] requestConfigVersion skipped — not connected');
    return;
  }
  cfgVersionAttempts++;
  console.log('[BLE] Sending GETCFGVER (attempt ' + cfgVersionAttempts + ')');
  sendReliable('GETCFGVER');
  clearTimeout(cfgVersionRetryTimer);
  cfgVersionRetryTimer = setTimeout(() => {
    if (!state.ble.connected) return;
    if (cfgVersionAttempts >= CFGVER_MAX_ATTEMPTS) {
      console.warn('[BLE] No CFGVER reply; falling back to full GETCFG');
      pendingCfgVersion = '';
      cfgAttempts = 0;
      requestConfig();
      return;
    }
    requestConfigVersion();
  }, CFGVER_RETRY_MS);
}

function cancelConfigVersionRetry() {
  clearTimeout(cfgVersionRetryTimer);
  cfgVersionRetryTimer = null;
}

// Full config transfer is now the fallback, not the default reconnect path.
// It is still retained for first connect, changed layouts, cleared browser
// cache, corrupted cache, and older firmware.
let cfgRetryTimer = null;
let cfgAttempts = 0;
const CFG_RETRY_MS = 3000;
const CFG_MAX_ATTEMPTS = 4;

function requestConfig() {
  if (!state.ble.connected) {
    console.warn('[BLE] requestConfig skipped — not connected');
    return;
  }
  cancelConfigVersionRetry();
  cfgAttempts++;
  state.rxBuffer = '';
  configBuffer = '';
  configChunks = 0;
  console.log('[BLE] Sending GETCFG (attempt ' + cfgAttempts + ')');
  sendReliable('GETCFG');
  clearTimeout(cfgRetryTimer);
  cfgRetryTimer = setTimeout(() => {
    if (!state.ble.connected) return;
    if (cfgAttempts >= CFG_MAX_ATTEMPTS) {
      console.error('[BLE] No CFGBEGIN after ' + cfgAttempts + ' attempts, giving up');
      hideLoading();
      toast(tr('toast.connectionFailed'), 'error');
      return;
    }
    console.warn('[BLE] No CFGBEGIN within ' + CFG_RETRY_MS + 'ms, retrying GETCFG');
    requestConfig();
  }, CFG_RETRY_MS);
}

function cancelConfigRetry() {
  clearTimeout(cfgRetryTimer);
  cfgRetryTimer = null;
}

function onNotify(event) {
  const value = event.target.value;
  let str = '';
  for (let i = 0; i < value.byteLength; i++) {
    const byte = value.getUint8(i);
    if (byte !== 13) str += String.fromCharCode(byte);
  }
  console.log('[BLE RX] Received:', str.replace(/\n/g, '\\n'));
  state.rxBuffer += str;
  let nl;
  while ((nl = state.rxBuffer.indexOf('\n')) !== -1) {
    const line = state.rxBuffer.slice(0, nl).trim();
    state.rxBuffer = state.rxBuffer.slice(nl + 1);
    if (line) processLine(line);
  }
}

function processLine(line) {
  console.log('[BLE] Processing line:', line);

  if (line.startsWith('CFGVER ')) {
    cancelConfigVersionRetry();
    const version = line.substring(7).trim();
    pendingCfgVersion = version;
    console.log('[BLE] Robot config revision:', version);

    if (forceFullConfigAfterVersion) {
      console.log('[BLE] Forced refresh requested — bypassing cache and sending GETCFG');
      forceFullConfigAfterVersion = false;
      cfgAttempts = 0;
      requestConfig();
      return;
    }

    const cached = loadCachedRemoteConfig(version);
    if (cached) {
      console.log('[BLE] Config revision unchanged — skipping GETCFG');
      activateRemoteConfig(cached, true);
      // This ACK is important: firmware gates autonomous modes + telemetry on
      // cfgSent/config-ready. A cache hit must advance that state even though
      // no CFGBEGIN/CFG/CFGEND stream occurred this session.
      sendReliable('CFGOK ' + version);
    } else {
      console.log('[BLE] No matching cache — downloading layout once');
      cfgAttempts = 0;
      requestConfig();
    }
  }
  else if (line.startsWith('CFGBEGIN')) {
    // Firmware may append the chunk count: "CFGBEGIN 228". Anything that does
    // not send it still matches this branch, so configTotal simply stays 0.
    _cfgTransferStartedAt = Date.now();
    const announced = parseInt(line.slice(8).trim(), 10);
    configTotal = Number.isFinite(announced) && announced > 0 ? announced : 0;
    console.log('[BLE] Config begin, expecting', configTotal || 'unknown', 'chunks');
    cancelConfigRetry();   // firmware answered — stop the retry timer
    configBuffer = '';
    configChunks = 0;
  }
  else if (line.startsWith('CFG ')) {
    // Also cancel here, not only on CFGBEGIN: if CFGBEGIN itself is
    // dropped, chunks still prove the firmware is answering, and a
    // retry mid-stream would corrupt the transfer.
    cancelConfigRetry();
    configBuffer += line.substring(4);
    configChunks++;
    // Covers a dropped CFGBEGIN: chunks alone still start the clock.
    if (!_cfgTransferStartedAt) _cfgTransferStartedAt = Date.now();
    // With a known total this is a true fraction of the transfer. Without one
    // the old guess (12 + 4/chunk) is kept, but that pins at 90% after chunk 20
    // and a big layout can be 200+ chunks, which reads as a stalled bar.
    if (configTotal > 0) {
      const pct = 12 + Math.round(78 * Math.min(1, configChunks / configTotal));
      setLoadingProgress(pct, `${tr('loadingReceiving')} (${configChunks} ${tr('loadingOf')} ${configTotal})`);
    } else {
      setLoadingProgress(Math.min(90, 12 + configChunks * 4), `${tr('loadingReceiving')} (${configChunks})`);
    }
    updateLoadingRate();
    console.log('[BLE] Config chunk, total length:', configBuffer.length);
  }
  else if (line === 'CFGEND') {
    console.log('[BLE] Config end, decoding...');
    cancelConfigRetry();
    setLoadingProgress(96, tr('loadingDecoding'));
    try {
      // Unicode-safe base64 decoding (handles emojis!)
      const decodedConfig = JSON.parse(decodeURIComponent(escape(atob(configBuffer))));
      // CFGVER was received before GETCFG in v47. Save only after the full
      // stream parses successfully, so a partial/corrupt transfer can never
      // poison future reconnects.
      saveCachedRemoteConfig(pendingCfgVersion, decodedConfig);
      activateRemoteConfig(decodedConfig, false);
    }
    catch(e) { console.error('[BLE] Config parse error:', e); hideLoading();
      toast(tr('toast.configError'), 'error'); }
  } else if (line.startsWith('UPD ')) {
    const parts = line.substring(4).split(' ');
    const id = parts[0];
    const val = parts.slice(1).join(' ');
    console.log('[BLE] Update widget:', id, '=', val);
    state.values[id] = val;
    updateRuntimeWidget(id, val);
  }
}

function registerRuntimeBindingCleanup(fn) {
  if (typeof fn === 'function') state.runtimeBindingCleanups.push(fn);
}

function cleanupRuntimeBindings() {
  const list = Array.isArray(state.runtimeBindingCleanups) ? state.runtimeBindingCleanups.splice(0) : [];
  list.forEach(fn => { try { fn(); } catch (e) { console.warn('[Play] binding cleanup failed:', e); } });
}

function runtimeInteractionBlocked(e) {
  if (!state.arrangeMode) return false;
  if (e) { try { e.preventDefault(); e.stopPropagation(); } catch (_) {} }
  return true;
}

function renderRuntime() {
  if (!state.config) return;
  document.getElementById('playViewControls')?.classList.add('visible');
  // The widget DOM is about to be replaced. D-pad keepalive timers are
  // not tied to their button elements, so without this they'd outlive
  // the rebuild and keep sending for buttons that no longer exist.
  clearAllDpadKeepalives(true);
  cleanupRuntimeBindings();
  const cfg = state.config;
  normalizeGroupMembership(cfg.widgets);
  // Add "Powered by Workshop-Diy" branding
  const title = cfg.title || 'My Remote';
  const titleEl = $('#runtimeTitle');
  titleEl.innerHTML = `${esc(title)} <span class="powered-by"><img src="assets/workshop-diy-logo.svg" alt="Workshop-DIY" class="branding-logo">Powered by Workshop-Diy</span>`;
  const grid = $('#runtimeGrid');
  let maxX = 0, maxY = 0;
  cfg.widgets.forEach(w => { maxX = Math.max(maxX, w.x + w.w); maxY = Math.max(maxY, w.y + w.h); });
  
  // Use saved canvas size or calculate from widgets - with reasonable limits
  const canvasW = state.runtimeCanvasSize?.w || cfg.canvas?.w || Math.max(350, maxX + 20);
  const canvasH = state.runtimeCanvasSize?.h || cfg.canvas?.h || Math.max(300, maxY + 20);
  grid.style.width = `${canvasW}px`;
  grid.style.height = `${canvasH}px`;
  // v2.12: runtimeGrid is absolutely positioned inside an explicit viewport
  // frame. Seed the frame before the next animation frame so renderRuntime()
  // never collapses or flashes at 0x0 while Play zoom initializes.
  const runtimeFrame = document.getElementById('runtimeCanvasViewport');
  if (runtimeFrame) {
    const z = Math.max(0.1, Number(state.playZoom) || 1);
    runtimeFrame.style.width = `${canvasW * z}px`;
    runtimeFrame.style.height = `${canvasH * z}px`;
    runtimeFrame.style.overflow = 'hidden';
    grid.style.position = 'absolute';
    grid.style.left = '0px';
    grid.style.top = '0px';
    grid.style.margin = '0';
    grid.style.transformOrigin = 'top left';
    grid.style.transform = `scale(${z})`;
  }
  grid.innerHTML = '';
  
  // Add canvas resize handle and size badge
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'canvas-resize-handle';
  grid.appendChild(resizeHandle);
  
  const sizeBadge = document.createElement('div');
  sizeBadge.className = 'runtime-size-badge';
  sizeBadge.textContent = `${canvasW} × ${canvasH}`;
  grid.appendChild(sizeBadge);
  
  cfg.widgets.filter(w => !w.hidden).forEach(w => {
    const el = document.createElement('div');
    el.className = 'rt-widget rt-type-' + w.t; el.dataset.id = w.id;
    el.dataset.type = w.t;
    el.style.cssText = `left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px;z-index:${w.t === 'group' ? 0 : 1}`;
    el.innerHTML = createRuntimeWidget(w) + '<div class="rt-resize-handle" style="display:none;"></div>';
    grid.appendChild(el);
    bindRuntimeWidget(el, w);
  });

  // Initial draw for graphs & gauges
  cfg.widgets.filter(w => !w.hidden).forEach(w => {
    applyWidgetDefaults(w);
    if (w.t === 'graph') drawGraphWidget(w);
    if (w.t === 'gauge') updateGaugeWidget(w, getRuntimeWidgetValue(w));
  });
  
  // Re-apply arrange mode if it was active
  if (state.arrangeMode) {
    setupArrangeMode();
  }
}

// === RUNTIME ARRANGE MODE ===
function toggleArrangeMode() {
  state.arrangeMode = !state.arrangeMode;
  const btn = $('#arrangeModeBtn');
  const grid = $('#runtimeGrid');
  const hint = $('#arrangeHint');
  
  if (state.arrangeMode) {
    // Arrange is an editor, never a robot-control surface. Stop any held D-pad
    // state before exposing drag handles, then block runtime controls below.
    clearAllDpadKeepalives(true);
    // Arrange edits logical coordinates. Disable Fit's crop first so dragging cannot
    // make a widget disappear outside the cropped presentation frame.
    try { window.appZoom?.setZoom?.(state.playZoom || 1); } catch (_) {}
    btn.classList.add('active');
    btn.textContent = tr('arrangeDone');
    grid.classList.add('arrange-mode');
    hint.style.display = 'block';

    // Show resize handles
    grid.querySelectorAll('.rt-resize-handle').forEach(h => h.style.display = 'block');

    setupArrangeMode();
    const rtJson = $('#runtimeExportJsonBtn'); if (rtJson) rtJson.classList.add('visible');
    const rtCfg = $('#runtimeExportMakeCodeBtn'); if (rtCfg) rtCfg.classList.add('visible');
    toast(tr('toast.arrangeModeOn'), 'success');
  } else {
    btn.classList.remove('active');
    btn.textContent = tr('arrange');
    grid.classList.remove('arrange-mode');
    hint.style.display = 'none';

    // Hide resize handles
    grid.querySelectorAll('.rt-resize-handle').forEach(h => h.style.display = 'none');

    teardownArrangeMode();
    const rtJson = $('#runtimeExportJsonBtn'); if (rtJson) rtJson.classList.remove('visible');
    const rtCfg = $('#runtimeExportMakeCodeBtn'); if (rtCfg) rtCfg.classList.remove('visible');

    // Sync explicit Arrange edits back to Build when this Play session came
    // from Build. Device-loaded layouts stay independent unless explicitly loaded
    // into Build via the existing Edit-in-Build action.
    syncRuntimeToBuild();
    // Re-fit only when Arrange was closed inside Play. If the user clicked the
    // Build tab, switchTab() has already activated Build and its own zoom/view
    // must be preserved rather than being unexpectedly replaced by Fit Design.
    requestAnimationFrame(() => {
      if (!document.querySelector('.runtime-view.active')) return;
      try { window.appZoom?.zoomFit?.(); } catch (_) {}
    });

    toast(tr('toast.layoutSaved'), 'success');
  }
}

function setupArrangeMode() {
  const grid = $('#runtimeGrid');
  if (!grid) return;
  
  // Setup canvas resize
  const canvasHandle = grid.querySelector('.canvas-resize-handle');
  if (canvasHandle && !canvasHandle._resizeSetup) {
    canvasHandle._resizeSetup = true;
    let isResizingCanvas = false;
    let canvasStartX, canvasStartY, canvasStartW, canvasStartH;
    
    const onCanvasResizeStart = (e) => {
      if (!state.arrangeMode) return;
      e.preventDefault();
      e.stopPropagation();
      isResizingCanvas = true;
      
      const touch = e.touches ? e.touches[0] : e;
      canvasStartX = touch.clientX;
      canvasStartY = touch.clientY;
      canvasStartW = parseInt(grid.style.width) || 400;
      canvasStartH = parseInt(grid.style.height) || 320;
    };
    
    const onCanvasResizeMove = (e) => {
      if (!isResizingCanvas || !state.arrangeMode) return;
      e.preventDefault();
      
      const touch = e.touches ? e.touches[0] : e;
      const scale = Math.max(0.1, Number(state.playZoom) || 1);
      const dx = (touch.clientX - canvasStartX) / scale;
      const dy = (touch.clientY - canvasStartY) / scale;
      
      const newW = Math.max(300, canvasStartW + dx);
      const newH = Math.max(200, canvasStartH + dy);
      
      grid.style.width = newW + 'px';
      grid.style.height = newH + 'px';
      
      // Update size badge
      const badge = grid.querySelector('.runtime-size-badge');
      if (badge) badge.textContent = `${newW} × ${newH}`;
    };
    
    const onCanvasResizeEnd = () => {
      if (!isResizingCanvas) return;
      isResizingCanvas = false;
      
      // Save canvas size
      state.runtimeCanvasSize = {
        w: parseInt(grid.style.width) || 400,
        h: parseInt(grid.style.height) || 320
      };
      // Keep the live config self-describing after Arrange-mode resizing.
      if (state.config) state.config.canvas = { ...state.runtimeCanvasSize };
    };
    
    canvasHandle.addEventListener('mousedown', onCanvasResizeStart);
    canvasHandle.addEventListener('touchstart', onCanvasResizeStart, { passive: false });
    document.addEventListener('mousemove', onCanvasResizeMove);
    document.addEventListener('touchmove', onCanvasResizeMove, { passive: false });
    document.addEventListener('mouseup', onCanvasResizeEnd);
    document.addEventListener('touchend', onCanvasResizeEnd);
    
    canvasHandle._cleanup = () => {
      canvasHandle.removeEventListener('mousedown', onCanvasResizeStart);
      canvasHandle.removeEventListener('touchstart', onCanvasResizeStart);
      document.removeEventListener('mousemove', onCanvasResizeMove);
      document.removeEventListener('touchmove', onCanvasResizeMove);
      document.removeEventListener('mouseup', onCanvasResizeEnd);
      document.removeEventListener('touchend', onCanvasResizeEnd);
    };
  }
  
  grid.querySelectorAll('.rt-widget').forEach(el => {
    // Skip if already set up
    if (el._arrangeSetup) return;
    el._arrangeSetup = true;
    
    const wid = el.dataset.id;
    let startX, startY, startLeft, startTop;
    let groupChildStarts = [];
    let isDragging = false;
    
    // Touch/Mouse drag
    const onStart = (e) => {
      if (!state.arrangeMode) return;
      if (e.target.closest('.rt-resize-handle')) return;
      
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      el.classList.add('dragging');
      
      const touch = e.touches ? e.touches[0] : e;
      startX = touch.clientX;
      startY = touch.clientY;
      startLeft = parseInt(el.style.left) || 0;
      startTop = parseInt(el.style.top) || 0;
      const def = state.config?.widgets?.find(w => w.id === wid);
      groupChildStarts = def?.t === 'group' ? widgetChildren(def, state.config.widgets).map(child => {
        const childEl = grid.querySelector(`.rt-widget[data-id="${CSS.escape(child.id)}"]`);
        return { child, el: childEl, left: Number(child.x || 0), top: Number(child.y || 0) };
      }) : [];
    };
    
    const onMove = (e) => {
      if (!isDragging || !state.arrangeMode) return;
      e.preventDefault();
      
      const touch = e.touches ? e.touches[0] : e;
      const scale = Math.max(0.1, Number(state.playZoom) || 1);
      const dx = (touch.clientX - startX) / scale;
      const dy = (touch.clientY - startY) / scale;
      
      const newLeft = Math.max(0, startLeft + dx);
      const newTop = Math.max(0, startTop + dy);
      
      el.style.left = newLeft + 'px';
      el.style.top = newTop + 'px';
      groupChildStarts.forEach(rec => {
        const left = Math.max(0, rec.left + dx);
        const top = Math.max(0, rec.top + dy);
        if (rec.el) { rec.el.style.left = left + 'px'; rec.el.style.top = top + 'px'; }
      });
    };
    
    const onEnd = (e) => {
      if (!isDragging) return;
      isDragging = false;
      el.classList.remove('dragging');
      
      // Update config
      if (state.config) {
        const w = state.config.widgets.find(w => w.id === wid);
        if (w) {
          w.x = parseInt(el.style.left) || 0;
          w.y = parseInt(el.style.top) || 0;
          if (w.t === 'group') {
            groupChildStarts.forEach(rec => {
              if (!rec.el) return;
              rec.child.x = parseInt(rec.el.style.left) || 0;
              rec.child.y = parseInt(rec.el.style.top) || 0;
            });
          }
        }
      }
      
      // Update grid size if widget moved outside
      updateRuntimeGridSize();
    };
    
    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
    
    // Store cleanup functions
    el._arrangeCleanup = () => {
      el.removeEventListener('mousedown', onStart);
      el.removeEventListener('touchstart', onStart);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchend', onEnd);
    };
    
    // Resize handle
    const handle = el.querySelector('.rt-resize-handle');
    if (handle) {
      let isResizing = false;
      let resizeStartX, resizeStartY, resizeStartW, resizeStartH;
      
      const onResizeStart = (e) => {
        if (!state.arrangeMode) return;
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        
        const touch = e.touches ? e.touches[0] : e;
        resizeStartX = touch.clientX;
        resizeStartY = touch.clientY;
        resizeStartW = parseInt(el.style.width) || 100;
        resizeStartH = parseInt(el.style.height) || 100;
      };
      
      const onResizeMove = (e) => {
        if (!isResizing || !state.arrangeMode) return;
        e.preventDefault();
        
        const touch = e.touches ? e.touches[0] : e;
        const scale = Math.max(0.1, Number(state.playZoom) || 1);
        const dx = (touch.clientX - resizeStartX) / scale;
        const dy = (touch.clientY - resizeStartY) / scale;
        
        const def = state.config?.widgets?.find(w => w.id === wid);
        const minDim = def?.t === 'separator' ? 8 : 50;
        const newW = Math.max(minDim, resizeStartW + dx);
        const newH = Math.max(minDim, resizeStartH + dy);
        
        el.style.width = newW + 'px';
        el.style.height = newH + 'px';
      };
      
      const onResizeEnd = () => {
        if (!isResizing) return;
        isResizing = false;
        
        // Update config
        if (state.config) {
          const w = state.config.widgets.find(w => w.id === wid);
          if (w) {
            w.w = parseInt(el.style.width) || 100;
            w.h = parseInt(el.style.height) || 100;
          }
        }
        
        updateRuntimeGridSize();
      };
      
      handle.addEventListener('mousedown', onResizeStart);
      handle.addEventListener('touchstart', onResizeStart, { passive: false });
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('touchmove', onResizeMove, { passive: false });
      document.addEventListener('mouseup', onResizeEnd);
      document.addEventListener('touchend', onResizeEnd);
      
      handle._resizeCleanup = () => {
        handle.removeEventListener('mousedown', onResizeStart);
        handle.removeEventListener('touchstart', onResizeStart);
        document.removeEventListener('mousemove', onResizeMove);
        document.removeEventListener('touchmove', onResizeMove);
        document.removeEventListener('mouseup', onResizeEnd);
        document.removeEventListener('touchend', onResizeEnd);
      };
    }
  });
}

function teardownArrangeMode() {
  const grid = $('#runtimeGrid');
  if (!grid) return;
  
  // Cleanup canvas resize
  const canvasHandle = grid.querySelector('.canvas-resize-handle');
  if (canvasHandle && canvasHandle._cleanup) {
    canvasHandle._cleanup();
    canvasHandle._cleanup = null;
    canvasHandle._resizeSetup = false;
  }
  
  grid.querySelectorAll('.rt-widget').forEach(el => {
    if (el._arrangeCleanup) {
      el._arrangeCleanup();
      el._arrangeCleanup = null;
    }
    el._arrangeSetup = false;
    
    const handle = el.querySelector('.rt-resize-handle');
    if (handle && handle._resizeCleanup) {
      handle._resizeCleanup();
      handle._resizeCleanup = null;
    }
  });
}

function updateRuntimeGridSize() {
  const grid = $('#runtimeGrid');
  if (!grid || !state.config) return;

  let maxX = 0, maxY = 0;
  state.config.widgets.filter(w => !w.hidden).forEach(w => {
    maxX = Math.max(maxX, Number(w.x || 0) + Number(w.w || 0));
    maxY = Math.max(maxY, Number(w.y || 0) + Number(w.h || 0));
  });

  // Arrange may expand the canvas when a control is moved/resized beyond its edge,
  // but it never shrinks the canvas implicitly. Shrinking is an explicit Build
  // operation (Trim Canvas), which keeps mode transitions deterministic.
  const cur = state.runtimeCanvasSize || state.config.canvas || {
    w: parseFloat(grid.style.width) || 400,
    h: parseFloat(grid.style.height) || 320
  };
  const next = {
    w: Math.max(300, Number(cur.w) || 0, Math.ceil(maxX + 20)),
    h: Math.max(200, Number(cur.h) || 0, Math.ceil(maxY + 20))
  };
  state.runtimeCanvasSize = next;
  state.config.canvas = { ...next };
  grid.style.width = `${next.w}px`;
  grid.style.height = `${next.h}px`;
  try { window.appZoom?.setZoom?.(state.playZoom || 1); } catch (_) {}
}

function syncRuntimeToBuild() {
  if (!state.config || !state.config.widgets) return;
  if (state.runtimeSource !== 'build') return;

  try { saveUndoState(); } catch (_) {}
  state.config.widgets.forEach(rtW => {
    const buildW = state.widgets.find(w => w.id === rtW.id);
    if (buildW) {
      buildW.x = Number(rtW.x) || 0;
      buildW.y = Number(rtW.y) || 0;
      buildW.w = Number(rtW.w) || buildW.w;
      buildW.h = Number(rtW.h) || buildW.h;
    }
  });
  const canvas = state.runtimeCanvasSize || state.config.canvas;
  if (canvas?.w && canvas?.h) state.buildCanvasSize = { w:Math.round(Number(canvas.w)), h:Math.round(Number(canvas.h)) };

  renderWidgets();
  applyBuildCanvasView();
  scheduleAutoSave();
}



// v48.1 — CONFIG-NATIVE GAUGE LINKING
// A gauge may declare `source:"slider_id"` in the MakeCode-delivered CFG.
// The web app does NOT create a second gauge. It only mirrors that source
// value into the real configured gauge for instant visual feedback; firmware
// UPD packets remain authoritative and keep other clients compatible too.
function getRuntimeWidgetValue(w) {
  if (Object.prototype.hasOwnProperty.call(state.values, w.id)) return String(state.values[w.id]);
  if (w.t === 'gauge' && w.source) {
    if (Object.prototype.hasOwnProperty.call(state.values, w.source)) return String(state.values[w.source]);
    const src = state.config?.widgets?.find(x => x.id === w.source);
    if (src && src.value !== undefined) return String(src.value);
  }
  if (w.value !== undefined) return String(w.value);
  return '0';
}

function mirrorConfiguredGaugeSources(sourceId, value) {
  if (!state.config?.widgets) return;
  const text = String(value);
  state.config.widgets.forEach(g => {
    if (g.t !== 'gauge' || g.source !== sourceId) return;
    state.values[g.id] = text;
    const gaugeEl = document.querySelector(`.rt-widget[data-id="${g.id}"]`);
    if (gaugeEl) updateGaugeWidget(g, text);
  });
}

function createRuntimeWidget(w) {
  const rawVal = getRuntimeWidgetValue(w);
  const val = esc(rawVal);
  const label = esc(w.label || w.t);
  const model = (w.model || '').trim();

  switch (w.t) {
    case 'group': {
      const m = model || 'panel';
      const count = Array.isArray(w.children) ? w.children.length : 0;
      return `<div class="rt-group model-${esc(m)}" style="--group-accent:${esc(w.color || '#00d4ff')}">
        <div class="rt-group-title">${label}</div>
        <div class="rt-group-count">${count ? `${count} item${count === 1 ? '' : 's'}` : ''}</div>
      </div>`;
    }

    case 'separator': {
      const orientation = w.orientation || ((w.h || 0) > (w.w || 0) ? 'vertical' : 'horizontal');
      const thickness = Math.max(1, Math.min(6, Number(w.thickness) || 1));
      const m = model || 'subtle';
      return `<div class="rt-separator ${esc(orientation)} model-${esc(m)}" style="--sep-color:${esc(w.color || '#94a3b8')};--sep-thickness:${thickness}px">
        <span class="rt-separator-line"></span>${w.label ? `<span class="rt-separator-label">${label}</span>` : ''}
      </div>`;
    }

    case 'button': {
      const m = model || 'neo';
      // An explicit icon wins. Without one the icon is picked by hashing the
      // last character of the widget id, which is fine for a demo button but
      // meaningless on a real control -- "Left motor" was landing on a random
      // sparkle. `icon: ""` deliberately means no icon at all.
      const icons = ['🎯', '⚡', '🚀', '💥', '✨', '🎮', '🔥', '💫'];
      const icon = (w.icon != null && w.icon !== '')
        ? esc(String(w.icon))
        : (w.icon === '' ? '' : icons[Math.abs(w.id.charCodeAt(w.id.length-1) || 0) % icons.length]);
      const iconSpan = icon ? `<span class="icon">${icon}</span>` : '';
      // `spin` turns the icon while the button is held -- a wheel that actually
      // turns says what a jog button does better than any label. Negative spins
      // anticlockwise, so a left/right pair can mirror each other the way the
      // two wheels do. Any truthy value spins; only the sign is read here.
      const spin = w.spin ? ` data-spin="${Number(w.spin) < 0 ? -1 : 1}"` : '';
      // Build mode has always previewed w.color on a button, but the runtime
      // render ignored it, so a colour set in CFG silently did nothing in Play.
      const bg = w.color ? ` style="background:${esc(String(w.color))}"` : '';
      return `<button class="rt-button model-${m}"${spin}${bg}>${iconSpan}<span>${label}</span></button>`;
    }

    case 'slider': {
      const m = model || 'track';
      const min = (w.min ?? 0);
      const max = (w.max ?? 100);
      const step = (w.step ?? 1);
      const numericRaw = parseFloat(rawVal);
      const numericVal = Number.isFinite(numericRaw) ? numericRaw : min;
      const clamped = Math.max(min, Math.min(max, numericVal));
      const isVertical = (w.h || 100) > (w.w || 100);
      const orientClass = isVertical ? ' vertical' : '';
      return `<div class="rt-slider-wrap${orientClass}">
        <div class="rt-slider-label">${label}</div>
        <div class="rt-slider-body">
          <input type="range" class="rt-slider model-${m}" min="${min}" max="${max}" step="${step}" value="${clamped}"${isVertical ? ' orient="vertical"' : ''}>
          <div class="rt-slider-val" aria-live="polite">${esc(String(clamped))}</div>
        </div>
      </div>`;
    }

    case 'toggle': {
      const m = model || 'square';
      const on = rawVal === '1';
      const glyph = m === 'icon' ? (on ? '⏻' : '⭘') : (on ? '😃' : '😴');
      return `<div class="rt-toggle-wrap">
        <button class="rt-toggle model-${m}${on ? ' on' : ''}">${glyph}</button>
        <span>${label}</span>
      </div>`;
    }

    case 'led': {
      const m = model || 'dot';
      const on = rawVal === '1';
      const onColor = w.colorOn || '#ff5252';
      const offColor = w.colorOff || '#333';
      // Create dynamic styles for the bulb effect
      const offStyle = `background: radial-gradient(circle at 30% 30%, #666, #333 40%, #222 70%, #111);`;
      const onStyle = `background: radial-gradient(circle at 30% 30%, ${onColor}99, ${onColor} 30%, ${onColor}cc 60%, ${onColor}88); border-color: ${onColor}88;`;
      const style = on ? onStyle : offStyle;
      const shadow = on 
        ? `box-shadow: inset 0 -8px 15px rgba(0,0,0,0.3), inset 0 8px 15px rgba(255,255,255,0.3), 0 0 30px ${onColor}, 0 0 60px ${onColor}88, 0 0 90px ${onColor}44;`
        : `box-shadow: inset 0 -8px 15px rgba(0,0,0,0.6), inset 0 8px 15px rgba(255,255,255,0.1), 0 4px 10px rgba(0,0,0,0.5);`;

      return `<div class="rt-led-wrap">
        <div class="rt-led model-${m}${on ? ' on' : ''}" style="${style}${shadow}" data-color="${onColor}"></div>
        <span>${label}</span>
      </div>`;
    }

    case 'joystick': {
      const m = model || 'classic';
      const stickM = m === 'min' ? 'min' : 'classic';
      return `<div class="rt-joystick-wrap">
        <div class="rt-joystick-base model-${m}"><div class="rt-joystick-stick model-${stickM}"></div></div>
        <span>${label}</span>
      </div>`;
    }

    case 'label': {
      const m = model || 'plain';
      return `<div class="rt-label-text model-${m}">${val || label}</div>`;
    }

    case 'gauge': {
      const m = model || 'classic';
      const units = esc(w.units || '');
      const decimals = (w.decimals ?? 0);
      // 11 tick marks across the arc
      const ticks = Array.from({length: 11}, (_, i) => {
        const a = (-180 + (180 * (i/10))) * Math.PI/180; // -180..0
        const cx = 60, cy = 70;
        const r1 = 42, r2 = 50;
        const x1 = cx + Math.cos(a) * r1;
        const y1 = cy + Math.sin(a) * r1;
        const x2 = cx + Math.cos(a) * r2;
        const y2 = cy + Math.sin(a) * r2;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;
      }).join('');
      return `<div class="rt-gauge-wrap model-${m}">
        <div class="rt-gauge-svg">
          <svg viewBox="0 0 120 80" width="100%" height="100%">
            <g class="rt-gauge-ticks">${ticks}</g>
            <path class="rt-gauge-bg" d="M10,70 A50,50 0 0 1 110,70" />
            <path class="rt-gauge-fg" data-role="gaugeArc" d="M10,70 A50,50 0 0 1 110,70" />
          </svg>
        </div>
        <div class="rt-gauge-center">
          <div class="rt-gauge-emoji" data-role="gaugeEmoji">😃</div>
          <div class="rt-gauge-value" data-role="gaugeValue">${esc((parseFloat(rawVal)||0).toFixed(decimals))}</div>
          <div class="rt-gauge-label">${label}${units ? ' ' + units : ''}</div>
        </div>
      </div>`;
    }
    
    case 'graph': {
      const m = model || 'grid';
      const win = parseInt(w.windowSec ?? 30, 10) || 30;
      const auto = (w.autoScale !== false);
      const series = Math.max(1, Math.min(10, parseInt(w.series ?? 1, 10) || 1));
      return `<div class="rt-graph-wrap model-${m}">
        <div class="rt-graph-head">
          <span>${label}</span>
          <span data-role="graphLast"></span>
        </div>
        <div class="rt-graph-sub" data-role="graphLegend"></div>
        <canvas class="rt-graph-canvas" data-role="graphCanvas"></canvas>
        <div class="rt-graph-sub">Win:${win}s&nbsp;&nbsp;${auto ? 'Auto' : 'Fixed'}&nbsp;&nbsp;Series:${series}</div>
      </div>`;
    }

    case 'dpad': {
      const m = model || 'classic';
      // Mecanum wheels can strafe, so the four corners are real directions
      // rather than dead cells. Each corner press sets TWO bits of the same
      // motion mask the cardinals use (up|left etc.), which the firmware
      // already sums into nx/ny — no protocol change. The centre is a STOP.
      if (m === 'mecanum') {
        return `<div class="rt-dpad model-mecanum">
        <button class="dpad-btn" data-dir="upleft" type="button">&#8598;</button>
        <button class="dpad-btn" data-dir="up" type="button">&#9650;</button>
        <button class="dpad-btn" data-dir="upright" type="button">&#8599;</button>
        <button class="dpad-btn" data-dir="left" type="button">&#9664;</button>
        <button class="dpad-btn dpad-stop" data-dir="stop" type="button">&#9632;</button>
        <button class="dpad-btn" data-dir="right" type="button">&#9654;</button>
        <button class="dpad-btn" data-dir="downleft" type="button">&#8601;</button>
        <button class="dpad-btn" data-dir="down" type="button">&#9660;</button>
        <button class="dpad-btn" data-dir="downright" type="button">&#8600;</button>
      </div>`;
      }
      // Two buttons, steering only. Sends the same "SET <id> <dir> <0|1>" as
      // every other model -- a firmware that already handles left/right needs
      // no change, and one that expects all four simply never sees up/down.
      if (m === 'leftright') {
        return `<div class="rt-dpad model-leftright">
        <button class="dpad-btn" data-dir="left" type="button">&#9664;</button>
        <button class="dpad-btn" data-dir="right" type="button">&#9654;</button>
      </div>`;
      }

      return `<div class="rt-dpad">
        <div></div>
        <button class="dpad-btn" data-dir="up" type="button">&#9650;</button>
        <div></div>
        <button class="dpad-btn" data-dir="left" type="button">&#9664;</button>
        <div class="dpad-center"></div>
        <button class="dpad-btn" data-dir="right" type="button">&#9654;</button>
        <div></div>
        <button class="dpad-btn" data-dir="down" type="button">&#9660;</button>
        <div></div>
      </div>`;
    }

    case 'xypad': {
      return `<div class="rt-xypad">
        <div class="xypad-crosshair"></div>
        <div class="xypad-dot" style="left:50%;top:50%"></div>
        <div class="xypad-label">${label}</div>
      </div>`;
    }

    case 'battery': {
      const level = parseInt(rawVal) || 100;
      const levelClass = level < 20 ? 'critical' : level < 40 ? 'low' : '';
      const emoji = level < 20 ? '😱' : level < 40 ? '😰' : level < 60 ? '😊' : level < 80 ? '😄' : '🤩';
      return `<div class="rt-battery">
        <div class="battery-tip"></div>
        <div class="battery-body">
          <div class="battery-level ${levelClass}" style="height:${level}%"></div>
        </div>
        <div class="battery-text">${level}%</div>
        <div class="battery-emoji">${emoji}</div>
      </div>`;
    }

    case 'timer': {
      return `<div class="rt-timer">
        <div class="timer-label">⏱️ ${label || 'Timer'}</div>
        <div class="timer-display" data-role="timerDisplay">00:00</div>
        <div class="timer-controls">
          <button class="timer-btn" data-action="start">▶️ Go!</button>
          <button class="timer-btn" data-action="pause">⏸️</button>
          <button class="timer-btn" data-action="reset">🔄</button>
        </div>
      </div>`;
    }

    case 'image': {
      const src = w.imageSrc || '';
      return `<div class="rt-image" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:8px;">
        ${src ? `<img src="${esc(src)}" style="max-width:100%;max-height:100%;object-fit:contain;">` : `<span style="opacity:0.5">${label || '🖼️'}</span>`}
      </div>`;
    }

    case 'select': {
      const choices = (w.options || '').split(',').map(s => s.trim()).filter(Boolean);
      const current = rawVal || choices[0] || '';
      return `<div class="rt-select-wrap">
        <div class="rt-select-label">${label}</div>
        <select class="rt-select">
          ${choices.map(c => `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>`;
    }

    case 'editfield': {
      const placeholder = esc(w.placeholder || 'Type here...');
      return `<div class="rt-editfield-wrap">
        <div class="rt-editfield-label">${label}</div>
        <div class="rt-editfield-row">
          <input type="text" class="rt-editfield" placeholder="${placeholder}" value="${val === '0' ? '' : val}">
          <button class="rt-editfield-send" type="button">➤</button>
        </div>
      </div>`;
    }

    case 'sound': {
      return `<div class="rt-sound">
        <div class="sound-icon" data-role="soundIcon">🔊</div>
        <span>${label}</span>
      </div>`;
    }

    case 'notification': {
      return `<div class="rt-notification">
        <div class="notification-icon">🔔</div>
        <span>${label}</span>
      </div>`;
    }

    default:
      return `<div>${w.t}</div>`;
  }
}


function bindRuntimeWidget(el, w) {
  switch (w.t) {
    case 'button':
      const btn = el.querySelector('.rt-button');
      let btnPressed = false;
      const press = e => { 
        if (runtimeInteractionBlocked(e)) return;
        e.preventDefault();
        if (btnPressed) return;
        btnPressed = true;
        beepClick();
        // Reliable, not send(): send() keeps only the LATEST message, so a
        // quick tap whose press and release land in the same write window
        // loses the "1" entirely and the press never reaches the robot. It
        // goes unnoticed on a STOP button you hold down, and is glaring on a
        // step button where one tap must mean exactly one step.
        sendReliable(`SET ${w.id} 1`); 
        btn.style.transform = 'scale(0.9)'; 
        if (btn.dataset.spin) btn.classList.add('spinning');
      };
      const release = () => {
        if (!btnPressed) return;
        btn.style.transform = '';
        btn.classList.remove('spinning');
        btnPressed = false;
        // Runtime controls should release immediately; artificial debounce on
        // actuator buttons only adds lag and can leave a command active while
        // switching views.
        sendReliable(`SET ${w.id} 0`);
      };
      btn.onmousedown = btn.ontouchstart = press;
      btn.onmouseup = btn.onmouseleave = btn.ontouchend = release;
      registerRuntimeBindingCleanup(() => {
        if (btnPressed && state.ble.connected) sendReliable(`SET ${w.id} 0`);
        btnPressed = false;
      });
      break;
    case 'slider':
      let sliderEl = el.querySelector('.rt-slider');
      const sliderValueEl = el.querySelector('.rt-slider-val');
      // v48.1: the gauge is a REAL MakeCode CFG widget, not HTML injected
      // inside the slider. We only mirror the slider value into CFG gauges
      // that explicitly name this slider in their `source` field.
      const reflectSliderValue = value => {
        if (sliderValueEl) sliderValueEl.textContent = String(value);
        state.values[w.id] = String(value);
        mirrorConfiguredGaugeSources(w.id, value);
      };
      // Wide hit area + explicit pointer mapping retained from v47.
      const sliderMin = parseFloat(sliderEl.min || w.min || 0);
      const sliderMax = parseFloat(sliderEl.max || w.max || 100);
      const sliderStep = Math.abs(parseFloat(sliderEl.step || w.step || 1)) || 1;
      const sliderVertical = el.querySelector('.rt-slider-wrap')?.classList.contains('vertical');
      let sliderPointerId = null;

      const quantizeSliderValue = raw => {
        const bounded = Math.max(sliderMin, Math.min(sliderMax, raw));
        const stepped = sliderMin + Math.round((bounded - sliderMin) / sliderStep) * sliderStep;
        const decimals = ((String(sliderStep).split('.')[1] || '').length);
        return Number(Math.max(sliderMin, Math.min(sliderMax, stepped)).toFixed(decimals));
      };

      const commitSliderValue = (value, final = false) => {
        const val = quantizeSliderValue(value);
        sliderEl.value = String(val);
        reflectSliderValue(val);
        send(`SET ${w.id} ${val}`);
        if (final) sliderEl.dispatchEvent(new Event('slidercommit'));
      };

      const valueFromPointer = e => {
        const r = sliderEl.getBoundingClientRect();
        let pct;
        if (sliderVertical) pct = 1 - ((e.clientY - r.top) / Math.max(1, r.height));
        else pct = (e.clientX - r.left) / Math.max(1, r.width);
        pct = Math.max(0, Math.min(1, pct));
        return sliderMin + pct * (sliderMax - sliderMin);
      };

      sliderEl.addEventListener('pointerdown', e => {
        if (runtimeInteractionBlocked(e)) return;
        if (e.button !== undefined && e.button !== 0) return;
        sliderPointerId = e.pointerId;
        sliderEl.classList.add('adjusting');
        try { sliderEl.setPointerCapture(e.pointerId); } catch (_) {}
        commitSliderValue(valueFromPointer(e));
        e.preventDefault();
      });
      sliderEl.addEventListener('pointermove', e => {
        if (state.arrangeMode) return;
        if (sliderPointerId !== e.pointerId) return;
        commitSliderValue(valueFromPointer(e));
        e.preventDefault();
      });
      const endSliderPointer = e => {
        if (sliderPointerId !== e.pointerId) return;
        commitSliderValue(valueFromPointer(e), true);
        try { sliderEl.releasePointerCapture(e.pointerId); } catch (_) {}
        sliderPointerId = null;
        sliderEl.classList.remove('adjusting');
        e.preventDefault();
      };
      sliderEl.addEventListener('pointerup', endSliderPointer);
      sliderEl.addEventListener('pointercancel', e => {
        if (sliderPointerId !== e.pointerId) return;
        sliderPointerId = null;
        sliderEl.classList.remove('adjusting');
      });

      sliderEl.oninput = e => {
        if (runtimeInteractionBlocked(e)) return;
        const val = quantizeSliderValue(parseFloat(e.target.value) || sliderMin);
        reflectSliderValue(val);
        send(`SET ${w.id} ${val}`);
      };
      sliderEl.onchange = e => {
        if (runtimeInteractionBlocked(e)) return;
        const val = quantizeSliderValue(parseFloat(e.target.value) || sliderMin);
        reflectSliderValue(val);
        send(`SET ${w.id} ${val}`);
      };
      break;
    case 'toggle':
      el.querySelector('.rt-toggle').onclick = function(e) {
        if (runtimeInteractionBlocked(e)) return;
        const on = this.classList.toggle('on');
        this.textContent = on ? '😃' : '😴';
        beepToggle(on);
        send(`SET ${w.id} ${on ? '1' : '0'}`);
      };
      break;
    case 'joystick':
      const stick = el.querySelector('.rt-joystick-stick');
      const base = el.querySelector('.rt-joystick-base');
      let isDown = false;
      let resetTimer = null; // Debounce timer for reset
      // Deviation from stock bit-rxy: send raw normalized
      // nx/ny (right-positive, up-positive), scaled to -100..100 ints,
      // instead of bit-rxy's stock angle/distance polar encoding. This
      // mirrors Maqueen Lab's own proven joystick (js/maqueen-tab.js:
      // nx = dx/radius, ny = -dy/radius, sent straight into the drive
      // mix) so the firmware never has to reconstruct nx/ny via
      // cos()/sin() from a rounded integer angle+distance pair.
      const handleMove = e => {
        if (!isDown || state.arrangeMode) return;
        const rect = base.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        let dx = clientX - centerX;
        let dy = clientY - centerY; // screen Y (down positive) for now
        const maxDist = Math.min(rect.width, rect.height) / 2 - 10;
        const d = Math.hypot(dx, dy);
        if (d > maxDist) { dx *= maxDist / d; dy *= maxDist / d; }
        stick.style.transform = `translate(${dx}px, ${dy}px)`;
        const nx = dx / maxDist;        // right positive
        const ny = -dy / maxDist;       // invert so up is positive (forward)
        // Send live position during drag. send()'s queue (bleSend) already
        // does latest-value-wins coalescing at bleSend.minInterval, so this
        // is safe to call on every pointermove without flooding BLE — it's
        // exactly the "continuous controls like joystick" case that queue
        // was built for. Without this, driving robots had to wait for
        // release before the vehicle moved at all.
        send(`SET ${w.id} ${Math.round(nx * 100)} ${Math.round(ny * 100)}`);
      };
      const resetJoystick = () => {
        if (!isDown) return;
        isDown = false;
        // Clear any pending reset timer
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        stick.style.transform = '';
        // Live updates already streamed during the drag; just center it now.
        send(`SET ${w.id} 0 0`);
      };
      const startJoystick = (e) => {
        if (runtimeInteractionBlocked(e)) return;
        if (e.type === 'touchstart') e.preventDefault();
        if (isDown) return; // Prevent multiple starts
        isDown = true;
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
      };
      base.onmousedown = startJoystick;
      base.ontouchstart = startJoystick;
      document.addEventListener('mousemove', handleMove);
      document.addEventListener('touchmove', handleMove, { passive: false });
      document.addEventListener('mouseup', resetJoystick);
      document.addEventListener('touchend', resetJoystick);
      registerRuntimeBindingCleanup(() => {
        if (isDown && state.ble.connected) send(`SET ${w.id} 0 0`);
        isDown = false;
        if (resetTimer) clearTimeout(resetTimer);
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('touchmove', handleMove);
        document.removeEventListener('mouseup', resetJoystick);
        document.removeEventListener('touchend', resetJoystick);
      });
      break;
    
    case 'dpad':
      const dpadBtns = el.querySelectorAll('.dpad-btn[data-dir]');
      console.log('[DPAD] Found buttons:', dpadBtns.length, Array.from(dpadBtns).map(b => b.dataset.dir));
      dpadBtns.forEach(btn => {
        const dir = btn.dataset.dir;
        console.log('[DPAD] Binding button:', dir, btn);
        let dpadPressed = false;
        let releaseTimer = null;
        let keepaliveTimer = null;

        const press = e => {
          if (runtimeInteractionBlocked(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (dpadPressed) return;
          dpadPressed = true;
          clearTimeout(releaseTimer);
          setDpadMotion(dir, true);
          btn.classList.add('active');
          beepClick();
          console.log('[DPAD] Pressed:', dir);
          // Keepalive: a held direction otherwise sends NOTHING between
          // press and release, so the firmware's drive watchdog can't
          // tell "still held" from "release packet was dropped" and used
          // to cut the motors mid-hold. Re-assert the direction every
          // 300ms (watchdog is 700ms, so two may be lost harmlessly).
          //
          // Deliberately send() and not sendReliable(): a keepalive is a
          // repeat, so losing one costs nothing, and the coalescing slot
          // drains AFTER the FIFO — which keeps the real press/release
          // packets strictly ordered ahead of it.
          clearInterval(keepaliveTimer);
          dpadKeepalives.delete(keepaliveTimer);
          keepaliveTimer = setInterval(() => {
            // Self-cancel if the button was released OR the link dropped
            // while held — otherwise this timer outlives the connection
            // and resumes spamming on the next one.
            if (!dpadPressed || !state.ble.connected) {
              clearInterval(keepaliveTimer);
              dpadKeepalives.delete(keepaliveTimer);
              return;
            }
            sendMotorMaskNow(dpadMotionMask);
          }, 1000);
          dpadKeepalives.add(keepaliveTimer);
        };

        const release = e => {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          if (!dpadPressed) return;
          btn.classList.remove('active');
          // Stop the keepalive immediately, not on the debounce timer —
          // otherwise it could re-assert the direction after release.
          clearInterval(keepaliveTimer);
          dpadKeepalives.delete(keepaliveTimer);
          keepaliveTimer = null;
          // Release immediately: avoid 100 ms motor-stop latency.
          clearTimeout(releaseTimer);
          dpadPressed = false;
          console.log('[DPAD] Released:', dir);
          setDpadMotion(dir, false);
        };
        
        // Pointer Events provide one immediate path for mouse/touch/pen and
        // avoid the duplicate synthetic mouse sequence that follows touch.
        btn.addEventListener('pointerdown', press, { passive: false });
        btn.addEventListener('pointerup', release, { passive: false });
        btn.addEventListener('pointercancel', release, { passive: false });
        
        // Only release on pointerleave if the button is pressed.
        btn.addEventListener('pointerleave', e => {
          if (dpadPressed && e.buttons === 0) {
            release(e);
          }
        }, { passive: false });

        // NOTE: there used to be a `btn.onclick = press` "fallback" here.
        // A real click fires mousedown -> mouseup -> click, so it invoked
        // press() a second time on every single tap. It was harmless only
        // because the dpadPressed guard swallowed it — but that same
        // guard, combined with the 100ms release debounce, is what makes
        // a genuine second tap within 100ms disappear. mousedown/touchstart
        // already cover every input path.
      });
      break;
    
    case 'xypad':
      const xypad = el.querySelector('.rt-xypad');
      const xydot = el.querySelector('.xypad-dot');
      let xyDown = false;
      let lastX = 50, lastY = 50;
      const handleXY = e => {
        if (!xyDown || state.arrangeMode) return;
        e.preventDefault();
        const rect = xypad.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        lastX = Math.round(x * 100);
        lastY = Math.round(y * 100);
        xydot.style.left = (x * 100) + '%';
        xydot.style.top = (y * 100) + '%';
        // Don't send during drag - only on release
      };
      const releaseXY = () => {
        if (!xyDown) return;
        xyDown = false;
        if (state.arrangeMode) return;
        // Send final position on release
        console.log('[XYPAD] Sending final:', lastX, lastY);
        send(`SET ${w.id} ${lastX} ${lastY}`);
      };
      xypad.onmousedown = xypad.ontouchstart = e => { 
        if (runtimeInteractionBlocked(e)) return;
        xyDown = true; 
        handleXY(e); 
      };
      document.addEventListener('mousemove', handleXY);
      document.addEventListener('touchmove', handleXY, { passive: false });
      document.addEventListener('mouseup', releaseXY);
      document.addEventListener('touchend', releaseXY);
      registerRuntimeBindingCleanup(() => {
        xyDown = false;
        document.removeEventListener('mousemove', handleXY);
        document.removeEventListener('touchmove', handleXY);
        document.removeEventListener('mouseup', releaseXY);
        document.removeEventListener('touchend', releaseXY);
      });
      break;
    
    case 'timer':
      let timerVal = 0;
      let timerInterval = null;
      let lastTimerSend = 0;
      const display = el.querySelector('[data-role="timerDisplay"]');
      const formatTime = s => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
      };
      el.querySelector('[data-action="start"]').onclick = (e) => {
        if (runtimeInteractionBlocked(e)) return;
        if (timerInterval) return;
        timerInterval = setInterval(() => {
          // Arrange mode is editing geometry, not running the controller.
          if (state.arrangeMode) return;
          timerVal++;
          display.textContent = formatTime(timerVal);
          // Only send every 5 seconds to avoid BLE spam
          if (timerVal - lastTimerSend >= 5) {
            lastTimerSend = timerVal;
            send(`SET ${w.id} ${timerVal}`);
          }
        }, 1000);
        beepClick();
      };
      el.querySelector('[data-action="pause"]').onclick = (e) => {
        if (runtimeInteractionBlocked(e)) return;
        clearInterval(timerInterval);
        timerInterval = null;
        // Send current value on pause
        send(`SET ${w.id} ${timerVal}`);
        beepClick();
      };
      el.querySelector('[data-action="reset"]').onclick = (e) => {
        if (runtimeInteractionBlocked(e)) return;
        clearInterval(timerInterval);
        timerInterval = null;
        timerVal = 0;
        lastTimerSend = 0;
        display.textContent = '00:00';
        send(`SET ${w.id} 0`);
        beepClick();
      };
      registerRuntimeBindingCleanup(() => {
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = null;
      });
      break;

    case 'select': {
      const sel = el.querySelector('.rt-select');
      sel.onchange = (e) => {
        if (runtimeInteractionBlocked(e)) return;
        beepClick();
        const msg = `SET ${w.id} ${sel.value}`;
        // Mode changes transfer ownership of the motors. They must never be
        // replaced by a later PING/continuous-control value in the generic
        // latest-value-wins slot.
        if (w.id === 'mode' || w.id === 'dist_read') sendReliable(msg);
        else send(msg);
      };
      break;
    }

    case 'editfield': {
      const input = el.querySelector('.rt-editfield');
      const sendBtn = el.querySelector('.rt-editfield-send');
      const submit = (e) => {
        if (runtimeInteractionBlocked(e)) return;
        beepClick();
        send(`SET ${w.id} ${input.value}`);
      };
      sendBtn.onclick = submit;
      input.onkeydown = e => { if (e.key === 'Enter') submit(e); };
      break;
    }
  }
}


// --- Graph & Gauge helpers ---
state.history = state.history || {}; // { [id]: { points: Array<{t:number, v:number[]}>, colors:string[] } }

function parseCsvNumbers(s){
  return String(s ?? '').split(',').map(x => parseFloat(x.trim())).filter(x => isFinite(x));
}

function ensureGraphState(id, series){
  if (!state.history[id]) state.history[id] = { points: [], colors: [] };
  const hs = state.history[id];
  if (!hs.colors || hs.colors.length !== series){
    // generate distinct-ish hues using HSL (no hard-coded palette)
    hs.colors = Array.from({length: series}).map((_,i)=>`hsl(${(i*360/series)|0} 85% 60%)`);
  }
  return hs;
}

function pushGraphPoint(w, csvVal){
  const nums = parseCsvNumbers(csvVal);
  const series = Math.max(1, Math.min(10, parseInt(w.series ?? 1, 10)));
  const hs = ensureGraphState(w.id, series);
  const now = performance.now();
  const arr = Array.from({length: series}).map((_,i)=> (nums[i] != null ? nums[i] : NaN));
  hs.points.push({ t: now, v: arr });

  // trim window
  const winMs = Math.max(5, Math.min(300, parseFloat(w.windowSec ?? 30))) * 1000;
  const cutoff = now - winMs;
  while (hs.points.length && hs.points[0].t < cutoff) hs.points.shift();
  
  // Also limit max points for smoother rendering
  const maxPoints = 150;
  while (hs.points.length > maxPoints) hs.points.shift();
}

function resizeCanvasToDisplaySize(canvas){
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.floor(rect.width * dpr));
  const h = Math.max(10, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h){
    canvas.width = w; canvas.height = h;
    return true;
  }
  return false;
}

function drawGraphWidget(w){
  const root = document.querySelector(`.rt-widget[data-id="${w.id}"]`);
  if (!root) return;
  const canvas = root.querySelector('[data-role="graphCanvas"]');
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(50, rect.width);
  const cssH = Math.max(40, rect.height);
  const W = Math.floor(cssW * dpr);
  const H = Math.floor(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H){
    canvas.width = W; canvas.height = H;
  }

  const ctx = canvas.getContext('2d');
  // draw in CSS pixels for predictable fonts/line widths
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  const seriesCount = Math.max(1, Math.min(10, parseInt(w.series ?? 1, 10)));
  const hs = ensureGraphState(w.id, seriesCount);
  const pts = hs.points || [];


  // legend (kid-friendly)
  const legend = root.querySelector('[data-role="graphLegend"]');
  if (legend){
    const names = (w.seriesNames || '').split(',').map(s => s.trim()).filter(Boolean);
    legend.innerHTML = Array.from({length: seriesCount}).map((_,i) => {
      const nm = esc(names[i] || `S${i+1}`);
      return `<span class="legend-item"><span class="rt-graph-dot" data-s="${i}"></span>${nm}</span>`;
    }).join('');
  }

  // layout
  const mL = 36, mR = 10, mT = 10, mB = 22;
  const plotX = mL, plotY = mT;
  const plotW = Math.max(10, cssW - mL - mR);
  const plotH = Math.max(10, cssH - mT - mB);

  // background
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0,0,cssW,cssH);

  // axes + grid
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;

  // y grid + labels
  ctx.font = '10px system-ui, Segoe UI, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';

  // if no data, draw frame + hint
  ctx.strokeRect(plotX, plotY, plotW, plotH);
  // Only a genuinely EMPTY series is "waiting". A single sample is real
  // data — "Distance read: Read now" delivers exactly one — and refusing to
  // plot it made a perfectly good reading look like a dead feed. One point
  // is drawn as a dot by the series loop below.
  if (pts.length < 1){
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('waiting for UPD...', plotX + 8, plotY + 16);
    // legend colors
    const legend2 = root.querySelector('[data-role="graphLegend"]');
    if (legend2){
      legend2.querySelectorAll('.rt-graph-dot').forEach(dot => {
        const i = parseInt(dot.getAttribute('data-s') || '0', 10);
        dot.style.background = hs.colors[i] || 'var(--accent)';
      });
    }
    return;
  }

  const t0 = pts[0].t;
  const t1 = pts[pts.length-1].t;
  const span = Math.max(0.001, t1 - t0);

  // y scale
  let yMin = Infinity, yMax = -Infinity;
  if (w.autoScale ?? true){
    pts.forEach(p => p.v.forEach(v => { if (isFinite(v)) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); } }));
    if (!isFinite(yMin) || !isFinite(yMax)){ yMin = 0; yMax = 1; }
  } else {
    yMin = parseFloat(w.yMin ?? 0);
    yMax = parseFloat(w.yMax ?? 100);
    if (!isFinite(yMin) || !isFinite(yMax)){ yMin = 0; yMax = 1; }
  }
  if (yMin === yMax){ yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad; yMax += pad;

  // With a single sample t0 === t1, so the normalised position is 0 and the
  // point would pin to the left edge. Centre it instead — it reads as "one
  // reading", not as the start of a trace that failed to advance.
  const single = pts.length < 2;
  const xForT = t => single ? plotX + plotW / 2 : plotX + ((t - t0) / span) * plotW;
  const yForV = v => plotY + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Y ticks
  const yTicks = 4;
  for (let i=0;i<=yTicks;i++){
    const p = i / yTicks;
    const y = plotY + p * plotH;
    ctx.beginPath(); ctx.moveTo(plotX, y); ctx.lineTo(plotX+plotW, y); ctx.stroke();
    const v = (yMax - (yMax - yMin) * p);
    ctx.fillText(v.toFixed(1), 4, y + 3);
  }

  
  // Y axis label
  if ((w.yLabel || '').trim()){
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '11px system-ui, Segoe UI, sans-serif';
    ctx.translate(12, plotY + plotH/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText(w.yLabel, 0, 0);
    ctx.restore();
  }

  // X ticks (seconds)
  const xTicks = 4;
  for (let i=0;i<=xTicks;i++){
    const p = i / xTicks;
    const x = plotX + p * plotW;
    ctx.beginPath(); ctx.moveTo(x, plotY); ctx.lineTo(x, plotY+plotH); ctx.stroke();
    const sec = ((t0 + span * p) - t1) / 1000; // negative to 0
    ctx.fillText(sec.toFixed(0) + 's', x - 10, plotY + plotH + 16);
  }

  // draw each series with smooth lines
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  hs.colors.forEach((c, si) => {
    // Draw glow effect first
    ctx.strokeStyle = c;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    let started = false;
    for (let i=0;i<pts.length;i++){
      const v = pts[i].v[si];
      if (!isFinite(v)) continue;
      const x = xForT(pts[i].t);
      const y = yForV(v);
      if (!started){ ctx.moveTo(x,y); started = true; }
      else { ctx.lineTo(x,y); }
    }
    if (started) ctx.stroke();
    
    // Draw main line
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.beginPath();
    started = false;
    for (let i=0;i<pts.length;i++){
      const v = pts[i].v[si];
      if (!isFinite(v)) continue;
      const x = xForT(pts[i].t);
      const y = yForV(v);
      if (!started){ ctx.moveTo(x,y); started = true; }
      else { ctx.lineTo(x,y); }
    }
    if (started) ctx.stroke();

    // A one-point path strokes nothing, so mark lone samples explicitly.
    // Without this the graph stays visually blank after a single Read now
    // even though the value has arrived.
    if (single){
      const v = pts[0].v[si];
      if (isFinite(v)){
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(xForT(pts[0].t), yForV(v), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  // update legend dots colors
  const legend2 = root.querySelector('[data-role="graphLegend"]');
  if (legend2){
    legend2.querySelectorAll('.rt-graph-dot').forEach(dot => {
      const i = parseInt(dot.getAttribute('data-s') || '0', 10);
      dot.style.background = hs.colors[i] || 'var(--accent)';
    });
  }
}

function stopDemoSim(){
  if (state._demoTimer){
    clearInterval(state._demoTimer);
    state._demoTimer = null;
  }
}

function startDemoSim(){
  stopDemoSim();

  // Never simulate over a live robot. The presence test below keys off generic
  // widget ids, and a real layout can legitimately use them — this one has a
  // gauge_temp, so the demo started against a connected micro:bit, overwrote
  // genuine telemetry with sine waves, and pushed updates for gauge_level and
  // graph_env that the device layout never contained ("Widget definition not
  // found", once per tick). A device-supplied config is never demo data.
  if (state.ble?.connected || state.deviceConfig || state.runtimeSource === 'device') return;

  // Check for any demo widgets
  const hasGraph = !!document.querySelector('.rt-widget[data-id="graph_env"] [data-role="graphCanvas"]');
  const hasGauge = !!document.querySelector('.rt-widget[data-id="gauge_temp"] .rt-gauge-wrap');
  const hasBattery = !!document.querySelector('.rt-widget[data-id="battery_level"]');
  const hasTimer = !!document.querySelector('.rt-widget[data-id="timer_game"]');
  const hasLed = !!document.querySelector('.rt-widget[data-id="led_status"]');
  
  if (!hasGraph && !hasGauge && !hasBattery && !hasTimer && !hasLed) return;

  let t0 = Date.now();
  let ledBlinkState = false;
  let timerSeconds = 0;
  
  state._demoTimer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;

    // Smooth sine waves for gauges
    const temp = 25 + 8 * Math.sin(t / 4);
    const level = 50 + 35 * Math.sin(t / 5);

    state.values['gauge_temp'] = temp.toFixed(1);
    state.values['gauge_level'] = level.toFixed(0);

    updateRuntimeWidget('gauge_temp', state.values['gauge_temp']);
    updateRuntimeWidget('gauge_level', state.values['gauge_level']);

    // Smooth waves for graph - slower, more gradual changes
    const s1 = 50 + 30 * Math.sin(t / 2);
    const s2 = 40 + 25 * Math.cos(t / 2.5);
    const csv = `${s1.toFixed(1)},${s2.toFixed(1)}`;
    state.values['graph_env'] = csv;
    updateRuntimeWidget('graph_env', csv);

    // Update score label
    const scoreEl = state.config?.widgets?.find(x => x.id === 'label_score');
    if (scoreEl){
      const sc = Math.floor((t * 3) % 999);
      const txt = `Score: ${sc}`;
      state.values['label_score'] = txt;
      updateRuntimeWidget('label_score', txt);
    }
    
    // Animate battery level (cycles between 10-100%)
    if (hasBattery) {
      const batteryLevel = Math.floor(50 + 45 * Math.sin(t / 8));
      state.values['battery_level'] = batteryLevel.toString();
      updateRuntimeWidget('battery_level', batteryLevel.toString());
    }
    
    // Animate timer (counts up)
    if (hasTimer) {
      timerSeconds = Math.floor(t);
      const mins = Math.floor(timerSeconds / 60);
      const secs = timerSeconds % 60;
      const timerStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      state.values['timer_game'] = timerStr;
      updateRuntimeWidget('timer_game', timerStr);
    }
    
    // Blink LEDs alternately
    if (hasLed) {
      ledBlinkState = !ledBlinkState;
      state.values['led_status'] = ledBlinkState ? '1' : '0';
      state.values['led_alert'] = ledBlinkState ? '0' : '1';
      updateRuntimeWidget('led_status', state.values['led_status']);
      updateRuntimeWidget('led_alert', state.values['led_alert']);
    }
  }, 400); // Slower updates for smoother appearance
}


function updateGaugeWidget(w, valStr){
  const root = document.querySelector(`.rt-widget[data-id="${w.id}"]`);
  if (!root) return;
  const wrap = root.querySelector('.rt-gauge-wrap');
  if (!wrap) return;

  const arc = wrap.querySelector('[data-role="gaugeArc"]') || wrap.querySelector('.rt-gauge-fg');
  const txt = wrap.querySelector('[data-role="gaugeValue"]');
  const emo = wrap.querySelector('[data-role="gaugeEmoji"]');

  const min = parseFloat(w.min ?? 0);
  const max = parseFloat(w.max ?? 100);
  const dec = parseInt(w.decimals ?? 0, 10);

  let v = parseFloat(valStr);
  if (!isFinite(v)) v = min;

  const denom = (max - min) || 1;
  const t = Math.max(0, Math.min(1, (v - min) / denom));

  // Match CSS dasharray (half-ish arc). If changed in CSS, keep in sync.
  const L = 157.1;

  // Color zones (kid-friendly)
  const warn = (w.warn != null) ? parseFloat(w.warn) : null;
  const danger = (w.danger != null) ? parseFloat(w.danger) : null;

  let color = 'var(--green)';
  if (danger != null && isFinite(danger) && v >= danger) color = 'var(--red)';
  else if (warn != null && isFinite(warn) && v >= warn) color = 'var(--orange)';
  else color = 'var(--green)';

  if (arc){
    arc.style.strokeDasharray = String(L);
    arc.style.strokeDashoffset = String(L * (1 - t));
    arc.style.stroke = color;
  }

  if (txt){
    const d = isFinite(dec) ? dec : 0;
    txt.textContent = v.toFixed(d);
  }

  if (emo){
    // Cute emoji based on percent
    const pct = Math.round(t * 100);
    emo.textContent = pct < 20 ? '😴' : pct < 40 ? '🙂' : pct < 60 ? '😃' : pct < 80 ? '🤩' : '🚀';
  }
}



function updateRuntimeWidget(id, val) {
  console.log('[UI] Updating widget:', id, 'to', val);
  if (!state.config) {
    console.log('[UI] No config loaded yet.');
    return;
  }
  const w = state.config.widgets.find(x => x.id === id);
  if (!w) {
    console.log('[UI] Widget definition not found');
    return;
  }
  console.log('[UI] Widget type:', w.t);

  // sound/notification are system effects, not visual state — they must
  // fire even if their on-canvas element happens to be scrolled/clipped
  // out of the current viewport, so handle them before the DOM lookup
  // that every other (visual) widget type below actually needs.
  if (w.t === 'sound') {
    playSoundEffect(val);
    const icon = document.querySelector(`.rt-widget[data-id="${id}"] [data-role="soundIcon"]`);
    if (icon) {
      icon.classList.remove('pulse');
      void icon.offsetWidth;
      icon.classList.add('pulse');
    }
    return;
  }
  if (w.t === 'notification') {
    showRuntimeNotification(w, val);
    return;
  }

  const el = document.querySelector(`.rt-widget[data-id="${id}"]`);
  if (!el) {
    console.log('[UI] Widget element not found in DOM.');
    return;
  }
  switch (w.t) {
    case 'slider': {
      const slider = el.querySelector('.rt-slider');
      if (slider) slider.value = val;
      const valueEl = el.querySelector('.rt-slider-val');
      if (valueEl) valueEl.textContent = String(val);
      state.values[id] = String(val);
      mirrorConfiguredGaugeSources(id, val);
      break;
    }
    case 'editfield': {
      const input = el.querySelector('.rt-editfield');
      // Don't clobber text the user is actively typing — only sync when
      // the field isn't focused (e.g. a device-side echo/reset).
      if (input && document.activeElement !== input) input.value = val;
      break;
    }
    case 'toggle': el.querySelector('.rt-toggle').classList.toggle('on', val === '1'); el.querySelector('.rt-toggle').textContent = val === '1' ? '😃' : '😴'; break;
    case 'led': {
      const ledEl = el.querySelector('.rt-led');
      const wdef = state.config.widgets.find(x => x.id === id);
      const onColor = wdef?.colorOn || '#ff5252';
      const offColor = wdef?.colorOff || '#2a2a3a';
      const model = (wdef?.model || 'dot');
      const on = val === '1';

      // Ensure model class is present (in case config changed live)
      ledEl.className = `rt-led model-${model}${on ? ' on' : ''}`;

      if (model === 'ring'){
        ledEl.style.background = 'transparent';
        ledEl.style.borderColor = on ? onColor : 'rgba(255,255,255,0.18)';
        ledEl.style.boxShadow = on ? `0 0 40px ${onColor}` : 'none';
      } else {
        ledEl.style.borderColor = '';
        ledEl.style.background = on ? onColor : offColor;
        ledEl.style.boxShadow = on ? `0 0 40px ${onColor}` : 'none';
      }

      console.log('[UI] LED', id, 'is now', on ? 'ON' : 'OFF');
      break;
    }
    case 'select': {
      const sel = el.querySelector('.rt-select');
      if (sel) sel.value = String(val);
      state.values[id] = String(val);
      break;
    }
    case 'label': el.querySelector('.rt-label-text').textContent = val; break;
    case 'gauge': updateGaugeWidget(w, val); break;
    case 'graph': {
      // val is comma-separated numbers: "23.4,2.1"
      pushGraphPoint(w, val);
      const last = el.querySelector('[data-role="graphLast"]');
      if (last) last.textContent = val;
      drawGraphWidget(w);
      break;
    }
  }
}


// --- Move Build/Play tabs + Name input to top-right (no redesign) ---
function moveBuildPlayNameTopRight(){
  // UI polish: keep Build/Play tabs in the header (.hero-tabs) and the
  // title input in .builder-header where the HTML puts them. No-op.
  return;
}



// --- Place Build/Play + Name centered above the canvas (no overlap) ---

// --- Play mode UI: hide Build + Name, show a tiny Back control ---
function updateToolbarForMode(activeTab){
  const inner = document.getElementById('canvasToolbarInner') || document.querySelector('.canvas-toolbar-inner');
  if (!inner) return;

  const tabs = inner.querySelector('.tabs');
  const buildBtn = tabs ? tabs.querySelector('[data-tab="builder"]') : null;
  const playBtn  = tabs ? tabs.querySelector('[data-tab="runtime"]') : null;
  const nameInput = inner.querySelector('#titleInput');

  // Create back button once
  let back = inner.querySelector('#playBackBtn');
  if (!back){
    back = document.createElement('button');
    back.id = 'playBackBtn';
    back.className = 'tab';
    back.title = 'Back to edit';
    back.textContent = '⬅';
    back.style.display = 'none';
    back.addEventListener('click', () => {
      // switch to builder without using the Build label/button
      if (tabs){
        const b = tabs.querySelector('[data-tab="builder"]');
        if (b) b.click();
      }
    });
    // put it at the start
    if (tabs) tabs.insertBefore(back, tabs.firstChild);
    else inner.insertBefore(back, inner.firstChild);
  }

  if (activeTab === 'runtime'){
    if (buildBtn) buildBtn.style.display = 'none';
    if (nameInput) nameInput.style.display = 'none';
    back.style.display = '';
    // ensure play button looks active
    if (playBtn) playBtn.classList.add('active');
  }else{
    if (buildBtn) buildBtn.style.display = '';
    if (nameInput) nameInput.style.display = '';
    back.style.display = 'none';
  }
}


function ensureCanvasToolbar(){
  // UI polish: do not create a second toolbar above the canvas. Tabs live
  // in the header (.hero-tabs); titleInput lives in .builder-header. No-op.
  return;
}



// --- Replace "Tap a widget..." hint with the Build/Play/Name toolbar ---
function placeToolbarWhereHintWas(){
  // UI polish: keep the canvas hint in place and do not relocate the
  // (now non-existent) canvas toolbar over it. No-op.
  return;
}


document.addEventListener('DOMContentLoaded', init);

document.addEventListener('click', (e)=>{
  const btn = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
  if (!btn) return;
  const tab = btn.getAttribute('data-tab');
  try{ updateToolbarForMode(tab); }catch(e){}
});

(function(){
  // --- header height -> CSS var (avoid overlap with sticky header) ---
  function updateHeaderH(){
    const hdr = document.querySelector('.hero-header, header');
    const h = hdr ? Math.ceil(hdr.getBoundingClientRect().height) : 90;
    document.documentElement.style.setProperty('--headerH', h+'px');
  }
  window.addEventListener('resize', updateHeaderH);
  window.addEventListener('load', updateHeaderH);

  // --- v2.4: viewport changes must NEVER rewrite layout geometry ---
  // v2.2 used Auto-Tidy when the visible Build area became narrower than the
  // design. With v2.3 Fit/Zoom/Pan that behavior is both unnecessary and
  // destructive: Build → Import → Play → Build could repack every widget.
  // Only the explicit Tidy button is allowed to call autoArrangeWidgets().
  let buildViewRefreshT = null;
  function refreshBuildViewportOnly(){
    clearTimeout(buildViewRefreshT);
    buildViewRefreshT = setTimeout(() => {
      try {
        if (!document.querySelector('.builder-view.active')) return;
        if (state.buildFitActive) fitBuildCanvas();
        else { applyBuildCanvasView(); updateBuildCanvasBadge(); }
      } catch(e) {}
    }, 80);
  }
  window.addEventListener('resize', refreshBuildViewportOnly);
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('[data-tab="builder"]');
    if (t) refreshBuildViewportOnly();
  });

  // --- helper UI creation ---
  function ensureHelperUI(){
    if (document.getElementById('helperPanel')) return;

    const panel = document.createElement('div');
    panel.id = 'helperPanel';
    panel.className = 'helper-panel';
    panel.style.display = 'none'; // default: avoid overlapping anything

    panel.innerHTML = `
      <div class="helper-titlebar" id="helperDrag">
        <div class="helper-title">🧰 Helper Tools</div>
        <div class="helper-actions">
          <button class="helper-action" id="helperFold" title="Fold">–</button>
          <button class="helper-action" id="helperClose" title="Hide">✕</button>
        </div>
      </div>
      <div class="helper-body">
        <details class="helper-details" open>
          <summary>🛠 Edit <span>▾</span></summary>
          <div class="helper-content" id="helperEdit"></div>
        </details>
        <details class="helper-details">
          <summary>📐 Arrange <span>▾</span></summary>
          <div class="helper-content" id="helperArrange"></div>
        </details>
        <details class="helper-details">
          <summary>🔎 View <span>▾</span></summary>
          <div class="helper-content" id="helperView"></div>
        </details>
        <details class="helper-details">
          <summary>🗺️ Minimap <span>▾</span></summary>
          <div class="helper-content" id="helperMini"></div>
        </details>
      </div>
    `;
    document.body.appendChild(panel);

    const fab = document.createElement('div');
    fab.id = 'helperFab';
    fab.className = 'helper-fab';
    fab.textContent = '🧰';
    document.body.appendChild(fab);

    // restore panel position if saved
    const saved = localStorage.getItem('helperPanelPos');
    if (saved){
      try{
        const {x,y} = JSON.parse(saved);
        if (Number.isFinite(x) && Number.isFinite(y)){
          panel.style.left = x+'px';
          panel.style.top = y+'px';
          panel.style.right = 'auto';
        }
      }catch(e){}
    }

    function isBad(el){
      if (!el) return true;
      if (el === document.documentElement || el === document.body) return false;
      if (el.closest && el.closest('.helper-panel')) return true;
      if (el.closest && el.closest('.modal, .modal-bg, .template-modal')) return true;
      // if it's a control, it's "not empty"
      if (el.closest && el.closest('button, a, input, select, textarea, .palette, .palette-card, .props-panel, .hero-header, header')) return true;
      return false;
    }
    function isGoodEmpty(el){
      if (!el) return true;
      if (el === document.documentElement || el === document.body) return true;
      // canvas area counts as "empty enough" for placing the icon (won't block clicks much)
      if (el.closest && (el.closest('#canvas') || el.closest('.canvas') || el.closest('main'))) return true;
      return false;
    }

    function pickFabSide(){
      const y = Math.max(80, window.innerHeight - 70);
      // candidate LEFT: either after left sidebar (if any) or 18px
      const leftBlock = document.querySelector('.left-panel, .sidebar-left, .side-left, .menu-left, .builder-sidebar, .palette-card, .palette');
      const leftX = leftBlock ? Math.ceil(leftBlock.getBoundingClientRect().right) + 14 : 18;

      // sample a few points in the icon area
      const sample = (x) => {
        const pts = [[x+18,y-18],[x+36,y-18],[x+18,y-36],[x+36,y-36]];
        for (const [px,py] of pts){
          const el = document.elementFromPoint(Math.min(window.innerWidth-1, px), Math.min(window.innerHeight-1, py));
          if (isBad(el)) return false;
        }
        // allow placement if area is generally background/canvas/main
        const el2 = document.elementFromPoint(Math.min(window.innerWidth-1, x+26), Math.min(window.innerHeight-1, y-26));
        return isGoodEmpty(el2);
      };

      if (sample(leftX)) return {side:'left', x:leftX};
      return {side:'right', x: null};
    }

    function placeFab(){
      const pick = pickFabSide();
      if (pick.side === 'left'){
        fab.style.left = pick.x + 'px';
        fab.style.right = 'auto';
      } else {
        fab.style.right = '18px';
        fab.style.left = 'auto';
      }
    }

    function showPanel(){
      fab.style.display = 'none';
      panel.style.display = 'block';
      updateHeaderH();
    }
    function hidePanel(){
      panel.style.display = 'none';
      placeFab();
      fab.style.display = 'flex';
    }

        // close hides; fold just collapses (does NOT hide)
    panel.querySelector('#helperClose').onclick = hidePanel;

    const foldBtn = panel.querySelector('#helperFold');
    function setFolded(on){
      panel.classList.toggle('folded', !!on);
      // icon switch: – when open, + when folded
      foldBtn.textContent = on ? '＋' : '–';
      foldBtn.title = on ? 'Expand' : 'Fold';
      try{ localStorage.setItem('helperPanelFolded', on ? '1' : '0'); }catch(e){}
    }
    // restore folded state - default to folded
    try{
      const savedFold = localStorage.getItem('helperPanelFolded');
      if (savedFold !== '0') setFolded(true); // Folded unless explicitly expanded
    }catch(e){ setFolded(true); }
    foldBtn.onclick = () => setFolded(!panel.classList.contains('folded'));

    fab.onclick = showPanel;

    // Place FAB initially (panel hidden by default)
    placeFab();
    window.addEventListener('resize', placeFab);

    // Dragging (use interact.js if present, else pointer events)
    function enableDrag(){
      const handle = panel.querySelector('#helperDrag');
      if (window.interact){
        let x = panel.offsetLeft, y = panel.offsetTop;
        // if positioned by right/top, offsetLeft might be 0; derive from rect
        const r = panel.getBoundingClientRect();
        x = r.left; y = r.top;

        interact(panel).draggable({
          allowFrom: '#helperDrag',
          listeners: {
            move (event) {
              x += event.dx;
              y += event.dy;
              // clamp in viewport
              const maxX = window.innerWidth - panel.offsetWidth - 6;
              const maxY = window.innerHeight - panel.offsetHeight - 6;
              x = Math.max(6, Math.min(maxX, x));
              y = Math.max(6, Math.min(maxY, y));

              panel.style.left = x + 'px';
              panel.style.top = y + 'px';
              panel.style.right = 'auto';
              localStorage.setItem('helperPanelPos', JSON.stringify({x, y}));
            }
          }
        });
      } else {
        let dragging=false, dx=0, dy=0;
        handle.addEventListener('pointerdown', (e)=>{
          dragging=true;
          const r = panel.getBoundingClientRect();
          dx = e.clientX - r.left;
          dy = e.clientY - r.top;
          handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', (e)=>{
          if (!dragging) return;
          let x = e.clientX - dx;
          let y = e.clientY - dy;
          const maxX = window.innerWidth - panel.offsetWidth - 6;
          const maxY = window.innerHeight - panel.offsetHeight - 6;
          x = Math.max(6, Math.min(maxX, x));
          y = Math.max(6, Math.min(maxY, y));
          panel.style.left = x+'px';
          panel.style.top = y+'px';
          panel.style.right = 'auto';
          localStorage.setItem('helperPanelPos', JSON.stringify({x,y}));
        });
        handle.addEventListener('pointerup', ()=> dragging=false);
      }
    }
    enableDrag();

    // Move existing canvas tools into this panel when they appear
    function moveToolsOnce(){
      const canvas = document.getElementById('canvas') || document.querySelector('.canvas');
      const smart = document.querySelector('.smart-toolbar');
      const tools = document.querySelector('.canvas-tools');
      const zoom = document.querySelector('.zoom-controls');
      const mini = document.querySelector('.minimap');

      if (!smart && !tools && !zoom && !mini) return false;

      // If they are inside canvas, move them
      if (smart) document.getElementById('helperView').appendChild(smart);
      if (zoom) document.getElementById('helperView').appendChild(zoom);
      if (tools) document.getElementById('helperEdit').appendChild(tools);
      if (mini) document.getElementById('helperMini').appendChild(mini);

      // Arrange buttons sometimes were inside smart-toolbar; keep as-is.
      // If there is a second toolbar group for arrange, keep it under Arrange section if present:
      const arrangeBar = document.querySelector('.smart-toolbar.arrange, .arrange-toolbar');
      if (arrangeBar) document.getElementById('helperArrange').appendChild(arrangeBar);

      // Remove any empty leftover wrappers in canvas
      if (canvas){
        canvas.querySelectorAll('.smart-toolbar, .canvas-tools, .zoom-controls, .minimap').forEach(()=>{});
      }
      return true;
    }

    // try a few times until app builds the tools
    let tries = 0;
    const timer = setInterval(()=>{
      tries++;
      if (moveToolsOnce() || tries > 40) clearInterval(timer);
    }, 250);

    // expose for debugging
    window.__helperTools = {showPanel, hidePanel, placeFab};
  }

  // Start after DOM is ready
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', ensureHelperUI);
  } else {
    ensureHelperUI();
  }
})();
/*
  Single Source of Truth + Prop Sync + Warnings + Export Validation
  Source of truth: state.config.widgets
  - Builder DOM widgets mirror config widgets (props + x/y/w/h)
  - Runtime builds ONLY from config widgets (existing behavior)
  - Any UI parameter change must call setProp(id,key,val)
*/
(function(){
  if (window.__SST_PATCH__) return;
  window.__SST_PATCH__ = true;

  // Expose state for debugging/tools if not already
  try { if (window.state == null && typeof state !== "undefined") window.state = state; } catch(e){}

  function deepClone(o){ try{return JSON.parse(JSON.stringify(o));}catch(e){ return o; } }

  function cfgWidgets(){ return (window.state && state.config && Array.isArray(state.config.widgets)) ? state.config.widgets : null; }

  function findCfg(id){
    const arr = cfgWidgets(); if(!arr) return null;
    return arr.find(w=>w && w.id === id) || null;
  }

  // Ensure every config widget has props object
  function ensureProps(cfg){
    if(!cfg) return;
    if(!cfg.props || typeof cfg.props !== "object") cfg.props = {};
  }

  // Apply props to builder DOM widget (visual parity)
  function applyPropsToBuilder(el, cfg){
    if(!el || !cfg) return;
    ensureProps(cfg);
    const p = cfg.props;

    // Store type for generic handling
    if (cfg.type) el.dataset.type = cfg.type;

    // Generic label
    if (p.label != null){
      const lab = el.querySelector('.widget-label');
      if(lab) lab.textContent = p.label;
      el.dataset.label = p.label;
    }

    // LED colors
    if ((cfg.type === 'led') || el.classList.contains('led') || el.dataset.type === 'led'){
      // Use onColor/offColor if present; else fallback to previous defaults
      const onC  = p.onColor  || '#ff5252';
      const offC = p.offColor || 'rgba(255,82,82,0.2)';
      el.dataset.onColor = onC;
      el.dataset.offColor = offC;
      // In builder we show "off" by default unless p.isOn
      const isOn = !!p.isOn;
      el.style.background = isOn ? onC : offC;
    }

    // Button bg color (optional)
    if (cfg.type === 'button' && p.color){
      el.style.background = p.color;
    }

    // Switch/toggle colors (optional)
    if ((cfg.type === 'toggle' || cfg.type === 'switch') && (p.onColor || p.offColor)){
      const isOn = !!p.isOn;
      if (isOn && p.onColor) el.style.background = p.onColor;
      if (!isOn && p.offColor) el.style.background = p.offColor;
    }
  }

  // Apply props to runtime element right after creation (visual parity)
  function applyPropsToRuntime(rtEl, cfg){
    if(!rtEl || !cfg) return;
    ensureProps(cfg);
    const p = cfg.props;

    // LED runtime element uses .rt-led
    if ((cfg.type === 'led') || rtEl.classList.contains('rt-led')){
      const led = rtEl.querySelector('.rt-led') || rtEl;
      const onC  = p.onColor  || '#ff5252';
      const offC = p.offColor || 'rgba(255,82,82,0.2)';
      const isOn = !!p.isOn;
      led.style.background = isOn ? onC : offC;
      if (led.classList.contains('rt-led')){
        led.classList.toggle('on', isOn);
      }
    }

    // Generic label
    if (p.label != null){
      const t = rtEl.querySelector('.rt-label-text');
      if(t) t.textContent = p.label;
    }

    // Button
    if (cfg.type === 'button' && p.color){
      const b = rtEl.querySelector('button') || rtEl;
      b.style.background = p.color;
    }
  }

  // === Single Source of Truth API ===
  window.setProp = function(id, key, val){
    const cfg = findCfg(id);
    if(!cfg) return false;
    ensureProps(cfg);
    cfg.props[key] = val;

    // Mirror to builder element if present
    const el = document.querySelector(`.widget[data-id="${CSS.escape(id)}"]`) || document.getElementById(id);
    if(el) applyPropsToBuilder(el, cfg);

    // If runtime is active, re-render (safe)
    if (state && state.mode === 'runtime' && typeof window.renderRuntime === 'function'){
      try { window.renderRuntime(); } catch(e){}
    }
    return true;
  };

  window.getProp = function(id, key){
    const cfg = findCfg(id);
    if(!cfg || !cfg.props) return undefined;
    return cfg.props[key];
  };

  // === Hook: whenever a builder widget is created/loaded, copy its visual props into config if missing ===
  function normalizeBuilderWidget(el){
    if(!el) return;
    const id = el.dataset.id || el.id;
    if(!id) return;
    const cfg = findCfg(id);
    if(!cfg) return;
    ensureProps(cfg);

    // If LED has dataset or style but props missing -> fill
    if ((cfg.type === 'led') || el.dataset.type === 'led'){
      if(!cfg.props.onColor){
        const c = el.dataset.onColor || el.style.backgroundColor || '#ff5252';
        cfg.props.onColor = c;
      }
      if(!cfg.props.offColor){
        cfg.props.offColor = el.dataset.offColor || 'rgba(255,82,82,0.2)';
      }
    }

    // Label
    const lab = el.querySelector('.widget-label');
    if(lab && cfg.props.label == null) cfg.props.label = lab.textContent;

    applyPropsToBuilder(el, cfg);
  }

  // Run once after load
  window.addEventListener('load', ()=>{
    document.querySelectorAll('.widget').forEach(normalizeBuilderWidget);
  });

  // Observe widgets layer to normalize new widgets
  const layer = document.getElementById('widgetsLayer') || document.querySelector('#widgetsLayer');
  if (layer && window.MutationObserver){
    const mo = new MutationObserver(muts=>{
      muts.forEach(m=>{
        m.addedNodes && m.addedNodes.forEach(n=>{
          if(n && n.classList && n.classList.contains('widget')) normalizeBuilderWidget(n);
          if(n && n.querySelectorAll) n.querySelectorAll('.widget').forEach(normalizeBuilderWidget);
        });
      });
    });
    mo.observe(layer, {childList:true, subtree:true});
  }

  // === Hook color inputs in properties panel (generic) ===
  // Many color pickers exist; we map by label text near it if possible, else fallback to LED onColor.
  document.addEventListener('input', (e)=>{
    const t = e.target;
    if(!t || t.type !== 'color') return;
    const sw = window.selectedWidget;
    if(!sw) return;
    const id = sw.dataset.id || sw.id;
    if(!id) return;

    // Try infer which color field it is
    let key = 'color';
    const lab = t.closest('label') || t.parentElement;
    const txt = (lab && lab.textContent) ? lab.textContent.toLowerCase() : '';
    if (txt.includes('on')) key = 'onColor';
    else if (txt.includes('off')) key = 'offColor';
    else if ((findCfg(id)||{}).type === 'led') key = 'onColor';

    window.setProp(id, key, t.value);
  }, true);

  // === Runtime creation hook: after renderRuntime finishes, apply props to runtime nodes ===
  const origRender = window.renderRuntime;
  if (typeof origRender === 'function'){
    window.renderRuntime = function(){
      const r = origRender.apply(this, arguments);
      try{
        // Attempt to map runtime nodes by data-id or id
        const arr = cfgWidgets() || [];
        arr.forEach(cfg=>{
          const rid = cfg.id;
          let rt = document.querySelector(`#runtimeGrid [data-id="${CSS.escape(rid)}"]`)
                || document.querySelector(`#runtimeGrid #${CSS.escape(rid)}`);
          // If not found, try common class container
          if(rt) applyPropsToRuntime(rt, cfg);
        });
      }catch(e){}
      return r;
    };
  }

  // === Warnings panel: visual state but no props ===
  const warn = document.createElement('div');
  warn.id = 'warnPanel';
  warn.style.cssText = `
    position:fixed; top:calc(var(--headerH, 90px) + 8px); left:10px;
    width:min(340px, 90vw); max-height:32vh; overflow:auto;
    background:rgba(255,165,0,.12); border:2px solid rgba(255,165,0,.85);
    border-radius:12px; padding:10px; z-index:160; color:#fff;
    font:12px system-ui, sans-serif; display:none;
  `;
  warn.innerHTML = `<div style="font-weight:900;letter-spacing:.08em;text-transform:uppercase;">⚠ Props Warnings</div>
  <div id="warnBody" style="margin-top:6px;opacity:.95"></div>`;
  document.body.appendChild(warn);

  function scanWarnings(){
    const arr = cfgWidgets(); if(!arr) return;
    const issues = [];
    arr.forEach(w=>{
      if(!w) return;
      if(!w.props) issues.push({id:w.id, msg:'Missing props object'});
      else if (w.type === 'led'){
        if(!w.props.onColor) issues.push({id:w.id, msg:'LED missing onColor (runtime will default red)'});
        if(!w.props.offColor) issues.push({id:w.id, msg:'LED missing offColor'});
      }
    });
    const body = document.getElementById('warnBody');
    if(!body) return;
    if(issues.length===0){ warn.style.display='none'; return; }
    warn.style.display='block';
    body.innerHTML = issues.map(x=>`<div style="margin:6px 0;"><b>${x.id}</b>: ${x.msg}</div>`).join('');
  }
  setInterval(scanWarnings, 800);

  // === Export-time validation ===
  // If there is an export function, wrap it; else add a button in helper tools if found.
  function validateConfig(){
    const arr = cfgWidgets(); if(!arr) return {ok:true, issues:[]};
    const issues = [];
    arr.forEach(w=>{
      if(!w) return;
      if(!w.props) issues.push(`${w.id}: missing props`);
      if(w.type==='led' && w.props){
        if(!w.props.onColor) issues.push(`${w.id}: LED missing onColor`);
      }
    });
    return {ok: issues.length===0, issues};
  }

  function alertIssues(res){
    if(res.ok) return true;
    alert("Export blocked: fix these first\\n\\n" + res.issues.join("\\n"));
    return false;
  }

  // Try wrap exportProject if exists
  if (typeof window.exportProject === 'function'){
    const orig = window.exportProject;
    window.exportProject = function(){
      const res = validateConfig();
      if(!alertIssues(res)) return;
      return orig.apply(this, arguments);
    };
  }
})();
(function(){
  if(window.__SEL_PATCH__) return;
  window.__SEL_PATCH__ = true;

  function cfgArr(){ return (window.state && state.config && Array.isArray(state.config.widgets)) ? state.config.widgets : []; }
  function findCfg(id){ return cfgArr().find(w=>w && w.id===id) || null; }
  function linkProps(el){
    if(!el) return;
    const id = el.dataset.id || el.id;
    if(!id) return;
    const cfg = findCfg(id);
    if(!cfg) return;
    if(!cfg.props || typeof cfg.props!=="object") cfg.props = {};
    // Single source of truth: builder widget points to cfg.props (same object)
    el.props = cfg.props;
    try{ el.dataset.type = cfg.type || el.dataset.type; }catch(e){}
  }

  // Capture clicks/taps to set selectedWidget reliably
  document.addEventListener('pointerdown', (e)=>{
    const w = e.target && e.target.closest ? e.target.closest('.widget') : null;
    if(!w) return;
    linkProps(w);
    window.selectedWidget = w;
  }, true);

  // Also sync when original code sets selection via click
  document.addEventListener('click', (e)=>{
    const w = e.target && e.target.closest ? e.target.closest('.widget') : null;
    if(!w) return;
    linkProps(w);
    window.selectedWidget = w;
  }, true);

  // Normalize existing widgets once
  window.addEventListener('load', ()=>{
    document.querySelectorAll('.widget').forEach(linkProps);
  });
})();
/* === Helper Tools: ensure buttons actually exist (create if missing) === */
(function(){
  if (window.__HELPER_TOOLS_BUILDER__) return;
  window.__HELPER_TOOLS_BUILDER__ = true;

  function $(s){ return document.querySelector(s); }

  function buildHelperTools(){
    const panel = document.getElementById('helperPanel');
    if(!panel) return false;

    const edit = document.getElementById('helperEdit');
    const arrange = document.getElementById('helperArrange');
    const view = document.getElementById('helperView');
    const miniWrap = document.getElementById('helperMini');

    if(!edit || !arrange || !view || !miniWrap) return false;

    // If already populated, do nothing
    if (edit.children.length || arrange.children.length || view.children.length) return true;

    // --- Create toolbars (same ids as the rest of your app expects) ---
    const tools = document.createElement('div');
    tools.className = 'canvas-tools';
    tools.innerHTML = `
      <button class="canvas-tool-btn" id="duplicateBtn" title="Duplicate (Ctrl+D)">⧉</button>
      <button class="canvas-tool-btn" id="groupBtn" title="Group (Ctrl+G)">⚭</button>
      <button class="canvas-tool-btn" id="ungroupBtn" title="Ungroup selected group">⚯</button>
      <button class="canvas-tool-btn" id="layersBtn" title="Layers (L)">☰</button>
      <button class="canvas-tool-btn" id="themeBtn" title="Theme (T)">🎨</button>
      <button class="canvas-tool-btn" id="bgBtn" title="Canvas Background">🖼️</button>
      <button class="canvas-tool-btn" id="shareBtn" title="Share QR">📱</button>
      <button class="canvas-tool-btn" id="screenshotBtn" title="Screenshot">📸</button>
      <button class="canvas-tool-btn" id="sensorBtn" title="Sensor Sim">🎮</button>
      <button class="canvas-tool-btn" id="pinBtn" title="Pin Reference">📌</button>
      <button class="canvas-tool-btn" id="contrastBtn" title="High Contrast">◐</button>
      <button class="canvas-tool-btn" id="helpBtn" title="Help (?)">❓</button>
    `;
    edit.appendChild(tools);

    const arrangeBar = document.createElement('div');
    arrangeBar.className = 'smart-toolbar arrange-toolbar';
    arrangeBar.innerHTML = `
      <div class="toolbar-group">
        <button class="canvas-tool-btn" id="arrangeGrid" title="Auto Grid">⊞</button>
        <button class="canvas-tool-btn" id="arrangeRows" title="Rows">≡</button>
        <button class="canvas-tool-btn" id="arrangeCols" title="Columns">⫾</button>
      </div>
      <div class="toolbar-group">
        <button class="canvas-tool-btn" id="alignL" title="Align Left">⫷</button>
        <button class="canvas-tool-btn" id="alignR" title="Align Right">⫸</button>
        <button class="canvas-tool-btn" id="alignT" title="Align Top">⊤</button>
        <button class="canvas-tool-btn" id="alignB" title="Align Bottom">⊥</button>
        <button class="canvas-tool-btn" id="distH" title="Distribute H">↔</button>
        <button class="canvas-tool-btn" id="distV" title="Distribute V">↕</button>
      </div>
    `;
    arrange.appendChild(arrangeBar);

    const viewBar = document.createElement('div');
    viewBar.className = 'smart-toolbar';
    viewBar.innerHTML = `
      <div class="toolbar-group">
        <button class="canvas-tool-btn ${window.state?.gridSnap ? 'active' : ''}" id="gridToggle" title="Grid Snap (G)">⊞</button>
        <button class="canvas-tool-btn ${window.state?.showGuides ? 'active' : ''}" id="guidesToggle" title="Guides">┼</button>
        <button class="canvas-tool-btn" id="rulerToggle" title="Ruler">📏</button>
      </div>
    `;
    view.appendChild(viewBar);

    const zoom = document.createElement('div');
    zoom.className = 'zoom-controls';
    zoom.innerHTML = `
      <button class="zoom-btn" id="zoomOut">−</button>
      <div class="zoom-level" id="zoomLevel">100%</div>
      <button class="zoom-btn" id="zoomIn">+</button>
    `;
    view.appendChild(zoom);

    // Minimap container exists in panel; make sure minimap element exists
    let mini = miniWrap.querySelector('.minimap');
    if(!mini){
      mini = document.createElement('div');
      mini.className = 'minimap';
      miniWrap.appendChild(mini);
    }

    // --- Wire events (guard if functions exist) ---
    const bind = (id, fnName) => {
      const el = document.getElementById(id);
      const fn = window[fnName];
      if(el && typeof fn === 'function') el.onclick = fn;
    };

    bind('duplicateBtn','duplicateSelected');
    bind('groupBtn','groupSelected');
    bind('ungroupBtn','ungroupSelected');
    bind('layersBtn','toggleLayers');
    bind('themeBtn','cycleTheme');
    bind('bgBtn','setCanvasBackground');
    bind('shareBtn','generateQR');
    bind('screenshotBtn','exportScreenshot');
    bind('sensorBtn','toggleSensorSim');
    bind('pinBtn','showPinMapping');
    bind('contrastBtn','toggleHighContrast');
    bind('helpBtn','showHelp');

    bind('arrangeGrid','autoArrangeGrid');
    bind('arrangeRows','autoArrangeRows');
    bind('arrangeCols','autoArrangeCols');
    bind('alignL','alignLeft');
    bind('alignR','alignRight');
    bind('alignT','alignTop');
    bind('alignB','alignBottom');
    bind('distH','distributeH');
    bind('distV','distributeV');

    const gridToggle = document.getElementById('gridToggle');
    if(gridToggle){
      gridToggle.onclick = () => {
        if(!window.state) return;
        state.gridSnap = !state.gridSnap;
        gridToggle.classList.toggle('active', state.gridSnap);
        const c = document.getElementById('canvas');
        if(c) c.classList.toggle('show-grid', state.gridSnap);
        if(typeof window.toast==='function') toast(state.gridSnap ? '⊞ Grid ON' : '⊞ Grid OFF', 'success');
      };
    }
    const guidesToggle = document.getElementById('guidesToggle');
    if(guidesToggle){
      guidesToggle.onclick = () => {
        if(!window.state) return;
        state.showGuides = !state.showGuides;
        guidesToggle.classList.toggle('active', state.showGuides);
        if(typeof window.toast==='function') toast(state.showGuides ? '┼ Guides ON' : '┼ Guides OFF', 'success');
      };
    }
    bind('rulerToggle','toggleRuler');

    const zoomIn = document.getElementById('zoomIn');
    const zoomOut = document.getElementById('zoomOut');
    if(zoomIn && typeof window.setZoom==='function') zoomIn.onclick = () => setZoom((state.zoom||1) + 0.1);
    if(zoomOut && typeof window.setZoom==='function') zoomOut.onclick = () => setZoom((state.zoom||1) - 0.1);

    return true;
  }

  // Make sure the helper panel exists and is populated once the app is ready
  const origEnsure = window.ensureHelperUI;
  window.ensureHelperUI = function(){
    const r = origEnsure ? origEnsure.apply(this, arguments) : undefined;
    // try populate after creation
    setTimeout(buildHelperTools, 0);
    setTimeout(buildHelperTools, 250);
    setTimeout(buildHelperTools, 800);
    return r;
  };

  // If setupCanvasTools exists, ensure it creates panel + tools
  const origSetup = window.setupCanvasTools;
  window.setupCanvasTools = function(){
    const r = origSetup ? origSetup.apply(this, arguments) : undefined;
    try{ window.ensureHelperUI(); }catch(e){}
    setTimeout(buildHelperTools, 0);
    return r;
  };

  window.addEventListener('load', ()=>{
    try{ window.ensureHelperUI(); }catch(e){}
    buildHelperTools();
  });
})();
/* === Default View Settings === */
(function(){
  try{
    if(window.state){
      state.gridSnap = false;
      state.showGrid = false;
      state.showGuides = false;
      state.showRuler = true;
    }
  }catch(e){}
})();
/* === Default View Settings (final) === */
(function(){
  try{
    if(window.state){
      state.gridSnap = false;
      state.showGrid = false;
      state.showGuides = true;   // guides ON
      state.showRuler = true;   // ruler ON
    }
  }catch(e){}
})();
(function(){
  const DEFAULT_FILTERS = { ble:true, ok:true, warn:true, error:true, info:true, debug:false, log:true };
  let filters = {...DEFAULT_FILTERS};
  let collapsed = true;
  const MAX_ITEMS = 1500;
  const items = [];
  const $ = (id)=>document.getElementById(id);

  function pad(n,w=2){ return String(n).padStart(w,'0'); }
  function stamp(){
    const d=new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
  }
  function safeJson(x){ try{ return JSON.stringify(x); }catch(e){ return String(x); } }
  function fmt(args){
    return args.map(x=>{
      if (x instanceof Error) return (x.stack || x.message || String(x));
      if (typeof x === 'object') return safeJson(x);
      return String(x);
    }).join(' ');
  }

  function detect(level,msg){
    const s=String(msg);
    let dir=null, out=s, lvl=level||'log';
    const rx=/^\s*\[?BLE\s*RX\]?\s*[:\-]?\s*/i;
    const tx=/^\s*\[?BLE\s*TX\]?\s*[:\-]?\s*/i;
    if (rx.test(s)){ dir='RX'; out=s.replace(rx,''); lvl='ble'; }
    else if (tx.test(s)){ dir='TX'; out=s.replace(tx,''); lvl='ble'; }
    else if (/^\s*\[BLE\]\s*/i.test(s)){ lvl='ble'; out=s.replace(/^\s*\[BLE\]\s*/i,''); }
    return {lvl,dir,out};
  }

  function push(level,msg,meta={}){
    const d=detect(level,msg);
    const it={ ts: stamp(), level: d.lvl, dir: d.dir || meta.dir || null, msg: d.out };
    items.push(it);
    while(items.length>MAX_ITEMS) items.shift();
    updateCount();
    renderSoon();
  }

  function updateCount(){
    const c=$('logCount'); if(!c) return;
    c.textContent = String(items.length);
  }

  function escapeHtml(s){
    return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;");
  }

  let raf=0;
  function renderSoon(force=false){
    if (collapsed && !force) return;
    if (raf) return;
    raf=requestAnimationFrame(()=>{ raf=0; render(); adjustLayout(); });
  }

  function render(){
    const body=$('logBody'); if(!body) return;
    const allow=(lvl)=>!!filters[lvl];
    const html=[];
    for(const it of items){
      if(!allow(it.level)) continue;
      const cls=['log-line', `level-${it.level}`, it.dir?`dir-${it.dir.toLowerCase()}`:''].filter(Boolean).join(' ');
      const tag = it.dir ? `${it.level.toUpperCase()} ${it.dir}` : it.level.toUpperCase();
      html.push(
        `<div class="${cls}"><span class="ts">${escapeHtml(it.ts)}</span><span class="tag">${escapeHtml(tag)}</span><span class="msg">${escapeHtml(it.msg)}</span></div>`
      );
    }
    body.innerHTML = html.join('');
    body.scrollTop = body.scrollHeight;
  }

  // Expose layout adjuster for other injections
  window.__adjustLogsLayout = adjustLayout;
  function adjustLayout(){
    const card=$('logCard');
    const canvasWrap=document.querySelector('.canvas-wrap');
    const resizableWrap=document.getElementById('resizableWrap');
    if(!card) return;
    const h=card.getBoundingClientRect().height||0;
    if(canvasWrap) canvasWrap.style.paddingBottom=(h+14)+'px';
    if(resizableWrap){
      const top=resizableWrap.getBoundingClientRect().top||0;
      const maxH=Math.max(320, Math.floor(window.innerHeight - top - h - 24));
      resizableWrap.style.maxHeight=maxH+'px';
    }
  }

  // Filters UI
  function buildFilters(){
    const host=$('logFilters'); if(!host) return;
    try{
      const saved=JSON.parse(localStorage.getItem('logFilters')||'null');
      if(saved && typeof saved==='object') filters={...filters, ...saved};
    }catch(e){}
    host.innerHTML = `
      <label class="log-chip"><input type="checkbox" data-lvl="ble">BLE</label>
      <label class="log-chip"><input type="checkbox" data-lvl="ok">OK</label>
      <label class="log-chip"><input type="checkbox" data-lvl="warn">WARN</label>
      <label class="log-chip"><input type="checkbox" data-lvl="error">ERROR</label>
      <label class="log-chip"><input type="checkbox" data-lvl="info">INFO</label>
      <label class="log-chip"><input type="checkbox" data-lvl="debug">DEBUG</label>
      <label class="log-chip"><input type="checkbox" data-lvl="log">LOG</label>
    `;
    host.querySelectorAll('input[data-lvl]').forEach(inp=>{
      const lvl=inp.getAttribute('data-lvl');
      inp.checked=!!filters[lvl];
      inp.addEventListener('change', ()=>{
        filters[lvl]=inp.checked;
        localStorage.setItem('logFilters', JSON.stringify(filters));
        renderSoon(true);
      });
    });
  }

  // Export
  function exportTxt(){
    const lines = items.map(it => `[${it.ts}] ${it.level.toUpperCase()}${it.dir?(' '+it.dir):''}  ${it.msg}`);
    const blob = new Blob([lines.join('\\n')], {type:'text/plain'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='logs.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function exportJson(){
    const blob = new Blob([JSON.stringify(items, null, 2)], {type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='logs.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Toggle open/close
  function setCollapsed(next){
    collapsed = next;
    const card=$('logCard'), t=$('logToggle');
    if(card) card.classList.toggle('collapsed', collapsed);
    if(t){
      t.textContent = collapsed ? '▸' : '▾';
      t.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    try{ localStorage.setItem('logCardCollapsed', collapsed ? '1':'0'); }catch(e){}
    // When expanding, force immediate render after DOM updates
    if (!collapsed) {
      setTimeout(() => { render(); adjustLayout(); }, 10);
    }
    adjustLayout();
  }
  function toggle(){ setCollapsed(!collapsed); }

  // APPLOG API (use this for important events)
  window.APPLOG = {
    log:(...a)=>push('log',fmt(a)),
    info:(...a)=>push('info',fmt(a)),
    debug:(...a)=>push('debug',fmt(a)),
    ble:(...a)=>push('ble',fmt(a)),
    rx:(...a)=>push('ble',fmt(a),{dir:'RX'}),
    tx:(...a)=>push('ble',fmt(a),{dir:'TX'}),
    ok:(...a)=>push('ok',fmt(a)),
    warn:(...a)=>push('warn',fmt(a)),
    err:(...a)=>push('error',fmt(a)),
    clear:()=>{ items.length=0; updateCount(); renderSoon(true); },
    exportTxt, exportJson, toggle, open:()=>setCollapsed(false)
  };

  // Capture into the in-app log panel AND still print to DevTools.
  //
  // This used to silence DevTools completely. That made the app
  // effectively undebuggable from the browser console: every
  // console.log in this file vanished, and the only lines that ever
  // appeared in DevTools were browser-generated ones (iframe sandbox,
  // favicon 404, CORS) — which looks exactly like "the code never ran"
  // and cost a long debugging session chasing BLE ghosts that were
  // really just invisible logs.
  //
  // Native methods are grabbed BEFORE the override so forwarding can't
  // recurse. Add ?quiet to the URL to restore the old silent behaviour.
  const nativeConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  const QUIET = /[?&]quiet\b/.test(location.search);
  function tee(level, native) {
    return (...a) => {
      push(level, fmt(a));
      if (!QUIET) { try { native(...a); } catch (e) {} }
    };
  }
  console.log   = tee('log',   nativeConsole.log);
  console.info  = tee('info',  nativeConsole.info);
  console.debug = tee('debug', nativeConsole.debug);
  console.warn  = tee('warn',  nativeConsole.warn);
  console.error = tee('error', nativeConsole.error);

  // Capture uncaught errors. preventDefault() here suppresses the
  // browser's own reporting, so an uncaught exception left NO trace in
  // DevTools at all — no message, no stack, no source line. Only do
  // that in ?quiet mode; otherwise let the error surface normally.
  window.addEventListener('error', (e)=>{
    push('error', e.message || 'Uncaught error');
    if (QUIET && e.preventDefault) e.preventDefault();
  }, true);
  window.addEventListener('unhandledrejection', (e)=>{
    push('error', String(e.reason));
    if (QUIET && e.preventDefault) e.preventDefault();
  }, true);

  // Wire UI
  window.addEventListener('DOMContentLoaded', ()=>{
    buildFilters();

    // restore collapsed state - default to collapsed
    const saved = localStorage.getItem('logCardCollapsed');
    setCollapsed(saved !== '0'); // Collapsed unless explicitly set to expanded

    $('logToggle')?.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); toggle(); }, {passive:false});
    $('logTab')?.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); toggle(); }, {passive:false});

    $('logClear')?.addEventListener('click', ()=>window.APPLOG.clear());
    $('logExportTxt')?.addEventListener('click', exportTxt);
    $('logExportJson')?.addEventListener('click', exportJson);

    // keyboard toggle
    window.addEventListener('keydown', (e)=>{
      if(e.ctrlKey && e.shiftKey && (e.key==='L' || e.key==='l')){ e.preventDefault(); toggle(); }
    }, {passive:false});

    // initial message
    push('ok', 'Logs ready (Ctrl+Shift+L). TX=orange, RX=cyan.');
    adjustLayout();
  });

  window.addEventListener('resize', ()=>adjustLayout());

})();
(function() {
  // Zoom functionality
  let currentZoom = 1;
  const minZoom = 0.2;
  const maxZoom = 3;
  const zoomStep = 0.15;
  
  const zoomLevel = document.getElementById('zoomLevel');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const zoomFitBtn = document.getElementById('zoomFitBtn');
  const zoomResetBtn = document.getElementById('zoomResetBtn');

  // Play toolbar has its own visible controls. v2.6/v2.7 rendered these
  // buttons but never bound them to the zoom functions, so clicks were no-ops.
  const playZoomInBtn = document.getElementById('playZoomInBtn');
  const playZoomOutBtn = document.getElementById('playZoomOutBtn');
  const playZoomFitBtn = document.getElementById('playZoomFitBtn');
  const playZoom100Btn = document.getElementById('playZoom100Btn');
  
  function getZoomTarget() {
    // In fullscreen mode, zoom the runtime grid only
    if (document.body.classList.contains('runtime-fullscreen')) {
      return document.getElementById('runtimeGrid');
    }
    // In normal runtime view, still zoom the grid
    const runtimeView = document.querySelector('.runtime-view');
    if (runtimeView && runtimeView.classList.contains('active')) {
      return document.getElementById('runtimeGrid');
    }
    // Otherwise zoom the app (builder mode)
    return document.querySelector('.app');
  }
  
  function getRuntimeCanvasViewport() {
    return document.getElementById('runtimeCanvasViewport');
  }

  function getRuntimeLogicalCanvasSize() {
    const grid = document.getElementById('runtimeGrid');
    const cfgCanvas = state.runtimeCanvasSize || state.config?.canvas || {};
    const w = Math.max(1, Number(cfgCanvas.w) || parseFloat(grid?.style.width) || grid?.offsetWidth || 1);
    const h = Math.max(1, Number(cfgCanvas.h) || parseFloat(grid?.style.height) || grid?.offsetHeight || 1);
    return { w, h };
  }

  function applyRuntimeViewport(zoom, crop = null) {
    const grid = document.getElementById('runtimeGrid');
    const frame = getRuntimeCanvasViewport();
    if (!grid || !frame) return;
    const canvas = getRuntimeLogicalCanvasSize();
    const z = Math.max(minZoom, Math.min(maxZoom, zoom));

    // v2.12: the frame owns the scaled layout footprint. The logical grid is
    // absolutely positioned inside it and may be cropped for Fit Content.
    // This avoids flex-centering a huge 2068x1301 grid into negative space.
    grid.style.zoom = '';
    grid.style.position = 'absolute';
    grid.style.margin = '0';
    grid.style.transformOrigin = 'top left';
    grid.style.transform = `scale(${z})`;

    if (crop) {
      const x = Math.max(0, Math.min(canvas.w, Number(crop.x) || 0));
      const y = Math.max(0, Math.min(canvas.h, Number(crop.y) || 0));
      const w = Math.max(1, Math.min(canvas.w - x, Number(crop.w) || canvas.w));
      const h = Math.max(1, Math.min(canvas.h - y, Number(crop.h) || canvas.h));
      grid.style.left = `${-x * z}px`;
      grid.style.top = `${-y * z}px`;
      frame.style.width = `${w * z}px`;
      frame.style.height = `${h * z}px`;
      frame.style.overflow = 'hidden';
      frame.dataset.fitCrop = JSON.stringify({ x, y, w, h });
    } else {
      grid.style.left = '0px';
      grid.style.top = '0px';
      frame.style.width = `${canvas.w * z}px`;
      frame.style.height = `${canvas.h * z}px`;
      frame.style.overflow = 'hidden';
      delete frame.dataset.fitCrop;
    }
  }

  function applyZoom(zoom) {
    const builderView = document.querySelector('.builder-view');
    if (builderView && builderView.classList.contains('active') && typeof setBuildZoom === 'function') {
      setBuildZoom(zoom);
      currentZoom = state.buildZoom || zoom;
      if (zoomLevel) zoomLevel.textContent = Math.round(currentZoom * 100) + '%';
      return;
    }
    currentZoom = Math.max(minZoom, Math.min(maxZoom, zoom));

    const runtimeView = document.querySelector('.runtime-view');
    const inRuntime = !!(runtimeView && runtimeView.classList.contains('active'));
    if (inRuntime) {
      state.playZoom = currentZoom;
      state.playViewRequestToken++;
    }

    const target = getZoomTarget();
    if (target) {
      if (inRuntime && target.id === 'runtimeGrid') {
        // Manual Play zoom/1:1 always exposes the full logical canvas. Fit
        // uses applyRuntimeViewport() with an explicit occupied-content crop.
        setPlayContentFitMode(false);
        applyRuntimeViewport(currentZoom, null);
      } else {
        target.style.zoom = '';
        target.style.transform = `scale(${currentZoom})`;
        target.style.transformOrigin = 'top left';
      }
      if (target.classList.contains('app') || target.classList.contains('app-scaler')) {
        document.body.classList.toggle('scaled', currentZoom !== 1);
      }
    }

    if (zoomLevel) zoomLevel.textContent = Math.round(currentZoom * 100) + '%';
    const playLevel = document.getElementById('playZoomLevel');
    if (playLevel && inRuntime) playLevel.textContent = Math.round(currentZoom * 100) + '%';
    if (currentZoom >= 0.5 && currentZoom <= 3) {
      try { if (inRuntime) localStorage.setItem('play_zoom', currentZoom); else localStorage.setItem('build_zoom', currentZoom); } catch(e) {}
    }
  }

  function zoomIn() {
    applyZoom(currentZoom + zoomStep);
  }
  
  function zoomOut() {
    applyZoom(currentZoom - zoomStep);
  }
  
  function setPlayContentFitMode(on) {
    const runtimeView = document.querySelector('.runtime-view.active');
    if (!runtimeView) return;
    runtimeView.classList.toggle('play-content-fit', !!on);
    state.playFitActive = !!on;
  }

  function getRuntimeOccupiedBounds() {
    const widgets = Array.isArray(state.config?.widgets) ? state.config.widgets : [];
    // Structural helpers should not force Play to waste screen space. A group
    // may intentionally be much larger than its useful controls, and a long
    // separator may span the authoring canvas. Fit the functional widgets.
    const primary = widgets.filter(w => w && !w.hidden && w.t !== 'group' && w.t !== 'separator'
      && Number.isFinite(Number(w.x)) && Number.isFinite(Number(w.y))
      && Number(w.w) > 0 && Number(w.h) > 0);
    const list = primary.length ? [...primary] : widgets.filter(w => w && !w.hidden && Number(w.w) > 0 && Number(w.h) > 0);
    if (!list.length) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const union = w => {
      const x = Number(w.x) || 0, y = Number(w.y) || 0;
      const width = Math.max(1, Number(w.w) || 1), height = Math.max(1, Number(w.h) || 1);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width); maxY = Math.max(maxY, y + height);
    };
    list.forEach(union);

    // Preserve useful structural decoration without letting an accidental giant
    // group/separator define the whole Fit rectangle.
    if (primary.length) {
      const baseW = Math.max(1, maxX - minX), baseH = Math.max(1, maxY - minY);
      widgets.filter(w => w && !w.hidden && (w.t === 'group' || w.t === 'separator')).forEach(w => {
        const x = Number(w.x)||0, y=Number(w.y)||0, ww=Math.max(1,Number(w.w)||1), hh=Math.max(1,Number(w.h)||1);
        const intersects = !(x+ww < minX || x > maxX || y+hh < minY || y > maxY);
        const reasonable = ww <= baseW * 1.5 && hh <= baseH * 1.5;
        if (intersects && reasonable) union(w);
      });
    }
    return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  function zoomFit() {
    const builderView = document.querySelector('.builder-view');
    if (builderView && builderView.classList.contains('active') && typeof fitBuildCanvas === 'function') {
      fitBuildCanvas();
      currentZoom = state.buildZoom || 1;
      if (zoomLevel) zoomLevel.textContent = Math.round(currentZoom * 100) + '%';
      return;
    }

    const runtimeView = document.querySelector('.runtime-view.active');
    const runtimeContent = document.getElementById('runtimeContent');
    const grid = document.getElementById('runtimeGrid');
    const frame = getRuntimeCanvasViewport();
    if (!runtimeView || !runtimeContent || !grid || !frame) return;

    const bounds = getRuntimeOccupiedBounds();
    if (!bounds) return;
    const canvas = getRuntimeLogicalCanvasSize();
    const CONTENT_PAD = 28;
    const cropX = Math.max(0, bounds.minX - CONTENT_PAD);
    const cropY = Math.max(0, bounds.minY - CONTENT_PAD);
    const cropMaxX = Math.min(canvas.w, bounds.maxX + CONTENT_PAD);
    const cropMaxY = Math.min(canvas.h, bounds.maxY + CONTENT_PAD);
    const cropW = Math.max(1, cropMaxX - cropX);
    const cropH = Math.max(1, cropMaxY - cropY);

    // Measure the actual space below the fixed application header and Play
    // toolbar. Do not use the huge logical grid's current bounding box.
    const isFs = document.body.classList.contains('runtime-fullscreen');
    // In narrow fullscreen layouts the Play toolbar can wrap to two rows and the
    // title can become taller. Reserve the *actual* chrome height before fitting
    // content instead of assuming a fixed 68px strip. This keeps the controller
    // below the toolbar/title at desktop, tablet and phone widths.
    if (isFs) {
      const titleRect = document.getElementById('runtimeTitle')?.getBoundingClientRect();
      const toolbarRect = document.querySelector('.runtime-top-btns')?.getBoundingClientRect();
      const chromeBottom = Math.max(
        Number(titleRect?.bottom) || 0,
        Number(toolbarRect?.bottom) || 0,
        68
      );
      runtimeView.style.setProperty('--play-fullscreen-top', `${Math.ceil(chromeBottom + 12)}px`);
    }
    const rvStyle = getComputedStyle(runtimeView);
    const padX = (parseFloat(rvStyle.paddingLeft) || 0) + (parseFloat(rvStyle.paddingRight) || 0);
    const contentRect = runtimeContent.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const availW = Math.max(160, runtimeView.clientWidth - padX - 16);
    // Measure from where the controller frame actually starts after all fixed
    // header/fullscreen chrome has been laid out. Using runtimeView.clientHeight
    // in fullscreen over-counted the 68px reserved top strip, making the fitted
    // frame extend below the viewport on common 16:9 screens.
    const top = Math.max(contentRect.top, frameRect.top, 0);
    const availH = Math.max(160, window.innerHeight - top - 18);

    const fitZoom = Math.max(minZoom, Math.min(maxZoom, availW / cropW, availH / cropH));
    currentZoom = fitZoom;
    state.playZoom = fitZoom;
    setPlayContentFitMode(true);
    applyRuntimeViewport(fitZoom, { x: cropX, y: cropY, w: cropW, h: cropH });

    const playLevel = document.getElementById('playZoomLevel');
    if (playLevel) playLevel.textContent = Math.round(fitZoom * 100) + '%';
    if (zoomLevel) zoomLevel.textContent = Math.round(fitZoom * 100) + '%';

    // The Fit frame itself is now exactly the occupied controller bounds, so
    // there is no need to scroll the giant authoring canvas to find content.
    try { runtimeView.scrollTo({ left: 0, top: 0, behavior: 'auto' }); } catch (e) {
      runtimeView.scrollLeft = 0; runtimeView.scrollTop = 0;
    }
  }

  function zoomReset() {
    setPlayContentFitMode(false);
    applyZoom(1);
  }
  
  // Event listeners
  if (zoomInBtn) zoomInBtn.onclick = zoomIn;
  if (zoomOutBtn) zoomOutBtn.onclick = zoomOut;
  if (zoomFitBtn) zoomFitBtn.onclick = zoomFit;
  if (zoomResetBtn) zoomResetBtn.onclick = zoomReset;

  // Play-mode navigation controls. Keep these explicit instead of depending on
  // the legacy floating zoom palette, which is hidden in normal Play mode.
  if (playZoomInBtn) playZoomInBtn.onclick = () => {
    currentZoom = state.playZoom || currentZoom || 1;
    zoomIn();
  };
  if (playZoomOutBtn) playZoomOutBtn.onclick = () => {
    currentZoom = state.playZoom || currentZoom || 1;
    zoomOut();
  };
  if (playZoomFitBtn) playZoomFitBtn.onclick = () => {
    currentZoom = state.playZoom || currentZoom || 1;
    zoomFit();
  };
  if (playZoom100Btn) playZoom100Btn.onclick = () => {
    currentZoom = state.playZoom || currentZoom || 1;
    zoomReset();
    const runtimeView = document.querySelector('.runtime-view.active');
    try { runtimeView?.scrollTo({ left: 0, top: 0, behavior: 'auto' }); } catch (e) {}
  };
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const runtimeActive = !!document.querySelector('.runtime-view.active');
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable;
    if (runtimeActive && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      zoomFit();
      return;
    }
    // Ctrl/Cmd + Plus/Minus for zoom
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomReset();
      }
    }
  });
  
  // Mouse wheel zoom with Ctrl
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    }
  }, { passive: false });
  
  // Pinch zoom for touch devices
  let lastTouchDistance = 0;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
    }
  }, { passive: true });
  
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (lastTouchDistance > 0) {
        const delta = (distance - lastTouchDistance) / 200;
        applyZoom(currentZoom + delta);
      }
      
      lastTouchDistance = distance;
    }
  }, { passive: true });
  
  document.addEventListener('touchend', () => {
    lastTouchDistance = 0;
  }, { passive: true });
  
  // Load saved zoom (with validation)
  try {
    // Check for reset parameter in URL
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('reset_zoom') === '1' || urlParams.get('reset') === '1') {
      localStorage.removeItem('app_zoom');
      localStorage.removeItem('build_zoom');
      localStorage.removeItem('play_zoom');
      console.log('[Zoom] Reset via URL parameter');
      // Clean URL
      if (window.history.replaceState) {
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
      }
    }
    
    const legacyZoom = localStorage.getItem('app_zoom');
    const savedBuildZoom = localStorage.getItem('build_zoom') || legacyZoom;
    const savedPlayZoom = localStorage.getItem('play_zoom');
    const bz = parseFloat(savedBuildZoom || '1');
    const pz = parseFloat(savedPlayZoom || '1');
    if (!isNaN(bz) && bz >= 0.15 && bz <= 2.5) state.buildZoom = bz;
    if (!isNaN(pz) && pz >= minZoom && pz <= maxZoom) state.playZoom = pz;
    currentZoom = state.buildZoom || 1;
    try { applyBuildCanvasView(); } catch (_) {}
  } catch(e) {
    console.warn('[Zoom] Error loading saved zoom:', e);
  }
  
  // Keep an active Fit stable when the browser/fullscreen viewport changes.
  let playFitResizeTimer = null;
  window.addEventListener('resize', () => {
    if (!state.playFitActive || !document.querySelector('.runtime-view.active')) return;
    clearTimeout(playFitResizeTimer);
    playFitResizeTimer = setTimeout(() => { try { zoomFit(); } catch (_) {} }, 80);
  });

  // Expose for other scripts
  window.appZoom = {
    zoomIn,
    zoomOut,
    zoomFit,
    zoomReset,
    getZoom: () => currentZoom,
    setZoom: applyZoom
  };
})();
(function(){
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  function applyWH(w,h){
    const card=document.getElementById('logCard'); if(!card) return;
    const W=clamp(Math.floor(w||380), 260, 960);
    const H=clamp(Math.floor(h||420), 220, Math.floor(window.innerHeight-20));
    card.style.setProperty('--logsW', W+'px');
    card.style.setProperty('--logsH', H+'px');
    card.style.setProperty('width', W+'px', 'important');
    card.style.setProperty('height', H+'px', 'important');
    card.style.width=W+'px'; card.style.height=H+'px';
    try{ localStorage.setItem('logsWidth', String(W)); localStorage.setItem('logsHeight', String(H)); }catch(e){}
    try{
      const pad = card.classList.contains('collapsed') ? 0 : Math.min(740, W + 18);
      const canvasWrap=document.querySelector('.canvas-wrap');
      if(canvasWrap){ canvasWrap.style.paddingRight = pad+'px'; canvasWrap.style.paddingBottom=''; }
    }catch(e){}
  }
  function ensure(){
    const card=document.getElementById('logCard'); if(!card) return false;
    // Add handles
    if(!document.getElementById('logResizeHandleX')){
      const hx=document.createElement('div'); hx.id='logResizeHandleX'; card.appendChild(hx);
      const hy=document.createElement('div'); hy.id='logResizeHandleY'; card.appendChild(hy);
      const hxy=document.createElement('div'); hxy.id='logResizeHandleXY'; card.appendChild(hxy);
    }
    // Apply saved
    try{
      const sw=parseInt(localStorage.getItem('logsWidth')||'380',10);
      const sh=parseInt(localStorage.getItem('logsHeight')||'420',10);
      applyWH(Number.isNaN(sw)?380:sw, Number.isNaN(sh)?420:sh);
    }catch(e){ applyWH(380,420); }
    if(card.__resizerBound) return true;
    card.__resizerBound=true;

    function cx(e){ if(e.touches&&e.touches[0]) return e.touches[0].clientX; if(e.changedTouches&&e.changedTouches[0]) return e.changedTouches[0].clientX; return e.clientX; }
    function cy(e){ if(e.touches&&e.touches[0]) return e.touches[0].clientY; if(e.changedTouches&&e.changedTouches[0]) return e.changedTouches[0].clientY; return e.clientY; }

    const hx=document.getElementById('logResizeHandleX');
    const hy=document.getElementById('logResizeHandleY');
    const hxy=document.getElementById('logResizeHandleXY');

    let mode=null, startX=0, startY=0, startW=0, startH=0;

    function down(m,e){
      if(card.classList.contains('collapsed')) return;
      mode=m;
      startX=cx(e); startY=cy(e);
      const r=card.getBoundingClientRect();
      startW=r.width; startH=r.height;
      document.body.style.userSelect='none';
      document.body.style.cursor = (m==='x'?'ew-resize':m==='y'?'ns-resize':'nwse-resize');
      e.preventDefault?.();
    }
    function move(e){
      if(!mode) return;
      const dx=cx(e)-startX;
      const dy=cy(e)-startY;
      // left-edge drag for X => width increases when moving left (negative dx)
      let W=startW, H=startH;
      if(mode==='x') W = startW - dx;
      if(mode==='y') H = startH + dy; // bottom edge
      if(mode==='xy'){ W = startW - dx; H = startH + dy; }
      applyWH(W,H);
      e.preventDefault?.();
    }
    function up(){
      if(!mode) return;
      mode=null;
      document.body.style.userSelect='';
      document.body.style.cursor='';
    }

    // Bind events
    function bindHandle(el,m){
      el.addEventListener('pointerdown', down.bind(null,m), {passive:false});
      el.addEventListener('mousedown', down.bind(null,m), {passive:false});
      el.addEventListener('touchstart', down.bind(null,m), {passive:false});
    }
    bindHandle(hx,'x'); bindHandle(hy,'y'); bindHandle(hxy,'xy');

    window.addEventListener('pointermove', move, {passive:false});
    window.addEventListener('pointerup', up, {passive:true});
    window.addEventListener('pointercancel', up, {passive:true});
    window.addEventListener('mousemove', move, {passive:false});
    window.addEventListener('mouseup', up, {passive:true});
    window.addEventListener('touchmove', move, {passive:false});
    window.addEventListener('touchend', up, {passive:true});
    window.addEventListener('touchcancel', up, {passive:true});

    return true;
  }

  let tries=0;
  const timer=setInterval(()=>{ if(ensure() || ++tries>140) clearInterval(timer); }, 150);
  const obs=new MutationObserver(()=>{ ensure(); });
  obs.observe(document.documentElement, {childList:true, subtree:true});
})();
/* v21: Only the right-side LOGS tab toggles collapse/expand */
(function(){
  function $(sel, root=document){ return root.querySelector(sel); }
  function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

  function bindOnce(){
    const card = document.getElementById('logCard');
    const tab  = document.getElementById('logTab');
    if(!card || !tab) return false;

    // Hide/remove any extra toggle controls in the header, but keep action buttons (Clear/TXT/JSON).
    const head = card.querySelector('#logHead') || card.querySelector('.logTop') || card;
    const actions = head.querySelector('#logActions') || head; // safe fallback

    // Any buttons inside head that are NOT inside #logActions are treated as toggles/UI chrome -> hide them.
    $all('button', head).forEach(btn=>{
      if(actions && actions.contains(btn)) return; // keep Clear/TXT/JSON etc.
      // keep nothing else in header
      btn.style.display = 'none';
      btn.disabled = true;
      btn.setAttribute('aria-hidden','true');
    });

    // Also disable click toggles on title area if any (some builds make LOGS title clickable)
    const title = head.querySelector('#logTitle') || head.querySelector('.logTitle');
    if(title){
      title.style.pointerEvents = 'none';
    }

    // Make sure tab toggles collapsed state
    if(!tab.__onlyToggleBound){
      tab.__onlyToggleBound = true;
      tab.addEventListener('click', ()=>{
        card.classList.toggle('collapsed');
        try{ localStorage.setItem('logsCollapsed', String(card.classList.contains('collapsed'))); }catch(e){}
        // When expanding: re-enable pointer events automatically via CSS (not collapsed).
        try{ if(typeof window.__adjustLogsLayout==='function') window.__adjustLogsLayout(); }catch(e){}
      });
    }

    // Ensure card reflects saved collapsed state
    try{
      const saved = (localStorage.getItem('logsCollapsed') ?? 'true') === 'true';
      card.classList.toggle('collapsed', saved);
    }catch(e){}

    return true;
  }

  let tries=0;
  const t=setInterval(()=>{
    if(bindOnce() || ++tries>200) clearInterval(t);
  }, 100);

  const obs=new MutationObserver(()=>{ bindOnce(); });
  obs.observe(document.documentElement, {childList:true, subtree:true});
})();

// 🎉 Fun random logo reactions
document.addEventListener('DOMContentLoaded', () => {
  const logo = document.querySelector('.hero-logo.fun-logo');
  if (!logo) return;

  const effects = ['spin', 'shake', 'flip'];

  logo.addEventListener('dblclick', () => {
    const effect = effects[Math.floor(Math.random() * effects.length)];
    logo.classList.remove('spin', 'shake', 'flip');
    // force reflow to restart animation
    void logo.offsetWidth;
    logo.classList.add(effect);
  });
});


// v2.3 Build viewport boot
document.addEventListener('DOMContentLoaded', () => {
  try { makeCanvasResizable(); setupBuildCanvasViewControls(); applyBuildCanvasView(); } catch(e) { console.warn('[BuildViewport]', e); }
});

// ── Firmware dialog ────────────────────────────────────────────────────────
// The source is embedded in a text/plain script block rather than fetched:
// this page is normally opened from file://, where fetch() is blocked, so a
// runtime read would fail precisely when someone needs the code. Regenerate
// the block with the embed tool that lives in the robot's own repository,
// e.g. keystudio_4wd_mecanum_rxy/tools/embed-firmware.cjs. This app ships no
// firmware of its own.
// ── SHARE ───────────────────────────────────────────────────────────────
// A QR of the PUBLISHED address, so the next person can open this app without
// anyone typing a URL into a tablet keyboard. Deliberately not location.href:
// run from file:// or a laptop's localhost -- which is exactly how it gets
// demonstrated -- that would encode an address their phone cannot reach.
//
// The image is baked into index.html. The address is a constant, so there is
// no reason to carry an encoder that recomputes the same picture every load.
(function initShareDialog() {
  const modal = document.getElementById('shareModal');
  const btn = document.getElementById('shareBtn');
  if (!modal || !btn) return;

  const close = () => modal.classList.add('hidden');
  btn.onclick = () => {
    modal.classList.remove('hidden');
    // Nothing here is destructive, so ANY tap closes it -- including on the
    // code itself, which people will poke at. The link is the exception.
    modal.focus();
  };
  modal.onclick = e => {
    if (e.target.closest('.qr-url')) return;
    close();
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
})();

(function initFirmwareDialog() {
  const srcEl = document.getElementById('fwSource');
  const modal = document.getElementById('fwModal');
  const btn = document.getElementById('fwBtn');
  if (!modal || !btn) return;
  // No embedded firmware: hide the button rather than leaving one that does
  // nothing when pressed. This app is robot-neutral, so there is no single
  // firmware to show; a robot-specific fork that re-adds the fwSource block
  // gets the dialog back with no further change.
  if (!srcEl) { btn.style.display = 'none'; return; }

  // ^\r?\n, not ^\n: these files are CRLF on disk, so stripping only the \n
  // leaves a stray carriage return at the top of the shown — and copied — code.
  const source = (srcEl.textContent || '').replace(/^\r?\n/, '');
  document.getElementById('fwCode').textContent = source;

  // Read the version out of the firmware itself, so the dialog can never
  // claim a build the embedded file is not.
  const ver = (source.match(/FIRMWARE_VERSION\s*=\s*"([^"]+)"/) || [])[1];
  document.getElementById('fwVersion').textContent = ver || '—';
  document.getElementById('fwBuilt').textContent = srcEl.dataset.built || '—';

  const show = on => modal.classList.toggle('show', on);
  btn.addEventListener('click', () => show(true));
  document.getElementById('fwClose').addEventListener('click', () => show(false));
  modal.addEventListener('click', e => { if (e.target === modal) show(false); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('show')) show(false);
  });

  // navigator.clipboard needs a secure context. file:// qualifies in Chrome
  // but not everywhere, so fall back rather than failing silently.
  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(label + ' copied', 'success');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(label + ' copied', 'success'); }
      catch (__) { toast('Copy failed — select the text manually', 'error'); }
      ta.remove();
    }
  }

  document.getElementById('fwCopy').addEventListener('click', () => copyText(source, 'Firmware code'));
  modal.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
    const el = document.querySelector(b.dataset.copy);
    copyText(el.value !== undefined ? el.value : el.textContent, 'Text');
  }));
})();
