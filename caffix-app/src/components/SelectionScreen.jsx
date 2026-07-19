import React from 'react';
import { ArrowLeft } from 'lucide-react';

const COFFEES = [
  {
    id: 'classic',
    name: 'Classic Crest',
    desc: 'Rich and authentic coffee experience made from premium Arabica beans.',
    price: 100,
    image: '/assets/classic_coffee.png'
  },
  {
    id: 'vanilla',
    name: 'Vanilla Velvet',
    desc: 'Smooth coffee blended with sweet vanilla notes for a creamy, comforting taste.',
    price: 100,
    image: '/assets/vanilla_coffee.png'
  },
  {
    id: 'hazelnut',
    name: 'Hazel Gold',
    desc: 'Rich nutty aroma with a smooth coffee finish delivering a premium café experience.',
    price: 100,
    image: '/assets/hazelnut_coffee.png'
  },
  {
    id: 'irish',
    name: 'Irish Emerald',
    desc: 'Classic espresso combined with rich Irish cream flavor and velvety smooth milk.',
    price: 100,
    image: '/assets/irish_coffee.png'
  },
  {
    id: 'mocha',
    name: 'Mocha Bliss',
    desc: 'Decadent chocolate syrup blended with robust espresso and creamy milk.',
    price: 100,
    image: '/assets/mocha_coffee.png'
  }
];

export default function SelectionScreen({ onSelect, onBack, prices = { classic: 100, vanilla: 100, hazelnut: 100, irish: 100, mocha: 100 } }) {
  const coffeesWithPrices = COFFEES.map((c) => ({
    ...c,
    price: prices[c.id] ?? c.price
  }));

  return (
    <div className="w-full h-full flex flex-col justify-between p-4 bg-cream-light relative overflow-hidden">
      {/* Title Header Row */}
      <div className="flex items-center gap-4 mb-2">
        <button
          onClick={onBack}
          className="p-2 rounded-xl bg-cream border border-coffee-light/20 hover:bg-cream-dark active:scale-95 active-touch-feedback"
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5 text-coffee" />
        </button>
        <div>
          <h2 className="font-sans font-extrabold text-2xl text-coffee-dark tracking-tight leading-none">
            Choose Your Beverage
          </h2>
          <p className="text-xs text-coffee-light font-medium tracking-wide mt-0.5">
            Select a flavor to customize your drink
          </p>
        </div>
      </div>

      {/* Coffee Cards Grid */}
      <div className="grid grid-cols-5 gap-3 flex-grow items-stretch my-2 overflow-hidden">
        {coffeesWithPrices.map((coffee) => (
          <div
            key={coffee.id}
            onClick={() => onSelect(coffee)}
            className="flex flex-col justify-between bg-white rounded-xl border border-coffee-light/10 shadow-sm overflow-hidden transform transition-all duration-300 hover:shadow-md active:scale-[0.98] cursor-pointer group active-touch-feedback relative"
          >
            {/* Coffee Image Section */}
            <div className="relative h-[100px] bg-cream/30 overflow-hidden flex items-center justify-center">
              <div
                className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover:scale-105"
                style={{ backgroundImage: `url('${coffee.image}')` }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-white/90 via-transparent to-transparent" />
            </div>

            {/* Information Section */}
            <div className="px-2.5 pb-2.5 flex-grow flex flex-col justify-between">
              <div>
                <h3 className="font-sans font-bold text-sm text-coffee-dark tracking-tight leading-tight group-hover:text-gold-dark transition-colors">
                  {coffee.name}
                </h3>
                <p className="text-[10px] text-coffee-light/80 leading-tight mt-1 line-clamp-3">
                  {coffee.desc}
                </p>
              </div>

              {/* Price & Action Button */}
              <div className="mt-2 flex items-center justify-between pt-1.5 border-t border-cream">
                <span className="font-sans font-black text-base text-coffee">
                  ₹{coffee.price}
                </span>
                <button
                  className="px-2.5 py-1 bg-coffee text-cream-light font-bold text-[10px] rounded-lg shadow-md group-hover:bg-gold-dark transition-all"
                  onClick={(e) => {
                    e.stopPropagation(); // Avoid double click trigger
                    onSelect(coffee);
                  }}
                >
                  Select
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer hint */}
      <div className="text-center text-[10px] text-coffee-light/40 uppercase tracking-widest font-bold">
        Secure touchless payment enabled
      </div>
    </div>
  );
}
