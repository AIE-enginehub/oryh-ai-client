/**
 * The controls ORYH's pages are built from.
 *
 * DeepSeek Harness's own primitives where it has one — a button, a text input, a modal — and the few it
 * does not: a labelled field, a native select, a notice, a spinner, a popover. Everything is styled from
 * Harness's design tokens (`--dsw-alias-*`), so a page follows the Harness theme with no provider of its
 * own, and nothing here carries a component library.
 */
import { Button as HarnessButton, Input as HarnessInput, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  Children,
  cloneElement,
  forwardRef,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

type ButtonProps = {
  /** `outline` when unsaid: an ordinary action. `primary` is the one the page wants taken; `ghost` sits in a row or a toolbar. */
  variant?: 'primary' | 'ghost' | 'outline'
  size?: 'md' | 'sm'
  icon?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

/** A button, drawn by Harness. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', size = 'md', className, ...rest },
  ref,
) {
  return (
    <HarnessButton ref={ref} variant={variant} size={size} className={classes('oryh-button', className)} {...rest} />
  )
})

/** A link that reads as a button: somewhere to go, not something to do. */
export function LinkButton({
  icon,
  variant = 'outline',
  className,
  children,
  ...rest
}: { icon?: ReactNode; variant?: 'primary' | 'outline' } & AnchorHTMLAttributes<HTMLAnchorElement>): ReactNode {
  return (
    <a className={classes('oryh-link-button', className)} data-variant={variant} {...rest}>
      {icon}
      {children}
    </a>
  )
}

/** A single-line input, drawn by Harness. */
export const Input = forwardRef<HTMLInputElement, { icon?: ReactNode } & InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <HarnessInput ref={ref} className={classes('oryh-input', className)} {...rest} />
  },
)

/** A native select, which every platform already knows how to open. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...rest },
  ref,
) {
  return <select ref={ref} className={classes('oryh-select', className)} {...rest} />
})

/**
 * A control under its label, with a hint beneath when there is one.
 *
 * The label names its control by id rather than wrapping it: wrapped, a press anywhere in a control made
 * of several parts — a product chooser, say — would have gone to the first button inside it.
 */
export function Field(props: {
  label: ReactNode
  hint?: ReactNode
  className?: string
  children: ReactNode
}): ReactNode {
  const id = useId()
  const [control, ...rest] = Children.toArray(props.children)
  const labelled =
    isValidElement<{ id?: string }>(control) && control.props.id === undefined ? cloneElement(control, { id }) : control
  const target = isValidElement<{ id?: string }>(labelled) ? labelled.props.id : undefined
  return (
    <div className={classes('oryh-field', props.className)}>
      <label className="oryh-field-label" {...(target ? { htmlFor: target } : {})}>
        {props.label}
      </label>
      {labelled}
      {rest}
      {props.hint !== undefined && <span className="oryh-field-hint">{props.hint}</span>}
    </div>
  )
}

/** Something the page has to say about what just happened, with what can be done about it beside it. */
export function Notice(props: {
  intent?: 'info' | 'warning' | 'error' | 'success'
  /** `alert` for what must be heard at once; a status otherwise. */
  role?: 'alert' | 'status'
  actions?: ReactNode
  className?: string
  children: ReactNode
}): ReactNode {
  const intent = props.intent ?? 'info'
  return (
    <div
      className={classes('oryh-notice', props.className)}
      data-intent={intent}
      role={props.role ?? (intent === 'error' ? 'alert' : 'status')}
    >
      <div className="oryh-notice-body">{props.children}</div>
      {props.actions !== undefined && <div className="oryh-notice-actions">{props.actions}</div>}
    </div>
  )
}

/** Something is being waited for; `label` says what. */
export function Spinner(props: { label?: ReactNode; size?: 'sm' | 'md' }): ReactNode {
  return (
    <span className="oryh-spinner" data-size={props.size ?? 'md'} role="status">
      <span className="oryh-spinner-ring" aria-hidden="true" />
      {props.label !== undefined && <span>{props.label}</span>}
    </span>
  )
}

/** A question that needs an answer before the page goes on, in Harness's modal. */
export function Dialog(props: {
  open: boolean
  onClose: () => void
  title: string
  /** What the corner button is called, for a screen reader. */
  closeLabel: string
  /** The buttons that answer it, in reading order. */
  actions?: ReactNode
  className?: string
  children?: ReactNode
}): ReactNode {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      closeLabel={props.closeLabel}
      className={classes('oryh-dialog', props.className)}
      {...(props.actions !== undefined ? { footer: props.actions } : {})}
    >
      {props.children}
    </Modal>
  )
}

/**
 * A small surface opened from a control and placed under it, right edges aligned.
 *
 * It is drawn at the end of the document, so no scrolling container between the control and the page can
 * cut it off, and kept under its control as the page scrolls or resizes. A press outside it, or Escape,
 * closes it.
 */
export function Popover(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The control it opens from; pressing it opens and closes the surface. */
  trigger: (toggle: () => void) => ReactNode
  /** What the surface is, for someone who cannot see it. */
  label: string
  className?: string
  children: ReactNode
}): ReactNode {
  const { open, onOpenChange } = props
  const anchor = useRef<HTMLSpanElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ top: number; left: number }>()
  const toggle = useCallback(() => onOpenChange(!open), [onOpenChange, open])
  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined)
      return
    }
    const position = () => {
      const from = anchor.current?.getBoundingClientRect()
      const box = surface.current?.getBoundingClientRect()
      if (!from || !box) return
      const margin = 8
      // Under the control when there is room, above it when there is not; never off either side.
      const below = from.bottom + 4
      const top =
        below + box.height + margin <= window.innerHeight ? below : Math.max(margin, from.top - 4 - box.height)
      const left = Math.min(Math.max(margin, from.right - box.width), window.innerWidth - box.width - margin)
      setPlace(now => (now && now.top === top && now.left === left ? now : { top, left }))
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (surface.current?.contains(target) || anchor.current?.contains(target)) return
      onOpenChange(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onOpenChange(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, onOpenChange])
  return (
    <>
      <span ref={anchor} className="oryh-popover-anchor">
        {props.trigger(toggle)}
      </span>
      {open &&
        createPortal(
          <div
            ref={surface}
            role="dialog"
            aria-label={props.label}
            className={classes('oryh-popover', props.className)}
            // Measured before it is shown: until then it is laid out off the page, not flashed in a corner.
            style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
          >
            {props.children}
          </div>,
          document.body,
        )}
    </>
  )
}
