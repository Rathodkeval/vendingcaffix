import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Prevent zoom gestures (pinch-to-zoom and double-tap zoom) for touchscreen kiosks
document.addEventListener('touchstart', (e) => {
  if (e.touches.length > 1) {
    e.preventDefault();
  }
}, { passive: false });

document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) {
    e.preventDefault();
  }
}, { passive: false });

document.addEventListener('gesturestart', (e) => {
  e.preventDefault();
});

// Web Audio API click/pop synthesizer
let audioCtx = null;
const playClickSound = () => {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.type = 'sine';
    const now = audioCtx.currentTime;
    
    // Smooth frequency sweep for a premium warm pop/click sound
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(150, now + 0.08);

    // Fast decay volume envelope (lasting 80ms)
    gainNode.gain.setValueAtTime(0.35, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.start(now);
    osc.stop(now + 0.08);
  } catch (err) {
    console.warn('Web Audio synthesis failed:', err);
  }
};

// Global instant pointerdown (touch/click) feedback sound listener
document.addEventListener('pointerdown', (e) => {
  const interactive = e.target.closest('button, a, input, select, textarea, [role="button"], .cursor-pointer, .active-touch-feedback');
  if (interactive) {
    playClickSound();
  }
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
