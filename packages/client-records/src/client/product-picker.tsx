import { Button, Dialog, Input, type PageFace } from '@oryh/ai-client-kit'
import type { ProductOption, ProductOptions } from '@oryh/ai-client-records'
import { useEffect, useState } from 'react'
import type { RecordsApi } from './api.js'
import type { Words } from './words.js'

/** How many products one query may be narrowed to. */
const LIMIT = 50

const SearchIcon = () => (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
  >
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m16 16 5 5" />
  </svg>
)
export function ProductPicker({
  api,
  face,
  t,
  value,
  onChange,
}: {
  api: RecordsApi
  face: PageFace
  t: Words
  value: ProductOption[]
  onChange: (value: ProductOption[]) => void
}) {
  const connectionId = face.connection.id
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<ProductOption[]>([]),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [reload, setReload] = useState(0),
    [data, setData] = useState<ProductOptions>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => setOpen(false), [value, connectionId])
  useEffect(() => {
    if (!open) return
    let live = true
    setBusy(true)
    setError('')
    setData(undefined)
    void api
      .productSearch({ connectionId, query: search, page })
      .then(v => {
        if (live) setData(v)
      })
      .catch(e => {
        if (live) setError(e instanceof Error ? e.message : t('pickerSearchFailed'))
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [api, connectionId, open, search, page, reload])
  function show() {
    setDraft([...value])
    setQuery('')
    setSearch('')
    setPage(1)
    setOpen(true)
  }
  return (
    <div className="product-picker">
      <div className="product-picker-control">
        <span>{value.length ? t('pickerSelected', { count: value.length }) : t('pickerAll')}</span>
        <Button type="button" variant="ghost" aria-label={t('pickerOpen')} onClick={show}>
          <SearchIcon />
        </Button>
      </div>
      {value.length > 0 && (
        <div className="product-chips">
          {value.map(p => (
            <span key={p.id} className="product-chip" title={p.name}>
              {p.code || p.name}
              <button
                type="button"
                aria-label={t('pickerRemove', { name: p.name })}
                onClick={() => onChange(value.filter(v => v.id !== p.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('pickerTitle')}
        closeLabel={face.frame.t('dialogClose')}
        className="oryh-dialog-wide product-picker-dialog"
        actions={
          <>
            <Button type="button" onClick={() => setOpen(false)}>
              {t('pickerCancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                onChange(draft)
                setOpen(false)
              }}
            >
              {t('pickerConfirm', { count: draft.length })}
            </Button>
          </>
        }
      >
        <form
          className="product-picker-search"
          onSubmit={e => {
            e.preventDefault()
            e.stopPropagation()
            setSearch(query.trim())
            setPage(1)
            setReload(v => v + 1)
          }}
        >
          <Input
            aria-label={t('pickerSearchLabel')}
            placeholder={t('pickerSearchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            maxLength={200}
          />
          <Button type="submit" disabled={busy}>
            {t('pickerSearchButton')}
          </Button>
        </form>
        <div className="product-picker-selection">
          <span>{t('pickerDraftCount', { count: draft.length, limit: LIMIT })}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDraft([])}>
            {t('pickerClear')}
          </Button>
        </div>
        {draft.length > 0 && (
          <div className="product-chips">
            {draft.map(p => (
              <span key={p.id} className="product-chip">
                {p.code || p.name}
                <button
                  type="button"
                  aria-label={t('pickerUnselect', { name: p.name })}
                  onClick={() => setDraft(v => v.filter(x => x.id !== p.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        {busy ? (
          <p role="status">{t('pickerSearching')}</p>
        ) : (
          data && (
            <>
              <div className="product-picker-results">
                {data.rows.map(p => (
                  <label className="product-picker-row" key={p.id}>
                    <input
                      type="checkbox"
                      checked={draft.some(v => v.id === p.id)}
                      disabled={draft.length >= LIMIT && !draft.some(v => v.id === p.id)}
                      onChange={e => setDraft(v => (e.target.checked ? [...v, p] : v.filter(x => x.id !== p.id)))}
                    />
                    <span>
                      <strong>{p.name}</strong>
                      <small>{p.code || t('pickerNoCode')}</small>
                    </span>
                  </label>
                ))}
                {!data.rows.length && <p>{t('pickerNoMatch')}</p>}
              </div>
              <div className="product-picker-pagination">
                <span>{t('pickerTotal', { count: data.total })}</span>
                <Button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  {face.frame.t('footerPrevious')}
                </Button>
                <span>
                  {page} / {data.pages}
                </span>
                <Button type="button" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}>
                  {face.frame.t('footerNext')}
                </Button>
              </div>
            </>
          )
        )}
      </Dialog>
    </div>
  )
}
