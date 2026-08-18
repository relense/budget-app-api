import { describe, expect, it } from '@jest/globals';
import { createRecurringExpenseTemplateService } from './recurringExpenseTemplateService.js';
import { createFakePrisma } from './testFakePrisma.js';

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
      deletedAt: null,
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
});

describe('deleteTemplate', () => {
  it('soft-deletes a template with no instances', async () => {
    const { prisma, service } = setup();
    const template = await service.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: 'cat-housing',
      budgetType: 'need',
      dueDay: 1,
    });

    await service.deleteTemplate('user-1', template.id);

    expect(prisma.recurringExpenseTemplates[0]!.deletedAt).not.toBeNull();
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
});

describe('listCatalog', () => {
  it('returns only the user\'s non-deleted templates', async () => {
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
