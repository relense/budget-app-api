import type { BudgetType, Direction } from '../categories/categoryService.js';

export interface DefaultCategory {
  name: string;
  icon: string;
  color: string;
  budgetType: BudgetType;
  direction: Direction;
}

/** Seeded into every new user's catalog on signup — see docs/PROGRESS.md. */
export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: 'Supermarket', icon: 'cart', color: '#D2FFD8', budgetType: 'need', direction: 'expense' },
  { name: 'Eating Out', icon: 'utensils', color: '#FFCCDB', budgetType: 'want', direction: 'expense' },
  { name: 'Gas/Transport', icon: 'car', color: '#D2FFD8', budgetType: 'need', direction: 'expense' },
  { name: 'Health', icon: 'heart', color: '#D6E3FC', budgetType: 'need', direction: 'expense' },
  { name: 'Hobbies', icon: 'gamepad', color: '#FFCCDB', budgetType: 'want', direction: 'expense' },
];
