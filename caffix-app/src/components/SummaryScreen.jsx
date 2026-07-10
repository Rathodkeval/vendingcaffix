import React, { useState } from 'react';
import { ArrowLeft, Check } from 'lucide-react';

export default function SummaryScreen({ selectedCoffee, onConfirm, onBack }) {
  const size = 'Medium';
  const [extraSugar, setExtraSugar] = useState(false);

  // Price calculations based on sizes
  const getPrice = () => {
    return selectedCoffee.price;
  };

  const currentPrice = getPrice();

  return (
    <div className="w-full h-full flex flex-col justify-between p-4 bg-cream-light relative overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={onBack}
          className="p-2 rounded-xl bg-cream border border-coffee-light/20 hover:bg-cream-dark active:scale-95 active-touch-feedback"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-coffee" />
        </button>
        <div>
          <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight leading-none">
            Customize & Confirm
          </h2>
          <p className="text-xs text-coffee-light font-medium tracking-wide mt-0.5">
            Review your order selection details below
          </p>
        </div>
      </div>

      {/* Main Dual Panels */}
      <div className="grid grid-cols-5 gap-4 flex-grow items-stretch my-1 overflow-hidden">
        {/* Left Panel: Beverage details */}
        <div className="col-span-2 bg-white rounded-2xl border border-coffee-light/10 p-3 flex flex-col justify-between shadow-sm">
          <div>
            <div
              className="w-full h-32 rounded-xl bg-cover bg-center border border-cream shadow-inner mb-2"
              style={{ backgroundImage: `url('${selectedCoffee.image}')` }}
            />
            <h3 className="font-sans font-extrabold text-lg text-coffee-dark tracking-tight leading-snug">
              {selectedCoffee.name}
            </h3>
            <p className="text-xs text-coffee-light/80 mt-1 leading-snug">
              {selectedCoffee.desc}
            </p>
          </div>
          <div className="bg-cream-light/60 p-2.5 rounded-xl border border-cream mt-2">
            <span className="text-[10px] uppercase font-bold text-coffee-light tracking-wider block">
              Specifications
            </span>
            <div className="text-[11px] text-coffee font-semibold mt-0.5 space-y-0.5">
              <div>Cup Size: <span className="text-gold-dark">Standard</span></div>
              <div>Sugar: <span className="text-gold-dark">{extraSugar ? 'Extra Sugar' : 'Standard'}</span></div>
            </div>
          </div>
        </div>

        {/* Right Panel: Interactive Customizers */}
        <div className="col-span-3 bg-white rounded-2xl border border-coffee-light/10 p-3 flex flex-col justify-between shadow-sm">
          <div className="space-y-4">
            {/* Standard Recipe Message */}
            <div className="bg-cream-light/20 border border-coffee-light/5 p-3.5 rounded-xl">
              <h4 className="text-xs font-bold text-coffee-dark uppercase tracking-wider">Caffix Recipe Standard</h4>
              <p className="text-[11px] text-coffee-light mt-1 leading-relaxed">
                This vending machine prepares beverages using a balanced recipe with standard water, milk, and coffee strength, dispensed in a standard cup.
              </p>
            </div>

            {/* Extra Sugar Toggle */}
            <div className="flex justify-between items-center bg-cream-light/30 p-2 rounded-xl border border-cream hover:bg-cream-light/40 transition-colors">
              <div className="flex flex-col">
                <span className="text-xs font-bold text-coffee">Extra Sugar</span>
                <span className="text-[10px] text-coffee-light/75">Add sweetness to your drink</span>
              </div>
              <button
                onClick={() => setExtraSugar(!extraSugar)}
                className={`w-10 h-6 flex items-center rounded-full p-0.5 cursor-pointer transition-all duration-300 border ${
                  extraSugar ? 'bg-coffee border-coffee justify-end' : 'bg-cream-dark border-coffee-light/15 justify-start'
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-white shadow-md block" />
              </button>
            </div>
          </div>

          {/* Pricing & Checkout Block */}
          <div className="flex items-center justify-between border-t border-cream pt-2 mt-2">
            <div>
              <span className="text-[10px] uppercase font-bold text-coffee-light tracking-wide">Total Amount</span>
              <div className="text-2xl font-black text-coffee-dark leading-none mt-0.5">₹{currentPrice}</div>
            </div>
            <button
              onClick={() => onConfirm({ name: selectedCoffee.name, size, price: currentPrice, extraSugar })}
              className="py-2.5 px-6 bg-emerald-700 hover:bg-emerald-800 text-cream-light font-bold text-sm rounded-xl shadow-md transition-all flex items-center gap-2 active:scale-95 active-touch-feedback"
            >
              <Check className="w-4 h-4" />
              <span>Confirm Order</span>
            </button>
          </div>
        </div>
      </div>

      {/* Touch footer spacing */}
      <div className="text-center text-[9px] text-coffee-light/30 uppercase tracking-widest font-bold mt-1">
        Tap option to select • Caffix smart brewer
      </div>
    </div>
  );
}
