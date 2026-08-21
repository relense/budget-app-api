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
  { name: 'Supermarket', icon: 'cart', color: '#CEF3C8', budgetType: 'need', direction: 'expense' },
  { name: 'Eating Out', icon: 'utensils', color: '#F3D9C8', budgetType: 'want', direction: 'expense' },
  { name: 'Gas/Transport', icon: 'car', color: '#DEF3C8', budgetType: 'need', direction: 'expense' },
  { name: 'Health', icon: 'heart', color: '#F3C8C8', budgetType: 'need', direction: 'expense' },
  { name: 'Hobbies', icon: 'gamepad', color: '#F3C8E9', budgetType: 'want', direction: 'expense' },
];
