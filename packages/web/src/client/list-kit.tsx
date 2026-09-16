import {Button,MessageBar,MessageBarBody,Spinner} from '@fluentui/react-components'
import {IconArrowLeft,IconChevronRight,IconPlus,IconRefresh} from '@tabler/icons-react'
import type {ReactNode} from 'react'
import type {StatusTone} from './status-words.js'

/**
 * The one way every business page says the same thing.
 *
 * Pages had drifted apart phrase by phrase: a row opened with ">" on one list, 「打开」 on another and
 * 「查看」 on a third; the count read 「筛选结果N条」, 「共 N 条」 or 「共 N 条 · 当前 N 条」; back was an icon
 * in one place and a "←" character in another; status was a pill here and a Fluent Badge there. None
 * of it was wrong on its own, and all of it together made the workbench feel like several products.
 *
 * So these pieces exist once, and pages compose them instead of writing their own. The copy lives here
 * too, in one place, for the day the workbench is translated. `docs/25-ui-conventions.md` records the
 * rules; `list-kit.spec.ts` fails a page that goes back to spelling them out by hand.
 */

/**
 * The top of every business page: an optional way back, the title, and the page's actions.
 * @param title - the menu label on a list page; the record's or form's name on a detail or form.
 * @param back - a {@link BackToList}, on details and forms only.
 * @param status - a {@link StatusPill} beside the title, when what is open has a status.
 * @param note - one short muted line about the page's state.
 * @param actions - buttons on the right: {@link RefreshButton} first, then {@link NewButton}.
 * @param tabs - the page's views, under the title.
 */
export function PageHeader({title,back,status,note,actions,tabs}:{title:ReactNode;back?:ReactNode;status?:ReactNode;note?:ReactNode;actions?:ReactNode;tabs?:ReactNode}){
 return <header className="business-page-header">{back}<div className="list-actions"><div className="page-title"><h1>{title}</h1>{status}{note?<span className="muted">{note}</span>:null}</div>{actions?<div className="toolbar">{actions}</div>:null}</div>{tabs}</header>
}

/** Header cell of the row-open column: named for screen readers, empty to the eye. */
export function RowOpenHeader(){return <th scope="col" className="row-open-cell"><span className="sr-only">操作</span></th>}

/**
 * The trailing ">" that opens a row's detail. Every list whose rows open has it, and nothing else.
 * @param title - what the row is called, so the button says what it opens.
 * @param onOpen - opens the detail.
 * @param disabled - while the list is busy.
 */
export function RowOpenCell({title,onOpen,disabled}:{title:string;onOpen:()=>void;disabled?:boolean}){
 return <td className="row-open-cell"><Button appearance="subtle" size="small" aria-label={`查看 ${title}`} title={`查看 ${title}`} icon={<IconChevronRight size={16}/>} disabled={Boolean(disabled)} onClick={onOpen}/></td>
}

/** Leave a detail or form for the list it came from. */
export function BackToList({onClick,disabled}:{onClick:()=>void;disabled?:boolean}){
 return <Button appearance="subtle" icon={<IconArrowLeft size={17}/>} disabled={Boolean(disabled)} onClick={onClick}>返回列表</Button>
}

/** Re-read a list from the server. */
export function RefreshButton({onClick,disabled}:{onClick:()=>void;disabled?:boolean}){
 return <Button disabled={Boolean(disabled)} icon={<IconRefresh size={17}/>} onClick={onClick}>刷新</Button>
}

/**
 * Start a new record from a list.
 * @param children - what is created, spelled 「新建…」.
 */
export function NewButton({onClick,disabled,children}:{onClick:()=>void;disabled?:boolean;children:ReactNode}){
 return <Button appearance="primary" icon={<IconPlus size={17}/>} disabled={Boolean(disabled)} onClick={onClick}>{children}</Button>
}

/** Drop every search and filter condition a list has. */
export function ClearConditionsButton({onClick}:{onClick:()=>void}){
 return <Button type="button" appearance="subtle" onClick={onClick}>清空条件</Button>
}

/** A status, always as a pill. Lists and detail headers alike; no Fluent Badge for status. */
export function StatusPill({tone='neutral',children}:{tone?:StatusTone;children:ReactNode}){
 return <span className={`record-status status-${tone}`}>{children}</span>
}

/** A list or page reading from the server. */
export function ListLoading({label='正在读取…'}:{label?:string}){
 return <div className="list-loading" role="status"><Spinner size="tiny"/>{label}</div>
}

/**
 * Something failed. A read that can simply be repeated offers to do so; a failed action does not,
 * because repeating it is the person's decision.
 * @param message - what failed, as the service said it.
 * @param onRetry - repeats the read, when there is one to repeat.
 */
export function ErrorNote({message,onRetry,disabled}:{message:ReactNode;onRetry?:()=>void;disabled?:boolean}){
 return <MessageBar intent="error" role="alert"><MessageBarBody>{message}</MessageBarBody>{onRetry?<Button disabled={Boolean(disabled)} onClick={onRetry}>重新加载</Button>:null}</MessageBar>
}

/**
 * The server may have moved on while a form held unsaved edits — usually a write made in Chat.
 * Refreshing shows the server's version and gives those edits up, which is why the button says so.
 * @param onRefresh - discards the unsaved edits and re-reads the document.
 */
export function StaleNote({onRefresh,disabled}:{onRefresh:()=>void;disabled?:boolean}){
 return <MessageBar intent="warning"><MessageBarBody>服务端数据可能已在 Chat 中更新，页面上未保存的修改可能已经过时。</MessageBarBody><Button disabled={Boolean(disabled)} onClick={onRefresh}>放弃修改并刷新</Button></MessageBar>
}

/**
 * What a list shows when it has no rows. Filtered-to-nothing and genuinely empty say different things,
 * so the page passes which one it is rather than inventing its own sentence.
 * @param filtered - whether search or query conditions are narrowing the list.
 * @param title - replaces the heading where "records" is the wrong word, such as local drafts.
 * @param hint - what the person can do next, when the page has something better than the default.
 * @param children - an optional action, such as creating the first record.
 */
export function EmptyState({filtered,title,hint,children}:{filtered:boolean;title?:string;hint?:string;children?:ReactNode}){
 return <div className="empty-state"><h3>{title??(filtered?'没有符合条件的记录':'当前没有记录')}</h3><p>{hint??(filtered?'调整或清空查询条件后再看。':'刷新后，新的记录会显示在这里。')}</p>{children}</div>
}

/**
 * Count and paging under a list.
 *
 * The count must not claim more than it knows. A server-paged list knows its total; a list that loaded
 * one batch and filters it in the browser does not, and says so — unifying the wording must never turn
 * a partial count into a false total.
 * @param count - rows the count describes.
 * @param partial - true when the count covers only what this page loaded, not the server's total.
 */
export function ListFooter({count,partial=false,page,pages,onPage,disabled}:{count:number;partial?:boolean;page:number;pages:number;onPage:(page:number)=>void;disabled?:boolean}){
 return <footer className="table-footer"><span>{partial?`${count} 条（仅本次载入）`:`共 ${count} 条`}</span><div className="pagination"><Button size="small" disabled={Boolean(disabled)||page<=1} onClick={()=>onPage(page-1)}>上一页</Button><span>{page} / {pages}</span><Button size="small" disabled={Boolean(disabled)||page>=pages} onClick={()=>onPage(page+1)}>下一页</Button></div></footer>
}

const pad=(n:number)=>String(n).padStart(2,'0')

/**
 * A date the way the workbench writes dates: `YYYY-MM-DD`, local time.
 * @param value - a Date, epoch milliseconds, or anything `Date` parses.
 * @returns the date, or the input unchanged when it is not one.
 */
export function formatDate(value:Date|number|string):string{
 const date=value instanceof Date?value:new Date(value)
 if(Number.isNaN(date.getTime()))return String(value)
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`
}

/**
 * A moment the way the workbench writes time: `YYYY-MM-DD HH:mm`, local time.
 * @param value - a Date, epoch milliseconds, or anything `Date` parses.
 * @returns the moment, or the input unchanged when it is not one.
 */
export function formatDateTime(value:Date|number|string):string{
 const date=value instanceof Date?value:new Date(value)
 if(Number.isNaN(date.getTime()))return String(value)
 return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const ISO_TIME=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * Show a server value, writing an ISO timestamp as {@link formatDateTime} does.
 * Anything that is not an ISO timestamp — a plain date, a number, free text — comes back unchanged, so
 * this is safe to apply to every displayed value.
 * @param value - a displayed value.
 * @returns the formatted value.
 */
export function formatDisplayValue(value:string):string{
 const match=ISO_TIME.exec(value)
 if(!match)return value
 // Without a zone the server meant wall-clock time; keep it rather than shifting it through UTC.
 if(!match[4])return `${match[1]} ${match[2]}:${match[3]}`
 return formatDateTime(value)
}
