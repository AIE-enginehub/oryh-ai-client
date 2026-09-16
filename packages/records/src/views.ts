import type {RecordKind} from './contracts.js'
export const recordSpecs:Record<RecordKind,{query:string;title:string;summary:string;date:string;fields:Record<string,string>}>= {
 'sales-orders':{query:'keyword',title:'order_no',summary:'customer_name_snapshot',date:'order_date',fields:{order_no:'订单号',title:'订单名称',order_kind:'订单类型',status:'状态',customer_name_snapshot:'客户',store_name:'门店',order_date:'订单日期',promised_date:'承诺日期',currency:'币种',total_amount:'订单总额',payment_terms:'付款条件',delivery_terms:'交付条件',contract_no:'合同号',project_id:'项目编号',remarks:'备注'}},
 'inventory-items':{query:'facility',title:'product_code',summary:'facility',date:'received_at',fields:{product_code:'产品编码',product_id:'产品编号',sku_id:'SKU 编号',facility:'仓库',facility_id:'仓库编号',lot_id:'批次',bin_number:'库位',quantity_on_hand:'现存数量',available_to_promise:'可承诺数量',unit_cost:'单位成本',currency:'币种',status:'状态',received_at:'入库时间',expire_date:'到期日期'}},
 'inventory-item-details':{query:'inventory_item_id',title:'reason',summary:'inventory_item_id',date:'effective_at',fields:{product_code:'产品编码',facility:'仓库',inventory_item_id:'库存项编号',item_status:'库存项状态',reason:'变动原因',quantity_on_hand_diff:'现存数量变动',available_to_promise_diff:'可承诺数量变动',description:'说明',sales_order_id:'销售订单编号',purchase_order_id:'采购订单编号',entity_type:'关联类型',entity_id:'关联编号',unit_cost:'单位成本',effective_at:'生效时间',created_by:'记录人',created_at:'创建时间'}},
 shipments:{query:'keyword',title:'shipment_no',summary:'carrier',date:'expected_date',fields:{shipment_no:'收发货单号',title:'名称',direction:'方向',status:'状态',facility:'仓库',carrier:'承运商',tracking_no:'运单号',sales_order_id:'销售订单编号',purchase_order_id:'采购订单编号',expected_date:'预计日期',shipped_at:'发出时间',received_at:'接收时间',stock_posted_at:'库存过账时间',remarks:'备注'}},
}
export const recordDefaultColumns:Record<RecordKind,string[]>={
 'sales-orders':['order_no','customer_name_snapshot','status','order_date'],
 'inventory-items':['product_code','facility','quantity_on_hand','available_to_promise','received_at'],
 'inventory-item-details':['reason','inventory_item_id','quantity_on_hand_diff','available_to_promise_diff','effective_at'],
 shipments:['shipment_no','carrier','status','expected_date'],
}
export function recordColumns(kind:RecordKind):Record<string,string>{return {id:'编号',...recordSpecs[kind].fields}}
