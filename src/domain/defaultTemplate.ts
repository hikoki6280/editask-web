import { normalizeDocumentText } from './editaskText'

const DEFAULT_TEMPLATE = `"""
この場所には自由なメモを書くことができます
"""
n -- TODAY TODO hold:0
n 1行１タスクです。Ctrl+Qでスタート、完了できます
日報を書く rep:1  m:30m
燃えるゴミ出し rep:1 days:月木
-- TODAY END hold:1
-- WEEK END hold:土
n+4 チームミーティング rep:7 m:1h30m
n+100 AirTag電池交換 rep:365
n+200 インフルワクチン予約を行う rep:340 days:1
00:00 00:00 2024/01/01 月 -- YESTERDAY DONE
14:00 15:32 2026/06/24 水 チームミーティング rep:7 m:1h30m
`

export function createDefaultTemplateContent(): string {
  return normalizeDocumentText(DEFAULT_TEMPLATE)
}
