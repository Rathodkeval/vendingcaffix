import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Check, Droplet, Milk } from 'lucide-react';
import { motion, LayoutGroup } from 'framer-motion';

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

export default function FlavorAndCustomizationView({
  initialStep = 'SELECTION',
  prices = { classic: 100, vanilla: 100, hazelnut: 100, irish: 100, mocha: 100 },
  selectedCoffee: propSelectedCoffee,
  onSelectCoffee,
  onConfirmOrder,
  onBackToWelcome
}) {
  // Step state: 'SELECTION' | 'SUMMARY'
  const [step, setStep] = useState(initialStep === 'WELCOME' ? 'SELECTION' : initialStep);
  const [activeIndex, setActiveIndex] = useState(2); // Default to Hazel Gold (index 2)
  const [selectedCoffee, setSelectedCoffeeState] = useState(
    propSelectedCoffee || COFFEES[2]
  );

  // Customization Options State
  const [extraSugar, setExtraSugar] = useState(false);
  const [base, setBase] = useState('water'); // 'water' | 'milk'

  // Refs for GSAP animation targets
  const containerRef = useRef(null);
  const selectedCupImgRef = useRef(null);
  const leftPanelCardRef = useRef(null);
  const leftPanelCupBoxRef = useRef(null);
  const rightPanelRef = useRef(null);
  const isAnimatingRef = useRef(false);

  const coffeesWithPrices = COFFEES.map((c) => ({
    ...c,
    price: prices[c.id] ?? c.price
  }));

  const activeCoffee = coffeesWithPrices[activeIndex];

  // 1. Preload ALL images upfront on mount (Requirement 5)
  useEffect(() => {
    coffeesWithPrices.forEach((c) => {
      const img = new Image();
      img.src = c.image;
    });
  }, []);

  // Sync initialStep prop with step state
  useEffect(() => {
    if (initialStep === 'SELECTION' || initialStep === 'SUMMARY') {
      setStep(initialStep);
    } else if (initialStep === 'WELCOME') {
      setStep('SELECTION');
    }
  }, [initialStep]);

  // Sync propSelectedCoffee with selectedCoffeeState and activeIndex
  useEffect(() => {
    if (!propSelectedCoffee) {
      setSelectedCoffeeState(coffeesWithPrices[2]);
      setExtraSugar(false);
      setBase('water');
      setActiveIndex(2);
    } else {
      setSelectedCoffeeState(propSelectedCoffee);
      const idx = coffeesWithPrices.findIndex((c) => c.id === propSelectedCoffee.id);
      if (idx !== -1) {
        setActiveIndex(idx);
      }
    }
  }, [propSelectedCoffee]);

  // Update selected coffee when activeIndex changes in selection mode
  const handleNext = () => {
    if (isAnimatingRef.current || step === 'SUMMARY') return;
    if (activeIndex < coffeesWithPrices.length - 1) {
      const nextIdx = activeIndex + 1;
      setActiveIndex(nextIdx);
      setSelectedCoffeeState(coffeesWithPrices[nextIdx]);
      if (onSelectCoffee) onSelectCoffee(coffeesWithPrices[nextIdx]);
    }
  };

  const handlePrev = () => {
    if (isAnimatingRef.current || step === 'SUMMARY') return;
    if (activeIndex > 0) {
      const prevIdx = activeIndex - 1;
      setActiveIndex(prevIdx);
      setSelectedCoffeeState(coffeesWithPrices[prevIdx]);
      if (onSelectCoffee) onSelectCoffee(coffeesWithPrices[prevIdx]);
    }
  };

  const handleDragEnd = (event, info) => {
    if (isAnimatingRef.current || step === 'SUMMARY') return;
    const swipeThreshold = 50; // pixels
    if (info.offset.x < -swipeThreshold) {
      handleNext();
    } else if (info.offset.x > swipeThreshold) {
      handlePrev();
    }
  };

  // Main Shared Element GPU Animation Handler
  const triggerSelectAnimation = (coffeeToSelect) => {
    if (isAnimatingRef.current) return;
    isAnimatingRef.current = true;

    // 0. Disable touch interactions immediately (0ms) to prevent double clicks
    if (containerRef.current) {
      containerRef.current.style.pointerEvents = 'none';
    }

    // Ensure the selected flavor is updated BEFORE navigation starts
    setSelectedCoffeeState({ ...coffeeToSelect });
    if (onSelectCoffee) onSelectCoffee({ ...coffeeToSelect });

    // Set step to SUMMARY, which triggers Framer Motion's shared-element transition
    setStep('SUMMARY');

    // Keep pointer events disabled for the 650ms animation duration
    setTimeout(() => {
      isAnimatingRef.current = false;
      if (containerRef.current) {
        containerRef.current.style.pointerEvents = 'auto';
      }
    }, 650);
  };

  const handleBack = () => {
    if (isAnimatingRef.current) return;

    if (step === 'SUMMARY') {
      isAnimatingRef.current = true;
      if (containerRef.current) containerRef.current.style.pointerEvents = 'none';

      // Set step back to SELECTION to trigger reverse layout transition
      setStep('SELECTION');

      // Keep pointer events disabled for the 650ms animation duration
      setTimeout(() => {
        isAnimatingRef.current = false;
        if (containerRef.current) {
          containerRef.current.style.pointerEvents = 'auto';
        }
        // Reset selection and customization state when returning to the flavor selection screen
        setSelectedCoffeeState(coffeesWithPrices[2]);
        if (onSelectCoffee) onSelectCoffee(null);
        setExtraSugar(false);
        setBase('water');
        setActiveIndex(2);
      }, 650);
    } else {
      onBackToWelcome();
    }
  };

  // Price calculations
  const calculateTotal = () => {
    let basePrice = selectedCoffee.price;
    if (extraSugar) basePrice += 5;
    return basePrice;
  };

  const currentPrice = calculateTotal();

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-[#FAF6F0] flex flex-col justify-between px-4 pt-3 pb-3 overflow-hidden select-none"
    >
      {/* 1. Static Cream Background & Header Row (Requirement 3: Never animates) */}
      <div className="flex items-center gap-3 mb-1 z-30">
        <button
          onClick={handleBack}
          className="p-2 rounded-xl bg-white/80 border border-coffee-light/15 hover:bg-cream active:scale-95 transition-transform cursor-pointer"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-coffee" />
        </button>
        <div>
          <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight leading-none">
            {step === 'SUMMARY' ? 'Customize & Confirm' : "The Reason You're Here"}
          </h2>
        </div>
      </div>

      {/* 2. Main Workspace - BOTH Views Mounted (Requirement 1 & 10) */}
      <div className="relative flex-grow w-full h-full overflow-hidden my-1">

        {/* SUMMARY CUSTOMIZATION VIEW LAYER (Always mounted in DOM) */}
        <div
          className={`absolute inset-0 grid grid-cols-5 gap-4 items-stretch overflow-hidden transition-opacity duration-300 ${
            step === 'SUMMARY' ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
        >
          {/* Left Target Product Showcase (Vertically Centered Cup + Title + Description Block) */}
          {/* Left Target Product Showcase (Vertically Centered Cup + Title + Description Block) */}
          <motion.div
            ref={leftPanelCardRef}
            animate={{ opacity: step === 'SUMMARY' ? 1 : 0 }}
            transition={{ duration: 0.20, ease: 'easeOut' }}
            style={{ willChange: 'opacity' }}
            className="col-span-2 flex flex-col items-center justify-center py-2 px-2 overflow-hidden border-none bg-transparent shadow-none gap-2"
          >
            {/* Dedicated Cup Target Frame */}
            <div
              ref={leftPanelCupBoxRef}
              className="w-full h-[265px] flex items-center justify-center relative overflow-visible border-none bg-transparent shadow-none"
            >
              {/* Cup physically moves here during animation, then handsoff to local DOM centering inside box */}
              {step === 'SUMMARY' && (
                <motion.img
                  layoutId={`coffee-cup-image-${selectedCoffee.id}`}
                  src={selectedCoffee.image}
                  alt={selectedCoffee.name}
                  className="h-[96%] w-auto object-contain pointer-events-none drop-shadow-md"
                  style={{ willChange: 'transform, opacity' }}
                  transition={{
                    type: 'tween',
                    ease: [0.22, 1, 0.36, 1],
                    duration: 0.65
                  }}
                />
              )}
            </div>

            {/* Centered Flavor Name & Description Directly Below Cup */}
            <div className="flex flex-col items-center text-center mt-1 px-2">
              <h3 className="font-sans font-black text-2xl text-coffee-dark tracking-[0.5px] uppercase leading-none mb-1">
                {selectedCoffee.name}
              </h3>
              <p className="text-[11.5px] text-coffee-dark/80 font-medium leading-snug line-clamp-2 max-w-[280px]">
                {selectedCoffee.desc}
              </p>
            </div>
          </motion.div>

          {/* Right Customization Panel (Requirement 10: Mounted with opacity: 0, transform: translate3d(20px, 0, 0)) */}
          <motion.div
            ref={rightPanelRef}
            animate={{
              opacity: step === 'SUMMARY' ? 1 : 0,
              x: step === 'SUMMARY' ? 0 : 20
            }}
            transition={{
              duration: 0.35,
              delay: step === 'SUMMARY' ? 0.30 : 0,
              ease: [0.22, 1, 0.36, 1]
            }}
            style={{
              pointerEvents: step === 'SUMMARY' ? 'auto' : 'none',
              willChange: 'transform, opacity'
            }}
            className="col-span-3 bg-white rounded-2xl border border-coffee-light/10 p-3 flex flex-col justify-between shadow-sm"
          >
            <div className="space-y-3">
              {/* CAFFIX Brew Code Card */}
              <div className="bg-cream-light/20 border border-coffee-light/5 p-2 rounded-xl">
                <h4 className="text-[10px] font-bold text-coffee-dark uppercase tracking-wider">CAFFIX BREW CODE</h4>
                <p className="text-[11px] text-coffee-light mt-0.5 leading-relaxed">
                  Precision In Every Pour. Perfection In Every Sip
                </p>
              </div>

              {/* Extra Sugar Toggle */}
              <div className="flex justify-between items-center bg-cream-light/30 p-2 rounded-xl border border-cream">
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
              </div>

              {/* Choose Base Section */}
              <div className="border-t border-cream pt-2">
                <h4 className="text-xs font-extrabold text-coffee-dark uppercase tracking-wider mb-0.5">Choose Your Base</h4>
                <p className="text-[10px] text-coffee-light/80 font-medium mb-1.5">
                  Select either water or milk. You can choose only one.
                </p>
                <div className="grid grid-cols-2 gap-3 mb-2">
                  <button
                    onClick={() => setBase('water')}
                    className={`flex flex-col items-center justify-center py-2 px-3 rounded-xl border-2 transition-all duration-200 cursor-pointer ${
                      base === 'water'
                        ? 'bg-coffee-dark border-coffee-dark text-cream-light shadow-md'
                        : 'bg-cream-light/30 border-cream hover:bg-cream-light/50 text-coffee-dark'
                    }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center mb-1 transition-all duration-200 ${
                        base === 'water'
                          ? 'bg-white text-coffee-dark shadow-sm'
                          : 'border border-coffee-light/35 bg-transparent text-coffee-dark'
                      }`}
                    >
                      <Droplet className="w-5 h-5" />
                    </div>
                    <span className="text-[11px] font-extrabold tracking-tight">Go Strong with Water</span>
                  </button>

                  <button
                    onClick={() => setBase('milk')}
                    className={`flex flex-col items-center justify-center py-2 px-3 rounded-xl border-2 transition-all duration-200 cursor-pointer ${
                      base === 'milk'
                        ? 'bg-coffee-dark border-coffee-dark text-cream-light shadow-md'
                        : 'bg-cream-light/30 border-cream hover:bg-cream-light/50 text-coffee-dark'
                    }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center mb-1 transition-all duration-200 ${
                        base === 'milk'
                          ? 'bg-white text-coffee-dark shadow-sm'
                          : 'border border-coffee-light/35 bg-transparent text-coffee-dark'
                      }`}
                    >
                      <Milk className="w-5 h-5" />
                    </div>
                    <span className="text-[11px] font-extrabold tracking-tight">Go Creamy with Milk</span>
                  </button>
                </div>
              </div>

              {/* Specifications Card */}
              <div className="bg-cream-light/60 p-2 rounded-xl border border-cream">
                <span className="text-[10px] uppercase font-bold text-coffee-light tracking-wider block mb-1">
                  Specifications
                </span>
                <div className="grid grid-cols-3 gap-2 text-[11px] text-coffee font-semibold">
                  <div className="bg-white/80 px-2 py-1 rounded border border-cream/50 text-center">
                    Cup: <span className="text-gold-dark font-extrabold">Standard</span>
                  </div>
                  <div className="bg-white/80 px-2 py-1 rounded border border-cream/50 text-center">
                    Sugar: <span className="text-gold-dark font-extrabold">{extraSugar ? 'Extra Sugar' : 'Standard'}</span>
                  </div>
                  <div className="bg-white/80 px-2 py-1 rounded border border-cream/50 text-center">
                    Base: <span className="text-gold-dark font-extrabold">{base === 'water' ? 'Water' : 'Milk'}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Total Amount & Confirm Order Button */}
            <div className="flex items-center justify-between border-t border-cream pt-2">
              <div className="flex flex-col">
                <span className="text-[10px] uppercase font-bold text-coffee-light tracking-wide">TOTAL AMOUNT</span>
                <div className="text-2xl font-black text-coffee-dark leading-none mt-0.5">
                  ₹{currentPrice}
                </div>
              </div>
              <button
                onClick={() =>
                  onConfirmOrder({
                    name: selectedCoffee.name,
                    size: 'Medium',
                    price: currentPrice,
                    extraSugar,
                    base
                  })
                }
                className="py-2.5 px-6 bg-coffee-dark hover:bg-coffee-dark/90 text-cream-light font-bold text-sm rounded-xl shadow-md transition-all flex items-center gap-2 cursor-pointer active:scale-95"
              >
                <Check className="w-4 h-4" />
                <span>Confirm Order</span>
              </button>
            </div>
          </motion.div>
        </div>


        {/* FLAVOR SELECTION CAROUSEL LAYER (Always mounted in DOM) */}
        <motion.div
          animate={{ opacity: step === 'SELECTION' ? 1 : 0 }}
          transition={{ duration: 0.20, ease: 'easeOut' }}
          style={{ willChange: 'opacity' }}
          className={`absolute inset-0 flex flex-col justify-between ${
            step === 'SELECTION' ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
        >
          {/* Navigation Arrows */}
          {activeIndex > 0 && step === 'SELECTION' && (
            <button
              onClick={handlePrev}
              className="carousel-non-selected absolute left-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/80 border border-coffee-light/10 text-coffee hover:bg-white shadow-md active:scale-90 transition-transform z-30 cursor-pointer"
              aria-label="Previous flavor"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}
          {activeIndex < coffeesWithPrices.length - 1 && step === 'SELECTION' && (
            <button
              onClick={handleNext}
              className="carousel-non-selected absolute right-6 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/80 border border-coffee-light/10 text-coffee hover:bg-white shadow-md active:scale-90 transition-transform z-30 cursor-pointer"
              aria-label="Next flavor"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}

          {/* Carousel Track */}
          <motion.div
            drag={step === 'SUMMARY' ? false : "x"}
            dragConstraints={{ left: 0, right: 0 }}
            onDragEnd={handleDragEnd}
            className="relative w-full h-[340px] flex items-center justify-center cursor-grab active:cursor-grabbing overflow-visible"
          >
            {coffeesWithPrices.map((coffee, index) => {
              const isActive = index === activeIndex;
              const diff = index - activeIndex;
              const absDiff = Math.abs(diff);

              const scale = isActive ? 1.15 : absDiff === 1 ? 0.85 : absDiff === 2 ? 0.72 : 0;
              const isSelectedInSummary = step === 'SUMMARY' && isActive;
              const opacity = isSelectedInSummary ? 0 : (isActive ? 1.0 : absDiff === 1 ? 0.65 : absDiff === 2 ? 0.35 : 0);
              const horizontalOffset = diff * 190;

              return (
                <div
                  key={coffee.id}
                  style={{
                    transform: `translate3d(${horizontalOffset}px, 0, 0) scale(${scale})`,
                    opacity: opacity,
                    zIndex: isActive ? 30 : 10 - absDiff,
                    willChange: 'transform, opacity'
                  }}
                  className={`absolute flex flex-col items-center justify-center transition-all duration-300 ${
                    !isActive ? 'carousel-non-selected' : ''
                  }`}
                  onClick={() => {
                    if (isActive && step === 'SELECTION') {
                      triggerSelectAnimation(coffee);
                    } else if (!isActive && step === 'SELECTION') {
                      setActiveIndex(index);
                      setSelectedCoffeeState(coffeesWithPrices[index]);
                      if (onSelectCoffee) onSelectCoffee(coffeesWithPrices[index]);
                    }
                  }}
                >
                  {/* Single Continuous Coffee Cup Image Element (Requirement 2 & 9) */}
                  <div className="relative w-[160px] h-[160px] flex items-center justify-center">
                    {!isSelectedInSummary && (
                      <motion.img
                        layoutId={`coffee-cup-image-${coffee.id}`}
                        src={coffee.image}
                        alt={coffee.name}
                        style={{ willChange: 'transform, opacity' }}
                        className="w-full h-full object-contain pointer-events-none drop-shadow-md"
                        transition={{
                          type: 'tween',
                          ease: [0.22, 1, 0.36, 1],
                          duration: 0.65
                        }}
                      />
                    )}
                  </div>

                  {/* Cup Title & Details (Fades out via .carousel-non-selected) */}
                  <div className="carousel-non-selected text-center mt-2 max-w-[185px]">
                    <h3 className="font-sans font-black text-xl text-coffee-dark tracking-tight uppercase leading-none mb-1">
                      {coffee.name}
                    </h3>
                    <p className="text-[9.5px] text-coffee-light/75 leading-tight mb-1.5 h-6 flex items-center justify-center px-1 font-medium">
                      {coffee.desc}
                    </p>
                    <div className="flex flex-col items-center gap-1 mt-0.5">
                      <span className="font-sans font-black text-base text-coffee">
                        ₹{coffee.price}
                      </span>
                      {isActive && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            triggerSelectAnimation(coffee);
                          }}
                          className="px-3.5 py-1 bg-coffee hover:bg-coffee-dark text-cream-light font-bold text-[10px] rounded-full shadow-lg border border-coffee-light/10 transition-all active:scale-95 cursor-pointer"
                        >
                          Choose Your Sip
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </motion.div>

          {/* Carousel Footer & Pagination */}
          <div className="carousel-non-selected flex flex-col items-center select-none pb-1 z-10">
            <div className="flex justify-center gap-2">
              {coffeesWithPrices.map((_, index) => (
                <button
                  key={index}
                  onClick={() => {
                    if (step === 'SELECTION') {
                      setActiveIndex(index);
                      setSelectedCoffeeState(coffeesWithPrices[index]);
                      if (onSelectCoffee) onSelectCoffee(coffeesWithPrices[index]);
                    }
                  }}
                  className={`h-2 rounded-full transition-all duration-300 cursor-pointer ${
                    index === activeIndex ? 'bg-coffee-dark w-4' : 'bg-coffee-light/35 w-2'
                  }`}
                  aria-label={`Go to flavor ${index + 1}`}
                />
              ))}
            </div>
            <p 
              style={{
                fontSize: '13px',
                fontWeight: 400,
                color: '#9A8B7A',
                opacity: 0.8,
                letterSpacing: '0.2px',
                lineHeight: 1.4
              }}
              className="text-center mt-4 mb-1 whitespace-nowrap"
            >
              Images are for illustrative purposes only. Actual product appearance may vary.
            </p>
          </div>
        </motion.div>

      </div>
    </div>
  );
}
