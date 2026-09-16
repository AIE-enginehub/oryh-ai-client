import {it,expect} from 'vitest'
import {PAGES} from '@oryh/ai-client-pages'
import {dictionaries} from './locale.js'
import {pageLabels} from './page-labels.js'

it('names every page to the agent exactly as the menu names it',()=>{
 // The Host describes pages to the agent from the registry; the person reads the menu. One page, one name.
 for(const page of PAGES)expect(dictionaries[pageLabels[page.id]],page.id).toBe(page.title)
})
