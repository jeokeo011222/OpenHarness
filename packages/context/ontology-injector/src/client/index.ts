/**
 * Client-side ontology registration.
 *
 * Registers three surfaces:
 *   - `sidebar.panellist` row with a 2×2 grid icon
 *   - `main` page with the domain rail, upload-and-generate form, graph canvas,
 *     inspector, version timeline, and the audit trail
 *   - `conversation.input.dock` row that selects the domain one chat turn runs on
 *
 * Both the page and the composer row talk to the Host through the injected
 * `ontologyStore` Remote face, so no filesystem access happens in the browser.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { OntologyStoreFace } from './face.ts'
import { OntologyIcon } from './OntologyIcon.tsx'
import { OntologyHeroSeat, OntologySelector } from './OntologySelector.tsx'
import { Workbench } from './Workbench.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type LocaleDict } from './locales.ts'

const NS = 'ontology.panel'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: keyof LocaleDict
  }
}

/** Required client services: slot registry, locale, and the Store namespace. */
export const inject = ['slots', 'locale', 'remote', 'remote.ontologyStore']

/** Panel id kept as plain string so it matches the cordis.patch.yml entry. */
const PANEL_ID = 'ontology'

/**
 * Register the ontology workbench — sidebar row plus main page.
 *
 * @param ctx - Client root context with slots, locale, and remote merged in.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ontology-panel: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = ctx.remote.ontologyStore

  // The generated Typert namespace file predates the retrieval endpoints; the
  // methods exist on the Host service and are registered as `@Remote`, so the
  // runtime contract is real. Narrowing through the hand-written face keeps the
  // panel typed against one source of truth until the generator is re-run.
  // `tests/retrieval.spec.ts` pins the Host method names so a rename cannot
  // slip past this assertion.
  const face = store as unknown as OntologyStoreFace

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ store: face, t }),
  }, Workbench))

  // The seat leads the dock: choosing what the turn is about comes before the
  // queue and the todo list, which describe the turn already under way.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'ontology',
    order: -10,
    inject: () => ({ store: face, t }),
  }, OntologySelector))

  // The new-session row holds the same seat on its right edge, beside the
  // workspace and preset controls. The dock seat stands down while that row is
  // up, so the choice is never offered twice on one screen.
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'ontology',
    order: 0,
    inject: () => ({ store: face, t }),
  }, OntologyHeroSeat))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 90,
    locale: NS,
    label: () => t('title'),
  }, OntologyIcon))
}
