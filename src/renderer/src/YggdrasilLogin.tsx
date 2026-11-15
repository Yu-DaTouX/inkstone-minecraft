import { useEffect, useRef, useState, type ReactElement } from 'react'
import { LogIn } from 'lucide-react'
import { Button } from './ui/Button'
import { ListBoxItem } from './ui/ListBox'
import { Notice } from './ui/Notice'
import { Select } from './ui/Select'
import { TextField } from './ui/TextField'
import type { LauncherSettings, YggdrasilSelection } from '../../shared/api.ts'
import { errorText } from '../../shared/errors.ts'
import { DEFAULT_YGGDRASIL_SERVER } from '../../shared/yggdrasil-config.ts'

interface Props {
  onSignedIn(settings: LauncherSettings): Promise<void>
  onCancel?(): void
  /** 左栏里空间小，省掉说明文字 */
  compact?: boolean
}

/** LittleSkin / authlib-injector 外置登录表单。密码只在这次请求里交给主进程，不保存。 */
export function YggdrasilLogin({ onSignedIn, onCancel, compact }: Props): ReactElement {
  const [server, setServer] = useState(DEFAULT_YGGDRASIL_SERVER)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<YggdrasilSelection | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const mounted = useRef(true)
  const pending = useRef<string | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (pending.current) void window.craft.yggdrasilCancel(pending.current).catch(() => {})
    }
  }, [])

  const finish = async (settings: LauncherSettings): Promise<void> => {
    pending.current = null
    setPassword('')
    setSelection(null)
    await onSignedIn(settings)
  }

  const login = async (): Promise<void> => {
    if (busy || !username.trim() || !password) return
    setBusy(true)
    setError('')
    try {
      const result = await window.craft.yggdrasilLogin(server.trim() || DEFAULT_YGGDRASIL_SERVER, username.trim(), password)
      if (!mounted.current) {
        if (result.state === 'select') void window.craft.yggdrasilCancel(result.selection.pendingId).catch(() => {})
        return
      }
      if (result.state === 'select') {
        pending.current = result.selection.pendingId
        setPassword('')
        setSelection(result.selection)
        setProfileId(result.selection.profiles[0]?.id ?? null)
      } else await finish(result.settings)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const choose = async (): Promise<void> => {
    if (!selection || !profileId || busy) return
    setBusy(true)
    setError('')
    try {
      const settings = await window.craft.yggdrasilSelect(selection.pendingId, profileId)
      if (mounted.current) await finish(settings)
    } catch (cause) {
      if (mounted.current) {
        pending.current = null
        setSelection(null)
        setError(errorText(cause))
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const cancel = (): void => {
    if (pending.current) void window.craft.yggdrasilCancel(pending.current).catch(() => {})
    pending.current = null
    setSelection(null)
    setPassword('')
    setError('')
    onCancel?.()
  }

  if (selection) {
    return (
      <div className="ygg-login" aria-live="polite">
        <p className="ygg-login__note">这个账号在 {selection.serverName} 有 {selection.profiles.length} 个角色，选一个用于游戏：</p>
        <Select aria-label="选择角色" label="角色" selectedKey={profileId} onSelectionChange={(key) => setProfileId(key == null ? null : String(key))}>
          {selection.profiles.map((profile) => (
            <ListBoxItem key={profile.id} id={profile.id} textValue={profile.name}>
              {profile.name}
            </ListBoxItem>
          ))}
        </Select>
        <div className="ygg-login__actions">
          <Button variant="secondary" icon={<LogIn size={18} />} isDisabled={busy || !profileId} onPress={() => void choose()}>
            {busy ? '正在绑定…' : '使用这个角色'}
          </Button>
          <Button variant="ghost" isDisabled={busy} onPress={cancel}>
            取消
          </Button>
        </div>
        {error ? <Notice tone="fail" compact>{error}</Notice> : null}
      </div>
    )
  }

  return (
    <form
      className="ygg-login"
      onSubmit={(event) => {
        event.preventDefault()
        void login()
      }}
    >
      <TextField label="服务器地址" value={server} onChange={setServer} spellCheck="false" inputMode="url" description={compact ? undefined : 'LittleSkin 或其他 authlib-injector 皮肤站，只支持 https'} />
      <TextField label="邮箱或用户名" value={username} onChange={setUsername} spellCheck="false" autoComplete="username" autoFocus />
      <TextField label="密码" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      <div className="ygg-login__actions">
        <Button type="submit" variant="secondary" icon={<LogIn size={18} />} isDisabled={busy || !username.trim() || !password}>
          {busy ? '正在登录…' : '登录'}
        </Button>
        {onCancel ? (
          <Button variant="ghost" isDisabled={busy} onPress={cancel}>
            取消
          </Button>
        ) : null}
      </div>
      {error ? <Notice tone="fail" compact>{error}</Notice> : null}
    </form>
  )
}
