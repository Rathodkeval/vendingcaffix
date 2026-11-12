import { BadRequestError } from './errors';

export interface IngredientRequirements {
  water: number;
  coffee: number;
  milk: number;
  vanilla: number;
  hazelnut: number;
  irish: number;
  mocha: number;
}

export interface InventoryLevels {
  water_level: number;
  coffee_level: number;
  milk_level: number;
  vanilla_level: number;
  hazelnut_level: number;
  irish_level: number;
  mocha_level: number;
}

const INVENTORY_CHECKS: Array<{
  reqKey: keyof IngredientRequirements;
  invKey: keyof InventoryLevels;
  message: string;
}> = [
  { reqKey: 'water', invKey: 'water_level', message: 'Ingredients depleted: Water refill required' },
  { reqKey: 'coffee', invKey: 'coffee_level', message: 'Ingredients depleted: Coffee beans refill required' },
  { reqKey: 'milk', invKey: 'milk_level', message: 'Ingredients depleted: Milk refill required' },
  { reqKey: 'vanilla', invKey: 'vanilla_level', message: 'Ingredients depleted: Vanilla syrup refill required' },
  { reqKey: 'hazelnut', invKey: 'hazelnut_level', message: 'Ingredients depleted: Hazelnut syrup refill required' },
  { reqKey: 'irish', invKey: 'irish_level', message: 'Ingredients depleted: Irish syrup refill required' },
  { reqKey: 'mocha', invKey: 'mocha_level', message: 'Ingredients depleted: Mocha syrup refill required' }
];

/**
 * Computes the exact per-cup ingredient requirements for a beverage name.
 */
export function getProductIngredientRequirements(productName: string): IngredientRequirements {
  const lowerName = (productName || '').toLowerCase();
  const requirements: IngredientRequirements = {
    water: 5,
    coffee: 6,
    milk: 5,
    vanilla: 0,
    hazelnut: 0,
    irish: 0,
    mocha: 0
  };

  if (lowerName.includes('vanilla')) {
    requirements.vanilla = 8;
  } else if (lowerName.includes('hazel')) {
    requirements.hazelnut = 8;
  } else if (lowerName.includes('irish')) {
    requirements.irish = 8;
  } else if (lowerName.includes('mocha')) {
    requirements.mocha = 8;
  }

  return requirements;
}

/**
 * Verifies that machine inventory levels satisfy the ingredient requirements
 * for the requested product, throwing BadRequestError with the canonical
 * depletion message when any required ingredient is insufficient.
 */
export function assertSufficientInventory(
  inventory: Partial<InventoryLevels> | null | undefined,
  productName: string,
  machineId?: string
): IngredientRequirements {
  if (!inventory) {
    throw new BadRequestError(
      machineId
        ? `Inventory record not found for machine ${machineId}`
        : 'Inventory record not found'
    );
  }

  const requirements = getProductIngredientRequirements(productName);
  for (const check of INVENTORY_CHECKS) {
    const needed = requirements[check.reqKey];
    if (needed > 0 && Number(inventory[check.invKey] ?? 0) < needed) {
      throw new BadRequestError(check.message);
    }
  }

  return requirements;
}
