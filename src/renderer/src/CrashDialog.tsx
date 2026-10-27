import { useEffect, useState, type ReactElement } from 'react'
import { ChevronDown, ChevronUp, FileWarning, X } from 'lucide-react'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Notice } from './ui/Notice'
import type { CrashAction, CrashDiagnosis } from '../../shared/crash-api.ts'

interface Props {
  diagnosis: CrashDiagnosis | null
  busy: string | null
  result: { ok: boolean; message: string } | null
  onClose(): void
  onAction(action: CrashAction): void
}

const SOURCE_LABEL: Record<string, string> = {
  'crash-report': '崩溃报告',
  'hs_err': 'hs_err',
  'process': '进程输出',
  'latest.log': 'latest.log'
}

export function CrashDialog({ diagnosis, busy, result, onClose, onAction }: Props): ReactElement {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [diagnosis?.id])
  return (
    <ModalOverlay className="ui-modal-overlay" isOpen={!!diagnosis} isDismissable onOpenChange={(next) => !next && onClose()}>
      <Modal className="ui-modal" data-dialog-size="md">
        <Dialog className="ui-dialog crash-dialog">
          <div className="ui-dialog__head">
            <Heading slot="title" className="ui-dialog__title">
              <span className="crash-dialog__glyph" aria-hidden="true">
                <FileWarning size={20} />
              </span>
              {diagnosis?.rule?.title ?? '游戏未能正常运行'}
            </Heading>
            <IconButton aria-label="关闭" size="sm" onPress={onClose}>
              <X size={18} />
            </IconButton>
          </div>
          {diagnosis ? (
            <div className="ui-dialog__body crash-dialog__body">
              <p className="crash-dialog__conclusion">{diagnosis.rule ? diagnosis.rule.explanation : '还无法确定原因。可以先检查最近添加或更新的 Mod，或导出诊断包供进一步分析。'}</p>
              <div className="crash-dialog__tags">
                {diagnosis.rule ? <Badge tone="stall">{diagnosis.rule.confidence === 'high' ? '匹配到已知错误特征' : '可能原因，需进一步确认'}</Badge> : null}
                <Badge>{diagnosis.versionId}</Badge>
                {diagnosis.exitCode !== null ? <Badge>退出码 {diagnosis.exitCode}</Badge> : null}
                {!diagnosis.windowShown ? <Badge tone="stall">窗口没出现</Badge> : null}
              </div>

              <Button variant="ghost" icon={expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />} aria-expanded={expanded} onPress={() => setExpanded((value) => !value)}>{expanded ? '收起技术细节' : '查看日志证据和相关 Mod'}</Button>
              {expanded && diagnosis.evidence.length > 0 ? (
                <section className="crash-dialog__section">
                  <div className="crash-dialog__section-head">
                    <span className="crash-dialog__label">证据</span>
                  </div>
                  <div className="crash-evidence" role="log" tabIndex={0}>
                    {diagnosis.evidence.map((line, index) => (
                      <div key={`${line.source}-${index}`} className="crash-evidence__line">
                        <span className="crash-evidence__source">{SOURCE_LABEL[line.source] ?? line.source}</span>
                        <span className="crash-evidence__text">{line.text}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {expanded && diagnosis.suspects.length > 0 ? (
                <section className="crash-dialog__section">
                  <span className="crash-dialog__label">日志中相关的 Mod（仍需验证）</span>
                  <ul className="crash-suspects">
                    {diagnosis.suspects.map((suspect) => (
                      <li key={suspect.fileName} className="crash-suspect">
                        <span className="crash-suspect__name">{suspect.name}</span>
                        <span className="crash-suspect__file">{suspect.fileName}</span>
                        <span className="crash-suspect__reasons">{suspect.reasons.join('；')}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {expanded && diagnosis.keywords.length > 0 ? (
                <section className="crash-dialog__section">
                  <span className="crash-dialog__label">堆栈关键词</span>
                  <div className="crash-dialog__keywords">
                    {diagnosis.keywords.map((keyword) => (
                      <code key={keyword} className="crash-dialog__keyword">
                        {keyword}
                      </code>
                    ))}
                  </div>
                </section>
              ) : null}

            </div>
          ) : null}
          {diagnosis ? (
            <footer className="crash-dialog__foot">
              {result ? (
                <Notice tone={result.ok ? 'ok' : 'fail'} compact>
                  {result.message}
                </Notice>
              ) : null}
              <div className="crash-dialog__actions">
                {diagnosis.actions.map((action, index) => (
                  <Button
                    key={`${action.kind}-${index}`}
                    variant={index === 0 && action.kind !== 'export' ? 'secondary' : 'ghost'}
                    className={index === 0 && action.kind !== 'export' ? 'fix-button' : undefined}
                    title={action.hint ?? undefined}
                    isDisabled={busy !== null}
                    onPress={() => onAction(action)}
                  >
                    {busy === action.kind ? '处理中…' : action.label}
                  </Button>
                ))}
              </div>
            </footer>
          ) : null}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
