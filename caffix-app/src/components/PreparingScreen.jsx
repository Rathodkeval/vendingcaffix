import React, { useState, useEffect, useRef } from 'react';
import { Check } from 'lucide-react';

// Web Audio API Kiosk Sound Synthesizer Class
class BrewingAudioController {
  constructor() {
    this.audioCtx = null;
    this.humNode = null;
    this.pourNoiseNode = null;
    this.pourFilterNode = null;
    this.pourGainNode = null;
    this.steamNoiseNode = null;
    this.steamGainNode = null;
    this.bubbleTimer = null;
  }

  init() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
    } catch (e) {
      console.warn('Web Audio init failed:', e);
    }
  }

  startStartupHum() {
    this.init();
    if (!this.audioCtx) return;

    try {
      const now = this.audioCtx.currentTime;
      const osc1 = this.audioCtx.createOscillator();
      const osc2 = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(60, now); // Low machine hum
      
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(120, now); // Warm harmonic

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 1.0); // Smooth hum fade-in

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc1.start(now);
      osc2.start(now);

      this.humNode = { osc1, osc2, gain };
    } catch (e) {
      console.warn('Hum start failed:', e);
    }
  }

  stopStartupHum() {
    if (this.humNode && this.audioCtx) {
      try {
        const now = this.audioCtx.currentTime;
        this.humNode.gain.gain.setValueAtTime(this.humNode.gain.gain.value, now);
        this.humNode.gain.gain.linearRampToValueAtTime(0, now + 0.5);
        const node = this.humNode;
        setTimeout(() => {
          try {
            node.osc1.stop();
            node.osc2.stop();
          } catch (e) {}
        }, 500);
        this.humNode = null;
      } catch (e) {}
    }
  }

  startPouringSound() {
    this.init();
    if (!this.audioCtx) return;

    try {
      const now = this.audioCtx.currentTime;
      const bufferSize = 2 * this.audioCtx.sampleRate;
      const noiseBuffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      
      // Pink/White noise generation
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }

      const noiseSource = this.audioCtx.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;

      // Resonant Lowpass filter to simulate dynamic acoustic volume changes
      const filter = this.audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1100, now);

      const gain = this.audioCtx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.1, now + 0.4);

      noiseSource.connect(filter);
      filter.connect(gain);
      gain.connect(this.audioCtx.destination);

      noiseSource.start(now);

      this.pourNoiseNode = noiseSource;
      this.pourFilterNode = filter;
      this.pourGainNode = gain;
    } catch (e) {
      console.warn('Pouring sound start failed:', e);
    }
  }

  updatePouringPitch(progress) {
    if (this.pourFilterNode && this.audioCtx) {
      try {
        const now = this.audioCtx.currentTime;
        // Pitch/Frequency sweeps down as cup fills to model liquid resonance physics
        const targetFreq = 1100 - (progress * 8.5);
        this.pourFilterNode.frequency.setTargetAtTime(Math.max(220, targetFreq), now, 0.2);
      } catch (e) {}
    }
  }

  stopPouringSound() {
    if (this.pourNoiseNode && this.pourGainNode && this.audioCtx) {
      try {
        const now = this.audioCtx.currentTime;
        this.pourGainNode.gain.setValueAtTime(this.pourGainNode.gain.value, now);
        this.pourGainNode.gain.linearRampToValueAtTime(0, now + 0.3);
        const node = this.pourNoiseNode;
        setTimeout(() => {
          try {
            node.stop();
          } catch (e) {}
        }, 300);
        this.pourNoiseNode = null;
        this.pourFilterNode = null;
        this.pourGainNode = null;
      } catch (e) {}
    }
  }

  startSteamSound() {
    this.init();
    if (!this.audioCtx) return;

    try {
      const now = this.audioCtx.currentTime;
      const bufferSize = this.audioCtx.sampleRate;
      const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const filter = this.audioCtx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(5500, now); // High steam hiss

      const gain = this.audioCtx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.012, now + 1.0); // Delicate background volume

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.audioCtx.destination);

      source.start(now);

      this.steamNoiseNode = source;
      this.steamGainNode = gain;
    } catch (e) {
      console.warn('Steam sound start failed:', e);
    }
  }

  stopSteamSound() {
    if (this.steamNoiseNode && this.steamGainNode && this.audioCtx) {
      try {
        const now = this.audioCtx.currentTime;
        this.steamGainNode.gain.setValueAtTime(this.steamGainNode.gain.value, now);
        this.steamGainNode.gain.linearRampToValueAtTime(0, now + 0.6);
        const node = this.steamNoiseNode;
        setTimeout(() => {
          try {
            node.stop();
          } catch (e) {}
        }, 600);
        this.steamNoiseNode = null;
        this.steamGainNode = null;
      } catch (e) {}
    }
  }

  startBubblingSound() {
    const playBubblePop = () => {
      if (!this.audioCtx || this.audioCtx.state === 'suspended') return;
      try {
        const now = this.audioCtx.currentTime;
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc.type = 'sine';
        const pitch = 1100 + Math.random() * 700;
        osc.frequency.setValueAtTime(pitch, now);
        osc.frequency.exponentialRampToValueAtTime(pitch / 2.2, now + 0.04);

        gain.gain.setValueAtTime(0.007, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);

        osc.start(now);
        osc.stop(now + 0.04);
      } catch (e) {}
      
      const nextDelay = 70 + Math.random() * 180;
      this.bubbleTimer = setTimeout(playBubblePop, nextDelay);
    };

    playBubblePop();
  }

  stopBubblingSound() {
    if (this.bubbleTimer) {
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = null;
    }
  }

  playCompletionChime() {
    this.init();
    if (!this.audioCtx) return;

    try {
      const now = this.audioCtx.currentTime;
      const osc1 = this.audioCtx.createOscillator();
      const osc2 = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(523.25, now); // C5
      
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(659.25, now); // E5

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc1.start(now);
      osc1.stop(now + 1.8);
      osc2.start(now);
      osc2.stop(now + 1.8);
    } catch (e) {
      console.warn('Chime failed:', e);
    }
  }
}

export default function PreparingScreen({ onComplete }) {
  const [progress, setProgress] = useState(0);
  const [activeStep, setActiveStep] = useState({ text: 'Preheating brewing boilers...', temp: '25°C', press: '0.0 Bar' });
  
  const canvasRef = useRef(null);
  const progressRef = useRef(0);
  const steamParticlesRef = useRef([]);
  const animationFrameIdRef = useRef(null);
  const audioControllerRef = useRef(null);

  // Update helper ref
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // Autoplay Context Activation Trigger
  const handleInteraction = () => {
    if (audioControllerRef.current) {
      audioControllerRef.current.init();
    }
  };

  // 1. Audio Setup & Tear Down
  useEffect(() => {
    const controller = new BrewingAudioController();
    audioControllerRef.current = controller;
    
    // Play startup machine hum and subtle ambient steam
    controller.startStartupHum();
    controller.startSteamSound();

    return () => {
      controller.stopStartupHum();
      controller.stopPouringSound();
      controller.stopSteamSound();
      controller.stopBubblingSound();
    };
  }, []);

  // 2. Main Progress Timer Loop
  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          return 100;
        }
        return prev + 1;
      });
    }, 120); // 100 ticks * 120ms = 12 seconds total duration

    return () => clearInterval(interval);
  }, []);

  // 3. Audio & Telemetry Transitions
  useEffect(() => {
    const audio = audioControllerRef.current;
    if (!audio) return;

    // Trigger pouring sounds at 20%
    if (progress === 20) {
      audio.startPouringSound();
      audio.startBubblingSound();
    }
    // Update liquid acoustics pitch
    if (progress > 20 && progress < 100) {
      audio.updatePouringPitch(progress);
    }
    // Complete cycle chimes
    if (progress === 100) {
      audio.stopPouringSound();
      audio.stopBubblingSound();
      audio.stopStartupHum();
      audio.playCompletionChime();
    }

    // Telemetry updates
    let text = '';
    let temp = '25°C';
    let press = '0.0 Bar';

    if (progress < 20) {
      text = 'Preheating brewing boilers...';
      const currentTemp = Math.round(25 + (progress / 20) * 50);
      temp = `${currentTemp}°C`;
      press = '0.0 Bar';
    } else if (progress < 35) {
      text = 'Grinding premium Arabica beans...';
      const currentTemp = Math.round(75 + ((progress - 20) / 15) * 10);
      temp = `${currentTemp}°C`;
      press = '0.5 Bar';
    } else if (progress < 50) {
      text = 'Heating infusion element...';
      const currentTemp = Math.round(85 + ((progress - 35) / 15) * 7);
      temp = `${currentTemp}°C`;
      press = '1.5 Bar';
    } else if (progress < 80) {
      text = 'Extracting espresso under 9 Bar...';
      temp = '95°C';
      press = '9.0 Bar';
    } else if (progress < 95) {
      text = 'Dispensing warm coffee blend...';
      const currentTemp = Math.round(95 - ((progress - 80) / 15) * 7);
      temp = `${currentTemp}°C`;
      press = '3.0 Bar';
    } else {
      text = 'Dispensing completed! Enjoy!';
      const currentTemp = Math.round(88 - ((progress - 95) / 5) * 16);
      temp = `${currentTemp}°C`;
      press = '0.0 Bar';
    }

    setActiveStep({ text, temp, press });
  }, [progress]);

  // 4. Auto transition redirect timer
  useEffect(() => {
    if (progress === 100) {
      onComplete();
    }
  }, [progress, onComplete]);

  // 5. Canvas Animation Loop (60 FPS)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const render = () => {
      const currentProgress = progressRef.current;
      drawKioskBrewing(ctx, currentProgress, steamParticlesRef.current);
      animationFrameIdRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, []);

  // 2D WebGL-Style Canvas Renderer
  const drawKioskBrewing = (ctx, currentProgress, steamParticles) => {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height * 0.52; // Shift up slightly to fit drip tray and status checkmark

    const cupH = 110;
    const cupTopW = 100;
    const cupBotW = 80;
    const cupY = cy - 40;

    // Calculate Fill Height Percentage
    let fillPct = 0;
    if (currentProgress > 20) {
      fillPct = Math.min(90, ((currentProgress - 20) / 80) * 90);
    }

    const isPouring = currentProgress > 20 && currentProgress < 100;

    // 1. Draw Stainless Drip Tray
    const trayY = cy + cupH - 30;
    const trayWidth = 220;
    const trayHeight = 25;

    // Tray base drop shadow
    ctx.beginPath();
    ctx.ellipse(cx, trayY + 4, trayWidth / 2, 14, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fill();

    // Metallic body gradient
    const trayGrad = ctx.createLinearGradient(cx - trayWidth/2, trayY, cx + trayWidth/2, trayY);
    trayGrad.addColorStop(0, '#8E8E93');
    trayGrad.addColorStop(0.2, '#D1D1D6');
    trayGrad.addColorStop(0.5, '#E5E5EA');
    trayGrad.addColorStop(0.8, '#D1D1D6');
    trayGrad.addColorStop(1, '#8E8E93');

    ctx.beginPath();
    ctx.roundRect(cx - trayWidth / 2, trayY, trayWidth, trayHeight, 6);
    ctx.fillStyle = trayGrad;
    ctx.fill();

    // Drip Slots
    ctx.fillStyle = '#2C1E17';
    for (let i = -3; i <= 3; i++) {
      const slotX = cx + i * 26;
      ctx.beginPath();
      ctx.roundRect(slotX - 7, trayY + 8, 14, 4, 1.5);
      ctx.fill();
    }

    // 2. Draw Dispenser Nozzle
    const nozzleY = 15;
    const nozzleW = 44;
    const nozzleH = 20;
    const nozzleGrad = ctx.createLinearGradient(cx - nozzleW/2, nozzleY, cx + nozzleW/2, nozzleY);
    nozzleGrad.addColorStop(0, '#1C1C1E');
    nozzleGrad.addColorStop(0.5, '#48484A');
    nozzleGrad.addColorStop(1, '#1C1C1E');

    ctx.beginPath();
    ctx.roundRect(cx - nozzleW / 2, nozzleY, nozzleW, nozzleH, [0, 0, 3, 3]);
    ctx.fillStyle = nozzleGrad;
    ctx.fill();

    ctx.beginPath();
    ctx.rect(cx - 5, nozzleY + nozzleH, 10, 5);
    ctx.fillStyle = '#111';
    ctx.fill();

    // 3. Draw Coffee Stream (Liquid physics)
    if (isPouring) {
      const streamStart = nozzleY + nozzleH + 5;
      const streamEnd = cupY + cupH - 6 - (fillPct / 100) * (cupH - 12);

      // Warm glow outer ring
      ctx.beginPath();
      ctx.moveTo(cx - 2.5, streamStart);
      ctx.lineTo(cx + 2.5, streamStart);
      ctx.lineTo(cx + 1.5, streamEnd);
      ctx.lineTo(cx - 1.5, streamEnd);
      ctx.closePath();
      ctx.fillStyle = 'rgba(201, 166, 107, 0.15)';
      ctx.fill();

      // Fluid stream
      const streamGrad = ctx.createLinearGradient(cx - 1.5, streamStart, cx + 1.5, streamStart);
      streamGrad.addColorStop(0, '#1A0F0A');
      streamGrad.addColorStop(0.5, '#4E3629');
      streamGrad.addColorStop(1, '#1A0F0A');

      ctx.beginPath();
      ctx.moveTo(cx - 1.8, streamStart);
      ctx.lineTo(cx + 1.8, streamStart);
      ctx.lineTo(cx + 1.2, streamEnd);
      ctx.lineTo(cx - 1.2, streamEnd);
      ctx.closePath();
      ctx.fillStyle = streamGrad;
      ctx.fill();

      // spec highlights on stream
      ctx.beginPath();
      ctx.moveTo(cx - 0.4, streamStart);
      ctx.lineTo(cx + 0.4, streamStart);
      ctx.lineTo(cx, streamEnd);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fill();
    }

    // 4. Steam Particles updates (increases above 80% progress)
    if (currentProgress > 30) {
      const steamRate = currentProgress > 80 ? 0.08 : 0.04;
      if (Math.random() < steamRate) {
        const liquidH = (fillPct / 100) * (cupH - 12);
        const liquidTopY = cupY + cupH - 6 - liquidH;
        steamParticles.push({
          x: cx + (Math.random() - 0.5) * (cupTopW - 24),
          y: liquidTopY,
          vx: (Math.random() - 0.5) * 0.3,
          vy: -(Math.random() * 0.5 + 0.3),
          size: Math.random() * 12 + 6,
          alpha: Math.random() * 0.1 + 0.04,
          swaySpeed: 0.02 + Math.random() * 0.02,
          swayWidth: 0.15 + Math.random() * 0.3,
          angle: Math.random() * Math.PI
        });
      }
    }

    // Draw Steam
    ctx.save();
    ctx.filter = 'blur(3.5px)';
    for (let i = steamParticles.length - 1; i >= 0; i--) {
      const p = steamParticles[i];
      p.y += p.vy;
      p.angle += p.swaySpeed;
      p.x += p.vx + Math.sin(p.angle) * p.swayWidth;
      p.alpha -= 0.001; // Soft natural fade

      if (p.alpha <= 0 || p.y < 30) {
        steamParticles.splice(i, 1);
        continue;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
      ctx.fill();
    }
    ctx.restore();

    // Inset Cup Inner clipping helper
    const traceCupInner = (ctx) => {
      const glassThickness = 5;
      const topRad = cupTopW / 2 - glassThickness;
      const botRad = cupBotW / 2 - glassThickness;
      const topY = cupY;
      const botY = cupY + cupH - glassThickness;

      ctx.beginPath();
      ctx.moveTo(cx - topRad, topY);
      ctx.lineTo(cx + topRad, topY);
      ctx.lineTo(cx + botRad, botY);
      ctx.lineTo(cx - botRad, botY);
      ctx.closePath();
    };

    // 5. Draw Coffee Liquid inside the cup
    if (fillPct > 0) {
      ctx.save();
      traceCupInner(ctx);
      ctx.clip();

      const liquidH = (fillPct / 100) * (cupH - 10);
      const liquidTopY = cupY + cupH - 5 - liquidH;

      const liqGrad = ctx.createLinearGradient(cx, cupY + cupH, cx, liquidTopY);
      liqGrad.addColorStop(0, '#0F0603'); // bottom rich dark core
      liqGrad.addColorStop(0.55, '#1E0E08'); // dark espresso body
      liqGrad.addColorStop(0.9, '#3B1E13'); // warm amber surface transition
      liqGrad.addColorStop(1, '#4A281A');

      ctx.beginPath();
      ctx.rect(cx - cupTopW, liquidTopY, cupTopW * 2, liquidH + 10);
      ctx.fillStyle = liqGrad;
      ctx.fill();

      // Splashes and turbulence on hitting liquid surface
      if (isPouring) {
        ctx.fillStyle = 'rgba(201, 166, 107, 0.2)';
        for (let i = 0; i < 4; i++) {
          const sX = cx + (Math.random() - 0.5) * 20;
          const sY = liquidTopY + Math.random() * 15;
          const rad = Math.random() * 2 + 1;
          ctx.beginPath();
          ctx.arc(sX, sY, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 6. Draw Crema layer formation (at 80%+ progress)
      if (currentProgress > 80) {
        const cremaRatio = (currentProgress - 80) / 20;
        const cremaHeight = 12 * cremaRatio;
        const cremaTopY = liquidTopY;

        const cremaGrad = ctx.createLinearGradient(cx, cremaTopY + cremaHeight, cx, cremaTopY);
        cremaGrad.addColorStop(0, '#80593B'); // dark crema boundary
        cremaGrad.addColorStop(0.6, '#C9A66B'); // golden crema
        cremaGrad.addColorStop(1, '#E9D6BF'); // light crema top froth

        ctx.beginPath();
        ctx.rect(cx - cupTopW, cremaTopY, cupTopW * 2, cremaHeight);
        ctx.fillStyle = cremaGrad;
        ctx.fill();

        // Cream bubbles pattern
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        for (let i = 0; i < 12; i++) {
          const bX = cx + (Math.random() - 0.5) * (cupBotW + 10);
          const bY = cremaTopY + Math.random() * cremaHeight;
          const r = Math.random() * 1.2 + 0.4;
          ctx.beginPath();
          ctx.arc(bX, bY, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Surface waves during pour
      if (isPouring) {
        ctx.beginPath();
        const waveHeight = 1.2;
        const wavePeriod = 0.1;
        const waveTime = Date.now() * 0.012;
        ctx.moveTo(cx - cupTopW, liquidTopY);
        for (let x = cx - cupTopW; x <= cx + cupTopW; x += 6) {
          const y = liquidTopY + Math.sin(x * wavePeriod + waveTime) * waveHeight;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(cx + cupTopW, liquidTopY + 15);
        ctx.lineTo(cx - cupTopW, liquidTopY + 15);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fill();
      }

      ctx.restore();
    }

    // 7. Glass Outer Shell (Reflections, thickness outlines)
    const topRadius = cupTopW / 2;
    const botRadius = cupBotW / 2;

    // Inner back thickness
    ctx.beginPath();
    ctx.moveTo(cx - topRadius, cupY);
    ctx.lineTo(cx + topRadius, cupY);
    ctx.lineTo(cx + botRadius, cupY + cupH);
    ctx.lineTo(cx - botRadius, cupY + cupH);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    // Thick base shell
    ctx.beginPath();
    ctx.moveTo(cx - botRadius, cupY + cupH);
    ctx.lineTo(cx + botRadius, cupY + cupH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 6;
    ctx.stroke();

    // Specular side highlights (left & right glass refraction edges)
    ctx.beginPath();
    ctx.moveTo(cx - topRadius, cupY);
    ctx.lineTo(cx - botRadius, cupY + cupH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx + topRadius, cupY);
    ctx.lineTo(cx + botRadius, cupY + cupH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Curved specular highlight body reflection
    ctx.beginPath();
    ctx.moveTo(cx - topRadius + 8, cupY + 10);
    ctx.lineTo(cx - botRadius + 6, cupY + cupH - 12);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 6;
    ctx.stroke();

    // Front-printed brand logo
    ctx.save();
    ctx.font = '800 12px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fillPct > 50 ? 'rgba(250, 246, 240, 0.9)' : 'rgba(78, 54, 41, 0.6)';
    ctx.fillText('caffix', cx, cy + 12);
    ctx.restore();

    // Top Rim outline
    ctx.beginPath();
    ctx.ellipse(cx, cupY, topRadius, 7, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fill();
  };

  return (
    <div 
      onClick={handleInteraction}
      className="w-full h-full flex flex-col justify-between p-4 bg-cream-light relative overflow-hidden select-none"
    >
      {/* Header title (Updated dynamically for complete state) */}
      <div className="text-center mt-2 transition-all duration-500">
        <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight leading-none">
          {progress === 100 ? 'Order Complete!' : 'Brewing in Progress'}
        </h2>
        <p className={`text-xs font-semibold tracking-wide mt-1.5 ${progress === 100 ? 'text-coffee-light' : 'text-coffee-light animate-pulse'}`}>
          {progress === 100 ? 'Thank you! Enjoy your coffee.' : 'Please wait while your coffee is freshly crafted'}
        </p>
      </div>

      {/* Center 3D-Like Canvas Animation Frame */}
      <div className="flex flex-col items-center justify-center my-1 flex-grow relative">
        <canvas 
          ref={canvasRef} 
          width={320} 
          height={320} 
          className="w-[320px] h-[320px] z-10" 
        />
      </div>

      {/* Lower section controls container */}
      <div className="w-full max-w-lg mx-auto bg-white border border-coffee-light/10 rounded-2xl p-4 shadow-sm mb-2 min-h-[94px] flex flex-col justify-center">
        {progress === 100 ? (
          // Success State Action Controls
          <div className="flex flex-col items-center justify-center gap-2">
            <div className="flex items-center gap-2 mb-1.5 animate-scale-up">
              <div className="relative w-7 h-7 bg-emerald-500 rounded-full flex items-center justify-center shadow-md shadow-emerald-500/20">
                <Check className="w-4 h-4 text-white stroke-[3.5]" />
                <div className="absolute inset-0 rounded-full border border-emerald-500 animate-ping opacity-30" />
              </div>
              <span className="text-xs font-black text-emerald-700 uppercase tracking-widest">
                Your coffee is ready!
              </span>
            </div>

            <button
              onClick={onComplete}
              className="w-full py-3 bg-coffee text-cream-light font-sans font-bold text-sm rounded-xl shadow-md hover:bg-coffee-dark border border-gold/20 flex items-center justify-center gap-2 active:scale-95 active-touch-feedback transition-all animate-fade-in"
            >
              <span>Tap to Continue</span>
            </button>
          </div>
        ) : (
          <>
            <div className="flex justify-end items-center text-xs font-bold text-coffee-dark mb-1.5">
              <span className="font-mono">{progress}%</span>
            </div>
            
            {/* Progress Bar Track */}
            <div className="w-full h-3 bg-cream rounded-full overflow-hidden shadow-inner border border-cream-dark/20">
              <div 
                className="h-full bg-gradient-to-r from-coffee-light to-coffee rounded-full transition-all duration-300 ease-out" 
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
