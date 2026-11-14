import path from 'path';
import bcrypt from 'bcryptjs';
import { initializeInventoryLedgerSchema } from '../utils/inventoryLedger';

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

export interface DefaultMachineSeed {
  id: string;
  machine_name: string;
  location: string;
  kiosk_token: string | null;
}

export function getConfiguredMachineSeeds(): DefaultMachineSeed[] {
  const perMachineTokens = new Map<string, string>();
  const rawKeys = process.env.KIOSK_MACHINE_KEYS || '';
  if (rawKeys.trim()) {
    for (const pair of rawKeys.split(',')) {
      const [mId, token] = pair.split(':').map(s => s.trim());
      if (mId && token) {
        perMachineTokens.set(mId, token);
      }
    }
  }

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith('KIOSK_SECRET_') && envVal) {
      const mId = envKey.replace('KIOSK_SECRET_', '').replace(/_/g, '-');
      perMachineTokens.set(mId, envVal.trim());
    }
  }

  const defaults: DefaultMachineSeed[] = [
    { id: 'CFX-MC-01', machine_name: 'Kiosk-One', location: 'Location 1', kiosk_token: perMachineTokens.get('CFX-MC-01') || null },
    { id: 'CFX-MC-02', machine_name: 'Kiosk-Two', location: 'Location 2', kiosk_token: perMachineTokens.get('CFX-MC-02') || null },
    { id: 'CFX-MC-03', machine_name: 'Kiosk-Three', location: 'Location 3', kiosk_token: perMachineTokens.get('CFX-MC-03') || null },
    { id: 'CFX-MC-04', machine_name: 'Kiosk-Four', location: 'Location 4', kiosk_token: perMachineTokens.get('CFX-MC-04') || null }
  ];

  const existingIds = new Set(defaults.map(d => d.id));

  // Add any additional machines from REGISTERED_MACHINES (comma-separated IDs, e.g. "CFX-MC-04,CFX-MC-05")
  const extraList = (process.env.REGISTERED_MACHINES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  for (const mId of extraList) {
    if (!existingIds.has(mId)) {
      existingIds.add(mId);
      defaults.push({
        id: mId,
        machine_name: `Kiosk-${mId}`,
        location: 'Registered Location',
        kiosk_token: perMachineTokens.get(mId) || null
      });
    }
  }

  // Also include any machine IDs defined in KIOSK_MACHINE_KEYS / KIOSK_SECRET_*
  for (const [mId, token] of perMachineTokens.entries()) {
    if (!existingIds.has(mId)) {
      existingIds.add(mId);
      defaults.push({
        id: mId,
        machine_name: `Kiosk-${mId}`,
        location: 'Registered Location',
        kiosk_token: token
      });
    }
  }

  return defaults;
}

const initialMachineSeeds = getConfiguredMachineSeeds();

function createInitialMockStore() {
  return {
    users: [
      {
        id: '1' as string | number,
        name: 'Caffix Manager',
        email: 'admin@caffix.com',
        password: bcrypt.hashSync('admin123', 10),
        role: 'admin',
        setup_token_hash: null as string | null,
        setup_token_expires_at: null as string | null,
        must_change_password: 0,
        updated_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: '2' as string | number,
        name: 'kiosk-one',
        email: 'kiosk01@caffix.com',
        password: bcrypt.hashSync('kiosk123', 10),
        role: 'kiosk',
        setup_token_hash: null as string | null,
        setup_token_expires_at: null as string | null,
        must_change_password: 0,
        updated_at: '2026-01-01T00:00:00.000Z'
      }
    ],
    products: [
      { id: 1, name: 'Classic Crest', price: 100, description: 'Rich and authentic coffee experience made from premium Arabica beans.', image: '/assets/classic_coffee.png' },
      { id: 2, name: 'Vanilla Velvet', price: 100, description: 'Smooth coffee blended with sweet vanilla notes for a creamy, comforting taste.', image: '/assets/vanilla_coffee.png' },
      { id: 3, name: 'Hazel Gold', price: 100, description: 'Rich nutty aroma with a smooth coffee finish delivering a premium café experience.', image: '/assets/hazelnut_coffee.png' },
      { id: 4, name: 'Irish Emerald', price: 100, description: 'Classic espresso combined with rich Irish cream flavor and velvety smooth milk.', image: '/assets/irish_coffee.png' },
      { id: 5, name: 'Mocha Bliss', price: 100, description: 'Decadent chocolate syrup blended with robust espresso and creamy milk.', image: '/assets/mocha_coffee.png' }
    ],
    machines: initialMachineSeeds.map((m, idx) => ({
      id: m.id,
      machine_name: m.machine_name,
      location: idx === 0 ? 'Delhi Airport T3' : m.location,
      desired_mode: 'RUNNING' as 'RUNNING' | 'MAINTENANCE',
      status: 'online',
      last_seen: null as string | null,
      kiosk_token: m.kiosk_token,
      owner_id: null as string | null,
      updated_at: '2026-01-01T00:00:00.000Z'
    })),
    machine_products: [] as Array<{
      machine_id: string;
      product_id: number;
      price: number;
      is_available: number;
      updated_at: string;
    }>,
    inventory: initialMachineSeeds.map((m, idx) => ({
      id: idx + 1,
      machine_id: m.id,
      milk_level: idx === 0 ? 92 : 100,
      coffee_level: idx === 0 ? 78 : 100,
      vanilla_level: idx === 0 ? 65 : 100,
      hazelnut_level: idx === 0 ? 55 : 100,
      irish_level: idx === 0 ? 60 : 100,
      mocha_level: idx === 0 ? 50 : 100,
      water_level: idx === 0 ? 85 : 100,
      updated_at: '2026-01-01T00:00:00.000Z'
    })),
    orders: [
      { id: 'CFX-4912', product_id: 1, amount: 100, status: 'COMPLETED', machine_id: 'CFX-MC-01', created_at: new Date().toISOString(), razorpay_order_id: null, razorpay_payment_id: null, razorpay_signature: null, refund_status: 'NONE', total_refunded_amount_paise: 0, pending_refund_amount_paise: 0, last_refunded_at: null, captured_amount_paise: null },
      { id: 'CFX-7104', product_id: 3, amount: 100, status: 'COMPLETED', machine_id: 'CFX-MC-01', created_at: new Date().toISOString(), razorpay_order_id: null, razorpay_payment_id: null, razorpay_signature: null, refund_status: 'NONE', total_refunded_amount_paise: 0, pending_refund_amount_paise: 0, last_refunded_at: null, captured_amount_paise: null },
      { id: 'CFX-3850', product_id: 2, amount: 100, status: 'COMPLETED', machine_id: 'CFX-MC-01', created_at: new Date().toISOString(), razorpay_order_id: null, razorpay_payment_id: null, razorpay_signature: null, refund_status: 'NONE', total_refunded_amount_paise: 0, pending_refund_amount_paise: 0, last_refunded_at: null, captured_amount_paise: null }
    ] as any[],
    refunds: [] as any[],
    webhook_events: [] as any[]
  };
}

// In-memory data store for Vercel Serverless environment
let mockStore = createInitialMockStore();

/**
 * Resets the in-memory MockDatabase to its initial cold-start seed state.
 * Used in automated tests to verify that authoritative Firestore state survives Vercel cold starts.
 */
export function resetMockDatabaseForColdStartSimulation(): void {
  mockStore = createInitialMockStore();
  if (process.env.VERCEL) {
    db = new MockDatabase();
  }
}

class MockDatabase {
  async exec(sql: string) {
    return;
  }

  async get(sql: string, params: any[] = []): Promise<any> {
    const query = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    
    if (query.includes('count(*)')) {
      if (query.includes('from users')) return { count: mockStore.users.length };
      if (query.includes('from products')) return { count: mockStore.products.length };
      if (query.includes('from machines')) return { count: mockStore.machines.length };
      if (query.includes('from machine_products')) return { count: mockStore.machine_products.length };
      if (query.includes('from inventory')) return { count: mockStore.inventory.length };
      if (query.includes('from orders')) return { count: mockStore.orders.length };
      if (query.includes('from refunds')) return { count: mockStore.refunds.length };
    }

    if (query.includes('from users')) {
      const param = params[0];
      if (query.includes('where id = ?')) {
        return mockStore.users.find(u => String(u.id) === String(param));
      }
      if (query.includes('where setup_token_hash = ?')) {
        return mockStore.users.find(u => u.setup_token_hash && u.setup_token_hash === param);
      }
      return mockStore.users.find(u => u.email.toLowerCase() === String(param).toLowerCase());
    }
    
    if (query.includes('from machine_products')) {
      const [machineId, productId] = params;
      return mockStore.machine_products.find(
        mp => mp.machine_id === machineId && mp.product_id === Number(productId)
      );
    }

    if (query.includes('from products')) {
      const id = params[0];
      return mockStore.products.find(p => p.id === Number(id));
    }
    
    if (query.includes('from machines')) {
      const param = params[0];
      if (query.includes('where kiosk_token = ?')) {
        return mockStore.machines.find(m => m.kiosk_token && m.kiosk_token === param);
      }
      return mockStore.machines.find(m => m.id === param);
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
      
      if (order) {
        if (order.refund_status === undefined) order.refund_status = 'NONE';
        if (order.total_refunded_amount_paise === undefined) order.total_refunded_amount_paise = 0;
        if (order.pending_refund_amount_paise === undefined) order.pending_refund_amount_paise = 0;
        if (order.last_refunded_at === undefined) order.last_refunded_at = null;
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

    if (query.includes('from refunds')) {
      if (query.includes('where id = ?')) {
        return mockStore.refunds.find(r => r.id === params[0]) || null;
      }
      if (query.includes('where idempotency_key = ?')) {
        return mockStore.refunds.find(r => r.idempotency_key === params[0]) || null;
      }
      if (query.includes('where razorpay_refund_id = ?')) {
        return mockStore.refunds.find(r => r.razorpay_refund_id === params[0]) || null;
      }
      if (query.includes('where order_id = ?')) {
        return mockStore.refunds.find(r => r.order_id === params[0]) || null;
      }
      return mockStore.refunds[0] || null;
    }

    if (query.includes('from webhook_events')) {
      if (query.includes('where provider = ? and event_id = ?')) {
        const [provider, eventId] = params;
        return (
          mockStore.webhook_events.find(
            (e: any) => e.provider === provider && e.event_id === eventId
          ) || null
        );
      }
      if (query.includes('where id = ?')) {
        return mockStore.webhook_events.find((e: any) => e.id === params[0]) || null;
      }
      return mockStore.webhook_events[0] || null;
    }
    
    return null;
  }

  async all(sql: string, params: any[] = []): Promise<any[]> {
    const query = sql.toLowerCase().replace(/\s+/g, ' ').trim();

    if (query.includes('from refunds')) {
      let filtered = mockStore.refunds;
      if (query.includes('where order_id = ?')) {
        filtered = filtered.filter(r => r.order_id === params[0]);
      } else if (query.includes('where machine_id = ?')) {
        filtered = filtered.filter(r => r.machine_id === params[0]);
      } else if (query.includes('where status = ?')) {
        filtered = filtered.filter(r => String(r.status).toUpperCase() === String(params[0]).toUpperCase());
      }
      return filtered.slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    }

    if (query.includes('from webhook_events')) {
      let filtered = mockStore.webhook_events;
      if (query.includes('where order_id = ?')) {
        filtered = filtered.filter((e: any) => e.order_id === params[0]);
      } else if (query.includes('where payment_id = ?')) {
        filtered = filtered.filter((e: any) => e.payment_id === params[0]);
      } else if (query.includes('where refund_id = ?')) {
        filtered = filtered.filter((e: any) => e.refund_id === params[0]);
      }
      return [...filtered];
    }
    
    if (query.includes('from users')) {
      if (query.includes('where role = ?')) {
        return mockStore.users.filter(u => u.role === params[0]);
      }
      return mockStore.users;
    }

    if (query.includes('from machine_products')) {
      if (query.includes('where machine_id = ?')) {
        return mockStore.machine_products.filter(mp => mp.machine_id === params[0]);
      }
      return mockStore.machine_products;
    }

    if (query.includes('from products')) {
      return mockStore.products;
    }

    if (query.includes('from machines')) {
      if (query.includes('where owner_id = ?')) {
        return mockStore.machines.filter(m => m.owner_id && String(m.owner_id) === String(params[0]));
      }
      return mockStore.machines;
    }
    
    if (query.includes('from orders')) {
      let filtered = mockStore.orders;
      if (query.includes('where o.machine_id = ?') || query.includes('where machine_id = ?')) {
        const machineId = params[0];
        filtered = filtered.filter(o => o.machine_id === machineId);
      } else if (query.includes('where o.status = ?') || query.includes('where status = ?')) {
        const statusFilter = String(params[0] || '').toUpperCase();
        filtered = filtered.filter(o => String(o.status || '').toUpperCase() === statusFilter);
      }
      return filtered.map(o => {
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
    const query = sql.toLowerCase().replace(/\s+/g, ' ').trim();

    if (query.startsWith('begin') || query.startsWith('commit') || query.startsWith('rollback')) {
      return { changes: 0 };
    }
    
    if (query.includes('insert into users') || query.includes('replace into users')) {
      // Support both explicit id (id, name, email, password, role, ...) and auto-generated id (name, email, password, role)
      if (query.includes('(id,')) {
        const [id, name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at] = params;
        const resolvedId = String(id);
        const existingIdx = mockStore.users.findIndex(
          u => String(u.id) === resolvedId || u.email.toLowerCase() === String(email).toLowerCase()
        );
        const userRecord = {
          id: resolvedId,
          name,
          email: String(email).toLowerCase(),
          password,
          role,
          setup_token_hash: setup_token_hash ?? null,
          setup_token_expires_at: setup_token_expires_at ?? null,
          must_change_password: must_change_password ?? 0,
          updated_at: updated_at || new Date().toISOString()
        };
        if (existingIdx >= 0) {
          mockStore.users[existingIdx] = userRecord;
        } else {
          mockStore.users.push(userRecord);
        }
        return { lastID: resolvedId, changes: 1 };
      } else {
        const [name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at] = params;
        const numericIds = mockStore.users.map(u => Number(u.id)).filter(n => !Number.isNaN(n));
        const newId = String((numericIds.length ? Math.max(...numericIds) : 0) + 1);
        mockStore.users.push({
          id: newId,
          name,
          email: String(email).toLowerCase(),
          password,
          role,
          setup_token_hash: setup_token_hash ?? null,
          setup_token_expires_at: setup_token_expires_at ?? null,
          must_change_password: must_change_password ?? 0,
          updated_at: updated_at || new Date().toISOString()
        });
        return { lastID: newId, changes: 1 };
      }
    }

    if (query.includes('update users set')) {
      if (query.includes('where id = ? and setup_token_hash = ?')) {
        const [password, updated_at, id, expectedTokenHash] = params;
        const user = mockStore.users.find(
          u => String(u.id) === String(id) && u.setup_token_hash && u.setup_token_hash === expectedTokenHash
        );
        if (!user) {
          return { changes: 0 };
        }
        user.password = password;
        user.setup_token_hash = null;
        user.setup_token_expires_at = null;
        user.must_change_password = 0;
        user.updated_at = updated_at || new Date().toISOString();
        return { changes: 1 };
      }

      const idOrEmail = params[params.length - 1];
      const user = query.includes('where id = ?')
        ? mockStore.users.find(u => String(u.id) === String(idOrEmail))
        : mockStore.users.find(u => u.email.toLowerCase() === String(idOrEmail).toLowerCase());
      if (user) {
        if (query.includes('name = ?') && query.includes('email = ?') && query.includes('password = ?') && query.includes('role = ?')) {
          const [name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at] = params;
          user.name = name ?? user.name;
          user.email = email ? String(email).toLowerCase() : user.email;
          user.password = password ?? user.password;
          user.role = role ?? user.role;
          user.setup_token_hash = setup_token_hash ?? null;
          user.setup_token_expires_at = setup_token_expires_at ?? null;
          user.must_change_password = must_change_password ?? 0;
          user.updated_at = updated_at || new Date().toISOString();
        } else if (query.includes('password = ?') && query.includes('setup_token_hash = null')) {
          user.password = params[0];
          user.setup_token_hash = null;
          user.setup_token_expires_at = null;
          user.must_change_password = 0;
          user.updated_at = params[1] || new Date().toISOString();
        } else if (query.includes('setup_token_hash = ?')) {
          user.setup_token_hash = params[0];
          user.setup_token_expires_at = params[1];
          user.must_change_password = params[2] ?? 1;
          user.updated_at = params[3] || new Date().toISOString();
        } else if (query.includes('password = ?')) {
          user.password = params[0];
          user.updated_at = params[1] || new Date().toISOString();
        }
      }
      return { changes: user ? 1 : 0 };
    }

    if (query.includes('insert into orders')) {
      const [id, product_id, amount, status, machine_id, created_at, razorpay_order_id, extra_sugar, base] = params;
      const existingIdx = mockStore.orders.findIndex(o => o.id === id);
      const newOrder = {
        id,
        product_id,
        amount,
        status,
        machine_id,
        created_at,
        razorpay_order_id,
        razorpay_payment_id: null,
        razorpay_signature: null,
        extra_sugar: extra_sugar ?? 1,
        base: base ?? 'water',
        dispense_status: 'PENDING',
        customer_name: null,
        customer_email: null,
        updated_at: created_at || new Date().toISOString(),
        dispensed_at: null,
        dispense_started_at: null,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        last_refunded_at: null,
        captured_amount_paise: null
      };
      if (existingIdx >= 0) {
        if (query.includes('insert or replace')) {
          mockStore.orders[existingIdx] = { ...mockStore.orders[existingIdx], ...newOrder };
        } else {
          throw new Error(`SQLITE_CONSTRAINT: UNIQUE constraint failed: orders.id (${id})`);
        }
      } else {
        mockStore.orders.push(newOrder);
      }
      return { lastID: id };
    }
    
    if (query.includes('update orders set')) {
      const isPendingOnly = query.includes("where id = ? and status = 'pending'");
      const isUnpaidOrigin = query.includes("where id = ? and status in ('pending', 'cancelled', 'failed')");
      if (query.includes("status = ?") && (isPendingOnly || isUnpaidOrigin)) {
        const eligibleStatuses = isUnpaidOrigin ? ['PENDING', 'CANCELLED', 'FAILED'] : ['PENDING'];
        const orderId = params[params.length - 1];
        const status = params[0];
        const order = mockStore.orders.find(o => o.id === orderId);
        if (!order || !eligibleStatuses.includes(String(order.status || '').toUpperCase())) {
          return { changes: 0 };
        }
        order.status = String(status).toUpperCase();

        if (query.includes('razorpay_payment_id')) {
          const paymentId = params[1];
          const signature = params[2];
          if (paymentId !== undefined && paymentId !== null && !order.razorpay_payment_id) {
            order.razorpay_payment_id = paymentId;
          }
          if (signature !== undefined && signature !== null && !order.razorpay_signature) {
            order.razorpay_signature = signature;
          }
        }
        if (query.includes('captured_amount_paise')) {
          // If query has captured_amount_paise, cap is param at index 3 in 5-param update
          const capIdx = query.includes('razorpay_payment_id') ? 3 : 1;
          const capPaise = params[capIdx];
          if (capPaise !== undefined && capPaise !== null && (order.captured_amount_paise === null || order.captured_amount_paise === undefined)) {
            order.captured_amount_paise = Number(capPaise);
          }
        }
        return { changes: 1 };
      }

      if (query.includes('pending_refund_amount_paise = ?') && query.includes('total_refunded_amount_paise = ?')) {
        const [pendingPaise, totalRefundedPaise, lastRefundedAt, refundStatus, updatedAt, orderId] = params;
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          order.pending_refund_amount_paise = Number(pendingPaise);
          order.total_refunded_amount_paise = Number(totalRefundedPaise);
          order.last_refunded_at = lastRefundedAt;
          order.refund_status = refundStatus;
          order.updated_at = updatedAt;
          return { changes: 1 };
        }
        return { changes: 0 };
      } else if (query.includes('pending_refund_amount_paise = ?') && query.includes('refund_status = ?')) {
        const [pendingPaise, refundStatus, updatedAt, orderId] = params;
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          order.pending_refund_amount_paise = Number(pendingPaise);
          order.refund_status = refundStatus;
          order.updated_at = updatedAt;
          return { changes: 1 };
        }
        return { changes: 0 };
      } else if (query.includes('captured_amount_paise =') || query.includes('captured_amount_paise = coalesce')) {
        const orderId = params[params.length - 1];
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          // Find capAmount in params
          for (const p of params.slice(0, params.length - 1)) {
            if (typeof p === 'number' && Number.isInteger(p) && p > 0) {
              if (order.captured_amount_paise === null || order.captured_amount_paise === undefined) {
                order.captured_amount_paise = p;
              }
            } else if (typeof p === 'string' && (p.startsWith('pay_') || p.startsWith('pay_mock_'))) {
              if (!order.razorpay_payment_id) order.razorpay_payment_id = p;
            }
          }
          return { changes: 1 };
        }
        return { changes: 0 };
      } else if (query.includes('razorpay_payment_id = ?')) {
        let paymentId: any;
        let signature: any = null;
        let orderId: any;
        if (query.includes('razorpay_signature = ?')) {
          [paymentId, signature, orderId] = params;
        } else {
          [paymentId, orderId] = params;
        }
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          order.razorpay_payment_id = paymentId;
          if (signature !== undefined) {
            order.razorpay_signature = signature;
          }
        }
        return { changes: order ? 1 : 0 };
      } else if (query.includes('razorpay_order_id = ?')) {
        const [rpOrderId, orderId] = params;
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          order.razorpay_order_id = rpOrderId;
        }
        return { changes: order ? 1 : 0 };
      } else if (query.includes('dispense_status = ?')) {
        const [dispenseStatus, orderId] = params;
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          order.dispense_status = String(dispenseStatus).toUpperCase();
        }
        return { changes: order ? 1 : 0 };
      } else if (!query.includes('dispense_status') && query.includes('status = ?')) {
        const [status, orderId] = params;
        const order = mockStore.orders.find(o => o.id === orderId);
        if (order) {
          order.status = status.toUpperCase();
        }
        return { changes: order ? 1 : 0 };
      }
      return { changes: 0 };
    }

    if (query.includes('delete from orders')) {
      if (query.includes('where id = ?')) {
        const idx = mockStore.orders.findIndex(o => o.id === params[0]);
        if (idx >= 0) {
          mockStore.orders.splice(idx, 1);
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      const deletedCount = mockStore.orders.length;
      mockStore.orders = [];
      return { changes: deletedCount || 1 };
    }

    if (query.includes('insert into refunds')) {
      const [
        id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
        amount_paise, currency, status, reason, notes, initiated_by,
        source, idempotency_key, error_code, error_description,
        created_at, updated_at, processed_at
      ] = params;
      const existingKey = mockStore.refunds.find(r => r.idempotency_key === idempotency_key);
      if (existingKey) {
        throw new Error(`SQLITE_CONSTRAINT: UNIQUE constraint failed: refunds.idempotency_key (${idempotency_key})`);
      }
      const existingId = mockStore.refunds.find(r => r.id === id);
      if (existingId) {
        throw new Error(`SQLITE_CONSTRAINT: UNIQUE constraint failed: refunds.id (${id})`);
      }
      const newRefund = {
        id,
        order_id,
        machine_id,
        razorpay_payment_id,
        razorpay_refund_id: razorpay_refund_id || null,
        amount_paise: Number(amount_paise),
        currency: currency || 'INR',
        status: status || 'PENDING',
        reason: reason || '',
        notes: notes || null,
        initiated_by: initiated_by || 'admin',
        source: source || 'SUPER_ADMIN_PORTAL',
        idempotency_key,
        error_code: error_code || null,
        error_description: error_description || null,
        created_at: created_at || new Date().toISOString(),
        updated_at: updated_at || new Date().toISOString(),
        processed_at: processed_at || null
      };
      mockStore.refunds.push(newRefund);
      return { lastID: id, changes: 1 };
    }

    if (query.includes('update refunds set')) {
      const refundId = params[params.length - 1];
      const refund = mockStore.refunds.find(r => r.id === refundId);
      if (!refund) return { changes: 0 };
      if (query.includes("and status = 'pending'") && refund.status !== 'PENDING') {
        return { changes: 0 };
      }
      if (query.includes('status = ?') && query.includes('razorpay_refund_id = ?')) {
        const [status, rpRefundId, processedAt, updatedAt] = params;
        refund.status = status;
        refund.razorpay_refund_id = rpRefundId;
        refund.processed_at = processedAt;
        refund.updated_at = updatedAt;
        return { changes: 1 };
      }
      if (query.includes("status = 'processed'") && query.includes('razorpay_refund_id = ?')) {
        const [rpRefundId, processedAt, updatedAt] = params;
        refund.status = 'PROCESSED';
        refund.razorpay_refund_id = rpRefundId;
        refund.processed_at = processedAt;
        refund.updated_at = updatedAt;
        return { changes: 1 };
      }
      if (query.includes('status = ?') && query.includes('error_code = ?')) {
        const [status, errorCode, errorDesc, updatedAt] = params;
        refund.status = status;
        refund.error_code = errorCode;
        refund.error_description = errorDesc;
        refund.updated_at = updatedAt;
        return { changes: 1 };
      }
      if (query.includes("status = 'failed'") && query.includes('error_code = ?')) {
        const [errorCode, errorDesc, updatedAt] = params;
        refund.status = 'FAILED';
        refund.error_code = errorCode;
        refund.error_description = errorDesc;
        refund.updated_at = updatedAt;
        return { changes: 1 };
      }
      if (query.includes('status = ?')) {
        refund.status = params[0];
        return { changes: 1 };
      }
      return { changes: 1 };
    }

    if (query.includes('delete from refunds')) {
      if (query.includes('where id = ?')) {
        const idx = mockStore.refunds.findIndex(r => r.id === params[0]);
        if (idx >= 0) {
          mockStore.refunds.splice(idx, 1);
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      const count = mockStore.refunds.length;
      mockStore.refunds = [];
      return { changes: count };
    }

    if (
      query.includes('insert into webhook_events') ||
      query.includes('insert or replace into webhook_events') ||
      query.includes('insert or ignore into webhook_events')
    ) {
      // Support flexible parameter bindings for 12, 14, or 15 column formats
      let id, provider, eventId, eventType, orderId, paymentId, refundId, status, payload, errorMessage, leaseExpiresAt, claimCount, createdAt, updatedAt, processedAt;
      
      if (params.length >= 13) {
        [
          id,
          provider,
          eventId,
          eventType,
          orderId,
          paymentId,
          refundId,
          status,
          payload,
          errorMessage,
          leaseExpiresAt,
          claimCount,
          createdAt,
          updatedAt,
          processedAt
        ] = params;
      } else {
        [
          id,
          provider,
          eventId,
          eventType,
          orderId,
          paymentId,
          refundId,
          status,
          payload,
          errorMessage,
          createdAt,
          processedAt
        ] = params;
      }

      const existingIdx = mockStore.webhook_events.findIndex(
        (e: any) => e.provider === provider && e.event_id === eventId
      );
      if (existingIdx >= 0) {
        if (query.includes('replace')) {
          mockStore.webhook_events[existingIdx] = {
            id,
            provider,
            event_id: eventId,
            event_type: eventType,
            order_id: orderId || null,
            payment_id: paymentId || null,
            refund_id: refundId || null,
            status,
            payload: payload || null,
            error_message: errorMessage || null,
            lease_expires_at: leaseExpiresAt || null,
            claim_count: claimCount !== undefined ? Number(claimCount) : 1,
            created_at: createdAt,
            updated_at: updatedAt || createdAt,
            processed_at: processedAt || null
          };
          return { changes: 1 };
        }
        if (query.includes('ignore')) {
          return { changes: 0 };
        }
        // Match real SQLite unique constraint behavior for plain INSERT
        throw new Error(
          'SQLITE_CONSTRAINT: UNIQUE constraint failed: webhook_events.provider, webhook_events.event_id'
        );
      }
      mockStore.webhook_events.push({
        id,
        provider,
        event_id: eventId,
        event_type: eventType,
        order_id: orderId || null,
        payment_id: paymentId || null,
        refund_id: refundId || null,
        status,
        payload: payload || null,
        error_message: errorMessage || null,
        lease_expires_at: leaseExpiresAt || null,
        claim_count: claimCount !== undefined ? Number(claimCount) : 1,
        created_at: createdAt,
        updated_at: updatedAt || createdAt,
        processed_at: processedAt || null
      });
      return { changes: 1, lastID: id };
    }

    if (query.includes('update webhook_events set')) {
      const eventId = params[params.length - 1];
      const provider = params[params.length - 2];
      const event = mockStore.webhook_events.find(
        (e: any) =>
          (e.provider === provider && e.event_id === eventId) || e.id === eventId
      );
      if (event) {
        if (query.includes('status = ?') && query.includes('lease_expires_at = ?')) {
          // Lease update: status = ?, lease_expires_at = ?, claim_count = ?, updated_at = ?
          event.status = params[0];
          event.lease_expires_at = params[1];
          event.claim_count = Number(params[2] || event.claim_count || 1);
          event.updated_at = params[3] || new Date().toISOString();
        } else {
          if (query.includes('status = ?')) {
            event.status = params[0];
          }
          if (query.includes('processed_at = ?')) {
            event.processed_at = params[1] || new Date().toISOString();
          }
          if (query.includes('error_message = ?')) {
            event.error_message = params[2] || null;
          }
          if (query.includes('updated_at = ?')) {
            event.updated_at = new Date().toISOString();
          }
        }
        return { changes: 1 };
      }
      return { changes: 0 };
    }
    
    if (query.includes('update inventory set')) {
      if (query.includes('milk_level = ?') && query.includes('coffee_level = ?') && query.includes('vanilla_level = ?')) {
        const [milk, coffee, vanilla, hazelnut, irish, mocha, water, updatedAt, machineId] = params;
        const inv = mockStore.inventory.find(i => i.machine_id === machineId);
        if (inv) {
          inv.milk_level = Number(milk);
          inv.coffee_level = Number(coffee);
          inv.vanilla_level = Number(vanilla);
          inv.hazelnut_level = Number(hazelnut);
          inv.irish_level = Number(irish);
          inv.mocha_level = Number(mocha);
          inv.water_level = Number(water);
          inv.updated_at = updatedAt || new Date().toISOString();
        }
      } else if (query.includes('milk_level = 100') && query.includes('coffee_level = 100')) {
        const machineId = params[params.length - 1];
        const inv = mockStore.inventory.find(i => i.machine_id === machineId);
        if (inv) {
          inv.milk_level = 100;
          inv.coffee_level = 100;
          inv.vanilla_level = 100;
          inv.hazelnut_level = 100;
          inv.irish_level = 100;
          inv.mocha_level = 100;
          inv.water_level = 100;
          inv.updated_at = new Date().toISOString();
        }
      } else if (query.includes('water_level = water_level - ?')) {
        const [water, coffee, milk, vanilla, hazelnut, irish, mocha] = params;
        const machineId = params[params.length - 1];
        const passedUpdatedAt = params.length >= 9 ? params[7] : null;
        const inv = mockStore.inventory.find(i => i.machine_id === machineId);
        if (inv) {
          inv.water_level -= water;
          inv.coffee_level -= coffee;
          inv.milk_level -= milk;
          inv.vanilla_level -= vanilla;
          inv.hazelnut_level -= hazelnut;
          inv.irish_level -= irish;
          inv.mocha_level -= mocha;
          inv.updated_at = passedUpdatedAt || new Date().toISOString();
        }
      } else {
        const machineId = params[params.length - 1];
        const passedUpdatedAt = params.length >= 2 ? params[0] : null;
        const inv = mockStore.inventory.find(i => i.machine_id === machineId);
        if (inv) {
          const match = query.match(/update inventory set (\w+_level) = 100/);
          if (match) {
            const field = match[1];
            (inv as any)[field] = 100;
            inv.updated_at = passedUpdatedAt || new Date().toISOString();
          }
        }
      }
      return { changes: 1 };
    }

    if (query.includes('delete from machine_products')) {
      if (query.includes('where machine_id = ? and product_id = ?')) {
        const [machineId, productId] = params;
        mockStore.machine_products = mockStore.machine_products.filter(
          mp => !(mp.machine_id === machineId && mp.product_id === Number(productId))
        );
      } else if (query.includes('where machine_id = ?')) {
        const [machineId] = params;
        mockStore.machine_products = mockStore.machine_products.filter(
          mp => mp.machine_id !== machineId
        );
      } else {
        mockStore.machine_products = [];
      }
      return { changes: 1 };
    }

    if (query.includes('insert into machine_products') || query.includes('replace into machine_products')) {
      const [machine_id, product_id, price, is_available, updated_at] = params;
      const existing = mockStore.machine_products.find(
        mp => mp.machine_id === machine_id && mp.product_id === Number(product_id)
      );
      if (existing) {
        existing.price = Number(price);
        existing.is_available = Number(is_available);
        existing.updated_at = updated_at || new Date().toISOString();
      } else {
        mockStore.machine_products.push({
          machine_id,
          product_id: Number(product_id),
          price: Number(price),
          is_available: Number(is_available),
          updated_at: updated_at || new Date().toISOString()
        });
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
    
    if (query.includes('update machines set')) {
      const id = params[params.length - 1];
      const mach = mockStore.machines.find(m => m.id === id);
      if (mach) {
        if (query.includes('desired_mode = ?') && query.includes('status = ?') && query.includes('last_seen = ?') && query.includes('owner_id = ?')) {
          const [machine_name, location, desired_mode, status, last_seen, kiosk_token, owner_id, updated_at] = params;
          mach.machine_name = machine_name ?? mach.machine_name;
          mach.location = location ?? mach.location;
          mach.desired_mode = desired_mode;
          mach.status = status;
          mach.last_seen = last_seen ?? mach.last_seen;
          if (kiosk_token !== undefined && kiosk_token !== null) {
            mach.kiosk_token = kiosk_token;
          }
          mach.owner_id = owner_id !== undefined ? (owner_id ? String(owner_id) : null) : mach.owner_id;
          mach.updated_at = updated_at || new Date().toISOString();
        } else if (query.includes('desired_mode = ?') && query.includes('status = ?')) {
          const [desired_mode, status, updated_at] = params;
          mach.desired_mode = desired_mode;
          mach.status = status;
          if (updated_at && updated_at !== id) {
            mach.updated_at = updated_at;
          }
        } else if (query.includes('last_seen = ?') && !query.includes('status = ?')) {
          mach.last_seen = params[0];
        } else if (query.includes('owner_id = ?')) {
          mach.owner_id = params[0] !== null && params[0] !== undefined && String(params[0]).trim() !== '' ? String(params[0]).trim() : null;
          if (params.length >= 3) {
            mach.updated_at = params[1];
          }
        } else if (query.includes('status = ?')) {
          const status = params[0];
          mach.status = status;
          mach.desired_mode = status === 'maintenance' ? 'MAINTENANCE' : 'RUNNING';
        } else if (query.includes('kiosk_token = ?')) {
          mach.kiosk_token = params[0];
        }
      }
      return { changes: mach ? 1 : 0 };
    }

    if (query.includes('delete from machines')) {
      if (query.includes('where id = ?')) {
        const idx = mockStore.machines.findIndex(m => m.id === params[0]);
        if (idx >= 0) {
          mockStore.machines.splice(idx, 1);
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      const deleted = mockStore.machines.length;
      mockStore.machines = [];
      return { changes: deleted };
    }

    if (query.includes('delete from inventory')) {
      if (query.includes('where machine_id = ?')) {
        const before = mockStore.inventory.length;
        mockStore.inventory = mockStore.inventory.filter(i => i.machine_id !== params[0]);
        return { changes: before - mockStore.inventory.length };
      }
      const deleted = mockStore.inventory.length;
      mockStore.inventory = [];
      return { changes: deleted };
    }

    if (query.includes('insert into machines') || query.includes('insert or ignore into machines')) {
      const [id, machine_name, location, status, last_seen, kiosk_token, desired_mode, owner_id, updated_at] = params;
      if (mockStore.machines.some(m => m.id === id)) {
        if (!query.includes('insert or ignore')) {
          throw new Error(`SQLITE_CONSTRAINT: UNIQUE constraint failed: machines.id (${id})`);
        }
        return { lastID: id, changes: 0 };
      }
      const resolvedDesiredMode: 'RUNNING' | 'MAINTENANCE' =
        desired_mode === 'MAINTENANCE' || status === 'maintenance' ? 'MAINTENANCE' : 'RUNNING';
      mockStore.machines.push({
        id,
        machine_name,
        location,
        desired_mode: resolvedDesiredMode,
        status: resolvedDesiredMode === 'MAINTENANCE' ? 'maintenance' : 'online',
        last_seen: last_seen || null,
        kiosk_token: kiosk_token || null,
        owner_id: owner_id !== undefined && owner_id !== null && String(owner_id).trim() !== '' ? String(owner_id).trim() : null,
        updated_at: updated_at || new Date().toISOString()
      });
      return { lastID: id };
    }

    if (query.includes('insert into inventory') || query.includes('insert or ignore into inventory')) {
      const [machine_id, updated_at] = params;
      if (!mockStore.inventory.some(i => i.machine_id === machine_id)) {
        mockStore.inventory.push({
          id: mockStore.inventory.length + 1,
          machine_id,
          milk_level: 100,
          coffee_level: 100,
          vanilla_level: 100,
          hazelnut_level: 100,
          irish_level: 100,
          mocha_level: 100,
          water_level: 100,
          updated_at: updated_at || '2026-01-01T00:00:00.000Z'
        });
      }
      return { lastID: mockStore.inventory.length };
    }
    
    return { lastID: null, changes: 0 };
  }
}

let db: any;
let initPromise: Promise<any> | null = null;

export async function initDB(): Promise<any> {
  if (process.env.VERCEL) {
    db = new MockDatabase();
    return db;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const dbPath = path.resolve(__dirname, '../../caffix.db');

    db = await sqliteOpen({
      filename: dbPath,
      driver: sqlite3.Database
    });

    // Enable foreign keys and busy timeout for multi-process concurrency
    await db.run('PRAGMA foreign_keys = ON');
    await db.run('PRAGMA busy_timeout = 5000');

    // Create Users table with stable TEXT PRIMARY KEY (supports UUIDs 'usr_...' and legacy '1'/'2')
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'kiosk', 'owner')),
        setup_token_hash TEXT,
        setup_token_expires_at TEXT,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      )
    `);

    // Migrate existing users table if id was INTEGER or role CHECK lacked 'owner'
    try {
      const userTableMaster = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
      const userTableInfo = await db.all("PRAGMA table_info(users)");
      const idCol = userTableInfo.find((col: any) => col.name === 'id');
      const needsTableRebuild =
        (userTableMaster?.sql && !userTableMaster.sql.includes("'owner'")) ||
        (idCol && String(idCol.type).toUpperCase().includes('INT'));

      if (needsTableRebuild) {
        await db.run('PRAGMA foreign_keys = OFF');
        const hasSetupHash = userTableInfo.some((col: any) => col.name === 'setup_token_hash');
        await db.exec(`
          DROP TABLE IF EXISTS users_new;
          CREATE TABLE users_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'kiosk', 'owner')),
            setup_token_hash TEXT,
            setup_token_expires_at TEXT,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT
          );
        `);
        if (hasSetupHash) {
          await db.exec(`
            INSERT INTO users_new (id, name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at)
            SELECT CAST(id AS TEXT), name, LOWER(email), password, role, setup_token_hash, setup_token_expires_at, COALESCE(must_change_password, 0), updated_at FROM users;
          `);
        } else {
          await db.exec(`
            INSERT INTO users_new (id, name, email, password, role)
            SELECT CAST(id AS TEXT), name, LOWER(email), password, role FROM users;
          `);
        }
        await db.exec(`
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
        await db.run('PRAGMA foreign_keys = ON');
      } else {
        if (!userTableInfo.some((col: any) => col.name === 'setup_token_hash')) {
          await db.exec('ALTER TABLE users ADD COLUMN setup_token_hash TEXT;');
        }
        if (!userTableInfo.some((col: any) => col.name === 'setup_token_expires_at')) {
          await db.exec('ALTER TABLE users ADD COLUMN setup_token_expires_at TEXT;');
        }
        if (!userTableInfo.some((col: any) => col.name === 'must_change_password')) {
          await db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;');
        }
        if (!userTableInfo.some((col: any) => col.name === 'updated_at')) {
          await db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT;');
        }
      }
    } catch (err) {
      console.error('Database migration check for users failed:', err);
    }

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

  // Create Machines table with separate desired_mode, nullable last_seen, and TEXT owner_id
  await db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      machine_name TEXT NOT NULL,
      location TEXT,
      desired_mode TEXT NOT NULL DEFAULT 'RUNNING' CHECK(desired_mode IN ('RUNNING', 'MAINTENANCE')),
      status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'maintenance')),
      last_seen TEXT,
      kiosk_token TEXT,
      owner_id TEXT,
      updated_at TEXT
    )
  `);

  // Run dynamic schema migration check for machines table
  try {
    const machTableInfo = await db.all("PRAGMA table_info(machines)");
    if (!machTableInfo.some((col: any) => col.name === 'kiosk_token')) {
      await db.exec('ALTER TABLE machines ADD COLUMN kiosk_token TEXT;');
    }
    if (!machTableInfo.some((col: any) => col.name === 'desired_mode')) {
      await db.exec("ALTER TABLE machines ADD COLUMN desired_mode TEXT NOT NULL DEFAULT 'RUNNING';");
      await db.exec("UPDATE machines SET desired_mode = CASE WHEN status = 'maintenance' THEN 'MAINTENANCE' ELSE 'RUNNING' END;");
    }
    if (!machTableInfo.some((col: any) => col.name === 'owner_id')) {
      await db.exec('ALTER TABLE machines ADD COLUMN owner_id TEXT;');
    }
    if (!machTableInfo.some((col: any) => col.name === 'updated_at')) {
      await db.exec('ALTER TABLE machines ADD COLUMN updated_at TEXT;');
    }
  } catch (err) {
    console.error('Database migration check for machines failed:', err);
  }

  // Create Per-Machine Products table (independent pricing & availability per machine)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS machine_products (
      machine_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      price INTEGER NOT NULL DEFAULT 100,
      is_available INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (machine_id, product_id),
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
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
      irish_level INTEGER NOT NULL DEFAULT 100,
      mocha_level INTEGER NOT NULL DEFAULT 100,
      water_level INTEGER NOT NULL DEFAULT 100,
      updated_at TEXT,
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
      extra_sugar INTEGER DEFAULT 0,
      base TEXT DEFAULT 'water',
      dispense_status TEXT DEFAULT 'PENDING',
      customer_name TEXT,
      customer_email TEXT,
      updated_at TEXT,
      dispensed_at TEXT,
      dispense_started_at TEXT,
      refund_status TEXT DEFAULT 'NONE' CHECK(refund_status IN ('NONE', 'PENDING', 'PARTIAL', 'FULL', 'FAILED')),
      total_refunded_amount_paise INTEGER DEFAULT 0,
      pending_refund_amount_paise INTEGER DEFAULT 0,
      last_refunded_at TEXT,
      captured_amount_paise INTEGER DEFAULT NULL,
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
    const hasExtraSugar = tableInfo.some((col: any) => col.name === 'extra_sugar');
    if (!hasExtraSugar) {
      await db.exec(`
        ALTER TABLE orders ADD COLUMN extra_sugar INTEGER DEFAULT 0;
      `);
    }
    const hasBase = tableInfo.some((col: any) => col.name === 'base');
    if (!hasBase) {
      await db.exec(`
        ALTER TABLE orders ADD COLUMN base TEXT DEFAULT 'water';
      `);
    }
    const hasDispenseStatus = tableInfo.some((col: any) => col.name === 'dispense_status');
    if (!hasDispenseStatus) {
      await db.exec(`
        ALTER TABLE orders ADD COLUMN dispense_status TEXT DEFAULT 'PENDING';
      `);
    }
    const hasCustomerName = tableInfo.some((col: any) => col.name === 'customer_name');
    if (!hasCustomerName) {
      await db.exec(`
        ALTER TABLE orders ADD COLUMN customer_name TEXT;
        ALTER TABLE orders ADD COLUMN customer_email TEXT;
      `);
    }
    const hasUpdatedAt = tableInfo.some((col: any) => col.name === 'updated_at');
    if (!hasUpdatedAt) {
      await db.exec(`
        ALTER TABLE orders ADD COLUMN updated_at TEXT;
        ALTER TABLE orders ADD COLUMN dispensed_at TEXT;
        ALTER TABLE orders ADD COLUMN dispense_started_at TEXT;
      `);
    }
    if (!tableInfo.some((col: any) => col.name === 'refund_status')) {
      await db.exec(
        "ALTER TABLE orders ADD COLUMN refund_status TEXT DEFAULT 'NONE' CHECK(refund_status IN ('NONE', 'PENDING', 'PARTIAL', 'FULL', 'FAILED'));"
      );
    }
    if (!tableInfo.some((col: any) => col.name === 'total_refunded_amount_paise')) {
      await db.exec(
        "ALTER TABLE orders ADD COLUMN total_refunded_amount_paise INTEGER DEFAULT 0;"
      );
    }
    if (!tableInfo.some((col: any) => col.name === 'pending_refund_amount_paise')) {
      await db.exec(
        "ALTER TABLE orders ADD COLUMN pending_refund_amount_paise INTEGER DEFAULT 0;"
      );
    }
    if (!tableInfo.some((col: any) => col.name === 'last_refunded_at')) {
      await db.exec(
        "ALTER TABLE orders ADD COLUMN last_refunded_at TEXT;"
      );
    }
    if (!tableInfo.some((col: any) => col.name === 'captured_amount_paise')) {
      await db.exec(
        "ALTER TABLE orders ADD COLUMN captured_amount_paise INTEGER DEFAULT NULL;"
      );
    }
  } catch (err) {
    console.error('Database migration check failed:', err);
  }

  // Analytics indexes for orders (Phase 2.9)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_analytics ON orders(machine_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  `);

  // Create Refunds table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      razorpay_payment_id TEXT NOT NULL,
      razorpay_refund_id TEXT,
      amount_paise INTEGER NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'PROCESSED', 'FAILED')),
      reason TEXT NOT NULL,
      notes TEXT,
      initiated_by TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('SUPER_ADMIN_PORTAL', 'RAZORPAY_DASHBOARD', 'RECONCILIATION')),
      idempotency_key TEXT UNIQUE NOT NULL,
      error_code TEXT,
      error_description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_at TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    )
  `);

  // Indexes for refunds
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON refunds(order_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_machine_id ON refunds(machine_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_razorpay_refund_id ON refunds(razorpay_refund_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
    CREATE INDEX IF NOT EXISTS idx_refunds_status_created_at ON refunds(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_refunds_machine_status_created_at ON refunds(machine_id, status, created_at);
  `);

  // Create Webhook Events Ledger table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      order_id TEXT,
      payment_id TEXT,
      refund_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED')),
      payload TEXT,
      error_message TEXT,
      lease_expires_at TEXT,
      claim_count INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      processed_at TEXT,
      UNIQUE(provider, event_id)
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_event_id ON webhook_events(provider, event_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_order_id ON webhook_events(order_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_payment_id ON webhook_events(payment_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_refund_id ON webhook_events(refund_id);
  `);

  // Run dynamic schema migration check for webhook_events table
  try {
    const whTableInfo = await db.all("PRAGMA table_info(webhook_events)");
    if (!whTableInfo.some((col: any) => col.name === 'lease_expires_at')) {
      await db.exec('ALTER TABLE webhook_events ADD COLUMN lease_expires_at TEXT;');
    }
    if (!whTableInfo.some((col: any) => col.name === 'claim_count')) {
      await db.exec('ALTER TABLE webhook_events ADD COLUMN claim_count INTEGER DEFAULT 1;');
    }
    if (!whTableInfo.some((col: any) => col.name === 'updated_at')) {
      await db.exec('ALTER TABLE webhook_events ADD COLUMN updated_at TEXT;');
    }
  } catch (err) {
    console.error('Database migration check for webhook_events failed:', err);
  }

  // Run dynamic schema migration check for inventory table
  try {
    const invTableInfo = await db.all("PRAGMA table_info(inventory)");
    if (!invTableInfo.some((col: any) => col.name === 'irish_level')) {
      await db.exec('ALTER TABLE inventory ADD COLUMN irish_level INTEGER NOT NULL DEFAULT 100;');
    }
    if (!invTableInfo.some((col: any) => col.name === 'mocha_level')) {
      await db.exec('ALTER TABLE inventory ADD COLUMN mocha_level INTEGER NOT NULL DEFAULT 100;');
    }
    if (!invTableInfo.some((col: any) => col.name === 'updated_at')) {
      await db.exec('ALTER TABLE inventory ADD COLUMN updated_at TEXT;');
    }
  } catch (err) {
    console.error('Database migration check for inventory failed:', err);
  }

  // Auditable Inventory Ledger Schema (Phase 2.8)
  try {
    await initializeInventoryLedgerSchema(db);
  } catch (err) {
    console.error('Database migration check for inventory_ledger failed:', err);
  }

    // Seed default data if empty
    await seedData();

    // Ensure default products are set to 100
    try {
      await db.run('UPDATE products SET price = 100 WHERE id IN (1, 2, 3, 4, 5)');
    } catch (err) {
      console.error('Failed to update product prices to 100:', err);
    }

    return db;
  })();

  return initPromise;
}

export function getDB(): any {
  if (process.env.VERCEL && !(db instanceof MockDatabase)) {
    db = new MockDatabase();
  }
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
      'INSERT INTO users (id, name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['1', 'Caffix Manager', 'admin@caffix.com', adminHash, 'admin', null, null, 0, '2026-01-01T00:00:00.000Z']
    );
    await db.run(
      'INSERT INTO users (id, name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['2', 'kiosk-one', 'kiosk01@caffix.com', kioskHash, 'kiosk', null, null, 0, '2026-01-01T00:00:00.000Z']
    );
  }

  // 2. Seed Products
  const productCount = await db.get('SELECT COUNT(*) as count FROM products');
  if (productCount && productCount.count === 0) {
    await db.run(
      'INSERT INTO products (id, name, price, description, image) VALUES (?, ?, ?, ?, ?)',
      [1, 'Classic Crest', 100, 'Some coffees need a personality. Ours has 100% Arabica.', '/assets/classic_coffee.png']
    );
    await db.run(
      'INSERT INTO products (id, name, price, description, image) VALUES (?, ?, ?, ?, ?)',
      [2, 'Vanilla Velvet', 100, 'Some people meditate. We made vanilla coffee', '/assets/vanilla_coffee.png']
    );
    await db.run(
      'INSERT INTO products (id, name, price, description, image) VALUES (?, ?, ?, ?, ?)',
      [3, 'Hazel Gold', 100, 'Your life deserves a little golden treatment. Meet Hazel Gold', '/assets/hazelnut_coffee.png']
    );
  }

  // Ensure existing product names and descriptions are updated to match new names
  try {
    await db.run("UPDATE products SET name = 'Classic Crest', description = 'Some coffees need a personality. Ours has 100% Arabica.' WHERE id = 1");
    await db.run("UPDATE products SET name = 'Vanilla Velvet', description = 'Some people meditate. We made vanilla coffee' WHERE id = 2");
    await db.run("UPDATE products SET name = 'Hazel Gold', description = 'Your life deserves a little golden treatment. Meet Hazel Gold' WHERE id = 3");
    await db.run("UPDATE products SET name = 'Irish Emerald', description = 'Bold enough to feel illegal All the Irish attitude' WHERE id = 4");
    await db.run("UPDATE products SET name = 'Mocha Bliss', description = 'Coffee with dessert energy = mocha bliss' WHERE id = 5");
  } catch (err) {
    console.error('Failed to update product names/descriptions in database:', err);
  }

  // Seed new products dynamically if they do not exist
  const hasIrishProd = await db.get('SELECT id FROM products WHERE id = 4');
  if (!hasIrishProd) {
    await db.run(
      'INSERT INTO products (id, name, price, description, image) VALUES (?, ?, ?, ?, ?)',
      [4, 'Irish Emerald', 100, 'Bold enough to feel illegal All the Irish attitude', '/assets/irish_coffee.png']
    );
  }

  const hasMochaProd = await db.get('SELECT id FROM products WHERE id = 5');
  if (!hasMochaProd) {
    await db.run(
      'INSERT INTO products (id, name, price, description, image) VALUES (?, ?, ?, ?, ?)',
      [5, 'Mocha Bliss', 100, 'Coffee with dessert energy = mocha bliss', '/assets/mocha_coffee.png']
    );
  }

  // 3. Seed Machines & 4. Seed Inventory (for all default and env-configured machines)
  // Note: last_seen is initialized as empty string '' (null in API responses) so machines do not falsely appear ONLINE before a real RPi heartbeat
  const seeds = getConfiguredMachineSeeds();
  for (let i = 0; i < seeds.length; i++) {
    const m = seeds[i];
    const existingMachine = await db.get('SELECT id, kiosk_token FROM machines WHERE id = ?', [m.id]);
    if (!existingMachine) {
      await db.run(
        'INSERT INTO machines (id, machine_name, location, status, last_seen, kiosk_token, desired_mode, owner_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [m.id, m.machine_name, i === 0 ? 'Delhi Airport T3' : m.location, 'online', '', m.kiosk_token, 'RUNNING', null, '2026-01-01T00:00:00.000Z']
      );
    } else if (m.kiosk_token && existingMachine.kiosk_token !== m.kiosk_token) {
      await db.run('UPDATE machines SET kiosk_token = ? WHERE id = ?', [m.kiosk_token, m.id]);
    }

    const existingInv = await db.get('SELECT id FROM inventory WHERE machine_id = ?', [m.id]);
    if (!existingInv) {
      const levels = i === 0 ? [92, 78, 65, 55, 60, 50, 85] : [100, 100, 100, 100, 100, 100, 100];
      await db.run(
        'INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, irish_level, mocha_level, water_level, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [m.id, ...levels, '2026-01-01T00:00:00.000Z']
      );
    }
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
