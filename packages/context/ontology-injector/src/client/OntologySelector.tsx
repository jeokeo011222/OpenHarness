/**
 * Ontology seat above the composer.
 *
 * Every operation in the ontology center is scoped to one domain, and a chat
 * turn is no different: the model only learns a domain's vocabulary when the
 * turn names it. This seat is that choice, made visible — pick a domain and the
 * draft carries `@<name>`; pick nothing and the conversation stays plain.
 *
 * It is a dropdown rather than a row of chips, because the composer already
 * reads as one row of seated choices ("default workspace", "standard mode"):
 * a chip row grows sideways with every domain and pushes the composer off the
 * grid, while a seat keeps its footprint and hands the list to a menu.
 *
 * The selection is derived from the draft text rather than stored: a restored
 * draft, a hand-deleted token, and a fresh click all agree without extra state
 * to keep in sync.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { OntologyDomainSummary } from '../types.ts'
import { mentionTokenFor } from '../mention.ts'
import type { MentionCandidate } from '../mention.ts'
import { unwrap, type OntologyStoreFace } from './face.ts'
import type { Translate } from './Inspector.tsx'
import { OntologyIcon } from './OntologyIcon.tsx'
import { domainRowDescription } from './domain-copy.ts'
import { appendDomainMention, selectedDomainId, stripDomainMentions, swapDomainMention } from './mention-draft.ts'
import seatCss from './domain-seat.module.css'
import styles from './ontology-selector.module.css'

/** Menu id of the "no ontology" row — a real choice, never a placeholder. */
const NONE_ID = '::none'

/** Props injected by the plugin registration. */
export interface OntologySelectorInjected {
  readonly store: OntologyStoreFace
  readonly t: Translate
}

/**
 * The runtime slice the seat itself needs, taken from the dock owner share.
 *
 * Both seats (the hero row's and the in-conversation dock's) receive the same
 * session standard kit, so one shape serves them and the seat never learns
 * which row it landed in.
 */
type SeatRuntime = Pick<PropsRuntime<'conversation.input.dock'>, 'useInput' | 'inputActions'>

/** Props of the in-conversation seat. */
export type OntologySelectorProps = PropsRuntime<'conversation.input.dock'> & OntologySelectorInjected

/** Props of the new-session row's seat. */
export type OntologyHeroSeatProps = PropsRuntime<'conversation.hero.options'> & OntologySelectorInjected

/**
 * The seat plus its menu.
 *
 * @param props - store face, copy, and the session standard kit.
 * @returns the seat and its menu, or nothing when the store holds no domains.
 */
function OntologySeat({ store, t, useInput, inputActions }: SeatRuntime & OntologySelectorInjected): ReactNode {
  const draft = useInput(state => state.draft)
  const phase = useInput(state => state.phase)
  const [domains, setDomains] = useState<OntologyDomainSummary[]>([])
  const [open, setOpen] = useState(false)
  const locked = phase !== 'plain'

  // The seat outlives the ontology center page, so it reloads when the window
  // regains focus: a domain created or disabled there shows up on return
  // without a reload of the whole client.
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      try {
        const list = unwrap(await store.listDomains())
        if (live) setDomains(list)
      } catch {
        // A missing store is not this seat's failure to report: the composer
        // must stay usable, and the center already surfaces the real error.
      }
    }
    void load()
    const onFocus = (): void => { void load() }
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      window.removeEventListener('focus', onFocus)
    }
  }, [store])

  // A turn starting disables the seat; a menu left open over it would offer
  // picks that the draft no longer accepts.
  useEffect(() => {
    if (locked) setOpen(false)
  }, [locked])

  if (domains.length === 0) return null

  const candidates: MentionCandidate[] = domains.map(domain => ({
    id: domain.id,
    label: domain.label,
    disabled: domain.disabled,
  }))
  const selected = selectedDomainId(draft, candidates)
  const current = domains.find(domain => domain.id === selected) ?? null

  const pick = (domain: OntologyDomainSummary): void => {
    if (locked || domain.disabled) return
    // Swapping in place beats appending: the token usually sits where the user
    // put it, and re-appending would move it behind the question.
    const swapped = swapDomainMention(draft, domain, candidates)
    if (swapped !== null) {
      inputActions.setDraft(swapped)
      return
    }
    const span = inputActions.captureInsertion()
    if (!inputActions.insertText(`${mentionTokenFor(domain)} `, span)) {
      // The draft changed under the caret (a concurrent edit); fall back to an
      // append rather than dropping the click on the floor.
      inputActions.setDraft(appendDomainMention(draft, domain))
    }
  }

  const items: MenuEntry[] = [
    {
      id: NONE_ID,
      label: (
        <span className={seatCss.item}>
          <span className={seatCss.itemName}>{t('selectorNone')}</span>
          <span className={seatCss.itemDesc}>{t('selectorHint')}</span>
        </span>
      ),
    },
    ...domains.map((domain): MenuEntry => ({
      id: domain.id,
      disabled: domain.disabled,
      label: (
        <span className={seatCss.item}>
          <span className={seatCss.itemName}>{domain.label}</span>
          <span className={seatCss.itemDesc}>
            {domain.disabled ? t('selectorDisabled') : domainRowDescription(domain, t)}
          </span>
        </span>
      ),
    })),
  ]

  const choose = (id: string): void => {
    setOpen(false)
    if (locked) return
    if (id === NONE_ID) {
      inputActions.setDraft(stripDomainMentions(draft, candidates))
      return
    }
    const domain = domains.find(entry => entry.id === id)
    if (domain !== undefined) pick(domain)
  }

  return (
    <Menu
      open={open && !locked}
      onClose={() => { setOpen(false) }}
      items={items}
      // An unchanged selection still needs a checked row: "no ontology" is
      // the default state, and an empty check column would read as a menu
      // that failed to load rather than one with a standing choice.
      selectedId={selected ?? NONE_ID}
      onSelect={choose}
      align="start"
      side="top"
      portal
      minWidthFromAnchor
      className={seatCss.anchor}
      anchor={(
        <button
          type="button"
          className={seatCss.seat}
          aria-haspopup="menu"
          aria-expanded={open && !locked}
          title={current === null ? t('selectorHint') : domainRowDescription(current, t)}
          disabled={locked}
          onClick={() => { setOpen(value => !value) }}
        >
          {/* A wrapper owns the flex slot: the glyph is a grid of spans, and
            * letting them join the seat's own row would space them apart. */}
          <span className={seatCss.seatIcon}><OntologyIcon size={16} /></span>
          <span className={seatCss.seatLabel}>{current?.label ?? t('selectorNone')}</span>
          <IconChevronDownOutlineRegular className={seatCss.chevron} />
        </button>
      )}
    />
  )
}

/**
 * The in-conversation seat, above the input card.
 *
 * The new-session row owns the seat while the session is still blank: that row
 * already holds the workspace and preset controls, and a second seat just below
 * it would ask the same question twice. Once the first turn lands the row is
 * gone, and this seat takes over — the choice stays reachable for every turn.
 *
 * @param props - dock owner share, session standard kit, and the injected face.
 * @returns the seat, or nothing while the new-session row is showing.
 */
export function OntologySelector({ session, ...rest }: OntologySelectorProps): ReactNode {
  // A blank session is the new-session screen, where the row above already
  // carries this seat. `blank` rather than the shell phase: while a blank
  // session replays its composer stays hidden, so the seat can wait it out.
  if (session.blank) return null
  // The card-aligned row belongs to the dock alone: the new-session row is a
  // flex row that sizes to content, where a percentage width would fight it.
  return (
    <div className={styles.row} data-ontology-selector="">
      <OntologySeat {...rest} />
    </div>
  )
}

/**
 * The new-session row's seat, sharing the line with the workspace and preset
 * controls — the composer's own line, not a second one below it.
 *
 * @param props - row slot share, session standard kit, and the injected face.
 * @returns the seat and its menu.
 */
export function OntologyHeroSeat(props: OntologyHeroSeatProps): ReactNode {
  return <OntologySeat {...props} />
}
