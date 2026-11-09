/** Change only bootstrap-owned rows; retain the person's model and plugin settings. */
export function desktopProfilePatch(text, dataDirectory, credentialsPath, workspace) {
  const marker = '# ORYH desktop data isolation'
  const connection = `${marker}\n- id: oryh-connection\n  config:\n    developmentOnly: true\n    dataDirectory: ${JSON.stringify(dataDirectory)}\n${workspace ? `    workspace: ${JSON.stringify(workspace)}\n` : ''}`
  const connectionPattern =
    /# ORYH desktop data isolation\n- id: oryh-connection\n  config:\n    developmentOnly: true\n    dataDirectory: [^\n]*\n(?:    workspace: [^\n]*\n)?/
  // Harness initializes an unused patch as `[]`; block items cannot be appended to that flow array.
  let result = text.replace(/^\s*\[\]\s*$/m, '')
  if (!text.includes(marker)) result += `\n${connection}`
  else if (workspace) {
    if (!connectionPattern.test(result)) throw new Error('ORYH desktop data patch changed; review before migration')
    result = result.replace(connectionPattern, () => connection)
  }
  if (credentialsPath) {
    const credentialsMarker = '# ORYH desktop shared API credentials'
    const credentials = `${credentialsMarker}\n- id: credentials\n  config:\n    path: ${JSON.stringify(credentialsPath)}\n`
    const pattern = /# ORYH desktop shared API credentials\n- id: credentials\n  config:\n    path: [^\n]*\n/
    if (!result.includes(credentialsMarker)) result += `\n${credentials}`
    else {
      if (!pattern.test(result)) throw new Error('ORYH desktop credentials patch changed; review before migration')
      result = result.replace(pattern, () => credentials)
    }
  }
  return result
}
