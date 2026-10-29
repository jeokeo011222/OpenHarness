/**
 * Client-side ontology workbench registration.
 *
 * Registers two sidebar/main slots:
 *   - `sidebar.panellist` row with a 2×2 grid icon
 *   - `main` page with the domain rail, upload-and-generate form, graph canvas,
 *     inspector, and version timeline
 *
 * The page talks to the Host through the injected `ontologyStore` Remote face,
 * so no filesystem access happens in the browser.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OntologyIcon } from './OntologyIcon.tsx'
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

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ store, t }),
  }, Workbench))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 90,
    locale: NS,
    label: () => t('title'),
  }, OntologyIcon))
}
