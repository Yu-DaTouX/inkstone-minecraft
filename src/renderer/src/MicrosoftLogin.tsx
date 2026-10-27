import { useEffect, useRef, useState, type ReactElement } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from './ui/Button'
import { Notice } from './ui/Notice'
import type { LauncherSettings, MicrosoftLoginCode } from '../../shared/api.ts'
import { errorText } from '../../shared/errors.ts'

export function MicrosoftLogin({ onSignedIn }: { onSignedIn(settings: LauncherSettings): Promise<void> }): ReactElement {
  const [code, setCode] = useState<MicrosoftLoginCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const active = useRef<string | null>(null)
  const revision = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      ++revision.current
      if (active.current) void window.craft.microsoftCancel(active.current).catch(() => {})
    }
  }, [])

  const login = async (): Promise<void> => {
    const attempt = ++revision.current
    setBusy(true)
    setError('')
    try {
      const next = await window.craft.microsoftBegin()
      if (!mounted.current || revision.current !== attempt) { await window.craft.microsoftCancel(next.id); return }
      active.current = next.id
      setCode(next)
      const settings = await window.craft.microsoftFinish(next.id)
      if (mounted.current && revision.current === attempt) {
        active.current = null
        setCode(null)
        await onSignedIn(settings)
      }
    } catch (cause) {
      if (mounted.current && revision.current === attempt) setError(errorText(cause))
    } finally {
      if (mounted.current && revision.current === attempt) { active.current = null; setBusy(false); setCode(null) }
    }
  }
  const cancel = (): void => {
    ++revision.current
    if (active.current) void window.craft.microsoftCancel(active.current).catch(() => {})
    active.current = null
    setCode(null)
    setBusy(false)
  }
  return (
    <div className="microsoft-login">
      <Button variant="secondary" block icon={<KeyRound size={14} />} isDisabled={busy} onPress={() => void login()}>
        {busy ? '等待 Microsoft 授权…' : '微软正版登录'}
      </Button>
      {code ? (
        <div className="microsoft-login__code" aria-live="polite">
          <p>在微软页面输入设备码：</p>
          <strong className="microsoft-login__value">{code.userCode}</strong>
          <p>有效至 {new Date(code.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}，授权后会自动完成登录。</p>
          <Button onPress={() => { void window.craft.openUrl(code.verificationUri).catch((cause) => setError(errorText(cause))) }}>打开微软登录页</Button>
        </div>
      ) : null}
      {busy ? <Button variant="ghost" onPress={cancel}>取消登录</Button> : null}
      {error ? <Notice tone="fail" compact>{error}</Notice> : null}
    </div>
  )
}
