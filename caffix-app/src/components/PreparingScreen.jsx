import React, { useState, useEffect } from 'react';
import { Thermometer, Gauge } from 'lucide-react';

const PREPARING_STEPS = [
  { progress: 10, text: 'Preheating brewing boilers...', temp: '42°C', press: '0.0 Bar', fill: 0, pouring: false },
  { progress: 25, text: 'Grinding premium Arabica beans...', temp: '78°C', press: '0.5 Bar', fill: 0, pouring: false },
  { progress: 40, text: 'Heating infusion element...', temp: '92°C', press: '1.5 Bar', fill: 5, pouring: false },
  { progress: 65, text: 'Extracting espresso under 9 Bar...', temp: '95°C', press: '9.0 Bar', fill: 35, pouring: true },
  { progress: 85, text: 'Dispensing warm coffee blend...', temp: '88°C', press: '3.0 Bar', fill: 80, pouring: true },
  { progress: 100, text: 'Dispensing completed! Enjoy!', temp: '72°C', press: '0.0 Bar', fill: 85, pouring: false }
];

export default function PreparingScreen({ onComplete }) {
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    if (stepIdx >= PREPARING_STEPS.length) {
      const completionTimeout = setTimeout(() => {
        onComplete();
      }, 1000);
      return () => clearTimeout(completionTimeout);
    }

    const currentStep = PREPARING_STEPS[stepIdx];
    let delay = 1200; // default duration per step
    if (stepIdx === 3) delay = 2200; // Extraction takes longer for visual effect
    if (stepIdx === 4) delay = 1800; // Dispense takes longer

    const timer = setTimeout(() => {
      setStepIdx((prev) => prev + 1);
    }, delay);

    return () => clearTimeout(timer);
  }, [stepIdx]);

  const activeStep = PREPARING_STEPS[Math.min(stepIdx, PREPARING_STEPS.length - 1)];

  return (
    <div className="w-full h-full flex flex-col justify-between p-4 bg-cream-light relative overflow-hidden">
      {/* Header title */}
      <div className="text-center mt-2">
        <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight leading-none">
          Brewing in Progress
        </h2>
        <p className="text-xs text-coffee-light font-medium tracking-wide mt-1 animate-pulse">
          Please wait while your coffee is freshly crafted
        </p>
      </div>

      {/* Center Cup & Brewing Animation Frame */}
      <div className="flex flex-col items-center justify-center my-2 flex-grow relative">
        <div className="coffee-cup-wrapper">
          {/* Coffee Stream Pouring (visible during pouring stage) */}
          {activeStep.pouring && (
            <div className="coffee-stream" />
          )}

          {/* Steam Lines Rising (visible when hot and not pouring, or after completed) */}
          {!activeStep.pouring && activeStep.fill > 0 && (
            <>
              <div className="steam-line steam-anim" style={{ left: '40%', height: '20px', animationDelay: '0s' }} />
              <div className="steam-line steam-anim" style={{ left: '50%', height: '30px', animationDelay: '0.4s' }} />
              <div className="steam-line steam-anim" style={{ left: '60%', height: '22px', animationDelay: '0.8s' }} />
            </>
          )}

          {/* The Cup */}
          <div className="cup-body">
            {/* Dynamic liquid fill level */}
            <div 
              className="coffee-level" 
              style={{ height: `${activeStep.fill}%` }}
            >
              {/* Coffee foam cream head (only when filled) */}
              {activeStep.fill > 5 && (
                <div className="coffee-foam" />
              )}
            </div>
          </div>
          <div className="cup-handle" />
        </div>

        {/* Diagnostic Telemetry gauges */}
        <div className="flex gap-6 mt-4">
          <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-xl border border-coffee-light/10 shadow-sm min-w-[90px]">
            <Thermometer className="w-4 h-4 text-orange-500" />
            <div className="text-left leading-none">
              <span className="text-[9px] uppercase font-bold text-coffee-light block">Temperature</span>
              <span className="font-mono text-xs font-bold text-coffee-dark">{activeStep.temp}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-xl border border-coffee-light/10 shadow-sm min-w-[90px]">
            <Gauge className="w-4 h-4 text-blue-500" />
            <div className="text-left leading-none">
              <span className="text-[9px] uppercase font-bold text-coffee-light block">Pressure</span>
              <span className="font-mono text-xs font-bold text-coffee-dark">{activeStep.press}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Progress Bar & State Text */}
      <div className="w-full max-w-lg mx-auto bg-white border border-coffee-light/10 rounded-2xl p-4 shadow-sm mb-2">
        <div className="flex justify-between items-center text-xs font-bold text-coffee-dark mb-1.5">
          <span className="text-[11px] font-sans tracking-tight">{activeStep.text}</span>
          <span className="font-mono">{activeStep.progress}%</span>
        </div>
        
        {/* Progress Bar Track */}
        <div className="w-full h-3 bg-cream rounded-full overflow-hidden shadow-inner border border-cream-dark/20">
          <div 
            className="h-full bg-gradient-to-r from-coffee-light to-coffee rounded-full transition-all duration-500 ease-out" 
            style={{ width: `${activeStep.progress}%` }}
          />
        </div>
      </div>

      {/* Safety alert */}
      <div className="text-center text-[10px] font-bold text-red-700/60 uppercase tracking-wider">
        ⚠ CAUTION: Hot beverage dispensing. Keep hands away from cup tray.
      </div>
    </div>
  );
}
