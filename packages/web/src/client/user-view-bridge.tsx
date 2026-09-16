import {useEffect} from 'react'
import {useCommands} from './command-stream.js'
import {publishUserViews} from './user-views.js'

/**
 * Carry the Host's menu entries from the command stream into the shared mirror the menu reads.
 *
 * It has to be a child of `CommandStream` — that is where the snapshot is — while the menu itself is
 * rendered far above it, so the mirror is how the two meet.
 * @param scope - enterprise identity scope the entries belong to.
 */
export function UserViewBridge({scope}:{scope:string}){
 const views=useCommands().commands.userViews
 useEffect(()=>{publishUserViews(scope,views)},[scope,views])
 return null
}
