// CAFFIX Coffee Kiosk Controller

const FLAVOURS = {
  classic: {
    id: 'classic',
    name: 'Classic Coffee',
    desc: 'Rich and authentic coffee experience made from premium Arabica coffee beans.',
    image: 'assets/classic_coffee.png'
  },
  vanilla: {
    id: 'vanilla',
    name: 'Vanilla Coffee',
    desc: 'Smooth coffee blended with sweet vanilla notes for a creamy and comforting taste.',
    image: 'assets/vanilla_coffee.png'
  },
  hazelnut: {
    id: 'hazelnut',
    name: 'Hazelnut Coffee',
    desc: 'Nutty aroma with a smooth coffee finish delivering a premium café experience.',
    image: 'assets/hazelnut_coffee.png'
  }
};

const SIZES = {
  Small: { name: 'Small', volume: '150ml', price: 20 },
  Medium: { name: 'Medium', volume: '250ml', price: 30 },
  Large: { name: 'Large', volume: '350ml', price: 40 }
};

document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname;
  const page = path.substring(path.lastIndexOf('/') + 1);

  // Universal Header actions (hidden admin panel access)
  setupAdminRedirect();

  // Page specific controllers
  if (page === 'index.html' || page === '') {
    initWelcomePage();
  } else if (page === 'size-selection.html') {
    initSizePage();
  } else if (page === 'customization.html') {
    initCustomPage();
  } else if (page === 'order-summary.html') {
    initSummaryPage();
  } else if (page === 'payment.html') {
    initPaymentPage();
  } else if (page === 'preparing.html') {
    initPreparingPage();
  } else if (page === 'collect.html') {
    initCollectPage();
  } else if (page === 'admin.html') {
    initAdminPage();
  }
});

// Triple-tap header logo hook to enter admin telemetry
function setupAdminRedirect() {
  const brandSection = document.querySelector('.brand-section');
  if (brandSection) {
    let tapCount = 0;
    let tapTimer = null;
    brandSection.addEventListener('click', () => {
      tapCount++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { tapCount = 0; }, 1000);
      if (tapCount >= 3) {
        window.location.href = 'admin.html';
      }
    });
  }
}

// Redirect helpers
function navigateToHome() {
  window.location.href = 'index.html';
}

function navigateToSelection() {
  window.location.href = 'index.html'; // Direct home flavour cards
}

// Select flavour directly from Home page cards
function selectFlavour(id) {
  if (FLAVOURS[id]) {
    localStorage.setItem('selectedFlavour', id);
    // Initialize default states for next pages
    localStorage.setItem('cupSize', 'Medium');
    localStorage.setItem('sugarLevel', 'Medium');
    localStorage.setItem('coffeeStrength', 'Regular');
    localStorage.setItem('extraFoam', 'false');
    window.location.href = 'size-selection.html';
  }
}

// STEP 1: Welcome/Home Page Controller (HTML5 Steam Particles)
function initWelcomePage() {
  const canvas = document.getElementById('steam-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  // Resize canvas
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Particle class
  class Particle {
    constructor() {
      this.reset();
      this.y = Math.random() * canvas.height; // scatter initially
    }

    reset() {
      this.x = canvas.width / 2 + (Math.random() - 0.5) * 160;
      this.y = canvas.height + 20;
      this.size = Math.random() * 25 + 15;
      this.speedY = -(Math.random() * 1.5 + 0.8);
      this.speedX = (Math.random() - 0.5) * 0.8;
      this.alpha = Math.random() * 0.25 + 0.05;
      this.fade = 0.0015 + Math.random() * 0.001;
      this.swaySpeed = 0.01 + Math.random() * 0.01;
      this.swayAngle = Math.random() * Math.PI;
    }

    update() {
      this.y += this.speedY;
      this.swayAngle += this.swaySpeed;
      this.x += this.speedX + Math.sin(this.swayAngle) * 0.4;
      this.alpha -= this.fade;
      if (this.alpha <= 0 || this.y < -30) {
        this.reset();
      }
    }

    draw() {
      ctx.beginPath();
      // Use warm tan cream particles representing coffee steam aroma
      ctx.fillStyle = `rgba(245, 230, 211, ${this.alpha})`;
      ctx.shadowBlur = 10;
      ctx.shadowColor = 'rgba(201, 166, 107, 0.05)';
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const particles = Array.from({ length: 45 }, () => new Particle());

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw subtle gradient vignette under steam
    const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 10, canvas.width/2, canvas.height/2, canvas.height);
    grad.addColorStop(0, 'rgba(248, 245, 240, 0)');
    grad.addColorStop(1, 'rgba(245, 230, 211, 0.2)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    particles.forEach(p => {
      p.update();
      p.draw();
    });
    requestAnimationFrame(animate);
  }
  animate();
}

// STEP 2: Size Selection Controller
function initSizePage() {
  const sizeCards = document.querySelectorAll('.size-card');
  const continueBtn = document.getElementById('size-continue-btn');
  let selectedSize = localStorage.getItem('cupSize') || 'Medium';

  function updateActiveCard() {
    sizeCards.forEach(card => {
      const cardSize = card.getAttribute('data-size');
      if (cardSize === selectedSize) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });
    localStorage.setItem('cupSize', selectedSize);
    localStorage.setItem('currentPrice', SIZES[selectedSize].price);
  }

  sizeCards.forEach(card => {
    card.addEventListener('click', () => {
      selectedSize = card.getAttribute('data-size');
      updateActiveCard();
    });
  });

  // Init card selection state
  updateActiveCard();

  continueBtn.addEventListener('click', () => {
    window.location.href = 'customization.html';
  });
}

// STEP 3: Customization Page Controller (Sugar, Strength, Foam Toggles)
function initCustomPage() {
  const flavourId = localStorage.getItem('selectedFlavour') || 'classic';
  const flavour = FLAVOURS[flavourId];

  // Populate preview box
  document.getElementById('preview-img').style.backgroundImage = `url('${flavour.image}')`;
  document.getElementById('preview-name').textContent = flavour.name;
  
  const currentSize = localStorage.getItem('cupSize') || 'Medium';
  const currentPrice = SIZES[currentSize].price;
  document.getElementById('preview-price').textContent = `₹${currentPrice}`;

  // Wire toggles
  setupToggleGroup('sugar-toggles', 'sugarLevel');
  setupToggleGroup('strength-toggles', 'coffeeStrength');

  // Extra Foam switch
  const foamCheckbox = document.getElementById('foam-input');
  const currentFoam = localStorage.getItem('extraFoam') === 'true';
  foamCheckbox.checked = currentFoam;
  
  foamCheckbox.addEventListener('change', () => {
    localStorage.setItem('extraFoam', foamCheckbox.checked.toString());
  });

  document.getElementById('custom-continue-btn').addEventListener('click', () => {
    window.location.href = 'order-summary.html';
  });
}

// Custom toggle selectors
function setupToggleGroup(containerId, storageKey) {
  const container = document.getElementById(containerId);
  const buttons = container.querySelectorAll('.btn-toggle');
  
  const currentVal = localStorage.getItem(storageKey);
  buttons.forEach(btn => {
    if (btn.textContent.trim() === currentVal) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }

    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      localStorage.setItem(storageKey, btn.textContent.trim());
    });
  });
}

// STEP 4: Order Summary Page Controller
function initSummaryPage() {
  const flavourId = localStorage.getItem('selectedFlavour') || 'classic';
  const flavour = FLAVOURS[flavourId];
  
  const size = localStorage.getItem('cupSize') || 'Medium';
  const sugar = localStorage.getItem('sugarLevel') || 'Medium';
  const strength = localStorage.getItem('coffeeStrength') || 'Regular';
  const extraFoam = localStorage.getItem('extraFoam') === 'true' ? 'Yes' : 'No';
  const finalPrice = SIZES[size].price;

  // Render elements
  document.getElementById('summary-img').style.backgroundImage = `url('${flavour.image}')`;
  document.getElementById('summary-name').textContent = flavour.name;
  document.getElementById('summary-size-val').textContent = `${size} (${SIZES[size].volume})`;
  document.getElementById('summary-sugar-val').textContent = sugar;
  document.getElementById('summary-strength-val').textContent = strength;
  document.getElementById('summary-foam-val').textContent = extraFoam;
  document.getElementById('total-amount').textContent = `₹${finalPrice}`;

  document.getElementById('pay-proceed-btn').addEventListener('click', () => {
    window.location.href = 'payment.html';
  });
}

// STEP 5: Payment Page Controller (Redesigned Waiting loop + Timer)
function initPaymentPage() {
  const flavourId = localStorage.getItem('selectedFlavour') || 'classic';
  const flavour = FLAVOURS[flavourId];
  const size = localStorage.getItem('cupSize') || 'Medium';
  const price = SIZES[size].price;

  // Render Summary bill invoice
  document.getElementById('bill-item-name').textContent = `${flavour.name} (${size})`;
  document.getElementById('bill-amount').textContent = `₹${price}`;
  
  const orderNum = 'CFX-' + Math.floor(1000 + Math.random() * 9000);
  document.getElementById('order-number').textContent = orderNum;

  // Countdown timer 3:00
  let timeRemaining = 180; // 3 minutes in seconds
  const timerEl = document.getElementById('timer-count');
  
  function updateTimer() {
    const mins = Math.floor(timeRemaining / 60);
    const secs = timeRemaining % 60;
    timerEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    if (timeRemaining > 0) {
      timeRemaining--;
      setTimeout(updateTimer, 1000);
    } else {
      // payment expired
      window.location.href = 'index.html';
    }
  }
  updateTimer();

  // Simulated gateway logger logs
  const logEl = document.getElementById('log-text');
  const logs = [
    { delay: 0, text: 'Connecting Secure Gateway...' },
    { delay: 1800, text: 'Generating UPI QR Transaction Code...' },
    { delay: 3500, text: 'Awaiting Payment Verification (Scan QR)...' }
  ];

  logs.forEach(log => {
    setTimeout(() => {
      if (logEl) logEl.textContent = log.text;
    }, log.delay);
  });

  // Automated success redirection (simulates user scanning QR and paying in 7 seconds)
  const autoPayTimer = setTimeout(() => {
    logEl.textContent = 'Payment Approved! Starting brewer...';
    logEl.style.color = 'var(--color-success)';
    setTimeout(() => {
      window.location.href = 'preparing.html';
    }, 1200);
  }, 7800);

  // Hidden secret trigger on QR code to pay immediately
  const qrFrame = document.getElementById('qr-frame');
  if (qrFrame) {
    qrFrame.addEventListener('click', () => {
      clearTimeout(autoPayTimer);
      window.location.href = 'preparing.html';
    });
  }

  // Cancel button
  document.getElementById('cancel-btn').addEventListener('click', () => {
    clearTimeout(autoPayTimer);
    window.location.href = 'index.html';
  });
}

// STEP 6: Preparing Coffee Page Controller
function initPreparingPage() {
  const fill = document.getElementById('progress-fill');
  const stepText = document.getElementById('brewing-step-text');
  const tempVal = document.getElementById('spec-temp');
  const pressVal = document.getElementById('spec-pressure');

  const steps = [
    { progress: 10, text: 'Preheating brewing boilers...', temp: '42°C', press: '0.0 Bar' },
    { progress: 25, text: 'Grinding premium Arabica beans...', temp: '78°C', press: '0.5 Bar' },
    { progress: 40, text: 'Heating infusion element...', temp: '92°C', press: '1.5 Bar' },
    { progress: 65, text: 'Extracting espresso under 9 Bar...', temp: '92°C', press: '9.0 Bar' },
    { progress: 85, text: 'Dispensing coffee...', temp: '88°C', press: '3.0 Bar' },
    { progress: 100, text: 'Dispensing completed!', temp: '72°C', press: '0.0 Bar' }
  ];

  let currentStep = 0;
  
  // Total animation takes ~7-8 seconds for testability (representing commercial 45s stage changes)
  function executeBrewStep() {
    if (currentStep < steps.length) {
      const step = steps[currentStep];
      fill.style.width = `${step.progress}%`;
      stepText.textContent = step.text;
      
      if (tempVal) tempVal.textContent = step.temp;
      if (pressVal) pressVal.textContent = step.press;
      
      let delay = 1000;
      if (currentStep === 3) delay = 1800; // Extraction takes longer
      if (currentStep === 4) delay = 1200; // Dispense takes longer
      
      currentStep++;
      setTimeout(executeBrewStep, delay);
    } else {
      setTimeout(() => {
        // Record telemetry transaction on admin dashboard
        recordTransaction();
        window.location.href = 'collect.html';
      }, 1000);
    }
  }

  // Record mock diagnostics parameters
  function recordTransaction() {
    let sales = parseFloat(localStorage.getItem('adminSales') || '560');
    let orders = parseInt(localStorage.getItem('adminOrders') || '28');
    let water = parseFloat(localStorage.getItem('adminWater') || '85.5');
    let beans = parseFloat(localStorage.getItem('adminBeans') || '78.2');
    
    const size = localStorage.getItem('cupSize') || 'Medium';
    const price = SIZES[size].price;

    // increment sales metrics
    localStorage.setItem('adminSales', (sales + price).toFixed(2));
    localStorage.setItem('adminOrders', (orders + 1).toString());
    
    // consume inventories
    let waterUse = size === 'Large' ? 0.35 : size === 'Medium' ? 0.25 : 0.15;
    let beansUse = size === 'Large' ? 1.5 : size === 'Medium' ? 1.0 : 0.8;
    localStorage.setItem('adminWater', Math.max(0, water - waterUse).toFixed(1));
    localStorage.setItem('adminBeans', Math.max(0, beans - beansUse).toFixed(1));
  }

  setTimeout(executeBrewStep, 500);
}

// STEP 7: Collect Coffee Screen Controller (10s Countdown)
function initCollectPage() {
  const countdownEl = document.getElementById('collect-countdown-num');
  let timeRemaining = 10;
  
  function tick() {
    if (countdownEl) countdownEl.textContent = timeRemaining;
    if (timeRemaining > 0) {
      timeRemaining--;
      setTimeout(tick, 1000);
    } else {
      navigateToHome();
    }
  }
  tick();
}

// TELEMETRY ADMIN DASHBOARD CONTROLLER
function initAdminPage() {
  // Read live state
  const sales = localStorage.getItem('adminSales') || '560.00';
  const orders = localStorage.getItem('adminOrders') || '28';
  const water = localStorage.getItem('adminWater') || '85.5';
  const beans = localStorage.getItem('adminBeans') || '78.2';

  document.getElementById('admin-sales').textContent = `₹${sales}`;
  document.getElementById('admin-orders').textContent = orders;
  document.getElementById('admin-water').textContent = `${water}%`;
  document.getElementById('admin-beans').textContent = `${beans}%`;

  // Refill indicators trigger
  const refillBtn = document.getElementById('admin-refill-btn');
  if (refillBtn) {
    refillBtn.addEventListener('click', () => {
      localStorage.setItem('adminWater', '100.0');
      localStorage.setItem('adminBeans', '100.0');
      document.getElementById('admin-water').textContent = '100.0%';
      document.getElementById('admin-beans').textContent = '100.0%';
      alert('Inventories refilled successfully.');
    });
  }
}
