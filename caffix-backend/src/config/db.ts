import path from 'path';
import bcrypt from 'bcryptjs';

// Dynamically load native sqlite3 package only when NOT running on Vercel
let sqlite3: any = null;
let sqliteOpen: any = null;

if (!process.env.VERCEL) {
  try {
    sqlite3 = require('sqlite3');
    sqliteOpen = require('sqlite').open;
  } catch (error) {
    console.error('Failed to load native sqlite3 package:', error);
  }
}

// In-memory data store for Vercel Serverless environment
const mockStore = {
  users: [
    { id: 1, name: 'Caffix Manager', email: 'admin@caffix.com', password: bcrypt.hashSync('admin123', 10), role: 'admin' },
    { id: 2, name: 'kiosk-one', email: 'kiosk01@caffix.com', password: bcrypt.hashSync('kiosk123', 10), role: 'kiosk' }
  ],
  products: [
    { id: 1, name: 'Classic Coffee', price: 100, description: 'Rich and authentic coffee experience made from premium Arabica beans.', image: '/assets/classic_coffee.png' },
    { id: 2, name: 'Vanilla Coffee', price: 100, description: 'Smooth coffee blended with sweet vanilla notes for a creamy, comforting taste.', image: '/assets/vanilla_coffee.png' },
    { id: 3, name: 'Hazelnut Coffee', price: 100, description: 'Rich nutty aroma with a smooth coffee finish delivering a premium café experience.', image: '/assets/hazelnut_coffee.png' }
  ],
  machines: [
    { id: 'CFX-MC-01', machine_name: 'Kiosk-One', location: 'Delhi Airport T3', status: 'online', last_seen: new Date().toISOString() }
  ],
  inventory: [
    { id: 1, machine_id: 'CFX-MC-01', milk_level: 92, coffee_level: 78, vanilla_level: 65, hazelnut_level: 55, water_level: 85 }
  ],
  orders: [
    { id: 'CFX-4912', product_id: 1, amount: 100, status: 'COMPLETED', machine_id: 'CFX-MC-01', created_at: new Date().toISOString(), razorpay_order_id: null, razorpay_payment_id: null, razorpay_signature: null },
    { id: 'CFX-7104', product_id: 3, amount: 100, status: 'COMPLETED', machine_id: 'CFX-MC-01', created_at: new Date().toISOString(), razorpay_order_id: null, razorpay_payment_id: null, razorpay_signature: null },
    { id: 'CFX-3850', product_id: 2, amount: 100, status: 'COMPLETED', machine_id: 'CFX-MC-01', created_at: new Date().toISOString(), razorpay_order_id: null, razorpay_payment_id: null, razorpay_signature: null }
  ] as any[]
};

class MockDatabase {
  async exec(sql: string) {
    return;
  }

  async get(sql: string, params: any[] = []): Promise<any> {
    const query = sql.toLowerCase();
    
    if (query.includes('count(*)')) {
      if (query.includes('from users')) return { count: mockStore.users.length };
      if (query.includes('from products')) return { count: mockStore.products.length };
      if (query.includes('from machines')) return { count: mockStore.machines.length };
      if (query.includes('from inventory')) return { count: mockStore.inventory.length };
      if (query.includes('from orders')) return { count: mockStore.orders.length };
    }

    if (query.includes('from users')) {
      const email = params[0];
      return mockStore.users.find(u => u.email === email);
    }
    
    if (query.includes('from products')) {
      const id = params[0];
      return mockStore.products.find(p => p.id === Number(id));
    }
    
    if (query.includes('from machines')) {
      const id = params[0];
      return mockStore.machines.find(m => m.id === id);
    }
    
    if (query.includes('from inventory')) {
      const machineId = params[0];
      return mockStore.inventory.find(i => i.machine_id === machineId);
    }
    
    if (query.includes('from orders')) {
      let order: any;
      if (query.includes('where o.id = ?') || query.includes('where id = ?')) {
        const id = params[0];
        order = mockStore.orders.find(o => o.id === id);
      } else if (query.includes('where razorpay_order_id = ?')) {
        const rpId = params[0];
        order = mockStore.orders.find(o => o.razorpay_order_id === rpId);
      }
      
      if (order && query.includes('join products')) {
        const p = mockStore.products.find(prod => prod.id === order.product_id);
        return {
          ...order,
          product_name: p ? p.name : '',
          product_desc: p ? p.description : ''
        };
      }
      return order;
    }
    
    return null;
  }

  async all(sql: string, params: any[] = []): Promise<any[]> {
    const query = sql.toLowerCase();
    
    if (query.includes('from products')) {
      return mockStore.products;
    }

    if (query.includes('from machines')) {
      return mockStore.machines;
    }
    
    if (query.includes('from orders')) {
      return mockStore.orders.map(o => {
        const p = mockStore.products.find(prod => prod.id === o.product_id);
        return {
          ...o,
          product_name: p ? p.name : ''
        };
      }).sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    
    return [];
  }

  async run(sql: string, params: any[] = []): Promise<any> {
    const query = sql.toLowerCase();
    
    if (query.includes('insert into orders')) {
      const [id, product_id, amount, status, machine_id, created_at, razorpay_order_id] = params;
      const newOrder = {
        id,
        product_id,
        amount,
        status,
        machine_id,
        created_at,
        razorpay_order_id,
        razorpay_payment_id: null,
        razorpay_signature: null
      };
      mockStore.orders.push(newOrder);
      return { lastID: id };
    }
    
    if (query.includes('update orders set')) {
      if (query.includes('razorpay_payment_id = ?')) {
        const [paymentId, signature, orderId] = params;
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          order.razorpay_payment_id = paymentId;
          order.razorpay_signature = signature;
        }
      } else if (query.includes('status = ?')) {
        const [status, orderId] = params;
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          order.status = status.toUpperCase();
        }
      }
      return { changes: 1 };
    }
    
    if (query.includes('update inventory set')) {
      if (query.includes('milk_level = 100')) {
        const [machineId] = params;
        const inv = mockStore.inventory.find(i => i.machine_id === machineId);
        if (inv) {
          inv.milk_level = 100;
          inv.coffee_level = 100;
          inv.vanilla_level = 100;
          inv.hazelnut_level = 100;
          inv.water_level = 100;
        }
      } else if (query.includes('water_level = water_level - ?')) {
        const [water, coffee, milk, vanilla, hazelnut, machineId] = params;
        const inv = mockStore.inventory.find(i => i.machine_id === machineId);
        if (inv) {
          inv.water_level -= water;
          inv.coffee_level -= coffee;
          inv.milk_level -= milk;
          inv.vanilla_level -= vanilla;
          inv.hazelnut_level -= hazelnut;
        }
      } else {
        const [machineId] = params;
        const inv = mockStore.inventory.find(i => i.machine_id === machineId);
        if (inv) {
          const match = query.match(/update inventory set (\w+_level) = 100/);
          if (match) {
            const field = match[1];
            (inv as any)[field] = 100;
          }
        }
      }
      return { changes: 1 };
    }
    
    if (query.includes('update products set price = ?')) {
      const [price, id] = params;
      const prod = mockStore.products.find(p => p.id === Number(id));
      if (prod) {
        prod.price = Number(price);
      }
      return { changes: 1 };
    }
    
    if (query.includes('update machines set status = ?')) {
      const [status, id] = params;
      const mach = mockStore.machines.find(m => m.id === id);
      if (mach) {
        mach.status = status;
      }
      return { changes: 1 };
    }

    if (query.includes('insert into machines')) {
      const [id, machine_name, location, status, last_seen] = params;
      mockStore.machines.push({ id, machine_name, location, status, last_seen });
      return { lastID: id };
    }

    if (query.includes('insert into inventory')) {
      const [machine_id] = params;
      mockStore.inventory.push({ id: mockStore.inventory.length + 1, machine_id, milk_level: 100, coffee_level: 100, vanilla_level: 100, hazelnut_level: 100, water_level: 100 });
      return { lastID: mockStore.inventory.length };
    }
    
    return { lastID: null, changes: 0 };
  }
}

let db: any;

export async function initDB(): Promise<any> {
  if (process.env.VERCEL) {
    db = new MockDatabase();
    return db;
  }

  const dbPath = path.resolve(__dirname, '../../caffix.db');
  
  db = await sqliteOpen({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.run('PRAGMA foreign_keys = ON');

  // Create Users table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'kiosk'))
    )
  `);

  // Create Products table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      description TEXT,
      image TEXT
    )
  `);

  // Create Machines table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      machine_name TEXT NOT NULL,
      location TEXT,
      status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'maintenance')),
      last_seen TEXT NOT NULL
    )
  `);

  // Create Inventory table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT UNIQUE NOT NULL,
      milk_level INTEGER NOT NULL DEFAULT 100,
      coffee_level INTEGER NOT NULL DEFAULT 100,
      vanilla_level INTEGER NOT NULL DEFAULT 100,
      hazelnut_level INTEGER NOT NULL DEFAULT 100,
      water_level INTEGER NOT NULL DEFAULT 100,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    )
  `);

  // Create Orders table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'PAID', 'PREPARING', 'COMPLETED', 'FAILED', 'CANCELLED')),
      machine_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    )
  `);

  // Run dynamic schema migration check for existing tables
  try {
    const tableInfo = await db.all("PRAGMA table_info(orders)");
    const hasRpOrder = tableInfo.some((col: any) => col.name === 'razorpay_order_id');
    if (!hasRpOrder) {
      await db.exec(`
        ALTER TABLE orders ADD COLUMN razorpay_order_id TEXT;
        ALTER TABLE orders ADD COLUMN razorpay_payment_id TEXT;
        ALTER TABLE orders ADD COLUMN razorpay_signature TEXT;
      `);
    }
  } catch (err) {
    console.error('Database migration check failed:', err);
  }

  // Seed default data if empty
  await seedData();

  return db;
}

export function getDB(): any {
  if (!db) {
    throw new Error('Database not initialized! Call initDB() first.');
  }
  return db;
}

async function seedData() {
  // 1. Seed Users
  const userCount = await db.get('SELECT COUNT(*) as count FROM users');
  if (userCount && userCount.count === 0) {
    const adminHash = bcrypt.hashSync('admin123', 10);
    const kioskHash = bcrypt.hashSync('kiosk123', 10);
    
    await db.run(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      ['Caffix Manager', 'admin@caffix.com', adminHash, 'admin']
    );
    await db.run(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      ['kiosk-one', 'kiosk01@caffix.com', kioskHash, 'kiosk']
    );
  }

  // 2. Seed Products
  const productCount = await db.get('SELECT COUNT(*) as count FROM products');
  if (productCount && productCount.count === 0) {
    await db.run(
      'INSERT INTO products (id, name, price, description, image) VALUES (?, ?, ?, ?, ?)',
      [1, 'Classic Coffee', 100, 'Rich and authentic coffee experience made from premium Arabica beans.', '/assets/classic_coffee.png']
    );
    await db.run(
      'INSERT INTO products (id, name, price, description, image) VALUES (?, ?, ?, ?, ?)',
      [2, 'Vanilla Coffee', 100, 'Smooth coffee blended with sweet vanilla notes for a creamy, comforting taste.', '/assets/vanilla_coffee.png']
    );
    await db.run(
      'INSERT INTO products (id, name, price, description, image) VALUES (?, ?, ?, ?, ?)',
      [3, 'Hazelnut Coffee', 100, 'Rich nutty aroma with a smooth coffee finish delivering a premium café experience.', '/assets/hazelnut_coffee.png']
    );
  }

  // 3. Seed Machines
  const machineCount = await db.get('SELECT COUNT(*) as count FROM machines');
  if (machineCount && machineCount.count === 0) {
    await db.run(
      'INSERT INTO machines (id, machine_name, location, status, last_seen) VALUES (?, ?, ?, ?, ?)',
      ['CFX-MC-01', 'Kiosk-One', 'Delhi Airport T3', 'online', new Date().toISOString()]
    );
  }

  // 4. Seed Inventory
  const inventoryCount = await db.get('SELECT COUNT(*) as count FROM inventory');
  if (inventoryCount && inventoryCount.count === 0) {
    await db.run(
      'INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, water_level) VALUES (?, ?, ?, ?, ?, ?)',
      ['CFX-MC-01', 92, 78, 65, 55, 85]
    );
  }

  // 5. Seed Orders
  const orderCount = await db.get('SELECT COUNT(*) as count FROM orders');
  if (orderCount && orderCount.count === 0) {
    const today = new Date().toISOString();
    await db.run(
      'INSERT INTO orders (id, product_id, amount, status, machine_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['CFX-4912', 1, 100, 'COMPLETED', 'CFX-MC-01', today]
    );
    await db.run(
      'INSERT INTO orders (id, product_id, amount, status, machine_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['CFX-7104', 3, 100, 'COMPLETED', 'CFX-MC-01', today]
    );
    await db.run(
      'INSERT INTO orders (id, product_id, amount, status, machine_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['CFX-3850', 2, 100, 'COMPLETED', 'CFX-MC-01', today]
    );
  }
}
