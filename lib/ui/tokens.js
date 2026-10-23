/**
 * UI 设计令牌（第 7 阶段）
 *
 * 两套样式（.ccp-* 新页面 / .dshp-* 旧面板）共用同一组变量。
 * 值全部来自宿主令牌或不变量，替换只为「以后改一处、两套一起变」。
 */
export const TOKENS_CSS = `
:root{
  --coco-line-w: .5px;
  --coco-line: var(--dsw-alias-border-l2, #e3e3e3);
  --coco-line-strong: var(--dsw-alias-border-l3, #cfcfcf);
  --coco-r-sm: 8px;
  --coco-r-md: 10px;
  --coco-r-lg: 12px;
  --coco-gap-sm: 8px;
  --coco-gap-md: 16px;
  --coco-gap-lg: 32px;
  --coco-fs-xs: 11px;
  --coco-fs-sm: 12px;
  --coco-fs-md: 13px;
  --coco-fs-lg: 14px;
  --coco-fs-xl: 20px;
  --coco-lh-sm: 18px;
  --coco-lh-md: 20px;
  --coco-lh-xl: 28px;
  --coco-ink: var(--dsw-alias-label-primary);
  --coco-ink-2: var(--dsw-alias-label-secondary);
  --coco-ink-3: var(--dsw-alias-label-tertiary);
  --coco-ok: var(--dsw-alias-state-success-primary);
  --coco-bad: var(--dsw-alias-state-error-primary);
  --coco-warn: var(--dsw-alias-state-warn-primary);
  --coco-mono: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
`;
