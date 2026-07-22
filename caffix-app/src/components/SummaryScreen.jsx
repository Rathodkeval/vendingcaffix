import React, { useState, useEffect } from 'react';
import { ArrowLeft, Check, Droplet, Milk } from 'lucide-react';
import { motion } from 'framer-motion';

// Smooth counting animation component for Total Amount (₹0 -> ₹100 over 300ms)
function AnimatedCounter({ value, duration = 300 }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let start = 0;
    const end = value;
    const startTime = performance.now();

    const updateCount = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutCubic easing for smooth deceleration
      const easeProgress = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(start + (end - start) * easeProgress));

      if (progress < 1) {
        requestAnimationFrame(updateCount);
      }
    };

    requestAnimationFrame(updateCount);
  }, [value, duration]);

  return <span>₹{count}</span>;
}

export default function SummaryScreen({ selectedCoffee, onConfirm, onBack }) {
  const size = 'Medium';
  const [extraSugar, setExtraSugar] = useState(false);
  const [base, setBase] = useState('water');

  // Price calculations based on sizes
  const getPrice = () => {
    let basePrice = selectedCoffee.price;
    if (extraSugar) basePrice += 5;
    return basePrice;
  };

  const currentPrice = getPrice();

  // Animation variants for right panel staggering
  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.04,
        delayChildren: 0.1
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
      className="absolute inset-0 flex flex-col justify-between px-4 pt-3 pb-3 bg-cream-light overflow-hidden"
    >
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex items-center gap-3 mb-1"
      >
        <button
          onClick={onBack}
          className="p-2 rounded-xl bg-cream border border-coffee-light/20 hover:bg-cream-dark active:scale-95 active-touch-feedback cursor-pointer"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-coffee" />
        </button>
        <div>
          <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight leading-none">
            Customize & Confirm
          </h2>
        </div>
      </motion.div>

      {/* Main Dual Panels */}
      <div className="grid grid-cols-5 gap-4 flex-grow items-stretch my-1 overflow-hidden">
        {/* Left Panel: Beverage details (Fades & expands around arriving cup) */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
          className="col-span-2 bg-white rounded-2xl border border-coffee-light/10 p-3 flex flex-col justify-between shadow-sm overflow-hidden"
        >
          <div>
            {/* Fully visible cup image with shared layoutId continuous travel animation */}
            <div className="w-full h-[210px] rounded-xl flex items-center justify-center border border-cream shadow-inner mb-2 bg-[#FAF6F0] p-2 overflow-hidden relative">
              <motion.img
                layoutId={`coffee-cup-${selectedCoffee.id}`}
                src={selectedCoffee.image}
                alt={selectedCoffee.name}
                className="w-full h-full object-contain pointer-events-none drop-shadow-md"
                transition={{
                  type: "spring",
                  stiffness: 190,
                  damping: 25,
                  mass: 0.9,
                  duration: 0.75
                }}
              />
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
            className="mt-1"
          >
            <h3 className="font-sans font-extrabold text-base text-coffee-dark tracking-tight leading-snug">
              {selectedCoffee.name}
            </h3>
            <p className="text-[10.5px] text-coffee-light/80 mt-0.5 leading-snug">
              {selectedCoffee.desc}
            </p>
          </motion.div>
        </motion.div>

        {/* Right Panel: Interactive Customizers (Builds itself with staggered fade/slide) */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="col-span-3 bg-white rounded-2xl border border-coffee-light/10 p-3 flex flex-col justify-between shadow-sm"
        >
          <div className="space-y-3">
            {/* Standard Recipe Message */}
            <motion.div variants={itemVariants} className="bg-cream-light/20 border border-coffee-light/5 p-2 rounded-xl">
              <h4 className="text-[10px] font-bold text-coffee-dark uppercase tracking-wider">CAFFIX BREW CODE</h4>
              <p className="text-[11px] text-coffee-light mt-0.5 leading-relaxed">
                Precision In Every Pour. Perfection In Every Sip
              </p>
            </motion.div>

            {/* Extra Sugar Toggle */}
            <motion.div variants={itemVariants} className="flex justify-between items-center bg-cream-light/30 p-2 rounded-xl border border-cream hover:bg-cream-light/40 transition-colors">
              <div className="flex flex-col">
                <span className="text-xs font-bold text-coffee">Extra Sugar (+₹5)</span>
                <span className="text-[10px] text-coffee-light/75">Add sweetness to your drink</span>
              </div>
              <button
                onClick={() => setExtraSugar(!extraSugar)}
                className={`w-10 h-6 flex items-center rounded-full p-0.5 cursor-pointer transition-all duration-300 border ${
                  extraSugar ? 'bg-coffee-dark border-coffee-dark justify-end' : 'bg-cream-dark border-coffee-light/15 justify-start'
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-white shadow-md block" />
              </button>
            </motion.div>

            {/* Choose Your Base */}
            <motion.div variants={itemVariants} className="border-t border-cream pt-2">
              <h4 className="text-xs font-extrabold text-coffee-dark uppercase tracking-wider mb-0.5">Choose Your Base</h4>
              <p className="text-[10px] text-coffee-light/80 font-medium mb-1.5">
                Select either water or milk. You can choose only one.
              </p>
              <div className="grid grid-cols-2 gap-3 mb-2">
                {/* Water Card */}
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setBase('water')}
                  className={`flex flex-col items-center justify-center py-2 px-3 rounded-xl border-2 transition-all duration-300 cursor-pointer ${
                    base === 'water'
                      ? 'bg-coffee-dark border-coffee-dark text-cream-light shadow-md scale-[1.02]'
                      : 'bg-cream-light/30 border-cream hover:bg-cream-light/50 text-coffee-dark'
                  }`}
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center mb-1 transition-all duration-300 ${
                      base === 'water'
                        ? 'bg-white text-coffee-dark shadow-sm'
                        : 'border border-coffee-light/35 bg-transparent text-coffee-dark'
                    }`}
                  >
                    <Droplet className="w-5 h-5" />
                  </div>
                  <span className="text-[11px] font-extrabold tracking-tight">Go Strong with Water</span>
                </motion.button>

                {/* Milk Card */}
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setBase('milk')}
                  className={`flex flex-col items-center justify-center py-2 px-3 rounded-xl border-2 transition-all duration-300 cursor-pointer ${
                    base === 'milk'
                      ? 'bg-coffee-dark border-coffee-dark text-cream-light shadow-md scale-[1.02]'
                      : 'bg-cream-light/30 border-cream hover:bg-cream-light/50 text-coffee-dark'
                  }`}
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center mb-1 transition-all duration-300 ${
                      base === 'milk'
                        ? 'bg-white text-coffee-dark shadow-sm'
                        : 'border border-coffee-light/35 bg-transparent text-coffee-dark'
                    }`}
                  >
                    <Milk className="w-5 h-5" />
                  </div>
                  <span className="text-[11px] font-extrabold tracking-tight">Go Creamy with Milk</span>
                </motion.button>
              </div>
            </motion.div>

            {/* Specifications */}
            <motion.div variants={itemVariants} className="bg-cream-light/60 p-2 rounded-xl border border-cream">
              <span className="text-[10px] uppercase font-bold text-coffee-light tracking-wider block mb-1">
                Specifications
              </span>
              <div className="grid grid-cols-3 gap-2 text-[11px] text-coffee font-semibold">
                <div className="bg-white/80 px-2 py-1 rounded border border-cream/50 text-center">Cup: <span className="text-gold-dark font-extrabold">Standard</span></div>
                <div className="bg-white/80 px-2 py-1 rounded border border-cream/50 text-center">Sugar: <span className="text-gold-dark font-extrabold">{extraSugar ? 'Extra Sugar' : 'Standard'}</span></div>
                <div className="bg-white/80 px-2 py-1 rounded border border-cream/50 text-center">Base: <span className="text-gold-dark font-extrabold">{base === 'water' ? 'Water' : 'Milk'}</span></div>
              </div>
            </motion.div>
          </div>

          {/* Pricing & Checkout Block (Fades & slides in with animated total amount counter) */}
          <motion.div variants={itemVariants} className="flex items-center justify-between border-t border-cream pt-2">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase font-bold text-coffee-light tracking-wide">TOTAL AMOUNT</span>
              <div className="text-2xl font-black text-coffee-dark leading-none mt-0.5">
                <AnimatedCounter value={currentPrice} />
              </div>
            </div>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => onConfirm({ name: selectedCoffee.name, size, price: currentPrice, extraSugar, base })}
              className="py-2.5 px-6 bg-coffee-dark hover:bg-coffee-dark/90 text-cream-light font-bold text-sm rounded-xl shadow-md transition-all flex items-center gap-2 cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>Confirm Order</span>
            </motion.button>
          </motion.div>
        </motion.div>
      </div>
    </motion.div>
  );
}
