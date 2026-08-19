import type { BudgetType, Direction } from '../categories/categoryService.js';

export interface DefaultCategory {
  name: string;
  icon: string;
  color: string;
  budgetType: BudgetType;
  direction: Direction;
}

/** Seeded into every new user's catalog on signup — see PROGRESS.md. */
export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: 'Supermarket', icon: 'cart', color: '#4CAF50', budgetType: 'need', direction: 'expense' },
  { name: 'Eating Out', icon: 'utensils', color: '#FF9800', budgetType: 'want', direction: 'expense' },
  { name: 'Gas/Transport', icon: 'car', color: '#2196F3', budgetType: 'need', direction: 'expense' },
  { name: 'Health', icon: 'heart', color: '#F44336', budgetType: 'need', direction: 'expense' },
  { name: 'Hobbies', icon: 'gamepad', color: '#9C27B0', budgetType: 'want', direction: 'expense' },
];
