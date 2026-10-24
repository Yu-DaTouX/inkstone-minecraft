import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { BlockIcon } from './BlockIcon.tsx'

const requests = new Map<string, Promise<string | null>>()

function loadIcon(folder: string, versionId: string): Promise<string | null> {
  const key = `${folder.toLowerCase()}|${versionId}`
  let request = requests.get(key)
  if (!request) {
    request = window.craft.instanceIcon(folder, versionId).catch(() => null)
    requests.set(key, request)
  }
  return request
}

export function forgetInstanceIcons(): void {
  requests.clear()
}

interface Props {
  folder: string
  versionId: string
  size?: number
}

export function InstanceIcon({ folder, versionId, size = 32 }: Props): ReactElement {
  const [src, setSrc] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setSrc(undefined)
    void loadIcon(folder, versionId).then((icon) => alive && setSrc(icon))
    return () => {
      alive = false
    }
  }, [folder, versionId])

  const style = { '--icon': `${size}px` } as CSSProperties
  if (src) return <img className="res-icon" src={src} alt="" style={style} draggable={false} />
  if (src === null) return <BlockIcon version={versionId} size={size} className="res-icon res-icon--block" />
  return <span className="res-icon res-icon--generated" data-loading="1" style={style} aria-hidden="true" />
}
