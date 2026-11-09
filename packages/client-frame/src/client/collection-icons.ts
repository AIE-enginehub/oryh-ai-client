import {
  IconBeach,
  IconBox,
  IconBuildingBank,
  IconBuildingStore,
  IconCash,
  IconClipboardList,
  IconClockHour4,
  IconCreditCard,
  IconFileDollar,
  IconFileInvoice,
  IconListDetails,
  IconListNumbers,
  IconPackage,
  IconReceipt,
  IconReceiptRefund,
  IconReportMoney,
  IconSignature,
  IconSpeakerphone,
  IconTable,
  IconTransfer,
  IconUserCircle,
  IconUsers,
  IconWallet,
} from '@tabler/icons-react'

type Icon = typeof IconTable

/**
 * The menu icon of a list over an ORYH collection with no page of its own — a role's invoices, a person's
 * order lines. Chosen beside the pages' own icons (docs/25) so no two entries in one menu look alike; a
 * collection not named here is a table.
 */
const ICONS: Readonly<Record<string, Icon>> = {
  invoices: IconFileInvoice,
  'invoice-items': IconListDetails,
  payments: IconCash,
  'payment-applications': IconTransfer,
  employees: IconUsers,
  'fin-accounts': IconBuildingBank,
  'fin-account-transactions': IconCreditCard,
  'pay-histories': IconReportMoney,
  'employee-leaves': IconBeach,
  'purchase-requests': IconClipboardList,
  'purchase-orders': IconPackage,
  'sales-quotations': IconFileDollar,
  'sales-returns': IconReceiptRefund,
  'sales-order-items': IconListNumbers,
  customers: IconUserCircle,
  vendors: IconBuildingStore,
  products: IconBox,
  contracts: IconSignature,
  'expense-claims': IconReceipt,
  'timesheet-headers': IconClockHour4,
  'billing-accounts': IconWallet,
  campaigns: IconSpeakerphone,
}

export function collectionIcon(collection: string | undefined): Icon {
  return (collection && ICONS[collection]) || IconTable
}
