import {it,expect,vi} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {ProjectTable} from './project-columns.js'
vi.mock('@fluentui/react-components',()=>({Button:({appearance,size,icon,children,...props}:any)=>createElement('button',props,children)}))
it('renders requested columns in order with the server creation timestamp',()=>{
 const html=renderToStaticMarkup(createElement(ProjectTable,{projects:[{id:'p',name:'项目',status:'active',code:null,client:null,startDate:null,endDate:null,createdAt:'2026-09-01T08:00:00Z'}],columns:['name','createdAt','client'],onOpen:()=>{}}))
 expect(html).toContain('dateTime="2026-09-01T08:00:00Z"')
 expect(html.indexOf('项目名称')).toBeLessThan(html.indexOf('创建时间'))
 expect(html.indexOf('创建时间')).toBeLessThan(html.indexOf('客户'))
 expect(html).not.toContain('开始日期')
 expect(html).toContain('—')
 // Rows open the way every list's rows open: one trailing control that names what it opens.
 expect(html).toContain('aria-label="查看 项目"')
})
