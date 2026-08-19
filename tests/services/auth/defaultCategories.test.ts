import { describe, expect, it } from '@jest/globals';
import { assertValidBudgetType } from '../../../src/services/categories/categoryService.js';
import { DEFAULT_CATEGORIES } from '../../../src/services/auth/defaultCategories.js';

describe('DEFAULT_CATEGORIES', () => {
  it.each(DEFAULT_CATEGORIES)(
    '$name passes categoryService\'s validation rules',
    (category) => {
      // Seeding bypasses createCategory (a bulk createMany, not one create
      // call per row), so this is the only thing that would catch a future
      // categoryService validation rule this fixed list stops satisfying.
      expect(() => assertValidBudgetType(category.direction, category.budgetType)).not.toThrow();
    },
  );
});
