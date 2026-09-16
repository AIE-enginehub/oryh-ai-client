import { defaultText, type BusinessText } from './business-locales.js';
import type { OryhExpenseClaim, OryhOperationResult, OryhProject, OryhTodo } from '@oryh/ai-client-core';
export interface BusinessRow {
    id: string;
    title: string;
    status: string;
    date: string;
    secondary: string;
    fields: [
        string,
        string
    ][];
    entityType: string;
}
export interface ViewFilter {
    text: string;
    status: string;
    from: string;
    to: string;
    descending: boolean;
}
export const emptyFilter: ViewFilter = { text: '', status: '', from: '', to: '', descending: true };
export function businessRows(result: OryhOperationResult, t: BusinessText = defaultText): BusinessRow[] {
    if (result.operationId === 'list-projects')
        return (result.result.data as readonly OryhProject[]).map(row => ({ id: row.id, title: row.name, status: row.status, date: row.startDate ?? '', secondary: row.client ?? '', entityType: 'project', fields: [["创建时间", row.createdAt ?? "—"], ["更新时间", row.updatedAt ?? "—"], [t("text179"), row.code ?? '—'], [t("text76"), row.client ?? '—'], [t("text28"), row.startDate ?? '—'], [t("text180"), row.endDate ?? '—']] }));
    if (result.operationId === 'my-expense-claims')
        return (result.result.data as readonly OryhExpenseClaim[]).map(row => ({ id: row.id, title: row.title, status: row.status, date: row.claimDate ?? '', secondary: row.currency, entityType: 'expense_claim', fields: [[t("text29"), row.claimDate ?? '—'], [t("text77"), row.currency], [t("text181"), row.submittedAt ?? t("text182")]] }));
    return (result.result.data as readonly OryhTodo[]).map(row => ({ id: row.id, title: row.title, status: row.status, date: row.dueAt?.slice(0, 10) ?? '', secondary: row.target?.title ?? row.entityType, entityType: 'todo', fields: [[t("text78"), row.target?.title ?? row.entityType], [t("text183"), row.dueAt ?? t("text184")], [t("text136"), row.description ?? '—'], [t("text185"), row.target?.deleted ? t("text186") : '—']] }));
}
/** These filters apply only to the explicitly labelled loaded response, never an implied server-wide result. */
export function filterRows(rows: readonly BusinessRow[], filter: ViewFilter): BusinessRow[] {
    const query = filter.text.trim().toLocaleLowerCase();
    return rows.filter(row => (!query || `${row.title} ${row.secondary} ${row.fields.map(field => field[1]).join(' ')}`.toLocaleLowerCase().includes(query))
        && (!filter.status || row.status === filter.status)
        && (!filter.from || (row.date !== '' && row.date >= filter.from))
        && (!filter.to || (row.date !== '' && row.date <= filter.to)))
        .sort((a, b) => {
        if (!a.date)
            return b.date ? 1 : 0;
        if (!b.date)
            return -1;
        return (filter.descending ? -1 : 1) * a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
    });
}
