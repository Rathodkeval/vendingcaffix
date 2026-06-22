import React, { useEffect, useRef } from 'react';
import { Coffee } from 'lucide-react';

export default function WelcomeScreen({ onStart, onAdminAccess }) {
  const canvasRef = useRef(null);
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef(null);

  const handleLogoClick = () => {
    tapCountRef.current++;
    clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0; }, 1000);
    if (tapCountRef.current >= 3) {
      tapCountRef.current = 0;
      if (onAdminAccess) onAdminAccess();
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let animationFrameId;

    const resizeCanvas = () => {
      canvas.width = canvas.parentElement.clientWidth;
      canvas.height = canvas.parentElement.clientHeight;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    class Particle {
      constructor() {
        this.reset();
        this.y = Math.random() * canvas.height;
      }

      reset() {
        this.x = canvas.width / 2 + (Math.random() - 0.5) * 180;
        this.y = canvas.height + 20;
        this.size = Math.random() * 30 + 15;
        this.speedY = -(Math.random() * 1.2 + 0.6);
        this.speedX = (Math.random() - 0.5) * 0.6;
        this.alpha = Math.random() * 0.15 + 0.05;
        this.fade = 0.001 + Math.random() * 0.001;
        this.swaySpeed = 0.005 + Math.random() * 0.01;
        this.swayAngle = Math.random() * Math.PI;
      }

      update() {
        this.y += this.speedY;
        this.swayAngle += this.swaySpeed;
        this.x += this.speedX + Math.sin(this.swayAngle) * 0.5;
        this.alpha -= this.fade;
        if (this.alpha <= 0 || this.y < -40) {
          this.reset();
        }
      }

      draw() {
        ctx.beginPath();
        ctx.fillStyle = `rgba(245, 230, 211, ${this.alpha})`;
        ctx.shadowBlur = 8;
        ctx.shadowColor = 'rgba(201, 166, 107, 0.03)';
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const particles = Array.from({ length: 30 }, () => new Particle());

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Warm radial background vignette under the steam
      const grad = ctx.createRadialGradient(
        canvas.width / 2,
        canvas.height / 2,
        20,
        canvas.width / 2,
        canvas.height / 2,
        canvas.height * 0.8
      );
      grad.addColorStop(0, 'rgba(250, 246, 240, 0)');
      grad.addColorStop(1, 'rgba(245, 230, 211, 0.15)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      particles.forEach((p) => {
        p.update();
        p.draw();
      });

      animationFrameId = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div className="relative w-full h-full flex flex-col justify-between items-center py-10 px-6 bg-cream-light overflow-hidden">
      {/* Background canvas for rising steam aroma */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-0" />

      {/* Decorative Warm Shapes */}
      <div className="absolute -top-32 -left-32 w-80 h-80 bg-cream/30 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -right-32 w-80 h-80 bg-gold/10 rounded-full blur-3xl pointer-events-none" />

      {/* Brand & Logo Section */}
      <div className="z-10 flex flex-col items-center text-center mt-6 cursor-pointer" onClick={handleLogoClick}>
        <div className="bg-coffee-dark p-4 rounded-full shadow-lg border-2 border-gold/40 mb-4 animate-status-pulse">
          <Coffee className="w-16 h-16 text-gold" />
        </div>
        <h1 className="font-sans font-extrabold text-5xl tracking-widest text-coffee-dark mb-2">
          CAFFIX
        </h1>
        <p className="text-coffee-light font-medium tracking-wide text-lg max-w-sm">
          Stay Caffeinated!
        </p>
      </div>

      {/* Action / Trigger Button */}
      <div className="z-10 w-full max-w-xs mb-6">
        <button
          onClick={onStart}
          className="w-full py-5 bg-coffee text-cream-light font-sans font-bold text-2xl rounded-2xl shadow-xl hover:bg-coffee-dark border-2 border-gold/30 transition-all duration-300 transform active:scale-95 flex items-center justify-center gap-3 active-touch-feedback"
        >
          <span>Start Order</span>
          <svg className="w-6 h-6 stroke-cream-light fill-none stroke-[2.5]" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
          </svg>
        </button>
        <p className="text-center text-xs text-coffee-light/60 mt-3 font-semibold tracking-wider uppercase">
          Touch screen to select beverage
        </p>
      </div>
    </div>
  );
}
