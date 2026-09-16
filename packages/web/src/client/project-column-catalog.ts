import type {ProjectColumn} from '@oryh/dsh-host/types'

/** Project list columns: what each is called, and which show before anyone chooses. Kept free of UI imports so preference stores can read it. */
export const projectColumnLabels:Record<ProjectColumn,string>={name:'项目名称',code:'项目编码',status:'状态',client:'客户',startDate:'开始日期',endDate:'结束日期',createdAt:'创建时间',updatedAt:'更新时间'}
export const defaultProjectColumns:ProjectColumn[]=['name','status','client','startDate']
