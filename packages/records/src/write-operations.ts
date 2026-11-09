import { WRITE_PATH_ID as ID, type WriteOperation } from '@oryh/ai-client-foundation'

/**
 * The record writes. Of the lists this domain serves — sales orders, inventory, shipments — only sales
 * orders are written from the client, and both channels may: the workbench's own pages, and a person
 * asking in Chat, which is how a spreadsheet of orders is imported.
 */
export const RECORD_WRITE_OPERATIONS: readonly WriteOperation[] = [
  {
    name: 'sales-order.import',
    label: '批量导入销售订单',
    method: 'POST',
    path: /^\/sales-orders\/bulk$/,
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.create',
    label: '新建销售订单',
    method: 'POST',
    path: /^\/sales-orders$/,
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.update',
    label: '修改销售订单',
    method: 'PATCH',
    path: new RegExp(`^/sales-orders/${ID}$`),
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.delete',
    label: '删除销售订单',
    method: 'DELETE',
    path: new RegExp(`^/sales-orders/${ID}$`),
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.save',
    label: '保存销售订单行',
    method: 'POST',
    path: new RegExp(`^/sales-orders/${ID}/save$`),
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.submit',
    label: '提交销售订单',
    method: 'POST',
    path: new RegExp(`^/sales-orders/${ID}/submit$`),
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.revise',
    label: '修订销售订单',
    method: 'POST',
    path: new RegExp(`^/sales-orders/${ID}/revise$`),
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.restore',
    label: '恢复销售订单',
    method: 'POST',
    path: new RegExp(`^/sales-orders/${ID}/restore$`),
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.reserve',
    label: '预留销售订单库存',
    method: 'POST',
    path: new RegExp(`^/sales-orders/${ID}/reserve$`),
    channels: ['page', 'chat'],
  },
  {
    name: 'sales-order.release',
    label: '释放销售订单库存',
    method: 'POST',
    path: new RegExp(`^/sales-orders/${ID}/release$`),
    channels: ['page', 'chat'],
  },
]
