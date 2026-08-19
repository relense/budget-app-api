import { describe, expect, it } from '@jest/globals';
import { createRecurringExpenseTemplateService } from './recurringExpenseTemplateService.js';
import { createFakePrisma } from '../categories/testFakePrisma.js';

function setup() {
  const prisma = createFakePrisma();
  const service = createRecurringExpenseTemplateService({ prisma: prisma as never });

  prisma.categories.push({
    id: 'cat-housing',
    userId: 'user-1',
    name: 'Housing',
    icon: 'home',
    color: '#000',
    budgetType: 'need',
    direction: 'expense',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  prisma.categories.push({
    id: 'cat-other-user',
    userId: 'user-2',
    name: 'Other',
    icon: 'x',
    color: '#000',
    budgetType: 'need',
    direction: 'expense',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { prisma, service };
}

describe('createTemplate', () => {
  it('creates a template for an owned category', async () => {
    const { prisma, service } = setup();

    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });

    expect(prisma.recurringExpenseTemplates).toHaveLength(1);
    expect(template).toMatchObject({
      userId: 'user-1',
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });
  });

  it('throws category_not_found for a category belonging to another user', async () => {
    const { service } = setup();

    await expect(
      service.createTemplate('user-1', {
        name: 'Rent',
        amountCents: 80000,
        categoryId: 'cat-other-user',
        budgetType: 'need',
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });

  it('rejects a non-positive amountCents', async () => {
    const { service } = setup();

    await expect(
      service.createTemplate('user-1', {
        name: 'Rent',
        amountCents: 0,
        categoryId: 'cat-housing',
        budgetType: 'need',
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it.each([0, 32, 1.5])('rejects an invalid dueDay of %p', async (dueDay) => {
    const { service } = setup();

    await expect(
      service.createTemplate('user-1', {
        name: 'Rent',
        amountCents: 80000,
        categoryId: 'cat-housing',
        budgetType: 'need',
        dueDay,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_due_day' });
  });

  it('rejects a budgetType of savings — not meaningful for a recurring obligation', async () => {
    const { service } = setup();

    await expect(
      service.createTemplate('user-1', {
        name: 'Rent',
        amountCents: 80000,
        categoryId: 'cat-housing',
        budgetType: 'savings' as never,
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_budget_type' });
  });
});

describe('updateTemplate', () => {
  it('updates template fields', async () => {
    const { service } = setup();
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });

    const updated = await service.updateTemplate('user-1', template.id, {
      name: 'Rent (updated)',
      amountCents: 85000,
      categoryId: 'cat-housing',
      budgetType: 'want',
      dueDay: 5,
    });

    expect(updated).toMatchObject({
      name: 'Rent (updated)',
      amountCents: 85000,
      budgetType: 'want',
      dueDay: 5,
    });
  });

  it('throws template_not_found for another user\'s template', async () => {
    const { service } = setup();
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });

    await expect(
      service.updateTemplate('user-2', template.id, {
        name: 'Rent',
        amountCents: 80000,
        categoryId: 'cat-housing',
        budgetType: 'need',
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'template_not_found' });
  });

  it('allows a categoryId change while no instance exists yet', async () => {
    const { prisma, service } = setup();
    prisma.categories.push({
      id: 'cat-transport',
      userId: 'user-1',
      name: 'Transport',
      icon: 'car',
      color: '#000',
      budgetType: 'need',
      direction: 'expense',
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });

    const updated = await service.updateTemplate('user-1', template.id, {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-transport',
      budgetType: 'need',
      dueDay: 1,
    });

    expect(updated.categoryId).toBe('cat-transport');
  });

  it('rejects a categoryId change once an instance exists — would retroactively shift recurringCommittedCents for past months', async () => {
    const { prisma, service } = setup();
    prisma.categories.push({
      id: 'cat-transport',
      userId: 'user-1',
      name: 'Transport',
      icon: 'car',
      color: '#000',
      budgetType: 'need',
      direction: 'expense',
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });
    prisma.recurringExpenseInstances.push({
      id: 'inst-1',
      userId: 'user-1',
      templateId: template.id,
      monthId: 'month-1',
      amountCents: 80000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.updateTemplate('user-1', template.id, {
        name: 'Rent',
        amountCents: 80000,
        categoryId: 'cat-transport',
        budgetType: 'need',
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'category_change_blocked' });
    expect(prisma.recurringExpenseTemplates[0]!.categoryId).toBe('cat-housing');
  });

  it('allows updating other fields while keeping the same categoryId, even with instances', async () => {
    const { prisma, service } = setup();
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });
    prisma.recurringExpenseInstances.push({
      id: 'inst-1',
      userId: 'user-1',
      templateId: template.id,
      monthId: 'month-1',
      amountCents: 80000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const updated = await service.updateTemplate('user-1', template.id, {
      name: 'Rent (updated)',
      amountCents: 85000,
      categoryId: 'cat-housing',
      budgetType: 'want',
      dueDay: 5,
    });

    expect(updated).toMatchObject({ name: 'Rent (updated)', amountCents: 85000, budgetType: 'want' });
  });

  it('rejects a budgetType of savings — not meaningful for a recurring obligation', async () => {
    const { service } = setup();
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });

    await expect(
      service.updateTemplate('user-1', template.id, {
        name: 'Rent',
        amountCents: 80000,
        categoryId: 'cat-housing',
        budgetType: 'savings' as never,
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_budget_type' });
  });
});

describe('deleteTemplate', () => {
  it('hard-deletes a template with no instances', async () => {
    const { prisma, service } = setup();
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });

    await service.deleteTemplate('user-1', template.id);

    expect(prisma.recurringExpenseTemplates).toHaveLength(0);
  });

  it('throws template_has_active_instances when an instance exists', async () => {
    const { prisma, service } = setup();
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });
    prisma.recurringExpenseInstances.push({
      id: 'inst-1',
      userId: 'user-1',
      templateId: template.id,
      monthId: 'month-1',
      amountCents: 80000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.deleteTemplate('user-1', template.id)).rejects.toMatchObject({
      reason: 'template_has_active_instances',
    });
  });

  it('throws template_has_active_instances (not a raw FK error) when an instance is created between the check and the delete', async () => {
    const { prisma, service } = setup();
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });

    // Simulate the race: the "no instances" check reports none (as if it
    // ran a moment before the concurrent insert), but an instance lands in
    // the table right after — the fake's delete() enforces
    // onDelete: Restrict just like the real DB, so this exercises the same
    // path a concurrent request would hit.
    prisma.recurringExpenseInstance.findFirst = (async () => {
      prisma.recurringExpenseInstances.push({
        id: 'inst-race',
        userId: 'user-1',
        templateId: template.id,
        monthId: 'month-race',
        amountCents: 80000,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return null;
    }) as typeof prisma.recurringExpenseInstance.findFirst;

    await expect(service.deleteTemplate('user-1', template.id)).rejects.toMatchObject({
      reason: 'template_has_active_instances',
    });
    expect(prisma.recurringExpenseTemplates).toHaveLength(1);
  });
});

describe('listCatalog', () => {
  it('excludes deleted templates', async () => {
    const { service } = setup();
    const mine = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });
    const deleted = await service.createTemplate('user-1', {
      name: 'Old',
      amountCents: 1000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });
    await service.deleteTemplate('user-1', deleted.id);

    const result = await service.listCatalog('user-1');

    expect(result.map((t) => t.id)).toEqual([mine.id]);
  });
});
