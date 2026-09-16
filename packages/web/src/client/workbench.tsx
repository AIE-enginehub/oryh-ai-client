import {canAccessPage,hasPermission} from '@oryh/ai-client-pages';
import {z} from 'zod';
import {useViewPreference} from './view-preferences.js';
const expenseTabPreference=z.enum(['list','drafts']).catch('list');
import {useColumnPreferences} from './column-preferences.js';
import {RecordPanel,isRecordKind} from './records.js';
import {pageLabels} from './page-labels.js';
import {PageHeader} from './list-kit.js';
import {ProjectPanel} from './projects.js';
import type { ChatNavigation as Navigation } from '@oryh/dsh-host/types';
import { ChatNavigation, BusinessNavigationContext } from './chat-navigation.js';
import { CommandStream } from './command-stream.js';
import { BusinessSessionContext } from './todo-chat.js';
import { TimesheetPanel } from './timesheets.js';
import type { BusinessView } from './layout-store.js';
import { useText } from './locale.js';
import { useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type KeyboardEvent } from 'react';
import { Button } from '@fluentui/react-components';
import { useOryhRemote } from './remote.js';
import { IconChevronRight } from '@tabler/icons-react';
import type { ConnectionSummary, OperationDefinition, OperationId } from '@oryh/ai-client-core';
import { BusinessPage } from './business-page.js';
import { isUserViewPage, userViewPage, useUserViews } from './user-views.js';
import { UserViewBridge } from './user-view-bridge.js';
import { ExpensePanel } from './expenses.js';
export interface PageContext {
    title: string;
    detail: string;
    scope: string;
    key: string;
    content?: string;
    columns?: string[];
    queryFields?:string[];
    /** Query-field values applied to the list, which the Host compares when it waits for a query-bar change. */
    queryValues?:Record<string,string>;
    productCode?:string;
    productIds?:string[];
    availableColumns?:{id:string;label:string}[];
    /** Present when the list on screen is a menu entry the person made. */
    view?:import('@oryh/dsh-host/types').UserViewSummary;
}
export function Workbench(props:Parameters<typeof WorkbenchContent>[0]):ReactNode {
 const {views}=useUserViews(props.connection);
 // A menu entry is only ever as open as the list it narrows: it grants nothing of its own.
 const target=isUserViewPage(props.page)?views.find(v=>userViewPage(v.id)===props.page)?.kind:props.page;
 if(target!==undefined&&!canAccessPage(props.connection.identity,target))return <main className="business-content"><h1>此功能不可用</h1><p>当前账号没有访问此功能的权限，或正在核验权限。请从左侧选择可用菜单。</p></main>;
 return <WorkbenchContent {...props}/>;
}
function WorkbenchContent({ page, connection, operations, onDirtyChange, settings, notices }: {
    page: BusinessView;
    connection: ConnectionSummary;
    operations: readonly OperationDefinition[];
    onDirtyChange: (dirty: boolean) => void;
    settings: ReactNode;
    notices: ReactNode;
}): ReactNode {
    const t = useText();
    const navigate=useContext(BusinessNavigationContext);
    const sessionId=useContext(BusinessSessionContext);
    const [navigation,setNavigation]=useState<Navigation>();
    const remote=useOryhRemote();
    const {views:userViews,loaded:userViewsLoaded,scope:userViewScope}=useUserViews(connection);
    const userView=isUserViewPage(page)?userViews.find(v=>userViewPage(v.id)===page):undefined;
    // The Host checks permissions against a real page, so a menu entry reports the list it narrows.
    const hostPage:import('@oryh/dsh-host/types').ChatPageRequest['page']=userView?userView.kind:isUserViewPage(page)?'my-open-todos':page;
    // An entry deleted elsewhere, or one from another workspace restored on reload, falls back to the
    // home page — but only once the Host's list has arrived: before that, "missing" just means "not yet".
    useEffect(()=>{if(userViewsLoaded&&isUserViewPage(page)&&!userView)navigate('my-open-todos')},[page,userView,userViewsLoaded,navigate]);
    const {recordViewColumns,projectColumns,setProjectColumns,setRecordColumns}=useColumnPreferences(connection);
    // ORYH hands an agent its skills on approval and expects it to re-sync, because a tenant admin
    // can redefine business logic at any time. The Host compares the server manifest first, so this
    // is a cheap no-op once installed. Failure is deliberately silent: the workbench still works
    // without skills, and a blocking error here would be worse than a Chat that knows less.
    useEffect(()=>{void remote.skillSync(connection.id).catch(()=>{})},[remote,connection.id]);
    const [projectDirty,setProjectDirty]=useState(false);
    const [expenseDirty, setExpenseDirty] = useState(false);
    const [timesheetDirty, setTimesheetDirty] = useState(false);
    const [approvalDirty, setApprovalDirty] = useState(false);
    const [timesheetVisited, setTimesheetVisited] = useState(false);
    const [approvalVisited, setApprovalVisited] = useState(false);
    useEffect(() => onDirtyChange(expenseDirty || timesheetDirty || approvalDirty || projectDirty), [expenseDirty, timesheetDirty, approvalDirty, projectDirty, onDirtyChange]);
    const [visited, setVisited] = useState<OperationId[]>(['my-open-todos']);
    const [savedExpenseTab, setExpenseTab] = useViewPreference<'list' | 'drafts'>('expenseTab','list',expenseTabPreference);
    const expenseTab=hasPermission(connection.identity,'expense.submit_own')?savedExpenseTab:'list';
    const [expenseVisited, setExpenseVisited] = useState(expenseTab==='drafts');
    const [newExpenseRequest, setNewExpenseRequest] = useState(0);
    const company = connection.identity.tenant.name ?? connection.identity.tenant.slug;
    useEffect(() => { if (page === 'timesheets') setTimesheetVisited(true); else if (page === 'timesheet-approvals') setApprovalVisited(true); else if (page !== 'settings'&&!isRecordKind(page)&&!isUserViewPage(page)) setVisited(current => current.includes(page) ? current : [...current, page]); }, [page]);
    const main = useRef<HTMLElement>(null);
    useEffect(() => { const seat = main.current?.closest<HTMLElement>('.oryh-business-seat'); if (seat) seat.scrollTop = 0; }, [page, expenseTab]);
    const [pageContexts,setPageContexts]=useState<Record<string,PageContext>>({});
    function report(id: string, value: PageContext) { setPageContexts(current=>JSON.stringify(current[id])===JSON.stringify(value)?current:{...current,[id]:value}); }
    const chatContext=page==='my-expense-claims'&&expenseTab==='drafts'?pageContexts['expense-draft']:pageContexts[page];
    // The expense page's two views sit under its title, in whichever view is showing; they are only
    // offered to someone who can keep drafts at all.
    const expenseTabs=hasPermission(connection.identity,'expense.submit_own')?<div className="view-tabs" role="group" aria-label={t("text20")}>
      <Button appearance={expenseTab === 'list' ? 'secondary' : 'subtle'} aria-pressed={expenseTab === 'list'} onClick={() => setExpenseTab('list')}>{t("text21")}</Button>
      <Button appearance={expenseTab === 'drafts' ? 'secondary' : 'subtle'} aria-pressed={expenseTab === 'drafts'} onClick={() => { setExpenseTab('drafts'); setExpenseVisited(true); }}>{t("text22")}</Button>
    </div>:undefined;
    return <CommandStream sessionId={sessionId} connectionId={connection.id}><div className="oryh-business">
    <UserViewBridge scope={userViewScope}/>
    <ChatNavigation page={hostPage} {...(chatContext?{context:chatContext}:{})} connectionId={connection.id} onOpen={command=>{if(command.target==='view'&&command.userViewId){setNavigation(undefined);navigate(userViewPage(command.userViewId));return}if(command.target==='filters'){setNavigation(command);return}if(command.target==='columns'&&command.columns){if(command.page&&isRecordKind(command.page)){const kind=command.page,columns=command.columns;setRecordColumns(kind,columns)}else setProjectColumns(command.columns as import('@oryh/dsh-host/types').ProjectColumn[]);return}if(command.target==='page'&&command.page){setNavigation(undefined);navigate(command.page);return}setNavigation(command);if(command.target==='project'){setVisited(current=>current.includes('list-projects')?current:[...current,'list-projects']);navigate('list-projects')}else if(command.manager){setApprovalVisited(true);navigate('timesheet-approvals')}else{setTimesheetVisited(true);navigate('timesheets')}}}/>
    <main ref={main} className="business-content">
      {notices}
      <div className="breadcrumb">{t("text16")}<IconChevronRight size={13}/> {isUserViewPage(page)?(userView?.label??''):t(pageLabels[page])}</div>
      {page === 'settings' && <PageHeader title={t(pageLabels.settings)} note={t('text18')}/>}
      {userView&&<RecordPanel key={`${connection.id}:${userView.id}`} kind={userView.kind} view={userView} columns={recordViewColumns[userView.kind]} onColumns={columns=>setRecordColumns(userView.kind,columns)} connectionId={connection.id} onContext={value=>report(page,value)}/>}
      {isRecordKind(page)&&<RecordPanel key={`${connection.id}:${page}`} kind={page} {...(navigation?.target==='filters'?{filterCommand:navigation}:{})} columns={recordViewColumns[page]} onColumns={columns=>setRecordColumns(page,columns)} connectionId={connection.id} onContext={value=>report(page,value)}/>}
      {visited.filter(id=>canAccessPage(connection.identity,id)).map(id => <section key={id} hidden={page !== id} aria-label={t("text19", { value0: t(pageLabels[id]) })}>
        {id==='list-projects'&&<ProjectPanel columns={projectColumns} onColumns={setProjectColumns} connection={connection} active={page===id} {...(navigation?.target==='project'?{navigation}: {})} onDirtyChange={setProjectDirty} onContext={value=>report(id,value)}/>}
        {id!=='list-projects'&&<div hidden={id === 'my-expense-claims' && expenseTab !== 'list'}><BusinessPage connection={connection} operationId={id} {...(id === 'my-expense-claims' && expenseTabs ? { tabs: expenseTabs } : {})} active={page === id && (id !== 'my-expense-claims' || expenseTab === 'list')} onContext={value => report(id, value)} onNewExpense={id === 'my-expense-claims' && hasPermission(connection.identity,'expense.submit_own') ? () => { setExpenseTab('drafts'); setExpenseVisited(true); setNewExpenseRequest(value => value + 1); } : undefined}/></div>}
        {id === 'my-expense-claims' && expenseVisited && hasPermission(connection.identity,'expense.submit_own') && <div hidden={expenseTab !== 'drafts'}><ExpensePanel connection={connection} active={page === id && expenseTab === 'drafts'} {...(expenseTabs ? { tabs: expenseTabs } : {})} newRequest={newExpenseRequest} onDirtyChange={setExpenseDirty} onContext={value => report('expense-draft', value)}/></div>}
      </section>)}
      {timesheetVisited && canAccessPage(connection.identity,'timesheets') && <div hidden={page !== 'timesheets'}><TimesheetPanel connection={connection} active={page === 'timesheets'} {...(!navigation?.manager&&navigation&&navigation.target!=='project'?{navigationId:navigation.id,navigation}:{})} manager={false} onDirtyChange={setTimesheetDirty}/></div>}
      {approvalVisited && canAccessPage(connection.identity,'timesheet-approvals') && <div hidden={page !== 'timesheet-approvals'}><TimesheetPanel connection={connection} active={page === 'timesheet-approvals'} {...(navigation?.manager?{navigationId:navigation.id,navigation}:{})} manager onDirtyChange={setApprovalDirty}/></div>}
      {page === 'settings' && <section className="settings-page"><div className="surface"><dl className="detail-grid"><dt>{t("text23")}</dt><dd>{company}</dd><dt>{t("text24")}</dt><dd>{connection.identity.user.email}</dd><dt>{t("text25")}</dt><dd>{connection.origin}</dd></dl>{settings}</div></section>}
    </main>
  </div></CommandStream>;
}
