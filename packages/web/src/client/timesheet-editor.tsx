import {useRef, useState} from 'react'
import {Button} from '@fluentui/react-components'
import {IconPlus, IconTrash, IconArrowBackUp} from '@tabler/icons-react'
import type {TimesheetFields, TimesheetLine, TimesheetOptions} from '@oryh/ai-client-timesheets'
import {EmptyState} from './list-kit.js'

/** A local aggregate draft. No row control writes to the business server. */
export function TimesheetEditor({fields,options,busy,dirty,existing,error,onChange,onSave,onDiscard}:{
  fields:TimesheetFields;options:TimesheetOptions;busy:boolean;dirty:boolean;existing:boolean;error:string;
  onChange:(fields:TimesheetFields)=>void;onSave:()=>void;onDiscard:()=>void;
}) {
  const root=useRef<HTMLFormElement>(null)
  const [removed,setRemoved]=useState<{line:TimesheetLine;index:number}>()
  const total=Number(fields.entries.reduce((n,l)=>n+(l.hours||0),0).toFixed(6))
  const days=new Set(fields.entries.map(l=>l.work_date).filter(Boolean)).size
  function edit(index:number,patch:Partial<TimesheetLine>){onChange({...fields,entries:fields.entries.map((l,i)=>i===index?{...l,...patch}:l)})}
  function add(){onChange({...fields,entries:[...fields.entries,{work_date:fields.entries.at(-1)?.work_date||fields.period_start,hours:0,work_type:options.workTypes[0]?.name||'',project_id:'',task:'',notes:''}]});requestAnimationFrame(()=>root.current?.querySelector<HTMLInputElement>('.timesheet-entry:last-child input')?.focus())}
  return <form ref={root} className="timesheet-editor" onSubmit={e=>{e.preventDefault();onSave()}}>
    <fieldset disabled={busy} className="timesheet-editor-fields"><legend className="sr-only">{existing?'编辑工时':'新建工时单'}</legend>
      <section className="form-section"><div className="form-section-heading"><div><h2>基本信息</h2><p>选择申报期间，记录本次工作的整体说明。</p></div></div>
        <div className="timesheet-period"><label>开始日期<input required type="date" value={fields.period_start} onChange={e=>onChange({...fields,period_start:e.target.value})}/></label><label>结束日期<input required type="date" min={fields.period_start} value={fields.period_end} onChange={e=>onChange({...fields,period_end:e.target.value})}/></label><label className="timesheet-narrative">工作说明 <span className="field-optional">选填</span><textarea rows={2} maxLength={10000} placeholder="概述本期工作，也可通过 Chat 填写" value={fields.source_report_text} onChange={e=>onChange({...fields,source_report_text:e.target.value})}/></label></div>
      </section>
      <section className="form-section timesheet-lines" aria-label="工时明细"><div className="form-section-heading"><div><h2>工时明细 <span className="section-count">{fields.entries.length}</span></h2><p>每项工作一条明细，所有修改随整单一起保存。</p></div><Button icon={<IconPlus size={16}/>} disabled={fields.entries.length>=100} onClick={add}>添加明细</Button></div>
        <div className="timesheet-entries">{fields.entries.map((line,index)=><div className="timesheet-entry" key={line.id??`new-${index}`} role="group" aria-label={`明细 ${index+1}`}>
          <div className="timesheet-entry-index">{String(index+1).padStart(2,'0')}</div>
          <div className="timesheet-entry-fields">
            <label data-field="date">工作日期<input aria-label={`第 ${index+1} 条工作日期`} required type="date" min={fields.period_start} max={fields.period_end} value={line.work_date} onChange={e=>edit(index,{work_date:e.target.value})}/></label>
            <label data-field="hours">小时<input aria-label={`第 ${index+1} 条小时`} required type="number" min="0.01" max="24" step="any" placeholder="0" value={line.hours||''} onChange={e=>edit(index,{hours:Number(e.target.value)})}/></label>
            <label data-field="type">工时类型<select required value={line.work_type} onChange={e=>edit(index,{work_type:e.target.value})}><option value="">请选择</option>{options.workTypes.map(o=><option value={o.name} key={o.name}>{o.title}</option>)}</select></label>
            <label data-field="project">关联项目<select value={line.project_id} onChange={e=>edit(index,{project_id:e.target.value})}><option value="">不关联项目</option>{line.project_id&&!options.projects.some(p=>p.id===line.project_id)&&<option value={line.project_id}>{line.project_id}（当前不可用）</option>}{options.projects.map(o=><option value={o.id} key={o.id}>{o.name}</option>)}</select></label>
            <label data-field="task">工作任务<input placeholder="具体完成了什么工作" maxLength={200} value={line.task} onChange={e=>edit(index,{task:e.target.value})}/></label>
            <label data-field="notes">备注 <span className="field-optional">选填</span><input placeholder="补充说明" maxLength={2000} value={line.notes} onChange={e=>edit(index,{notes:e.target.value})}/></label>
          </div>
          <Button className="timesheet-entry-remove" appearance="subtle" size="small" icon={<IconTrash size={16}/>} aria-label={`删除第 ${index+1} 条明细`} title="删除明细（保存后生效）" onClick={()=>{setRemoved({line,index});onChange({...fields,entries:fields.entries.filter((_,i)=>i!==index)})}}/>
        </div>)}</div>
        {!fields.entries.length&&<EmptyState filtered={false} title="还没有工时明细" hint="添加一条工作记录，或通过 Chat 填写。"><Button onClick={add} icon={<IconPlus size={16}/>}>添加第一条明细</Button></EmptyState>}
        {removed&&<div className="timesheet-undo" role="status"><span>已从草稿移除一条明细</span><Button appearance="subtle" size="small" disabled={fields.entries.length>=100} icon={<IconArrowBackUp size={15}/>} onClick={()=>{const entries=[...fields.entries];entries.splice(Math.min(removed.index,entries.length),0,removed.line);onChange({...fields,entries});setRemoved(undefined)}}>撤销删除</Button></div>}
      </section>
    </fieldset>
    <footer className="document-savebar"><div className="timesheet-total"><strong>{total}<small> 小时</small></strong><span>{days} 天 · {fields.entries.length} 条明细</span></div><div className="oryh-ts-save-feedback">{error&&<p role="alert">{error}</p>}{busy&&<p role="status">正在核对…</p>}<div className="toolbar"><Button disabled={busy||!dirty} onClick={()=>{setRemoved(undefined);onDiscard()}}>放弃修改</Button><Button type="submit" appearance="primary" disabled={busy||!dirty||!fields.entries.length}>{busy?'正在核对…':'核对并保存'}</Button></div></div></footer>
  </form>
}
