import { describe, expect, it } from 'vitest'
import { type CatalogueEntry, collectionOf, roleMenu } from '../src/role-menu.js'

/** A slice of ORYH's `/builtin-object-types`, as it derives it from its own routes. */
const catalogue: CatalogueEntry[] = [
  { object_type: 'invoices', path: '/invoices', also_called: ['invoice'] },
  { object_type: 'payments', path: '/payments', also_called: ['payment'] },
  { object_type: 'employees', path: '/employees', also_called: ['employee', 'staff'] },
  { object_type: 'fin_accounts', path: '/fin-accounts', also_called: ['fin_account'] },
  { object_type: 'pay_histories', path: '/pay-histories', also_called: ['pay_history'] },
  { object_type: 'expense_claims', path: '/expense-claims', also_called: ['expense_claim'] },
  { object_type: 'sales_orders', path: '/sales-orders', also_called: ['order', 'sales_order'] },
]
/** Invoices and payments filter by direction, which is what ORYH scopes invoicing by. */
const declared = async (collection: string) =>
  ['invoices', 'payments'].includes(collection) ? [{ name: 'direction', type: 'string' as const }] : []

describe('the menu a role implies', () => {
  it('gives a finance clerk her invoices, payments, payroll, staff and accounts', async () => {
    // The permissions of the finance employee whose menu had none of this.
    const permissions = [
      'payroll.manage',
      'payroll.read',
      'employees.manage',
      'invoice.manage:payroll',
      'invoice.manage:purchase',
      'invoice.manage:reimbursement',
      'payment.record',
      'payment.apply',
      'fin_account.manage',
      'expense.submit_own',
      'timesheet.submit_own',
    ]
    expect(await roleMenu(permissions, catalogue, declared)).toEqual([
      { collection: 'pay-histories', filters: {}, label: '薪资档案', grants: ['payroll.manage', 'payroll.read'] },
      { collection: 'employees', filters: {}, label: '员工', grants: ['employees.manage'] },
      // Each entry names what implies it, so the page can drop it the moment that grant goes.
      {
        collection: 'invoices',
        filters: { direction: 'payroll' },
        label: '发票·工资条',
        grants: ['invoice.manage:payroll'],
      },
      {
        collection: 'invoices',
        filters: { direction: 'purchase' },
        label: '发票·进项',
        grants: ['invoice.manage:purchase'],
      },
      {
        collection: 'invoices',
        filters: { direction: 'reimbursement' },
        label: '发票·报销',
        grants: ['invoice.manage:reimbursement'],
      },
      { collection: 'payments', filters: {}, label: '收付款', grants: ['payment.record', 'payment.apply'] },
      { collection: 'fin-accounts', filters: {}, label: '资金账户', grants: ['fin_account.manage'] },
    ])
  })

  it('lets a bare grant cover every scope, in either order', async () => {
    for (const permissions of [
      ['invoice.manage:payroll', 'invoice.manage'],
      ['invoice.manage', 'invoice.manage:payroll'],
      ['invoice.manage:*'],
    ])
      expect(await roleMenu(permissions, catalogue, declared)).toEqual([
        { collection: 'invoices', filters: {}, label: '发票', grants: permissions },
      ])
  })

  it('adds nothing for own documents, unknown domains, or a scope that is not a word', async () => {
    expect(
      await roleMenu(
        ['expense.submit_own', 'master_data.manage', 'approval.record', 'invoice.manage:../x', 'nodot'],
        catalogue,
        declared,
      ),
    ).toEqual([])
  })

  it('resolves a domain through the words ORYH says mean a collection, and a few it names differently', () => {
    expect(collectionOf('order', catalogue)).toBe('sales-orders')
    expect(collectionOf('payroll', catalogue)).toBe('pay-histories')
    expect(collectionOf('inventory', catalogue)).toBeUndefined()
  })
})

describe('every system permission ORYH defines', () => {
  /** ORYH's collections, derived the way it derives them from its routes (oryh.cn, 2026-09-21). */
  const full: CatalogueEntry[] = [
    'billing-accounts',
    'business-objects',
    'campaigns',
    'contracts',
    'employee-leaves',
    'employees',
    'expense-claims',
    'fin-accounts',
    'flow-runs',
    'invoices',
    'pay-histories',
    'payments',
    'policies',
    'purchase-orders',
    'purchase-requests',
    'sales-orders',
    'sales-quotations',
    'shipments',
    'skills',
    'timesheet-headers',
    'todos',
  ].map(path => {
    const object_type = path.replace(/-/g, '_')
    const singular = object_type.endsWith('ies') ? `${object_type.slice(0, -3)}y` : object_type.replace(/s$/, '')
    return {
      object_type,
      path: `/${path}`,
      also_called: [
        singular,
        ...(path === 'sales-orders' ? ['order'] : []),
        ...(path === 'sales-quotations' ? ['quotation'] : []),
      ],
    }
  })
  /** `app/core/permissions.py` SYSTEM_CAPABILITIES, all of them. */
  const permissions =
    'approval.record billing_account.manage billing_account.post booking.own business_object.advance business_object.summarize business_object.write campaign.manage contract.manage crm.own crm.read_all employees.manage expense.advance expense.read_all expense.submit_own fin_account.manage flow_run.record inventory.manage invoice.advance invoice.manage keys.manage leave.advance leave.read_all leave.submit_own master_data.manage notification.send object_types.manage order.advance order.read_all order.submit_own payment.advance payment.apply payment.record payroll.manage payroll.read policy.manage policy.publish purchase.advance purchase.read_all purchase.submit_own purchase_order.manage quotation.advance quotation.read_all quotation.submit_own shipment.manage skills.calibrate skills.manage tenant.act_for_any_employee timesheet.advance timesheet.read_all timesheet.submit_own todos.assign todos.complete_own users.manage workflows.publish'.split(
      ' ',
    )

  it('gives business collections and leaves configuration out', async () => {
    const collections = (await roleMenu(permissions, full, async () => [])).map(entry => entry.collection)
    expect(collections).toEqual([
      'billing-accounts',
      'campaigns',
      'contracts',
      'employees',
      'expense-claims',
      'fin-accounts',
      'invoices',
      'employee-leaves',
      'sales-orders',
      'payments',
      'pay-histories',
      'purchase-requests',
      'purchase-orders',
      'sales-quotations',
      'shipments',
      'timesheet-headers',
      'todos',
    ])
    for (const configuration of ['skills', 'policies', 'flow-runs', 'business-objects'])
      expect(collections).not.toContain(configuration)
  })
})
