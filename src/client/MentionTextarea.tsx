import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { MentionableUser } from './pr-feedback-api.ts'
import { applyMention, mentionQueryAt, type MentionQuery } from './mention.ts'
import { menuNavigationIndex } from './menu-navigation.ts'
import * as styles from './styles.ts'

/** How long the draft must sit still before the repository is asked who `@al`
 *  might be; one request per keystroke would rate-limit the token. */
const SUGGEST_DEBOUNCE_MS = 200

/** A comment composer that completes `@handles` from the repository's
 *  mentionable users. GitHub notifies on the text alone, so the popup is a
 *  convenience: typing a login by hand works exactly as well. */
export function MentionTextarea({
  value, placeholder, suggestLabel, maxLength = 2_000, autoFocus = false, disabled = false,
  suggest, onChange, onSubmit,
}: {
  value: string
  placeholder: string
  suggestLabel: string
  maxLength?: number
  autoFocus?: boolean
  disabled?: boolean
  suggest: (query: string) => Promise<readonly MentionableUser[]>
  onChange: (value: string) => void
  /** Ctrl/Cmd+Enter, but only while the completion popup is closed. */
  onSubmit?: () => void
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<MentionQuery>()
  const [users, setUsers] = useState<readonly MentionableUser[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [caretTarget, setCaretTarget] = useState<number>()
  const open = mention !== undefined && users.length > 0

  useEffect(() => {
    if (mention === undefined) {
      setUsers([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void suggest(mention.query).then((found) => {
        if (cancelled) return
        setUsers(found)
        setActiveIndex(0)
      }, () => {
        if (!cancelled) setUsers([])
      })
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mention, suggest])

  // Completing a handle moves the caret past the inserted login; React restores
  // it to the end of the value otherwise.
  useLayoutEffect(() => {
    if (caretTarget === undefined || areaRef.current === null) return
    areaRef.current.setSelectionRange(caretTarget, caretTarget)
    setCaretTarget(undefined)
  }, [caretTarget, value])

  const track = (area: HTMLTextAreaElement): void => {
    setMention(mentionQueryAt(area.value, area.selectionStart ?? area.value.length))
  }

  const complete = (login: string): void => {
    const area = areaRef.current
    if (area === null || mention === undefined) return
    const applied = applyMention(area.value, area.selectionStart ?? area.value.length, mention, login)
    setMention(undefined)
    setUsers([])
    setCaretTarget(applied.caret)
    onChange(applied.text)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        setActiveIndex(current => menuNavigationIndex(current, users.length, event.key as 'ArrowDown'))
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const login = users[activeIndex]?.login
        if (login !== undefined) {
          event.preventDefault()
          complete(login)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(undefined)
        setUsers([])
        return
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && onSubmit !== undefined) {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <span style={styles.mentionField}>
      <textarea
        ref={areaRef}
        className={styles.diffCommentTextareaClass}
        style={styles.diffCommentTextarea}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        onChange={(event) => {
          onChange(event.currentTarget.value)
          track(event.currentTarget)
        }}
        onKeyUp={event => { track(event.currentTarget) }}
        onClick={event => { track(event.currentTarget) }}
        onBlur={() => { setMention(undefined) }}
        onKeyDown={handleKeyDown}
      />
      {!open ? null : (
        <span role="listbox" aria-label={suggestLabel} style={styles.mentionList}>
          {users.map((user, index) => (
            <button
              key={user.login}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              style={{ ...styles.mentionItem, ...(index === activeIndex ? styles.mentionItemActive : {}) }}
              onMouseEnter={() => { setActiveIndex(index) }}
              // The blur that a click would fire first must not close the popup
              // before the completion runs.
              onMouseDown={event => { event.preventDefault() }}
              onClick={() => { complete(user.login) }}
            >
              {user.avatarUrl === undefined ? null : (
                <img src={user.avatarUrl} alt="" width={16} height={16} loading="lazy" referrerPolicy="no-referrer" style={styles.mentionAvatar} />
              )}
              {user.login}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
