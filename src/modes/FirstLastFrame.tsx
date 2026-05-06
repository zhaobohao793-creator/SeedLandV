import ModeHeader from './ModeHeader'
import PromptPanel from '@/components/PromptPanel'
import ParamsPanel from '@/components/params/ParamsPanel'
import AssetPicker from '@/components/asset/AssetPicker'
import GenerateButton from '@/components/GenerateButton'
import { useAppStore } from '@/lib/store'

const MODE = 'first-last-frame' as const

export default function FirstLastFrame() {
  const form = useAppStore((s) => s.forms[MODE])
  const imgs = form.assets.filter((a) => a.kind === 'image').length
  const canSubmit = form.prompt.trim().length > 0 && imgs === 2

  return (
    <div className="space-y-5">
      <ModeHeader
        title="首尾帧过渡"
        subtitle="First & Last Frame"
        description="给出首帧和尾帧，模型补齐中间的过渡动画。注意：列表中第 1 张为首帧、第 2 张为尾帧。"
      />
      <PromptPanel
        mode={MODE}
        placeholder="描述过渡过程，例如：花苞慢慢绽放成盛开的花朵，微距，柔光"
        orderedLabels={['首帧', '尾帧']}
      />
      <AssetPicker
        mode={MODE}
        kinds={['image']}
        max={2}
        hint="2 张图：首帧 → 尾帧"
        orderedLabels={['首帧', '尾帧']}
      />
      <ParamsPanel mode={MODE} />
      <GenerateButton mode={MODE} canSubmit={canSubmit} requireHint="需要提示词 + 2 张图" />
    </div>
  )
}
