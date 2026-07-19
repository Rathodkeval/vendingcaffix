import React, { useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';

const COFFEES = [
  {
    id: 'classic',
    name: 'Classic Crest',
    desc: 'Some coffees need a personality. Ours has 100% Arabica.',
    price: 100,
    image: '/assets/classic_crest.png'
  },
  {
    id: 'vanilla',
    name: 'Vanilla Velvet',
    desc: 'Some people meditate. We made vanilla coffee',
    price: 100,
    image: '/assets/vanilla_velvet.png'
  },
  {
    id: 'hazelnut',
    name: 'Hazel Gold',
    desc: 'Your life deserves a little golden treatment. Meet Hazel Gold',
    price: 100,
    image: '/assets/hazel_gold.png'
  },
  {
    id: 'irish',
    name: 'Irish Emerald',
    desc: 'Bold enough to feel illegal All the Irish attitude',
    price: 100,
    image: '/assets/irish_emerald.png'
  },
  {
    id: 'mocha',
    name: 'Mocha Bliss',
    desc: 'Coffee with dessert energy = mocha bliss',
    price: 100,
    image: '/assets/mocha_bliss.png'
  }
];

export default function SelectionScreen({ onSelect, onBack, prices = { classic: 100, vanilla: 100, hazelnut: 100, irish: 100, mocha: 100 } }) {
  // Set Hazel Gold (index 2) as default active flavor
  const [activeIndex, setActiveIndex] = useState(2);

  const coffeesWithPrices = COFFEES.map((c) => ({
    ...c,
    price: prices[c.id] ?? c.price
  }));

  const handlePrev = () => {
    if (activeIndex > 0) {
      setActiveIndex(activeIndex - 1);
    }
  };

  const handleNext = () => {
    if (activeIndex < coffeesWithPrices.length - 1) {
      setActiveIndex(activeIndex + 1);
    }
  };

  const handleDragEnd = (event, info) => {
    const swipeThreshold = 50; // pixels
    if (info.offset.x < -swipeThreshold) {
      handleNext();
    } else if (info.offset.x > swipeThreshold) {
      handlePrev();
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col justify-between px-6 pt-4 pb-3 bg-gradient-to-b from-[#FAF6F0] via-[#F5ECE2] to-[#FAF6F0] overflow-hidden select-none">
      {/* Title Header Row */}
      <div className="flex items-center gap-4">
        <button
          onClick={onBack}
          className="p-2 rounded-xl bg-white/70 border border-coffee-light/10 hover:bg-cream active:scale-95 active-touch-feedback shadow-sm"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-coffee" />
        </button>
        <div>
          <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight leading-none">
            The Reason You're Here
          </h2>
        </div>
      </div>

      {/* Swipe Carousel Area */}
      <div className="relative flex-grow flex items-center justify-center my-2 overflow-hidden">
        {/* Navigation Arrows */}
        {activeIndex > 0 && (
          <button
            onClick={handlePrev}
            className="absolute left-4 p-3 rounded-full bg-white/80 border border-coffee-light/10 text-coffee hover:bg-white shadow-md active:scale-90 transition-all z-20 cursor-pointer active-touch-feedback"
            aria-label="Previous flavor"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {activeIndex < coffeesWithPrices.length - 1 && (
          <button
            onClick={handleNext}
            className="absolute right-4 p-3 rounded-full bg-white/80 border border-coffee-light/10 text-coffee hover:bg-white shadow-md active:scale-90 transition-all z-20 cursor-pointer active-touch-feedback"
            aria-label="Next flavor"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}

        {/* Drag Container Track */}
        <motion.div
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          onDragEnd={handleDragEnd}
          className="relative w-[1000px] h-[340px] flex items-center justify-center cursor-grab active:cursor-grabbing"
        >
          {coffeesWithPrices.map((coffee, index) => {
            const isActive = index === activeIndex;
            const diff = index - activeIndex;

            return (
              <motion.div
                key={coffee.id}
                style={{ pointerEvents: 'auto' }}
                animate={{
                  x: diff * 240, // Horizontal separation of cups
                  scale: isActive ? 1.05 : 0.85,
                  opacity: isActive ? 1.0 : 0.4,
                  zIndex: 10 - Math.abs(diff),
                }}
                transition={{ type: 'spring', stiffness: 260, damping: 28 }}
                className="absolute flex flex-col items-center justify-center cursor-pointer active-touch-feedback"
                onClick={() => onSelect(coffee)}
              >
                {/* Floating Breathing Coffee Cup Image */}
                <motion.div
                  animate={isActive ? {
                    y: [0, -6, 0],
                  } : { y: 0 }}
                  transition={{
                    repeat: Infinity,
                    duration: 3.5,
                    ease: "easeInOut"
                  }}
                  className="relative w-[190px] h-[190px] flex items-center justify-center"
                >
                  <img
                    src={coffee.image}
                    alt={coffee.name}
                    className="w-full h-full object-contain pointer-events-none"
                    style={{
                      // Premium radial golden glow filter under the active cup
                      filter: isActive 
                        ? 'drop-shadow(0 15px 20px rgba(212, 163, 115, 0.45)) drop-shadow(0 4px 6px rgba(139, 90, 43, 0.15))' 
                        : 'drop-shadow(0 8px 12px rgba(0, 0, 0, 0.08))'
                    }}
                  />

                </motion.div>

                {/* Cup Specification Labels & Price */}
                <div className="text-center mt-3 max-w-[190px]">
                  <h3 className="font-sans font-extrabold text-sm text-coffee-dark tracking-tight leading-none mb-0.5">
                    {coffee.name}
                  </h3>
                  <p className="text-[10px] text-coffee-light/75 leading-tight mb-2 h-7 flex items-center justify-center px-1 font-medium">
                    {coffee.desc}
                  </p>

                  <div className="flex flex-col items-center gap-1 mt-1">
                    <span className="font-sans font-black text-base text-coffee">
                      ₹{coffee.price}
                    </span>
                    {isActive && (
                      <motion.button
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="px-4 py-1.5 bg-coffee hover:bg-coffee-dark text-cream-light font-bold text-[10.5px] rounded-full shadow-lg border border-coffee-light/10 transition-all active:scale-95 active-touch-feedback cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(coffee);
                        }}
                      >
                        Select Flavor
                      </motion.button>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      </div>

      {/* Pagination indicators and helper instruction */}
      <div className="flex flex-col items-center select-none pb-1">
        {/* Pagination Dots */}
        <div className="flex justify-center gap-2 mb-1.5">
          {coffeesWithPrices.map((_, index) => (
            <button
              key={index}
              onClick={() => setActiveIndex(index)}
              className={`w-2 h-2 rounded-full transition-all duration-300 cursor-pointer ${
                index === activeIndex ? 'bg-coffee-dark w-4' : 'bg-coffee-light/35'
              }`}
              aria-label={`Go to flavor ${index + 1}`}
            />
          ))}
        </div>

        {/* Swipe instruction */}
        <div className="text-center text-[10.5px] text-coffee-light/60 font-semibold flex items-center justify-center gap-1.5">
          <svg className="w-3.5 h-3.5 text-coffee/60 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <span>Swipe left or right to explore our premium flavors</span>
        </div>
      </div>
    </div>
  );
}
