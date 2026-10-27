import { describeError } from '../../../shared/errors.ts'
import { Notice } from './Notice'

export function ErrorNotice({ error }: { error: unknown }) {
  const info = describeError(error)
  return <Notice tone="fail" title={info.title}>
    {info.hint || null}
    {info.details ? <details className="error-details"><summary>查看技术细节</summary><pre>{info.details}</pre></details> : null}
  </Notice>
}
